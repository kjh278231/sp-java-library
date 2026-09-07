# SPP Solver (Java) — 설계 문서

목표: OR-Library Set Partitioning 인스턴스(55개)에서 OR-Tools(CP-SAT, SCIP)보다
**해 품질과 시간(최적성 증명 포함) 모두** 우위인 Java 솔버.

## 1. 문제 정의

```
min  Σ_j c_j x_j
s.t. Σ_j a_ij x_j = 1   ∀ i ∈ Rows      (각 행을 정확히 1번 커버)
     x_j ∈ {0,1}
```
- c_j 는 정수(OR-Library 기준). 내부적으로 `long` 사용.
- 규모: 행 17~823, 열 ~200~1,053,137. 행 수가 작다는 점이 자료구조 설계의 핵심.

## 2. 왜 범용 솔버를 이길 수 있는가 (전략)

| 구조적 사실 | 활용 방법 |
|---|---|
| 각 행 제약이 곧 **클리크**(같은 행을 공유하는 열들은 상호 배타) | 충돌 검사를 비트마스크 AND 한 번으로. 행 ≤ 1024 → 열당 `long[16]` |
| LP 완화가 타이트 | LP/라그랑지안 하한 + **감소비용 고정**으로 열의 90%+를 제거한 "core 문제" 생성 |
| 분기는 **Ryan–Foster**(행 쌍을 같이/따로)가 변수 분기보다 균형적 | 트리 깊이 급감. 범용 MIP는 이 분기를 쓰지 못함 |
| 열이 매우 많지만(수만~백만) 하한에 기여하는 열은 극소수 | Volume/라그랑지안으로 전체 열을 O(nnz)에 스캔 → core만 정밀 LP |
| CP-SAT의 강점은 병렬 LNS | 동일 전략(다중 워커 LNS + 공유 incumbent)을 SPP 전용 sub-solver로 재현 |

## 3. 아키텍처

```
spp/
├── io/         OrLibReader (rows cols / 열마다: cost k r1..rk), MPS writer(검증용)
├── model/      Instance(CSC+CSR), ColumnMask(long[]), Presolve 결과 매핑
├── presolve/   Reducer: 중복열·지배열·단일열 행·동일 행 병합·고정 전파
├── bound/      LagrangianVolume(subgradient/Volume), DualSimplex(core LP), ReducedCostFixer
├── primal/     GreedyRC, LagrangianRepair, LpDive, LocalSearch(swap/ejection), LNS
├── search/     BranchAndBound(node LP warm-start, Ryan-Foster), NodeQueue(best-bound+dive)
├── cut/        OddCycleCuts (Phase 3, 선택)
├── parallel/   Portfolio: 1 tree-search + N LNS workers, SharedIncumbent
├── Solver.java 파이프라인 오케스트레이션, 시간 제한, 로그
└── bench/      Runner(Java) + scripts/ortools_cpsat.py, ortools_scip.py, compare.py
```

### 3.1 자료구조 (성능의 토대)
- `Instance`: CSC(`colStart[]`, `rowIdx[]`)와 CSR(`rowStart[]`, `colIdx[]`) 둘 다 보유. `int[]` 평면 배열, 객체 없음.
- `ColumnMask`: 열별 행 비트마스크 `long[(m+63)/64]`. 충돌 검사 `(a & b) != 0`, 커버 갱신 `covered |= mask`.
- 비용 `long[] cost`. 감소비용은 `double[]`.
- Presolve 후 원본↔축소 인덱스 매핑 유지(해 복원용).

### 3.2 Presolve
1. 열 정렬(행 집합 기준 해시) → **중복 열** 제거(최소 비용만 유지).
2. **행 단일 열**: 그 행을 커버하는 열이 1개면 강제 선택 → 충돌 열 전부 삭제 → 반복.
3. **동일 행**: 커버하는 열 집합이 같은 두 행은 하나로 병합(제약 중복).
4. **지배 열**(제한적): 열 j의 행 집합이 열 k의 행 집합과 같거나, 두 열 {k,l}의 disjoint 합집합 = rows(j)이고 c_k+c_l ≤ c_j면 j 삭제. 쌍까지만(O(nnz·avg_deg)).
5. 불변식: 각 단계 후 실행 가능성 보존. 인스턴스별 축소율 로그.

