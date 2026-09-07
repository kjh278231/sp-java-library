# M0 Preflight 점검 보고서

- 일시: 2026-09-07
- 모드: preflight (환경 점검만, 설치·변경 없음)
- **판정: FAIL** (blocker 1건: JDK 미설치)

## 체크 표

| 항목 | 상태 | 확인 명령 / 증거 | 힌트 |
|---|---|---|---|
| JDK 21+ | **fail** | `java -version` → `'java' is not recognized`. `JAVA_HOME` 비어 있음. `C:\Program Files\{Java,Eclipse Adoptium,Microsoft,Zulu}` 및 `%LOCALAPPDATA%\Programs` 에 JDK 디렉터리 없음. `winget list --id Microsoft.OpenJDK` → 설치된 패키지 없음 | `winget install --id Microsoft.OpenJDK.21 -e` 후 새 터미널에서 `java -version` 확인 (또는 `winget install --id EclipseAdoptium.Temurin.21.JDK -e`) |
| Gradle / gradlew | warn | `Test-Path .\gradlew.bat` → False. `gradle --version` → 명령 없음 | 첫 작업(M0-T1)에서 wrapper 부트스트랩 필요. 시스템 Gradle 설치: `winget install --id Gradle.Gradle -e` 후 `gradle wrapper --gradle-version 8.10` |
| Python 3.11+ | ok | `python --version` → `Python 3.14.5` | (ortools 휠이 3.14를 지원하지 않으면 3.12 병행 설치: `winget install --id Python.Python.3.12 -e`) |
| Python ortools | warn | `python -c "import ortools"` → `ModuleNotFoundError: No module named 'ortools'` | 기준선 스크립트 작업에서 `python -m pip install ortools` (3.14 미지원 시 3.12 venv 사용) |
| git 작업 트리 | warn | `git status --short` → ` D DESIGN.md`, ` D DESIGN.v1.md`, `?? .claude/`, `?? CLAUDE.md`, `?? docs/` (미커밋 변경 5건) | 설계 문서 이동/추가분을 M0 시작 전 커밋 권장: `git add -A && git commit -m "docs: move design docs to docs/, add agents"` |
| 데이터 `data/instances/spp*.txt` | warn | `data/` 디렉터리 없음, 파일 0개 (기대 55개) | 데이터 준비 작업(M0)에서 OR-Library spp 인스턴스 55개를 `data/instances/`에 배치 |
| docs/00-overview.md | ok | 존재 (8,764 B) | |
| docs/01-infrastructure.md | ok | 존재 (16,071 B) | |
| docs/02-algorithm-design.md | ok | 존재 (15,694 B) | |
| docs/03-implementation-plan.md | ok | 존재 (12,957 B) | |

## Blockers
1. JDK 21+ 미설치 — `winget install --id Microsoft.OpenJDK.21 -e`

## Warnings
1. Gradle wrapper(`gradlew.bat`)·시스템 Gradle 모두 없음 — 첫 작업에서 부트스트랩
2. Python `ortools` 미설치 — 기준선 스크립트 작업에서 설치 (Python 3.14 휠 호환 확인 필요)
3. git 미커밋 변경 5건 (DESIGN.md/DESIGN.v1.md 삭제, .claude/, CLAUDE.md, docs/ 미추적)
4. `data/instances/` 없음 — spp 인스턴스 0/55

## 실행 명령 원본 발췌
```
java -version
  'java' is not recognized as the name of a cmdlet ...
Test-Path .\gradlew.bat
  False
gradle --version
  'gradle' is not recognized ...
python --version
  Python 3.14.5
python -c "import ortools"
  ModuleNotFoundError: No module named 'ortools'
git status --short
   D DESIGN.md
   D DESIGN.v1.md
  ?? .claude/
  ?? CLAUDE.md
  ?? docs/
ls data/instances/spp*.txt | wc -l
  0
```
