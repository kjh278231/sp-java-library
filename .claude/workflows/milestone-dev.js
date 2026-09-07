export const meta = {
  name: 'milestone-dev',
  description: 'SPP 솔버 마일스톤 개발: 문서확인(doc-checker) → 구현(implementer) → 검증(verifier) 수정 루프 → 게이트 판정',
  whenToUse: '설계 문서(docs/00~03)의 마일스톤(M0~M6)을 작업 단위로 차근차근 구현할 때. args: {milestone:"M0", tasks?:["M0-T1"], maxFixRounds?:2, includeRunTasks?:false, skipPreflight?:false, continueOnFail?:false}',
  phases: [
    { title: '준비', detail: '개발 환경 사전점검과 마일스톤 작업 목록 추출' },
    { title: '문서확인', detail: '작업별 구현 스펙 추출 (병렬)' },
    { title: '구현·검증', detail: '작업 순서대로 구현 → verify → 수정 루프' },
    { title: '게이트', detail: '마일스톤 완료 기준 판정과 문서 정합성 점검' },
  ],
}

// ───────────────────────── 인자 ─────────────────────────
const A = args && typeof args === 'object' ? args : {}
const M = typeof A.milestone === 'string' && A.milestone ? A.milestone.toUpperCase() : 'M0'
const MAX_FIX = typeof A.maxFixRounds === 'number' ? A.maxFixRounds : 2
const ONLY = Array.isArray(A.tasks) && A.tasks.length ? A.tasks.map(String) : null
const INCLUDE_RUN = A.includeRunTasks === true
const SKIP_PREFLIGHT = A.skipPreflight === true
const CONTINUE_ON_FAIL = A.continueOnFail === true

const DOCS = 'docs/00-overview.md, docs/01-infrastructure.md, docs/02-algorithm-design.md, docs/03-implementation-plan.md'
const DEV = `docs/dev/${M}`

// ───────────────────────── 스키마 ─────────────────────────
const S = (props, required) => ({ type: 'object', properties: props, required })
const str = { type: 'string' }
const strs = { type: 'array', items: str }

const PREFLIGHT_SCHEMA = S({
  ok: { type: 'boolean' },
  reportFile: str,
  checks: { type: 'array', items: S({ name: str, status: { type: 'string', enum: ['ok', 'warn', 'fail'] }, detail: str, hint: str }, ['name', 'status', 'detail']) },
  blockers: strs,
  warnings: strs,
}, ['ok', 'checks', 'blockers', 'warnings'])

const PLAN_SCHEMA = S({
  milestone: str,
  goal: str,
  planFile: str,
  gate: strs,
  tasks: { type: 'array', items: S({
    id: str, title: str,
    kind: { type: 'string', enum: ['code', 'script', 'data', 'run'] },
    size: str,
    docRefs: strs,
    dependsOn: strs,
    summary: str,
  }, ['id', 'title', 'kind', 'docRefs', 'dependsOn', 'summary']) },
}, ['milestone', 'gate', 'tasks'])

const SPEC_SCHEMA = S({
  taskId: str, title: str, specFile: str, summary: str,
  deliverables: { type: 'array', items: S({ path: str, description: str }, ['path', 'description']) },
  constraints: { type: 'array', items: S({ rule: str, docRef: str, kind: { type: 'string', enum: ['MUST', 'MUST_NOT'] } }, ['rule', 'docRef', 'kind']) },
  acceptance: { type: 'array', items: S({ check: str, how: str }, ['check', 'how']) },
  testPlan: strs,
  openQuestions: { type: 'array', items: S({ question: str, proposedDefault: str }, ['question', 'proposedDefault']) },
}, ['taskId', 'specFile', 'summary', 'deliverables', 'constraints', 'acceptance', 'testPlan', 'openQuestions'])

