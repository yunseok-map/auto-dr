# UI 리디자인 — "덜 둥글게, 더 기술적으로"

> 목적: 현재 대시보드의 과도하게 둥근(soft/bubbly) 느낌을 제거하고, Linear·Vercel·Datadog·Stripe 류의 **sharp / instrument-panel / technical** 느낌으로 전환.
> 작업 대상: `src/dashboard/public/styles.css` (단일 파일). HTML/JS 구조 변경 없음 → 토큰 사용 최소화.

## 1. 레퍼런스 리서치 요약

핀터레스트·Medium·디자인 시스템 글을 조사한 결론:

- **Linear** — "midnight command deck". status badge `border-radius: 2px`, 카드는 1px inset border + soft shadow(채움색 X), accent는 화면당 1개 action에만 절제. dense "instrument-panel" 밀도. (`linear.app/now/how-we-redesigned-the-linear-ui`)
- **Vercel / Stripe** — 얇은 sans-serif, sharp line, 장식 배제, 기능 중심 미니멀.
- **Datadog / Sentry / Supabase** — dark-mode-first 기술 도구. 각진 컨테이너, 낮은 radius, 정보 밀도 우선.
- **공통 원칙(zazzy)** — sharp edge는 "professionalism, seriousness, attention to detail"을 전달. 중요 데이터/액션 컨테이너에 각진 모서리가 신뢰감을 줌.

**진단 — 현재 무엇이 "너무 둥근가":**
| 요소 | 현재 | 문제 |
|---|---|---|
| pill `999px` | ghost-btn, seg, tab, tag, badge, dim-track, ledger-bar 등 다수 | 알약형이 가장 큰 "bubbly" 원인 |
| `--r-lg 14px` | section, alert, toast | 카드가 풍선처럼 보임 |
| `--r 10px` / `--r-sm 7px` | 대부분 컨테이너/인풋 | 전반적으로 물렁한 느낌 |
| gradient 채움 + glow shadow | card, start-btn, logo | soft·과장된 입체감 |

## 2. 개선 방향 (디자인 토큰 재정의)

radius를 **계단식으로 대폭 축소**하고, pill을 거의 전부 제거한다.

```
--r-lg: 14px → 6px     (section, alert, toast, viewer)
--r:    10px → 4px     (card, drop, input 컨테이너)
--r-sm:  7px → 3px     (작은 버튼/인풋/태그)
--r-pill: 999px → 4px  (신규 — 기존 pill을 거의 각지게; conn-dot 같은 '점'만 원형 유지)
```

원형(circle) 유지 예외: `conn-dot`, `drop-ico` 같은 **상태 점/아이콘 도트**만 `50%` 유지 (정보성 점은 원형이 관습).

## 3. 구체적 변경 목록 (styles.css)

1. **:root 토큰**
   - `--r-lg:6px; --r:4px; --r-sm:3px;` 추가로 `--r-pill:4px;`
   - shadow 약하게: glow성 컬러 그림자 줄이고 중립 그림자로. `--ring`은 radius 3px에 맞게 유지하되 두께 2px로.
2. **pill(`999px`) → `var(--r-pill)`(4px)로 일괄 치환** 대상:
   - `.ghost-btn`, `.seg`/`.seg-btn`(이미 9px/6px → 4px/3px), `.tab`, `.kind-tag/.status-tag`, `.badge`, `.dim-track/.dim-fill`, `.ledger-bar`, `.issues 999px류`, `.score-pill`(텍스트라 radius 영향 적음).
   - 단, **progress bar(track/fill)** 는 `2px`로 (얇은 막대는 살짝만).
3. **scrollbar thumb** `8px → 2px`, border 3px→2px.
4. **logo** `border-radius:10px → 4px`, inset glow 약화.
5. **그라데이션/글로우 절제** (선택적, 과하지 않게):
   - `.card` 그라데이션 채움 → 평평한 `--panel2` 단색 + 1px border 유지(Linear식).
   - `.start-btn` glow shadow 강도 ↓.
   - `.seg-btn.active`, `.tab.active` 의 큰 glow shadow ↓ (3px→2px, 투명도↓).
6. **세그/탭 active** accent 유지하되 box-shadow 약하게(절제된 accent 원칙).
7. 모바일 `@media` 의 radius 영향 없음(구조만) → 변경 불필요.

## 4. 비변경 원칙 (덜 건드려서 토큰 절약)

- 색상 팔레트(다크 네이비)·타이포·레이아웃·간격은 **유지**. radius와 일부 shadow만 손본다.
- HTML/JS는 손대지 않는다(클래스명 그대로).
- 한 번의 일괄 치환 위주로 edit 횟수 최소화.

## 5. 적용 후 기대

알약형 컨트롤이 4px 각진 형태로 바뀌고, 카드/섹션의 14px가 6px로 줄어 전체적으로 **각지고 단단한 technical 대시보드** 인상. 정보 밀도·신뢰감 상승, "동글동글"한 느낌 제거.
