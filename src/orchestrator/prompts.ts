import type { Finding, InputKind, Rubric, RunInput, Severity } from '../types.js';

// ── V4: 다각도 리뷰 패널 기본 렌즈 ──
export const DEFAULT_LENSES = ['정합성', '구조', '표현', '사실성'];
const LENS_DESC: Record<string, string> = {
  정합성: '논리적 일관성·앞뒤 모순·정의/주장과 근거의 정합성',
  구조: '구성·흐름·섹션 배치·내비게이션·중복',
  표현: '문장 명료성·표기·어조·가독성·간결성',
  사실성: '사실·수치·인용·고유명사의 정확성',
  정확성: '버그·엣지케이스·오류 가능성',
  보안: '취약점·입력검증·민감정보 노출',
  성능: '비효율·불필요한 비용',
};

// 한 렌즈 관점에서 "지적만" 산출하는 프롬프트(고치지 않음).
export function buildLensPrompt(input: RunInput, artifact: string, lens: string, refsDigest?: string): string {
  const desc = LENS_DESC[lens] ?? lens;
  return `너는 "${lens}" 한 관점만 보는 전문 리뷰어다. 대상: ${input.kind} / ${input.title}
오직 "${lens}"(${desc}) 측면의 문제만 찾아라. 다른 관점은 무시한다. 고치지 말고 "지적"만 한다.
${refsDigest && refsDigest.trim() ? `\n[반드시 따를 기준]\n${refsDigest.trim()}\n` : ''}
[대상]
<<<ARTIFACT
${artifact}
ARTIFACT>>>

오직 하나의 JSON 객체만 출력(코드펜스·설명 금지):
{ "findings": [ { "title": "<문제 요약 1문장>", "severity": "low|medium|high" }, ... ], "score": <이 관점 점수 0-100> }
문제가 없으면 findings 는 []. 과장·중복 금지, 핵심만.`;
}

// 모인 지적들의 진위를 판정하는 검증 프롬프트.
export function buildVerifyPrompt(input: RunInput, artifact: string, candidates: { title: string; severity?: Severity }[]): string {
  const list = candidates.map((c, i) => `  ${i + 1}. [${c.severity ?? 'medium'}] ${c.title}`).join('\n');
  return `너는 엄격한 검증자다. 아래 "지적 후보"들이 대상에 비추어 실제로 타당한지 판정하라.
근거가 약하거나, 사실과 다르거나, 과잉지적이면 real=false. 확실히 타당한 것만 real=true.

[대상]
<<<ARTIFACT
${artifact}
ARTIFACT>>>

[지적 후보]
${list}

오직 하나의 JSON 객체만 출력(코드펜스·설명 금지):
{ "findings": [ { "title": "<후보와 동일하거나 다듬은 요약>", "severity": "low|medium|high", "real": <true|false> }, ... ] }
입력한 후보 순서대로 모두 판정한다.`;
}

// #9: 입력 언어를 거칠게 감지해 출력 언어 지시문으로 쓸 라벨을 반환(한국어/English/일본어/中文/그 외는 빈값).
export function detectLang(text: string): string {
  const sample = (text || '').slice(0, 4000);
  const ko = (sample.match(/[가-힣]/g) || []).length;
  const ja = (sample.match(/[ぁ-んァ-ン]/g) || []).length;
  const zh = (sample.match(/[一-鿿]/g) || []).length;
  const en = (sample.match(/[A-Za-z]/g) || []).length;
  const max = Math.max(ko, ja, zh, en);
  if (max === 0) return '';
  if (max === ko) return '한국어';
  if (max === ja) return '日本語';
  if (max === zh) return '中文';
  return 'English';
}