const IMPL_SCHEMA = S({
  taskId: str,
  status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
  changedFiles: strs,
  commandsRun: strs,
  testResults: str,
  notes: str,
  blockers: strs,
  disputed: { type: 'array', items: S({ issue: str, reason: str }, ['issue', 'reason']) },
}, ['taskId', 'status', 'changedFiles', 'commandsRun', 'testResults', 'notes', 'blockers'])

const VERIFY_SCHEMA = S({
  taskId: str,
  round: { type: 'number' },
  verdict: { type: 'string', enum: ['pass', 'fail'] },
  reportFile: str,
  checks: { type: 'array', items: S({ check: str, result: { type: 'string', enum: ['pass', 'fail', 'skipped'] }, evidence: str }, ['check', 'result', 'evidence']) },
  issues: { type: 'array', items: S({ severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, description: str, location: str, fixHint: str }, ['severity', 'description']) },
  summary: str,
}, ['taskId', 'verdict', 'checks', 'issues', 'summary'])

const GATE_SCHEMA = S({
  milestone: str,
  verdict: { type: 'string', enum: ['pass', 'fail', 'partial'] },
  reportFile: str,
  criteria: { type: 'array', items: S({ criterion: str, result: { type: 'string', enum: ['pass', 'fail', 'skipped'] }, evidence: str }, ['criterion', 'result', 'evidence']) },
  remaining: strs,
  recommendations: strs,
}, ['milestone', 'verdict', 'criteria', 'remaining', 'recommendations'])

const DRIFT_SCHEMA = S({
  milestone: str,
  reportFile: str,
  drifts: { type: 'array', items: S({
    area: str, docRef: str, docSays: str, codeDoes: str,
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
    resolution: str,
  }, ['area', 'docRef', 'docSays', 'codeDoes', 'severity', 'resolution']) },
  summary: str,
}, ['milestone', 'drifts', 'summary'])

// ───────────────────────── 프롬프트 ─────────────────────────
const J = (o) => JSON.stringify(o, null, 2)

const preflightPrompt = () => `[preflight 모드] 마일스톤 ${M} 개발을 시작하기 전 개발 환경을 점검하라. 코드·환경은 수정하지 않는다.
verifier 정의의 preflight 표(JDK 21+, Gradle/gradlew, Python 3.11+ 및 ortools, git 작업 트리, data/instances/ 파일 수, ${DOCS} 존재)를 전부 확인한다.
fail 항목만 blockers에 넣고, 각 항목에 설치·해결 힌트(winget 명령 등)를 쓴다.
결과를 ${DEV}/preflight.md 에 저장하고 reportFile에 경로를 넣는다.`

const planPrompt = () => `[모드 A: 마일스톤 계획] 마일스톤 ${M}의 작업 목록과 게이트를 설계 문서에서 추출하라.
읽을 문서: docs/00-overview.md(§1~§5), docs/03-implementation-plan.md(§1 순서 원칙, §2 개요, §3의 ${M} 절, §4 의존성, §5 리스크, §6 파라미터), 그리고 ${M} 절이 참조하는 01/02 절.
요구사항:
- 03 §3 ${M} 표의 각 행을 기본 작업 단위로 한다. 표에 없지만 선행이 필요한 작업(예: data/instances/ OR-Library 파일 확보, .gitignore, 디렉터리 골격)은 별도 작업으로 추가하고 summary에 근거를 쓴다.
- id는 "${M}-T1", "${M}-T2" … 순서. dependsOn은 앞선 id만 가리키도록 위상 정렬한다(01 §1 의존 방향, 03 §4).
- kind: code | script | data | run. "실행" 규모 항목(예: 기준선 1차 수집)은 run.
- gate: 03 §3 ${M}의 게이트 문장을 "무엇을 실행해 무엇을 확인한다" 형태의 항목으로 분해한다.
- git ls-files 와 ls 로 저장소 현황을 확인해 이미 있는 산출물은 summary에 "기존:" 표시.
- 계획을 ${DEV}/plan.md 에 표로 저장하고 planFile에 경로를 넣는다.`

