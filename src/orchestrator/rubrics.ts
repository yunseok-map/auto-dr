import type { InputKind, Rubric, RubricDimension } from '../types.js';

// 맞춤 평가 기준 템플릿 — 대시보드에서 골라 시작점으로 쓰고 편집한다.
export const RUBRIC_TEMPLATES: Record<string, Rubric> = {
  document: {
    template: 'document',
    passThreshold: 90,
    dimensions: [
      { name: '명료성', weight: 1, description: '문장이 명확하고 이해하기 쉬운가' },
      { name: '구조', weight: 1, description: '논리 흐름과 구성이 탄탄한가' },
      { name: '완결성', weight: 1, description: '빠진 내용 없이 충분한가' },
      { name: '정확성', weight: 1.2, description: '사실·근거가 정확하고 일관적인가' },
      { name: '간결성', weight: 0.8, description: '군더더기 없이 압축적인가' },
    ],
  },
  code: {
    template: 'code',
    passThreshold: 90,
    dimensions: [
      { name: '정확성', weight: 1.4, description: '버그·엣지케이스 처리가 올바른가' },
      { name: '가독성', weight: 1, description: '네이밍·구조·주석이 명확한가' },
      { name: '유지보수성', weight: 1, description: '모듈화·중복제거·확장성' },
      { name: '보안', weight: 1.2, description: '취약점·검증 누락이 없는가' },
      { name: '성능', weight: 0.8, description: '불필요한 비용·비효율이 없는가' },
    ],
  },
  resume: {
    template: 'resume',
    passThreshold: 88,
    dimensions: [
      { name: '임팩트', weight: 1.3, description: '성과가 수치·결과 중심으로 설득력 있게 드러나는가' },
      { name: '명료성', weight: 1, description: '문장이 간결하고 읽기 쉬운가' },
      { name: '직무적합성', weight: 1.2, description: '대상 직무에 맞는 키워드·역량이 부각되는가' },
      { name: '일관성', weight: 0.8, description: '시제·형식·표기가 일관적인가' },
      { name: '진정성', weight: 0.7, description: '과장 없이 신뢰 가는가' },
    ],
  },
  marketing: {
    template: 'marketing',
    passThreshold: 88,
    dimensions: [
      { name: '설득력', weight: 1.3, description: '행동을 유도하는 카피인가' },
      { name: '명료성', weight: 1, description: '핵심 메시지가 분명한가' },
      { name: '타깃적합성', weight: 1.1, description: '대상 독자에게 맞는 톤·근거인가' },
      { name: 'SEO·접근성', weight: 0.8, description: '검색·접근성 측면이 좋은가' },
      { name: '간결성', weight: 0.8, description: '군더더기 없이 압축적인가' },
    ],
  },
};

// #8: 입력 종류(+초점)로 적절한 평가기준 템플릿을 추천. 대시보드에서 시작점으로 자동 선택.
export function suggestRubric(kind: InputKind, focus?: string): { template: string; rubric: Rubric } {
  const f = (focus || '').toLowerCase();
  let key: string;
  if (kind === 'code') key = 'code';
  else if (kind === 'url') key = 'marketing';
  else if (/이력서|resume|cv|자기소개|자소서/.test(f)) key = 'resume';
  else if (/마케팅|market|seo|카피|광고|홍보/.test(f)) key = 'marketing';
  else key = 'document';
  return { template: key, rubric: RUBRIC_TEMPLATES[key] };
}

// 외부(대시보드/API)에서 들어온 rubric을 안전하게 정규화한다. 잘못되면 null.
export function normalizeRubric(raw: unknown): Rubric | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const dimsRaw = Array.isArray(o.dimensions) ? o.dimensions : [];
  const dimensions: RubricDimension[] = [];
  for (const d of dimsRaw) {
    if (!d || typeof d !== 'object') continue;
    const dd = d as Record<string, unknown>;
    const name = String(dd.name ?? '').trim();
    if (!name) continue;
    let weight = Number(dd.weight);
    if (!Number.isFinite(weight) || weight <= 0) weight = 1;
    const description = dd.description != null ? String(dd.description).trim() : undefined;
    dimensions.push({ name, weight, description });
  }
  if (!dimensions.length) return null;
  const pt = Number(o.passThreshold);
  const passThreshold = Number.isFinite(pt) && pt > 0 && pt <= 100 ? pt : undefined;
  const template = o.template != null ? String(o.template) : undefined;
  return { dimensions, passThreshold, template };
}

// rubric 기준 종합 점수 = dimensions 가중평균(이름 매칭, 대소문자·공백 무시).
export function weightedScore(rubric: Rubric, dims: Record<string, number>): number | null {
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const lookup = new Map<string, number>();
  for (const [k, v] of Object.entries(dims)) lookup.set(key(k), Number(v));
  let sum = 0;
  let wsum = 0;
  let matched = 0;
  for (const d of rubric.dimensions) {
    const v = lookup.get(key(d.name));
    if (v == null || Number.isNaN(v)) continue;
    sum += v * d.weight;
    wsum += d.weight;
    matched++;
  }
  if (!matched || wsum === 0) return null;
  return Math.round((sum / wsum) * 10) / 10;
}
