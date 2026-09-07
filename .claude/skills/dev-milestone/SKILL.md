---
name: dev-milestone
description: SPP 솔버의 마일스톤(M0~M6)을 설계 문서 기반으로 개발한다. milestone-dev 워크플로우로 문서확인(doc-checker) → 구현(implementer) → 검증(verifier) 수정 루프 → 게이트 판정을 실행하고 결과를 요약한다.
argument-hint: <M0|M1|...> [--tasks M0-T1,M0-T2] [--fix-rounds N] [--include-run] [--continue-on-fail] [--skip-preflight] [--resume <runId>]
disable-model-invocation: true
---

사용자가 `/dev-milestone` 를 호출했다. 이것은 다중 에이전트 오케스트레이션(Workflow 도구)에 대한 명시적 opt-in 이다.

## 1. 인자 해석

`$ARGUMENTS` 를 다음 규칙으로 읽는다. 첫 토큰이 마일스톤 id(M0~M6, 대소문자 무관). 없으면 `M0`.

| 옵션 | args 필드 | 기본 |
|---|---|---|
| `--tasks a,b` | `tasks: ["a","b"]` | 전체 |
| `--fix-rounds N` | `maxFixRounds: N` | 2 |
| `--include-run` | `includeRunTasks: true` | false (장시간 실행 작업 생략) |
| `--continue-on-fail` | `continueOnFail: true` | false (첫 실패 작업에서 중단) |
| `--skip-preflight` | `skipPreflight: true` | false |
| `--resume <runId>` | Workflow 의 `resumeFromRunId` 로 전달 | |

## 2. 실행 전 확인 (인라인, 짧게)

- `docs/00-overview.md` ~ `docs/03-implementation-plan.md` 와 `.claude/workflows/milestone-dev.js` 가 있는지 확인한다. 없으면 중단하고 알린다.
- `git status --short` 를 보고 미커밋 변경이 있으면 한 줄로 알리되 진행은 한다(워크플로우가 커밋하지 않으므로 사용자의 변경은 보존된다).
- 이전 실행 산출물(`docs/dev/<M>/`)이 있으면 "이전 실행 기록이 있음, 덮어씀" 을 한 줄로 알린다.

## 3. 워크플로우 실행

Workflow 도구를 `name: "milestone-dev"` 와 위에서 만든 `args` 객체로 호출한다. `args` 는 실제 JSON 객체로 넘긴다(문자열화 금지).
`--resume` 이 있으면 이전 도구 결과가 알려준 `scriptPath` 와 `resumeFromRunId` 를 함께 넘긴다.

실행은 백그라운드로 돈다. 완료 알림이 올 때까지 결과를 예측하지 않는다. 사용자가 진행 상황을 물으면 `/workflows` 를 안내한다.

규모 안내: 작업 하나당 스펙 1 + 구현 1 + 검증 1(+ 수정 루프당 2) 에이전트가 든다. M0 는 작업 8~10개라 20~40 에이전트 규모다. 사용자가 범위를 줄이고 싶으면 `--tasks` 를 쓴다.

## 4. 결과 처리

워크플로우 반환값의 `status` 에 따라:

- `blocked`: `preflight.blockers` 를 표로 보여 주고 각 항목의 설치 명령을 코드 블록으로 제시한다. 설치는 사용자가 한다.
- `halted` / `tasks-failed`: 실패한 작업의 `verify.issues`(severity 순)와 보고서 경로를 보여 준다. 재실행 방법을 제시한다: 고친 뒤 `/dev-milestone <M> --tasks <실패 id 이후>` 또는 `--resume <runId>`.
- `gate-passed` / `gate-partial` / `gate-failed`: 게이트 `criteria` 표, 드리프트 목록(있으면), `skipped` 작업과 `gate.remaining` 의 실행 명령을 보여 준다.

그다음 `docs/dev/<M>/summary.md` 를 쓴다. 내용: 실행 인자, 작업별 판정과 회차, 게이트 판정, 드리프트, 남은 일(run 작업 명령 포함), 참조 보고서 경로. 한국어, 표 위주.

마지막에 커밋을 **제안만** 한다(`git add -A && git commit`). 사용자가 요청하기 전에는 커밋하지 않는다. 드리프트에 "문서 개정 제안" 이 있으면 설계 문서 수정은 사람의 결정이라고 명시한다.
