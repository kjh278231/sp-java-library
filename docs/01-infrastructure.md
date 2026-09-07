# SPP Solver — 인프라 설계

개정 3 (2026-09-07). 범위는 알고리즘(02)을 제외한 전부다. 코드 구조, 데이터 흐름과 자료구조, 자원 예산, 병렬 실행 틀,
검증 장치, 벤치마크 장치, 빌드·실행 환경. 알고리즘 문서는 이 문서의 자료구조(§3)와 시간 예산(§5)을 전제로 쓴다.

## 1. 패키지 구조

```
spp/
├── io/        OrLibReader(byte 단위 파서), MpsWriter(검증용), OptimaTable            §4
├── model/     Instance(CSC, 행 차수, 행 bitset), CoreInstance(CSC+CSR+ColumnMask),
│              PresolveMap, Solution, SolveContext                                    §2, §3
├── presolve/  Reducer(02 §2), NodePresolve(02 §7.3)
├── bound/     Volume(02 §3), ReducedCostFixer(02 §4), Sifter(02 §5.4)
│   └── lp/    DualSimplex, Basis, SparseLU(Markowitz+Forrest–Tomlin), DenseLU(소형)  02 §5.5, §5.6
├── primal/    GreedyRC, LagrangianRepair, LpDive, ExactRepair, Lns(이웃 전략)         02 §6
├── search/    BranchAndBound, Node(bound 델타+기저), NodeQueue(best-bound+plunge),
│              RyanFoster                                                            02 §7
├── cut/       CliqueSeparator, OddCycleSeparator, CutPool                           02 §8 (M5)
├── parallel/  Portfolio, SharedIncumbent, ParallelTree(옵션)                         §6
├── verify/    Verifier(원본 기준 해 검증), BoundGuard(테스트 모드 하한 단언)           §8
├── Solver.java   파이프라인 오케스트레이션, 시간 예산, JSON 로그                      §2, §5, §7
└── bench/     Runner(Java), scripts/{ortools_cpsat.py, ortools_scip.py,
               rootlp_glop.py, compare.py}                                           §9
```

의존 방향은 위에서 아래로만 흐른다. `io`·`model`은 다른 패키지를 모른다. `bound/lp`는 `model`만 안다.
`search`와 `primal`은 `bound`를 쓰되 서로를 모르고, `parallel`이 둘을 묶는다. `verify`는 `model`만 안다.

## 2. 파이프라인 오케스트레이션

`Solver.solve(Instance, Options) → Result`. 단계 사이의 공유 상태는 `SolveContext` 하나에 모은다.

`SolveContext`: 축소 인스턴스, `PresolveMap`, 비용 gcd `g`, `Deadline`(§5), `SharedIncumbent`(UB, §6), 전역 LB, 시드, 로그 싱크, 단계별 타임스탬프.

| 단계 | 컴포넌트 | 입력 → 출력 | 예산(§5) |
|---|---|---|---|
| 1 | `OrLibReader` | 파일 → `Instance` | 내부 시간 미포함 |
| 2 | `Reducer` | `Instance` → 축소 `Instance` + `PresolveMap` | ≤ 2% T |
| 3 | `Volume`, `GreedyRC`, `LagrangianRepair` | 축소 인스턴스 → `LB_L`, `u`, `x̄`, `UB₀` | ≤ 8% + 2% T |
| 4 | `ReducedCostFixer` | `LB_L`, `r_j`, UB → 고정 집합 → `CoreInstance` | 3에 포함 |
| 5 | `Sifter` + `DualSimplex` | core → `z_LP`, 쌍대 `y`, 기저 | ≤ 30% T |
| 6 | `ReducedCostFixer`, `LpDive` | `z_LP`, `y`, UB → 추가 고정, UB 갱신 | 5에 포함 |
| 7 | `CliqueSeparator`, `OddCycleSeparator` (M5) | LP 해 → cut 행 | 5에 포함 |
| 8 | `Portfolio` (`BranchAndBound` + `Lns` 워커) | context → 증명 또는 시간 소진 | 나머지 |
| 9 | `PresolveMap.restore`, `Verifier` | 축소 해 → 원본 해 → 검증 → `Result` | |

