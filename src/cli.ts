#!/usr/bin/env -S npx tsx
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { DASHBOARD_PORT } from './config.js';
import { resolveInput } from './input/adapters.js';
import { startRun } from './orchestrator/runner.js';
import { listRuns } from './orchestrator/state.js';
import { startDashboard } from './dashboard/server.js';
import type { InputKind } from './types.js';

const program = new Command();
program.name('auto-dr').description('자율 문서/코드/웹 리뷰·개선 루프').version('0.1.0');

program
  .command('review')
  .argument('<source>', '로컬 파일 경로, 디렉터리, 또는 http(s) URL')
  .option('-k, --kind <kind>', '입력 종류 강제 (document|url|code)')
  .option('-p, --port <port>', '대시보드 포트', String(DASHBOARD_PORT))
  .option('--patience <n>', '비개선 연속 허용 횟수', (v) => parseInt(v, 10))
  .option('--min-delta <n>', '개선 인정 최소 점수폭', (v) => parseFloat(v))
  .option('--max-iter <n>', '안전 상한 반복 수', (v) => parseInt(v, 10))
  .option('--model <model>', 'claude 모델 (예: opus, sonnet)')
  .option('--url-mode <mode>', 'URL 리뷰 범위 (content|source|full)', 'full')
  .option('--url-render <mode>', 'URL JS 렌더링 (off|auto|on)', 'auto')
  .option('--url-crawl <n>', '같은 도메인 추가 페이지 크롤 수(최대 8)', (v) => parseInt(v, 10))
  .option('--url-check-links', '링크 유효성(깨진 링크) 검사')
  .option('--no-dashboard', '대시보드 없이 실행')
  .option('--open', '브라우저 자동 열기')
  .action(async (source: string, opts: any) => {
    const port = parseInt(opts.port, 10);
    let dash: Awaited<ReturnType<typeof startDashboard>> | null = null;
    if (opts.dashboard) {
      dash = await startDashboard(port);
      console.log(`\n  📊 대시보드: ${dash.url}\n`);
      if (opts.open) openBrowser(dash.url);
    }

    console.log(`입력 분석 중: ${source}`);
    const input = await resolveInput(source, opts.kind as InputKind | undefined, { urlMode: opts.urlMode, urlRender: opts.urlRender, urlCrawl: opts.urlCrawl, urlCheckLinks: opts.urlCheckLinks });
    console.log(`→ 종류=${input.kind}, 제목=${input.title}, 길이=${input.artifact.length}자\n`);

    const run = await startRun(input, {
      patience: opts.patience,
      minDelta: opts.minDelta,
      maxIterations: opts.maxIter,
      model: opts.model,
    });

    console.log(`\n✅ 완료 — 상태: ${run.status}, 베스트 점수: ${run.bestScore} (반복 #${run.bestIteration})`);
    console.log(`   산출물: runs/${run.id}/best/`);

    if (dash) {
      console.log(`\n  대시보드 유지 중: ${dash.url}  (종료: Ctrl+C)`);
    } else {
      process.exit(0);
    }
  });

program
  .command('dashboard')
  .description('대시보드만 실행')
  .option('-p, --port <port>', '포트', String(DASHBOARD_PORT))
  .option('--open', '브라우저 자동 열기')
  .action(async (opts: any) => {
    const dash = await startDashboard(parseInt(opts.port, 10));
    console.log(`📊 대시보드: ${dash.url}  (종료: Ctrl+C)`);
    if (opts.open) openBrowser(dash.url);
  });

program
  .command('list')
  .description('저장된 런 목록')
  .action(async () => {
    const runs = await listRuns();
    if (!runs.length) return console.log('런이 없습니다.');
    for (const r of runs) {
      console.log(`${r.id}  [${r.status}]  best=${r.bestScore ?? '-'}  iters=${r.currentIteration}  ${r.title}`);
    }
  });

function openBrowser(url: string) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

program.parseAsync(process.argv);
