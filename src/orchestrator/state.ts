import fs from 'node:fs/promises';
import path from 'node:path';
import { RUNS_DIR } from '../config.js';
import { exportOffice } from '../output/export.js';
import type {
  Finding,
  IterationResult,
  LogEntry,
  RunConfig,
  RunInput,
  RunState,
  RunStatus,
  TokenUsage,
} from '../types.js';

// 토큰 사용 내역 누적(런 합계 등에서 사용).
export function addUsage(base: TokenUsage | undefined, add: TokenUsage | undefined): TokenUsage | undefined {
  if (!add) return base;
  const b = base ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    input: b.input + add.input,
    output: b.output + add.output,
    cacheRead: b.cacheRead + add.cacheRead,
    cacheWrite: b.cacheWrite + add.cacheWrite,
  };
}

export function runDir(id: string): string {
  return path.join(RUNS_DIR, id);
}
function iterDir(id: string, n: number): string {
  return path.join(runDir(id), 'iterations', `iter-${String(n).padStart(3, '0')}`);
}

function makeId(title: string): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'run';
  return `${ts}-${slug}`;
}

export async function createRun(input: RunInput, config: RunConfig): Promise<RunState> {
  const id = makeId(input.title);
  const dir = runDir(id);
  await fs.mkdir(path.join(dir, 'iterations'), { recursive: true });
  await fs.mkdir(path.join(dir, 'best'), { recursive: true });

  // 원본 스냅샷 저장
  await fs.writeFile(path.join(dir, `input.${input.ext}`), input.artifact, 'utf8');
  await fs.writeFile(
    path.join(dir, 'input.meta.json'),
    JSON.stringify(
      { kind: input.kind, source: input.source, title: input.title, ext: input.ext, origFormat: input.origFormat, meta: input.meta },
      null,
      2,
    ),
    'utf8',
  );

  const now = new Date().toISOString();
  const state: RunState = {
    id,
    title: input.title,
    input: { kind: input.kind, source: input.source, ext: input.ext, origFormat: input.origFormat },
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    currentIteration: 0,
    bestIteration: null,
    bestScore: null,
    scores: [],
    iterations: [],
    findings: [],
    config,
    totalCostUsd: 0,
    log: [],
  };
  await writeState(state);
  await writeStateMd(id, state, input);
  return state;
}

export async function writeState(state: RunState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(runDir(state.id), 'run.json'), JSON.stringify(state, null, 2), 'utf8');
}

export function addLog(state: RunState, level: LogEntry['level'], msg: string): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, msg };
  state.log.push(entry);
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
  const tag = level === 'error' ? '✖' : level === 'warn' ? '!' : '·';
  console.log(`[${state.id}] ${tag} ${msg}`);
}

export async function setStatus(state: RunState, status: RunStatus, message?: string): Promise<void> {
  state.status = status;
  if (message) state.message = message;
  await writeState(state);
}