const specPrompt = (t) => `[모드 B: 작업 스펙] 작업 ${t.id} "${t.title}"의 구현 스펙을 작성하라.
작업 정보:
${J(t)}
절차: docs/00-overview.md §1~§5 → docs/03-implementation-plan.md §3 ${M} 해당 행 → 위 docRefs 절 전부 → 관련 인프라 절(01 §1 패키지, §3 자료구조, §4 입출력, §7 CLI, §10 테스트, §11 스택·저장소) → 관련 02 절.
스펙에 반드시 담을 것: deliverables(경로·내용), constraints(MUST/MUST_NOT + 문서 참조), acceptance(검증자가 그대로 실행할 명령과 기대 결과), testPlan(정상·오류 케이스), openQuestions(문서에 없는 결정 + proposedDefault).
현재 코드베이스(git ls-files, Glob)에서 이 작업이 접하는 기존 파일을 확인해 스펙에 적는다.
kind가 run 인 작업이면 "실행 명령과 결과 저장 위치를 문서화한다"를 deliverable로 하고 장시간 실행 자체는 acceptance에 넣지 않는다.
스펙을 ${DEV}/specs/${t.id}.md 에 저장하고 specFile에 경로를 넣는다.`

const implPrompt = (t, spec) => `[구현 모드] 작업 ${t.id} "${t.title}"를 스펙대로 구현하라.
스펙 파일: ${spec.specFile}
스펙 요약:
${J({ summary: spec.summary, deliverables: spec.deliverables, constraints: spec.constraints, acceptance: spec.acceptance, testPlan: spec.testPlan, openQuestions: spec.openQuestions })}
먼저 스펙 파일과 작업 docRefs(${(t.docRefs || []).join(', ')}) 절을 직접 읽는다. 스펙과 문서가 충돌하면 문서를 따르고 notes에 기록한다.
openQuestions는 proposedDefault를 채택하고 notes에 "채택: …"으로 남긴다.
완료 조건: deliverables 전부 존재, testPlan 전부 구현, 테스트 명령을 실제로 실행해 통과, acceptance를 스스로 확인. 빌드가 깨진 상태로 끝내지 않는다.
스펙 밖 파일은 수정하지 않는다(빌드 연결 등 불가피한 경우 notes에 기록). git commit 은 하지 않는다.`

const fixPrompt = (t, spec, impl, verify, round) => `[fix 모드, ${round}회차] 작업 ${t.id} "${t.title}"의 verifier 판정이 fail 이다. 이슈를 수정하라.
스펙 파일: ${spec.specFile}
verifier 보고서: ${verify.reportFile || '(없음)'}
verifier 이슈(blocker/major 는 전부 처리, minor 는 비용이 작을 때만):
${J(verify.issues)}
직전 구현 보고:
${J({ status: impl.status, changedFiles: impl.changedFiles, notes: impl.notes, blockers: impl.blockers })}
규칙: 단언 약화·테스트 삭제·@Disabled 로 통과시키는 것 금지. 게이트 수치 완화 금지. 이슈가 틀렸다고 판단하면 고치지 말고 disputed 에 문서 절 인용 또는 재현 결과를 쓴다.
수정 후 테스트를 다시 실행하고 결과를 testResults 에 넣는다.`

const verifyPrompt = (t, spec, impl, round) => `[검증 모드, ${round}회차] 작업 ${t.id} "${t.title}" 구현을 스펙과 설계 문서에 대해 검증하라.
스펙 파일: ${spec.specFile}
스펙:
${J({ deliverables: spec.deliverables, constraints: spec.constraints, acceptance: spec.acceptance, testPlan: spec.testPlan, openQuestions: spec.openQuestions })}
구현자 보고(믿지 말고 직접 확인할 것):
${J(impl)}
절차: 1) constraints 각각 증거 확인 2) 빌드·테스트 직접 실행(출력 인용, 실행된 테스트 수 확인) 3) 테스트 품질(단언 없음·@Disabled·순환 테스트·testPlan 누락) 4) acceptance 각각 실제 실행·측정 5) 범위 위반(git status, deliverables 대비, 설계 문서 변경 여부) 6) 의존 방향(01 §1) import 검사 7) disputed 가 있으면 문서 인용으로 재판정.
verdict pass 는 blocker 0 이고 major 0 일 때만.
보고서를 ${DEV}/verify/${t.id}-r${round}.md 에 저장하고 reportFile 에 경로를 넣는다.`

