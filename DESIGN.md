# SPP Solver (Java) — 설계 문서

개정 2 (2026-09-07). 1차 설계 검토 결과를 반영해 전면 재작성했다. 이전 판은 `DESIGN.v1.md`.

목표: OR-Library Set Partitioning 인스턴스 55개(nw01–43, aa01–06, kl01–02, us01–04)에서
OR-Tools(CP-SAT, SCIP)보다 **해 품질과 최적성 증명 시간 모두** 우위인 순수 Java 솔버.
"우위"의 판정 기준은 §13에 사전 고정하고, 벤치 이후에 바꾸지 않는다.

---

## 1. 문제 정의

```
min  Σ_j c_j x_j
s.t. Σ_j a_ij x_j = 1   ∀ i ∈ R      (각 행을 정확히 한 번 커버)
     x_j ∈ {0,1}
```

- `c_j`는 양의 정수(OR-Library 기준). 내부적으로 `long`. 모든 비용의 최대공약수 `g`를 계산해 하한 올림에 쓴다(§6.2).
- 규모: 행 `m` = 17~823, 열 `n` = 약 200~1,053,137. **m이 작고 n이 매우 크다**는 비대칭이 자료구조와 LP 전략 전체를 결정한다.
- `x_j ≤ 1`은 행 제약이 함의하지만 LP에는 **명시적 상한으로 유지**한다. 열 추가·분기·고정을 전부 bound 변경으로 처리하기 위한 전제다(§6.3).
- 파일 포맷: 첫 줄 `rows cols`, 이후 열마다 `cost k r1 ... rk`(행 번호 1-based).

## 2. 왜 범용 솔버를 이길 수 있는가

| 구조적 사실 | 활용 |
|---|---|
| 각 행 제약이 곧 **클리크**(같은 행을 공유하는 열은 상호 배타) | 충돌 검사 = 비트마스크 AND 한 번. m ≤ 1024 → 열당 `long[16]` |
| LP 완화가 타이트하고 비용이 정수 | 정확한 LP 쌍대 + **감소비용 고정**으로 열 대부분 제거. `LB = g·ceil(z/g)` |
| n ≫ m | **Sifting**: 작은 core LP + 전체 열 O(nnz) pricing. m ≤ 823이라 기저 연산이 싸다 |
| **Ryan–Foster** 분기가 변수 분기보다 균형적 | 트리 깊이 감소. 범용 MIP는 이 분기를 쓰지 않는다 |
| 충돌 그래프에는 **어느 행에도 담기지 않는 클리크**가 있다 | clique cut. Hoffman–Padberg branch-and-cut의 주력 cut(§9) |
| CP-SAT의 강점은 병렬 LNS | SPP 전용 **정확 재해결 LNS** 워커 다수 + 공유 incumbent |

이 설계의 단일 핵심 부품은 **bounded dual simplex 하나**다. root 시작, sifting의 열 추가, 분기, 고정, cut 추가가
전부 "bound 변경" 또는 "행 추가"로 표현되어 dual simplex의 warm-start 안에서 처리된다(§6.3). primal simplex는 구현하지 않는다.

## 3. 아키텍처와 파이프라인

```
spp/
├── io/        OrLibReader(byte 단위 파서), MpsWriter(검증용), OptimaTable
├── model/     Instance(CSC, 행 차수, 행 bitset), CoreInstance(CSC+CSR+ColumnMask), PresolveMap, Solution
├── presolve/  Reducer(§5), NodePresolve(경량, §8.3)
├── bound/     Volume(§6.1), ReducedCostFixer(§6.2), Sifter(§6.3)
│   └── lp/    DualSimplex, Basis, SparseLU(Markowitz+Forrest–Tomlin), DenseLU(소형 전용)
├── primal/    GreedyRC, LagrangianRepair, LpDive, ExactRepair(작은 SPP DFS), Lns(이웃 전략)
├── search/    BranchAndBound, Node(bound 델타+기저), NodeQueue(best-bound+plunge), RyanFoster
├── cut/       CliqueSeparator, OddCycleSeparator, CutPool          (M5)
├── parallel/  Portfolio, SharedIncumbent, ParallelTree(옵션)
├── verify/    Verifier(원본 기준 해 검증), BoundGuard(테스트 모드 하한 단언)
├── Solver.java   파이프라인 오케스트레이션, 시간 예산(§11), JSON 로그
└── bench/     Runner(Java), scripts/{ortools_cpsat.py, ortools_scip.py, rootlp_glop.py, compare.py}
```