### 3.3 하한(Bound) — 2단계
**Stage A: Volume algorithm(라그랑지안)** — 전체 열에 대해 실행
- L(u) = Σ_i u_i + Σ_j min(0, c_j − Σ_{i∈j} u_i). 등호 제약이므로 u 부호 자유.
- Volume(Barahona–Anbil)은 primal 근사 x̄도 제공 → 휴리스틱 초기화·분기 결정에 활용.
- 비용: 반복당 O(nnz). us01(1M열)도 수십 ms/iter.
- 산출: 하한 LB_L, 쌍대 u, 감소비용 r_j.

**감소비용 고정**: UB − LB_L < r_j 이면 x_j = 0 고정. 남은 열 = **core**.
전형적으로 core는 수천 열. 여기서부터는 정밀 LP가 감당 가능.

**Stage B: 자체 구현 Dual Simplex** — core에 대해
- 왜 dual simplex: 분기(행 추가/열 고정) 후 **쌍대 가능성이 유지**되어 warm-start가 자연스럽고, 노드당 재최적화가 수 회 pivot으로 끝남.
- 구현 범위: bounded dual simplex, revised form, LU 분해(행 ≤ 1000 → dense LU도 허용, 이후 Forrest–Tomlin 업데이트), Harris ratio test, 부동소수 tolerance 1e-9, 주기 방지 perturbation.
- 정수 비용이므로 LB = ceil(LP − ε). 이 정수화가 pruning을 크게 돕는다.
- 리스크 완화: Stage A만으로도 동작하는 솔버를 먼저 완성하고 Stage B를 얹는다.

### 3.4 Primal 휴리스틱
1. **GreedyRC**: 감소비용 오름차순, 충돌 없으면 선택. 미커버 행 남으면 실패 → 2로.
2. **LagrangianRepair**: Volume의 x̄ 기반 선택 후, 미커버 행을 "그 행만 추가로 정확히 커버하는 열" 탐색으로 복구. 복구 불가 시 충돌 열 제거 후 재시도(제한 횟수).
3. **LpDive**: LP 해에서 x_j 가장 큰 열 고정 → 재LP(dual simplex warm) → 반복. 깊이 제한, 백트랙 1회.
4. **LocalSearch**: 현재 해에서 열 k개 제거 → 생긴 미커버 행 집합 R을 정확히 커버하는 최소 비용 조합을 **작은 SPP로 정확히 재해결**(행 |R| ≤ ~40이므로 비트마스크 DFS/DP로 ms 단위). 이것이 CP-SAT LNS의 SPP 특화 버전.
5. **LNS 워커**: 이웃 선택 전략을 워커별로 다르게 — 랜덤 열 k개, 인접 행 블록, LP 분수값 열 주변, 고비용 열 주변.

### 3.5 Branch & Bound
- **분기 규칙: Ryan–Foster**. LP 분수해에서 행 쌍 (r,s)를 골라
  - 좌: r,s를 함께 커버하는 열만 허용(둘 중 하나만 커버하는 열 삭제)
  - 우: r,s를 함께 커버하는 열 삭제
  둘 다 열 삭제만이므로 dual simplex warm-start 그대로 유효. 쌍 선택: Σ_{j∋r,s} x_j 가 0.5에 가장 가까운 쌍.
- **노드 순서**: best-bound 기본 + 주기적 dive(DFS)로 incumbent 갱신. 노드 ≤ 수천 개 예상.
- 각 노드에서: 감소비용 고정 재적용 → presolve 경량 재실행(단일열 행) → LP → prune/분기.
- 최적성 증명 = 트리 고갈 or 전역 LB ≥ UB.

