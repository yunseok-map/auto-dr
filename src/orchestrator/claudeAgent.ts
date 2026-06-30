import { spawn } from 'node:child_process';
import { registerChild, unregisterChild } from './controls.js';
import { callProvider } from './providers.js';
import type { EditOp, IterationResult, NewFinding, ProviderId, ScoreDimensions, Severity, TokenUsage } from '../types.js';

const IS_WIN = process.platform === 'win32';

export interface AgentRunOptions {
  prompt: string;
  iteration: number;
  cwd: string;
  model?: string;
  provider?: ProviderId; // V5: cli(기본)=claude -p, 그 외=해당 provider API 직접 호출
  timeoutMs?: number;
  runId?: string; // 즉시 중단(자식 프로세스 강제 종료)용
  maxCostUsd?: number; // 회차당 비용 상한 → claude --max-budget-usd
}

interface Completion {
  text: string;
  tokens?: TokenUsage;
  costUsd?: number;
  model?: string;
}

// 한 번의 LLM 호출: provider 가 cli 면 claude -p, 아니면 해당 provider API.
async function getCompletion(
  prompt: string,
  opts: { cwd: string; model?: string; provider?: ProviderId; timeoutMs?: number; runId?: string; maxCostUsd?: number },
): Promise<Completion> {
  const provider = opts.provider ?? 'cli';
  if (provider !== 'cli') {
    return callProvider(provider, prompt, { model: opts.model, runId: opts.runId, timeoutMs: opts.timeoutMs });
  }
  const args = ['-p', '--output-format', 'json'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.maxCostUsd && opts.maxCostUsd > 0) args.push('--max-budget-usd', String(opts.maxCostUsd));
  const { stdout, code } = await spawnClaude(args, prompt, opts.cwd, opts.timeoutMs ?? 15 * 60_000, opts.runId);
  let envelope: ClaudeJsonEnvelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`claude 응답(JSON envelope) 파싱 실패 (exit ${code}): ${stdout.slice(0, 500)}`);
  }
  if (envelope.is_error) {
    throw new Error(`claude 오류 응답: ${envelope.result ?? envelope.subtype ?? 'unknown'}`);
  }
  return {
    text: String(envelope.result ?? ''),
    tokens: parseUsage(envelope),
    costUsd: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : undefined,
    model: pickModel(envelope),
  };
}

interface ClaudeJsonEnvelope {
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: unknown;
  model?: string;
  modelUsage?: Record<string, unknown>;
}

// 한 회차를 실행하고 우리 JSON 결과를 IterationResult 로 파싱한다(백엔드는 getCompletion 이 결정).
export async function runAgent(opts: AgentRunOptions): Promise<IterationResult> {
  const start = Date.now();
  const c = await getCompletion(opts.prompt, {
    cwd: opts.cwd,
    model: opts.model,
    provider: opts.provider,
    timeoutMs: opts.timeoutMs,
    runId: opts.runId,
    maxCostUsd: opts.maxCostUsd,
  });
  const resultText = c.text;
  const payload = extractJson(resultText);

  const dimensions: ScoreDimensions = normalizeDims(payload.dimensions);
  const score = clamp(Number(payload.score), 0, 100);

  return {
    iteration: opts.iteration,
    score,
    dimensions,
    rationale: String(payload.rationale ?? ''),
    reviewMarkdown: String(payload.review_markdown ?? ''),
    improvedArtifact: String(payload.improved_artifact ?? ''),
    edits: parseEdits(payload.edits),
    resolvedIds: parseResolved(payload.resolved),
    newFindings: parseNewFindings(payload.new_findings ?? payload.remaining_issues),
    done: Boolean(payload.done),
    durationMs: Date.now() - start,
    createdAt: new Date().toISOString(),
    costUsd: c.costUsd,
    model: c.model,
    tokens: c.tokens,
    raw: resultText,
  };
}

// envelope.usage 에서 토큰 내역을 추출한다.
function parseUsage(env: ClaudeJsonEnvelope): TokenUsage | undefined {
  const u = env.usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== 'object') return undefined;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
  };
}

// 우리 JSON 스키마가 아닌 "평문 텍스트"가 필요할 때(참고자료 요약 등). result 텍스트를 그대로 반환.
export async function runPlain(
  prompt: string,
  opts: { cwd: string; model?: string; provider?: ProviderId; timeoutMs?: number; runId?: string; maxCostUsd?: number },
): Promise<{ text: string; costUsd?: number; tokens?: TokenUsage }> {
  const c = await getCompletion(prompt, {
    cwd: opts.cwd,
    model: opts.model,
    provider: opts.provider,
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
    runId: opts.runId,
    maxCostUsd: opts.maxCostUsd,
  });
  return { text: c.text, costUsd: c.costUsd, tokens: c.tokens };
}