파이프라인(`Solver.solve`):

1. 파싱 → `Instance`. 파싱 시간은 별도 기록(§13).
2. Presolve(§5) → 축소 인스턴스 + 매핑.
3. Volume(§6.1) → `LB_L`, 쌍대 `u`, primal 근사 `x̄`. GreedyRC / LagrangianRepair(§7) → `UB₀`. incumbent는 Verifier 통과 후에만 채택.
4. 라그랑지안 감소비용 고정(§6.2)으로 1차 core.
5. Sifting root LP(§6.3) → `z_LP`, 정확 쌍대 `y*`. `LB = g·ceil((z_LP−ε)/g)`. `LB ≥ UB`면 종료.
6. 정확 감소비용 고정 ↔ 재LP 루프(최대 3회). LpDive → UB 갱신.
7. (M5) root cut 라운드(§9).
8. 포트폴리오(§10): B&B 스레드 + LNS 워커. 종료 = 트리 고갈 or 전역 `LB ≥ UB` or 시간 제한.
9. Postsolve → 원본 해. Verifier. 결과 JSON 한 줄 출력.

## 4. 자료구조와 메모리

- **전체 열**: CSC(`colStart[]`, `rowIdx[]`) + `long[] cost` + 행 차수 `int[] rowDeg`. `int[]` 평면 배열, 객체 없음.
- **행→열 bitset**: 행마다 n비트(`long[(n+63)/64]`). 행 지배 검사(§5-4)와 단일열 행 탐지에 사용. us01: 145행 × 1M비트 ≈ 18 MB.
- **Core 전용**: CSR(`rowStart[]`, `colIdx[]`)과 `ColumnMask`(`long[(m+63)/64]`)는 core 열에 대해서만 생성.
  us01 전체 열에 마스크를 만들면 100 MB를 넘으므로 금지한다(§15).
- 감소비용 `double[]`(전체 열), 기저·쌍대 관련 배열은 m 크기.
- **PresolveMap**: 원본 열 인덱스 배열, 강제 선택 열 목록, 삭제 행 목록. 해 복원 = 매핑 역적용 + 강제 열 추가.
- 메모리 예산: us01 CSC가 nnz×4 B 수준(수십 MB) + bitset + core 구조. `-Xmx4g`에서 여유 있게 동작하도록 유지.

## 5. Presolve

고정점까지 반복한다. 각 규칙은 "가능해 집합의 최적값 보존"을 불변식으로 하고 규칙별 단위 테스트를 둔다(§12).

1. **빈 행**: 덮는 열이 없으면 불가능. 노드 presolve에서는 prune.
2. **중복 열**: 행 집합 해시로 그룹화, 최소 비용 열만 유지. Ryan–Foster의 쌍 존재 정리가 "중복 없는 열"을 전제하므로 필수.
3. **단일열 행**: 그 열을 1로 고정 → 충돌 열 전부 삭제 → 덮인 행 제거. 반복.
4. **행 지배**: `cols(r) ⊆ cols(s)`이면 `cols(s) \ cols(r)`의 열은 전부 삭제.
   r을 덮는 열은 반드시 s도 덮으므로, 다른 열이 s를 덮으면 s가 이중 커버된다. 두 집합이 같으면 s 제약을 삭제(제약 중복, 이전 판의 "동일 행 병합"은 이 규칙의 특수 경우).
   행 bitset의 AND-NOT으로 쌍당 O(n/64), 전체 O(m²·n/64). aa01 약 1e8, us01 약 3e8 워드 연산으로 문제없다.
   Hoffman–Padberg 전처리에서 가장 큰 축소를 내는 규칙이며 노드 경량 presolve에도 넣는다(§8.3).
