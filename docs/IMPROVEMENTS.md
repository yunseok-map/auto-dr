# auto-dr 개선 로드맵

코드 전체 분석 기준으로 도출한 강화·보완 항목. 위에서부터 임팩트 순.
상태: ⬜ 대기 / 🔧 작업중 / ✅ 완료 / ⏸ 보류

---

## 🎯 품질 업그레이드 (수렴 끊김·점수 신뢰도)

### Q1. ✅ 기본 상한 상향
- 수렴 전에 끊기던 원인은 토큰이 아니라 낮은 상한($0.50)이었음. `maxTotalCostUsd` $0.50→**$2.0**, `maxIterations` 5→**8**, 세션 상한 기본 $5→**$10**.
- 파일: `config.ts`, `limits.ts`.

### Q2. ✅ 독립 채점기(LLM-as-judge) 분리
- 개선한 모델이 자기 점수를 매기던 자가 채점 → 별도 모델(`judgeModel`, 기본 `sonnet`)이 최종 개선본을 독립 채점. 채택/합격선 판정에 사용. 점수 인플레·오정지 완화.
- 파일: `judge.ts`, `prompts.ts`(`buildJudgePrompt`), runner 통합, `config.ts`(`useJudge`/`judgeModel`).

### Q3. ✅ 마무리 정밀검증 패스
- 완료 선언 직전, 강한 모델(`finalPassModel` 또는 사다리 최상위)로 **전체를 한 번 더 꼼꼼히** 점검(최대 1회). 회차·예산 여유가 있을 때만.
- 파일: `runner.ts`(`forceFinal`/`finalPassDone`), `prompts.ts`(`finalThorough`), `config.ts`(`finalPass`/`finalPassModel`).

### Q4. ✅ 후속 패스 깊이 옵션화
- 2회차 이후 렌즈 수(`laterPassLenses`, 기본 1)·검증 여부(`laterPassVerify`, 기본 false)를 설정으로 조절(품질↔토큰 노브).
- 파일: `runner.ts`, `config.ts`, `types.ts`, dashboard 노출.

### Q5. ✅ 비용 상한 graceful 종료 (런 분석에서 발견한 버그)
- 예산 초과 호출 거부(`error_max_budget_usd`)를 **크래시(error)가 아니라 `stopped_cost`로** 마감 + 호출 전 예산 바닥 가드로 자멸적 승급 차단.
- 근거: [RUN_REPORT_20260628.md](RUN_REPORT_20260628.md). 파일: `runner.ts`(`isBudgetError`/`MIN_CALL_BUDGET_USD`).

### Q6. ✅ R1 — 후속 패스 edit 강제력 강화
- 2회차 이후 해결은 **그 항목을 실제로 고친 edit(`findingIds` 태그)이 있어야** 인정. 태그가 전혀 없으면 적용된 edit 수만큼만 인정 → "말로만 해결" 차단.
- 한 edit 이 여러 지적을 고치는 경우 `findingIds: [...]` 배열 지원. 파일: `types.ts`/`claudeAgent.ts`/`prompts.ts`/`runner.ts(applyLedger)`.

### Q7. ✅ R2 — 후반 새 발견 억제 + 열린 항목 해결 우선
- 2회차 이후 신규 지적을 회차당 **최대 `laterPassMaxNew`(기본 3)개**까지만, 중요도(high>medium>low) 우선으로 채택 → 대장 폭증/순진척 0 완화. 프롬프트도 "열린 항목 해결 최우선"으로 강화.
- 1회차·마무리 패스는 상한 없음(전체 수집). 파일: `prompts.ts`/`runner.ts`/`config.ts`.

### Q8. ✅ R3 — 예산 인지 모델 승급
- 직전 회차 비용 × 모델 단가비(haiku1·sonnet3·opus5)로 상위 모델 1콜 추정비 산출 → 잔여 예산이 부족하면 **승급 보류**(예산 벽으로의 자멸적 승급 차단). 파일: `runner.ts`(`estimateModelCost`).

### Q9. ✅ R4 — 오피스 재생성 왕복 검증
- docx/pptx 재생성 직후 다시 텍스트를 추출해 본문 손실(원문 대비 <50%)을 런타임 경고 + 왕복 테스트(`test/export.roundtrip.test.ts`). 파일: `state.ts`(`verifyOfficeRoundtrip`).

---

## 🔴 정합성·신뢰성 (최우선)

### 1. ✅ "해결 처리"와 실제 수정 적용 분리 → 가짜 해결 방지
- 문제: `runner.ts applyLedger`가 에이전트의 `resolvedIds`를 무조건 신뢰. `applyEdits`에서 패치가 실패(find 불일치)해도 항목이 resolved로 닫힘.
- 보완: `findingId`가 달린 edit이 **실제 적용된 경우에만** 해당 finding resolved 처리. 적용 실패분은 open 유지 + 경고.
- 파일: `src/orchestrator/runner.ts`