// 독립 채점기 프롬프트: 결과물을 만들지 않은 별도 모델이 엄격·정직하게 점수를 매긴다.
// (개선한 모델이 자기 점수를 매기는 자가 채점의 점수 인플레/오정지를 보정)
export function buildJudgePrompt(input: RunInput, artifact: string, rubric?: Rubric, focus?: string, refsDigest?: string, anchorScore?: number): string {
  const custom = rubric && rubric.dimensions.length ? rubric.dimensions : null;
  const baseDims = rubricDimsFor(input);
  const rubricLines = custom
    ? custom.map((d) => `  - "${d.name}" (가중치 ${d.weight}): ${d.description ?? ''}`).join('\n')
    : baseDims.map((r) => `  - "${r.dim}": ${r.desc}`).join('\n');
  const dimKeys = custom
    ? custom.map((d) => `"${d.name}": <0-100>`).join(', ')
    : baseDims.map((r) => `"${r.dim}": <0-100>`).join(', ');
  // E1: 직전 베스트 점수를 '보정 앵커'로 제시 → 매 회차 0에서 재채점하며 생기는 점수 드리프트를 줄인다.
  // (이전 산출물 전체를 다시 넣지 않으므로 토큰 추가 없음. 절대 기준은 어디까지나 루브릭)
  const anchorLine =
    typeof anchorScore === 'number' && Number.isFinite(anchorScore)
      ? `[보정 기준] 직전 베스트 버전은 약 ${Math.round(anchorScore)}점으로 평가됐다. 이 버전이 그보다 분명히 나으면 더 높게, 못하면 더 낮게, 비슷하면 비슷하게 일관된 척도로 매겨라(다만 절대 기준은 아래 루브릭이다).\n`
      : '';
  return `너는 이 결과물을 만들지 않은 "독립 채점자"다. 작성자 편을 들지 말고 엄격하고 정직하게 평가하라.
대상: ${input.kind} / ${input.title}
${focus && focus.trim() ? `[평가 초점] ${focus.trim()}\n` : ''}${anchorLine}${refsDigest && refsDigest.trim() ? `[반드시 따를 기준]\n${refsDigest.trim()}\n` : ''}
[평가 루브릭] (각 0~100${custom ? ', 아래 항목명을 dimensions 키로 정확히 사용' : ''})
${rubricLines}

[평가 대상]
<<<ARTIFACT
${artifact}
ARTIFACT>>>

오직 하나의 JSON 객체만 출력(코드펜스·설명 금지):
{ "score": <0-100 종합>, "dimensions": { ${dimKeys} }, "rationale": "<무엇이 부족한지 구체적으로 1~3문장>" }
관대하게 주지 마라. 완벽하지 않으면 100을 주지 않는다. 각 차원을 독립적으로, 근거에 기반해 평가한다.`;
}

// 입력 종류별 평가 루브릭 (각 차원 0~100)
const RUBRICS: Record<InputKind, { dim: string; desc: string }[]> = {
  document: [
    { dim: 'clarity', desc: '명료성: 문장이 명확하고 이해하기 쉬운가' },
    { dim: 'structure', desc: '구조: 논리 흐름과 구성이 탄탄한가' },
    { dim: 'completeness', desc: '완결성: 빠진 내용 없이 충분한가' },
    { dim: 'accuracy', desc: '정확성: 사실·근거가 정확하고 일관적인가' },
    { dim: 'conciseness', desc: '간결성: 군더더기 없이 압축적인가' },
  ],
  url: [
    { dim: 'clarity', desc: '명료성: 핵심 메시지가 분명한가' },
    { dim: 'structure', desc: '구조: 정보 위계와 내비게이션 흐름이 좋은가' },
    { dim: 'completeness', desc: '완결성: 사용자가 필요한 정보가 다 있는가' },
    { dim: 'seo_accessibility', desc: 'SEO/접근성: 메타·시맨틱·접근성 측면이 좋은가' },
    { dim: 'persuasiveness', desc: '설득력: 목적(전환/이해)을 잘 달성하는가' },
  ],
  code: [
    { dim: 'correctness', desc: '정확성: 버그·엣지케이스 처리가 올바른가' },
    { dim: 'readability', desc: '가독성: 네이밍·구조·주석이 명확한가' },
    { dim: 'maintainability', desc: '유지보수성: 모듈화·중복제거·확장성' },
    { dim: 'security', desc: '보안: 취약점·검증 누락이 없는가' },
    { dim: 'performance', desc: '성능: 불필요한 비용·비효율이 없는가' },
  ],
};

