// 공용 타입 정의

export type InputKind = 'document' | 'url' | 'code';

// V5: 호출 백엔드. cli = claude -p(구독), 나머지는 해당 provider API 직접 호출.
export type ProviderId = 'cli' | 'anthropic' | 'openai' | 'gemini' | 'together' | 'nemotron';

export interface RunInput {
  kind: InputKind;
  source: string; // 원본 경로 또는 URL
  title: string;
  artifact: string; // 개선 대상이 되는 추출 텍스트(원본 내용)
  ext: string; // 개선본 확장자 (md / txt / html / js ...)
  origFormat?: OfficeFormat; // 원본이 오피스 문서면 그 형식 — 개선본을 같은 형식으로 재생성
  references?: ReferenceDoc[]; // V4: 첨부 참고자료(추출본은 runs/<id>/refs/)
  meta?: Record<string, unknown>;
}

// 개선본을 원본과 같은 형식으로 재생성할 때의 대상 형식.
export type OfficeFormat = 'docx' | 'pptx' | 'pdf';

export interface ScoreDimensions {
  [name: string]: number; // 각 0~100
}

export type Severity = 'low' | 'medium' | 'high';

// 토큰 사용 내역(claude -p envelope 의 usage 에서 추출)
export interface TokenUsage {
  input: number; // 새 입력 토큰(전체 단가)
  output: number; // 출력 토큰(입력의 ~5배 단가)
  cacheRead: number; // 캐시 읽기(~0.1배 단가)
  cacheWrite: number; // 캐시 쓰기(~1.25~2배 단가)
}

// ── V4: 맞춤 평가 기준(rubric) ──
export interface RubricDimension {
  name: string; // 점수 차원 이름(=dimensions JSON 키). 예: "명료성"
  weight: number; // 가중치(종합 점수 가중평균). 합이 1이 아니어도 됨(정규화).
  description?: string; // 이 차원을 어떻게 볼지 설명
}
export interface Rubric {
  dimensions: RubricDimension[];
  passThreshold?: number; // 종합 점수가 이 값 이상이면 합격(완료 후보)
  template?: string; // 어떤 템플릿에서 시작했는지(표시용)
}

// ── V4: 참고자료 1건(추출 텍스트로 보관) ──
export interface ReferenceDoc {
  id: string; // refs/<id>.md
  title: string;
  ext: string;
  chars: number;
}

// ── V4: 변경 내역 1건(패스별 누적) ──
export interface ChangeEntry {
  iter: number;
  find: string;
  replace: string;
  reason?: string;
  findingId?: number;
}

// 지적사항 대장(findings ledger)의 한 항목.
// 1회차에서 발견해 누적하고, 이후 회차에서 '열린 항목'을 해결해 나간다.
export interface Finding {
  id: number;
  title: string;
  severity?: Severity;
  status: 'open' | 'resolved';
  foundIter: number; // 처음 발견된 반복
  resolvedIter?: number; // 해결된 반복
}

// 에이전트가 이번 회차에 "새로 발견한"(=이전에 놓친) 항목.
export interface NewFinding {
  title: string;
  severity?: Severity;
}

// 비1회차의 부분 수정(전체본 재출력 대신 바뀌는 부분만 → 출력 토큰 절약).
export interface EditOp {
  find: string; // 현재본에 '정확히(공백·줄바꿈 포함)' 존재하는 변경 대상 텍스트
  replace: string; // 그 자리에 들어갈 새 텍스트(삭제는 빈 문자열)
  reason?: string; // V4: 이 수정을 왜 했는지(변경 추적 산출물용)
  findingId?: number; // V4: 이 수정이 해결하는 지적 #번호(단일 — 하위호환)
  findingIds?: number[]; // R1: 한 edit 이 여러 지적을 해결할 때 그 #번호들
}

export interface IterationResult {
  iteration: number;
  score: number; // 종합 0~100
  dimensions: ScoreDimensions;
  rationale: string; // 점수 근거
  reviewMarkdown: string; // 이번 회차 작업 노트(마크다운)
  improvedArtifact: string; // 개선본 전체(1회차) 또는 edits 적용 후 결과
  edits?: EditOp[]; // 비1회차: 전체본 대신 부분 수정 목록(토큰 절약)
  resolvedIds: number[]; // 이번 회차에 해결한 '열린 항목'의 id
  newFindings: NewFinding[]; // 이번 회차에 새로 발견(놓쳤던)한 항목
  done: boolean; // 에이전트가 더 개선할 것이 없다고 판단
  durationMs: number;
  createdAt: string;
  costUsd?: number;
  model?: string; // 실제로 사용된 모델(envelope 실측)
  tokens?: TokenUsage; // 이 회차 토큰 사용 내역
  stages?: StageTime[]; // U3: 회차 내 단계별 소요(리뷰/검증/개선/채점). 간트 시각화용
  raw?: string; // claude 원본 응답(디버그용)
}

// U3: 한 회차 안의 단계별 소요 시간(ms). panel 은 렌즈/검증/개선, 단일은 개선, 공통으로 채점.
export interface StageTime {
  name: string; // 리뷰 · 검증 · 개선 · 채점
  ms: number;
}

export type RunStatus =
  | 'pending'
  | 'running'
  | 'paused' // 일시정지(수동 또는 동일문제 반복 자동정지) — 토큰 미사용
  | 'stopped_user' // 사용자가 중단
  | 'stopped_declined' // 점수 하락으로 중단
  | 'stopped_plateau' // 정체로 중단
  | 'stopped_done' // 에이전트가 완료 선언
  | 'stopped_cap' // 안전 상한 도달(반복 횟수)
  | 'stopped_cost' // 런 총비용 상한 도달
  | 'stopped_ratelimit' // Claude 사용/세션 한도 도달(일시적 — 리셋 후 재시도 가능)
  | 'error'
  | 'completed';