5. **지배 열(제한적)**: disjoint한 `rows(k) ∪ rows(l) = rows(j)`이고 `c_k + c_l ≤ c_j`면 j 삭제.
   비용이 `Σ_i deg(i)²`에 비례하므로 `deg(i) > D`(기본 5,000)인 행은 건너뛴다. us01에서는 사실상 생략된다.
6. 규칙별 축소량을 로그에 남긴다. 소형 인스턴스에서 presolve 전/후 최적값이 같음을 외부 솔버로 확인한다(§12).

## 6. 하한(Bound)

### 6.1 Stage A: Volume algorithm(라그랑지안), 전체 열 대상

- `L(u) = Σ_i u_i + Σ_j min(0, r_j)`, `r_j = c_j − Σ_{i∈j} u_i`. 등호 제약이므로 u의 부호는 자유.
- Volume(Barahona–Anbil): 부분기울기 `g = 1 − A·x_new`, `x̄ ← α·x_new + (1−α)·x̄`. `x̄`는 휴리스틱 초기화와 분기 힌트에 쓴다.
- 반복당 O(nnz), CSC 스트리밍. us01에서 반복당 수십 ms.
- 종료: (a) 반복 상한(기본 500), (b) 50회 연속 무개선, (c) 시간 예산 소진(§11), (d) `g·ceil(L/g) ≥ UB`.
- 산출: `LB_L`, `u`, `r_j`, `x̄`.

### 6.2 감소비용 고정(Reduced-cost fixing)

임의의 유효 하한 `LB`와 그 쌍대에서 얻은 감소비용 `r_j`, 현재 `UB`에 대해(비용 gcd `g`):

- `r_j ≥ 0`이고 `g·ceil((LB + r_j)/g) ≥ UB` → **x_j = 0 고정**. (x_j=1인 어떤 가능해도 비용 ≥ LB + r_j)
- `r_j < 0`이고 `g·ceil((LB − r_j)/g) ≥ UB` → **x_j = 1 고정**. (x_j=0이면 비용 ≥ LB − r_j)

근거: 임의의 가능해 x에 대해 `c·x = Σ_i u_i + Σ_j r_j x_j`. 정수 비용이므로 올림 후 비교가 유효하며, 이전 판의 `UB − LB < r_j`보다 강하다.

- 라그랑지안 쌍대(Stage A)와 LP 쌍대(Stage B) 모두에 적용된다. 노드 쌍대로 고정한 것은 그 subtree 안에서만 유효.
- 고정은 UB에 상대적이다. UB가 개선되면 기존 고정은 그대로 유효하고 추가 고정이 가능하다.
- 고정된 열은 "UB보다 좋은 해에 들어갈 수 없는 열"이다. 따라서 LNS(§7-5)도 고정 열을 후보에서 제외해도 된다.

### 6.3 Stage B: Sifting + bounded dual simplex

**LP 형태**

```
min  c·x
s.t. A x + a = 1            a: 행별 인공변수, 경계 [0,0], 비용 0
     Σ_{j∈C} x_j + s = 1    cut 행(M5), s ≥ 0
     0 ≤ x ≤ 1
```

쌍대 가능성 조건: 비기저 변수가 하한에 있으면 `r_j ≥ 0`, 상한에 있으면 `r_j ≤ 0`, 고정 변수는 무관.

**시작 기저**: 인공변수 전부. 쌍대 `y = 0`이므로 `r_j = c_j ≥ 0`, 모든 x_j는 하한 0에서 쌍대 가능.
인공변수는 값 1로 상한 0을 위반하므로 dual simplex가 밀어낸다. 별도의 phase 1이나 primal simplex가 필요 없다.
종료 시 인공변수가 기저에 0이 아닌 값으로 남으면 불가능.

**모든 사건을 bound 변경 또는 행 추가로 표현**