// URL 은 urlMode 에 따라 다른 차원으로 평가한다(content=콘텐츠/SEO, source=코드/접근성, full=하이브리드).
const URL_RUBRICS: Record<string, { dim: string; desc: string }[]> = {
  content: RUBRICS.url, // 콘텐츠/카피 리뷰 — 기존 url 루브릭(SEO·설득력 중심)
  source: [
    { dim: 'markup_semantics', desc: '마크업/시맨틱: HTML 구조·시맨틱 태그·유효성' },
    { dim: 'accessibility', desc: '접근성: alt·라벨·heading 순서·키보드/대비 고려' },
    { dim: 'performance', desc: '성능: 리소스 무게·렌더블로킹·불필요한 스크립트' },
    { dim: 'code_quality', desc: '코드 품질: CSS/JS 구조·중복·유지보수성' },
    { dim: 'seo', desc: 'SEO: 메타·구조화데이터·canonical·제목 구조' },
  ],
  full: [
    { dim: 'clarity', desc: '명료성: 콘텐츠 메시지가 분명한가' },
    { dim: 'structure', desc: '구조: 정보 위계·내비게이션·시맨틱 구조' },
    { dim: 'accessibility', desc: '접근성: alt·라벨·heading 순서·대비' },
    { dim: 'seo', desc: 'SEO: 메타·구조화데이터·제목 구조' },
    { dim: 'performance', desc: '성능: 리소스 무게·스크립트 효율' },
    { dim: 'persuasiveness', desc: '설득력: 목적(전환/이해)을 잘 달성하는가' },
  ],
};

// 입력에 맞는 평가 차원 목록. URL 은 urlMode 를 반영.
function rubricDimsFor(input: RunInput): { dim: string; desc: string }[] {
  if (input.kind === 'url') {
    const mode = String((input.meta as any)?.urlMode ?? 'full');
    return URL_RUBRICS[mode] ?? URL_RUBRICS.full;
  }
  return RUBRICS[input.kind];
}

const ARTIFACT_GUIDE: Record<InputKind, string> = {
  document: '개선본은 원본과 같은 형식의 "다시 쓴 전체 문서"여야 한다. 일부만 쓰지 말 것.',
  url: '개선본은 페이지 내용/카피/구조에 대한 개선 제안을 반영한 "개선된 콘텐츠 초안"(마크다운)으로 작성한다.',
  code: '개선본은 리팩터링/수정이 적용된 "전체 코드"여야 한다. 디렉터리 입력이면 파일별로 ===== FILE: 경로 ===== 헤더를 유지한 전체 코드 묶음으로 작성한다.',
};

// 입력에 맞는 개선본 가이드. URL 은 urlMode 별로 콘텐츠/코드/하이브리드를 안내.
function artifactGuideFor(input: RunInput): string {
  if (input.kind === 'url') {
    const mode = String((input.meta as any)?.urlMode ?? 'full');
    if (mode === 'source')
      return '개선본은 마크업/CSS/JS 에 대한 구체적 개선안을 코드 블록과 함께 담은 마크다운으로 작성한다(수정 전/후 예시 포함).';
    if (mode === 'full')
      return '개선본은 콘텐츠·구조와 함께 접근성·SEO·코드 개선까지 담은 마크다운 개선안으로 작성한다(필요한 곳은 코드 예시 포함).';
    return ARTIFACT_GUIDE.url;
  }
  return ARTIFACT_GUIDE[input.kind];
}

// ⑤ 대형 문서는 비1회차에서 열린 지적과 관련된 섹션만 발췌해 보낸다(입력 토큰 절약).
const LARGE_CHARS = 6000; // 이 길이 초과 시 섹션 발췌 시도
const SCOPE_BUDGET = 5000; // 발췌로 보낼 대략적 문자 예산

