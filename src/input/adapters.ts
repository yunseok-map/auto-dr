import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { buildWebArtifact, extractWebMeta, type UrlMode, type WebMeta } from './web.js';
import { renderHtml } from './render.js';
import type { InputKind, OfficeFormat, RunInput } from '../types.js';

export type UrlRender = 'off' | 'auto' | 'on';

const CODE_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.sh', '.ps1',
  '.sql', '.html', '.css', '.scss', '.vue', '.svelte', '.json', '.yaml', '.yml',
  '.svg', '.xml', // 마크업: 개선본을 같은 확장자(.svg/.xml)로 저장해 원본처럼 열람·미리보기 가능
]);
const DOC_TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc', '.text']);

// 코드 디렉터리 수집 시 제외할 폴더/파일
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'runs', '__pycache__', '.venv', 'venv']);
const MAX_CODE_BYTES = 400_000; // 코드 묶음 최대 크기(토큰 폭주 방지)

export function detectKind(source: string): InputKind {
  if (/^https?:\/\//i.test(source)) return 'url';
  const ext = path.extname(source).toLowerCase();
  if (CODE_EXTS.has(ext)) return 'code';
  return 'document';
}

export async function resolveInput(
  source: string,
  kindOverride?: InputKind,
  opts: { urlMode?: UrlMode; urlRender?: UrlRender; urlCrawl?: number; urlCheckLinks?: boolean } = {},
): Promise<RunInput> {
  const kind = kindOverride ?? detectKindAsync(source);
  const resolvedKind = await kind;
  switch (resolvedKind) {
    case 'url':
      return await fromUrl(source, opts.urlMode ?? 'full', opts.urlRender ?? 'auto', opts.urlCrawl ?? 1, opts.urlCheckLinks ?? false);
    case 'code':
      return await fromCode(source);
    default:
      return await fromDocument(source);
  }
}

async function detectKindAsync(source: string): Promise<InputKind> {
  if (/^https?:\/\//i.test(source)) return 'url';
  try {
    const st = await fs.stat(source);
    if (st.isDirectory()) return 'code';
  } catch {
    /* 파일 없음 → 아래에서 에러 */
  }
  return detectKind(source);
}

// 임의 파일을 평문 텍스트로 추출(참고자료 등에서 재사용). pdf/docx/pptx/텍스트/코드 지원.
export async function extractFileText(source: string): Promise<string> {
  const ext = path.extname(source).toLowerCase();
  if (ext === '.pdf') return extractPdf(source);
  if (ext === '.docx') return extractDocx(source);
  if (ext === '.pptx') return extractPptx(source);
  return fs.readFile(source, 'utf8');
}

// ---------- 로컬 문서 ----------
async function fromDocument(source: string): Promise<RunInput> {
  const ext = path.extname(source).toLowerCase();
  const title = path.basename(source);
  let artifact = '';
  let outExt = 'md';
  let origFormat: OfficeFormat | undefined;

  if (DOC_TEXT_EXTS.has(ext) || ext === '') {
    artifact = await fs.readFile(source, 'utf8');
    outExt = ext.replace('.', '') || 'txt';
  } else if (ext === '.pdf') {
    artifact = await extractPdf(source);
    outExt = 'md';
    origFormat = 'pdf'; // 개선본을 .pdf 로 재생성(한글 폰트 임베드)
  } else if (ext === '.docx') {
    artifact = await extractDocx(source);
    outExt = 'md';
    origFormat = 'docx'; // 개선본을 .docx 로 재생성
  } else if (ext === '.pptx') {
    artifact = await extractPptx(source);
    outExt = 'md';
    origFormat = 'pptx'; // 개선본을 .pptx 로 재생성
  } else if (CODE_EXTS.has(ext)) {
    // 단일 코드 파일은 code 로 위임
    return fromCode(source);
  } else {
    // 알 수 없는 확장자는 텍스트로 시도
    artifact = await fs.readFile(source, 'utf8');
    outExt = 'txt';
  }

  return { kind: 'document', source: path.resolve(source), title, artifact, ext: outExt, origFormat };
}

async function extractPdf(source: string): Promise<string> {
  try {
    const mod: any = await import('pdf-parse');
    const pdfParse = mod.default ?? mod;
    const buf = await fs.readFile(source);
    const data = await pdfParse(buf);
    return data.text;
  } catch (e: any) {
    throw new Error(`PDF 추출 실패 (pdf-parse 필요): ${e?.message ?? e}`);
  }
}

async function extractDocx(source: string): Promise<string> {
  try {
    const mod: any = await import('mammoth');
    const mammoth = mod.default ?? mod;
    const { value } = await mammoth.extractRawText({ path: source });
    return value;
  } catch (e: any) {
    throw new Error(`DOCX 추출 실패 (mammoth 필요): ${e?.message ?? e}`);
  }
}

// PPTX → 슬라이드별 마크다운. 각 슬라이드를 "## 슬라이드 N" 섹션 + 문단별 불릿으로.
async function extractPptx(source: string): Promise<string> {
  try {
    const mod: any = await import('jszip');
    const JSZip = mod.default ?? mod;
    const buf = await fs.readFile(source);
    const zip = await JSZip.loadAsync(buf);
    // ppt/slides/slideN.xml 을 N 순서대로
    const slideFiles = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => slideNum(a) - slideNum(b));
    const sections: string[] = [];
    for (let i = 0; i < slideFiles.length; i++) {
      const xml: string = await zip.files[slideFiles[i]].async('string');
      const paras = pptxParagraphs(xml);
      const lines: string[] = [`## 슬라이드 ${i + 1}`, ''];
      for (const p of paras) lines.push(`- ${p}`);
      sections.push(lines.join('\n'));
    }
    return sections.join('\n\n') || '(빈 프레젠테이션)';
  } catch (e: any) {
    throw new Error(`PPTX 추출 실패 (jszip 필요): ${e?.message ?? e}`);
  }
}

function slideNum(p: string): number {
  const m = p.match(/slide(\d+)\.xml$/);
  return m ? Number(m[1]) : 0;
}

// 슬라이드 XML 에서 <a:p>(문단) 단위로 <a:t>(텍스트 런)을 모아 한 줄씩.
function pptxParagraphs(xml: string): string[] {
  const out: string[] = [];
  const pBlocks = xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? [];
  for (const block of pBlocks) {
    const runs = [...block.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    const text = runs.join('').trim();
    if (text) out.push(text);
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------- 웹사이트 URL ----------
// SSRF 가드: 사용자가 넣은 URL이 내부망/루프백/링크로컬/메타데이터 주소로 향하지 않게 차단.
// 도메인은 실제 해석된 IP까지 검사한다(domain→사설IP 우회 방지).
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true; // 사설/루프백/예약
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16~31
    if (a === 192 && b === 168) return true; // 192.168
    if (a === 169 && b === 254) return true; // 링크로컬(클라우드 메타데이터 169.254.169.254 포함)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true; // 루프백/미지정
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA
    if (v.startsWith('fe80')) return true; // 링크로컬
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7)); // IPv4-mapped
    return false;
  }
  return false;
}

