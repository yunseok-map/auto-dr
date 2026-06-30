import { runPlain } from './claudeAgent.js';
import { buildJudgePrompt } from './prompts.js';
import type { ProviderId, Rubric, RunInput, ScoreDimensions, TokenUsage } from '../types.js';

export interface JudgeResult {
  score: number;
  dimensions: ScoreDimensions;
  rationale: string;
  costUsd?: number;
  tokens?: TokenUsage;
}

export interface JudgeOptions {
  input: RunInput;
  artifact: string;
  rubric?: Rubric;
  focus?: string;
  refsDigest?: string;
  cwd: string;
  model?: string;
  provider?: ProviderId;
  runId?: string;
  maxCostUsd?: number;
  anchorScore?: number; // E1: 직전 베스트 점수(보정 앵커 — 점수 드리프트 완화)
}

// 독립 채점기 1회 호출: 개선본을 별도 모델로 채점해 {score, dimensions, rationale} 반환.
// 실패하거나 점수를 못 뽑으면 null(호출부는 자가 점수로 폴백).
export async function runJudge(o: JudgeOptions): Promise<JudgeResult | null> {
  const prompt = buildJudgePrompt(o.input, o.artifact, o.rubric, o.focus, o.refsDigest, o.anchorScore);
  const { text, costUsd, tokens } = await runPlain(prompt, {
    cwd: o.cwd,
    model: o.model,
    provider: o.provider,
    runId: o.runId,
    maxCostUsd: o.maxCostUsd,
  });
  const p = parseLoose(text);
  if (!p) return null;
  const score = clampNum(p.score);
  if (score == null) return null;
  const dimensions: ScoreDimensions = {};
  if (p.dimensions && typeof p.dimensions === 'object') {
    for (const [k, v] of Object.entries(p.dimensions as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n)) dimensions[k] = Math.max(0, Math.min(100, n));
    }
  }
  return { score, dimensions, rationale: String(p.rationale ?? ''), costUsd, tokens };
}

function clampNum(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

// 느슨한 JSON 추출(코드펜스/잡텍스트 허용).
function parseLoose(text: string): Record<string, unknown> | null {
  const t = (text || '').trim();
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
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
  return null;
}
