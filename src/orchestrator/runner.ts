import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../config.js';
import type { EditOp, Finding, IterationResult, ReferenceDoc, RunConfig, RunInput, RunState } from '../types.js';
import { runAgent, runPlain } from './claudeAgent.js';
import { clearControl, getDesired, signal, waitWhilePaused } from './controls.js';
import { buildPrompt, buildRefsDigestPrompt, DEFAULT_LENSES } from './prompts.js';
import { runPanel } from './panel.js';
import { fixedRoute, planRoute } from './routing.js';
import { weightedScore } from './rubrics.js';
import {
  addLog,
  addUsage,
  createRun,
  readBestArtifact,
  runDir,
  saveIteration,
  setStatus,
  writeFindingsMd,
  writeState,
  writeStateMd,
} from './state.js';

export interface StartOptions extends Partial<RunConfig> {
  focus?: string; // 리뷰 초점
  references?: { title: string; ext: string; text: string }[]; // V4: 첨부 참고자료(추출 텍스트)
  compare?: { groupId: string; variant: 'A' | 'B'; label?: string }; // V4: A/B 비교 묶음
}

// 한 입력에 대해 "개선될 때까지" 자율 반복.
export async function startRun(input: RunInput, opts: StartOptions = {}): Promise<RunState> {
  const { focus, references, compare, ...rest } = opts;
  const config: RunConfig = { ...DEFAULT_CONFIG, ...stripUndefined(rest) };
  // V5: provider 가 cli 가 아니면 직접 API 호출(모델 라우팅·승급 없이 지정 모델 고정).
  const isApi = !!config.provider && config.provider !== 'cli';
  const state = await createRun(input, config);
  if (focus && focus.trim()) state.focus = focus.trim();
  if (compare) state.compare = compare;
  addLog(state, 'info', `런 시작: ${input.title} (${input.kind})${state.focus ? ` · 초점: ${state.focus}` : ''}`);

  // ── V4: 참고자료 → refs/ 저장 + 1회 기준 요약(state.refsDigest). 실패해도 진행. ──
  if (references && references.length) {
    try {
      const refsDir = path.join(runDir(state.id), 'refs');
      await fs.mkdir(refsDir, { recursive: true });
      const meta: ReferenceDoc[] = [];
      for (let i = 0; i < references.length; i++) {
        const r = references[i];
        const fname = `ref-${i + 1}.md`;
        await fs.writeFile(path.join(refsDir, fname), r.text, 'utf8');
        meta.push({ id: fname, title: r.title, ext: r.ext, chars: r.text.length });
      }
      input.references = meta;
      addLog(state, 'info', `참고자료 ${meta.length}건 첨부 — 기준 요약 생성 중...`);
      const dp = buildRefsDigestPrompt(references.map((r) => ({ title: r.title, text: r.text })));
      const { text, costUsd, tokens } = await runPlain(dp, {
        cwd: runDir(state.id),
        model: isApi ? config.model : 'haiku',
        provider: config.provider,
        runId: state.id,
        maxCostUsd: config.maxCostPerIterUsd,
      });
      const digest = text.trim().slice(0, 4000);
      if (digest) {
        state.refsDigest = digest;
        addLog(state, 'info', `참고자료 기준 요약 완료 (${digest.length}자) — 매 패스에 반영합니다.`);
      }
      if (costUsd) state.totalCostUsd += costUsd;
      if (tokens) state.totalTokens = addUsage(state.totalTokens, tokens);
      await writeState(state);
    } catch (e: any) {
      addLog(state, 'warn', `참고자료 요약 실패(무시하고 진행): ${e?.message ?? e}`);
    }
  }

  // ── 모델 라우팅 결정 ──
  // model 이 'auto'(또는 미지정)면 입력을 보고 모델 사다리를 정하고, 정체 시 자동 승급한다.
  // 특정 모델이 지정되면 그 모델로 고정(승급 없음).
  const route = isApi
    ? fixedRoute(config.model || '') // API: 지정 모델 단일 사용(승급 없음)
    : !config.model || config.model === 'auto'
      ? planRoute(input, state.focus)
      : fixedRoute(config.model);
  let tier = 0; // 현재 사다리 위치(0=시작 모델)
  let tierAttempts = 0; // 현재 모델 단계에서 시도한 회차 수(maxAttemptsPerModel 도달 시 승급)
  addLog(
    state,
    'info',
    isApi
      ? `직접 API 호출: provider=${config.provider} · 모델=${config.model || '(기본)'}`
      : `모델 라우팅: ${route.reason}${route.auto && route.ladder.length > 1 ? ` [경로 ${route.ladder.join(' → ')}]` : ''}`,
  );

  await setStatus(state, 'running');

  let noImprove = 0; // 베스트 대비 유의미한 개선이 없었던 연속 횟수(patience 판정용)
  const openHistory: number[] = []; // 회차별 열린 항목 수(정체/churn 감지용)

  try {
    for (let n = 1; n <= config.maxIterations; n++) {
      // ── 제어 확인(claude 호출 직전): 일시정지 중에는 토큰을 전혀 쓰지 않는다 ──
      const ctrl = await honorControls(state);
      if (ctrl === 'stopped') break;

      // ── 런 총비용 상한: 다음 호출을 하기 전에 누적 비용이 한도를 넘었으면 종료(진짜 비용 브레이크) ──
      if (config.maxTotalCostUsd && config.maxTotalCostUsd > 0 && state.totalCostUsd >= config.maxTotalCostUsd) {
        await setStatus(
          state,
          'stopped_cost',
          `런 총비용 상한 $${config.maxTotalCostUsd} 도달(누적 $${state.totalCostUsd.toFixed(4)}) → 종료. 베스트 ${state.bestScore} (반복 #${state.bestIteration})`,
        );
        addLog(state, 'warn', state.message!);
        break;
      }

      // 점진 진행: 1회차는 원본, 이후는 "베스트 개선본"을 이어받는다(점수 하락 회차는 버리고 베스트에서 재시도).
      const currentArtifact = n === 1 ? input.artifact : await readBestArtifact(state, input.artifact);
      const openFindings = state.findings.filter((f) => f.status === 'open');

      addLog(
        state,
        'info',
        n === 1
          ? '반복 #1 — 전체 검토 후 지적사항 대장 작성 중...'
          : `반복 #${n} — 열린 항목 ${openFindings.length}건 해결 + 놓친 부분 탐색 중...`,
      );
      await writeState(state);

      const promptCtx = {
        input,
        currentArtifact,
        iteration: n,
        isFirst: n === 1,
        openFindings,
        focus: state.focus,
        rubric: config.rubric,
        refsDigest: state.refsDigest,
        emitChanges: config.emitChanges,
      };
      const usePanel = config.reviewMode === 'panel';
      const allLenses = config.lenses && config.lenses.length ? config.lenses : DEFAULT_LENSES;
      // 점진 경량화: 1회차만 전체 렌즈+검증으로 대장 구축, 이후 패스는 렌즈 1개·검증 생략(호출수↓ = 토큰↓)
      const passLenses = n === 1 ? allLenses : allLenses.slice(0, 1);
      const passVerify = n === 1 ? config.verifyFindings !== false : false;
      const prompt = usePanel ? '' : buildPrompt(promptCtx);

      const iterModel = route.ladder[tier]; // 이번 회차에 사용할 모델(승급에 따라 단계 상승)
      tierAttempts++; // 이 모델 단계에서의 시도 횟수
      // 이번 호출에 허용할 비용: 회차당 상한과 "총비용 상한의 잔여분" 중 작은 값(잔여분으로 단일 호출 초과도 차단)
      const callBudget = perCallBudget(config, state.totalCostUsd);
      // 한 패스 실행: panel 모드면 다각도 리뷰+검증, 아니면 단일 호출.
      const doPass = () =>
        usePanel
          ? runPanel({
              ctx: promptCtx,
              iteration: n,
              cwd: runDir(state.id),
              runId: state.id,
              lenses: passLenses,
              verify: passVerify,
              lensModel: isApi ? config.model : 'haiku',
              editorModel: iterModel,
              provider: config.provider,
              maxCostUsd: callBudget,
            })
          : runAgent({ prompt, iteration: n, cwd: runDir(state.id), model: iterModel, provider: config.provider, runId: state.id, maxCostUsd: callBudget });

      if (usePanel) {
        addLog(
          state,
          'info',
          `다각도 리뷰(${passLenses.join('·')})${passVerify ? ' + 검증' : ''}${n > 1 ? ' · 경량 패스' : ''} 진행 중...`,
        );
      }

      let result;
      try {
        result = await doPass();
      } catch (e: any) {
        // 사용자가 중단을 눌러 호출이 강제 종료된 경우 → 재시도 없이 즉시 종료
        if (getDesired(state.id) === 'stop') {
          state.control = 'stopped';
          await setStatus(state, 'stopped_user', '사용자가 런을 중단했습니다.');
          addLog(state, 'info', '사용자 요청으로 진행 중 호출을 종료하고 중단됨.');
          break;
        }
        addLog(state, 'error', `반복 #${n} 실패: ${e?.message ?? e}`);
        // 일시적 실패는 1회 재시도
        if (n === state.currentIteration + 1) {
          addLog(state, 'warn', `재시도 #${n}...`);
          try {
            result = await doPass();
          } catch (e2: any) {
            await setStatus(state, 'error', `반복 #${n} 재시도 실패: ${e2?.message ?? e2}`);
            return state;
          }
        } else {
          await setStatus(state, 'error', String(e?.message ?? e));
          return state;
        }
      }

      // ── V4: 맞춤 평가기준이 있으면 종합 점수를 차원 가중평균으로 재계산 ──
      if (config.rubric) {
        const ws = weightedScore(config.rubric, result.dimensions);
        if (ws != null) result.score = ws;
      }

      // ── ① 부분 수정(edits) 적용: 비1회차는 전체본 대신 패치를 받아 현재본(베스트)에 적용 ──
      let appliedEdits: EditOp[] = []; // V4: 변경 내역(emitChanges)용 — 실제 적용된 편집
      if (n > 1) {
        const edits = result.edits ?? [];
        if (edits.length) {
          const ap = applyEdits(currentArtifact, edits);
          result.improvedArtifact = ap.text;
          appliedEdits = ap.appliedOps;
          addLog(
            state,
            ap.failed ? 'warn' : 'info',
            `부분 수정 ${ap.applied}건 적용${ap.failed ? ` · ${ap.failed}건 미적용(find 불일치)` : ''}`,
          );
        } else if (result.improvedArtifact && result.improvedArtifact.trim()) {
          addLog(state, 'warn', 'edits 없이 전체본을 반환 → 그대로 사용(폴백)');
        } else {
          result.improvedArtifact = currentArtifact; // 변경 없음
          addLog(state, 'warn', '이번 회차 변경 없음(edits 비어 있음)');
        }
      }

      // 채택 판정: 베스트 이상이면 채택. 입력은 항상 "베스트"에서 이어받으므로,
      // 비채택(점수 하락) 회차는 대장 변경을 커밋하지 않고 통째로 폐기한다(베스트와 정합 유지).
      const prevBest = state.bestScore;
      const kept = prevBest == null || result.score >= prevBest;

      // ── 채택된 회차만 지적사항 대장 갱신(해결 처리 + 놓쳤던 새 항목 추가) ──
      const { resolved, added } = kept ? applyLedger(state, result, n) : { resolved: 0, added: 0 };

      // ── V4: 변경 내역 누적(채택된 회차의 실제 적용 편집만) ──
      if (kept && config.emitChanges && appliedEdits.length) {
        if (!state.changeLog) state.changeLog = [];
        for (const e of appliedEdits) {
          state.changeLog.push({ iter: n, find: e.find, replace: e.replace, reason: e.reason, findingId: e.findingId });
        }
      }

      await saveIteration(state, result, kept);
      await writeFindingsMd(state);
      await writeStateMd(state.id, state, input);

      const openNow = state.findings.filter((f) => f.status === 'open').length;
      openHistory.push(openNow);
      addLog(
        state,
        'info',
        kept
          ? `반복 #${n} 점수 ${result.score} · 해결 ${resolved}건 · 새 발견 ${added}건 · 열린항목 ${openNow}건`
          : `반복 #${n} 점수 ${result.score} (베스트 ${state.bestScore} 미만) → 폐기하고 베스트에서 재시도`,
      );

      // 베스트 대비 유의미한 개선(minDelta 이상) 여부로 정체 카운터 갱신
      const improvedBy = prevBest == null ? Number.POSITIVE_INFINITY : result.score - prevBest;
      if (improvedBy >= config.minDelta) noImprove = 0;
      else noImprove++;

      // ── 점진 완료 판정: 열린 항목 0 & 새 발견 0 (또는 에이전트 done) ──
      const cleanPass = openNow === 0 && added === 0;
      // V4: 맞춤 평가기준의 합격선 도달 시에도 완료(베스트 기준)
      const passThreshold = config.rubric?.passThreshold;
      const reachedThreshold = passThreshold != null && state.bestScore != null && state.bestScore >= passThreshold;
      if (result.done || cleanPass || reachedThreshold) {
        addLog(
          state,
          'info',
          result.done
            ? '에이전트가 완료를 선언함 (done=true).'
            : reachedThreshold
              ? `합격선(${passThreshold}점) 도달 — 베스트 ${state.bestScore}점 → 완료.`
              : '열린 항목이 모두 해결되고 새로 발견된 문제가 없음 → 완료.',
        );
        await setStatus(
          state,
          'completed',
          reachedThreshold
            ? `합격선 ${passThreshold}점 도달(베스트 ${state.bestScore}점). 남은 지적 ${state.findings.filter((f) => f.status === 'open').length}건.`
            : `모든 지적사항 해결 (총 ${state.findings.length}건). 베스트 점수 ${state.bestScore}`,
        );
        break;
      }

      // ── 정체/막힘 신호 산출 ──
      const recurring = detectStuck(state, config.recurWindow, n, openHistory); // 막힌 항목/churn
      const plateau = config.patience > 0 && noImprove >= config.patience; // 베스트 개선 정체
      // 이 모델 단계에서 허용 시도 횟수 소진(아직 완료 못함) → 다음 단계로 강제 승급해 총 회차를 예측 가능하게
      const tierExhausted = !!config.maxAttemptsPerModel && tierAttempts >= config.maxAttemptsPerModel;
      const canEscalate = route.auto && tier < route.ladder.length - 1; // 더 강한 모델이 남았는가

      // ── ① 자동 승급: 막힘/정체 OR 단계 시도 소진 시, 더 강한 모델이 남아 있으면 한 단계 위로 재시도 ──
      if ((recurring.length || plateau || tierExhausted) && canEscalate) {
        const from = route.ladder[tier];
        tier++;
        tierAttempts = 0; // 새 단계의 시도 횟수 초기화
        const to = route.ladder[tier];
        const trigger = recurring.length ? `진행 막힘(${recurring.length}건)` : plateau ? '개선 정체' : `${config.maxAttemptsPerModel}회 시도 소진`;
        addLog(state, 'warn', `${trigger} → 모델 승급 ${from} → ${to} 로 다음 회차 재시도`);
        noImprove = 0; // 승급 후 patience 예산을 새로 부여(승급 직후 즉시 종료 방지)
        state.recurMutedUntil = state.currentIteration + config.recurWindow; // 승급 직후 즉시 재감지 방지
        // pause/stop 하지 않고 다음 반복을 더 강한 모델로 계속
      } else {
        // ── ② 더 승급할 곳이 없을 때(최상위 모델이거나 고정 모델): 기존 동작 ──
        // 막힌 항목 또는 진행 정체(churn) → 자동 일시정지(재개 가능, 일시정지 중 토큰 0)
        let pausedThisIter = false;
        if (recurring.length) {
          state.alert = {
            type: 'recurring',
            title: '진행이 막혀 자동 일시정지되었습니다',
            message:
              '불필요한 토큰 사용을 막기 위해 일시정지 됐습니다. 기존 내용 확인 부탁드립니다.',
            issues: recurring,
            ts: new Date().toISOString(),
          };
          // 재개 후 즉시 재발하지 않도록 window 회만큼 감지 보류
          state.recurMutedUntil = state.currentIteration + config.recurWindow;
          addLog(state, 'warn', `진행 정체 감지 ${recurring.length}건 → 자동 일시정지 (최상위 모델 ${route.ladder[tier]})`);
          await setStatus(state, 'paused', state.alert.message);
          signal(state.id, 'pause'); // 실제로 대기시켜 토큰 사용을 멈춘다
          const after = await honorControls(state);
          if (after === 'stopped') break;
          pausedThisIter = true;
          noImprove = 0; // 재개 시 patience 예산을 새로 부여(재개 직후 즉시 종료 방지)
        }

        // 정체/하락 조기 종료(patience·minDelta): 베스트가 patience회 연속 개선되지 않으면 종료
        if (!pausedThisIter && plateau) {
          const declined = prevBest != null && result.score < prevBest - config.minDelta;
          await setStatus(
            state,
            declined ? 'stopped_declined' : 'stopped_plateau',
            `${config.patience}회 연속 ${declined ? '점수 하락' : '개선 정체'} → 자동 종료(토큰 절약). 베스트 ${state.bestScore} (반복 #${state.bestIteration})`,
          );
          addLog(state, 'warn', state.message!);
          break;
        }
      }

      // 안전 상한(폭주 방지)
      if (n === config.maxIterations) {
        await setStatus(state, 'stopped_cap', `안전 상한(${config.maxIterations}) 도달 — 열린 항목 ${openNow}건 남음`);
        addLog(state, 'warn', state.message!);
      }
    }
  } catch (e: any) {
    addLog(state, 'error', `런 오류: ${e?.message ?? e}`);
    await setStatus(state, 'error', String(e?.message ?? e));
    clearControl(state.id);
    return state;
  }

  clearControl(state.id);
  addLog(
    state,
    'info',
    `런 종료. 베스트 점수 ${state.bestScore} (반복 #${state.bestIteration}). 산출물: runs/${state.id}/best/`,
  );
  await writeState(state);
  return state;
}