### 3.6 병렬 (CP-SAT 대응)
- 스레드 1: B&B 트리 탐색(하한 담당).
- 스레드 2..N: LNS 워커(상한 담당). `SharedIncumbent`(AtomicReference + 비용 CAS).
- 워커가 UB 갱신 → B&B가 감소비용 고정 재적용으로 즉시 이득.
- 결정론 옵션(seed 고정, 단일 스레드)으로 디버깅 재현성 확보.

### 3.7 Cuts (Phase 3, 필요 시)
- 충돌 그래프의 **odd-cycle 부등식**: Σ_{j∈C} x_j ≤ (|C|−1)/2. nw18·aa 계열에 효과 보고 있음.
- 행 클리크는 이미 제약에 포함되어 있으므로 clique cut은 무의미. 분리는 최단경로 기반.

## 4. 벤치마크 설계 (공정성 확보)

측정 지표(인스턴스별, 동일 하드웨어/시간 제한):
- `obj`: 최종 목적함수, `opt`: 알려진 최적과 일치 여부
- `t_best`: 최적값을 처음 찍은 시각, `t_proof`: 최적성 증명 완료 시각
- `gap`: 시간 초과 시 (UB−LB)/UB

기준선: `ortools_cpsat.py`(workers=8), `ortools_scip.py`. 동일 시간 제한(예: 60s), 동일 스레드 수.
Java는 **프로세스 시작 포함 wall-clock**과 **solve() 내부 시간** 둘 다 기록(JVM 기동 ~0.1–0.3s는 명시적으로 분리 보고).
승리 조건: 55개 중 `opt` 개수 ≥ OR-Tools, 그리고 `t_proof`의 기하평균이 더 작을 것.
실패 인스턴스가 있으면 어디서 시간이 새는지(LP? 트리 크기? 휴리스틱?) 프로파일을 남긴다.

## 5. 마일스톤

| # | 산출물 | 완료 기준 |
|---|---|---|
| M0 | 프로젝트 골격, OrLibReader, Instance, 벤치 스크립트(OR-Tools 기준선 수집) | 55개 전부 파싱, 기준선 표 생성 |
| M1 | Presolve + Volume 하한 + GreedyRC/LagrangianRepair | 모든 인스턴스에서 feasible 해, nw 계열 대부분 gap < 1% |
| M2 | LocalSearch/LNS + 병렬 워커 | 알려진 최적값 도달 개수가 CP-SAT 60s와 동등 |
| M3 | Dual Simplex(core) + 감소비용 고정 + B&B(Ryan–Foster) | 최적성 증명 개수 ≥ SCIP, nw 계열 전부 증명 |
| M4 | 튜닝: 노드 LP warm-start, 분기 쌍 선택, 워커 이웃 전략 | t_proof 기하평균 < OR-Tools |
| M5 | (선택) Odd-cycle cuts | nw18/aa 계열 노드 수 감소 |

## 6. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| 자체 dual simplex의 수치 불안정/성능 | core로 축소 후에만 사용. 행 ≤ 1000이므로 dense LU 허용. Stage A(Volume)만으로도 동작하는 fallback 유지 |
| us01(100만 열) 메모리/시간 | CSC만 우선 로드, 마스크는 core에만 생성. Volume 반복은 O(nnz) 스트리밍 |
| aa 계열 트리 폭발 | Ryan–Foster + 강한 감소비용 고정 + LNS incumbent 조기 확보. 안 되면 M5 cuts |
| "이겼다"는 판정의 신뢰성 | 동일 머신, 5회 반복 중앙값, 시드 고정, JVM 기동 시간 분리 보고 |

## 7. 기술 스택
- Java 21, Gradle(Kotlin DSL), 외부 런타임 의존성 없음(순수 Java). 테스트 JUnit 5.
- 벤치 기준선: Python 3 + `ortools` 패키지.
- 인스턴스: OR-Library `sppnw*.txt`, `sppaa*.txt`, `sppkl*.txt`, `sppus*.txt` → `data/` 하위.
