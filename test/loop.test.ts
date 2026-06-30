import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 전체 루프(채택·해결·완료)를 LLM 없이 가짜 에이전트로 검증한다.
// RUNS_DIR 격리를 위해 env 를 먼저 설정한 뒤 동적 import.
test('startRun: 가짜 에이전트로 2회차 만에 모든 지적 해결 후 완료', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'autodr-loop-'));
  process.env.AUTODR_RUNS_DIR = dir;
  const runner = await import('../src/orchestrator/runner.js');
  const { startRun, agentHooks } = runner;

  const origAgent = agentHooks.runAgent;
  const origJudge = agentHooks.runJudge;
  let call = 0;
  // 가짜 에디터: iter1 은 지적 2건 + 개선본, iter2 는 두 지적을 edit 으로 해결.
  agentHooks.runAgent = async (opts: any) => {
    call++;
    const base = {
      iteration: opts.iteration,
      dimensions: {},
      rationale: 'test',
      reviewMarkdown: 'note',
      done: false,
      durationMs: 1,
      createdAt: new Date().toISOString(),
      costUsd: 0,
    };
    if (call === 1) {
      return {
        ...base,
        score: 60,
        improvedArtifact: 'IMPROVED-1',
        edits: [],
        resolvedIds: [],
        newFindings: [{ title: '문제 A' }, { title: '문제 B' }],
      } as any;
    }
    // iter2: 현재본(IMPROVED-1)을 고치는 edit 으로 #1,#2 해결
    return {
      ...base,
      score: 80,
      improvedArtifact: '',
      edits: [{ find: 'IMPROVED-1', replace: 'IMPROVED-2', findingIds: [1, 2] }],
      resolvedIds: [1, 2],
      newFindings: [],
    } as any;
  };
  agentHooks.runJudge = async () => null; // 자가 점수 사용

  try {
    const input = {
      kind: 'document' as const,
      source: 'test',
      title: 'loop-test',
      artifact: 'ORIGINAL TEXT',
      ext: 'md',
    };
    const state = await startRun(input, { useJudge: false, finalPass: false, maxIterations: 5, model: 'sonnet' });

    assert.equal(state.status, 'completed', '모든 지적 해결 후 completed 여야 함');
    assert.equal(state.findings.length, 2);
    assert.equal(state.findings.filter((f) => f.status === 'open').length, 0, '열린 항목이 없어야 함');
    assert.equal(state.bestScore, 80);
    assert.equal(state.bestIteration, 2);
  } finally {
    agentHooks.runAgent = origAgent;
    agentHooks.runJudge = origJudge;
    delete process.env.AUTODR_RUNS_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