async function assertPublicUrl(source: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(source);
  } catch {
    throw new Error(`잘못된 URL: ${source}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`허용되지 않은 프로토콜: ${u.protocol}`);
  }
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('내부 주소(localhost)로의 요청은 차단됩니다.');
  }
  // 호스트가 IP면 바로 검사, 도메인이면 해석된 모든 주소를 검사.
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!ips.length || ips.some(isPrivateIp)) {
    throw new Error(`내부망/예약 주소로의 요청은 차단됩니다: ${host}`);
  }
}

async function fromUrl(
  source: string,
  mode: UrlMode = 'full',
  render: UrlRender = 'auto',
  crawl = 1,
  checkLinks = false,
): Promise<RunInput> {
  await assertPublicUrl(source);
  // 참고: 리다이렉트는 따라가되(http→https 등 정상 동작 보존) 최초 대상 주소만 사전 검증한다.
  const res = await fetch(source, { headers: { 'User-Agent': 'auto-dr/0.1' } });
  if (!res.ok) throw new Error(`URL 가져오기 실패: ${res.status} ${res.statusText}`);
  const ct = res.headers.get('content-type') ?? '';
  let body = await res.text();
  let rendered: 'static' | 'rendered' | 'render-failed' = 'static';

  // JS 렌더링 결정: 'on'=항상, 'auto'=정적 HTML 이 SPA 빈 셸로 보일 때만, 'off'=안 함.
  const isHtml = ct.includes('text/html') || /^\s*<(!doctype|html)/i.test(body);
  const needRender =
    isHtml && (render === 'on' || (render === 'auto' && extractWebMeta(body, source).likelySpa));
  if (needRender) {
    try {
      body = await renderHtml(source);
      rendered = 'rendered';
    } catch {
      rendered = 'render-failed'; // 브라우저 미설치/타임아웃 → 정적 HTML 로 폴백
    }
  }

  // 리치 분석: 구조/SEO/접근성 요약 + (full/source 모드면) HTML 소스 + 동일 출처 CSS/JS 까지 묶는다.
  const { artifact, title, meta } = await buildWebArtifact(body, source, ct, mode, rendered);
  let extra = '';
  // #9: 다중 페이지 크롤(같은 도메인 내부 링크, 정적 분석)
  if (meta && crawl > 1) {
    try {
      extra += await crawlSummary(source, meta, Math.min(crawl, 8));
    } catch {
      /* 크롤 실패 무시 */
    }
  }
  // #10: 링크 유효성 검사(내부/사설 주소 제외)
  if (meta && checkLinks) {
    try {
      extra += await checkLinksSection(meta.allLinks);
    } catch {
      /* 링크검사 실패 무시 */
    }
  }
  return {
    kind: 'url',
    source,
    title,
    artifact: artifact + extra,
    ext: 'md',
    meta: { contentType: ct, urlMode: mode, rendered, crawl, checkLinks, web: meta ?? undefined },
  };
}

// #9: 같은 도메인 내부 링크를 BFS 로 따라가 페이지별 구조 요약(정적). maxPages 까지.
async function crawlSummary(startUrl: string, mainMeta: WebMeta, maxPages: number): Promise<string> {
  const visited = new Set([startUrl.split('#')[0]]);
  const queue = [...mainMeta.internalLinks];
  const pages: { url: string; meta: WebMeta }[] = [];
  while (queue.length && pages.length < maxPages - 1) {
    const u = queue.shift()!;
    if (visited.has(u)) continue;
    visited.add(u);
    try {
      await assertPublicUrl(u);
      const r = await fetch(u, { headers: { 'User-Agent': 'auto-dr/0.1' }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('text/html')) continue;
      const meta = extractWebMeta(await r.text(), u);
      pages.push({ url: u, meta });
      for (const l of meta.internalLinks) if (!visited.has(l) && queue.length < 100) queue.push(l);
    } catch {
      /* 페이지 실패 무시 */
    }
  }
  if (!pages.length) return '';
  const lines = ['', '', `## 추가 페이지 크롤 (${pages.length}개 · 정적 분석)`];
  for (const p of pages) {
    const h1 = p.meta.headings.find((h) => h.level === 1);
    lines.push(`- **${p.url}**`);
    lines.push(
      `  - 제목: ${p.meta.title || '⚠️ 없음'} · h1: ${h1 ? h1.text : '⚠️ 없음'} · 단어 ${p.meta.wordCount} · 이미지 alt없음 ${p.meta.images.missingAlt}/${p.meta.images.total} · 링크 ${p.meta.links.total}${p.meta.description ? '' : ' · ⚠️ 메타설명 없음'}`,
    );
  }
  return lines.join('\n');
}

// #10: 링크 상태 검사 — HEAD(필요시 GET) 로 4xx/5xx/네트워크 오류 탐지. 내부/사설은 안전상 건너뜀.
async function checkLinksSection(links: string[], max = 40): Promise<string> {
  const uniq = [...new Set(links)].slice(0, max);
  const results: { u: string; status: string; ok: boolean; skip?: boolean }[] = [];
  let idx = 0;
  const worker = async () => {
    while (idx < uniq.length) {
      const u = uniq[idx++];
      try {
        await assertPublicUrl(u);
      } catch {
        results.push({ u, status: '건너뜀(내부)', ok: true, skip: true });
        continue;
      }
      try {
        let r = await fetch(u, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'auto-dr/0.1' }, signal: AbortSignal.timeout(8000) });
        if (r.status === 405 || r.status === 501 || r.status === 403) {
          r = await fetch(u, { method: 'GET', headers: { 'User-Agent': 'auto-dr/0.1' }, signal: AbortSignal.timeout(8000) });
        }
        results.push({ u, status: String(r.status), ok: r.ok });
      } catch {
        results.push({ u, status: '연결오류', ok: false });
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const broken = results.filter((r) => !r.ok && !r.skip);
  const checked = results.filter((r) => !r.skip).length;
  const lines = ['', '', `## 링크 상태 검사 (${checked}개 확인)`, `- 정상 ${checked - broken.length} · 문제 ${broken.length}`];
  if (broken.length) {
    lines.push('- ⚠️ 문제 링크:');
    for (const b of broken) lines.push(`  - [${b.status}] ${b.u}`);
  } else {
    lines.push('- ✅ 깨진 링크 없음');
  }
  return lines.join('\n');
}

// ---------- 로컬 코드 (파일 또는 디렉터리) ----------
async function fromCode(source: string): Promise<RunInput> {
  const st = await fs.stat(source);
  if (st.isFile()) {
    const content = await fs.readFile(source, 'utf8');
    const ext = path.extname(source).replace('.', '') || 'txt';
    return {
      kind: 'code',
      source: path.resolve(source),
      title: path.basename(source),
      artifact: content,
      ext,
    };
  }

  // 디렉터리: 코드 파일을 하나의 묶음 텍스트로
  const files: string[] = [];
  await walk(source, files);
  let total = 0;
  const parts: string[] = [];
  for (const f of files) {
    try {
      const content = await fs.readFile(f, 'utf8');
      const rel = path.relative(source, f);
      const block = `\n\n===== FILE: ${rel} =====\n${content}`;
      if (total + block.length > MAX_CODE_BYTES) {
        parts.push(`\n\n[... 크기 제한으로 일부 파일 생략 ...]`);
        break;
      }
      total += block.length;
      parts.push(block);
    } catch {
      /* 바이너리 등 skip */
    }
  }
  return {
    kind: 'code',
    source: path.resolve(source),
    title: path.basename(path.resolve(source)),
    artifact: parts.join(''),
    ext: 'md', // 디렉터리 개선본은 패치/설명 묶음(md)
    meta: { fileCount: files.length },
  };
}

async function walk(dir: string, acc: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') && e.isDirectory()) continue;
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, acc);
    } else if (CODE_EXTS.has(path.extname(e.name).toLowerCase())) {
      acc.push(full);
    }
  }
}
