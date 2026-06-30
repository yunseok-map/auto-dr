# auto-dr 고도화 로드맵

기능(엔진)·웹(대시보드) 개선. 상태: ⬜ 대기 / 🔧 작업중 / ✅ 완료 / ⏸ 보류

> 정합성·비용·품질 개선 이력은 [IMPROVEMENTS.md](IMPROVEMENTS.md), 실행 분석은 [RUN_REPORT_20260628.md](RUN_REPORT_20260628.md).

---

## ⭐ 최우선

### 1. ✅ 런 "이어하기" (resume from best)
멈춘 런의 best + 열린 findings 를 시드로 1회차부터 점진 모드 재개. `POST /api/runs/:id/continue`, 상세에 "이어하기" 버튼. (`state.buildResumeSeed`, runner `resumed`/`isFirst`)

### 2. ✅ 세션 한도 자동 재개
`stopped_ratelimit` 의 리셋 시각(`resumeAt`)을 파싱(`computeResumeAt`), `autoResume` 켜진 런을 서버 스케줄러(60s)가 리셋 후 자동 이어하기. UI 토글 + 카운트다운 표시.

### 3. ✅ 설정 프리셋 / 마지막 설정 기억
고급 옵션을 localStorage 저장·복원(`saveFormPrefs`/`restoreFormPrefs`), placeholder 실효 기본값 표기. 스테일 값 혼란 방지.

### 4. ✅ 라이브 비용 게이지
누적 비용/상한 게이지(75%/90% 경고색) + 토큰 카드. "왜 멈췄는지" 가시화.

---

## 🔧 엔진/기능

### 5. ✅ 루프 단위 테스트(가짜 에이전트 주입)
`agentHooks` 주입 + `AUTODR_RUNS_DIR` 격리 → LLM 없이 전체 루프 검증(`test/loop.test.ts`).

### 6. ✅ 코드 입력 → unified diff
코드 런은 원본 대비 패치(`best/improved.diff`) 생성(`output/diff.ts`), `GET /api/runs/:id/best/diff`, UI 다운로드 링크.

### 7. ✅ severity 우선 해결 큐
열린 항목을 high>medium>low 순으로 정렬해 프롬프트에 제시.

### 8. ✅ 평가기준 자동 추천
`suggestRubric(kind, focus)` + `GET /api/rubric/suggest`.

### 9. ✅ 언어 자동 감지·대응
`detectLang` 으로 입력 언어 감지 → 출력 언어 지시.

### 10. ✅ 외부 알림(웹훅)
종료 시 요약 POST(`webhookUrl`/`AUTODR_WEBHOOK_URL`, Slack/Discord 호환).

---

## 🖥 웹/대시보드

### 11. ✅ 실시간 단계 표시
진행 중 hero 에 최근 로그(현재 단계) 표시 — panel 길이로 인한 "멈춘 줄" 오해 감소.

### 12. ✅ findings 심각도 필터
대장에 전체/high/medium/low 필터 칩.

### 13. ✅ diff 뷰 단어 단위 하이라이트
수정된 줄은 단어 단위로 짝지어 `<w-del>`/`<w-ins>` 강조 + "변경된 줄만 보기" 토글(eq 줄 접기). (`renderDiff`/`wordDiff`)

### 14. ✅ 런 관리(검색/삭제)
사이드바 검색 + 런별 삭제(`DELETE /api/runs/:id`, 경로 탈출 방지·진행 중 거부).

### 15. ✅ 전체 로그 뷰어
`log.jsonl` 링크(`GET /api/runs/:id/log`)를 진행 기록 카드에 노출.

### 16. ✅ 친절한 종료 안내 + 액션
`stopped_cost`/`stopped_ratelimit` 시 힌트 배너 + "이어하기" 버튼 + 리셋 시각.

### 17. ⛔ 다크 테마 — 보류(불필요)
라이트 단일 테마 유지. i18n(한/영)만 추후 후보로 남김.