const gatePrompt = (plan, results) => `[gate 모드] 마일스톤 ${M} 게이트를 판정하라.
게이트 항목(03 §3 ${M}):
${J(plan.gate)}
이번 실행에서 구현·검증된 작업:
${J(results.map(r => ({ id: r.task.id, title: r.task.title, kind: r.task.kind, verdict: r.verdict, changedFiles: r.impl ? r.impl.changedFiles : [] })))}
생략된 작업(run 등):
${J(SKIPPED.map(t => ({ id: t.id, title: t.title, kind: t.kind })))}
각 항목을 실제 실행·측정으로 확인한다(예: 55개 인스턴스 파싱 루프, us01 파싱 시간 3회 중앙값). 생략된 작업에 의존하는 항목은 skipped 로 표시하고 remaining 에 실행 명령을 적는다. 통과로 꾸미지 않는다.
보고서를 ${DEV}/gate.md 에 저장하고 reportFile 에 경로를 넣는다.`

const driftPrompt = (results) => `[모드 C: 정합성 점검] 마일스톤 ${M}에서 구현된 코드가 설계 문서와 어긋나는 곳을 찾으라.
변경 파일:
${J(uniq(results.flatMap(r => (r.impl && r.impl.changedFiles) || [])))}
점검 축: 패키지 구조·의존 방향(01 §1), 자료구조(01 §3), CLI 옵션(01 §7), 결과 JSON 필드(01 §4.4), 저장소 구성(01 §11), 파라미터 기본값(03 §6), 이번 마일스톤 작업들의 docRefs 절 절차.
설계 문서는 수정하지 않는다. 각 드리프트의 resolution 에 "코드 수정" 또는 "문서 개정 제안"을 쓴다.
결과를 ${DEV}/drift.md 에 저장하고 reportFile 에 경로를 넣는다.`

// ───────────────────────── 유틸 ─────────────────────────
function uniq(xs) { const s = new Set(); const out = []; for (const x of xs) { if (!s.has(x)) { s.add(x); out.push(x) } } return out }
function compactVerify(v) { return v ? { verdict: v.verdict, reportFile: v.reportFile, issues: v.issues, summary: v.summary } : null }
function compactImpl(i) { return i ? { status: i.status, changedFiles: i.changedFiles, testResults: i.testResults, blockers: i.blockers, disputed: i.disputed || [] } : null }

// ───────────────────────── 에이전트 호출 ─────────────────────────
// 커스텀 서브에이전트(.claude/agents/*.md)는 세션 시작 시 로드된다. 방금 만든 세션처럼 아직 인식되지 않으면
// 역할 정의 파일을 먼저 읽도록 지시한 범용 에이전트로 대체한다(도구 제한은 지침으로만 유지됨).
const ROLE_FILE = { 'doc-checker': '.claude/agents/doc-checker.md', implementer: '.claude/agents/implementer.md', verifier: '.claude/agents/verifier.md' }
let customAgents = true
async function call(prompt, opts) {
  const role = opts && opts.agentType
  if (!role) return agent(prompt, opts)
  if (customAgents) {
    try { return await agent(prompt, opts) }
    catch (e) {
      const msg = String((e && e.message) || e)
      if (!/agent type .* not found/i.test(msg)) throw e
      customAgents = false
      log(`커스텀 서브에이전트 '${role}' 를 이 세션에서 찾지 못함 → 역할 파일을 읽는 범용 에이전트로 대체 (새 세션에서는 정상 인식됨)`)
    }
  }
  const o = Object.assign({}, opts)
  delete o.agentType
  const pre = `너는 이 프로젝트의 '${role}' 역할이다. 먼저 ${ROLE_FILE[role] || '.claude/agents/' + role + '.md'} 를 Read 로 읽고 그 지침(역할·규칙·모드·보고 형식·도구 제한)을 그대로 따르라.

`
  return agent(pre + prompt, o)
}

