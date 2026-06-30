import fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { RUNS_DIR } from '../config.js';
import { exportOffice } from '../output/export.js';
import { editOfficeInPlace } from '../output/inplace.js';
import { unifiedDiff } from '../output/diff.js';
import { extractFileText } from '../input/adapters.js';
import type {
  Finding,
  IterationResult,
  LogEntry,
  OfficeFormat,
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
  // run.json 비대화 방지: 최근 200개만 보관(대시보드 표시용). 전체 이력은 log.jsonl 에 누적.
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
  try {
    appendFileSync(path.join(runDir(state.id), 'log.jsonl'), JSON.stringify(entry) + '\n');
  } catch {
    /* 로그 파일 쓰기 실패는 무시(콘솔·run.json 으로 충분) */
  }
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
        stages: result.stages,
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
    stages: result.stages,
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

    // 원본이 오피스 문서면 개선본을 같은 형식으로 제공.
    if (state.input.origFormat) {
      const fmt = state.input.origFormat;
      const outPath = path.join(bdir, `improved.${fmt}`);
      // ① 제자리 수정: 업로드한 "원본 양식"을 그대로 두고 텍스트 내용만 교체(서식/표/이미지 보존).
      let inPlace = false;
      if ((fmt === 'docx' || fmt === 'pptx') && state.input.source) {
        try {
          inPlace = await editOfficeInPlace(state.input.source, result.improvedArtifact, outPath, fmt);
          if (inPlace) addLog(state, 'info', `원본 ${fmt} 양식 유지하며 내용만 교체(제자리 수정) 완료`);
          state.officeInPlace = inPlace;
        } catch (e: any) {
          addLog(state, 'warn', `제자리 수정 실패(재생성으로 폴백): ${e?.message ?? e}`);
        }
      }
      // ② 폴백 또는 pdf: 깔끔한 새 문서로 재생성.
      if (!inPlace) {
        try {
          await exportOffice(result.improvedArtifact, fmt, outPath);
        } catch (e: any) {
          addLog(state, 'warn', `개선본 ${fmt} 재생성 실패: ${e?.message ?? e}`);
        }
      } else {
        // 제자리 수정이 주 산출물이면, 참고용 "정리본"(재생성)도 별도 제공.
        try {
          await exportOffice(result.improvedArtifact, fmt, path.join(bdir, `improved.clean.${fmt}`));
        } catch {
          /* 정리본 실패는 무시 */
        }
      }
      // R4: 왕복 검증 — 본문 손실 점검(경고만).
      await verifyOfficeRoundtrip(state, result.improvedArtifact, outPath, fmt);
    }

    // V4: 변경 내역 산출물(emitChanges 로 changeLog 가 쌓였을 때만)
    if (state.changeLog && state.changeLog.length) {
      try {
        await writeChangesArtifacts(state, bdir);
      } catch (e: any) {
        addLog(state, 'warn', `변경 내역 생성 실패: ${e?.message ?? e}`);
      }
    }

    // #6: 코드 입력이면 원본 대비 unified diff(패치)를 best/improved.diff 로 생성.
    if (state.input.kind === 'code') {
      try {
        const original = await fs.readFile(path.join(runDir(state.id), `input.${state.input.ext}`), 'utf8');
        const lines = original.split('\n').length + result.improvedArtifact.split('\n').length;
        if (lines <= 8000) {
          const patch = unifiedDiff(original, result.improvedArtifact, state.title);
          if (patch) await fs.writeFile(path.join(bdir, 'improved.diff'), patch, 'utf8');
        }
      } catch (e: any) {
        addLog(state, 'warn', `diff 생성 실패: ${e?.message ?? e}`);
      }
    }
  }
  await writeState(state);
}