규칙:
- 어느 단계든 데드라인에 끊길 수 있다. 끊긴 시점에도 `Result`는 유효한 LB와 UB를 담는다. sifting이 수렴 전에 끊기면 현재 쌍대로 `L(y)`를 하한으로 쓴다(02 §5.4).
- `LB ≥ UB`가 되면 이후 단계를 건너뛰고 9로 간다.
- incumbent 갱신은 어디서 일어나든 `Verifier`를 통과한 뒤에만 `SharedIncumbent`에 반영한다(§8).

## 3. 자료구조와 메모리

| 대상 | 구조 | 비고 |
|---|---|---|
| 전체 열 | CSC(`int[] colStart`, `int[] rowIdx`), `long[] cost`, `int[] rowDeg` | `int[]` 평면 배열, 객체 없음. 열 내 행 인덱스는 정렬 저장 |
| 행→열 bitset | 행마다 `long[(n+63)/64]` | 행 지배 검사와 단일열 행 탐지. us01: 145행 × 1M비트 ≈ 18 MB |
| core 전용 | CSR(`rowStart[]`, `colIdx[]`), `ColumnMask`(`long[(m+63)/64]`) | core 열에 대해서만 생성. us01 전체에 마스크를 만들면 100 MB 초과라 금지 |
| 감소비용 | `double[]`(전체 열) | pricing 결과 |
| 기저·쌍대 | m 크기 배열 | `Basis`: 기저 열 인덱스 `int[m]`, 비기저 상태 비트 |
| `PresolveMap` | 원본 열 인덱스 배열, 강제 선택 열 목록, 삭제 행 목록 | 해 복원 = 매핑 역적용 + 강제 열 추가 |
| `Solution` | 선택 열 `int[]`(원본 인덱스), 비용 `long` | 불변 객체. 공유 시 복사 없음 |

- 충돌 검사 `(mask_a & mask_b) != 0`, 커버 갱신 `covered |= mask`.
- 메모리 예산: us01 CSC가 nnz×4 B 수준(수십 MB) + bitset + core 구조. `-Xmx4g`에서 여유 있게 동작하도록 유지한다.
- 워커 간 공유 데이터(인스턴스, 마스크, CSC)는 읽기 전용이며 복제하지 않는다.

## 4. 입출력

### 4.1 OrLibReader

- 포맷: 첫 줄 `rows cols`, 이후 열마다 `cost k r1 ... rk`. 행 번호 1-based. 토큰은 공백·개행 혼용.
- 구현: `FileChannel`로 큰 `ByteBuffer`를 순회하며 10진 정수를 직접 파싱한다. `Scanner`, `String.split`, `Integer.parseInt`는 금지(us01에서 수십 초).
- 검증: 헤더의 열 수와 실제 열 수 일치, 행 번호가 1..m 범위, k와 나열된 행 수 일치, 열 내 중복 행 번호 없음, 비용 > 0. 위반 시 예외로 중단.
- 1-based → 0-based 변환, 열 내 행 인덱스 정렬(마스크·해시·지배 검사가 정렬을 전제).
- 목표: us01(100 MB 안팎) ≤ 2 s. 파싱 시간은 `t_parse`로 별도 기록한다.
- 개발 편의용 바이너리 캐시(`data/cache/*.bin`)는 허용하되 벤치 실행에서는 쓰지 않는다.

### 4.2 MpsWriter

presolve 후 인스턴스를 MPS로 내보낸다. LP 완화 대조(Glop, §8)와 IP 대조(SCIP)에 쓴다. 고정 열은 bound로 표현하고, 강제 선택 열은 상수항으로 반영해 목적값이 원본 기준과 일치하게 한다.

### 4.3 OptimaTable

- `data/optima.csv`: `instance,optimum,source,note`. 출처는 OR-Library 부속 정보와 Hoffman–Padberg(1993) 표를 대조해 기록하고, 불일치 시 SCIP 장시간 실행으로 확정한다.
- `data/solutions/<instance>.sol`: 알려진 최적해의 열 인덱스 목록(원본 기준). `BoundGuard`의 최적해 추적(§8)에 쓴다. 자체 솔버 또는 SCIP 결과를 `Verifier`로 검증한 뒤 저장.