| 사건 | 처리 | 쌍대 가능성 |
|---|---|---|
| sifting 열 추가(`r_j < 0`) | 비기저, **상한 1에 배치** | 유지(상한에서 r_j ≤ 0). primal 위반 → pivot |
| Ryan–Foster 분기, x_j=0 고정 | `ub := 0` | 유지. 기저 열이면 primal 위반 → pivot |
| x_j=1 고정 | `lb := 1` | 유지 |
| cut 추가 | 새 행, slack을 기저에 | 유지(slack 비용 0) |
| 노드 점프 | 경로의 bound 델타 재적용 + 저장 기저 복원 + 재인수분해 | 저장 기저는 해당 노드에서 최적이므로 쌍대 가능 |

열을 물리적으로 삭제하거나 삽입하지 않는다. 이전 판의 "열 삭제만이므로 warm-start 유효"는 틀렸다.
분기 대상 열은 분수값을 가진 **기저 열**이고, 기저 열을 지우면 기저가 무효가 된다.

**Sifting 루프**(UB에 의존하지 않고 정확한 LP 쌍대를 얻는 것이 목적)

1. 초기 core: Volume 감소비용 기준 각 행의 상위 k열(기본 k=10) ∪ `r_j ≤ τ`인 열 ∪ `x̄` support ∪ incumbent 열. 상한 20m 열.
2. core LP를 dual simplex로 풀어 쌍대 `y`를 얻는다.
3. 전체 열 pricing: `r_j = c_j − y·a_j`, CSC 순회 O(nnz).
4. `r_j < −ε`인 열을 가장 음수부터 최대 2m개 추가(상한 1에 배치) → 2로.
5. 추가할 열이 없으면 종료. `z_LP`는 **전체 문제**의 LP 최적값, `y`는 정확한 쌍대. `LB = g·ceil((z_LP−ε)/g)`.
6. 정확 감소비용 고정(§6.2) → 고정이 있으면 LP 재해결 → 다시 고정. 최대 3회.

수렴 전에 시간 예산이 끝나면 현재 `y`로 `L(y) = Σ y_i + Σ_j min(0, r_j)`를 계산해 하한으로 쓴다. 이 값은 임의의 y에 대해 유효하다.
core 크기가 "수천 열"이 될 것이라는 가정에 설계가 의존하지 않는다.

**Dual simplex 구현 범위**

- bounded, revised form. 쌍대 가격은 Dantzig로 시작, M6에서 dual steepest edge.
- 비율 검사: Harris 2-pass. 모든 변수가 [0,1] boxed이므로 bound flipping ratio test가 효과적이다(M6).
- 허용오차: primal/dual 1e-9, pivot 1e-7. 퇴화 대응: 비용 perturbation 후 제거·재최적화.
- 불가능 판정: 비율 검사에 진입 후보가 없음 → 쌍대 무한 → primal 불가능 → 노드 prune.
- 시간 제한 체크: 100 pivot마다(§11).

**LU 인수분해**

| 방식 | 적용 범위 | 근거 |
|---|---|---|
| Markowitz 희소 LU + Forrest–Tomlin 업데이트 | 기본. 갱신 50~100회 또는 fill 초과 시 재인수분해 | SPP 기저 열은 nnz가 수 개. 재인수분해가 ms 단위 |
| Dense LU | m ≤ 150인 인스턴스 | 단순하고 이 크기에서는 더 빠름 |

m = 823의 dense LU는 회당 약 2×10⁸ flop, Java에서 0.1~0.3 s다. best-bound 점프마다 재인수분해하면 노드 수천 개에서 수 분이 새므로
소형 인스턴스 이외에서는 금지한다.

## 7. Primal 휴리스틱

