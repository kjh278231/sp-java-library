# SPP Solver — 프로젝트 지침

OR-Library Set Partitioning 55개 인스턴스에서 OR-Tools(CP-SAT, SCIP)를 이기는 **순수 Java 21 솔버**. 외부 런타임 의존성 없음(테스트만 JUnit 5). Gradle Kotlin DSL.

## 진실 공급원

- 요구사항은 `docs/00-overview.md`, `docs/01-infrastructure.md`, `docs/02-algorithm-design.md`, `docs/03-implementation-plan.md` 넷뿐이다. 코드가 문서와 다르면 코드가 틀린 것이다. 문서를 고치는 결정은 사람이 한다.
- `docs/archive/` 는 폐기된 이전 판. 참고만.
- 문서 간 참조 표기: `01 §4.1` = 인프라 문서 4.1절.

## 개발 절차

마일스톤(M0~M6) 단위로, `03 §3` 의 작업 표를 순서대로 구현한다. 진입점은 `/dev-milestone <M>`.

| 역할 | 서브에이전트 | 하는 일 |
|---|---|---|
| 문서확인 | `doc-checker` | 마일스톤 계획·작업 스펙 추출, 구현 후 문서 정합성 점검. 설계 문서는 수정하지 않음 |
| 구현 | `implementer` | 스펙 하나를 구현하고 테스트 통과. verifier 이슈 수정(fix) |
| 검증 | `verifier` | 구현 보고를 믿지 않고 직접 빌드·테스트·측정. 코드 수정 금지. preflight·게이트 판정 |

워크플로우 `milestone-dev`(`.claude/workflows/milestone-dev.js`): preflight → 계획 → 스펙(병렬) → 작업별 [구현 → 검증 → 수정 루프(기본 2회)] 순차 → 게이트 + 드리프트.
실행 기록은 `docs/dev/<M>/` (`plan.md`, `specs/`, `verify/`, `gate.md`, `drift.md`, `summary.md`).

## 지켜야 할 것

- 검증 장치(`Verifier`, `BoundGuard`, 최적값 표)가 알고리즘보다 먼저다(`03 §1`). 틀린 하한으로 "이기는" 결과를 만들지 않는다.
- 테스트를 통과시키려고 단언을 약화하거나 게이트 수치를 완화하지 않는다.
- 패키지 의존 방향은 `01 §1` 위→아래만. `io`·`model` 은 다른 패키지를 모른다.
- 파서는 byte 파싱(`01 §4.1`). `Scanner`, `String.split`, `Integer.parseInt` 금지.
- 큰 데이터(`data/instances/`, `data/cache/`, `results/`)와 빌드 산출물은 커밋하지 않는다.
- 자동 커밋 금지. 커밋·푸시는 사용자가 요청할 때만.

## 환경

Windows 11, PowerShell 기본(Git Bash 사용 가능). 빌드: `.\gradlew.bat test | slowTest | bench | jar` (M0 이후). 벤치 기준선: Python 3.11+, `bench/scripts/requirements.txt`.

JDK와 Gradle은 **SDKMAN**(`~/.sdkman`, Git Bash에서 설치)으로 관리한다. Temurin JDK 21(`21.0.12-tem`), Gradle 9.x. `.claude/settings.local.json`의 `env`가 `JAVA_HOME`, `GRADLE_HOME`(Windows 경로)을 모든 도구 셸에 주입한다.
- Bash 도구: `java`, `javac`, `jar`, `gradle`이 `~/bin` 래퍼를 통해 바로 동작한다. `JAVA_HOME`은 POSIX 경로(`/c/Users/SDS/.sdkman/...`)로 보인다.
- PowerShell 도구: `java`는 PATH에 없다. `& "$env:JAVA_HOME\bin\java.exe"`, `& "$env:GRADLE_HOME\bin\gradle.bat"` 처럼 호출한다. `.\gradlew.bat`은 `JAVA_HOME`을 쓰므로 그대로 동작한다.
- 사용자 터미널(새 창)에서는 Git Bash·PowerShell 모두 `java`/`gradle`이 PATH에 있다(사용자 환경변수와 PowerShell 프로필에 설정됨).
- JDK 버전 변경은 Git Bash에서 `sdk install java <id>` / `sdk default java <id>`. 시스템 설치(winget)는 쓰지 않는다.
