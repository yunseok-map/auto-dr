import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, isBudgetError, isRateLimitError, applyLedger, estimateModelCost } from '../src/orchestrator/runner.js';
import type { Finding, IterationResult, RunState } from '../src/types.js';
import { weightedScore, normalizeRubric } from '../src/orchestrator/rubrics.js';
import { isPrivateIp } from '../src/input/adapters.js';
import { isSimilarTitle, dedupeByTitle, findSimilarIndex } from '../src/orchestrator/dedup.js';
import { chunkArtifact } from '../src/orchestrator/chunked.js';

// ── applyEdits: 안전한 부분 수정(고유성 검증) ──
test('applyEdits: 유일 매칭은 치환 적용', () => {
  const r = applyEdits('hello world', [{ find: 'world', replace: 'there' }]);
  assert.equal(r.text, 'hello there');
  assert.equal(r.applied, 1);
  assert.equal(r.ambiguous, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.appliedOps.length, 1);
});

test('applyEdits: 다중 일치는 모호로 분류하고 건너뜀(오적용 방지)', () => {
  const r = applyEdits('a a a', [{ find: 'a', replace: 'X' }]);
  assert.equal(r.text, 'a a a'); // 변경 없음
  assert.equal(r.applied, 0);
  assert.equal(r.ambiguous, 1);
});

test('applyEdits: find 가 없으면 failed', () => {
  const r = applyEdits('hello', [{ find: 'zzz', replace: 'q' }]);
  assert.equal(r.applied, 0);
  assert.equal(r.failed, 1);
});

test('applyEdits: 공백 차이는 유연 매칭(유일할 때만)', () => {
  const r = applyEdits('foo    bar baz', [{ find: 'foo bar', replace: 'X' }]);
  assert.equal(r.applied, 1);
  assert.equal(r.text, 'X baz');
});

test('applyEdits: 빈 문자열 replace 는 삭제', () => {
  const r = applyEdits('keep [drop]', [{ find: ' [drop]', replace: '' }]);
  assert.equal(r.text, 'keep');
  assert.equal(r.applied, 1);
});

test('applyEdits: 스마트 따옴표/대시 표기차를 정규화 매칭', () => {
  const r = applyEdits('He said “hello” — ok', [{ find: '"hello" - ok', replace: 'X' }]);
  assert.equal(r.applied, 1);
  assert.equal(r.text, 'He said X');
});

test('applyEdits: 연속 공백/줄바꿈 차이를 정규화 매칭', () => {
  const r = applyEdits('foo    bar\n\tbaz qux', [{ find: 'bar baz qux', replace: 'X' }]);
  assert.equal(r.applied, 1);
  assert.equal(r.text, 'foo    X');
});

test('applyEdits: 정규화 후에도 다중 일치면 ambiguous(오적용 방지)', () => {
  const r = applyEdits('a dash — x and a dash — y', [{ find: 'a dash - ', replace: 'Z' }]);
  assert.equal(r.applied, 0);
  assert.equal(r.ambiguous, 1);
});

// E3: 적용 실패/모호한 find 는 unmatched 로 모아 다음 회차 프롬프트에 피드백한다.
test('applyEdits: 불일치/모호 find 는 unmatched 에 수집(적용된 것은 제외)', () => {
  const r = applyEdits('hello world, a a a', [
    { find: 'world', replace: 'there' }, // 적용됨 → unmatched 아님
    { find: 'zzz', replace: 'q' }, // 불일치
    { find: 'a', replace: 'X' }, // 다중 일치(모호)
  ]);
  assert.equal(r.applied, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.ambiguous, 1);
  assert.deepEqual(r.unmatched.sort(), ['a', 'zzz']);
});

// ── weightedScore: 차원 가중평균 ──
test('weightedScore: 가중평균을 계산', () => {
  const rubric = normalizeRubric({
    dimensions: [
      { name: '정확성', weight: 2 },
      { name: '명료성', weight: 1 },
    ],
  })!;
  const s = weightedScore(rubric, { 정확성: 90, 명료성: 60 });
  assert.equal(s, 80); // (90*2 + 60*1) / 3 = 80
});

test('weightedScore: 이름 매칭은 대소문자/공백 무시', () => {
  const rubric = normalizeRubric({ dimensions: [{ name: 'Clarity Score', weight: 1 }] })!;
  const s = weightedScore(rubric, { clarityscore: 70 });
  assert.equal(s, 70);
});

