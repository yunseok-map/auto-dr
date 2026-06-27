# auto-dr 기능 고도화 스펙 — V4

> 선택된 5개 기능을 설계한다. **모두 opt-in** — 기존 단일-리뷰 자율 루프는 그대로 동작해야 한다(하위호환 필수).
> 대상 스택: `src/orchestrator/*`, `src/input/adapters.ts`, `src/output/export.ts`, `src/dashboard/*`, `src/types.ts`, `src/config.ts`.
> 이 문서가 구현 기준(single source of truth).

## 0. 범위

1. **다각도 리뷰 패널 + 지적 검증** — 패스당 여러 렌즈 병렬 리뷰 → 합치고 중복제거 → 진위 검증 → 개선.
2. **맞춤 평가 기준(rubric)** — 평가 항목·가중치·합격선을 사용자가 정의(템플릿 제공).
3. **참고자료 첨부** — 스타일가이드/사양서를 같이 올리면 그 기준에 대조·수정.
4. **변경 추적 / 코멘트 출력** — 무엇을 왜 바꿨는지 표시된 마크업본 + 변경 내역 산출물.
5. **런 A/B 비교** — 같은 입력을 두 설정으로 돌려 나란히 비교.

---

## 1. 데이터 모델 (types.ts) — 추가 필드 (전부 optional)

```ts
// 평가 기준 한 항목
interface RubricDimension { name: string; weight: number; description?: string; }
interface Rubric { dimensions: RubricDimension[]; passThreshold?: number; template?: string; }

// 참고자료 1건 (추출된 텍스트로 보관)
interface ReferenceDoc { id: string; title: string; ext: string; chars: number; }

// 변경 내역 1건 (패스별 누적)
interface ChangeEntry { iter: number; find: string; replace: string; reason?: string; findingId?: number; }

// EditOp 확장
interface EditOp { find: string; replace: string; reason?: string; findingId?: number; }

// RunConfig 추가
reviewMode?: 'single' | 'panel';        // 기본 single(기존 동작)
lenses?: string[];                       // panel 모드 렌즈 목록(기본: 정합성/구조/표현/사실성)
verifyFindings?: boolean;                // panel: 지적 진위 검증 패스 on/off
rubric?: Rubric;                         // 맞춤 평가기준
emitChanges?: boolean;                   // 변경 추적 산출물 생성 여부

// RunInput 추가
references?: ReferenceDoc[];             // 첨부 참고자료(추출본은 runs/<id>/refs/ 에 저장)

// RunState 추가
refsDigest?: string;                     // 참고자료 압축 요약(토큰 절약용, 1회 생성)
changeLog?: ChangeEntry[];               // 누적 변경 내역
compare?: { groupId: string; variant: 'A' | 'B'; label?: string; peerId?: string };
```

state.md/run.json 저장은 기존 writeState 흐름에 그대로 얹는다.

---

## 2. 기능 ② 맞춤 평가 기준 (rubric) — 토대

가장 먼저 구현(다른 기능이 점수 체계를 공유).

- **데이터:** `config.rubric = { dimensions:[{name,weight,description}], passThreshold }`.
- **템플릿:** 코드/문서/이력서/마케팅용 기본 rubric 4종을 `src/orchestrator/rubrics.ts`에 상수로. 대시보드에서 선택→편집.
- **프롬프트(prompts.ts):** rubric이 있으면 "다음 항목으로 평가하라: name(가중치 w) — description …"를 명시하고, **dimensions JSON 키를 rubric 항목명으로 강제**. 종합 점수는 **코드에서 가중평균**으로 재계산(모델 score는 참고용) → 일관성↑.
- **합격선:** `passThreshold` 도달 시 완료 후보(기존 plateau/done와 함께). 도달하면 로그/상태에 표시.
- **대시보드:** 고급 옵션에 "평가 기준" 패널 — 템플릿 셀렉트 + 항목 추가/삭제 + 가중치 입력 + 합격선. POST body에 `rubric`(JSON) 추가, server.ts 파싱.
- **하위호환:** rubric 없으면 기존처럼 모델이 dimensions 자유 산정.

