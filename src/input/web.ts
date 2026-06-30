// 웹페이지 리치 분석 — HTML 을 납작한 텍스트로만 보지 않고 구조/SEO/접근성/리소스 + 실제 코드까지
// 묶어 리뷰 대상 아티팩트를 만든다. 의존성 없이 정규식 기반(휴리스틱).

export type UrlMode = 'content' | 'source' | 'full';

const MAX_HTML_CHARS = 80_000; // 아티팩트에 싣는 원본 HTML 발췌 상한
const MAX_RES_FILES = 5; // 함께 가져올 동일 출처 CSS/JS 최대 개수
const MAX_RES_BYTES = 40_000; // 리소스 1개 발췌 상한
const MAX_RES_TOTAL = 150_000; // 리소스 합계 상한
const RES_TIMEOUT = 8000;

export interface WebMeta {
  title: string;
  lang: string;
  description: string;
  canonical: string;
  robots: string;
  viewport: string;
  og: number;
  twitter: number;
  jsonLd: number;
  headings: { level: number; text: string }[];
  links: { total: number; internal: number; external: number; vague: number; empty: number };
  internalLinks: string[]; // 같은 도메인 절대 URL(크롤용, 캡)
  allLinks: string[]; // 모든 http(s) 절대 URL(링크 검사용, 캡)
  images: { total: number; missingAlt: number };
  scripts: { external: string[]; inline: number };
  styles: string[];
  wordCount: number;
  htmlBytes: number;
  likelySpa: boolean;
}

// ---------- 텍스트 평면화(콘텐츠 모드) ----------
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeHost(u: string): string {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return '';
  }
}
function absUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}
function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? m[1].trim() : '';
}
function metaContent(html: string, key: 'name' | 'property', val: string): string {
  const re = new RegExp(`<meta[^>]*${key}\\s*=\\s*["']${val}["'][^>]*>`, 'i');
  const m = html.match(re);
  return m ? attr(m[0], 'content') : '';
}

const VAGUE_ANCHORS = /^(여기|클릭|click here|click|here|이곳|바로가기|더보기|read more|link|링크)$/i;