1. **GreedyRC**: 감소비용 오름차순으로 충돌 없는 열 선택. 미커버 행이 남으면 실패 → 2로.
2. **LagrangianRepair**: `x̄` 상위 열을 선택한 뒤 미커버 행을 "그 행들만 정확히 덮는 열" 탐색으로 복구. 실패 시 충돌 열 제거 후 재시도(횟수 제한).
3. **LpDive**: LP 해에서 `x_j` 최대 열에 `lb := 1` → dual simplex 재최적화 → 반복. 깊이 제한, 백트랙 1회, 불가능이면 중단.
4. **ExactRepair**(작은 SPP 정확 재해결): 입력은 미커버 행 집합 R(|R| ≲ 40~60). 후보 `C_R = { j : mask_j ⊆ R, 미고정 }`을 마스크 필터로 뽑는다.
   - 탐색: 가장 낮은 미커버 행 r을 고르고, r을 덮으며 현재 covered와 충돌하지 않는 후보 열로 분기하는 **DFS**.
   - 가지치기: `현재 비용 + Σ_{i∈R 미커버} u_i + Σ_{j∈C_R 미사용} min(0, r_j) ≥ best`. 후보는 감소비용 순으로 정렬.
   - 상태 수 상한(기본 1e5)으로 시간을 보장한다.
   - 부분집합 DP는 상태가 2^|R|이라 쓰지 않는다. 이전 판의 "비트마스크 DP" 서술은 폐기.
5. **LNS 워커**: incumbent에서 k열 제거 → R = 제거 열들의 행 합집합 → ExactRepair → 개선 시 SharedIncumbent 갱신.
   이웃 전략은 워커별로 다르게 배정한다.
   - 랜덤 k열
   - 인접 행 블록: 임의 행 s와, s를 덮는 incumbent 열들이 덮는 행
   - LP 분수 support 주변: 분수값 열과 겹치는 incumbent 열
   - 고비용 열 주변
   - `x̄` 대비 편차가 큰 열
   - k는 성공률 기반으로 적응. 시드는 워커별 고정. 고정 열은 후보에서 제외(§6.2).

## 8. Branch & Bound

### 8.1 분기: Ryan–Foster를 bound 변경으로

- LP 분수해에서 행 쌍 (r, s)를 고른다. `f(r,s) = Σ_{j∋r,s} x_j`가 0.5에 가장 가까운 쌍.
  분수해가 존재하고 중복 열이 없으면 `0 < f < 1`인 쌍이 항상 존재한다(Ryan–Foster). 후보는 분수 support(수십~수백 열)의 행 쌍만 훑으면 된다.
- 좌 노드: r, s 중 **하나만** 덮는 열에 `ub := 0`. 우 노드: r, s를 **둘 다** 덮는 열에 `ub := 0`.
- 보조 규칙: `max x_j ≥ 0.9`인 열이 있으면 plunge 중에는 `lb := 1` 변수 분기도 허용한다. x_j = 1은 충돌 열 전부를 제거하므로 강력하다.

### 8.2 노드 순서

- 기본은 **plunge**(dive): 자식 중 하한 추정이 좋은 쪽을 즉시 처리. 부모 인수분해를 Forrest–Tomlin 업데이트로 상속.
- prune되면 **best-bound** 노드로 점프. 점프 시 재인수분해(희소 LU, ms). 점프 횟수를 로그에 남긴다.
- 전역 LB = min(큐의 노드 LB, 처리 중 노드 LB). 증명 = 큐 비움 or 전역 `LB ≥ UB`.
- 노드는 부모 대비 bound 델타와 최종 기저(기저 열 인덱스 m개 + 비기저 상태 비트)만 저장한다.

### 8.3 노드 처리 순서

1. bound 델타 적용. 점프면 경로를 재구성하고 기저를 복원해 재인수분해.
2. dual simplex → z. 불가능 → prune. `LB_node = g·ceil((z−ε)/g)`. `LB_node ≥ UB` → prune.
3. 노드 쌍대로 감소비용 고정(subtree 한정). 고정은 그 노드 LP의 쌍대가 있어야 하므로 LP 뒤에 온다.
4. 경량 presolve: 단일열 행 → `lb := 1`과 충돌 열 `ub := 0`, 행 지배, 열 없는 행 → prune.
5. 3~4에서 변화가 있으면 2로(최대 2회 반복).
6. 정수해면 Verifier 통과 후 incumbent 갱신 → prune.
7. (M5) root와 깊이 ≤ d에서 cut 분리 라운드(§9).
8. 분기(§8.1).

## 9. Cuts (M5)

행 클리크는 제약에 있지만, 충돌 그래프에는 **어느 한 행에도 담기지 않는 클리크**가 존재한다. 이전 판의 "clique cut은 무의미" 주장은 틀렸다.

