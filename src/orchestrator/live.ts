import { EventEmitter } from 'node:events';

// 진행 중 생성 텍스트를 대시보드로 실시간 흘려보내는 인메모리 채널(같은 프로세스).
// 디스크(runs/*)를 토큰마다 쓰지 않고, SSE 로만 브로드캐스트한다.
export const liveBus = new EventEmitter();
liveBus.setMaxListeners(100);

interface LiveBuf {
  text: string; // 현재까지 누적(뒤쪽만 보관)
  ts: number;
  flush: NodeJS.Timeout | null; // per-run throttle
}

const MAX_BUF = 8000; // 화면엔 최근 일부만 필요 → 메모리·전송량 절약
const THROTTLE_MS = 120; // 초당 ~8회로 묶어 보냄(토큰마다 SSE 폭주 방지)

const buffers = new Map<string, LiveBuf>();

// 새 생성 시작 → 버퍼 초기화 + 클라이언트 리셋 신호.
export function liveStart(runId: string): void {
  if (!runId) return;
  const prev = buffers.get(runId);
  if (prev?.flush) clearTimeout(prev.flush);
  buffers.set(runId, { text: '', ts: Date.now(), flush: null });
  liveBus.emit('live', { runId, reset: true });
}

// 토큰 델타 추가(스로틀링해서 묶어 emit).
export function liveToken(runId: string, delta: string): void {
  if (!runId || !delta) return;
  const b = buffers.get(runId);
  if (!b) return;
  b.text = (b.text + delta).slice(-MAX_BUF);
  b.ts = Date.now();
  if (b.flush) return; // 이미 예약됨
  b.flush = setTimeout(() => {
    b.flush = null;
    liveBus.emit('live', { runId, text: b.text });
  }, THROTTLE_MS);
}

// 생성 종료 → 마지막 상태 flush 후 완료 신호.
export function liveEnd(runId: string): void {
  if (!runId) return;
  const b = buffers.get(runId);
  if (b?.flush) clearTimeout(b.flush);
  if (b) liveBus.emit('live', { runId, text: b.text });
  buffers.delete(runId);
  liveBus.emit('live', { runId, done: true });
}