### 4.4 결과 JSON

실행마다 stdout 마지막 줄에 JSON 한 줄. `compare.py`가 이 줄만 읽는다.

| 그룹 | 필드 |
|---|---|
| 식별 | `instance`, `m`, `n`, `nnz`, `version`, `threads`, `seed`, `deterministic`, `time_limit` |
| presolve | `m_reduced`, `n_reduced`, `forced_cols`, 규칙별 삭제 수 |
| 결과 | `lb`, `ub`, `status`(`optimal`/`feasible`/`infeasible`/`timeout`), `opt`(최적값 일치), `gap` |
| 시간 | `t_parse`, `t_presolve`, `t_volume`, `t_rootlp`, `t_first_opt`, `t_proof`, `t_solve`(내부 합계), `t_wall`, `t_jvm` |
| 탐색 | `nodes`, `jumps`, `refactors`, `lns_moves`, `lns_improvements`, `cuts_added`, `fixed_by_rc` |
| 환경 | `jdk`, `os`, `cpu`, `ram` |

## 5. 시간 예산과 데드라인

시간 제한 T(벤치 기본 60 s). `Deadline`은 전체 마감과 단계별 하위 마감을 갖고, 단계가 예산을 남기면 이후 단계로 이월한다.

| 단계 | 예산 | 비고 |
|---|---|---|
| 파싱 | 내부 시간 미포함 | `t_parse` 별도 기록. us01 목표 ≤ 2 s |
| Presolve | ≤ 2% T | |
| Volume | ≤ 8% T | 02 §3의 종료 조건이 먼저 걸리면 조기 종료 |
| 초기 휴리스틱 | ≤ 2% T | |
| Sifting root LP + 고정 루프 | 수렴까지, ≤ 30% T | 초과 시 `L(y)`를 하한으로(02 §5.4) |
| B&B + LNS | 나머지 | 증명 완료 시 즉시 종료 |

데드라인 체크 지점: Volume 매 반복, simplex 100 pivot마다, sifting 매 라운드, LNS 매 이동, ExactRepair 1e4 상태마다, B&B 매 노드.
체크는 `System.nanoTime()` 비교 한 번이라 비용이 없다.

## 6. 병렬 프레임워크

- **구성**: 스레드 1은 B&B(하한과 증명), 스레드 2..N은 LNS 워커(상한). 워커는 단계 8에서 시작하고, 종료 신호(증명·시간·불가능)에 멈춘다.
- **SharedIncumbent**: `AtomicReference<Solution>`, 비용 CAS로 갱신. 갱신 전 `Verifier` 통과 필수. B&B는 다음 노드에서 새 UB를 읽어 감소비용 고정에 반영한다(02 §9).
- **전역 LB**: B&B 스레드만 갱신하고 나머지는 읽기만 한다. 종료 판정 `LB ≥ UB`도 B&B 스레드가 한다.
- **ParallelTree(옵션, M4)**: 워커마다 독립 `DualSimplex`와 LU 인스턴스, 공유 `NodeQueue`(우선순위 = LB), 처리 중 노드 집합. 전역 LB = min(큐, 처리 중). 각 워커는 plunge 후 점프. B&B 워커 수는 스레드 예산 중 몫(기본 1, aa 계열에서 2~4).
- **결정론 모드**(`--deterministic`): 단일 스레드, LNS를 B&B 노드 사이에 라운드로빈으로 삽입, 시드 고정. 동일 입력·시드는 바이트 동일한 로그를 낸다.
- **병렬 모드 시드**: 워커 i의 시드 = base + i. 로그에 기록.
- 워커 간 공유 데이터는 읽기 전용(§3). incumbent는 불변 `Solution` 객체를 참조로 공유.

## 7. CLI와 로깅

