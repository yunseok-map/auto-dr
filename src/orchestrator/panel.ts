import { runAgent, runPlain } from './claudeAgent.js';
import { getDesired } from './controls.js';
import { buildLensPrompt, buildPrompt, buildVerifyPrompt } from './prompts.js';
import type { PromptContext } from './prompts.js';
import type { IterationResult, NewFinding, ProviderId, Severity, TokenUsage } from '../types.js';

function addTok(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!b) return a;
  const x = a ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return { input: x.input + b.input, output: x.output + b.output, cacheRead: x.cacheRead + b.cacheRead, cacheWrite: x.cacheWrite + b.cacheWrite };
}

export interface PanelOptions {
  ctx: PromptContext; // 에디터 단계용 buildPrompt 컨텍스트
  iteration: number;
  cwd: string;
  runId?: string;
  lenses: string[];
  verify: boolean;
  lensModel?: string; // 렌즈 리뷰 모델(기본 haiku)
  editorModel?: string; // 개선 적용 모델(라우팅 모델)
  maxCostUsd?: number;
  provider?: ProviderId; // V5: 호출 백엔드
}

// 다각도 리뷰 패스: 병렬 렌즈 리뷰 → 합치고 중복제거 → (검증) → 에디터로 개선 적용.
// 반환은 일반 IterationResult 와 동일 모양이라 runner 하위 로직이 그대로 동작한다.
export async function runPanel(o: PanelOptions): Promise<IterationResult> {
  const start = Date.now();
  const lensModel = o.lensModel ?? 'haiku';
  const artifact = o.ctx.currentArtifact;
  let extraCost = 0;
  let extraTokens: TokenUsage | undefined;
  // 사용자가 중단을 눌렀으면 이후 단계 호출을 더 띄우지 않는다(토큰 절약).
  const ensureNotStopped = () => {
    if (o.runId && getDesired(o.runId) === 'stop') throw new Error('사용자 중단으로 패널 리뷰 종료');
  };

  // ── 1) 병렬 렌즈 리뷰(지적만) ──
  const lensResults = await Promise.allSettled(
    o.lenses.map((lens) =>
      runPlain(buildLensPrompt(o.ctx.input, artifact, lens, o.ctx.refsDigest), {
        cwd: o.cwd,
        model: lensModel,
        provider: o.provider,
        runId: o.runId,
        maxCostUsd: o.maxCostUsd,
      }),
    ),
  );
  const candidates: NewFinding[] = [];
  for (const r of lensResults) {
    if (r.status !== 'fulfilled') continue;
    if (r.value.costUsd) extraCost += r.value.costUsd;
    extraTokens = addTok(extraTokens, r.value.tokens);
    const parsed = parseLoose(r.value.text);
    for (const f of toFindings(parsed.findings)) candidates.push(f);
  }

  // ── 2) 중복 제거(제목 정규화) ──
  const deduped = dedupe(candidates);

  // ── 3) 진위 검증(옵션) ──
  ensureNotStopped();
  let verified = deduped;
  if (o.verify && deduped.length) {
    try {
      const v = await runPlain(buildVerifyPrompt(o.ctx.input, artifact, deduped), {
        cwd: o.cwd,
        model: lensModel,
        provider: o.provider,
        runId: o.runId,
        maxCostUsd: o.maxCostUsd,
      });
      if (v.costUsd) extraCost += v.costUsd;
      extraTokens = addTok(extraTokens, v.tokens);
      const vp = parseLoose(v.text);
      const judged = Array.isArray(vp.findings) ? vp.findings : [];
      if (judged.length) {
        const kept: NewFinding[] = [];
        for (const j of judged) {
          if (!j || typeof j !== 'object') continue;
          const o2 = j as Record<string, unknown>;
          const real = o2.real;
          if (real === false || real === 'false') continue; // 거짓 지적 제거
          const title = String(o2.title ?? '').trim();
          if (!title) continue;
          kept.push({ title, severity: normSev(o2.severity) });
        }
        if (kept.length) verified = dedupe(kept);
      }
    } catch {
      /* 검증 실패 시 dedupe 결과를 그대로 사용 */
    }
  }

  // ── 4) 에디터: 검증된 지적을 반영해 개선 적용(일반 runAgent 재사용) ──
  ensureNotStopped();
  const editorPrompt = buildPrompt({ ...o.ctx, injectedFindings: verified });
  const result = await runAgent({
    prompt: editorPrompt,
    iteration: o.iteration,
    cwd: o.cwd,
    model: o.editorModel,
    provider: o.provider,
    runId: o.runId,
    maxCostUsd: o.maxCostUsd,
  });

  // 패널이 찾은 지적을 대장 기록 대상(newFindings)으로 사용(에디터의 new_findings 는 무시).
  result.newFindings = verified;
  result.costUsd = (result.costUsd ?? 0) + extraCost;
  result.tokens = addTok(result.tokens, extraTokens);
  result.durationMs = Date.now() - start;
  return result;
}

// ---- helpers ----
const SEVS: Severity[] = ['low', 'medium', 'high'];
function normSev(v: unknown): Severity | undefined {
  const s = String(v ?? '').toLowerCase();
  return SEVS.includes(s as Severity) ? (s as Severity) : undefined;
}
function toFindings(v: unknown): NewFinding[] {
  if (!Array.isArray(v)) return [];
  const out: NewFinding[] = [];
  for (const x of v) {
    if (typeof x === 'string') {
      if (x.trim()) out.push({ title: x.trim() });
    } else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const title = String(o.title ?? o.issue ?? '').trim();
      if (title) out.push({ title, severity: normSev(o.severity) });
    }
  }
  return out;
}
function normTitle(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim().slice(0, 80);
}
function dedupe(items: NewFinding[]): NewFinding[] {
  const seen = new Set<string>();
  const out: NewFinding[] = [];
  for (const f of items) {
    const k = normTitle(f.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

// 느슨한 JSON 추출(코드펜스/잡텍스트 허용).
function parseLoose(text: string): { findings?: unknown; score?: unknown } {
  const t = (text || '').trim();
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let obj = tryParse(t);
  if (obj) return obj;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    obj = tryParse(fence[1].trim());
    if (obj) return obj;
  }
  const start = t.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          obj = tryParse(t.slice(start, i + 1));
          if (obj) return obj;
          break;
        }
      }
    }
  }
  return {};
}
