// 지적사항(findings) 중복 판정 유틸 — 정규화 일치뿐 아니라 "토큰 자카드 유사도"로
// 표현만 다른 근접 중복까지 잡는다. LLM/임베딩 호출 없이 결정적으로 동작(토큰·비용 0).

// 제목 정규화: 소문자화 + 구두점/기호를 공백으로.
export function normTitle(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim()
    .slice(0, 120);
}

// 문자 바이그램 집합. 한국어처럼 어미가 바뀌는(하다/함) 경우에도 견고하게 유사도를 잡는다.
// (단어 토큰 자카드는 교착어 어미 차이에 약해 바이그램이 더 정확)
function gramSet(s: string): Set<string> {
  const norm = normTitle(s).replace(/\s+/g, '');
  const grams = new Set<string>();
  if (norm.length <= 1) {
    if (norm) grams.add(norm);
    return grams;
  }
  for (let i = 0; i < norm.length - 1; i++) grams.add(norm.slice(i, i + 2));
  return grams;
}

// 자카드 유사도(0~1). 한쪽이 비면 0.
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// 두 제목이 (사실상) 같은 지적인지. 정규화가 같거나, 바이그램 자카드가 임계 이상이면 중복.
export function isSimilarTitle(a: string, b: string, threshold = 0.6): boolean {
  if (!a || !b) return false;
  if (normTitle(a) === normTitle(b)) return true;
  return jaccard(gramSet(a), gramSet(b)) >= threshold;
}

// 기존 제목 목록 중 입력 제목과 중복인 것의 인덱스(없으면 -1).
export function findSimilarIndex(title: string, existing: string[], threshold = 0.6): number {
  const t = gramSet(title);
  const nt = normTitle(title);
  for (let i = 0; i < existing.length; i++) {
    if (normTitle(existing[i]) === nt) return i;
    if (jaccard(t, gramSet(existing[i])) >= threshold) return i;
  }
  return -1;
}

// 제목 기반 목록 중복 제거(앞선 항목 우선 보존).
export function dedupeByTitle<T extends { title: string }>(items: T[], threshold = 0.6): T[] {
  const out: T[] = [];
  const titles: string[] = [];
  for (const it of items) {
    if (!it.title || !it.title.trim()) continue;
    if (findSimilarIndex(it.title, titles, threshold) >= 0) continue;
    out.push(it);
    titles.push(it.title);
  }
  return out;
}
