import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 프로젝트 루트 (src 의 상위)
export const PROJECT_ROOT = path.resolve(__dirname, '..');

// 모든 산출물은 로컬 runs/ 아래에 저장 (테스트는 AUTODR_RUNS_DIR 로 격리)
export const RUNS_DIR = process.env.AUTODR_RUNS_DIR || path.join(PROJECT_ROOT, 'runs');

export const DASHBOARD_PORT = 4517;

// 대시보드 바인딩 호스트. 기본은 로컬 전용(127.0.0.1) — API 키 입력·임의 경로 실행이
// 같은 네트워크에 노출되지 않도록 한다. LAN 공개가 필요하면 AUTODR_HOST=0.0.0.0 로 오버라이드.
export const DASHBOARD_HOST = process.env.AUTODR_HOST || '127.0.0.1';

export const DEFAULT_CONFIG: RunConfig = {
  patience: 2, // 베스트 대비 비개선 2회 연속이면 중단
  minDelta: 0.5, // 0.5점 미만 상승은 "정체"로 간주
  maxIterations: 8, // 안전 백스톱. 보통 완료/정체/비용상한이 먼저 걸지만, 수렴 전에 끊기지 않도록 여유를 둠
  recurWindow: 3, // 동일 문제가 최근 3회 연속 등장하면 자동 일시정지
  model: 'auto', // 기본: 자동 라우팅(분량·종류로 모델 선택 + 정체 시 자동 승급). 대시보드에서 특정 모델로 고정 가능
  maxCostPerIterUsd: undefined, // 회차당 비용 상한(선택). 설정 시 호출이 그 금액에서 중단
  maxTotalCostUsd: 2.0, // 런 총비용 상한($2 — 합격선까지 수렴할 여유. 폭주 차단용 백스톱). 대시보드에서 변경/해제 가능
  maxAttemptsPerModel: 2, // 자동 라우팅: 한 모델에서 2회까지 시도 후에도 끝나지 않으면 다음 단계로 승급(총 회차 예측 가능)
  useJudge: true, // 독립 채점기: 개선한 모델이 아닌 별도 모델이 점수를 매겨 점수 인플레/오정지 방지
  judgeModel: 'sonnet', // 채점기 모델(cli). API provider면 그 provider 모델을 사용
  laterPassLenses: 1, // panel: 2회차 이후 렌즈 수(기본 1=토큰 절약). 올리면 후반 품질↑·토큰↑
  laterPassVerify: false, // panel: 2회차 이후 검증 패스 생략(기본). true면 후반에도 진위 검증
  laterPassMaxNew: 3, // R2: 2회차 이후 회차당 새 지적 최대 3개(열린 항목 해결 우선, 대장 폭증 방지)
  finalPass: true, // 완료 직전 강한 모델로 전체 정밀검증/마무리 1회
  webhookUrl: process.env.AUTODR_WEBHOOK_URL || undefined, // #10: 종료 알림 웹훅
  autoResume: false, // #2: 세션 한도 자동 이어하기(기본 끔 — 무인 과금 방지)
};