**구현 위치:** types.ts, config.ts(기본 rubric 없음), rubrics.ts(신규), prompts.ts, runner.ts(가중평균·합격선), claudeAgent.ts(점수 재계산 훅), server.ts, app.js/index.html.

---

## 3. 기능 ③ 참고자료 첨부 (RAG-lite)

- **업로드:** 대시보드 새 분석 폼에 "참고자료(여러 개)" 파일 입력. server.ts multer `upload.fields([{name:'file'},{name:'refs', maxCount:5}])`.
- **추출:** `resolveInput`의 추출 로직 재사용(`extractAny(path)` 분리)으로 각 ref를 텍스트화 → `runs/<id>/refs/<n>.md` 저장 + `RunInput.references` 메타.
- **압축 요약(토큰 절약):** 런 시작 시 참고자료 전체를 **한 번** 저렴 모델(haiku)로 "지켜야 할 규칙 목록"으로 요약 → `state.refsDigest`. 이후 매 패스 프롬프트엔 **digest만** 주입(원문 전체 X). digest가 너무 길면 잘라냄(상한 표시).
- **프롬프트:** "참고 기준(반드시 따를 것): {refsDigest}" 섹션 추가. 위반은 지적·수정 대상.
- **하위호환:** refs 없으면 digest 생성·주입 모두 skip.

**구현:** adapters.ts(extractAny 추출 분리 + ref 처리), runner.ts(digest 1회 생성), prompts.ts(주입), server.ts(멀티 업로드), state.ts(refs 저장), app.js/index.html(폼).

---

## 4. 기능 ① 다각도 리뷰 패널 + 검증

`reviewMode:'panel'`일 때만. single이면 기존 경로 그대로.

**패스 파이프라인 (panel):**
1. **병렬 렌즈 리뷰** — `lenses`(기본: 정합성·구조·표현·사실성) 각각 `claude -p`로 **지적만**(findings-only) 산출. 각 렌즈는 자기 관점 지적 리스트 + 해당 렌즈 점수. (claudeAgent에 `mode:'findings'` 경량 프롬프트/파서 추가, Promise.all 병렬.)
2. **합치기+중복제거(코드):** 모든 렌즈 findings를 normTitle로 dedupe.
3. **진위 검증(verifyFindings on):** dedupe된 지적을 한 번의 `claude -p`로 "각 지적이 실제로 타당한가(real/false) + 심각도"를 판정 → false 제거. (다수 거짓지적 차단.)
4. **개선 적용:** 검증 통과 findings + 현재본 → `claude -p`(editor 프롬프트)로 edits(+reason/findingId) + 가중평균용 dimensions 산출.
- 패스당 호출 수 = lenses + (verify?1:0) + 1. **비용↑ → opt-in**, 기존 비용 상한/모델 라우팅과 함께 동작. 라우팅은 editor 호출에 적용, 렌즈 리뷰는 기본 저렴 모델(haiku) 고정(설정 가능).
- **점진(2회차+):** 1회차는 풀 패널, 이후는 "열린 항목 해결 + 놓친 것 1렌즈 빠른 점검"으로 호출 줄이는 옵션(비용 타협). 우선은 매 패스 풀 패널로 구현하고 비용은 상한으로 관리.

**구현:** claudeAgent.ts(findings/verify/editor 모드 분리 호출 함수), prompts.ts(렌즈/검증/에디터 프롬프트), runner.ts(panel 분기), types.ts.

---

## 5. 기능 ④ 변경 추적 / 코멘트 출력

`emitChanges:true`일 때.