// R4: 오피스 재생성본 왕복 검증 — 다시 텍스트를 추출해 마크다운 본문 대비 과도하게 짧으면 경고.
// (구조/내용 손실 의심을 런타임에 잡는 안전망. pdf 는 텍스트 추출 변동이 커서 생략.)
async function verifyOfficeRoundtrip(state: RunState, md: string, outPath: string, fmt: OfficeFormat): Promise<void> {
  if (fmt === 'pdf') return;
  try {
    const extracted = await extractFileText(outPath);
    const a = extracted.replace(/\s+/g, '').length;
    const b = md.replace(/\s+/g, '').length;
    if (b > 200 && a < b * 0.5) {
      addLog(state, 'warn', `${fmt} 재생성본 본문이 원문 대비 짧음(공백 제외 ${a}/${b}자) — 구조/내용 손실 의심`);
    }
  } catch {
    /* 검증용 재추출 실패는 무시(재생성 자체는 성공) */
  }
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

// 서버 시작 시 호출: 제어 상태는 인메모리(controls.ts)라 프로세스가 죽으면 사라진다.
// 따라서 부팅 시점에 run.json 이 아직 running/paused 인 런은 이전 프로세스의 고아다 → error 로 정리.
// (베스트 산출물·findings 는 디스크에 남아 있으므로 결과 열람에는 영향 없음)
export async function reconcileOrphans(): Promise<number> {
  const runs = await listRuns();
  let fixed = 0;
  for (const r of runs) {
    if (r.status !== 'running' && r.status !== 'paused') continue;
    r.status = 'error';
    r.message = '서버 재시작으로 중단됨 (이전 프로세스에서 진행 중이던 런).';
    r.control = 'stopped';
    r.alert = null;
    r.updatedAt = new Date().toISOString();
    try {
      await fs.writeFile(path.join(runDir(r.id), 'run.json'), JSON.stringify(r, null, 2), 'utf8');
      fixed++;
    } catch {
      /* 쓰기 실패는 무시 */
    }
  }
  return fixed;
}

// 이어하기(resume): 부모 런의 베스트 개선본을 새 입력으로, 열린 지적을 시드로 묶어 반환.
// 부모가 없거나 베스트 산출물이 없으면 null.
export async function buildResumeSeed(parentId: string): Promise<{
  input: RunInput;
  seedFindings: Finding[];
  config: RunConfig;
  focus?: string;
  refsDigest?: string;
} | null> {
  const parent = await getRun(parentId);
  if (!parent) return null;
  let artifact: string;
  try {
    artifact = await fs.readFile(path.join(runDir(parentId), 'best', `improved.${parent.input.ext}`), 'utf8');
  } catch {
    return null; // 베스트 산출물이 없으면 이어하기 불가
  }
  if (!artifact.trim()) return null;
  const input: RunInput = {
    kind: parent.input.kind,
    source: parent.input.source,
    title: parent.title.replace(/\s*\(이어하기.*\)$/, '') + ' (이어하기)',
    artifact,
    ext: parent.input.ext,
    origFormat: parent.input.origFormat,
  };
  const seedFindings = parent.findings.filter((f) => f.status === 'open');
  return { input, seedFindings, config: parent.config, focus: parent.focus, refsDigest: parent.refsDigest };
}

// U7: 처음부터 다시 실행(rerun) — 부모의 '원본 입력'과 설정으로 새 런을 시작(시드 없음).
// 베스트가 없어도(1회차에서 에러로 멈춘 경우 등) 동작한다.
export async function buildRerunSeed(parentId: string): Promise<{
  input: RunInput;
  config: RunConfig;
  focus?: string;
  refsDigest?: string;
} | null> {
  const parent = await getRun(parentId);
  if (!parent) return null;
  let artifact: string;
  try {
    artifact = await fs.readFile(path.join(runDir(parentId), `input.${parent.input.ext}`), 'utf8');
  } catch {
    return null; // 원본 입력이 없으면 재실행 불가
  }
  if (!artifact.trim()) return null;
  const input: RunInput = {
    kind: parent.input.kind,
    source: parent.input.source,
    title: parent.title.replace(/\s*\((이어하기|다시 실행).*\)$/, ''),
    artifact,
    ext: parent.input.ext,
    origFormat: parent.input.origFormat,
  };
  return { input, config: parent.config, focus: parent.focus, refsDigest: parent.refsDigest };
}

// A/B 비교: 두 변형 런을 서로의 peerId 로 연결(비교 뷰에서 짝을 찾을 수 있게).
export async function setComparePeer(id: string, peerId: string): Promise<void> {
  const r = await getRun(id);
  if (!r || !r.compare) return;
  r.compare.peerId = peerId;
  await writeState(r);
}

export async function getRun(id: string): Promise<RunState | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(RUNS_DIR, id, 'run.json'), 'utf8'));
  } catch {
    return null;
  }
}