// 사용자에게 강조해서 보여줄 알림(예: 동일 문제 반복으로 인한 자동 일시정지)
export interface RunAlert {
  type: 'recurring' | 'info';
  title: string;
  message: string;
  issues: string[]; // 강조할 반복 문제 목록
  ts: string;
}

export interface IterationSummary {
  iteration: number;
  score: number;
  kept: boolean; // 베스트로 채택되었는지
  createdAt: string;
  durationMs: number;
  rationale: string;
  remainingIssues: string[];
  dimensions: ScoreDimensions;
  costUsd?: number;
  model?: string; // 이 반복에서 실제 사용된 모델
  tokens?: TokenUsage; // 이 반복 토큰 사용 내역
  stages?: StageTime[]; // U3: 단계별 소요(간트 시각화용)
}

export interface RunConfig {
  patience: number; // 비개선이 연속 몇 회면 중단할지
  minDelta: number; // 개선으로 인정할 최소 점수 증가폭
  maxIterations: number; // 안전 상한 (폭주 방지)
  recurWindow: number; // 동일 문제가 최근 몇 회 연속 등장하면 자동 일시정지할지
  provider?: ProviderId; // V5: 호출 백엔드(기본 cli=claude -p). API provider면 model 은 그 provider의 모델 id
  model?: string; // claude 모델. 'auto'(기본)=자동 라우팅, 또는 haiku/sonnet/opus 고정. API provider면 그 모델 id
  maxCostPerIterUsd?: number; // 회차당 비용 상한($). 설정 시 claude --max-budget-usd 로 전달
  maxTotalCostUsd?: number; // 런 전체 누적 비용 상한($). 초과 시 다음 호출 전에 종료(stopped_cost)
  maxAttemptsPerModel?: number; // 자동 라우팅에서 한 모델로 시도할 최대 회차. 소진 시 다음 단계로 승급
  useJudge?: boolean; // 독립 채점기 사용(개선 모델과 분리된 모델이 점수를 매김). 기본 true
  judgeModel?: string; // 채점기 모델(cli 경로). 미지정 시 기본값. API provider면 그 provider 모델 사용
  laterPassLenses?: number; // panel: 2회차 이후 사용할 렌즈 수(품질↔토큰 노브). 기본 1
  laterPassVerify?: boolean; // panel: 2회차 이후에도 검증 패스를 돌릴지. 기본 false
  laterPassMaxNew?: number; // R2: 2회차 이후 회차당 새로 받을 지적 최대 수(열린 항목 해결 우선). 기본 3
  finalPass?: boolean; // 완료 직전 강한 모델로 전체를 한 번 정밀검증/마무리. 기본 true
  finalPassModel?: string; // 마무리 패스 모델(cli). 미지정 시 사다리 최상위(보통 opus)
  webhookUrl?: string; // #10: 종료 시 요약을 POST 할 웹훅 URL(Slack incoming webhook 등). 기본 env AUTODR_WEBHOOK_URL
  autoResume?: boolean; // #2: 세션 한도로 멈추면 리셋 시각에 자동 이어하기. 기본 false
  // ── V4 (전부 optional, 미설정 시 기존 동작) ──
  reviewMode?: 'single' | 'panel'; // panel: 다각도 병렬 리뷰 + 검증
  lenses?: string[]; // panel 렌즈 목록(미설정 시 기본 렌즈)
  verifyFindings?: boolean; // panel: 지적 진위 검증 패스
  rubric?: Rubric; // 맞춤 평가기준
  emitChanges?: boolean; // 변경 추적 산출물 생성
}

export interface RunState {
  id: string;
  title: string;
  input: { kind: InputKind; source: string; ext: string; origFormat?: OfficeFormat };
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  currentIteration: number;
  bestIteration: number | null;
  bestScore: number | null;
  scores: { iteration: number; score: number; kept: boolean }[];
  iterations: IterationSummary[];
  findings: Finding[]; // 지적사항 대장(누적). 1회차에 채우고 이후 회차에서 해결.
  config: RunConfig;
  focus?: string; // 리뷰 초점(사용자가 대시보드에서 선택)
  message?: string; // 상태 사유 / 에러 메시지
  alert?: RunAlert | null; // 강조 알림(동일 문제 반복 자동정지 등)
  control?: 'run' | 'paused' | 'stopped'; // 러너가 적용 중인 제어 상태
  actualModel?: string; // 최근 반복에서 실제로 사용된 모델(실측)
  recurMutedUntil?: number; // 이 반복 번호까지는 반복감지 자동정지 보류
  totalCostUsd: number;
  totalTokens?: TokenUsage; // 런 누적 토큰(회차 + 참고자료 요약 등 모든 호출)
  // ── V4 ──
  refsDigest?: string; // 참고자료 압축 요약(1회 생성, 매 패스 주입)
  changeLog?: ChangeEntry[]; // 누적 변경 내역(emitChanges)
  compare?: { groupId: string; variant: 'A' | 'B'; label?: string; peerId?: string }; // A/B 비교
  parentId?: string; // 이어하기(resume)로 만들어진 런이면 원본 런 id
  officeInPlace?: boolean; // 오피스 개선본을 원본 양식 제자리 수정으로 만들었는지(true면 정리본도 별도 존재)
  resumeAt?: string; // #2: 세션 한도로 멈춘 경우, 자동 이어하기 예정 시각(ISO). UI 카운트다운에도 사용
  autoResumedAt?: string; // #2: 자동 이어하기가 트리거된 시각(중복 트리거 방지)
  log: LogEntry[];
}

export interface LogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}