```
A={1,2,3}  B={1,4,5}  C={2,4,6}  D={3,5,6}
네 열은 쌍마다 행을 하나 공유하지만 공통 행은 없다.
LP 해 x_A = x_B = x_C = x_D = 1/2 → 모든 행의 합이 1 (LP 가능해)
x_A + x_B + x_C + x_D ≤ 1 은 유효한 clique 부등식이고 이 점을 잘라낸다.
크기 3 odd-cycle 부등식(x_A+x_B+x_C ≤ 1)도 자르지만 clique 부등식이 지배한다.
```

- **Clique 분리(1순위)**: 분수 support 열(보통 수십~수백)을 정점, 행 공유를 간선으로 하는 그래프에서 `x_j` 가중 greedy로 극대 클리크를 키운다.
  `Σ x_j > 1 + ε`이면 위반. 한 행에 통째로 담기는 클리크는 이미 제약이므로 건너뛴다.
- **Odd-cycle 분리(2순위)**: 같은 support 그래프에서 이분 복제 그래프 최단경로로 분리. `Σ_{j∈C} x_j ≤ (|C|−1)/2`.
- cut은 행 추가이므로 dual simplex warm-start 안에서 처리된다(§6.3). CutPool에 보관, 비활성 cut은 재인수분해 시점에 제거.
- 적용 범위: root 최대 R라운드, 이후 깊이 ≤ d 노드에서만.
- **트리거**: M3에서 aa 계열이 노드 수 폭발로 증명에 실패하면 즉시 착수한다. "선택"이 아니라 조건부 필수다. SCIP는 clique/odd-cycle cut을 기본 탑재하므로
  cut 없이 SCIP와 같은 증명 개수를 내려면 근거가 필요하다.

## 10. 병렬 포트폴리오

- 스레드 1: B&B(하한과 증명 담당). 스레드 2..N: LNS 워커(상한 담당, §7-5).
- `SharedIncumbent`: `AtomicReference<Solution>` + 비용 CAS. 워커의 UB 갱신은 B&B의 다음 노드에서 감소비용 고정으로 즉시 반영된다.
- CP-SAT 8 워커는 LP 워커와 탐색 워커를 섞어 쓴다. aa 계열에서 트리 탐색이 병목이면 **노드 단위 병렬 B&B**를 켠다(M4 옵션).
  워커마다 독립 LP 객체와 인수분해를 갖고 노드 큐만 공유한다. 전역 LB는 큐와 처리 중 노드의 최솟값.
- 결정론 모드: 단일 스레드 + 시드 고정으로 완전 재현. 병렬 모드에서는 워커별 시드를 로그에 남긴다.

## 11. 시간 예산과 제한 처리

시간 제한 T(벤치 기본 60 s)에 대한 단계별 예산. 단계가 예산을 남기면 이후 단계로 넘긴다.

| 단계 | 예산 | 비고 |
|---|---|---|
| 파싱 | 내부 시간 미포함, 별도 기록 | byte 단위 파서. us01(100 MB 안팎) 목표 ≤ 2 s. `Scanner`/`split` 금지 |
| Presolve | ≤ 2% T | |
| Volume | ≤ 8% T | §6.1 종료 조건이 먼저 걸리면 조기 종료 |
| 초기 휴리스틱 | ≤ 2% T | |
| Sifting root LP + 고정 루프 | 수렴까지, ≤ 30% T | 초과 시 `L(y)`를 하한으로 사용(§6.3) |
| B&B + LNS | 나머지 | 증명 완료 시 즉시 종료 |

데드라인 체크 지점: Volume 매 반복, simplex 100 pivot마다, sifting 매 라운드, LNS 매 이동, ExactRepair 1e4 상태마다.
어느 단계에서 끊기든 그 시점의 유효한 LB/UB를 보고한다.

## 12. 정확성 검증

이 프로젝트의 최악 실패는 **틀린 하한으로 "최적 증명"을 찍고 벤치에서 이기는 것**이다. 라그랑지안 부호 실수, LP 허용오차, 고정 규칙 오류가 모두 조용히 이렇게 나타난다.

