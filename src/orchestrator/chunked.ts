import { runAgent } from './claudeAgent.js';
import { getDesired } from './controls.js';
import { buildPrompt, splitSections } from './prompts.js';
import { dedupeByTitle } from './dedup.js';
import type { IterationResult, NewFinding, ProviderId, Rubric, RunInput, ScoreDimensions } from '../types.js';

export interface ChunkedFirstPassOptions {
  input: RunInput;
  cwd: string;
  model?: string;
  provider?: ProviderId;
  runId?: string;
  maxCostUsd?: number;
  focus?: string;
  rubric?: Rubric;
  refsDigest?: string;
  budget?: number; // 한 청크 최대 문자 수(기본 12000)
}

// 큰 1회차 입력을 섹션 경계로 청크 분할 → 각 청크를 "그 파트만" 개선하고 지적 수집 →
// 개선 청크를 원래 순서로 이어붙여 전체 개선본을 만든다(내용 누락 없이 컨텍스트 초과 방지).
// 결과 모양은 일반 IterationResult 와 동일하므로 runner 하위 로직이 그대로 동작한다.
export async function runChunkedFirstPass(o: ChunkedFirstPassOptions): Promise<IterationResult> {
  const start = Date.now();
  const budget = o.budget ?? 12000;
  const chunks = chunkArtifact(o.input.artifact, o.input.kind, budget);
  const total = chunks.length;

  const improvedParts: string[] = [];
  const allFindings: NewFinding[] = [];
  const dimAcc: Record<string, { sum: number; w: number }> = {};
  let scoreSum = 0;
  let scoreW = 0;
  let costUsd = 0;
  let tokens: IterationResult['tokens'] | undefined;
  const notes: string[] = [];

  for (let i = 0; i < total; i++) {
    if (o.runId && getDesired(o.runId) === 'stop') throw new Error('사용자 중단으로 분할 1회차 종료');
    const chunk = chunks[i];
    const prompt = buildPrompt({
      input: o.input,
      currentArtifact: chunk,
      iteration: 1,
      isFirst: true,
      openFindings: [],
      focus: o.focus,
      rubric: o.rubric,
      refsDigest: o.refsDigest,
      chunk: { index: i + 1, total },
    });
    const r = await runAgent({
      prompt,
      iteration: 1,
      cwd: o.cwd,
      model: o.model,
      provider: o.provider,
      runId: o.runId,
      maxCostUsd: o.maxCostUsd,
    });
    // 개선 청크가 비면 원본 청크를 보존(누락 방지).
    improvedParts.push(r.improvedArtifact && r.improvedArtifact.trim() ? r.improvedArtifact : chunk);
    for (const f of r.newFindings) allFindings.push(f);
    const w = Math.max(1, chunk.length); // 길이 가중
    scoreSum += r.score * w;
    scoreW += w;
    for (const [k, v] of Object.entries(r.dimensions)) {
      if (!dimAcc[k]) dimAcc[k] = { sum: 0, w: 0 };
      dimAcc[k].sum += v * w;
      dimAcc[k].w += w;
    }
    if (r.costUsd) costUsd += r.costUsd;
    tokens = addTokens(tokens, r.tokens);
    if (r.rationale) notes.push(`· 파트 ${i + 1}: ${r.rationale}`);
  }

  const dimensions: ScoreDimensions = {};
  for (const [k, v] of Object.entries(dimAcc)) dimensions[k] = Math.round((v.sum / v.w) * 10) / 10;

  return {
    iteration: 1,
    score: scoreW ? Math.round((scoreSum / scoreW) * 10) / 10 : 0,
    dimensions,
    rationale: `분할 검토(${total}개 파트) 종합. ` + notes.slice(0, 6).join(' '),
    reviewMarkdown: `# 1회차(분할 검토)\n\n총 ${total}개 파트로 나눠 각각 개선했습니다.\n\n${notes.join('\n')}`,
    improvedArtifact: improvedParts.join('\n\n'),
    resolvedIds: [],
    newFindings: dedupeByTitle(allFindings),
    done: false,
    durationMs: Date.now() - start,
    createdAt: new Date().toISOString(),
    costUsd: costUsd || undefined,
    model: o.model,
    tokens,
  };
}

function addTokens(a: IterationResult['tokens'], b: IterationResult['tokens']): IterationResult['tokens'] {
  if (!b) return a;
  const x = a ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    input: x.input + b.input,
    output: x.output + b.output,
    cacheRead: x.cacheRead + b.cacheRead,
    cacheWrite: x.cacheWrite + b.cacheWrite,
  };
}

// 섹션 경계(마크다운 헤딩 / ===== FILE 마커)로 나눈 뒤 예산까지 묶어 청크를 만든다.
// 한 섹션이 예산을 넘으면 길이로 하드 분할(경계 없이라도 누락은 없음).
export function chunkArtifact(text: string, kind: RunInput['kind'], budget: number): string[] {
  const sections = splitSections(text, kind);
  const units: string[] = [];
  for (const s of sections) {
    const block = s.title ? `${s.title}\n${s.body}` : s.body;
    if (block.length <= budget) {
      units.push(block);
    } else {
      for (let i = 0; i < block.length; i += budget) units.push(block.slice(i, i + budget));
    }
  }
  // 인접 유닛을 예산 내에서 합쳐 호출 수를 줄인다.
  const chunks: string[] = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + u.length + 2 > budget) {
      chunks.push(cur);
      cur = u;
    } else {
      cur = cur ? cur + '\n\n' + u : u;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [text];
}
