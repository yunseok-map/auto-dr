import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../config.js';
import type { EditOp, Finding, IterationResult, NewFinding, ReferenceDoc, RunConfig, RunInput, RunState } from '../types.js';
import { runAgent, runPlain } from './claudeAgent.js';
import { clearControl, getDesired, signal, waitWhilePaused } from './controls.js';
import { acquireSlot, addSessionCost, sessionCostExceeded } from './limits.js';
import { findSimilarIndex } from './dedup.js';
import { buildPrompt, buildRefsDigestPrompt, detectLang, DEFAULT_LENSES } from './prompts.js';
import { runPanel } from './panel.js';
import { runChunkedFirstPass } from './chunked.js';
import { runJudge } from './judge.js';
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
  // ── 이어하기(resume) ──
  parentId?: string; // 이어받은 원본 런 id (있으면 이 런은 "이어하기"로 동작)
  seedFindings?: Finding[]; // 이어받을 열린 지적사항(대장 시드) → 1회차부터 점진 해결 모드
  refsDigest?: string; // 부모 런의 참고자료 요약을 그대로 승계(재생성 비용 절약)
}

// 회귀 가드: 개선본 길이가 직전 베스트의 이 비율 미만이면 콘텐츠 손실로 보고 채택 거부.
const SHRINK_VETO_RATIO = 0.5;
// E1: 채택 히스테리시스 — 독립 채점기(단발 호출)의 점수 노이즈로 좋은 회차가 폐기되는 것을 막는다.
// 베스트보다 이 폭 미만으로만 낮으면(노이즈 범위) 채택해 대장(해결된 항목) 진척을 보존한다.
const ACCEPT_EPS = 1.0;
// 1회차 입력이 이 길이를 넘으면 분할(map-reduce) 검토로 전환(컨텍스트 초과·누락 방지).
const LARGE_FIRST_CHARS = 24000;
// 회차당 예산이 이 값 미만이면 호출이 비용 상한에서 거부되므로, 시도 대신 graceful 종료한다.
const MIN_CALL_BUDGET_USD = 0.03;

// #5: 테스트에서 LLM 호출을 가짜로 갈아끼울 수 있는 주입 지점(단일 모드 루프 테스트용).
// 프로덕션에서는 실제 runAgent/runJudge 를 그대로 사용.
export const agentHooks = { runAgent, runJudge };