- **Verifier**: 원본 인스턴스 기준으로 각 행이 정확히 한 번 덮이는지, 열 인덱스가 유효한지, 비용을 `long`으로 재계산해 일치하는지 검사.
  incumbent 갱신마다 실행(O(해의 nnz)라 항상 켠다). 최종 해도 postsolve 후 재검증.
- **BoundGuard**(테스트 모드): `data/optima.csv`의 알려진 최적값과 최적해 벡터를 로드하고,
  - 전역 LB ≤ 알려진 최적값을 항상 단언한다.
  - 노드의 bound 집합이 알려진 최적해를 허용하면 그 노드에서 `z ≤ 최적값`을 단언하고, 감소비용 고정이 최적해의 열을 0으로(또는 비최적 열을 1로) 고정하지 않았음을 단언한다(최적해 추적).
  - 최종적으로 55개 전부 "증명된 최적값 == 알려진 최적값"을 회귀 테스트로 둔다.
- **외부 LP 대조**: presolve 후 인스턴스를 MPS로 내보내고 `rootlp_glop.py`(OR-Tools Glop)로 LP 완화를 풀어 `z_LP`를 55개 전부 대조(상대 오차 1e-6).
- **Presolve 검증**: 규칙별 단위 테스트(§9의 clique 반례 포함). 소형 인스턴스에서 presolve 전/후 IP 최적값 일치를 SCIP로 확인.
- **결정론 재현**: 단일 스레드 모드에서 동일 입력·시드는 동일 로그를 낸다.
- 위 항목은 M0~M1 산출물에 포함되며 §15 리스크 표의 1번 항목이다.

## 13. 벤치마크 설계

### 13.1 인스턴스별 측정값

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

### 13.2 비교 쌍

OR-Tools 경유 SCIP는 실질적으로 단일 스레드로 돌기 때문에 "동일 스레드 수"는 CP-SAT에만 성립한다. 두 쌍으로 나눈다.

| 쌍 | Java | 기준선 |
|---|---|---|
| A | 1 스레드(결정론 모드) | OR-Tools SCIP |
| B | 8 스레드 | CP-SAT `num_workers=8` |

동일 머신, T = 60 s, 5회 반복 중앙값. OR-Tools 버전·JDK 버전·CPU·RAM을 결과에 기록한다.
기준선이 알려진 최적값을 재현하는지도 확인한다(기준선 자체의 sanity check).

### 13.3 JVM 효과

nw 계열은 ms 단위로 끝나므로 JVM 기동뿐 아니라 JIT 미완료 실행이 결과를 지배한다.
- **cold**: 인스턴스마다 새 JVM(1차 결과).
- **warm**: 한 JVM에서 55개 연속 실행(2차 결과, JIT 영향 분리용).
둘 다 보고한다.

### 13.4 집계와 승리 조건(사전 고정)

- `t_proof` 집계는 **shifted geometric mean**(shift 1 s). 시간 초과는 PAR-2(2T)로 계상.
- 승리 조건은 각 비교 쌍에서 다음 셋을 모두 만족하는 것이다.
  1. `opt` 개수 ≥ 기준선
  2. 증명 개수 ≥ 기준선
  3. `t_proof`의 shifted geometric mean < 기준선
- 인스턴스별 전체 표를 공개한다. 지는 인스턴스는 단계별 시간(파싱/presolve/Volume/LP/트리/LNS)과 노드 수, 점프 수 프로파일을 함께 남긴다.

### 13.5 알려진 최적값

`data/optima.csv`: OR-Library 부속 정보와 Hoffman–Padberg(1993) 표를 대조해 작성. 불일치가 있으면 SCIP 장시간 실행으로 확정하고 출처를 열에 기록한다. M0 산출물.

## 14. 마일스톤