```
java -Xmx4g -jar spp.jar [옵션] <instance.txt>
  --time <sec>            시간 제한 T (기본 60)
  --threads <n>           스레드 수 (기본 = 코어 수)
  --seed <k>              기본 시드 (기본 1)
  --deterministic         단일 스레드 + 시드 고정
  --verify-opt <csv>      BoundGuard 활성화 (data/optima.csv)
  --solution <file>       최적해 추적용 .sol (BoundGuard)
  --export-mps <file>     presolve 후 MPS 내보내기
  --log <level>           quiet | info | debug
```

- stdout: 마지막 줄 결과 JSON(§4.4). stderr: 진행 로그(단계 타임스탬프, LB/UB 갱신, 노드·점프 카운터).
- 결정론 모드의 debug 로그는 재현 비교의 기준이 된다.

## 8. 정확성 검증 인프라

이 프로젝트의 최악 실패는 **틀린 하한으로 "최적 증명"을 찍고 벤치에서 이기는 것**이다. 라그랑지안 부호 실수, LP 허용오차, 고정 규칙 오류가 모두 조용히 이렇게 나타난다.

| 장치 | 내용 | 실행 시점 |
|---|---|---|
| `Verifier` | 원본 인스턴스 기준으로 각 행이 정확히 한 번 덮이는지, 열 인덱스 유효성, `long` 비용 재계산 일치 | incumbent 갱신마다(O(해의 nnz)라 항상 켬), 최종 해 postsolve 후 |
| `BoundGuard` | `data/optima.csv`와 `.sol`을 로드. 전역 LB ≤ 최적값 단언. 노드의 bound가 최적해를 허용하면 그 노드에서 `z ≤ 최적값` 단언, 감소비용 고정이 최적해의 열을 0으로(비최적 열을 1로) 고정하지 않았음 단언 | `--verify-opt` 테스트 모드 |
| 외부 LP 대조 | presolve 후 MPS를 `rootlp_glop.py`(OR-Tools Glop)로 풀어 `z_LP` 대조, 상대 오차 1e-6. 결과는 `data/rootlp.csv` | M2 게이트, 이후 회귀 |
| Presolve 검증 | 규칙별 단위 테스트(02 §8의 clique 반례 포함). 소형 인스턴스에서 presolve 전/후 IP 최적값 일치를 SCIP로 확인 | M1 게이트 |
| 결정론 재현 | 단일 스레드 모드에서 동일 입력·시드는 동일 로그 | 회귀 |
| 회귀 테스트 | 55개 전부 "증명된 최적값 == 알려진 최적값" | 매 마일스톤 |

## 9. 벤치마크 인프라

### 9.1 인스턴스별 측정값

| 항목 | Java | OR-Tools |
|---|---|---|
| `obj`, `lb`, `status` | 최종 UB, 전역 LB, 증명 여부 | objective, best bound, status |
| `opt` | `obj == data/optima.csv` | 동일 |
| `t_first_opt` | 최적값을 처음 찍은 solve 내부 시각 | 로그에서 추출 가능하면 기록 |
| `t_proof` | 증명 완료 solve 내부 시각 | `solver.WallTime()` / `wall_time()` |
| `gap` | 시간 초과 시 `(UB−LB)/UB` | 동일 |
| `t_parse`, `t_jvm`, `t_wall` | 파싱, JVM 기동, 프로세스 전체 | `t_build`(Python 모델 생성), `t_wall` |

**1차 지표는 solver 내부 시간**이다. Python으로 us01의 1M 변수를 모델에 넣는 시간은 solve 시간을 압도하므로, 이를 포함해 이기는 것은 신뢰를 얻지 못한다.
wall-clock과 파싱·JVM 기동·모델 생성 시간은 전부 별도 열로 보고한다.

### 9.2 비교 쌍

OR-Tools 경유 SCIP는 실질적으로 단일 스레드로 돌기 때문에 "동일 스레드 수"는 CP-SAT에만 성립한다. 두 쌍으로 나눈다.

| 쌍 | Java | 기준선 |
|---|---|---|
| A | 1 스레드(결정론 모드) | OR-Tools SCIP |
| B | 8 스레드 | CP-SAT `num_workers=8` |

