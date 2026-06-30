# URL(웹사이트) 리뷰 고도화 계획

현재: `fromUrl` 이 HTML 을 텍스트로 납작하게(`htmlToText`) 만들어 **보이는 글자만** 리뷰. → 코드·구조·SEO·접근성·성능·리소스를 못 봄. SPA 는 빈 셸만 읽힘.

상태: ⬜ 대기 / 🔧 작업중 / ✅ 완료 / ⏸ 보류

---

## 바로 구현 (의존성 없음)

### 1. ✅ 구조 보존 추출(텍스트 평면화 탈피)
제목·meta·heading 위계·링크·이미지·리소스를 **구조화 요약**으로 뽑아 리뷰어에게 제공. 보이는 글자만이 아니라 "문서 구조"를 판단.

### 2. ✅ SEO/메타 분석
`<head>` 파싱: title(길이), meta description(길이), canonical, robots, viewport, `html lang`, Open Graph/Twitter 카드, JSON-LD 구조화 데이터 유무 → 누락·과다 플래그.

### 3. ✅ 접근성(a11y) 정적 신호
alt 없는 이미지 수, heading 순서 점프, `lang` 누락, 모호한 링크 텍스트("여기/클릭/here"), 빈 링크 → 요약에 포함.

### 4. ✅ "전반적인 코드" 읽기 — HTML 소스 + 동일 출처 CSS/JS 번들
납작한 텍스트 대신 **원본 HTML(발췌) + 같은 도메인 CSS/JS 파일(개수·용량 제한)** 을 함께 묶어 리뷰. 마크업/스타일/스크립트 품질까지 평가 가능. (사용자 요청의 핵심)

### 5. ✅ 리뷰 모드 선택(`urlMode`)
- `content`: 기존처럼 본문 텍스트만(콘텐츠/카피 리뷰)
- `full`(기본): 개요+구조+본문+HTML소스+CSS/JS (종합)
- `source`: 개요+코드 위주(개발자용)

### 5b. ✅ urlMode 별 평가 루브릭 자동 전환
모드에 따라 채점 차원이 바뀜(의도-채점 일치):
- `content` → 명료성·구조·완결성·SEO/접근성·**설득력**
- `source` → **마크업/시맨틱·접근성·성능·코드품질·SEO**
- `full` → 명료성·구조·접근성·SEO·성능·설득력(하이브리드)
- 개선본 가이드도 모드별(콘텐츠 초안 / 코드 개선안 / 하이브리드). 맞춤 rubric 을 주면 항상 그게 우선. (`prompts.rubricDimsFor`/`artifactGuideFor`)

### 6. ✅ 리소스/페이지 무게 요약
HTML 크기, 외부 스크립트/스타일/이미지 개수, 인라인 스크립트 수 → 성능 관점 신호.

### 7. ✅ SPA 감지 힌트
본문 텍스트가 거의 없고 스크립트가 많으면 "JS 렌더링 필요(SPA) 가능성" 표시 → 리뷰어 오판 방지 + 8번 안내.

---

## 후속(의존성/비용 큼) — 보류

### 8. ✅ 실제 JS 렌더링(headless 브라우저)
Playwright(chromium)로 렌더 후 실 DOM 추출 → SPA 정확 리뷰. `urlRender`: `auto`(SPA 감지 시)·`on`(항상)·`off`. 미설치/실패 시 정적 HTML 로 graceful 폴백. (`src/input/render.ts`)
- 설치: `npm install` 후 `npx playwright install chromium` (브라우저 바이너리).

### 9. ✅ 다중 페이지 크롤
같은 도메인 내부 링크를 BFS 로 따라가 페이지별 구조 요약(`urlCrawl`, 최대 8쪽, 정적 분석). `crawlSummary`.

### 10. ✅ 링크 유효성 검사
링크에 HEAD(필요시 GET) 요청해 4xx/5xx/연결오류 탐지(`urlCheckLinks`). 내부/사설 주소는 안전상 건너뜀, 최대 40개·동시 6. `checkLinksSection`.

> 보안: 모든 리소스 fetch 는 **동일 출처(host)만**, 크기·개수·타임아웃 제한, 기존 SSRF 가드(사설/메타데이터 차단) 유지.