// 한 입력에 대해 "개선될 때까지" 자율 반복.
export async function startRun(input: RunInput, opts: StartOptions = {}): Promise<RunState> {
  const { focus, references, compare, parentId, seedFindings, refsDigest, ...rest } = opts;
  const config: RunConfig = { ...DEFAULT_CONFIG, ...stripUndefined(rest) };
  // V5: provider 가 cli 가 아니면 직접 API 호출(모델 라우팅·승급 없이 지정 모델 고정).
  const isApi = !!config.provider && config.provider !== 'cli';
  // 이어하기: 부모 런이 지정되면 1회차부터 점진(해결+신규) 모드로 동작(처음부터 다시 안 함).
  const resumed = !!parentId;
  // #9: 입력 언어를 감지해 출력 언어를 맞춘다(한국어 입력이면 기존과 동일).
  const lang = detectLang(input.artifact);
  const state = await createRun(input, config);
  if (focus && focus.trim()) state.focus = focus.trim();
  if (compare) state.compare = compare;
  if (parentId) state.parentId = parentId;
  if (refsDigest && refsDigest.trim()) state.refsDigest = refsDigest.trim();
  // 대장 시드: 부모 런의 열린 지적을 이어받아 번호를 다시 매긴다(중복/누락 없이).
  if (seedFindings && seedFindings.length) {
    state.findings = seedFindings.map((f, i) => ({
      id: i + 1,
      title: f.title,
      severity: f.severity,
      status: 'open',
      foundIter: 0, // 부모에서 이어받음
    }));
    await writeFindingsMd(state);
  }
  addLog(
    state,
    'info',
    resumed
      ? `이어하기 시작: ${input.title} — 이어받은 열린 지적 ${state.findings.length}건 (원본: ${parentId})`
      : `런 시작: ${input.title} (${input.kind})${state.focus ? ` · 초점: ${state.focus}` : ''}`,
  );

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
      addSessionCost(costUsd);
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
  let lastUnmatchedFinds: string[] = []; // E3: 직전 회차에 적용 실패한 edit 의 find(다음 프롬프트에 피드백)
  let finalPassDone = false; // 마무리 정밀검증 패스를 이미 돌렸는지(최대 1회)
  let forceFinal = false; // 이번 회차를 마무리 정밀검증 패스로 강제 실행

  // 전역 동시 실행 슬롯 — 여러 런이 동시에 claude 프로세스를 폭증시키지 않도록 제한(슬롯 없으면 대기).
  const releaseSlot = await acquireSlot();
  try {
    for (let n = 1; n <= config.maxIterations; n++) {
      // ── 제어 확인(claude 호출 직전): 일시정지 중에는 토큰을 전혀 쓰지 않는다 ──
      const ctrl = await honorControls(state);
      if (ctrl === 'stopped') break;

      // ── 세션 전역 비용 상한: 모든 런 합산이 한도를 넘으면 새 호출 전에 종료(폭주 백스톱) ──
      if (sessionCostExceeded()) {
        await setStatus(
          state,
          'stopped_cost',
          `세션 전역 비용 상한 도달 → 종료. 베스트 ${state.bestScore} (반복 #${state.bestIteration})`,
        );
        addLog(state, 'warn', state.message!);
        break;
      }

      // ── 런 총비용 상한: 다음 호출을 하기 전에 누적 비용이 한도를 넘었으면 종료(진짜 비용 브레이크) ──
      if (config.maxTotalCostUsd && config.maxTotalCostUsd > 0 && state.totalCostUsd >= config.maxTotalCostUsd) {
        // 아직 수렴 전(완료 아님)이면 상한을 올리라는 힌트를 덧붙인다. panel 모드는 회차당 비용이 큼.
        const hint =
          state.findings.some((f) => f.status === 'open')
            ? ` — 미완료(열린 ${state.findings.filter((f) => f.status === 'open').length}건). 상한을 올리거나(대시보드 '런 총비용 상한')${config.reviewMode === 'panel' ? ' panel 모드 비용을 고려하세요' : ' 비우면 기본 $2.00'}.`
            : '';
        await setStatus(
          state,
          'stopped_cost',
          `런 총비용 상한 $${config.maxTotalCostUsd} 도달(누적 $${state.totalCostUsd.toFixed(4)}) → 종료. 베스트 ${state.bestScore} (반복 #${state.bestIteration})${hint}`,
        );
        addLog(state, 'warn', state.message!);
        break;
      }

      // ── 예산 바닥 가드: 남은 회차당 예산이 너무 적으면 호출이 error_max_budget_usd 로 죽으므로
      //    더 강한 모델로 승급해 호출을 시도하기 전에 깔끔하게 종료한다(크래시 대신 graceful stop). ──
      const remainingBudget = perCallBudget(config, state.totalCostUsd);
      if (remainingBudget != null && remainingBudget < MIN_CALL_BUDGET_USD) {
        await setStatus(
          state,
          'stopped_cost',
          `남은 예산(약 $${remainingBudget.toFixed(4)})이 1회 호출에 부족 → 종료. 베스트 ${state.bestScore} (반복 #${state.bestIteration})`,
        );
        addLog(state, 'warn', state.message!);
        break;
      }

      // isFirst = 처음부터 전체 검토해 대장을 새로 만드는 1회차. 이어하기(resumed)면 1회차도 점진 모드.
      const isFirst = n === 1 && !resumed;
      // 점진 진행: 1회차는 입력(원본 또는 이어받은 베스트), 이후는 "베스트 개선본"을 이어받는다.
      const currentArtifact = n === 1 ? input.artifact : await readBestArtifact(state, input.artifact);
      // #7: 심각도 높은 항목을 먼저 해결하도록 정렬(high>medium>low, 동일 시 발견 순).
      const sevRank = (s?: string) => (s === 'high' ? 0 : s === 'low' ? 2 : 1);
      const openFindings = state.findings
        .filter((f) => f.status === 'open')
        .sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.foundIter - b.foundIter || a.id - b.id);

      addLog(
        state,
        'info',
        isFirst
          ? '반복 #1 — 전체 검토 후 지적사항 대장 작성 중...'
          : `반복 #${n} — 열린 항목 ${openFindings.length}건 해결 + 놓친 부분 탐색 중...`,
      );
      await writeState(state);

      const isFinalPass = forceFinal; // 이번 회차가 마무리 정밀검증인지
      forceFinal = false; // 트리거 소비(한 회차만 적용)
      const promptCtx = {
        input,
        currentArtifact,
        iteration: n,
        isFirst,
        openFindings,
        focus: state.focus,
        rubric: config.rubric,
        refsDigest: state.refsDigest,
        emitChanges: config.emitChanges,
        finalThorough: isFinalPass,
        // R2: 후반 패스는 신규 지적 수를 제한(열린 항목 해결 우선). 1회차(새 대장)·마무리는 제한 없음.
        maxNewFindings: isFirst || isFinalPass ? undefined : config.laterPassMaxNew,
        lang,
        // E3: 직전 회차에 본문에서 못 찾아 적용 실패한 find 들 → 정확히 재인용하도록 경고.
        failedFinds: !isFirst ? lastUnmatchedFinds : [],
      };
      const usePanel = config.reviewMode === 'panel';
      // 대용량 1회차는 분할(map-reduce) 검토로 컨텍스트 초과·본문 누락을 방지(panel·이어하기는 제외).
      const useChunkedFirst = isFirst && !usePanel && input.artifact.length > LARGE_FIRST_CHARS;
      const allLenses = config.lenses && config.lenses.length ? config.lenses : DEFAULT_LENSES;
      // 후속 패스 깊이(품질↔토큰 노브): 1회차(새 대장)/마무리는 전체 렌즈+검증, 그 외는 설정값.
      const laterLenses = Math.max(1, config.laterPassLenses ?? 1);
      const fullDepth = isFirst || isFinalPass;
      const passLenses = fullDepth ? allLenses : allLenses.slice(0, laterLenses);
      const passVerify = fullDepth ? config.verifyFindings !== false : config.laterPassVerify === true;
      const prompt = usePanel ? '' : buildPrompt(promptCtx);

      // 이번 회차 모델: 평소엔 사다리 현재 단계. 마무리 패스면 가장 강한 모델로 정밀검증.
      const iterModel = isFinalPass
        ? isApi
          ? config.model
          : config.finalPassModel || route.ladder[route.ladder.length - 1] || 'opus'
        : route.ladder[tier];
      tierAttempts++; // 이 모델 단계에서의 시도 횟수
      // 이번 호출에 허용할 비용: 회차당 상한과 "총비용 상한의 잔여분" 중 작은 값(잔여분으로 단일 호출 초과도 차단)
      const callBudget = perCallBudget(config, state.totalCostUsd);
      // 한 패스 실행: panel 모드면 다각도 리뷰+검증, 대용량 1회차면 분할 검토, 아니면 단일 호출.
      const doPass = () =>
        usePanel
          ? runPanel({
              ctx: promptCtx,
              iteration: n,
              cwd: runDir(state.id),
              runId: state.id,
              lenses: passLenses,
              verify: passVerify,
              // P2: 렌즈·검증은 "빠른 스카우트"(Claude 는 haiku). nemotron 은 추론 OFF 경량 패스로 →
              // 회차 시간 대폭↓. 깊은 작업은 에디터(editorModel, 추론 ON)가 담당.
              lensModel: isApi ? (config.provider === 'nemotron' ? 'nemotron:fast' : config.model) : 'haiku',
              editorModel: iterModel,
              provider: config.provider,
              maxCostUsd: callBudget,
            })
          : useChunkedFirst
            ? runChunkedFirstPass({
                input,
                cwd: runDir(state.id),
                model: iterModel,
                provider: config.provider,
                runId: state.id,
                maxCostUsd: callBudget,
                focus: state.focus,
                rubric: config.rubric,
                refsDigest: state.refsDigest,
              })
            : agentHooks.runAgent({ prompt, iteration: n, cwd: runDir(state.id), model: iterModel, provider: config.provider, runId: state.id, maxCostUsd: callBudget });

      if (usePanel) {
        addLog(
          state,
          'info',
          `다각도 리뷰(${passLenses.join('·')})${passVerify ? ' + 검증' : ''}${n > 1 ? ' · 경량 패스' : ''} 진행 중...`,
        );
      } else if (useChunkedFirst) {
        addLog(state, 'info', `대용량 입력(${input.artifact.length}자) — 분할 검토로 1회차 진행 중...`);
      }
      if (isFinalPass) {
        addLog(state, 'info', `🔎 마무리 정밀검증 패스(모델 ${iterModel}) — 전체를 한 번 더 점검합니다...`);
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
        // ── 비용 상한(--max-budget-usd)으로 호출이 거부된 경우 → 크래시(error)가 아니라 graceful 종료. ──
        // (재시도해도 같은 예산으로 또 실패하므로 베스트를 보존하고 stopped_cost 로 마감)
        if (isBudgetError(e)) {
          await setStatus(
            state,
            'stopped_cost',
            `비용 상한으로 호출 중단 → 종료. 베스트 ${state.bestScore} (반복 #${state.bestIteration})`,
          );
          addLog(state, 'warn', state.message!);
          break;
        }
        // ── Claude 사용/세션 한도(일시적) → 재시도해도 같은 한도라 무의미. graceful 종료(베스트 보존). ──
        if (isRateLimitError(e)) {
          state.resumeAt = computeResumeAt(e);
          await setStatus(
            state,
            'stopped_ratelimit',
            `Claude 사용 한도 도달${rateLimitHint(e)} → 종료(베스트 보존)${config.autoResume ? ' · 리셋 후 자동 이어하기 예약됨' : '. 한도 리셋 후 다시 실행하세요'}. 베스트 ${state.bestScore} (반복 #${state.bestIteration})`,
          );
          addLog(state, 'warn', state.message!);
          break;
        }
        addLog(state, 'error', `반복 #${n} 실패: ${e?.message ?? e}`);
        // 일시적 실패는 1회 재시도
        if (n === state.currentIteration + 1) {
          addLog(state, 'warn', `재시도 #${n}...`);
          try {
            result = await doPass();
          } catch (e2: any) {
            // 재시도가 사용자 중단/예산 오류면 error 가 아니라 graceful 종료로 마감.
            if (getDesired(state.id) === 'stop') {
              state.control = 'stopped';
              await setStatus(state, 'stopped_user', '사용자가 런을 중단했습니다.');
              break;
            }
            if (isBudgetError(e2)) {
              await setStatus(
                state,
                'stopped_cost',
                `비용 상한으로 호출 중단 → 종료. 베스트 ${state.bestScore} (반복 #${state.bestIteration})`,
              );
              addLog(state, 'warn', state.message!);
              break;
            }
            if (isRateLimitError(e2)) {
              state.resumeAt = computeResumeAt(e2);
              await setStatus(
                state,
                'stopped_ratelimit',
                `Claude 사용 한도 도달${rateLimitHint(e2)} → 종료(베스트 보존)${config.autoResume ? ' · 리셋 후 자동 이어하기 예약됨' : '. 한도 리셋 후 다시 실행하세요'}. 베스트 ${state.bestScore} (반복 #${state.bestIteration})`,
              );
              addLog(state, 'warn', state.message!);
              break;
            }
            await setStatus(state, 'error', `반복 #${n} 재시도 실패: ${e2?.message ?? e2}`);
            return state;
          }
        } else {
          await setStatus(state, 'error', String(e?.message ?? e));
          return state;
        }
      }

      // ── ① 부분 수정(edits) 적용: 점진 회차(1회차 새 대장 제외)는 전체본 대신 패치를 현재본에 적용 ──
      let appliedEdits: EditOp[] = []; // V4: 변경 내역(emitChanges)용 — 실제 적용된 편집
      if (!isFirst) {
        const edits = result.edits ?? [];
        if (edits.length) {
          const ap = applyEdits(currentArtifact, edits);
          result.improvedArtifact = ap.text;
          appliedEdits = ap.appliedOps;
          lastUnmatchedFinds = ap.unmatched; // E3: 다음 회차에 "정확히 재인용하라"로 피드백
          addLog(
            state,
            ap.failed || ap.ambiguous ? 'warn' : 'info',
            `부분 수정 ${ap.applied}건 적용` +
              (ap.ambiguous ? ` · ${ap.ambiguous}건 모호(다중 일치) 건너뜀` : '') +
              (ap.failed ? ` · ${ap.failed}건 미적용(find 불일치)` : ''),
          );
        } else if (result.improvedArtifact && result.improvedArtifact.trim()) {
          lastUnmatchedFinds = [];
          addLog(state, 'warn', 'edits 없이 전체본을 반환 → 그대로 사용(폴백)');
        } else {
          result.improvedArtifact = currentArtifact; // 변경 없음
          lastUnmatchedFinds = [];
          addLog(state, 'warn', '이번 회차 변경 없음(edits 비어 있음)');
        }
      }

      // ── 독립 채점기: 자가 점수 대신 별도 모델이 "최종 개선본"을 채점(점수 인플레/오정지 방지) ──
      // 매우 큰 산출물은 채점 호출의 컨텍스트 초과 위험이 있어 자가 점수를 유지한다.
      // E5: 조건부 채점 — 자가 점수(보통 과대평가)가 이미 베스트 채택선(ACCEPT_EPS) 아래면 어차피 폐기될
      //     회차이므로 채점 호출을 생략해 비용·지연을 아낀다. 마무리 패스/1회차(베스트 없음)는 항상 채점.
      const selfScore = result.score;
      const wouldDiscardBySelf =
        state.bestScore != null && !isFinalPass && selfScore < state.bestScore - ACCEPT_EPS;
      const canJudge =
        config.useJudge !== false &&
        result.improvedArtifact.length <= LARGE_FIRST_CHARS &&
        !wouldDiscardBySelf;
      if (wouldDiscardBySelf && config.useJudge !== false) {
        addLog(
          state,
          'info',
          `자가 점수 ${selfScore} < 베스트 ${state.bestScore} → 폐기 예상, 독립 채점 생략(비용 절약)`,
        );
      }
      // U3: panel 이 아닌 경로(단일/분할)는 stages 가 없으니 '개선' 단일 단계로 보정.
      if (!result.stages || !result.stages.length) {
        result.stages = [{ name: '개선', ms: result.durationMs }];
      }
      if (canJudge) {
        const judgeModel = isApi ? config.model : config.judgeModel || 'sonnet';
        const judgeBudget = perCallBudget(config, state.totalCostUsd + (result.costUsd ?? 0));
        const judgeStart = Date.now();
        try {
          const j = await agentHooks.runJudge({
            input,
            artifact: result.improvedArtifact,
            rubric: config.rubric,
            focus: state.focus,
            refsDigest: state.refsDigest,
            cwd: runDir(state.id),
            model: judgeModel,
            provider: config.provider,
            runId: state.id,
            maxCostUsd: judgeBudget,
            anchorScore: state.bestScore ?? undefined, // E1: 직전 베스트를 보정 앵커로(아직 갱신 전)
          });
          if (j) {
            if (Object.keys(j.dimensions).length) result.dimensions = j.dimensions;
            result.score = j.score;
            if (j.rationale) result.rationale = j.rationale;
            result.costUsd = (result.costUsd ?? 0) + (j.costUsd ?? 0);
            result.tokens = addUsage(result.tokens, j.tokens);
            addLog(state, 'info', `독립 채점(${judgeModel}): ${result.score}점`);
          } else {
            addLog(state, 'warn', '독립 채점 파싱 실패 → 자가 점수 사용');
          }
        } catch (e: any) {
          addLog(state, 'warn', `독립 채점 실패(자가 점수 사용): ${e?.message ?? e}`);
        }
        result.stages.push({ name: '채점', ms: Date.now() - judgeStart }); // U3
      }

      // ── 맞춤 평가기준이 있으면 종합 점수를 차원 가중평균으로 재계산(채점기/자가 점수 무엇이든 일관) ──
      if (config.rubric) {
        const ws = weightedScore(config.rubric, result.dimensions);
        if (ws != null) result.score = ws;
      }

      // 채택 판정: 베스트 이상이면 채택. 입력은 항상 "베스트"에서 이어받으므로,
      // 비채택(점수 하락) 회차는 대장 변경을 커밋하지 않고 통째로 폐기한다(베스트와 정합 유지).
      const prevBest = state.bestScore;
      // E1: 정확히 '>=' 가 아니라 노이즈 폭(ACCEPT_EPS)만큼의 히스테리시스를 둔다.
      // 채점기 점수가 베스트보다 미세하게 낮아도(분산) 해결된 항목 진척을 버리지 않는다.
      let kept = prevBest == null || result.score >= prevBest - ACCEPT_EPS;

      // ── 회귀 가드(콘텐츠 보존): 개선본이 직전 베스트 대비 과도하게 짧아지면 본문 누락을 의심해 폐기. ──
      // (모델이 문서/코드를 통째로 빼먹는 흔한 회귀를 점수와 무관하게 차단. 간결성 개선과 구분하려고 보수적 임계 사용)
      if (kept && prevBest != null && currentArtifact.length > 400) {
        const ratio = result.improvedArtifact.length / currentArtifact.length;
        if (ratio < SHRINK_VETO_RATIO) {
          kept = false;
          addLog(
            state,
            'warn',
            `개선본이 베스트 대비 과도하게 축소(${result.improvedArtifact.length}/${currentArtifact.length}자, ${Math.round(ratio * 100)}%) → 콘텐츠 손실 의심으로 폐기`,
          );
        }
      }

      // ── 해결 정합성 가드: 본문이 실제로 바뀌지 않았으면 어떤 항목도 "해결"로 인정하지 않는다. ──
      // 에이전트가 resolved 를 주장해도 edits 가 적용되지 않았으면(또는 변경이 없으면) 가짜 해결이다.
      const changedThisIter = isFirst ? true : result.improvedArtifact !== currentArtifact;
      // R1: edit→지적 매핑(findingId/findingIds)을 수집. 해결은 "실제로 그 항목을 건드린 edit"이 있어야 인정.
      const appliedFindingIds = new Set<number>();
      for (const e of appliedEdits) {
        if (typeof e.findingId === 'number') appliedFindingIds.add(e.findingId);
        if (e.findingIds) for (const id of e.findingIds) appliedFindingIds.add(id);
      }

      // ── 채택된 회차만 지적사항 대장 갱신(해결 처리 + 놓쳤던 새 항목 추가) ──
      const { resolved, added, rejected, droppedNew } = kept
        ? applyLedger(state, result, n, {
            changed: changedThisIter,
            requireMapping: !isFirst, // R1: 점진 회차는 edit 으로 뒷받침된 해결만 인정(이어하기 1회차 포함)
            appliedFindingIds,
            appliedCount: appliedEdits.length,
            maxNew: isFirst || isFinalPass ? undefined : config.laterPassMaxNew, // R2
          })
        : { resolved: 0, added: 0, rejected: 0, droppedNew: 0 };
      if (kept && rejected) {
        addLog(state, 'warn', `해결 주장 ${rejected}건은 대응 수정(edit)이 없어 보류(열린 상태 유지)`);
      }
      if (kept && droppedNew) {
        addLog(state, 'info', `신규 지적 ${droppedNew}건은 후반 상한(${config.laterPassMaxNew})으로 보류 — 열린 항목 해결 우선`);
      }

      // ── V4: 변경 내역 누적(채택된 회차의 실제 적용 편집만) ──
      if (kept && config.emitChanges && appliedEdits.length) {
        if (!state.changeLog) state.changeLog = [];
        for (const e of appliedEdits) {
          state.changeLog.push({ iter: n, find: e.find, replace: e.replace, reason: e.reason, findingId: e.findingId ?? e.findingIds?.[0] });
        }
      }

      await saveIteration(state, result, kept);
      addSessionCost(result.costUsd); // 세션 전역 비용 누적
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
        // ── 마무리 정밀검증 패스: 완료 선언 전에 강한 모델로 전체를 한 번 더(최대 1회). ──
        // 회차·예산 여유가 있고 이번 회차가 마무리 패스가 아니었을 때만 한 번 끼워 넣는다.
        const budgetOkForFinal = (() => {
          const rb = perCallBudget(config, state.totalCostUsd);
          return rb == null || rb >= MIN_CALL_BUDGET_USD * 3;
        })();
        if (config.finalPass !== false && !finalPassDone && !isFinalPass && n < config.maxIterations && budgetOkForFinal) {
          finalPassDone = true;
          forceFinal = true;
          state.recurMutedUntil = state.currentIteration + config.recurWindow; // 마무리 직후 즉시 정체정지 방지
          addLog(state, 'info', '완료 조건 충족 — 마무리 정밀검증 패스를 1회 실행한 뒤 마칩니다.');
          continue;
        }
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
      const ladderLeft = route.auto && tier < route.ladder.length - 1; // 더 강한 모델이 남았는가
      // R3: 승급 예산 인지 — 더 강한 모델 1콜 추정비용을 잔여 예산이 감당 못 하면 승급하지 않는다(예산 벽 자멸 방지).
      const remForEscalate = perCallBudget(config, state.totalCostUsd);
      const estEscalatedCost = ladderLeft ? estimateModelCost(state, route.ladder[tier], route.ladder[tier + 1]) : null;
      const affordEscalate = remForEscalate == null || estEscalatedCost == null || remForEscalate >= estEscalatedCost;
      const canEscalate = ladderLeft && affordEscalate;
      if (ladderLeft && !affordEscalate && (recurring.length || plateau || tierExhausted)) {
        addLog(
          state,
          'warn',
          `모델 승급 보류 — 잔여 예산(약 $${remForEscalate?.toFixed(4)})이 ${route.ladder[tier + 1]} 1콜 추정비($${estEscalatedCost?.toFixed(4)})보다 적음`,
        );
      }

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
  } finally {
    releaseSlot(); // 다음 대기 런에게 슬롯 양보
    void notifyWebhook(state, config); // #10: 종료 요약 알림(fire-and-forget)
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
// R1 해결 정합성:
//  - changed 가 false 면 해결 불가(수정 없이 고쳤다는 주장 무시).
//  - requireMapping(2회차+)이면 "그 항목을 건드린 edit"이 있어야 해결 인정.
//    · findingIds 태그가 있으면 그 항목만 인정, · 태그가 전혀 없으면 적용된 edit 수만큼만 인정(말로만 다수 해결 방지).
// R2: maxNew 가 있으면 신규 지적을 중요도순 maxNew 개까지만 추가(열린 항목 해결 우선).
export function applyLedger(
  state: RunState,
  result: IterationResult,
  n: number,
  guard: {
    changed: boolean;
    requireMapping: boolean;
    appliedFindingIds: Set<number>;
    appliedCount: number;
    maxNew?: number;
  },
): { resolved: number; added: number; rejected: number; droppedNew: number } {
  let resolved = 0;
  let rejected = 0;
  // 태그가 전혀 없을 때 인정할 해결 개수 예산(적용된 edit 수). 태그가 있으면 무제한(멤버십으로 판정).
  let untaggedBudget = guard.appliedFindingIds.size ? Number.POSITIVE_INFINITY : guard.appliedCount;
  const openById = new Map(state.findings.filter((f) => f.status === 'open').map((f) => [f.id, f]));
  for (const id of result.resolvedIds) {
    const f = openById.get(id);
    if (!f) continue;
    if (!guard.changed) {
      rejected++;
      continue;
    }
    if (guard.requireMapping) {
      if (guard.appliedFindingIds.size) {
        if (!guard.appliedFindingIds.has(id)) {
          rejected++;
          continue;
        }
      } else if (untaggedBudget <= 0) {
        rejected++;
        continue;
      } else {
        untaggedBudget--;
      }
    }
    f.status = 'resolved';
    f.resolvedIter = n;
    resolved++;
  }

  // 신규 지적 후보 수집(기존 + 후보 간 근접 중복 제거).
  const knownTitles = state.findings.map((f) => f.title);
  const fresh: NewFinding[] = [];
  for (const nf of result.newFindings) {
    const title = (nf.title ?? '').trim();
    if (!title) continue;
    if (findSimilarIndex(title, knownTitles) >= 0) continue;
    if (findSimilarIndex(title, fresh.map((x) => x.title)) >= 0) continue;
    fresh.push({ title, severity: nf.severity });
  }

  // R2: 후반 상한 — 중요도(high>medium>low) 우선으로 maxNew 개만 채택.
  let accepted = fresh;
  let droppedNew = 0;
  if (guard.maxNew != null && fresh.length > guard.maxNew) {
    const rank = (s?: string) => (s === 'high' ? 0 : s === 'low' ? 2 : 1);
    accepted = [...fresh].sort((a, b) => rank(a.severity) - rank(b.severity)).slice(0, guard.maxNew);
    droppedNew = fresh.length - accepted.length;
  }

  let nextId = state.findings.reduce((m, f) => Math.max(m, f.id), 0) + 1;
  let added = 0;
  for (const nf of accepted) {
    const f: Finding = { id: nextId++, title: nf.title.trim(), severity: nf.severity, status: 'open', foundIter: n };
    state.findings.push(f);
    added++;
  }
  return { resolved, added, rejected, droppedNew };
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
// 매칭 단계(점점 관대):
//  1) 정확 일치  2) 정규화 일치(공백·스마트따옴표·대시·NBSP 등 표기차 흡수)
// 어느 단계든 "유일하게" 매칭될 때만 적용한다(2회 이상이면 ambiguous 로 건너뜀 — 오적용 방지).
export function applyEdits(
  base: string,
  edits: EditOp[],
): { text: string; applied: number; failed: number; ambiguous: number; appliedOps: EditOp[]; unmatched: string[] } {
  let text = base;
  let applied = 0;
  let failed = 0;
  let ambiguous = 0;
  const appliedOps: EditOp[] = [];
  // E3: 적용되지 못한(불일치/모호) find 들을 모아 다음 회차 프롬프트에 피드백한다.
  const unmatched: string[] = [];
  const noteUnmatched = (find: string) => {
    if (find && unmatched.length < 12) unmatched.push(find.slice(0, 200));
  };
  for (const e of edits) {
    if (!e.find) {
      failed++;
      continue;
    }
    // 1) 정확 일치 + 고유성
    const first = text.indexOf(e.find);
    if (first >= 0) {
      if (text.indexOf(e.find, first + Math.max(1, e.find.length)) >= 0) {
        ambiguous++;
        noteUnmatched(e.find);
        continue;
      }
      text = text.slice(0, first) + e.replace + text.slice(first + e.find.length);
      applied++;
      appliedOps.push(e);
      continue;
    }
    // 2) 정규화 일치(표기차 흡수) — 원문 인덱스로 되돌려 그 구간만 치환
    const r = matchNormalized(text, e.find);
    if (r.status === 'ambiguous') {
      ambiguous++;
      noteUnmatched(e.find);
      continue;
    }
    if (r.status === 'ok') {
      text = text.slice(0, r.start) + e.replace + text.slice(r.end);
      applied++;
      appliedOps.push(e);
      continue;
    }
    failed++;
    noteUnmatched(e.find);
  }
  return { text, applied, failed, ambiguous, appliedOps, unmatched };
}

// 매칭용 정규화: 유니코드 표기차를 ASCII 로 접고 연속 공백을 1칸으로 합친다.
// norm 문자열과 함께 "norm 인덱스 → 원문 인덱스" 맵을 반환해 매칭 후 원문 구간을 정확히 집어낸다.
function normForMatch(s: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < s.length; i++) {
    let c = s[i];
    if (c === ' ' || c === '​') c = ' '; // NBSP / zero-width → space
    else if (c === '‘' || c === '’' || c === 'ʼ') c = "'";
    else if (c === '“' || c === '”') c = '"';
    else if (c === '–' || c === '—' || c === '−') c = '-';
    else if (c === '…') c = '.'; // … → . (길이 변동 최소화: 한 글자로)
    if (/\s/.test(c)) {
      if (prevSpace) continue; // 연속 공백 접기
      norm += ' ';
      map.push(i);
      prevSpace = true;
    } else {
      norm += c;
      map.push(i);
      prevSpace = false;
    }
  }
  return { norm, map };
}

// 정규화 공간에서 find 를 유일하게 찾아 원문 [start,end) 구간으로 환원.
function matchNormalized(text: string, find: string): { status: 'ok' | 'fail' | 'ambiguous'; start: number; end: number } {
  const { norm, map } = normForMatch(text);
  const nf = normForMatch(find).norm.trim();
  if (!nf) return { status: 'fail', start: 0, end: 0 };
  const first = norm.indexOf(nf);
  if (first < 0) return { status: 'fail', start: 0, end: 0 };
  if (norm.indexOf(nf, first + nf.length) >= 0) return { status: 'ambiguous', start: 0, end: 0 };
  const start = map[first];
  const end = map[first + nf.length - 1] + 1; // 마지막 매칭 문자 다음(원문 기준)
  return { status: 'ok', start, end };
}

// R3: 한 모델(from)에서의 직전 회차 비용을 바탕으로, 더 강한 모델(to)로 1콜 시 예상 비용을 추정.
// cli 모델 상대 단가 가중치(haiku=1, sonnet≈3, opus≈5; 가격표 비율 근사). 추정 불가하면 null(=승급 허용).
const MODEL_COST_WEIGHT: Record<string, number> = { haiku: 1, sonnet: 3, opus: 5 };
export function estimateModelCost(state: RunState, fromModel: string, toModel: string): number | null {
  // 가장 최근에 비용이 기록된 회차를 기준으로 삼는다.
  const lastCost = [...state.iterations].reverse().find((i) => typeof i.costUsd === 'number' && i.costUsd! > 0)?.costUsd;
  if (!lastCost) return null;
  const wf = MODEL_COST_WEIGHT[fromModel] ?? 1;
  const wt = MODEL_COST_WEIGHT[toModel] ?? wf;
  return lastCost * (wt / wf) * 1.1; // 10% 안전 마진
}

// #10: 종료 시 웹훅으로 요약 전송(설정 시). 실패는 무시(fire-and-forget).
async function notifyWebhook(state: RunState, config: RunConfig): Promise<void> {
  if (!config.webhookUrl) return;
  const open = state.findings.filter((f) => f.status === 'open').length;
  const text = `auto-dr · ${state.title} — ${state.status} · 베스트 ${state.bestScore ?? '-'} (반복 #${state.bestIteration ?? '-'}) · 비용 $${(state.totalCostUsd || 0).toFixed(4)} · 열린 ${open}건`;
  try {
    await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Slack/Discord 호환: text 필드 + 상세 메타 동봉
      body: JSON.stringify({
        text,
        run: { id: state.id, title: state.title, status: state.status, bestScore: state.bestScore, totalCostUsd: state.totalCostUsd, open, message: state.message },
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* 웹훅 실패는 런 결과에 영향 없음 */
  }
}

// 비용 상한(--max-budget-usd) 때문에 호출이 거부됐는지 판별(메시지 휴리스틱).
export function isBudgetError(e: unknown): boolean {
  const m = String((e as any)?.message ?? e ?? '').toLowerCase();
  return m.includes('max_budget') || m.includes('budget_usd') || m.includes('exceed') && m.includes('budget');
}

// Claude 구독/요청 사용 한도(세션·레이트 리밋)에 걸렸는지 판별. 일시적이라 크래시가 아니라 graceful 종료한다.
export function isRateLimitError(e: unknown): boolean {
  const m = String((e as any)?.message ?? e ?? '').toLowerCase();
  return (
    m.includes('session limit') ||
    m.includes('usage limit') ||
    m.includes('rate limit') ||
    m.includes('too many requests') ||
    m.includes('429')
  );
}

// 한도 메시지에서 "리셋 시각" 안내를 뽑아 덧붙인다(있으면).
function rateLimitHint(e: unknown): string {
  const raw = String((e as any)?.message ?? e ?? '');
  const m = raw.match(/reset[s]?\s+([^\n.]+)/i);
  return m ? ` (리셋: ${m[1].trim()})` : '';
}

// #2: 한도 메시지의 "resets 3:50pm" 같은 시각을 파싱해 자동 이어하기 예정 ISO 를 만든다(+2분 버퍼).
// 파싱 실패 시 보수적으로 5시간 뒤(Claude 세션 창)로 둔다.
export function computeResumeAt(e: unknown, now = new Date()): string {
  const raw = String((e as any)?.message ?? e ?? '');
  const m = raw.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1); // 이미 지난 시각이면 다음날
    return new Date(d.getTime() + 2 * 60_000).toISOString();
  }
  return new Date(now.getTime() + 5 * 3600_000).toISOString();
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
