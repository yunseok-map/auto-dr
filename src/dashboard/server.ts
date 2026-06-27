import express from 'express';
import multer from 'multer';
import chokidar from 'chokidar';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_PORT, PROJECT_ROOT, RUNS_DIR } from '../config.js';
import { getRun, listRuns, runDir } from '../orchestrator/state.js';
import { resolveInput, extractFileText } from '../input/adapters.js';
import { startRun } from '../orchestrator/runner.js';
import { signal } from '../orchestrator/controls.js';
import { normalizeRubric } from '../orchestrator/rubrics.js';
import { keyStatus, setKeys } from '../orchestrator/providers.js';
import type { InputKind } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(PROJECT_ROOT, 'data', 'uploads');

export interface DashboardHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startDashboard(port = DASHBOARD_PORT): Promise<DashboardHandle> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(RUNS_DIR, { recursive: true });

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(PUBLIC_DIR));

  // 업로드 파일은 원래 이름 유지(확장자 보존)
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
      filename: (_req, file, cb) => {
        const ts = Date.now();
        const safe = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[^\w.가-힣-]+/g, '_');
        cb(null, `${ts}-${safe}`);
      },
    }),
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  // 진행 중인 런 추적(중복/상태 표시용)
  const active = new Set<string>();

  // ---- 새 리뷰 시작 (파일 업로드 또는 URL/경로) ----
  app.post('/api/runs', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'refs', maxCount: 5 }]), async (req, res) => {
    try {
      const body = req.body ?? {};
      const filesMap = (req.files as Record<string, Express.Multer.File[]>) || {};
      const file = filesMap.file?.[0];
      const refFiles = filesMap.refs ?? [];
      const kind = (body.kind && body.kind !== 'auto' ? body.kind : undefined) as InputKind | undefined;
      const focus: string | undefined = body.focus || undefined;
      // V5: provider 선택(cli=기존). API provider면 모델은 providerModel 사용.
      const provider = (['anthropic', 'openai', 'gemini'].includes(body.provider) ? body.provider : undefined) as
        | 'anthropic'
        | 'openai'
        | 'gemini'
        | undefined;

      // ── V4: 참고자료 추출(있으면) ──
      let references: { title: string; ext: string; text: string }[] | undefined;
      if (refFiles.length) {
        references = [];
        for (const rf of refFiles) {
          try {
            const text = await extractFileText(rf.path);
            if (!text.trim()) continue;
            const title = Buffer.from(rf.originalname, 'latin1').toString('utf8');
            references.push({ title, ext: path.extname(rf.originalname).replace('.', '') || 'txt', text });
          } catch {
            /* 추출 실패한 참고자료는 건너뜀 */
          }
        }
        if (!references.length) references = undefined;
      }

      const opts = {
        focus,
        patience: numOrUndef(body.patience),
        minDelta: numOrUndef(body.minDelta),
        maxIterations: numOrUndef(body.maxIter),
        recurWindow: numOrUndef(body.recurWindow),
        provider,
        model: provider ? body.providerModel || undefined : body.model || undefined,
        maxCostPerIterUsd: numOrUndef(body.maxCostPerIterUsd),
        maxTotalCostUsd: numOrUndef(body.maxTotalCostUsd),
        maxAttemptsPerModel: numOrUndef(body.maxAttemptsPerModel),
        rubric: parseRubricField(body.rubric),
        reviewMode: body.reviewMode === 'panel' ? ('panel' as const) : undefined,
        verifyFindings: body.verifyFindings === 'false' ? false : undefined,
        emitChanges: body.emitChanges === 'true' ? true : undefined,
        references,
      };

      let source: string;
      if (file) {
        source = file.path;
      } else if (body.source && String(body.source).trim()) {
        source = String(body.source).trim();
      } else {
        return res.status(400).json({ error: '파일 또는 source(URL/경로)가 필요합니다.' });
      }

      const input = await resolveInput(source, kind);
      if (file) {
        // 업로드 파일은 타임스탬프 접두어 대신 원래 이름을 제목으로
        input.title = Buffer.from(file.originalname, 'latin1').toString('utf8');
      }

      // 백그라운드 실행(응답은 즉시) — 대시보드가 SSE로 진행 상황 반영
      res.json({ ok: true, title: input.title, kind: input.kind, refs: references?.length ?? 0 });
      runInBackground(input, opts, active);
    } catch (e: any) {
      if (!res.headersSent) res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // ── V4: A/B 비교 — 같은 입력을 두 설정(A/B)으로 순차 실행(같은 groupId) ──
  app.post('/api/compare', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'refs', maxCount: 5 }]), async (req, res) => {
    try {
      const body = req.body ?? {};
      const filesMap = (req.files as Record<string, Express.Multer.File[]>) || {};
      const file = filesMap.file?.[0];
      const refFiles = filesMap.refs ?? [];
      const kind = (body.kind && body.kind !== 'auto' ? body.kind : undefined) as InputKind | undefined;

      let references: { title: string; ext: string; text: string }[] | undefined;
      if (refFiles.length) {
        references = [];
        for (const rf of refFiles) {
          try {
            const text = await extractFileText(rf.path);
            if (!text.trim()) continue;
            references.push({ title: Buffer.from(rf.originalname, 'latin1').toString('utf8'), ext: path.extname(rf.originalname).replace('.', '') || 'txt', text });
          } catch {
            /* skip */
          }
        }
        if (!references.length) references = undefined;
      }

      const base = {
        patience: numOrUndef(body.patience),
        minDelta: numOrUndef(body.minDelta),
        maxIterations: numOrUndef(body.maxIter),
        recurWindow: numOrUndef(body.recurWindow),
        maxCostPerIterUsd: numOrUndef(body.maxCostPerIterUsd),
        maxTotalCostUsd: numOrUndef(body.maxTotalCostUsd),
        maxAttemptsPerModel: numOrUndef(body.maxAttemptsPerModel),
        rubric: parseRubricField(body.rubric),
        reviewMode: body.reviewMode === 'panel' ? ('panel' as const) : undefined,
        verifyFindings: body.verifyFindings === 'false' ? false : undefined,
        emitChanges: body.emitChanges === 'true' ? true : undefined,
        references,
      };

      let source: string;
      if (file) source = file.path;
      else if (body.source && String(body.source).trim()) source = String(body.source).trim();
      else return res.status(400).json({ error: '파일 또는 source(URL/경로)가 필요합니다.' });

      const input = await resolveInput(source, kind);
      if (file) input.title = Buffer.from(file.originalname, 'latin1').toString('utf8');

      const groupId = 'cmp-' + Date.now();
      res.json({ ok: true, groupId, title: input.title });

      // 순차 실행(비용/부하 관리). 각 변형은 독립 input 복제 사용.
      void (async () => {
        const variants = [
          { v: 'A' as const, focus: body.focusA || undefined, model: body.modelA || undefined, label: body.labelA || 'A' },
          { v: 'B' as const, focus: body.focusB || undefined, model: body.modelB || undefined, label: body.labelB || 'B' },
        ];
        for (const vv of variants) {
          try {
            await startRun({ ...input }, { ...base, focus: vv.focus, model: vv.model, compare: { groupId, variant: vv.v, label: vv.label } });
          } catch (e: any) {
            console.error('A/B 비교 런 오류:', e?.message ?? e);
          }
        }
      })();
    } catch (e: any) {
      if (!res.headersSent) res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  app.get('/api/runs', async (_req, res) => res.json(await listRuns()));

  // ── V5: provider API 키 (어떤 키가 설정됐는지만 노출; 값은 절대 반환 안 함) ──
  app.get('/api/keys', async (_req, res) => res.json(await keyStatus()));
  app.post('/api/keys', async (req, res) => {
    try {
      await setKeys(req.body ?? {});
      res.json(await keyStatus());
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // ---- 런 제어: 일시정지 / 재개 / 중단 ----
  app.post('/api/runs/:id/:action(pause|resume|stop)', async (req, res) => {
    const run = await getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    const action = req.params.action as 'pause' | 'resume' | 'stop';
    if (action === 'pause') signal(run.id, 'pause');
    else if (action === 'resume') signal(run.id, 'run');
    else signal(run.id, 'stop');
    res.json({ ok: true, action, id: run.id });
  });

  app.get('/api/runs/:id', async (req, res) => {
    const run = await getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json(run);
  });

  app.get('/api/runs/:id/input', async (req, res) => {
    await sendFileSafe(res, runDir(req.params.id), 'input.*');
  });

  app.get('/api/runs/:id/best', async (req, res) => {
    // 텍스트 개선본(미리보기용) — 같은 폴더의 .docx/.pptx 바이너리는 제외.
    await sendTextArtifact(res, path.join(runDir(req.params.id), 'best'));
  });

  // 원본 형식으로 재생성된 오피스 개선본(.docx/.pptx) 바이너리 다운로드.
  app.get('/api/runs/:id/best/office', async (req, res) => {
    const bdir = path.join(runDir(req.params.id), 'best');
    try {
      const files = await fs.readdir(bdir);
      const match = files.find((f) => f === 'improved.docx' || f === 'improved.pptx' || f === 'improved.pdf');
      if (!match) return res.status(404).json({ error: 'not found' });
      const run = await getRun(req.params.id);
      const base = run ? run.title.replace(/\.[^.]+$/, '') : 'improved';
      const fname = `${base}_개선본${path.extname(match)}`;
      res.download(path.join(bdir, match), fname);
    } catch {
      res.status(404).json({ error: 'not found' });
    }
  });

  app.get('/api/runs/:id/findings', async (req, res) => {
    await sendFileSafe(res, runDir(req.params.id), 'findings.md');
  });

  // V4: 변경 내역(.md) 텍스트
  app.get('/api/runs/:id/best/changes', async (req, res) => {
    await sendFileSafe(res, path.join(runDir(req.params.id), 'best'), 'changes.md');
  });

  // V4: 변경 내역을 원본 형식(.docx/.pptx/.pdf)으로 다운로드
  app.get('/api/runs/:id/best/changes-office', async (req, res) => {
    const bdir = path.join(runDir(req.params.id), 'best');
    try {
      const files = await fs.readdir(bdir);
      const match = files.find((f) => /^changes\.(docx|pptx|pdf)$/.test(f));
      if (!match) return res.status(404).json({ error: 'not found' });
      const run = await getRun(req.params.id);
      const base = run ? run.title.replace(/\.[^.]+$/, '') : 'changes';
      res.download(path.join(bdir, match), `${base}_변경내역${path.extname(match)}`);
    } catch {
      res.status(404).json({ error: 'not found' });
    }
  });

  app.get('/api/runs/:id/iterations/:n/:file', async (req, res) => {
    const n = String(parseInt(req.params.n, 10)).padStart(3, '0');
    const dir = path.join(runDir(req.params.id), 'iterations', `iter-${n}`);
    const file = req.params.file;
    if (file === 'review') return sendFileSafe(res, dir, 'review.md');
    if (file === 'artifact') return sendFileSafe(res, dir, 'improved.*');
    if (file === 'score') return sendFileSafe(res, dir, 'score.json');
    res.status(404).json({ error: 'unknown file' });
  });

  // ---- SSE: runs 변경 감지 ----
  const sseClients = new Set<() => void>();
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: hello\ndata: {}\n\n');
    const onChange = () => res.write(`event: change\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    sseClients.add(onChange);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(onChange);
    });
  });

  let debounce: NodeJS.Timeout | null = null;
  const watcher = chokidar.watch(RUNS_DIR, { ignoreInitial: true, depth: 4 });
  watcher.on('all', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => sseClients.forEach((fn) => fn()), 300);
  });

  // /api 는 항상 JSON 으로 응답 (미매칭 경로 + 라우팅 단계 오류 포함).
  // 이렇게 해야 프론트가 HTML 을 받아 "Unexpected token '<'" 로 깨지지 않는다.
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    if (req.path.startsWith('/api')) return res.status(500).json({ error: String(err?.message ?? err) });
    next(err);
  });

  return await new Promise((resolve) => {
    const server = app.listen(port, () => {
      const url = `http://localhost:${port}`;
      resolve({
        port,
        url,
        close: async () => {
          await watcher.close();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

function runInBackground(input: any, opts: any, active: Set<string>): void {
  startRun(input, stripUndefined(opts))
    .then((s) => active.delete(s.id))
    .catch((e) => console.error('백그라운드 런 오류:', e?.message ?? e));
}

function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}
// 폼에서 온 rubric(JSON 문자열)을 안전하게 파싱·정규화
function parseRubricField(v: unknown) {
  if (!v) return undefined;
  try {
    const obj = typeof v === 'string' ? JSON.parse(v) : v;
    return normalizeRubric(obj) ?? undefined;
  } catch {
    return undefined;
  }
}
function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const OFFICE_EXTS = new Set(['.docx', '.pptx', '.pdf']);
// 'improved.*' 중 텍스트 개선본만 골라 보낸다(바이너리 오피스 파일 제외).
async function sendTextArtifact(res: express.Response, dir: string): Promise<void> {
  try {
    const files = await fs.readdir(dir);
    const match = files.find((f) => f.startsWith('improved.') && !OFFICE_EXTS.has(path.extname(f).toLowerCase()));
    if (!match) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const content = await fs.readFile(path.join(dir, match), 'utf8');
    res.type('text/plain; charset=utf-8').send(content);
  } catch {
    res.status(404).json({ error: 'not found' });
  }
}

async function sendFileSafe(res: express.Response, dir: string, pattern: string): Promise<void> {
  try {
    let target: string;
    if (pattern.includes('*')) {
      const prefix = pattern.split('*')[0];
      const files = await fs.readdir(dir);
      const match = files.find((f) => f.startsWith(prefix));
      if (!match) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      target = path.join(dir, match);
    } else {
      target = path.join(dir, pattern);
    }
    const content = await fs.readFile(target, 'utf8');
    res.type('text/plain; charset=utf-8').send(content);
  } catch {
    res.status(404).json({ error: 'not found' });
  }
}