test('weightedScore: 매칭되는 차원이 없으면 null', () => {
  const rubric = normalizeRubric({ dimensions: [{ name: 'A', weight: 1 }] })!;
  assert.equal(weightedScore(rubric, { B: 50 }), null);
});

// ── normalizeRubric: 안전 정규화 ──
test('normalizeRubric: 잘못된 가중치는 1로, 빈 이름은 제거', () => {
  const r = normalizeRubric({
    dimensions: [
      { name: 'ok', weight: -5 },
      { name: '', weight: 2 },
      { name: 'good' },
    ],
    passThreshold: 88,
  })!;
  assert.equal(r.dimensions.length, 2);
  assert.equal(r.dimensions[0].weight, 1); // 음수 → 1
  assert.equal(r.passThreshold, 88);
});

test('normalizeRubric: 차원이 하나도 없으면 null', () => {
  assert.equal(normalizeRubric({ dimensions: [] }), null);
  assert.equal(normalizeRubric(null), null);
});

test('normalizeRubric: 범위 밖 passThreshold 는 무시', () => {
  const r = normalizeRubric({ dimensions: [{ name: 'a', weight: 1 }], passThreshold: 999 })!;
  assert.equal(r.passThreshold, undefined);
});

// ── isPrivateIp: SSRF 가드 ──
test('isPrivateIp: 사설/루프백/링크로컬은 차단 대상', () => {
  assert.equal(isPrivateIp('10.0.0.1'), true);
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('192.168.1.1'), true);
  assert.equal(isPrivateIp('172.16.5.4'), true);
  assert.equal(isPrivateIp('169.254.169.254'), true); // 클라우드 메타데이터
  assert.equal(isPrivateIp('::1'), true);
});

test('isPrivateIp: 공인 IP 는 허용', () => {
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('1.1.1.1'), false);
  assert.equal(isPrivateIp('172.32.0.1'), false); // 172.16~31 밖
});

// ── dedup: 토큰 유사도 기반 근접 중복 ──
test('isSimilarTitle: 표현만 다른 근접 중복을 같다고 본다', () => {
  assert.equal(isSimilarTitle('서론 문장이 모호하다', '서론 문장이 모호함'), true);
  assert.equal(isSimilarTitle('보안 취약점: SQL 인젝션', '완전히 다른 성능 문제'), false);
});

test('dedupeByTitle: 근접 중복 제거(앞선 항목 보존)', () => {
  const items = [
    { title: '제목이 불명확하다' },
    { title: '제목이 불명확함' }, // 근접 중복
    { title: '오타가 있다' },
  ];
  const out = dedupeByTitle(items);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, '제목이 불명확하다');
});

test('findSimilarIndex: 없으면 -1', () => {
  assert.equal(findSimilarIndex('전혀 새로운 지적', ['기존 항목 하나']), -1);
});

// ── chunkArtifact: 분할은 내용을 누락하지 않는다 ──
test('chunkArtifact: 청크를 이어붙이면 원본 토큰이 모두 보존', () => {
  const doc = ['# A', 'aaaa', '# B', 'bbbb', '# C', 'cccc'].join('\n');
  const chunks = chunkArtifact(doc, 'document', 12);
  assert.ok(chunks.length >= 2); // 예산이 작아 여러 청크
  const joined = chunks.join('\n');
  for (const kw of ['# A', 'aaaa', '# B', 'bbbb', '# C', 'cccc']) {
    assert.ok(joined.includes(kw), `누락된 조각: ${kw}`);
  }
});

test('chunkArtifact: 작은 입력은 단일 청크', () => {
  const chunks = chunkArtifact('짧은 문서', 'document', 12000);
  assert.equal(chunks.length, 1);
});

// ── isBudgetError: 비용 상한 거부를 graceful 종료로 분류 ──
test('isBudgetError: 예산 초과 오류를 인식', () => {
  assert.equal(isBudgetError(new Error('claude 오류 응답: error_max_budget_usd')), true);
  assert.equal(isBudgetError('exceeded max_budget'), true);
});

test('isBudgetError: 일반 오류는 false', () => {
  assert.equal(isBudgetError(new Error('network timeout')), false);
  assert.equal(isBudgetError(null), false);
});

// ── isRateLimitError: 세션/사용 한도를 graceful 종료로 분류 ──
test('isRateLimitError: 세션·레이트 한도를 인식', () => {
  assert.equal(isRateLimitError(new Error("You've hit your session limit · resets 3:50pm")), true);
  assert.equal(isRateLimitError('429 Too Many Requests'), true);
  assert.equal(isRateLimitError('usage limit reached'), true);
});