// ───────────────────────── 1. 준비 ─────────────────────────
phase('준비')
let preflight = null
if (!SKIP_PREFLIGHT) {
  preflight = await call(preflightPrompt(), { label: 'preflight', phase: '준비', schema: PREFLIGHT_SCHEMA, agentType: 'verifier', effort: 'low' })
  if (!preflight) return { milestone: M, status: 'error', reason: 'preflight 에이전트가 결과를 반환하지 않음' }
  if (preflight.blockers.length) {
    log(`preflight 차단: ${preflight.blockers.join(' | ')}`)
    return { milestone: M, status: 'blocked', preflight }
  }
  if (preflight.warnings.length) log(`preflight 경고 ${preflight.warnings.length}건: ${preflight.warnings.join(' | ')}`)
}

const plan = await call(planPrompt(), { label: `plan:${M}`, phase: '준비', schema: PLAN_SCHEMA, agentType: 'doc-checker' })
if (!plan || !plan.tasks.length) return { milestone: M, status: 'error', reason: '작업 목록 추출 실패', preflight }

let tasks = plan.tasks
const SKIPPED = []
if (ONLY) {
  const keep = new Set(ONLY)
  for (const t of tasks) if (!keep.has(t.id)) SKIPPED.push(t)
  tasks = tasks.filter(t => keep.has(t.id))
  const missing = ONLY.filter(id => !plan.tasks.some(t => t.id === id))
  if (missing.length) log(`요청한 작업 id 가 계획에 없음: ${missing.join(', ')}`)
  for (const t of tasks) {
    const unmet = (t.dependsOn || []).filter(d => !keep.has(d))
    if (unmet.length) log(`주의: ${t.id} 의 선행 작업 ${unmet.join(', ')} 은 이번 실행 범위 밖 (이미 구현되어 있어야 함)`)
  }
}
if (!INCLUDE_RUN) {
  for (const t of tasks) if (t.kind === 'run') SKIPPED.push(t)
  tasks = tasks.filter(t => t.kind !== 'run')
}
if (SKIPPED.length) log(`생략: ${SKIPPED.map(t => `${t.id}(${t.kind})`).join(', ')} — includeRunTasks:true 또는 tasks 인자로 포함 가능`)
log(`${M} 작업 ${tasks.length}개: ${tasks.map(t => t.id).join(' → ')}`)
if (!tasks.length) return { milestone: M, status: 'nothing-to-do', plan, skipped: SKIPPED, preflight }

// ───────────────────────── 2. 문서확인 (스펙, 병렬) ─────────────────────────
// 스펙 추출은 읽기 전용이라 병렬로 시작해 두고, 구현 루프에서 순서대로 await 한다.
// (배리어를 두지 않으므로 T1 스펙이 끝나면 다른 스펙이 진행 중이어도 T1 구현이 시작된다.)
phase('문서확인')
const specPromises = tasks.map(t =>
  call(specPrompt(t), { label: `spec:${t.id}`, phase: '문서확인', schema: SPEC_SCHEMA, agentType: 'doc-checker' })
    .catch(() => null))

