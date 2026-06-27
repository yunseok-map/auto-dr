import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import { registerChild, unregisterChild } from './controls.js';
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

// 키 저장(빈 문자열은 해당 키 삭제). 값이 들어온 것만 갱신.
export async function setKeys(patch: Record<string, unknown>): Promise<void> {
  await ensureLoaded();
  for (const p of ['anthropic', 'openai', 'gemini']) {
    if (!(p in patch)) continue;
    const v = patch[p];
    if (typeof v === 'string' && v.trim()) keys[p] = v.trim();
    else if (v === '') delete keys[p];
  }
  await fs.mkdir(path.dirname(KEYS_FILE), { recursive: true });
  await fs.writeFile(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8');
}

// 어떤 키가 설정됐는지만 반환(값은 노출하지 않음).
export async function keyStatus(): Promise<Record<string, boolean>> {
  await ensureLoaded();
  return { anthropic: !!keys.anthropic, openai: !!keys.openai, gemini: !!keys.gemini };
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

// Anthropic 모델 단가($/1M [input, output]) — 비용 표시용(다른 provider는 토큰만).
const ANTHROPIC_PRICE: Record<string, [number, number]> = {
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
};

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
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5 * 60_000);
  try {
    if (provider === 'anthropic') return await callAnthropic(key, prompt, opts.model, ctrl.signal);
    if (provider === 'openai') return await callOpenAI(key, prompt, opts.model, ctrl.signal);
    if (provider === 'gemini') return await callGemini(key, prompt, opts.model, ctrl.signal);
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
    body: JSON.stringify({ model: m, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
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
  const price = ANTHROPIC_PRICE[m];
  const costUsd = price
    ? ((tokens.input + tokens.cacheRead + tokens.cacheWrite) * price[0] + tokens.output * price[1]) / 1e6
    : undefined;
  return { text, tokens, costUsd, model: j.model || m };
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
  return { text, tokens, costUsd: undefined, model: j.model || m };
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
  return { text, tokens, costUsd: undefined, model: m };
}
