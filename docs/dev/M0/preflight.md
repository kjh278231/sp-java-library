# M0 Preflight 점검 보고서

- 일시: 2026-09-07
- 모드: preflight (환경 점검만, 설치·변경 없음)
- **판정: OK** (blocker 0건, warning 4건)

## 체크 표

| 항목 | 상태 | 확인 명령 / 증거 | 힌트 |
|---|---|---|---|
| JDK 21+ | ok | `C:\Users\SDS\.sdkman\candidates\java\current\bin\java.exe -version` → `openjdk version "21.0.12" 2026-07-21 LTS (Temurin-21.0.12+8)`. `JAVA_HOME`(User) = `C:\Users\SDS\.sdkman\candidates\java\current`, User `Path`에 `...\java\current\bin` 포함. 단, 현재 셸 세션에서는 `java` 가 `not recognized` (세션이 PATH 변경 이전에 시작됨) | 새 터미널을 열어 `java -version` 재확인. 계속 실패하면 `winget install --id Microsoft.OpenJDK.21 -e` |
| Gradle / gradlew | ok | `.\gradlew.bat` 없음(`Test-Path` → False). 시스템 Gradle: `C:\Users\SDS\.sdkman\candidates\gradle\current\bin\gradle.bat --version` → `Gradle 9.7.1`, Launcher JVM 21.0.12. User `Path`에 `...\gradle\current\bin` 포함 (현재 세션 PATH는 미반영) | 첫 작업(M0-T1)에서 `gradle wrapper` 로 `gradlew.bat` 생성. 새 터미널에서 `gradle --version` 확인 |
| Python 3.11+ | ok | `python --version` → `Python 3.14.5` | ortools 휠이 3.14 미지원이면 `winget install --id Python.Python.3.12 -e` 후 venv 사용 |
| Python ortools | warn | `python -c "import ortools"` → `ModuleNotFoundError: No module named 'ortools'` | 기준선 스크립트 작업에서 `python -m pip install ortools` |
| git 작업 트리 | warn | `git status --short` → ` M .claude/agents/implementer.md`, ` M .claude/agents/verifier.md`, ` M CLAUDE.md`, `?? .gitignore` (미커밋 4건) | M0 시작 전 커밋 권장: `git add -A; git commit -m "chore: update agent defs, add .gitignore"` |
| 데이터 `data/instances/spp*.txt` | warn | `data/instances/` 디렉터리 없음, 파일 0개 (기대 55개) | 데이터 준비 작업(M0)에서 OR-Library spp 인스턴스 55개를 `data/instances/`에 배치 |
| docs/00-overview.md | ok | 존재 | |
| docs/01-infrastructure.md | ok | 존재 | |
| docs/02-algorithm-design.md | ok | 존재 | |
| docs/03-implementation-plan.md | ok | 존재 | |

## Blockers
없음

## Warnings
1. `gradlew.bat` 미존재 — 시스템 Gradle 9.7.1로 첫 작업에서 wrapper 부트스트랩 필요
2. Python `ortools` 미설치 — 기준선 스크립트 작업에서 설치 (Python 3.14 휠 호환 확인 필요)
3. git 미커밋 변경 4건 (.claude/agents/*.md, CLAUDE.md 수정, .gitignore 미추적)
4. `data/instances/` 없음 — spp 인스턴스 0/55

## 참고
- 현재 실행 중인 PowerShell 세션의 PATH에는 sdkman java/gradle bin 이 없어 `java`/`gradle` 명령이 실패한다. 영구 User 환경변수에는 등록되어 있으므로 새 세션에서는 정상 동작할 것으로 판단. 구현 작업 셸에서 실패하면 `$env:Path += ";$env:JAVA_HOME\bin;C:\Users\SDS\.sdkman\candidates\gradle\current\bin"` 로 세션 보정.
