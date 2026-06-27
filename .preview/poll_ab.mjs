// A/B 비교 두 런이 끝날 때까지 폴링.
const GID = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERM = new Set(['completed', 'stopped_done', 'stopped_plateau', 'stopped_cap', 'stopped_cost', 'stopped_declined', 'stopped_user', 'error']);
for (let i = 0; i < 90; i++) {
  let runs = [];
  try {
    runs = await (await fetch('http://localhost:4517/api/runs')).json();
  } catch {}
  const g = runs.filter((r) => r.compare && r.compare.groupId === GID).sort((a, b) => (a.compare.variant > b.compare.variant ? 1 : -1));
  const line = g.map((r) => `${r.compare.variant}:${r.status}/${r.bestScore ?? '-'} (it${r.currentIteration})`).join('  ');
  console.log(`[t${i}] ${g.length} runs  ${line}`);
  if (g.length >= 2 && g.every((r) => TERM.has(r.status))) {
    console.log('BOTH_DONE');
    break;
  }
  await sleep(8000);
}