// 제어 신호를 적용한다. 반환값: 계속하려면 'run', 중단이면 'stopped'.
async function honorControls(state: RunState): Promise<'run' | 'stopped'> {
  if (getDesired(state.id) === 'stop') {
    state.control = 'stopped';
    await setStatus(state, 'stopped_user', '사용자가 런을 중단했습니다.');
    addLog(state, 'info', '사용자 요청으로 중단됨.');
    return 'stopped';
  }
  if (getDesired(state.id) === 'pause') {
    state.control = 'paused';
    // 자동 일시정지(alert)면 그 메시지를 유지, 아니면 수동 일시정지 메시지
    if (state.status !== 'paused') {
      await setStatus(
        state,
        'paused',
        state.alert?.message ?? '일시정지됨 — 재개 전까지 토큰을 사용하지 않습니다.',
      );
    }
    addLog(state, 'info', '일시정지됨 — claude 호출 중단. 재개 대기 중...');
    const next = await waitWhilePaused(state.id);
    if (next === 'stop') {
      state.control = 'stopped';
      await setStatus(state, 'stopped_user', '사용자가 런을 중단했습니다.');
      addLog(state, 'info', '사용자 요청으로 중단됨.');
      return 'stopped';
    }
    // 재개
    state.control = 'run';
    state.alert = null;
    await setStatus(state, 'running', '재개됨.');
    addLog(state, 'info', '재개됨 — 다음 반복을 계속합니다.');
  }
  return 'run';
}