동일 머신, T = 60 s, 5회 반복 중앙값. OR-Tools 버전·JDK 버전·CPU·RAM을 결과에 기록한다.
기준선이 알려진 최적값을 재현하는지도 확인한다(기준선 자체의 sanity check).

### 9.3 JVM 효과

nw 계열은 ms 단위로 끝나므로 JVM 기동뿐 아니라 JIT 미완료 실행이 결과를 지배한다.

- **cold**: 인스턴스마다 새 JVM. 1차 결과.
- **warm**: 한 JVM에서 55개 연속 실행. 2차 결과, JIT 영향 분리용.

둘 다 보고한다. 벤치 결과에 따라 AppCDS나 GraalVM native-image를 M6에서 검토한다(03 §7).

### 9.4 집계와 승리 조건(사전 고정)

- `t_proof` 집계는 **shifted geometric mean**(shift 1 s). 시간 초과는 PAR-2(2T)로 계상.
- 승리 조건은 각 비교 쌍에서 다음 셋을 모두 만족하는 것이다.
  1. `opt` 개수 ≥ 기준선
  2. 증명 개수 ≥ 기준선
  3. `t_proof`의 shifted geometric mean < 기준선
- 인스턴스별 전체 표를 공개한다. 지는 인스턴스는 단계별 시간과 노드 수, 점프 수 프로파일을 함께 남긴다.

### 9.5 스크립트

| 스크립트 | 역할 | 기록 |
|---|---|---|
| `ortools_cpsat.py` | CP-SAT, `num_workers=8`, `max_time_in_seconds=T` | `t_build`, `solver.WallTime()`, objective, `BestObjectiveBound`, status |
| `ortools_scip.py` | `pywraplp` SCIP, `SetTimeLimit(T·1000)` | `t_build`, `wall_time()`, objective, `BestBound`, status |
| `rootlp_glop.py` | MPS → Glop LP 완화값 | `data/rootlp.csv` |
| `Runner`(Java) | 55개 × 반복 × cold/warm 실행, JSON 수집 | `results/<run-id>/*.jsonl` |
| `compare.py` | 두 쌍의 표, 집계, 승리 조건 판정, 패배 인스턴스 프로파일 | `results/<run-id>/report.md` |

`requirements.txt`로 `ortools` 버전을 고정한다.

## 10. 테스트 구조

| 종류 | 대상 | Gradle 태스크 |
|---|---|---|
| 단위 | presolve 규칙별, `DualSimplex`(소형 LP 대 brute force와 알려진 해), `SparseLU`(랜덤 희소 행렬 재구성 오차), 마스크·bitset, 파서(정상·오류 파일), `ExactRepair`(brute force 대조), 감소비용 고정(수작업 사례) | `test` |
| 통합 | 소형 인스턴스(nw41 등) 전체 파이프라인 = 알려진 최적값. 결정론 로그 재현 | `test` |
| 회귀 | 55개 최적값 일치, Glop LP 대조 | `slowTest` |
| 벤치 | §9 전체 | `bench` (테스트에 포함하지 않음) |

## 11. 기술 스택과 저장소 구성

- Java 21, Gradle(Kotlin DSL), 외부 런타임 의존성 없음. 테스트 JUnit 5.
- 벤치 기준선: Python 3.11+, `ortools` 버전 고정.
- 저장소:

```
docs/             00~03 설계 문서, archive/
src/main/java/spp/     §1 패키지 구조
src/test/java/spp/     §10
bench/scripts/    ortools_cpsat.py, ortools_scip.py, rootlp_glop.py, compare.py, requirements.txt
data/instances/   sppnw*.txt, sppaa*.txt, sppkl*.txt, sppus*.txt
data/optima.csv   인스턴스, 최적값, 출처
data/solutions/   <instance>.sol
data/rootlp.csv   presolve 후 LP 완화값(Glop 대조용)
data/cache/       개발용 바이너리 캐시(벤치 미사용, VCS 제외)
results/          실행별 JSON 라인 로그, compare.py 산출 표
```

- Gradle 태스크: `run`, `test`, `slowTest`, `bench`, `jar`(단일 실행 jar).