export interface PromptContext {
  input: RunInput;
  currentArtifact: string; // 이번 회차의 입력이 되는 "직전 베스트 개선본"(또는 1회차는 원본)
  iteration: number;
  isFirst: boolean;
  openFindings: Finding[]; // 아직 해결되지 않은 지적사항(대장의 열린 항목)
  focus?: string; // 리뷰 초점(사용자 선택)
  rubric?: Rubric; // V4: 맞춤 평가기준(있으면 기본 루브릭 대체)
  refsDigest?: string; // V4: 참고자료 압축 요약(있으면 기준으로 주입)
  emitChanges?: boolean; // V4: edits 에 reason/findingId 를 요구
  injectedFindings?: { title: string; severity?: Severity }[]; // V4: 패널 리뷰가 발견한 지적(에디터가 반영)
  chunk?: { index: number; total: number }; // 대용량 1회차 분할: 이 파트만 검토·개선(1-based index)
  finalThorough?: boolean; // 마무리 정밀검증 패스: 전체를 한 번 더 꼼꼼히 보라고 지시
  maxNewFindings?: number; // R2: 이번 패스에서 새로 추가할 지적 최대 수(열린 항목 해결 우선)
  lang?: string; // #9: 출력 언어 라벨(예: 한국어/English). 비면 지시 생략
  failedFinds?: string[]; // E3: 직전 회차에 본문에서 못 찾아 적용 실패한 edit 의 find(정확히 재인용 유도)
}

// V4: 참고자료들을 "지켜야 할 규칙 체크리스트"로 압축 요약하는 프롬프트(런 시작 시 1회).
export function buildRefsDigestPrompt(refs: { title: string; text: string }[]): string {
  const MAX_PER = 4000;
  const body = refs
    .map(
      (r, i) =>
        `### 참고자료 ${i + 1}: ${r.title}\n${r.text.slice(0, MAX_PER)}${r.text.length > MAX_PER ? '\n[...이하 생략...]' : ''}`,
    )
    .join('\n\n');
  return `다음 참고자료들을 리뷰·개선 시 "반드시 지켜야 할 규칙·기준" 체크리스트로 압축하라.
- 핵심 규칙만 간결한 불릿으로(최대 25줄). 배경 설명 말고 "지켜야 할 것"만.
- 표기/용어/스타일/구조/금지사항 등 검증 가능한 형태로. 한국어로.
- 오직 불릿 목록만 출력(머리말·코드펜스 금지).

${body}`;
}