test('isRateLimitError: 일반 오류는 false', () => {
  assert.equal(isRateLimitError(new Error('error_max_budget_usd')), false);
  assert.equal(isRateLimitError(null), false);
});

// ── applyLedger: R1(edit 뒷받침 해결) / R2(후반 신규 상한) ──
function makeState(findings: Finding[]): RunState {
  return { findings } as unknown as RunState;
}
function makeResult(resolvedIds: number[], newFindings: { title: string; severity?: any }[]): IterationResult {
  return { resolvedIds, newFindings } as unknown as IterationResult;
}
const openFinding = (id: number): Finding => ({ id, title: `이슈 ${id}`, status: 'open', foundIter: 1 });

test('R1: 태그된 해결만 인정(edit 이 건드린 항목만 닫힘)', () => {
  const state = makeState([openFinding(1), openFinding(2), openFinding(3)]);
  // 모델이 1·2·3 해결 주장했지만 edit findingIds 에는 2만 있음 → 2만 해결, 1·3 보류
  const r = applyLedger(state, makeResult([1, 2, 3], []), 2, {
    changed: true,
    requireMapping: true,
    appliedFindingIds: new Set([2]),
    appliedCount: 1,
  });
  assert.equal(r.resolved, 1);
  assert.equal(r.rejected, 2);
  assert.equal(state.findings.find((f) => f.id === 2)!.status, 'resolved');
  assert.equal(state.findings.find((f) => f.id === 1)!.status, 'open');
});

test('R1: 태그가 전혀 없으면 적용된 edit 수만큼만 해결 인정', () => {
  const state = makeState([openFinding(1), openFinding(2), openFinding(3)]);
  // edit 1건 적용·태그 없음, 해결 3건 주장 → 1건만 인정
  const r = applyLedger(state, makeResult([1, 2, 3], []), 2, {
    changed: true,
    requireMapping: true,
    appliedFindingIds: new Set(),
    appliedCount: 1,
  });
  assert.equal(r.resolved, 1);
  assert.equal(r.rejected, 2);
});

test('R1: 본문 변경이 없으면 해결 전부 무시', () => {
  const state = makeState([openFinding(1)]);
  const r = applyLedger(state, makeResult([1], []), 2, {
    changed: false,
    requireMapping: true,
    appliedFindingIds: new Set([1]),
    appliedCount: 1,
  });
  assert.equal(r.resolved, 0);
  assert.equal(r.rejected, 1);
});

test('R2: 후반 신규 지적은 중요도순 maxNew 개까지만', () => {
  const state = makeState([]);
  const r = applyLedger(
    state,
    makeResult([], [
      { title: '사소한 A', severity: 'low' },
      { title: '중대한 B', severity: 'high' },
      { title: '보통 C', severity: 'medium' },
    ]),
    2,
    { changed: true, requireMapping: true, appliedFindingIds: new Set(), appliedCount: 0, maxNew: 1 },
  );
  assert.equal(r.added, 1);
  assert.equal(r.droppedNew, 2);
  assert.equal(state.findings[0].title, '중대한 B'); // high 우선 채택
});

test('R2: maxNew 없으면(1회차/마무리) 전부 추가', () => {
  const state = makeState([]);
  const r = applyLedger(state, makeResult([], [{ title: 'x' }, { title: 'y' }]), 1, {
    changed: true,
    requireMapping: false,
    appliedFindingIds: new Set(),
    appliedCount: 0,
  });
  assert.equal(r.added, 2);
  assert.equal(r.droppedNew, 0);
});

// ── R3: 승급 예산 추정 ──
test('estimateModelCost: 직전 비용 × 모델 단가비 × 마진', () => {
  const state = { iterations: [{ costUsd: 0.1 }] } as unknown as RunState;
  // haiku→opus: 0.1 × (5/1) × 1.1 = 0.55
  assert.ok(Math.abs(estimateModelCost(state, 'haiku', 'opus')! - 0.55) < 1e-9);
  // sonnet→opus: 0.1 × (5/3) × 1.1 ≈ 0.18333
  assert.ok(Math.abs(estimateModelCost(state, 'sonnet', 'opus')! - 0.1 * (5 / 3) * 1.1) < 1e-9);
});

test('estimateModelCost: 비용 기록이 없으면 null(승급 허용)', () => {
  const state = { iterations: [] } as unknown as RunState;
  assert.equal(estimateModelCost(state, 'sonnet', 'opus'), null);
});
