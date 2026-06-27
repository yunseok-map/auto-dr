import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import type { OfficeFormat } from '../types.js';

// 개선본 마크다운을 원본과 같은 오피스 형식(.docx / .pptx)으로 재생성한다(길 A).
// 원본의 정확한 레이아웃 복원이 아니라, 개선된 내용을 담은 "깔끔한 새 문서"를 만든다.
export async function exportOffice(
  markdown: string,
  format: OfficeFormat,
  outPath: string,
): Promise<void> {
  const blocks = parseMarkdown(markdown);
  if (format === 'docx') await exportDocx(blocks, outPath);
  else if (format === 'pptx') await exportPptx(blocks, outPath);
  else await exportPdf(blocks, outPath);
}

// ---------- 마크다운 → 블록 모델 ----------
type Inline = { text: string; bold?: boolean };
type Block =
  | { type: 'heading'; level: number; runs: Inline[] }
  | { type: 'bullet'; level: number; runs: Inline[] }
  | { type: 'para'; runs: Inline[] };

function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (trimmed) blocks.push({ type: 'para', runs: [{ text: trimmed }] });
      continue;
    }
    if (!trimmed) continue;

    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, runs: parseInline(h[2]) });
      continue;
    }
    const bullet = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      const indent = bullet[1].length;
      const level = Math.min(4, Math.floor(indent / 2));
      blocks.push({ type: 'bullet', level, runs: parseInline(stripInlineMd(bullet[3])) });
      continue;
    }
    blocks.push({ type: 'para', runs: parseInline(stripInlineMd(trimmed)) });
  }
  return blocks;
}

// **굵게** 만 의미있게 반영, 나머지 인라인 마크업은 제거.
function parseInline(text: string): Inline[] {
  const runs: Inline[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    runs.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text }];
}

// 굵게(**) 외 흔한 인라인 마크업 기호를 텍스트에서 정리.
function stripInlineMd(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(^|[\s(])\*(?!\*)([^*]+)\*/g, '$1$2')
    .replace(/(^|[\s(])_([^_]+)_/g, '$1$2');
}

function runsToPlain(runs: Inline[]): string {
  return runs.map((r) => r.text).join('');
}

// ---------- DOCX ----------
async function exportDocx(blocks: Block[], outPath: string): Promise<void> {
  const docx: any = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;
  const HEADINGS = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ];

  const children = blocks.map((b) => {
    const runs = b.runs.map((r) => new TextRun({ text: r.text, bold: r.bold }));
    if (b.type === 'heading') {
      return new Paragraph({ heading: HEADINGS[Math.min(5, b.level - 1)], children: runs });
    }
    if (b.type === 'bullet') {
      return new Paragraph({ bullet: { level: b.level }, children: runs });
    }
    return new Paragraph({ children: runs, spacing: { after: 120 } });
  });

  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  await fs.writeFile(outPath, buf);
}

// ---------- PPTX ----------
async function exportPptx(blocks: Block[], outPath: string): Promise<void> {
  const mod: any = await import('pptxgenjs');
  const PptxGenJS = mod.default ?? mod;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'A4', width: 10, height: 5.63 });
  pptx.layout = 'A4';

  // 최상위 헤딩(# 또는 ##)마다 새 슬라이드. 그 아래 내용은 본문 불릿/문단으로.
  const slides: { title: string; body: { type: 'bullet' | 'para'; level: number; text: string }[] }[] = [];
  let cur: (typeof slides)[number] | null = null;
  const startSlide = (title: string) => {
    cur = { title, body: [] };
    slides.push(cur);
  };
  for (const b of blocks) {
    if (b.type === 'heading' && b.level <= 2) {
      startSlide(runsToPlain(b.runs));
      continue;
    }
    if (!cur) startSlide('');
    if (b.type === 'heading') {
      cur!.body.push({ type: 'para', level: 0, text: runsToPlain(b.runs) });
    } else {
      cur!.body.push({ type: b.type, level: b.type === 'bullet' ? b.level : 0, text: runsToPlain(b.runs) });
    }
  }
  if (!slides.length) startSlide('(빈 문서)');

  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.addText(s.title || ' ', {
      x: 0.4,
      y: 0.25,
      w: 9.2,
      h: 0.8,
      fontSize: 24,
      bold: true,
      color: '1a1a2e',
    });
    const textObjs = s.body.length
      ? s.body.map((it) => ({
          text: it.text,
          options: {
            bullet: it.type === 'bullet',
            indentLevel: it.level,
            fontSize: 16,
            color: '333333',
            paraSpaceAfter: 6,
          },
        }))
      : [{ text: ' ', options: { fontSize: 16 } }];
    slide.addText(textObjs as any, { x: 0.6, y: 1.2, w: 8.8, h: 4.0, valign: 'top' });
  }

  await pptx.writeFile({ fileName: outPath });
}

