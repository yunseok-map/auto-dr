import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportOffice } from '../src/output/export.js';
import { extractFileText } from '../src/input/adapters.js';

// R4: 마크다운 → docx 재생성 → 다시 추출 시 제목·본문·불릿이 보존되는지(왕복 검증).
test('docx 왕복: 마크다운 구조·본문이 보존된다', async () => {
  const md = [
    '# 사내공모 신청서',
    '본 문서는 지원 동기를 설명합니다.',
    '## 경력 요약',
    '- 첫째 프로젝트 경험',
    '- 둘째 성과 지표',
    '마지막 마무리 문단입니다.',
  ].join('\n');
  const dir = mkdtempSync(path.join(tmpdir(), 'autodr-docx-'));
  const out = path.join(dir, 'improved.docx');
  try {
    await exportOffice(md, 'docx', out);
    const text = await extractFileText(out);
    for (const kw of [
      '사내공모 신청서',
      '지원 동기를 설명',
      '경력 요약',
      '첫째 프로젝트 경험',
      '둘째 성과 지표',
      '마지막 마무리 문단',
    ]) {
      assert.ok(text.includes(kw), `docx 재생성본에서 누락됨: ${kw}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// pptx 왕복: 최상위 헤딩이 슬라이드로, 본문 텍스트가 보존되는지.
test('pptx 왕복: 슬라이드 제목·본문이 보존된다', async () => {
  const md = ['# 첫 번째 슬라이드', '- 핵심 메시지 하나', '# 두 번째 슬라이드', '본문 설명 텍스트.'].join('\n');
  const dir = mkdtempSync(path.join(tmpdir(), 'autodr-pptx-'));
  const out = path.join(dir, 'improved.pptx');
  try {
    await exportOffice(md, 'pptx', out);
    const text = await extractFileText(out);
    for (const kw of ['첫 번째 슬라이드', '핵심 메시지 하나', '두 번째 슬라이드', '본문 설명 텍스트']) {
      assert.ok(text.includes(kw), `pptx 재생성본에서 누락됨: ${kw}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