export function buildPrompt(ctx: PromptContext): string {
  // 맞춤 rubric 이 있으면 그 항목명을 dimensions 키로 강제, 없으면 종류별 기본 루브릭.
  const custom = ctx.rubric && ctx.rubric.dimensions.length ? ctx.rubric.dimensions : null;
  const baseDims = rubricDimsFor(ctx.input); // URL 은 urlMode 별 차원
  const rubricLines = custom
    ? custom.map((d) => `  - "${d.name}" (가중치 ${d.weight}): ${d.description ?? ''}`).join('\n')
    : baseDims.map((r) => `  - "${r.dim}": ${r.desc}`).join('\n');
  const dimKeys = custom
    ? custom.map((d) => `"${d.name}": <0-100>`).join(', ')
    : baseDims.map((r) => `"${r.dim}": <0-100>`).join(', ');

  const openList = ctx.openFindings.length
    ? ctx.openFindings.map((f) => `  #${f.id} [${f.severity ?? 'medium'}] ${f.title}`).join('\n')
    : '  (없음)';

  // ⑤ 산출물 뷰: 비1회차 대형 문서는 관련 섹션만 발췌
  let artifactView = ctx.currentArtifact;
  let scopeNote = '';
  if (!ctx.isFirst && ctx.currentArtifact.length > LARGE_CHARS) {
    const s = scopeArtifact(ctx.currentArtifact, ctx.openFindings, ctx.input.kind);
    if (s.omitted > 0) {
      artifactView = s.view;
      scopeNote =
        `\n[발췌 안내] 문서가 커서 열린 지적과 관련된 섹션만 보여준다(전체 ${s.titles.length}개 중 ${s.omitted}개 생략).` +
        ` edits 의 find 는 아래 발췌에 '정확히 존재하는' 텍스트만 사용하고, 발췌에 없는 부분은 이번 회차에 수정하지 마라.\n` +
        `전체 섹션 목록: ${s.titles.join(' · ')}`;
    }
  }

  // 회차별 작동 방식
  const modeBlock = ctx.chunk
    ? `이 입력은 큰 대상을 나눈 **파트 ${ctx.chunk.index}/${ctx.chunk.total}** 다. 이 파트에 한정해 검토하라.
이 파트에서 발견한 지적을 new_findings 에 담고, **이 파트의 개선된 전체 텍스트**를 improved_artifact 로 출력하라.
다른 파트는 보이지 않으니 신경 쓰지 말고, 이 파트의 내용을 임의로 삭제·요약하지 마라(누락 금지). resolved 는 []이다.`
    : ctx.isFirst
    ? `이번은 1회차다. 대상을 처음부터 꼼꼼히 검토해 발견한 모든 지적사항을 new_findings 에 담아라.
그리고 그 지적들을 반영한 개선본(improved_artifact)을 만들어라.
1회차에는 해결할 "열린 항목"이 없으므로 resolved 는 빈 배열 []이다.`
    : `이번은 ${ctx.iteration}회차다. 전체를 처음부터 다시 검사하지 마라. **열린 항목 해결이 최우선이다.**
1) 아래 "열린 지적사항"을 실제로 해결하도록 현재본을 수정하라. 해결한 항목의 #번호를 resolved 에 넣어라.
   - ⚠️ resolved 에 넣은 **모든 #번호는 반드시 그 항목을 실제로 고치는 edit** 을 동반해야 하고, 그 edit 의 "findingIds" 에 해당 #번호를 적어야 한다.
   - edit 없이(=본문을 안 고치고) resolved 에 넣지 마라. "말로만 해결"은 무시되고 항목은 그대로 열린 상태로 남는다.
2) 그다음, 이전 회차들이 "놓친" 새로운 문제만 추가로 찾아 new_findings 에 담아라(중복 금지).${
        ctx.maxNewFindings != null
          ? ` 단, 신규 지적은 정말 중요한 것만 **최대 ${ctx.maxNewFindings}개**까지만(사소한 건 생략). 새 문제 찾기보다 열린 항목 해결을 우선하라.`
          : ''
      }
3) **개선본 전체를 출력하지 마라.** 바뀌는 부분만 edits 배열로 표현한다(출력 토큰 절약).
   - 각 edit 의 "find" 는 현재본에 '그대로(공백·줄바꿈 포함) 존재하는' 충분히 고유한 텍스트여야 한다.
   - "replace" 는 그 자리에 들어갈 새 텍스트. 삭제는 ""(빈 문자열). 새 내용 추가는 인접한 기존 블록을 find 로 잡아 replace 안에 함께 넣어라.
   - "findingIds" 는 이 edit 이 해결하는 열린 항목 #번호 배열(순수 개선이면 []). 한 edit 이 여러 항목을 고치면 모두 적어라.
   - 바꿀 게 없으면 edits 는 빈 배열 []이다.
4) 열린 항목이 모두 해결되고 새로 발견할 것도 없으면 done=true 로 마무리하라.`;

  const outputSchema = ctx.isFirst
    ? `{
  "resolved": [],
  "new_findings": [ { "title": "<새로 발견한 문제 요약>", "severity": "low|medium|high" }, ... ],
  "improved_artifact": "<개선본 전체 텍스트>",
  "review_markdown": "<이번 회차 작업 노트(마크다운)>",
  "score": <number 0-100>,
  "dimensions": { ${dimKeys} },
  "rationale": "<점수 근거 1~3문장>",
  "done": <true|false>
}`
    : `{
  "resolved": [<해결한 열린 항목의 #번호(정수)>, ...],
  "new_findings": [ { "title": "<새로 발견한 문제 요약>", "severity": "low|medium|high" }, ... ],
  "edits": [ { "find": "<현재본에서 그대로 복사한 변경 대상 텍스트>", "replace": "<바뀐 텍스트>", "findingIds": [<이 edit 이 해결하는 열린 항목 #번호들; 순수 개선이면 []>]${ctx.emitChanges ? ', "reason": "<왜 바꿨는지 1문장>"' : ''} }, ... ],
  "review_markdown": "<짧은 작업 노트>",
  "score": <number 0-100>,
  "dimensions": { ${dimKeys} },
  "rationale": "<점수 근거 1~3문장>",
  "done": <true|false>
}`;

  const artifactRule = ctx.chunk
    ? `- improved_artifact 는 "이 파트"의 개선된 전체 텍스트다. 이 파트 범위를 벗어난 내용을 추가하거나, 내용을 줄이지 마라(누락 금지).`
    : ctx.isFirst
    ? `- ${artifactGuideFor(ctx.input)}`
    : `- 출력은 edits(부분 수정)만 사용한다. 개선본 전체를 다시 출력하지 마라.`;

  // E3: 직전 회차에 적용 실패한 find 경고 — 모델이 같은 잘못된 인용을 반복하지 않게 한다.
  const failedBlock =
    !ctx.isFirst && ctx.failedFinds && ctx.failedFinds.length
      ? `\n[⚠️ 직전 회차에 적용 실패한 수정 — 아래 "find" 텍스트가 현재본에 그대로 없어 무시됐다]
${ctx.failedFinds.map((f) => `  · ${JSON.stringify(f)}`).join('\n')}
→ 이 부분을 다시 고치려면, 현재본에서 **글자 그대로(공백·줄바꿈 포함) 복사한 더 짧고 고유한 find** 를 사용하라. 위 문자열을 그대로 재사용하지 마라.\n`
      : '';

  const finalBlock = ctx.finalThorough
    ? `\n[🔎 마무리 정밀검증 — 매우 중요]
이번은 완료 직전 마지막 점검이다. 점진 모드를 벗어나 **전체를 처음부터 다시 꼼꼼히** 보라.
열린 항목을 모두 해결하고, 앞 회차들이 놓친 오류·일관성 문제(용어/표기/서식/누락)를 끝까지 찾아 고쳐라.
사소한 것까지 마감 품질로 끌어올리되, 원래 의도는 보존한다.\n`
    : '';

  return `너는 점진적(incremental) 리뷰·개선 에이전트다. 사람의 추가 개입 없이 동작한다.
대상 종류: ${ctx.input.kind} / 제목: ${ctx.input.title}

[작동 방식]
${modeBlock}
${finalBlock}
[리뷰 초점]
${ctx.focus && ctx.focus.trim() ? ctx.focus.trim() : '특정 초점 지정 없음 — 모든 차원을 균형 있게 본다.'}
${ctx.lang ? `[출력 언어] 개선본·작업노트·근거를 모두 ${ctx.lang}로 작성한다(원문 언어 유지).` : ''}
${ctx.refsDigest && ctx.refsDigest.trim() ? `\n[참고 기준 — 반드시 따를 것]\n${ctx.refsDigest.trim()}\n위 기준을 위반하는 부분은 new_findings 로 지적하고 개선본에서 바로잡아라.\n` : ''}
[평가 루브릭] (각 0~100${custom ? ', 아래 항목명을 dimensions 키로 정확히 사용' : ', 참고용 자가 채점'})
${rubricLines}
- 각 차원 점수를 정직하게 매겨라. overall score 도 0~100 으로 함께 제시한다.${custom ? '\n- (종합 점수는 시스템이 가중평균으로 다시 계산하므로 각 차원 점수의 정확성이 가장 중요하다.)' : ''}

[열린 지적사항 — 이번에 해결할 대상]
${openList}
${ctx.injectedFindings && ctx.injectedFindings.length ? `\n[다각도 리뷰가 이번 패스에서 새로 발견한 지적 — 반드시 개선본/edits 에 반영하라]\n${ctx.injectedFindings.map((f) => `  - [${f.severity ?? 'medium'}] ${f.title}`).join('\n')}\n(위 지적들은 시스템이 대장에 기록하므로 new_findings 에 중복으로 넣지 말고, 고친 결과만 반영하라.)` : ''}
${failedBlock}

[중요 규칙]
- 매 회차 전체를 통으로 재검사하지 말고, 위 "열린 항목"을 해결하고 "놓친 것만" 새로 추가하는 식으로 누적 진행한다.
${artifactRule}
- 과잉수정/원래 의도 훼손 금지. 사실을 지어내지 말 것. 점수는 정직하게.${scopeNote}

[현재 버전]${ctx.chunk ? ` (원본의 일부 — 파트 ${ctx.chunk.index}/${ctx.chunk.total})` : ctx.isFirst ? ' (원본)' : ' (직전 베스트 개선본; 클 경우 관련 섹션만 발췌)'}
<<<ARTIFACT
${artifactView}
ARTIFACT>>>

[출력 형식 — 매우 중요]
오직 하나의 JSON 객체만 출력한다. 코드펜스(\`\`\`), 설명, 인사말 금지. 다음 스키마를 정확히 따른다:
${outputSchema}
JSON 문자열 안의 줄바꿈/따옴표는 반드시 올바르게 이스케이프할 것.`;
}