// claude 응답 envelope 에서 "실제로 사용된" 모델명을 뽑는다.
// (요청은 sonnet 이어도 실제로는 opus 로 돌 수 있으므로 실측값을 표시)
function pickModel(env: ClaudeJsonEnvelope): string | undefined {
  if (env.modelUsage && typeof env.modelUsage === 'object') {
    const keys = Object.keys(env.modelUsage);
    if (keys.length) return keys.join(', ');
  }
  if (typeof env.model === 'string' && env.model) return env.model;
  return undefined;
}

function spawnClaude(
  args: string[],
  prompt: string,
  cwd: string,
  timeoutMs: number,
  runId?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    // Windows 에서는 claude.cmd 를 통해 실행되므로 shell:true 가 안전하다.
    const cmd = IS_WIN ? 'claude.cmd' : 'claude';
    const child = spawn(cmd, args, { cwd, shell: IS_WIN, windowsHide: true });

    let killedByUser = false;
    // Windows 에서 shell:true 로 띄운 claude.cmd 는 cmd 래퍼만 죽이면 실제 claude 프로세스가
    // 살아남아 토큰을 계속 쓴다. taskkill /T /F 로 프로세스 트리 전체를 강제 종료한다.
    const hardKill = () => {
      try {
        if (IS_WIN && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    };
    // 사용자가 "중단"을 누르면 이 자식 프로세스(트리)를 즉시 강제 종료한다.
    const killFn = () => {
      killedByUser = true;
      hardKill();
    };
    if (runId) registerChild(runId, killFn);
    const cleanup = () => {
      if (runId) unregisterChild(runId, killFn);
    };

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      hardKill();
      cleanup();
      reject(new Error(`claude 호출 타임아웃 (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`claude 실행 실패: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      if (killedByUser) {
        reject(new Error('사용자 중단으로 claude 호출이 종료됨'));
      } else if (code !== 0 && !stdout) {
        reject(new Error(`claude 종료 코드 ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve({ stdout, stderr, code });
      }
    });

    // 프롬프트는 stdin 으로 전달 (인자 길이/따옴표 문제 회피)
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// result 텍스트에서 우리 JSON 객체를 견고하게 추출
function extractJson(text: string): any {
  const trimmed = text.trim();
  // 1) 그대로 파싱
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 계속 */
  }
  // 2) 코드펜스 제거
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* 계속 */
    }
  }
  // 3) 첫 { 부터 균형 잡힌 } 까지 추출
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            const candidate = trimmed.slice(start, i + 1);
            try {
              return JSON.parse(candidate);
            } catch {
              break;
            }
          }
        }
      }
    }
  }
  throw new Error(`결과에서 JSON 추출 실패: ${trimmed.slice(0, 300)}`);
}

function parseEdits(v: unknown): EditOp[] {
  if (!Array.isArray(v)) return [];
  const out: EditOp[] = [];
  for (const x of v) {
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const find = typeof o.find === 'string' ? o.find : '';
      if (!find) continue;
      const replace = typeof o.replace === 'string' ? o.replace : '';
      const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim() : undefined;
      const fidRaw = o.findingId ?? o.finding_id;
      const fid = typeof fidRaw === 'number' ? fidRaw : parseInt(String(fidRaw ?? '').replace(/[^0-9]/g, ''), 10);
      const findingId = Number.isFinite(fid) ? fid : undefined;
      const findingIds = parseIntList(o.findingIds ?? o.finding_ids);
      out.push({ find, replace, reason, findingId, findingIds });
    }
  }
  return out;
}

// "findingIds" 를 정수 배열로 파싱(숫자/"#3"/문자열 혼용 허용). 없으면 undefined.
function parseIntList(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: number[] = [];
  for (const x of v) {
    const n = typeof x === 'number' ? x : parseInt(String(x).replace(/[^0-9]/g, ''), 10);
    if (Number.isFinite(n)) out.push(n);
  }
  return out.length ? out : undefined;
}

function parseResolved(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    // 숫자, 또는 "#3" / "3" 형태 문자열 모두 허용
    const n = typeof x === 'number' ? x : parseInt(String(x).replace(/[^0-9]/g, ''), 10);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const SEVERITIES: Severity[] = ['low', 'medium', 'high'];
function parseNewFindings(v: unknown): NewFinding[] {
  if (!Array.isArray(v)) return [];
  const out: NewFinding[] = [];
  for (const x of v) {
    if (typeof x === 'string') {
      if (x.trim()) out.push({ title: x.trim() });
    } else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const title = String(o.title ?? o.issue ?? o.text ?? '').trim();
      if (!title) continue;
      const sev = String(o.severity ?? '').toLowerCase();
      out.push({ title, severity: SEVERITIES.includes(sev as Severity) ? (sev as Severity) : undefined });
    }
  }
  return out;
}

function normalizeDims(d: unknown): ScoreDimensions {
  const out: ScoreDimensions = {};
  if (d && typeof d === 'object') {
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      const n = Number(v);
      if (!Number.isNaN(n)) out[k] = clamp(n, 0, 100);
    }
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
