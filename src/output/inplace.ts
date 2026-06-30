// 원본 오피스 파일(업로드한 양식)을 그대로 두고 "텍스트 내용만" 교체한다.
// docx/pptx 는 ZIP+XML 이므로 문단(<w:p>/<a:p>)의 텍스트 런(<w:t>/<a:t>)을 갈아끼워
// 서식·표·이미지·레이아웃을 보존한다. 개선본(마크다운)을 문단 순서로 정렬해 매핑.
import fs from 'node:fs/promises';
import type { OfficeFormat } from '../types.js';

// 개선본 텍스트를 "문단 리스트"로 정규화(마크다운 머리표/불릿 제거, 빈 줄 제거).
function normalizeParas(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/, '').trim())
    .filter((l) => l.length > 0);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// 한 문단 블록의 텍스트 런들을 합쳐 평문으로.
function paraText(block: string, tTag: string): string {
  const re = new RegExp(`<${tTag}\\b[^>]*>([\\s\\S]*?)<\\/${tTag}>`, 'g');
  let out = '';
  for (const m of block.matchAll(re)) out += decodeXml(m[1]);
  return out;
}

// 문단 블록의 텍스트를 newText 로 교체: 첫 런에 전체 텍스트, 나머지 런은 비움(서식·런 구조 보존).
function setParaText(block: string, tTag: string, newText: string): string {
  let first = true;
  return block.replace(new RegExp(`<${tTag}\\b[^>]*>[\\s\\S]*?<\\/${tTag}>`, 'g'), () => {
    if (first) {
      first = false;
      return `<${tTag} xml:space="preserve">${escapeXml(newText)}</${tTag}>`;
    }
    return `<${tTag}></${tTag}>`;
  });
}

// XML 문서에서 문단(pTag)들을 순서대로 개선 문단에 매핑해 텍스트만 교체.
// 텍스트가 있는 문단 수와 개선 문단 수가 너무 다르면(구조 급변) 실패로 보고 폴백하게 한다.
function applyToXml(xml: string, pTag: string, tTag: string, improvedParas: string[]): { xml: string; replaced: number } | null {
  const blocks: { start: number; end: number; text: string }[] = [];
  const re = new RegExp(`<${pTag}\\b[\\s\\S]*?<\\/${pTag}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const text = paraText(m[0], tTag);
    if (text.trim()) blocks.push({ start: m.index, end: m.index + m[0].length, text });
  }
  if (!blocks.length) return null;
  // 구조 급변 가드: 텍스트 문단 수 대비 개선 문단 수가 0.6~1.6 배 범위를 벗어나면 매핑 신뢰 어려움.
  const ratio = improvedParas.length / blocks.length;
  if (ratio < 0.6 || ratio > 1.6) return null;

  let out = '';
  let cursor = 0;
  let replaced = 0;
  const n = Math.min(blocks.length, improvedParas.length);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    out += xml.slice(cursor, b.start);
    const block = xml.slice(b.start, b.end);
    if (i < n && improvedParas[i].trim() && improvedParas[i].trim() !== b.text.trim()) {
      out += setParaText(block, tTag, improvedParas[i].trim());
      replaced++;
    } else {
      out += block; // 변경 없음 또는 매핑 범위 밖 → 원본 유지
    }
    cursor = b.end;
  }
  out += xml.slice(cursor);
  return { xml: out, replaced };
}

// 원본 docx/pptx 를 열어 내용만 교체해 outPath 로 저장. 성공하면 true.
export async function editOfficeInPlace(
  originalPath: string,
  improvedText: string,
  outPath: string,
  fmt: OfficeFormat,
): Promise<boolean> {
  if (fmt !== 'docx' && fmt !== 'pptx') return false; // pdf 등은 제자리 수정 불가
  const mod: any = await import('jszip');
  const JSZip = mod.default ?? mod;
  const buf = await fs.readFile(originalPath);
  const zip = await JSZip.loadAsync(buf);
  const improvedParas = normalizeParas(improvedText);
  if (!improvedParas.length) return false;

  let totalReplaced = 0;
  if (fmt === 'docx') {
    const f = zip.file('word/document.xml');
    if (!f) return false;
    const res = applyToXml(await f.async('string'), 'w:p', 'w:t', improvedParas);
    if (!res) return false;
    zip.file('word/document.xml', res.xml);
    totalReplaced = res.replaced;
  } else {
    // pptx: 슬라이드 XML 들을 번호 순으로 이어 매핑(슬라이드 경계 무시하고 문단 순서대로).
    const slideNames = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => (Number(a.match(/slide(\d+)/)![1]) - Number(b.match(/slide(\d+)/)![1])));
    if (!slideNames.length) return false;
    // 전체 슬라이드의 텍스트 문단 수로 가드 판정하기 위해 한 번에 처리하지 않고 순차로 소비.
    let consumed = 0;
    let okAny = false;
    for (const name of slideNames) {
      const xml = await zip.files[name].async('string');
      const remaining = improvedParas.slice(consumed);
      // 이 슬라이드 텍스트 문단 수만큼만 가드 우회: 슬라이드별 비율 가드는 완화(전체 흐름 매핑).
      const res = applyToXmlLoose(xml, 'a:p', 'a:t', remaining);
      if (res) {
        zip.file(name, res.xml);
        consumed += res.consumed;
        totalReplaced += res.replaced;
        okAny = true;
      }
    }
    if (!okAny) return false;
  }

  if (totalReplaced === 0) return false; // 바뀐 게 없으면 제자리 수정 의미 없음 → 폴백
  const outBuf: Buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(outPath, outBuf);
  return true;
}

// pptx 슬라이드용: 이번 XML 의 텍스트 문단을 앞에서부터 improved 문단으로 채우고, 소비한 개수를 반환.
function applyToXmlLoose(xml: string, pTag: string, tTag: string, improvedParas: string[]): { xml: string; replaced: number; consumed: number } | null {
  const blocks: { start: number; end: number; text: string }[] = [];
  const re = new RegExp(`<${pTag}\\b[\\s\\S]*?<\\/${pTag}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const text = paraText(m[0], tTag);
    if (text.trim()) blocks.push({ start: m.index, end: m.index + m[0].length, text });
  }
  if (!blocks.length) return { xml, replaced: 0, consumed: 0 };
  let out = '';
  let cursor = 0;
  let replaced = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    out += xml.slice(cursor, b.start);
    const block = xml.slice(b.start, b.end);
    const rep = improvedParas[i];
    if (rep && rep.trim() && rep.trim() !== b.text.trim()) {
      out += setParaText(block, tTag, rep.trim());
      replaced++;
    } else {
      out += block;
    }
    cursor = b.end;
  }
  out += xml.slice(cursor);
  return { xml: out, replaced, consumed: blocks.length };
}
