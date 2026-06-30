import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import { registerChild, unregisterChild } from './controls.js';
import { liveStart, liveToken, liveEnd } from './live.js';
import type { ProviderId, TokenUsage } from '../types.js';

// API 키는 로컬 파일에만 저장하고 run.json/config 에는 절대 넣지 않는다.
const KEYS_FILE = path.join(PROJECT_ROOT, 'data', 'providers.json');
let keys: Record<string, string> = {};
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  try {
    keys = JSON.parse(await fs.readFile(KEYS_FILE, 'utf8'));
  } catch {
    keys = {};
  }
  loaded = true;
}

// 키를 저장하는 provider 목록(여기에 추가하면 setKeys/keyStatus 가 자동 반영).
export const KEY_PROVIDERS = ['anthropic', 'openai', 'gemini', 'together', 'nemotron'] as const;

// 키 저장(빈 문자열은 해당 키 삭제). 값이 들어온 것만 갱신.
export async function setKeys(patch: Record<string, unknown>): Promise<void> {
  await ensureLoaded();
  for (const p of KEY_PROVIDERS) {
    if (!(p in patch)) continue;
    const v = patch[p];
    if (typeof v === 'string' && v.trim()) keys[p] = v.trim();
    else if (v === '') delete keys[p];
  }
  await fs.mkdir(path.dirname(KEYS_FILE), { recursive: true });
  await fs.writeFile(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8');
}

// 키 초기화: provider 지정 시 그 키만, 'all' 이면 전부 삭제.
export async function clearKeys(provider?: string): Promise<void> {
  await ensureLoaded();
  if (!provider || provider === 'all') {
    for (const p of KEY_PROVIDERS) delete keys[p];
  } else {
    delete keys[provider];
  }
  await fs.mkdir(path.dirname(KEYS_FILE), { recursive: true });
  await fs.writeFile(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8');
}

// 어떤 키가 설정됐는지만 반환(값은 노출하지 않음).
export async function keyStatus(): Promise<Record<string, boolean>> {
  await ensureLoaded();
  const out: Record<string, boolean> = {};
  for (const p of KEY_PROVIDERS) out[p] = !!keys[p];
  return out;
}
export async function hasKey(provider: string): Promise<boolean> {
  await ensureLoaded();
  return !!keys[provider];
}

export interface Completion {
  text: string;
  tokens?: TokenUsage;
  costUsd?: number;
  model?: string;
}

// 모델 단가($/1M [input, output]) — 비용 추정용(비용 상한이 모든 provider에서 작동하도록).
// 정확 매칭 → 접두어 매칭 → provider 기본값 순으로 찾는다(미등록 모델도 추정치를 낸다).
const ANTHROPIC_PRICE: Record<string, [number, number]> = {
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
};
const OPENAI_PRICE: Record<string, [number, number]> = {
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1-nano': [0.1, 0.4],
  'o4-mini': [1.1, 4.4],
};
const GEMINI_PRICE: Record<string, [number, number]> = {
  'gemini-2.0-flash': [0.1, 0.4],
  'gemini-2.0-flash-lite': [0.075, 0.3],
  'gemini-1.5-flash': [0.075, 0.3],
  'gemini-1.5-pro': [1.25, 5],
};
// Together AI 단가($/1M [input, output]) — 모델별 상이. 대표 모델만 등록, 나머지는 fallback.
const TOGETHER_PRICE: Record<string, [number, number]> = {
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': [0.88, 0.88],
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo': [0.18, 0.18],
  'Qwen/Qwen2.5-72B-Instruct-Turbo': [1.2, 1.2],
  'deepseek-ai/DeepSeek-V3': [1.25, 1.25],
};
// NVIDIA Nemotron(integrate.api.nvidia.com) — 개인 NIM 엔드포인트는 사실상 무과금/널널한 한도.
// 비용 상한(maxTotalCostUsd)에 걸리지 않도록 0으로 둔다(검수용으로 마음껏 호출).
const NEMOTRON_PRICE: Record<string, [number, number]> = {};
// provider별 단가표 + 미등록 모델용 보수적 기본값(상한이 과소적용되지 않도록 약간 높게 잡음).
const PRICE_TABLE: Record<string, { table: Record<string, [number, number]>; fallback: [number, number] }> = {
  anthropic: { table: ANTHROPIC_PRICE, fallback: [3, 15] },
  openai: { table: OPENAI_PRICE, fallback: [2.5, 10] },
  gemini: { table: GEMINI_PRICE, fallback: [1.25, 5] },
  together: { table: TOGETHER_PRICE, fallback: [0.9, 0.9] },
  nemotron: { table: NEMOTRON_PRICE, fallback: [0, 0] },
};

// 토큰 사용량 → 추정 비용($). 캐시 토큰도 입력 단가로 보수 계산(과소청구 방지).
function estimateCost(provider: string, model: string, t: TokenUsage): number | undefined {
  const cfg = PRICE_TABLE[provider];
  if (!cfg) return undefined;
  const exact = cfg.table[model];
  const prefix = exact ? undefined : Object.entries(cfg.table).find(([k]) => model.startsWith(k))?.[1];
  const [inP, outP] = exact ?? prefix ?? cfg.fallback;
  const inputTokens = t.input + t.cacheRead + t.cacheWrite;
  return (inputTokens * inP + t.output * outP) / 1e6;
}

// provider API 직접 호출(무의존, fetch). runId 로 등록하면 "바로 그만두기" 시 abort 된다.
export async function callProvider(
  provider: ProviderId,
  prompt: string,
  opts: { model?: string; runId?: string; timeoutMs?: number },
): Promise<Completion> {
  await ensureLoaded();
  const key = keys[provider];
  if (!key) throw new Error(`${provider} API 키가 없습니다 — 설정에서 키를 입력하세요.`);

  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  if (opts.runId) registerChild(opts.runId, abort);
  // nemotron 은 추론 모델이라 한 호출이 수 분 걸린다(detailed thinking on). 기본 5분으론 자주
  // 잘려서("This operation was aborted") 재시도로 시간을 더 낭비한다 → nemotron 만 12분으로 늘린다.
  const defaultTimeout = provider === 'nemotron' ? 12 * 60_000 : 5 * 60_000;
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? defaultTimeout);
  try {
    if (provider === 'anthropic') return await callAnthropic(key, prompt, opts.model, ctrl.signal);
    if (provider === 'openai') return await callOpenAI(key, prompt, opts.model, ctrl.signal);
    if (provider === 'gemini') return await callGemini(key, prompt, opts.model, ctrl.signal);
    if (provider === 'together') return await callTogether(key, prompt, opts.model, ctrl.signal);
    if (provider === 'nemotron') return await callNemotron(key, prompt, opts.model, ctrl.signal, opts.runId);
    throw new Error(`알 수 없는 provider: ${provider}`);
  } finally {
    clearTimeout(timer);
    if (opts.runId) unregisterChild(opts.runId, abort);
  }
}

async function callAnthropic(key: string, prompt: string, model: string | undefined, signal: AbortSignal): Promise<Completion> {
  const m = model || 'claude-haiku-4-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    // prompt caching: 프롬프트 본문을 캐시 블록으로 표시 → 반복 프리픽스(루브릭·참고기준 등) 입력 비용 절감.
    body: JSON.stringify({
      model: m,
      max_tokens: 8000,
      messages: [
        { role: 'user', content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  const text = (j.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  const u = j.usage || {};
  const tokens: TokenUsage = {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
  };
  return { text, tokens, costUsd: estimateCost('anthropic', m, tokens), model: j.model || m };
}

async function callOpenAI(key: string, prompt: string, model: string | undefined, signal: AbortSignal): Promise<Completion> {
  const m = model || 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: m, messages: [{ role: 'user', content: prompt }], max_tokens: 8000 }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  const text = j.choices?.[0]?.message?.content || '';
  const u = j.usage || {};
  const tokens: TokenUsage = { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cacheRead: 0, cacheWrite: 0 };
  return { text, tokens, costUsd: estimateCost('openai', j.model || m, tokens), model: j.model || m };
}

// Together AI 는 OpenAI 호환 API.
async function callTogether(key: string, prompt: string, model: string | undefined, signal: AbortSignal): Promise<Completion> {
  const m = model || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
  const res = await fetch('https://api.together.xyz/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: m, messages: [{ role: 'user', content: prompt }], max_tokens: 8000 }),
  });
  if (!res.ok) throw new Error(`Together API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  const text = j.choices?.[0]?.message?.content || '';
  const u = j.usage || {};
  const tokens: TokenUsage = { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cacheRead: 0, cacheWrite: 0 };
  return { text, tokens, costUsd: estimateCost('together', j.model || m, tokens), model: j.model || m };
}

// NVIDIA Nemotron 은 OpenAI 호환 API(integrate.api.nvidia.com). 스트리밍으로 받아 라이브 표시.
async function callNemotron(key: string, prompt: string, model: string | undefined, signal: AbortSignal, runId?: string): Promise<Completion> {
  // 'auto' 는 Claude 자동 라우팅 전용 키워드(실제 모델 id 아님) → 기본 모델로 폴백(안 그러면 model="auto" → 404).
  // P2: 'nemotron:fast' = 렌즈·검증용 경량 신호. 추론 OFF + 작은 출력으로 빠르게(브레드스 스카우트).
  // 그 외엔 깊은 리뷰용 추론 ON + 큰 출력(에디터: 개선본 전체를 JSON 으로 되돌림).
  const fast = model === 'nemotron:fast';
  const m = !model || model === 'auto' || fast ? 'nvidia/nemotron-3-super-120b-a12b' : model;
  const body = JSON.stringify({
    model: m,
    messages: [
      { role: 'system', content: fast ? 'detailed thinking off' : 'detailed thinking on' },
      { role: 'user', content: prompt },
    ],
    // 거대한 개선본을 JSON 문자열에 정확히 이스케이프해야 하므로 온도를 낮춰(변동↓) 깨진 JSON 빈도를 줄인다.
    temperature: 0.4,
    top_p: 0.95,
    max_tokens: fast ? 8192 : 65536,
    // P1: 스트리밍 — 토큰을 받는 즉시 대시보드로 흘려보내 "쓰는 과정"을 실시간 표시.
    stream: true,
    stream_options: { include_usage: true },
  });

  // NVIDIA 게이트웨이는 긴 생성에서 간헐적으로 5xx(특히 504)를 낸다 — 일시적이라 백오프 후 재시도하면 대개 성공.
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          signal,
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body,
        });
      } catch (e) {
        if (signal.aborted) throw e; // 사용자 중단/타임아웃은 재시도하지 않음
        lastErr = e; // 네트워크 오류 → 백오프 후 재시도
        if (attempt < MAX_ATTEMPTS) { await backoffSleep(attempt, signal); continue; }
        throw e;
      }

      if (res.status >= 500) {
        // 일시적 서버 오류(502/503/504 등) → 백오프 후 재시도
        lastErr = new Error(`Nemotron API ${res.status}: ${(await res.text()).slice(0, 200)}`);
        if (attempt < MAX_ATTEMPTS) { await backoffSleep(attempt, signal); continue; }
        throw lastErr;
      }
      if (!res.ok) throw new Error(`Nemotron API ${res.status}: ${(await res.text()).slice(0, 300)}`); // 4xx 는 재시도 무의미
      if (!res.body) throw new Error('Nemotron 응답 본문이 비어 있습니다.');

      // ── SSE 스트림 파싱 ──
      // content = 최종 결과(JSON, 파싱 대상) / reasoning_content = 사고과정(표시용, 버림).
      // 둘 다 라이브 화면엔 흘려보내 "생각하고 쓰는" 과정을 보여준다.
      if (runId) liveStart(runId);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sse = '';
      let full = '';
      let finishReason = '';
      let usage: any = {};
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sse += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = sse.indexOf('\n')) >= 0) {
          const line = sse.slice(0, nl).trim();
          sse = sse.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let chunk: any;
          try { chunk = JSON.parse(data); } catch { continue; }
          const ch = chunk.choices?.[0];
          if (ch) {
            const d = ch.delta || {};
            if (d.content) full += d.content;
            const piece = d.content || d.reasoning_content || '';
            if (piece && runId) liveToken(runId, piece);
            if (ch.finish_reason) finishReason = ch.finish_reason;
          }
          if (chunk.usage) usage = chunk.usage;
        }
      }

      // 출력이 토큰 한도에서 잘리면 JSON 이 깨진다 — 조용히 넘어가지 말고 알린다.
      if (finishReason === 'length') {
        throw new Error('Nemotron 응답이 토큰 한도에서 잘렸습니다(출력 과대) — 입력을 줄이거나 분할이 필요합니다.');
      }
      const tokens: TokenUsage = { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0, cacheRead: 0, cacheWrite: 0 };
      return { text: full, tokens, costUsd: estimateCost('nemotron', m, tokens), model: m };
    }
    throw lastErr ?? new Error('Nemotron API 호출 실패');
  } finally {
    if (runId) liveEnd(runId);
  }
}

// abort 를 존중하는 지수 백오프 대기(4s → 10s ...). 호출 타임아웃/사용자 중단 시 즉시 reject.
function backoffSleep(attempt: number, signal: AbortSignal): Promise<void> {
  const ms = attempt === 1 ? 4000 : 10000;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

async function callGemini(key: string, prompt: string, model: string | undefined, signal: AbortSignal): Promise<Completion> {
  const m = model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  const text = (j.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('');
  const u = j.usageMetadata || {};
  const tokens: TokenUsage = { input: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0, cacheRead: 0, cacheWrite: 0 };
  return { text, tokens, costUsd: estimateCost('gemini', m, tokens), model: m };
}
