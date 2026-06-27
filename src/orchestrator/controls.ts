// 런 일시정지/재개/중단 제어 레지스트리 (인메모리).
// 대시보드 서버와 러너가 같은 프로세스에서 동작하므로 인메모리로 신호를 공유한다.
// 일시정지 중에는 claude 를 호출하지 않으므로 토큰이 전혀 소모되지 않는다.

export type Desired = 'run' | 'pause' | 'stop';

interface Controller {
  desired: Desired;
  waiters: Set<() => void>;
}

const registry = new Map<string, Controller>();

function ensure(id: string): Controller {
  let c = registry.get(id);
  if (!c) {
    c = { desired: 'run', waiters: new Set() };
    registry.set(id, c);
  }
  return c;
}

// 외부(대시보드 API)에서 신호를 보낸다.
export function signal(id: string, desired: Desired): void {
  const c = ensure(id);
  c.desired = desired;
  // 대기 중인 러너를 깨운다.
  for (const w of [...c.waiters]) w();
  // 중단이면 진행 중인 claude 호출을 즉시 강제 종료(토큰 절약).
  if (desired === 'stop') killChild(id);
}

// ── 진행 중인 claude 자식 프로세스 추적(즉시 중단용) ──
// 한 런이 여러 호출(panel 의 렌즈 병렬 등)을 동시에 띄울 수 있으므로 런당 여러 kill 을 보관.
const children = new Map<string, Set<() => void>>();

export function registerChild(id: string, kill: () => void): void {
  let s = children.get(id);
  if (!s) {
    s = new Set();
    children.set(id, s);
  }
  s.add(kill);
}
export function unregisterChild(id: string, kill: () => void): void {
  children.get(id)?.delete(kill);
}
// 해당 런의 "현재 떠 있는 모든" claude 자식을 즉시 종료한다.
function killChild(id: string): void {
  const s = children.get(id);
  if (!s) return;
  for (const k of [...s]) {
    try {
      k();
    } catch {
      /* ignore */
    }
  }
}

export function getDesired(id: string): Desired {
  return registry.get(id)?.desired ?? 'run';
}

// 일시정지(pause) 상태인 동안 블로킹한다. 재개(run) 또는 중단(stop) 시 그 신호를 반환.
export function waitWhilePaused(id: string): Promise<Desired> {
  const c = ensure(id);
  if (c.desired !== 'pause') return Promise.resolve(c.desired);
  return new Promise((resolve) => {
    const check = () => {
      if (c.desired !== 'pause') {
        c.waiters.delete(check);
        resolve(c.desired);
      }
    };
    c.waiters.add(check);
  });
}

// 런 종료 시 정리.
export function clearControl(id: string): void {
  registry.delete(id);
  children.delete(id);
}