// 한 반복 결과를 디스크에 저장
export async function saveIteration(
  state: RunState,
  result: IterationResult,
  kept: boolean,
): Promise<void> {
  // 이 시점에 state.findings(대장)는 러너가 이미 갱신한 상태다.
  const openTitles = state.findings
    .filter((f) => f.status === 'open')
    .map((f) => `#${f.id} ${f.title}`);

  const dir = iterDir(state.id, result.iteration);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'review.md'), result.reviewMarkdown, 'utf8');
  await fs.writeFile(path.join(dir, `improved.${state.input.ext}`), result.improvedArtifact, 'utf8');
  await fs.writeFile(
    path.join(dir, 'score.json'),
    JSON.stringify(
      {
        iteration: result.iteration,
        score: result.score,
        dimensions: result.dimensions,
        rationale: result.rationale,
        resolvedIds: result.resolvedIds,
        newFindings: result.newFindings,
        openFindings: openTitles,
        done: result.done,
        kept,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
        model: result.model,
        createdAt: result.createdAt,
      },
      null,
      2,
    ),
    'utf8',
  );

  state.iterations.push({
    iteration: result.iteration,
    score: result.score,
    kept,
    createdAt: result.createdAt,
    durationMs: result.durationMs,
    rationale: result.rationale,
    remainingIssues: openTitles,
    dimensions: result.dimensions,
    costUsd: result.costUsd,
    model: result.model,
    tokens: result.tokens,
  });
  if (result.model) state.actualModel = result.model;
  state.scores.push({ iteration: result.iteration, score: result.score, kept });
  state.currentIteration = result.iteration;
  if (result.costUsd) state.totalCostUsd += result.costUsd;
  if (result.tokens) state.totalTokens = addUsage(state.totalTokens, result.tokens);

  // 점진 진행을 위해 "직전 회차 개선본"을 current/ 에 항상 보존 → 다음 회차 입력
  const cdir = path.join(runDir(state.id), 'current');
  await fs.mkdir(cdir, { recursive: true });
  await fs.writeFile(path.join(cdir, `improved.${state.input.ext}`), result.improvedArtifact, 'utf8');

  if (kept) {
    state.bestIteration = result.iteration;
    state.bestScore = result.score;
    // best/ 갱신 (가장 점수 높았던 스냅샷 보존)
    const bdir = path.join(runDir(state.id), 'best');
    await fs.writeFile(path.join(bdir, `improved.${state.input.ext}`), result.improvedArtifact, 'utf8');
    await fs.writeFile(path.join(bdir, 'review.md'), result.reviewMarkdown, 'utf8');

    // 길 A: 원본이 오피스 문서면 개선본을 같은 형식(.docx/.pptx)으로 재생성.
    if (state.input.origFormat) {
      const outPath = path.join(bdir, `improved.${state.input.origFormat}`);
      try {
        await exportOffice(result.improvedArtifact, state.input.origFormat, outPath);
      } catch (e: any) {
        addLog(state, 'warn', `개선본 ${state.input.origFormat} 재생성 실패: ${e?.message ?? e}`);
      }
    }

    // V4: 변경 내역 산출물(emitChanges 로 changeLog 가 쌓였을 때만)
    if (state.changeLog && state.changeLog.length) {
      try {
        await writeChangesArtifacts(state, bdir);
      } catch (e: any) {
        addLog(state, 'warn', `변경 내역 생성 실패: ${e?.message ?? e}`);
      }
    }
  }
  await writeState(state);
}