// ---------- 구조/SEO/접근성 추출 ----------
export function extractWebMeta(html: string, pageUrl: string): WebMeta {
  const pageHost = safeHost(pageUrl);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  const lang = attr(html.match(/<html[^>]*>/i)?.[0] || '', 'lang');
  const description = metaContent(html, 'name', 'description');
  const canonical = (() => {
    const m = html.match(/<link[^>]*rel\s*=\s*["']canonical["'][^>]*>/i);
    return m ? attr(m[0], 'href') : '';
  })();
  const robots = metaContent(html, 'name', 'robots');
  const viewport = metaContent(html, 'name', 'viewport');
  const og = (html.match(/<meta[^>]*property\s*=\s*["']og:[^"']+["']/gi) || []).length;
  const twitter = (html.match(/<meta[^>]*name\s*=\s*["']twitter:[^"']+["']/gi) || []).length;
  const jsonLd = (html.match(/<script[^>]*type\s*=\s*["']application\/ld\+json["']/gi) || []).length;

  const headings: { level: number; text: string }[] = [];
  for (const m of html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = htmlToText(m[2]).replace(/\s+/g, ' ').trim().slice(0, 120);
    if (text) headings.push({ level: Number(m[1]), text });
  }

  let internal = 0, external = 0, vague = 0, empty = 0, totalLinks = 0;
  const internalSet = new Set<string>();
  const allSet = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[0], 'href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    totalLinks++;
    const text = htmlToText(m[1]).replace(/\s+/g, ' ').trim();
    if (!text) empty++;
    else if (VAGUE_ANCHORS.test(text)) vague++;
    const abs = absUrl(href, pageUrl);
    if (!/^https?:\/\//i.test(abs)) continue;
    const clean = abs.split('#')[0];
    if (allSet.size < 120) allSet.add(clean);
    const h = safeHost(abs);
    if (h && pageHost && h === pageHost) { internal++; if (internalSet.size < 60) internalSet.add(clean); }
    else if (h) external++;
  }

  let imgTotal = 0, missingAlt = 0;
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    imgTotal++;
    if (!/\balt\s*=/i.test(m[0])) missingAlt++;
  }

  const extScripts: string[] = [];
  let inlineScripts = 0;
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = attr('<x ' + m[1] + '>', 'src');
    if (src) extScripts.push(absUrl(src, pageUrl));
    else if (m[2].trim()) inlineScripts++;
  }
  const styles: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi)) {
    const href = attr(m[0], 'href');
    if (href) styles.push(absUrl(href, pageUrl));
  }

  const text = htmlToText(html);
  const wordCount = (text.match(/\S+/g) || []).length;
  const likelySpa = wordCount < 120 && extScripts.length + inlineScripts >= 3;

  return {
    title, lang, description, canonical, robots, viewport, og, twitter, jsonLd,
    headings, links: { total: totalLinks, internal, external, vague, empty },
    internalLinks: [...internalSet], allLinks: [...allSet],
    images: { total: imgTotal, missingAlt },
    scripts: { external: extScripts, inline: inlineScripts }, styles,
    wordCount, htmlBytes: Buffer.byteLength(html, 'utf8'), likelySpa,
  };
}

// ---------- 동일 출처 리소스(CSS/JS) 수집 ----------
async function fetchSameOrigin(urls: string[], pageUrl: string): Promise<{ url: string; code: string }[]> {
  const pageHost = safeHost(pageUrl);
  const out: { url: string; code: string }[] = [];
  let total = 0;
  for (const u of urls) {
    if (out.length >= MAX_RES_FILES || total >= MAX_RES_TOTAL) break;
    if (safeHost(u) !== pageHost) continue; // 동일 출처만(보안)
    if (!/^https?:\/\//i.test(u)) continue;
    try {
      const res = await fetch(u, { headers: { 'User-Agent': 'auto-dr/0.1' }, signal: AbortSignal.timeout(RES_TIMEOUT) });
      if (!res.ok) continue;
      let code = await res.text();
      if (code.length > MAX_RES_BYTES) code = code.slice(0, MAX_RES_BYTES) + '\n/* …이하 생략(크기 제한)… */';
      out.push({ url: u, code });
      total += code.length;
    } catch {
      /* 리소스 실패는 무시 */
    }
  }
  return out;
}

// ---------- 분석 아티팩트 빌드 ----------
export async function buildWebArtifact(
  html: string,
  pageUrl: string,
  contentType: string,
  mode: UrlMode,
  rendered: 'static' | 'rendered' | 'render-failed' = 'static',
): Promise<{ artifact: string; title: string; meta: WebMeta | null }> {
  // HTML 이 아니면(JSON/텍스트/코드 등) 원문 그대로 리뷰
  if (!contentType.includes('text/html') && !/^\s*<(!doctype|html)/i.test(html)) {
    return { artifact: html, title: pageUrl, meta: null };
  }
  const meta = extractWebMeta(html, pageUrl);
  const text = htmlToText(html);

  if (mode === 'content') {
    return { artifact: text, title: meta.title || pageUrl, meta };
  }

  const len = (s: string) => `${s ? s.length : 0}자`;
  const renderNote =
    rendered === 'rendered'
      ? '\n> 🖥️ 헤드리스 브라우저로 **JS 렌더링 후** 분석함(SPA 대응).'
      : rendered === 'render-failed'
        ? '\n> ⚠️ JS 렌더링 실패 → 정적 HTML 로 분석함(브라우저 미설치 가능: `npx playwright install chromium`).'
        : '';
  const overview = [
    `# 웹페이지 분석: ${pageUrl}`,
    renderNote,
    '',
    '## 페이지 개요 / SEO',
    `- 제목(title): ${meta.title ? `"${meta.title}" (${len(meta.title)})` : '⚠️ 없음'}`,
    `- 언어(html lang): ${meta.lang || '⚠️ 없음'}`,
    `- 메타 설명: ${meta.description ? `"${meta.description}" (${len(meta.description)})` : '⚠️ 없음'}`,
    `- canonical: ${meta.canonical || '없음'}`,
    `- viewport: ${meta.viewport || '⚠️ 없음(모바일 대응 확인)'} · robots: ${meta.robots || '기본'}`,
    `- Open Graph 태그: ${meta.og}개 · Twitter 카드: ${meta.twitter}개 · JSON-LD 구조화데이터: ${meta.jsonLd}개`,
    '',
    '## 제목 구조 (headings)',
    meta.headings.length
      ? meta.headings.map((h) => `${'  '.repeat(h.level - 1)}- h${h.level}: ${h.text}`).join('\n')
      : '⚠️ heading 없음',
    `- (h1 개수: ${meta.headings.filter((h) => h.level === 1).length})`,
    '',
    '## 접근성 / 링크 / 이미지',
    `- 이미지 ${meta.images.total}개 중 alt 없음 ${meta.images.missingAlt}개`,
    `- 링크 ${meta.links.total}개 (내부 ${meta.links.internal} / 외부 ${meta.links.external}) · 모호한 텍스트("여기/클릭") ${meta.links.vague}개 · 빈 링크 ${meta.links.empty}개`,
    '',
    '## 리소스 / 무게',
    `- HTML 크기: ${(meta.htmlBytes / 1024).toFixed(1)}KB · 본문 단어수: ${meta.wordCount}`,
    `- 외부 스크립트 ${meta.scripts.external.length}개 · 인라인 스크립트 ${meta.scripts.inline}개 · 스타일시트 ${meta.styles.length}개`,
    meta.likelySpa ? '- ⚠️ 본문이 거의 비어 있고 스크립트가 많음 → **SPA(클라이언트 렌더링) 가능성**. 정적 HTML 만으로는 실제 콘텐츠를 못 볼 수 있음.' : '',
  ].join('\n');

  const parts: string[] = [overview];

  if (mode !== 'source') {
    parts.push('', '## 본문 텍스트(추출)', text.slice(0, 20_000) + (text.length > 20_000 ? '\n…(이하 생략)…' : ''));
  }

  // HTML 소스 + 동일 출처 CSS/JS (실제 코드 리뷰용)
  const htmlSnippet = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) + '\n<!-- …이하 생략(크기 제한)… -->' : html;
  parts.push('', '## HTML 소스(발췌)', '```html', htmlSnippet, '```');

  const resources = await fetchSameOrigin([...meta.styles, ...meta.scripts.external], pageUrl);
  if (resources.length) {
    parts.push('', '## 연결된 CSS/JS (동일 출처, 발췌)');
    for (const r of resources) {
      const isCss = /\.css(\?|$)/i.test(r.url);
      parts.push('', `### ${r.url}`, '```' + (isCss ? 'css' : 'js'), r.code, '```');
    }
  } else if (meta.styles.length + meta.scripts.external.length > 0) {
    parts.push('', '_(동일 출처 CSS/JS 를 가져오지 못했습니다 — CDN/외부 호스팅이거나 차단됨)_');
  }

  return { artifact: parts.join('\n'), title: meta.title || pageUrl, meta };
}