### 2. ✅ `applyEdits` 첫 일치 무조건 치환 → 오적용 방지
- 문제: `indexOf` 첫 일치만 보고 치환. 반복 문자열이면 엉뚱한 위치 수정. 공백 유연 정규식은 더 광범위.
- 보완: `find`가 2회 이상 등장하면 모호로 스킵(고유성 검증). 적용/모호/실패를 구분해 반환.
- 파일: `src/orchestrator/runner.ts`

### 3. ✅ 프로세스 재시작 시 런 고아화 정리
- 문제: 제어 신호·진행이 전부 인메모리(`controls.ts`). 서버 재시작 시 `run.json`에 `running`/`paused`로 남은 런이 영구 표시.
- 보완: 서버 시작 시 스윕 — 인메모리에 살아있지 않은 `running`/`paused` 런을 `error`(중단됨)로 정리.
- 파일: `src/dashboard/server.ts`, `src/orchestrator/state.ts`

---

## 🔒 보안

### 7. ✅ 대시보드 localhost 바인딩
- 문제: `app.listen(port)` → `0.0.0.0`(LAN 전체)에 노출. API 키 입력·임의 경로 실행이 외부에 열림.
- 보완: `127.0.0.1` 바인딩(환경변수로 오버라이드 허용).
- 파일: `src/dashboard/server.ts`, `src/config.ts`

### 8. ⬜ `fromUrl` SSRF 가드
- 사설 IP/메타데이터 대역 차단.
- 파일: `src/input/adapters.ts`

---

## 💰 비용·효율

### 4. ✅ 비-CLI provider 비용 상한 작동
- OpenAI/Gemini/Anthropic 단가표 + 미등록 모델 보수적 기본값 → 토큰 기반 비용 추정. 상한이 모든 provider에서 작동.
- 파일: `src/orchestrator/providers.ts` (`estimateCost`)

### 5. ✅ API 경로 prompt caching
- `callAnthropic` 메시지에 `cache_control: ephemeral` 추가 → 반복 프리픽스 캐싱으로 입력 비용 절감.

### 6. ✅ 대용량 1회차 분할(map-reduce) 검토
- 1회차 입력이 `LARGE_FIRST_CHARS`(24000자) 초과면 섹션 경계로 청크 분할 → 각 파트만 개선·지적 수집 → 순서대로 이어붙여 전체 개선본 생성(내용 누락 없이 컨텍스트 초과 방지).
- 파일: `src/orchestrator/chunked.ts`, `prompts.ts`(`chunk` 모드/`splitSections` export), runner 통합.

---

## 🧪 품질·관측

### 9. ✅ 순수 함수 유닛테스트
- `applyEdits`/`weightedScore`/`normalizeRubric`/`isPrivateIp` — `test/units.test.ts`, `npm test` (13 케이스 통과).

### 10. ✅ `run.json` 로그 분리
- 전체 로그는 `log.jsonl`에 append 누적, run.json에는 최근 200개만 보관(대시보드 호환 유지). `/api/runs/:id/log` 엔드포인트로 전체 조회.
- 파일: `src/orchestrator/state.ts`(`addLog`), `server.ts`.

---

## ✨ 기능 강화

### 11. ✅ 전역 동시성 큐 + 전역(세션) 비용 상한
- `limits.ts`: 동시 실행 슬롯(`AUTODR_MAX_CONCURRENT`, 기본 2) + 세션 누적 비용 상한(`AUTODR_MAX_SESSION_COST`, 기본 $5). runner에 통합.

### 12. ✅ A/B 비교 `peerId` 연결
- `/api/compare`가 두 변형 런을 서로의 `peerId`로 연결(`setComparePeer`). 비교 뷰 UI는 후속(프론트).

### 13. ✅ 근접 중복 findings 제거(임베딩 없이)
- 정규화 일치 + 문자 바이그램 자카드 유사도(임계 0.6)로 표현만 다른 중복까지 병합. LLM/임베딩 콜 0(결정적).
- 파일: `src/orchestrator/dedup.ts`. runner(대장 누적)·panel(렌즈 합치기) 공통 사용.

### 14. ✅ 회귀 가드(콘텐츠 보존)
- 개선본이 직전 베스트 대비 `SHRINK_VETO_RATIO`(50%) 미만으로 축소되면 본문 누락 의심 → 점수와 무관하게 채택 거부.
- 파일: `src/orchestrator/runner.ts`. (LLM 기반 규칙 재검증은 토큰 비용 때문에 보류, 결정적 가드로 대체)