- **수집:** edits에 `reason`/`findingId`를 받아(프롬프트에서 요구) 패스마다 `state.changeLog`에 누적(적용 성공분만).
- **md 산출물:** `runs/<id>/best/changes.md` — 각 변경: "원문 → 수정 / 이유 / 관련 지적 #". + 원본↔개선본 라인 diff(서버측 생성 or 기존 클라 diff 재사용).
- **오피스 산출물:** docx는 `docx` 라이브러리로 **코멘트 또는 변경요약 문서** 생성(인라인 위치추적은 어려우니, 1차로 "변경 요약 docx"=표 형태 원문/수정/이유). pptx/pdf는 변경요약 md→기존 export로.
- **대시보드:** 미리보기에 "변경 내역" 탭 추가 — changeLog를 카드 리스트(원문/수정/이유/지적칩)로. 다운로드 버튼에 "변경 내역(.md/.docx)".
- **하위호환:** emitChanges 없으면 수집·생성 skip.

**구현:** types.ts(EditOp.reason, ChangeEntry), runner.ts(누적), state.ts(changes.md 작성), export.ts(변경요약 docx), server.ts(다운로드 라우트), app.js(탭).

---

## 6. 기능 ⑤ 런 A/B 비교

- **시작:** 대시보드 "A/B로 비교" 토글 → 변형 A/B 각각의 설정(초점/모델/기준) 입력 → server.ts가 **같은 입력으로 두 런을 생성**하되 `compare={groupId, variant, peerId}` 부여. 순차 또는 병렬 실행(기본 순차로 비용/부하 관리).
- **상태:** 두 run.json에 compare 메타. listRuns에서 groupId로 묶음 인식.
- **대시보드 비교 뷰:** 그룹 선택 시 좌(A)/우(B) 2열 — 제목·상태·점수 링·초안 스텝퍼·dimensions·findings 요약·최종 개선본 링크를 나란히. "더 나은 쪽 채택" 안내.
- **하위호환:** compare 없으면 일반 단일 런 UI.

**구현:** types.ts(compare), server.ts(`POST /api/compare` 두 런 생성), state.ts(메타), app.js(그룹 감지 + 비교 레이아웃), index.html/styles.css(2열).

---

## 7. 구현 단계 (phase)

- **P1 데이터 모델:** types.ts + config.ts 추가 필드(전부 optional). 빌드 깨지지 않게.
- **P2 rubric(②):** rubrics.ts + prompts.ts + runner 가중평균/합격선 + 대시보드 편집기 + server 파싱.
- **P3 references(③):** adapters extractAny 분리 + 멀티 업로드 + digest 1회 + 프롬프트 주입.
- **P4 panel(①):** claudeAgent 모드 분리 + 병렬 렌즈 + dedupe + verify + editor + runner 분기.
- **P5 changes(④):** edit reason 수집 + changes.md/docx + 대시보드 탭.
- **P6 compare(⑤):** /api/compare + 비교 뷰.
- 각 phase 후 `npm run typecheck` 통과 + 기존 단일 런 동작 보존 확인.

## 8. 하위호환·비용 원칙

- 모든 신기능 기본 OFF. 기본 설정으로 시작한 런은 V3와 동일하게 동작.
- panel/refs/web 등 호출 증가 기능은 기존 `maxTotalCostUsd`·모델 라우팅·patience 상한 아래에서 동작.
- 토큰 절약: refs는 digest만, 점진 패스 경량화 옵션, 렌즈 리뷰는 저렴 모델 고정.

## 9. 수용 기준(각 기능)

- ② rubric: 항목/가중치 지정 시 dimensions가 그 항목으로 나오고 종합=가중평균, passThreshold 도달 시 완료표시.
- ③ refs: 첨부 시 digest 생성·프롬프트 반영, 미첨부 시 무변화.
- ① panel: 렌즈별 병렬 호출→합산→검증→개선, false 지적 감소, single 모드 무영향.
- ④ changes: changes.md/docx 생성 + 대시보드 "변경 내역" 탭에 이유·지적 표시.
- ⑤ compare: 두 변형 생성·실행·2열 비교, 일반 런 무영향.