// V4: 변경 내역 산출물 — best/changes.md (+ 원본 형식이면 changes.<fmt>)
function truncOne(s: string, n = 160): string {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function buildChangesMd(state: RunState): string {
  const log = state.changeLog ?? [];
  const lines: string[] = [`# 변경 내역 — ${state.title}`, '', `총 ${log.length}건의 수정이 적용되었습니다.`, ''];
  let curIter = -1;
  log.forEach((c, idx) => {
    if (c.iter !== curIter) {
      curIter = c.iter;
      lines.push('', `## ${c.iter}번째 초안`, '');
    }
    lines.push(`### ${idx + 1}. ${c.reason ? truncOne(c.reason, 120) : '수정'}${c.findingId ? `  (지적 #${c.findingId})` : ''}`);
    lines.push(`- 원문: \`${truncOne(c.find)}\``);
    lines.push(`- 수정: ${c.replace && c.replace.trim() ? `\`${truncOne(c.replace)}\`` : '(삭제)'}`);
    lines.push('');
  });
  return lines.join('\n');
}
export async function writeChangesArtifacts(state: RunState, bdir: string): Promise<void> {
  const md = buildChangesMd(state);
  await fs.writeFile(path.join(bdir, 'changes.md'), md, 'utf8');
  if (state.input.origFormat) {
    try {
      await exportOffice(md, state.input.origFormat, path.join(bdir, `changes.${state.input.origFormat}`));
    } catch {
      /* 변경요약 오피스 생성 실패는 무시(changes.md 는 이미 있음) */
    }
  }
}

// 지적사항 대장(findings.md) — 사용자가 보는 누적 체크리스트.
export async function writeFindingsMd(state: RunState): Promise<void> {
  const open = state.findings.filter((f) => f.status === 'open');
  const resolved = state.findings.filter((f) => f.status === 'resolved');
  const lines: string[] = [];
  lines.push(`# 지적사항 대장 — ${state.title}`);
  lines.push('');
  lines.push(`- 진행 회차: ${state.currentIteration}`);
  lines.push(`- 열린 항목: ${open.length} / 해결: ${resolved.length} / 전체: ${state.findings.length}`);
  lines.push('');
  lines.push('## 🔴 열린 항목 (다음 회차 해결 대상)');
  if (open.length) open.forEach((f) => lines.push(`- [ ] #${f.id} [${f.severity ?? 'medium'}] ${f.title}  _(발견 #${f.foundIter})_`));
  else lines.push('- (없음 — 모두 해결됨)');
  lines.push('');
  lines.push('## ✅ 해결된 항목');
  if (resolved.length) resolved.forEach((f) => lines.push(`- [x] #${f.id} [${f.severity ?? 'medium'}] ${f.title}  _(발견 #${f.foundIter} → 해결 #${f.resolvedIter})_`));
  else lines.push('- (아직 없음)');
  const md = lines.join('\n');
  await fs.writeFile(path.join(runDir(state.id), 'findings.md'), md, 'utf8');
}

// 다음 반복에 줄 "압축 상태" — 토큰 최소화의 핵심.
// 전체 히스토리 대신 직전 점수/남은 이슈/베스트만 담는다.
export async function writeStateMd(id: string, state: RunState, input: RunInput): Promise<void> {
  const last = state.iterations[state.iterations.length - 1];
  const best = state.bestIteration != null ? state.iterations.find((i) => i.iteration === state.bestIteration) : null;
  const lines: string[] = [];
  lines.push(`# 진행 상태: ${state.title}`);
  lines.push(`- 대상 종류: ${input.kind}`);
  lines.push(`- 완료한 반복: ${state.currentIteration}`);
  lines.push(`- 베스트 점수: ${state.bestScore ?? 'N/A'} (반복 #${state.bestIteration ?? '-'})`);
  if (last) {
    lines.push(`- 직전 반복 #${last.iteration} 점수: ${last.score}`);
    lines.push(`- 직전 근거: ${last.rationale}`);
  }
  lines.push('');
  lines.push('## 아직 남은 개선 포인트(우선 해결 대상)');
  const issues = (best ?? last)?.remainingIssues ?? [];
  if (issues.length) issues.forEach((i) => lines.push(`- ${i}`));
  else lines.push('- (없음)');
  lines.push('');
  lines.push('## 점수 추이');
  state.scores.slice(-10).forEach((s) => lines.push(`- #${s.iteration}: ${s.score}${s.kept ? ' (채택)' : ''}`));
  const md = lines.join('\n');
  await fs.writeFile(path.join(runDir(id), 'state.md'), md, 'utf8');
}

export async function readStateMd(id: string): Promise<string> {
  try {
    return await fs.readFile(path.join(runDir(id), 'state.md'), 'utf8');
  } catch {
    return '';
  }
}

// 베스트 개선본 텍스트
export async function readBestArtifact(state: RunState, fallback: string): Promise<string> {
  try {
    return await fs.readFile(path.join(runDir(state.id), 'best', `improved.${state.input.ext}`), 'utf8');
  } catch {
    return fallback;
  }
}

// 직전 회차 개선본(점진 진행의 입력) — best 가 아니라 "가장 최근" 개선본을 이어받는다.
export async function readLatestArtifact(state: RunState, fallback: string): Promise<string> {
  try {
    return await fs.readFile(path.join(runDir(state.id), 'current', `improved.${state.input.ext}`), 'utf8');
  } catch {
    return fallback;
  }
}

export async function listRuns(): Promise<RunState[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(RUNS_DIR);
  } catch {
    return [];
  }
  const out: RunState[] = [];
  for (const e of entries) {
    try {
      const raw = await fs.readFile(path.join(RUNS_DIR, e, 'run.json'), 'utf8');
      out.push(JSON.parse(raw));
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export async function getRun(id: string): Promise<RunState | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(RUNS_DIR, id, 'run.json'), 'utf8'));
  } catch {
    return null;
  }
}
