import express from 'express';
import multer from 'multer';
import chokidar from 'chokidar';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_HOST, DASHBOARD_PORT, PROJECT_ROOT, RUNS_DIR } from '../config.js';
import { buildResumeSeed, buildRerunSeed, getRun, listRuns, reconcileOrphans, runDir, setComparePeer } from '../orchestrator/state.js';
import { resolveInput, extractFileText } from '../input/adapters.js';
import { startRun } from '../orchestrator/runner.js';
import { signal } from '../orchestrator/controls.js';
import { normalizeRubric, suggestRubric } from '../orchestrator/rubrics.js';
import { clearKeys, keyStatus, setKeys } from '../orchestrator/providers.js';
import { liveBus } from '../orchestrator/live.js';
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

  // 이전 프로세스에서 진행 중이던(고아) 런 정리 — 인메모리 제어가 없어 재개 불가하므로 error 로 마감.
  const orphans = await reconcileOrphans();
  if (orphans) console.log(`이전 세션의 진행 중 런 ${orphans}건을 정리했습니다.`);

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
      const provider = (['anthropic', 'openai', 'gemini', 'together', 'nemotron'].includes(body.provider) ? body.provider : undefined) as
        | 'anthropic'
        | 'openai'
        | 'gemini'
        | 'together'
        | 'nemotron'
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
        useJudge: body.useJudge === 'false' ? false : undefined,
        judgeModel: body.judgeModel || undefined,
        laterPassLenses: numOrUndef(body.laterPassLenses),
        laterPassVerify: body.laterPassVerify === 'true' ? true : undefined,
        laterPassMaxNew: numOrUndef(body.laterPassMaxNew),
        autoResume: body.autoResume === 'true' ? true : undefined,
        webhookUrl: body.webhookUrl || undefined,
        finalPass: body.finalPass === 'false' ? false : undefined,
        finalPassModel: body.finalPassModel || undefined,
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

      const urlMode = ['content', 'source', 'full'].includes(body.urlMode) ? body.urlMode : undefined;
      const urlRender = ['off', 'auto', 'on'].includes(body.urlRender) ? body.urlRender : undefined;
      const urlCrawl = numOrUndef(body.urlCrawl);
      const urlCheckLinks = body.urlCheckLinks === 'true' ? true : undefined;
      const input = await resolveInput(source, kind, { urlMode, urlRender, urlCrawl, urlCheckLinks });
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

      const urlMode = ['content', 'source', 'full'].includes(body.urlMode) ? body.urlMode : undefined;
      const urlRender = ['off', 'auto', 'on'].includes(body.urlRender) ? body.urlRender : undefined;
      const urlCrawl = numOrUndef(body.urlCrawl);
      const urlCheckLinks = body.urlCheckLinks === 'true' ? true : undefined;
      const input = await resolveInput(source, kind, { urlMode, urlRender, urlCrawl, urlCheckLinks });
      if (file) input.title = Buffer.from(file.originalname, 'latin1').toString('utf8');

      const groupId = 'cmp-' + Date.now();
      res.json({ ok: true, groupId, title: input.title });

      // 순차 실행(비용/부하 관리). 각 변형은 독립 input 복제 사용.
      void (async () => {
        const variants = [
          { v: 'A' as const, focus: body.focusA || undefined, model: body.modelA || undefined, label: body.labelA || 'A' },
          { v: 'B' as const, focus: body.focusB || undefined, model: body.modelB || undefined, label: body.labelB || 'B' },
        ];
        const ids: string[] = [];
        for (const vv of variants) {
          try {
            const s = await startRun({ ...input }, { ...base, focus: vv.focus, model: vv.model, compare: { groupId, variant: vv.v, label: vv.label } });
            ids.push(s.id);
          } catch (e: any) {
            console.error('A/B 비교 런 오류:', e?.message ?? e);
          }
        }
        // 두 변형을 서로 연결(비교 뷰에서 짝 조회용)
        if (ids.length === 2) {
          await setComparePeer(ids[0], ids[1]);
          await setComparePeer(ids[1], ids[0]);
        }
      })();
    } catch (e: any) {
      if (!res.headersSent) res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // ── 이어하기: 종료된 런의 베스트 + 열린 지적을 시드로 새 런을 백그라운드 시작 ──
  // (경로는 일시정지 제어의 'resume' 와 겹치지 않게 'continue' 사용)
  app.post('/api/runs/:id/continue', async (req, res) => {
    try {
      const seed = await buildResumeSeed(req.params.id);
      if (!seed) return res.status(400).json({ error: '이어할 베스트 산출물이 없습니다.' });
      const { input, seedFindings, config, focus, refsDigest } = seed;
      res.json({ ok: true, parentId: req.params.id, title: input.title, seeded: seedFindings.length });
      runInBackground(
        input,
        stripUndefined({
          ...config,
          focus,
          refsDigest,
          parentId: req.params.id,
          seedFindings,
        }),
        active,
      );
    } catch (e: any) {
      if (!res.headersSent) res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // U7: 처음부터 다시 실행(rerun) — 베스트가 없어도(에러로 멈춘 런) 원본 입력으로 새 런 시작.
  app.post('/api/runs/:id/rerun', async (req, res) => {
    try {
      const seed = await buildRerunSeed(req.params.id);
      if (!seed) return res.status(400).json({ error: '원본 입력을 찾을 수 없어 다시 실행할 수 없습니다.' });
      const { input, config, focus, refsDigest } = seed;
      res.json({ ok: true, title: input.title });
      runInBackground(input, stripUndefined({ ...config, focus, refsDigest }), active);
    } catch (e: any) {
      if (!res.headersSent) res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // #8: 입력 종류·초점 기반 평가기준 추천(대시보드 자동 선택용)
  app.get('/api/rubric/suggest', (req, res) => {
    const kind = (['document', 'url', 'code'].includes(String(req.query.kind)) ? req.query.kind : 'document') as InputKind;
    res.json(suggestRubric(kind, req.query.focus ? String(req.query.focus) : undefined));
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
  // 키 초기화: ?provider=anthropic|openai|gemini|together|all (기본 all)
  app.delete('/api/keys', async (req, res) => {
    try {
      await clearKeys(req.query.provider ? String(req.query.provider) : 'all');
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

  // #14: 런 삭제(산출물 폴더 제거). 진행 중인 런은 거부.
  app.delete('/api/runs/:id', async (req, res) => {
    const run = await getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    if (run.status === 'running' || run.status === 'pending') {
      return res.status(409).json({ error: '진행 중인 런은 삭제할 수 없습니다.' });
    }
    const dir = runDir(req.params.id);
    // 경로 탈출 방지: 반드시 RUNS_DIR 하위여야 함.
    if (!path.resolve(dir).startsWith(path.resolve(RUNS_DIR))) {
      return res.status(400).json({ error: 'invalid id' });
    }
    try {
      await fs.rm(dir, { recursive: true, force: true });
      res.json({ ok: true, id: req.params.id });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  app.get('/api/runs/:id/input', async (req, res) => {
    await sendFileSafe(res, runDir(req.params.id), 'input.*');
  });

  app.get('/api/runs/:id/best', async (req, res) => {
    // 텍스트 개선본(미리보기용) — 같은 폴더의 .docx/.pptx 바이너리는 제외.
    await sendTextArtifact(res, path.join(runDir(req.params.id), 'best'));
  });

  // 원본 양식 유지(제자리 수정) 오피스 개선본 다운로드. (제자리 실패 시 재생성본이 같은 파일명)
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

  // 깔끔하게 재생성한 "정리본"(제자리 수정이 성공했을 때만 별도로 존재).
  app.get('/api/runs/:id/best/office-clean', async (req, res) => {
    const bdir = path.join(runDir(req.params.id), 'best');
    try {
      const files = await fs.readdir(bdir);
      const match = files.find((f) => /^improved\.clean\.(docx|pptx|pdf)$/.test(f));
      if (!match) return res.status(404).json({ error: 'not found' });
      const run = await getRun(req.params.id);
      const base = run ? run.title.replace(/\.[^.]+$/, '') : 'improved';
      res.download(path.join(bdir, match), `${base}_정리본${path.extname(match)}`);
    } catch {
      res.status(404).json({ error: 'not found' });
    }
  });

  app.get('/api/runs/:id/findings', async (req, res) => {
    await sendFileSafe(res, runDir(req.params.id), 'findings.md');
  });

  // 전체 로그(run.json 에는 최근 200개만; 전체 이력은 log.jsonl)
  app.get('/api/runs/:id/log', async (req, res) => {
    await sendFileSafe(res, runDir(req.params.id), 'log.jsonl');
  });

  // #6: 코드 런의 unified diff(패치)
  app.get('/api/runs/:id/best/diff', async (req, res) => {
    await sendFileSafe(res, path.join(runDir(req.params.id), 'best'), 'improved.diff');
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

  // ---- SSE: runs 변경 감지 + 라이브 스트림 ----
  const sseClients = new Set<(event: string, data: string) => void>();
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: hello\ndata: {}\n\n');
    const send = (event: string, data: string) => res.write(`event: ${event}\ndata: ${data}\n\n`);
    sseClients.add(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(send);
    });
  });

  // P1/U1: 진행 중 생성 토큰을 'live' 이벤트로 모든 SSE 클라이언트에 전달.
  liveBus.on('live', (msg: unknown) => {
    const data = JSON.stringify(msg);
    sseClients.forEach((fn) => fn('live', data));
  });

  // ── #2: 세션 한도 자동 이어하기 스케줄러 ──
  // autoResume 이 켜진 stopped_ratelimit 런이 resumeAt 시각을 지나면 자동으로 이어하기를 1회 트리거.
  const autoResumeTimer = setInterval(async () => {
    try {
      const runs = await listRuns();
      const now = Date.now();
      for (const r of runs) {
        if (r.status !== 'stopped_ratelimit') continue;
        if (!r.config?.autoResume || r.autoResumedAt) continue;
        if (!r.resumeAt || new Date(r.resumeAt).getTime() > now) continue;
        const seed = await buildResumeSeed(r.id);
        if (!seed) continue;
        r.autoResumedAt = new Date().toISOString(); // 중복 트리거 방지(부모에 기록)
        try {
          await fs.writeFile(path.join(runDir(r.id), 'run.json'), JSON.stringify(r, null, 2), 'utf8');
        } catch {
          /* ignore */
        }
        console.log(`자동 이어하기 트리거: ${r.id}`);
        runInBackground(
          seed.input,
          stripUndefined({ ...seed.config, focus: seed.focus, refsDigest: seed.refsDigest, parentId: r.id, seedFindings: seed.seedFindings }),
          active,
        );
      }
    } catch {
      /* 스케줄러 오류는 무시 */
    }
  }, 60_000);

  let debounce: NodeJS.Timeout | null = null;
  const changedIds = new Set<string>(); // U1: 디바운스 창 동안 바뀐 런 id 누적
  const watcher = chokidar.watch(RUNS_DIR, { ignoreInitial: true, depth: 4 });
  watcher.on('all', (_evt, fp) => {
    try {
      const rel = path.relative(RUNS_DIR, String(fp));
      const id = rel.split(path.sep)[0];
      if (id && !id.startsWith('..')) changedIds.add(id);
    } catch {
      /* 경로 파싱 실패는 무시 — id 없이 브로드캐스트(전체 갱신) */
    }
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      const payload = JSON.stringify({ ts: Date.now(), ids: [...changedIds] });
      changedIds.clear();
      sseClients.forEach((fn) => fn('change', payload));
    }, 300);
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
    const server = app.listen(port, DASHBOARD_HOST, () => {
      const url = `http://localhost:${port}`;
      resolve({
        port,
        url,
        close: async () => {
          clearInterval(autoResumeTimer);
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