// ---- ⑤ 섹션 스코프: 열린 지적과 관련된 섹션만 골라 발췌 ----
export interface Section { title: string; body: string; }

function scopeArtifact(
  text: string,
  findings: Finding[],
  kind: InputKind,
): { view: string; titles: string[]; omitted: number } {
  const sections = splitSections(text, kind);
  const titles = sections.map((s) => s.title);
  if (sections.length <= 1) return { view: text, titles, omitted: 0 };

  const kws = Array.from(new Set(findings.flatMap((f) => tokenize(f.title))));
  const scored = sections.map((s, i) => ({ s, i, score: relevance(s.title + '\n' + s.body, kws) }));
  // 관련도 높은 순(동점은 원래 순서) → 예산까지 채택
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const picked: { s: Section; i: number }[] = [];
  let used = 0;
  for (const x of scored) {
    const len = x.s.title.length + x.s.body.length + 8;
    if (picked.length > 0 && used + len > SCOPE_BUDGET) continue;
    picked.push(x);
    used += len;
  }
  picked.sort((a, b) => a.i - b.i); // 문서 순서 복원
  const omitted = sections.length - picked.length;
  const view = picked.map((x) => x.s.title + '\n' + x.s.body).join('\n\n');
  return { view, titles, omitted };
}

export function splitSections(text: string, kind: InputKind): Section[] {
  const lines = text.split('\n');
  const headRe = kind === 'code' ? /^=====\s*FILE:.*=====\s*$/ : /^#{1,3}\s+\S/;
  const sections: Section[] = [];
  let cur: { title: string; body: string[] } = { title: '(머리말)', body: [] };
  let started = false;
  for (const ln of lines) {
    if (headRe.test(ln)) {
      if (started || cur.body.length) sections.push({ title: cur.title, body: cur.body.join('\n') });
      cur = { title: ln.trim(), body: [] };
      started = true;
    } else {
      cur.body.push(ln);
    }
  }
  sections.push({ title: cur.title, body: cur.body.join('\n') });
  return sections.filter((s, i) => !(i === 0 && s.title === '(머리말)' && !s.body.trim()));
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+|[가-힣]{2,}/g) || []).filter((w) => w.length >= 2);
}

function relevance(text: string, kws: string[]): number {
  if (!kws.length) return 0;
  const body = text.toLowerCase();
  let score = 0;
  for (const k of kws) {
    let idx = body.indexOf(k);
    while (idx >= 0) {
      score++;
      idx = body.indexOf(k, idx + k.length);
    }
  }
  return score;
}