// 지적사항 대장 갱신: 해결한 항목 닫기 + 놓쳤던 새 항목 추가(중복 제거).
function applyLedger(
  state: RunState,
  result: IterationResult,
  n: number,
): { resolved: number; added: number } {
  let resolved = 0;
  const openById = new Map(state.findings.filter((f) => f.status === 'open').map((f) => [f.id, f]));
  for (const id of result.resolvedIds) {
    const f = openById.get(id);
    if (f) {
      f.status = 'resolved';
      f.resolvedIter = n;
      resolved++;
    }
  }

  const known = new Set(state.findings.map((f) => normTitle(f.title)));
  let nextId = state.findings.reduce((m, f) => Math.max(m, f.id), 0) + 1;
  let added = 0;
  for (const nf of result.newFindings) {
    const key = normTitle(nf.title);
    if (!key || known.has(key)) continue; // 이미 있는 항목은 다시 추가하지 않음
    known.add(key);
    const f: Finding = { id: nextId++, title: nf.title.trim(), severity: nf.severity, status: 'open', foundIter: n };
    state.findings.push(f);
    added++;
  }
  return { resolved, added };
}

// 진행이 막힌 신호 감지 → 자동 일시정지 대상.
// (1) 같은 항목이 window 회 이상 열린 채 안 풀림, 또는
// (2) churn 보완: 최근 window 회 동안 열린 항목 수가 줄지 않음(새 지적만 반복, 순진척 0).
function detectStuck(state: RunState, window: number, currentIter: number, openHistory: number[]): string[] {
  if (window < 2) return [];
  if (currentIter <= (state.recurMutedUntil ?? 0)) return [];

  const stuck = state.findings
    .filter((f) => f.status === 'open' && currentIter - f.foundIter + 1 >= window)
    .map((f) => `#${f.id} [${f.severity ?? 'medium'}] ${f.title} (${currentIter - f.foundIter + 1}회째 미해결)`);
  if (stuck.length) return stuck;

  const recent = openHistory.slice(-window);
  if (recent.length >= window && recent.every((x) => x > 0) && Math.min(...recent) >= recent[0]) {
    const open = state.findings.filter((f) => f.status === 'open').length;
    return [`열린 항목 ${open}건이 ${window}회 동안 줄지 않음 — 새 지적만 반복되고 순진척이 없음`];
  }
  return [];
}

