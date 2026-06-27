import fs from 'node:fs/promises';
import path from 'node:path';
import type { InputKind, OfficeFormat, RunInput } from '../types.js';

const CODE_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.sh', '.ps1',
  '.sql', '.html', '.css', '.scss', '.vue', '.svelte', '.json', '.yaml', '.yml',
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

export async function resolveInput(source: string, kindOverride?: InputKind): Promise<RunInput> {
  const kind = kindOverride ?? detectKindAsync(source);
  const resolvedKind = await kind;
  switch (resolvedKind) {
    case 'url':
      return await fromUrl(source);
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
async function fromUrl(source: string): Promise<RunInput> {
  const res = await fetch(source, { headers: { 'User-Agent': 'auto-dr/0.1' } });
  if (!res.ok) throw new Error(`URL 가져오기 실패: ${res.status} ${res.statusText}`);
  const ct = res.headers.get('content-type') ?? '';
  const body = await res.text();
  let artifact: string;
  if (ct.includes('text/html')) {
    artifact = htmlToText(body);
  } else {
    artifact = body; // 원시 텍스트/코드 등은 그대로
  }
  return {
    kind: 'url',
    source,
    title: source,
    artifact,
    ext: 'md',
    meta: { contentType: ct },
  };
}

function htmlToText(html: string): string {
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
