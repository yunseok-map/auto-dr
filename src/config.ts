import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 프로젝트 루트 (src 의 상위)
export const PROJECT_ROOT = path.resolve(__dirname, '..');

// 모든 산출물은 로컬 runs/ 아래에 저장
export const RUNS_DIR = path.join(PROJECT_ROOT, 'runs');

export const DASHBOARD_PORT = 4517;

export const DEFAULT_CONFIG: RunConfig = {
  patience: 2, // 베스트 대비 비개선 2회 연속이면 중단
  minDelta: 0.5, // 0.5점 미만 상승은 "정체"로 간주
  maxIterations: 5, // 토큰 절약용 백스톱(회차당 ~23K 오버헤드가 매번 실리므로 평균 회차를 낮게). 실제 종료는 보통 완료/정체/비용상한이 먼저 건다
  recurWindow: 3, // 동일 문제가 최근 3회 연속 등장하면 자동 일시정지
  model: 'auto', // 기본: 자동 라우팅(분량·종류로 모델 선택 + 정체 시 자동 승급). 대시보드에서 특정 모델로 고정 가능
  maxCostPerIterUsd: undefined, // 회차당 비용 상한(선택). 설정 시 호출이 그 금액에서 중단
  maxTotalCostUsd: 0.5, // 런 총비용 상한(기본 $0.50 — 폭주 차단용 백스톱). 대시보드에서 변경/해제 가능
  maxAttemptsPerModel: 2, // 자동 라우팅: 한 모델에서 2회까지 시도 후에도 끝나지 않으면 다음 단계로 승급(총 회차 예측 가능)
};
