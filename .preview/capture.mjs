// Headless screenshot via Chrome DevTools Protocol — no external deps.
// Uses Node 22 global fetch + global WebSocket. Chrome must already be
// running with --remote-debugging-port=9222 (isolated profile).
import { writeFileSync } from 'node:fs';

const PORT = 9222;
const OUT = process.argv[2] || 'shot.png';
const TARGET_URL = process.argv[3] || 'http://localhost:4517/';
const WAIT_MS = Number(process.argv[4] || 5500);
const SCALE = Number(process.argv[5] || 1);       // deviceScaleFactor (crispness)
const CLIP_H = Number(process.argv[6] || 0);      // fixed crop height (0 = full content)
const EVAL = process.argv[7] || '';               // JS to run after load (e.g. click a tab)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return t;
    } catch {}
    await sleep(300);
  }
  throw new Error('no page target found on CDP');
}

const target = await getPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) =>
  new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });

await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1550, deviceScaleFactor: SCALE, mobile: false });
await send('Page.navigate', { url: TARGET_URL });
await sleep(WAIT_MS);
if (EVAL) {
  await send('Runtime.evaluate', { expression: EVAL });
  await sleep(2000);
}
const lm = await send('Page.getLayoutMetrics');
const cs = (lm.result && (lm.result.cssContentSize || lm.result.contentSize)) || { width: 1600, height: 1550 };
const fullH = Math.min(Math.ceil(cs.height), 6000);
const clip = { x: 0, y: 0, width: Math.ceil(cs.width), height: CLIP_H > 0 ? CLIP_H : fullH, scale: 1 };
const shot = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
if (!shot.result || !shot.result.data) { console.error('no screenshot data:', JSON.stringify(shot).slice(0, 300)); process.exit(2); }
const buf = Buffer.from(shot.result.data, 'base64');
writeFileSync(OUT, buf);
console.log('WROTE', OUT, buf.length, 'bytes; page', clip.width + 'x' + clip.height);
ws.close();
process.exit(0);