// ---------- PDF ----------
// 한글이 깨지지 않도록 시스템에 설치된 한글 TTF(맑은고딕 등)를 임베드한다.
// repo 에 폰트를 번들하지 않고 로컬 폰트를 읽어 쓰므로 재배포 라이선스 이슈가 없다.
const FONT_CANDIDATES: { regular: string; bold?: string }[] = [
  { regular: 'C:\\Windows\\Fonts\\malgun.ttf', bold: 'C:\\Windows\\Fonts\\malgunbd.ttf' },
  { regular: 'C:\\Windows\\Fonts\\NanumGothic.ttf', bold: 'C:\\Windows\\Fonts\\NanumGothicBold.ttf' },
  { regular: '/usr/share/fonts/truetype/nanum/NanumGothic.ttf', bold: '/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf' },
  { regular: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc' },
  { regular: '/System/Library/Fonts/AppleSDGothicNeo.ttc' },
  { regular: '/Library/Fonts/AppleGothic.ttf' },
];

async function findKoreanFont(): Promise<{ regular: string; bold: string }> {
  for (const c of FONT_CANDIDATES) {
    try {
      await fs.access(c.regular);
      let bold = c.regular;
      if (c.bold) {
        try {
          await fs.access(c.bold);
          bold = c.bold;
        } catch {
          /* bold 없으면 regular 로 대체 */
        }
      }
      return { regular: c.regular, bold };
    } catch {
      /* 다음 후보 */
    }
  }
  throw new Error('한글 지원 TTF 폰트를 찾지 못했습니다(맑은고딕/나눔고딕 등). PDF 재생성을 건너뜁니다.');
}

const PDF_HEADING_SIZE = [20, 16, 14, 13, 12, 12];

async function exportPdf(blocks: Block[], outPath: string): Promise<void> {
  const { regular, bold } = await findKoreanFont();
  const mod: any = await import('pdfkit');
  const PDFDocument = mod.default ?? mod;
  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
  doc.registerFont('ko', regular);
  doc.registerFont('ko-bold', bold);

  const stream = createWriteStream(outPath);
  const done = new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });
  doc.pipe(stream);

  const writeRuns = (runs: Inline[], opts: any) => {
    if (!runs.length) {
      doc.text(' ', opts);
      return;
    }
    runs.forEach((r, i) => {
      doc.font(r.bold ? 'ko-bold' : 'ko');
      doc.text(r.text, { ...opts, continued: i < runs.length - 1 });
    });
  };

  for (const b of blocks) {
    if (b.type === 'heading') {
      const size = PDF_HEADING_SIZE[Math.min(5, b.level - 1)];
      doc.moveDown(b.level <= 2 ? 0.6 : 0.4);
      doc.font('ko-bold').fontSize(size).fillColor('#1a1a2e');
      writeRuns(b.runs.map((r) => ({ ...r, bold: true })), { lineGap: 2 });
      doc.fillColor('#000000');
      doc.moveDown(0.2);
    } else if (b.type === 'bullet') {
      doc.fontSize(11);
      const indent = 56 + b.level * 16;
      writeRuns([{ text: '• ' }, ...b.runs], { indent: indent - 56, lineGap: 2, paragraphGap: 2 });
    } else {
      doc.fontSize(11);
      writeRuns(b.runs, { lineGap: 2, paragraphGap: 4 });
    }
  }

  doc.end();
  await done;
}