| # | 산출물 | 완료 기준 |
|---|---|---|
| M0 | 골격, byte 파서, `Instance`, `Verifier`, `data/optima.csv`, 기준선 스크립트(내부 시간·모델 생성 시간 분리) | 55개 전부 파싱(us01 ≤ 2 s), 기준선 표 생성, 기준선이 알려진 최적값 재현 |
| M1 | Presolve(행 지배 포함) + Volume + GreedyRC/LagrangianRepair + BoundGuard | 모든 인스턴스에서 feasible 해, `LB_L ≤ 최적값` 전부 통과, nw 계열 대부분 gap < 1% |
| M2 | Sifting + bounded dual simplex(희소 LU) + 정확 감소비용 고정 + LpDive + 외부 LP 대조 | `z_LP`가 Glop과 55개 전부 일치, root에서 nw 계열 다수 증명 |
| M3 | B&B(Ryan–Foster bound 변경, plunge + best-bound) + 노드 presolve | 증명 개수 ≥ SCIP(쌍 A), nw·kl·us 계열 전부 증명. aa 계열 실패 시 M5 트리거 |
| M4 | LNS + ExactRepair + 병렬 포트폴리오(옵션: 병렬 B&B) | `opt` 도달 개수 ≥ CP-SAT 60 s(쌍 B) |
| M5 | Clique cut → odd-cycle cut, CutPool | aa 계열 노드 수 감소, 증명 개수 목표 달성 |
| M6 | 튜닝: dual steepest edge, bound flipping ratio test, 분기 쌍 선택, 이웃 전략 적응 | `t_proof` shifted geomean < 기준선(두 쌍 모두), 최종 벤치 표 |

정밀 LP(M2)를 이전 판보다 앞당겼다. 지표의 대부분이 nw 계열 root LP 증명 시간에서 나오므로 가장 결정적인 부품을 먼저 완성한다.

## 15. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| **틀린 하한으로 거짓 최적 증명** | §12 전부. Verifier 상시, BoundGuard 최적해 추적, Glop LP 대조, 55개 회귀 테스트 |
| 자체 dual simplex의 수치 불안정과 구현 공수(최대 리스크) | 단일 알고리즘으로 통일(primal 없음). Harris + perturbation. Stage A만으로 동작하는 fallback 유지. M2에서 Glop 대조로 조기 검출 |
| Dense LU를 노드에서 쓰면 점프마다 0.1~0.3 s | 희소 LU 기본, dense는 m ≤ 150 한정. plunge 우선으로 점프 자체를 줄임 |
| core가 커서 Stage B가 감당 못 함 | sifting은 core 크기 가정에 의존하지 않음. 라운드당 추가 열 상한 2m, 시간 예산 초과 시 `L(y)` 하한 |
| aa 계열 트리 폭발 | Ryan–Foster + 강한 고정 + LNS 조기 incumbent. 실패 시 M5 clique cut 즉시 착수. 병렬 B&B 옵션 |
| us01(1M열) 메모리·시간 | CSC + 행 bitset만 전체 열에, 마스크·CSR은 core만. byte 파서. Volume·pricing은 O(nnz) 스트리밍. 지배 열 규칙 생략 |
| "이겼다"는 판정의 신뢰성 | §13: 내부 시간 1차, 비교 쌍 분리, shifted geomean + PAR-2 사전 고정, cold/warm 분리, 5회 중앙값, 전체 표 공개 |

## 16. 기술 스택과 저장소 구성

- Java 21, Gradle(Kotlin DSL), 외부 런타임 의존성 없음. 테스트 JUnit 5.
- 벤치 기준선: Python 3.11+, `ortools` 버전 고정(`requirements.txt`).
- 저장소:

```
data/instances/   sppnw*.txt, sppaa*.txt, sppkl*.txt, sppus*.txt
data/optima.csv   인스턴스, 최적값, 출처
data/rootlp.csv   presolve 후 LP 완화값(Glop 대조용)
results/          실행별 JSON 라인 로그, compare.py 산출 표
```

- 실행: `java -Xmx4g -jar spp.jar --time 60 --threads 8 --seed 1 data/instances/sppaa01.txt` → 결과 JSON 한 줄.
  `--deterministic`은 단일 스레드 + 시드 고정. `--verify-opt data/optima.csv`는 BoundGuard를 켠다.
