# auto-dr 개선 작업 계획 (v2)

> 이 문서는 토큰 절약을 위한 작업 기준 문서입니다. 큰 작업을 한 번에 다 하지 않고
> 이 체크리스트를 따라 단계별로 진행합니다. 각 단계 완료 시 `[x]`로 표시합니다.

## 요청 사항 (사용자)

1. **정지 / 일시정지 기능** — 토큰이 녹는 것을 막을 수 있게 런을 일시정지/재개/중단할 수 있어야 함.
2. **동일 문제 반복 시 자동 일시정지 + 강조 알림** — QA/검수 이후에도 같은 문제가 계속 발생하면
   스스로 잠시 멈추고, 해당 문제를 강조해 보여주고, 다음과 같은 알림을 띄움:
   > "불필요한 토큰 사용을 막기 위해 일시정지 됐습니다. 기존 내용 확인 부탁드립니다."
3. **UI/UX 대폭 강화** — 현재 디자인이 빈약하므로 보기 좋게 전면 개선.

## 설계

### 1) 일시정지/정지 제어
- `src/orchestrator/controls.ts` (신규): 런 ID별 인메모리 제어 레지스트리.
  - `signal(id, 'pause'|'resume'|'stop')`, `getDesired(id)`, `waitWhilePaused(id)`, `clearControl(id)`
  - 대시보드 서버와 러너가 같은 프로세스에서 동작 → 인메모리 공유 가능.
- 러너(`runner.ts`)는 **각 반복(=claude 호출) 직전**에 제어 상태를 확인.
  - `stop` → 즉시 중단(`stopped_user`).
  - `pause` → claude 호출 없이 대기(토큰 0). 재개되면 계속, 중단되면 종료.
- 서버 엔드포인트: `POST /api/runs/:id/pause|resume|stop`.

### 2) 동일 문제 반복 감지 → 자동 일시정지
- 각 반복 저장 후 `remainingIssues`를 정규화해 최근 `recurWindow`(기본 3)회 반복을 비교.
- 어떤 이슈가 최근 N회 **연속** 등장하면 → 자동 일시정지(`signal pause`) + `state.alert` 기록.
  - `alert = { type:'recurring', title, message, issues[], ts }`
  - 메시지: "불필요한 토큰 사용을 막기 위해 일시정지 됐습니다. 기존 내용 확인 부탁드립니다."
- 재개 시 alert 해제 + `recurMutedUntil`로 즉시 재발 방지.

### 3) UI/UX
- `styles.css` 전면 리디자인(토큰화된 디자인 시스템, 카드/그림자/그라데이션/애니메이션).
- 제어 버튼(일시정지/재개/중단) 헤더에 배치.
- 알림 배너(상단, 펄스 강조) + 토스트 + 데스크톱 알림(Notification API) + 비프음.
- 점수 차트(영역 채움/그라데이션), 런 목록 개선, 빈 상태 개선, 반응형.

## 데이터 모델 변경 (types.ts)
- `RunStatus`에 `'paused'`, `'stopped_user'` 추가.
- `RunState`에 `alert?`, `control?`, `recurMutedUntil?` 추가.
- `RunConfig`에 `recurWindow` 추가, `RunAlert` 타입 추가.

---

# v3 — 점진적(incremental) 리뷰로 전환

## 문제
기존 루프는 **매 회차 전체를 처음부터 다시 리뷰**하고 개선본을 통째로 다시 썼다.
→ 같은 지적을 반복하고 토큰을 낭비함.

## 사용자가 원하는 방식
- 1회차: 전체를 검토해 **지적사항을 `findings.md`(대장)에 누적**.
- 2회차+: 대장의 **열린 항목을 해결**하고, **이전에 놓친 새 문제만 추가**. 전체 재검사 금지.
- 모든 항목 해결 & 새 발견 없음 → 완료.

## 구현
- **데이터**: `Finding{ id, title, severity, status(open/resolved), foundIter, resolvedIter }`,
  `RunState.findings[]`. 에이전트 출력은 `resolved`(닫은 #id) + `new_findings`(새 항목) **델타만**.
- **프롬프트**(`prompts.ts`): 1회차=전체검토→new_findings, 2회차+=열린항목 해결+놓친것만 추가.
  열린 항목 목록을 `#id [severity] title` 로 전달.
- **러너**(`runner.ts`): `applyLedger`(해결/추가, 중복 제거) → 완료 판정(열린0&새0 또는 done).
  점수 최고 스냅샷은 `best/`에 보존하되 **다음 회차 입력은 항상 최신본(`current/`)** 을 이어받음.
  `detectStuck`: 한 항목이 `recurWindow`회 이상 안 풀리면 자동 일시정지(반복문제 감지).
- **산출물**: `runs/<id>/findings.md`(대장), `current/improved.*`(최신본), `best/`(최고점 스냅샷).
- **대시보드**: "🗒 지적사항 대장" 섹션(진행바 + 열린/해결 목록 + .md 열기), API `/api/runs/:id/findings`.

## v3 체크리스트
- [x] types: Finding/NewFinding/findings[] + IterationResult 델타 필드
- [x] prompts: 점진 프롬프트
- [x] claudeAgent: resolved/new_findings 파싱
- [x] state: findings.md, current/ 최신본, ledger 반영 저장
- [x] runner: applyLedger + 완료/막힘 판정
- [x] dashboard: 대장 섹션 + 엔드포인트
- [x] typecheck 통과 / 서버 기동 확인
- [ ] 실제 런으로 동작 확인 (사용자)

---

## (v2) 진행 체크리스트
- [x] 작업 계획 문서 작성
- [x] controls.ts 추가
- [x] types.ts / config.ts 갱신
- [x] runner.ts 일시정지·정지·반복감지 반영
- [x] server.ts 제어 엔드포인트 추가
- [x] styles.css 전면 리디자인
- [x] index.html / app.js 제어·알림·UI 반영
- [x] typecheck 통과
- [ ] 대시보드 수동 확인 (사용자)