// ───────────────────────── 3. 구현·검증 (순차 + 수정 루프) ─────────────────────────
// 같은 작업 트리에서 빌드 파일·패키지를 공유하므로 구현은 의존 순서대로 하나씩 진행한다.
phase('구현·검증')
const results = []
let halted = null
for (let i = 0; i < tasks.length; i++) {
  const t = tasks[i]
  const spec = await specPromises[i]
  if (!spec) {
    results.push({ task: t, verdict: 'spec-failed', rounds: 0, impl: null, verify: null })
    log(`${t.id}: 스펙 추출 실패`)
    if (!CONTINUE_ON_FAIL) { halted = t.id; break }
    continue
  }

  let round = 1
  let impl = await call(implPrompt(t, spec), { label: `impl:${t.id}`, phase: '구현·검증', schema: IMPL_SCHEMA, agentType: 'implementer' })
  if (!impl) impl = { taskId: t.id, status: 'blocked', changedFiles: [], commandsRun: [], testResults: '', notes: '', blockers: ['구현 에이전트가 결과를 반환하지 않음'] }
  let verify = await call(verifyPrompt(t, spec, impl, round), { label: `verify:${t.id}#${round}`, phase: '구현·검증', schema: VERIFY_SCHEMA, agentType: 'verifier' })

  while (verify && verify.verdict !== 'pass' && round <= MAX_FIX) {
    const majors = verify.issues.filter(x => x.severity !== 'minor').length
    log(`${t.id}: verify #${round} fail (blocker/major ${majors}건) → fix #${round + 1}`)
    round++
    const fixed = await call(fixPrompt(t, spec, impl, verify, round), { label: `fix:${t.id}#${round}`, phase: '구현·검증', schema: IMPL_SCHEMA, agentType: 'implementer' })
    if (fixed) impl = fixed
    verify = await call(verifyPrompt(t, spec, impl, round), { label: `verify:${t.id}#${round}`, phase: '구현·검증', schema: VERIFY_SCHEMA, agentType: 'verifier' })
  }

  const verdict = verify ? verify.verdict : 'verify-failed'
  results.push({ task: t, spec: { specFile: spec.specFile, openQuestions: spec.openQuestions }, verdict, rounds: round, impl: compactImpl(impl), verify: compactVerify(verify) })
  log(`${t.id} "${t.title}": ${verdict} (${round}회차)`)

  if (verdict !== 'pass' && !CONTINUE_ON_FAIL) { halted = t.id; break }
}

// ───────────────────────── 4. 게이트 ─────────────────────────
phase('게이트')
const allPassed = !halted && results.length === tasks.length && results.every(r => r.verdict === 'pass')
let gate = null
let drift = null
if (allPassed) {
  // 게이트 판정(verifier)과 문서 정합성 점검(doc-checker)은 서로 독립 → 동시 실행, 둘 다 필요하므로 배리어가 맞다.
  const both = await parallel([
    () => call(gatePrompt(plan, results), { label: `gate:${M}`, phase: '게이트', schema: GATE_SCHEMA, agentType: 'verifier' }),
    () => call(driftPrompt(results), { label: `drift:${M}`, phase: '게이트', schema: DRIFT_SCHEMA, agentType: 'doc-checker' }),
  ])
  gate = both[0]
  drift = both[1]
  log(`게이트: ${gate ? gate.verdict : '판정 실패'}, 드리프트 ${drift ? drift.drifts.length : '?'}건`)
} else {
  log(`게이트 생략: ${halted ? `${halted} 에서 중단` : '실패한 작업 있음'}`)
}

const status = allPassed
  ? (gate && gate.verdict === 'pass' ? 'gate-passed' : (gate && gate.verdict === 'partial' ? 'gate-partial' : 'gate-failed'))
  : (halted ? 'halted' : 'tasks-failed')

return {
  milestone: M,
  status,
  haltedAt: halted,
  preflight: preflight ? { warnings: preflight.warnings, reportFile: preflight.reportFile } : null,
  plan: { planFile: plan.planFile, gate: plan.gate, taskCount: plan.tasks.length },
  tasks: results,
  skipped: SKIPPED.map(t => ({ id: t.id, title: t.title, kind: t.kind })),
  gate,
  drift,
}
