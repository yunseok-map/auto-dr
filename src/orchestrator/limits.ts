// 전역 가드: 여러 런이 동시에 돌 때 claude 프로세스 폭증·합산 비용 폭주를 막는다.
// (런 1개당 상한은 RunConfig 에 있지만, 동시에 N개를 띄우면 합계가 무제한이 되는 문제를 보완)

// 동시 실행 슬롯 수(기본 2). AUTODR_MAX_CONCURRENT 로 조정.
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.AUTODR_MAX_CONCURRENT || '2', 10) || 2);

// 세션 누적 비용 상한($). 기본 10. 0/빈값이면 무제한. AUTODR_MAX_SESSION_COST 로 조정.
const MAX_SESSION_COST = (() => {
  const raw = process.env.AUTODR_MAX_SESSION_COST;
  if (raw === undefined) return 10;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 = 무제한
})();

let active = 0;
const waiters: Array<() => void> = [];
let sessionCostUsd = 0;

// 동시 실행 슬롯 획득. 슬롯이 없으면 대기. 반환된 release() 를 반드시 호출.
export function acquireSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active--;
        const next = waiters.shift();
        if (next) next();
      });
    };
    if (active < MAX_CONCURRENT) grant();
    else waiters.push(grant);
  });
}

// 세션 누적 비용에 더한다(각 호출 후 호출).
export function addSessionCost(usd: number | undefined): void {
  if (usd && usd > 0) sessionCostUsd += usd;
}

// 세션 누적 비용이 상한을 넘었는지(다음 호출 전에 검사).
export function sessionCostExceeded(): boolean {
  return MAX_SESSION_COST > 0 && sessionCostUsd >= MAX_SESSION_COST;
}

export function sessionCostStatus(): { spent: number; cap: number; concurrency: number } {
  return { spent: sessionCostUsd, cap: MAX_SESSION_COST, concurrency: MAX_CONCURRENT };
}