// ① 부분 수정 적용: find 를 현재본에서 찾아 replace 로 치환. 실제 적용된 편집 목록도 반환.
function applyEdits(base: string, edits: EditOp[]): { text: string; applied: number; failed: number; appliedOps: EditOp[] } {
  let text = base;
  let applied = 0;
  let failed = 0;
  const appliedOps: EditOp[] = [];
  for (const e of edits) {
    const i = text.indexOf(e.find);
    if (i >= 0) {
      text = text.slice(0, i) + e.replace + text.slice(i + e.find.length);
      applied++;
      appliedOps.push(e);
      continue;
    }
    // 공백/줄바꿈 차이 허용(토큰 사이 공백을 유연하게 매칭)
    const pat = e.find.trim().split(/\s+/).filter(Boolean).map(escapeRegExp).join('\\s+');
    if (pat) {
      try {
        const m = new RegExp(pat).exec(text);
        if (m) {
          text = text.slice(0, m.index) + e.replace + text.slice(m.index + m[0].length);
          applied++;
          appliedOps.push(e);
          continue;
        }
      } catch {
        /* 잘못된 정규식 → 실패 처리 */
      }
    }
    failed++;
  }
  return { text, applied, failed, appliedOps };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normTitle(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim()
    .slice(0, 80);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// 이번 claude 호출에 줄 비용 상한($) — 회차당 상한과 "총비용 상한의 잔여분" 중 작은 값.
// 둘 다 없으면 undefined(무제한). 잔여분으로 단일 호출이 총상한을 넘는 것도 막는다.
function perCallBudget(config: RunConfig, spentUsd: number): number | undefined {
  const limits: number[] = [];
  if (config.maxCostPerIterUsd && config.maxCostPerIterUsd > 0) limits.push(config.maxCostPerIterUsd);
  if (config.maxTotalCostUsd && config.maxTotalCostUsd > 0) limits.push(Math.max(0, config.maxTotalCostUsd - spentUsd));
  return limits.length ? Math.min(...limits) : undefined;
}
