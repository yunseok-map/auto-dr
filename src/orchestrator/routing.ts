import type { RunInput } from '../types.js';

// 자동 라우팅이 사용하는 모델 단계(저렴 → 고품질).
export type ModelName = 'haiku' | 'sonnet' | 'opus';

export interface RoutePlan {
  ladder: ModelName[]; // 시작(index 0)부터 승급 순서. 길이 1이면 단일 모델.
  reason: string; // 트리아지 근거(로그/대시보드 표시용)
  auto: boolean; // true 면 정체/막힘 시 다음 단계로 자동 승급 허용
}

// ── 진입 트리아지 ──
// 입력 분량/종류(+리뷰 초점)만 보고 코드 휴리스틱으로 모델 경로를 정한다.
// LLM 호출 없음 → 토큰 0, 즉시. '내용의 난이도'는 못 보지만(길이로 추정) 비용이 들지 않는다.
export function planRoute(input: RunInput, focus?: string): RoutePlan {
  const n = input.artifact.length;
  const isCode = input.kind === 'code';
  const deep = isDeepFocus(focus);

  // 짧은 코드(또는 심층 추론 초점) → 어차피 분량이 작아 opus 비용도 작으니 처음부터 직행.
  if (n < 4000 && (isCode || deep)) {
    return {
      ladder: ['opus'],
      auto: true, // 사다리 끝이라 실제 승급은 일어나지 않지만 의미상 자동 경로
      reason: `짧은 ${isCode ? '코드' : '입력'}(${n}자)${deep ? ' · 심층 초점' : ''} → opus 직행`,
    };
  }
  // 대용량 → 가장 싼 haiku 로 넓게 훑고, 막히면 단계적으로 승급.
  if (n > 20000) {
    return {
      ladder: ['haiku', 'sonnet', 'opus'],
      auto: true,
      reason: `대용량(${n}자) → haiku→sonnet→opus 계단식`,
    };
  }
  // 중간 분량 → sonnet 부터, 막히면 opus.
  return {
    ladder: ['sonnet', 'opus'],
    auto: true,
    reason: `중간 분량(${n}자) → sonnet→opus 계단식`,
  };
}

// 사용자가 모델을 명시한 경우 → 단일 모델 고정(자동 승급 없음).
export function fixedRoute(model: string): RoutePlan {
  return { ladder: [model as ModelName], auto: false, reason: `사용자 지정 모델 고정: ${model}` };
}

// 초점 문구가 깊은 추론(보안/정합성/버그/성능/동시성 등)을 요구하면 상향 신호로 본다.
const DEEP_FOCUS_RE =
  /보안|security|정합|correct|버그|bug|취약|vuln|논리|logic|알고리즘|algorithm|성능|perf|race|동시성|concurren/i;
function isDeepFocus(focus?: string): boolean {
  return !!focus && DEEP_FOCUS_RE.test(focus);
}
