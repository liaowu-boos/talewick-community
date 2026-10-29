import http from 'node:http';
import {createPublicationFeedbackService,createPublicationFeedbackRouter} from './publication-feedback.mjs';
import { WebSocketServer } from 'ws';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, publicConfig, appRoot } from './config.mjs';
import { createModel } from './model.mjs';
import { TaskService, PLANNING_FOLLOWUP_DECISION_MODE } from './tasks.mjs';
import { ConversationService } from './conversations.mjs';
import { createWorkflowRouter } from './workflow-engine.mjs';
import { loadLibraryService, createLibraryRouter, createRetrieveKnowledge } from './library.mjs';
import {loadNarrativeObservationProjection, unavailableNarrativeObservationProjection} from './narrative-observation-runtime.mjs';
import {createLibraryBatchService} from './library-batch-service.mjs';
import {createLibraryBatchRouter} from './library-batch-router.mjs';
import { Full15Service, createFull15Router, productManuscriptRevision } from './full15-service.mjs';
import { createFull15Analyze } from './full15-analyze.mjs';
import { defaultFull15Input, full15InputFromRequestSpec } from './full15-input.mjs';
import { IndependentReviewService, createIndependentReviewRouter } from './independent-review-service.mjs';
import { createIndependentReviewAnalyze, createIndependentReviewPositionRepairAnalyze } from './independent-review-analyze.mjs';
import { full15InputFromWholeQuality } from './whole-quality-data-bridge.mjs';
import { CandidateRecheckService, PRODUCT_RECHECK_VERSION, createCandidateRecheckRouter } from './candidate-rechecks.mjs';
import { resolveDeepReferenceLayer, queryDeepReferences as queryDeepReferenceLayer } from '../../../data/runtime/deep-reference-layer.mjs';
import { listImportableProjects, projectImportSnapshot } from './project-import.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

async function bodyJSON(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail('请求需要使用 JSON 格式。', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw fail('本次材料超过 2 MB，请减少选取内容。', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('请求正文不是有效 JSON。'); }
}

/** Bind only loopback; the browser sees status/results and never receives the model key. */
export async function createRuntime({ config, model = createModel(config), workflow, agentModel, conversationModel, library: injectedLibrary,
  libraryBatchFileState,
  narrativeObservation: injectedNarrativeObservation, publicationFeedback: injectedFeedback, full15Adapter, full15Analyze,
  full15InputForManuscript, independentReviewAdapter, independentReviewAnalyze, independentReviewPositionRepairAnalyze, independentReviewZeroDispatchAuditForTask, independentReviewReadingFocus, independentReviewHandoff,
  distDir = path.join(appRoot, 'dist') }) {
  const resolvedFull15Adapter = full15Adapter === undefined ? await import('../../../validation/runtime/full15-task.mjs').catch(() => null) : full15Adapter;
  const resolvedIndependentReviewAdapter = independentReviewAdapter === undefined ? await import('../../../validation/runtime/independent-review-task.mjs').catch(() => null) : independentReviewAdapter;
  const resolvedIndependentReviewReadingFocus = independentReviewReadingFocus === undefined ? await import('../../../validation/runtime/focused-whole-quality-evaluation.mjs').catch(() => null) : independentReviewReadingFocus;
  const resolvedIndependentReviewHandoff = independentReviewHandoff === undefined ? await import('../../../creation/runtime/independent-review-handoff.mjs').catch(() => null) : independentReviewHandoff;
  const libraryRoot = config.libraryDir || path.join(config.runsDir, 'library');
  const narrativeObservation = injectedNarrativeObservation ?? (injectedLibrary === undefined
    ? await loadNarrativeObservationProjection({libraryRoot})
    : unavailableNarrativeObservationProjection('library_injected'));
  let deepReferenceInstallation = null;
  let deepReferenceStatus = { available: false, reason: 'not_installed' };
  const deepReferenceInstallRoot = config.deepReferenceInstallRoot || path.join(libraryRoot, 'deep-reference-layer');
  {
    try {
      deepReferenceInstallation = await resolveDeepReferenceLayer({ installRoot: deepReferenceInstallRoot });
      deepReferenceStatus = { available: true, contractVersion: deepReferenceInstallation.schemaVersion,
        installId: deepReferenceInstallation.installId, sourceCount: deepReferenceInstallation.sourceCount,
        frozenCatalogSnapshotSha256: deepReferenceInstallation.bindings.frozenCatalogSnapshotSha256,
        liveBoundSourcesSha256: deepReferenceInstallation.bindings.liveBoundSourcesSha256,
        boundary: '99份资料是证据约束的分析假说；检索不等于采用。' };
    } catch (error) { deepReferenceStatus = { available: false, reason: error?.code === 'ENOENT' ? 'not_installed' : error?.code || 'verification_failed' }; }
  }
  const queryDeepReferences = deepReferenceInstallation ? (query => queryDeepReferenceLayer({ installation: deepReferenceInstallation, ...query })) : undefined;
  let library = injectedLibrary ?? null;
  const retrieveKnowledge = (query, options) => createRetrieveKnowledge(library)(query, options);
  let tasks, full15, independentReviews, releaseFull15;
  const full15Ready = new Promise(resolve => { releaseFull15 = resolve; });
  try {
    tasks = await new TaskService({ runsDir: config.runsDir, model, engine: config.engine || 'fixed',
      newPlanningFollowupDecisionMode: PLANNING_FOLLOWUP_DECISION_MODE,
      workflow: workflow || createWorkflowRouter({ config, agentModel, retrieveKnowledge, queryDeepReferences, queryNarrativeObservations: narrativeObservation.query }), onCompleted: async (task, _request, artifacts) => {
      const service = await full15Ready;
      if (!service?.available() || task.kind !== 'create' || !task.result) return;
      await service.start({ projectId: task.projectId, requestId: `creation-${task.id}`, title: task.result.title, chapters: task.result.chapters, manuscriptRevision: productManuscriptRevision(task.result.title, task.result.chapters) }, { trigger: 'automatic', sourceTaskId: task.id, configuredInput: full15InputFromRequestSpec(artifacts?.requestSpec) });
    } }).init();
    // Full15 initialization may rewrite interrupted queue records, so it starts
    // only after TaskService has acquired the shared runsDir ownership marker.
    const resolveFull15Input = full15InputForManuscript ?? (async input => {
      if (!input.sourceTaskId) return defaultFull15Input();
      const source = tasks.get(input.sourceTaskId), artifacts = tasks.artifacts.get(input.sourceTaskId), sourceRequest = tasks.requests.get(input.sourceTaskId);
      if (source.projectId !== input.projectId || !artifacts || !sourceRequest) throw fail('关联创作任务与当前项目不一致，未沿用检查要求。', 409);
      const baseInput = full15InputFromRequestSpec(artifacts.requestSpec);
      if (source.revisionMode !== 'whole-manuscript-v2') return baseInput;
      if (source.status !== 'completed' || source.result?.wholeRevision?.schemaVersion !== 'whole-manuscript-quality-1' || !resolvedIndependentReviewHandoff?.buildIndependentReviewRequest) throw fail('关联整稿修订没有可核对的实际版本。', 409);
      const handoff = resolvedIndependentReviewHandoff.buildIndependentReviewRequest({ caseId: `full15-${input.sourceTaskId}`,
        request: structuredClone(sourceRequest), result: structuredClone(source.result), selection: input.selection });
      const candidate = handoff.request.candidate?.mode === 'no_change' ? handoff.request.baselineChapters : handoff.request.candidate?.chapters;
      if (!Array.isArray(candidate) || JSON.stringify(candidate) !== JSON.stringify(input.chapters)) throw fail('当前正文不是关联整稿修订实际采纳的版本，未沿用其参考清单。', 409);
      return full15InputFromWholeQuality({ baseInput, quality: source.result.wholeRevision.quality, selection: input.selection });
    });
    full15 = await new Full15Service({ rootDir: path.join(config.runsDir, 'full15-product'), adapter: resolvedFull15Adapter, analyze: full15Analyze ?? createFull15Analyze({ model }), inputForManuscript: resolveFull15Input }).init();
    independentReviews = await new IndependentReviewService({ rootDir: path.join(config.runsDir, 'independent-reviews'),
      adapter: resolvedIndependentReviewAdapter, analyze: independentReviewAnalyze ?? createIndependentReviewAnalyze({ model }),
      analyzePositionRepair: independentReviewPositionRepairAnalyze === undefined
        ? (publicConfig(config).configured ? createIndependentReviewPositionRepairAnalyze({ model }) : undefined)
        : independentReviewPositionRepairAnalyze,
      zeroDispatchAuditForTask: independentReviewZeroDispatchAuditForTask,
      readingFocus: resolvedIndependentReviewReadingFocus,
      prepareRequest: async input => {
        if (input.mode === 'single') return { request: { caseId: input.caseId, mode: 'single', baselineChapters: structuredClone(input.chapters) },
          provenance: { role: 'source', manuscriptRevision: input.manuscriptRevision } };
        if (!resolvedIndependentReviewHandoff || typeof resolvedIndependentReviewHandoff.buildIndependentReviewRequest !== 'function') throw fail('候选比较交接尚未接通。单稿独立评阅仍可使用。', 503);
        const source = tasks.get(input.sourceTaskId);
        const sourceRequest = tasks.requests.get(input.sourceTaskId);
        if (source.projectId !== input.projectId || source.status !== 'completed' || source.revisionMode !== 'whole-manuscript-v2' || !sourceRequest || source.result?.wholeRevision?.schemaVersion !== 'whole-manuscript-quality-1') throw fail('关联整稿修订任务不可用于独立比较。', 409);
        if (productManuscriptRevision(sourceRequest.projectTitle ?? input.title, sourceRequest.chapters) !== input.manuscriptRevision
          || JSON.stringify(sourceRequest.chapters) !== JSON.stringify(input.chapters)) throw fail('当前稿件不是关联修订任务冻结的原稿。请对当前版本发起单稿评阅。', 409);
        return resolvedIndependentReviewHandoff.buildIndependentReviewRequest({ caseId: input.caseId, request: structuredClone(sourceRequest), result: structuredClone(source.result), selection: input.selection });
      } }).init();
    releaseFull15(full15);
  } catch (error) {
    releaseFull15(null);
    await Promise.allSettled([tasks?.close(), full15?.close(), independentReviews?.close(), library?.close()]);
    throw error;
  }
  try { if (injectedLibrary === undefined) library = (await loadLibraryService({ rootDir: libraryRoot, model,
    narrativeObservationProjector: narrativeObservation.projector })).library; }
  catch (error) { await tasks.close(); await full15.close(); await independentReviews.close(); throw error; }
  const libraryRouter = createLibraryRouter({ library, json, bodyJSON });
  let libraryBatches=null;
  let libraryBatchesUnavailableCode=null;
  try {
    if(library&&['registerSource','startSource','waitSource','verifyIndexBinding'].every(key=>typeof library[key]==='function'))libraryBatches=await createLibraryBatchService({library,rootDir:path.join(await realpath(config.runsDir),'library-batches'),concurrency:2,ownsLibrary:false,fileState:libraryBatchFileState});
  }catch(error){
    if(error?.code==='BATCH_LOCAL_FILE_WAIT')libraryBatchesUnavailableCode=error.code;
    else{await tasks.close();await full15.close();await independentReviews.close();await library?.close();throw error;}
  }
  const batchRouter=createLibraryBatchRouter({service:libraryBatches,json,bodyJSON,canRun:()=>publicConfig(config).configured,unavailableCode:libraryBatchesUnavailableCode});
  let conversations;
  try { conversations = await new ConversationService({ runsDir: config.runsDir, tasks, config, conversationModel }).init(); }
  catch (error) { await libraryBatches?.close(); await tasks.close(); await full15.close(); await independentReviews.close(); await library?.close(); throw error; }
  let publicationFeedback;
  try { publicationFeedback=injectedFeedback??await createPublicationFeedbackService({rootDir:path.join(config.runsDir,'publication-feedback'),model,configured:()=>publicConfig(config).configured}); }
  catch(error){await Promise.allSettled([conversations.close(),libraryBatches?.close(),tasks.close(),full15.close(),independentReviews.close(),library?.close()]);throw error;}
  const feedbackRouter=createPublicationFeedbackRouter({service:publicationFeedback,json,bodyJSON});
  const candidateRechecks = await new CandidateRecheckService({ rootDir: path.join(config.runsDir, 'candidate-rechecks'), tasks, model }).init();
  const candidateRecheckRouter = createCandidateRecheckRouter({ service: candidateRechecks, json, bodyJSON, canRun: () => publicConfig(config).configured });
  const full15Router=createFull15Router({service:full15,json,bodyJSON});
  const independentReviewRouter=createIndependentReviewRouter({service:independentReviews,json,bodyJSON});
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const close = async () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); const results=await Promise.allSettled([candidateRechecks.close(),independentReviews.close(),full15.close(),publicationFeedback.close(),conversations.close(),libraryBatches?.close(),tasks.close(),library?.close()]); const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason; };
  const allowedOrigins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, 'http://127.0.0.1:4323', 'http://localhost:4323']);
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw fail('请通过本机地址访问创作服务。', 403);
      if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) throw fail('当前页面不能访问这台电脑的创作服务。', 403);
      const url = new URL(req.url, `http://${host}`);
      if (await independentReviewRouter(req,res,url)) return;
      if (await candidateRecheckRouter(req,res,url)) return;
      if (await full15Router(req,res,url)) return;
      if (await feedbackRouter(req,res,url)) return;
      if (await batchRouter(req, res, url)) return;
      if (await libraryRouter(req, res, url)) return;
      if (url.pathname === '/api/runtime' && req.method === 'GET') return json(res, 200, { ...publicConfig(config), library: { available: Boolean(library), batchesAvailable:Boolean(libraryBatches), ...(libraryBatchesUnavailableCode?{batchesUnavailableCode:libraryBatchesUnavailableCode}:{}), contractVersion: 'v04-contract-1', narrativeObservations: narrativeObservation.status }, deepReferences: deepReferenceStatus, full15: { available: full15.available(), contractVersion: 'full15-product-task-1' }, independentReviews: { available: independentReviews.available(), contractVersion: 'independent-review-product-task-1' }, candidateRechecks: { available: true, contractVersion: PRODUCT_RECHECK_VERSION } });
      const chat = url.pathname.match(/^\/api\/conversations\/([\w-]{1,160})(?:\/turns(?:\/([\w-]{1,160})\/(stream|cancel))?)?$/);
      if (chat) {
        const [, projectId, turnId, action] = chat;
        if (req.method === 'GET' && !url.pathname.endsWith('/turns') && !turnId) { await conversations.refresh(projectId); return json(res, 200, { turns: conversations.list(projectId) }); }
        if (req.method === 'POST' && url.pathname.endsWith('/turns')) {
          if (!publicConfig(config).configured) throw fail(publicConfig(config).message, 503);
          return json(res, 202, { turn: await conversations.start(projectId, await bodyJSON(req)) });
        }
        if (req.method === 'GET' && action === 'stream') { await conversations.refresh(projectId); return conversations.stream(projectId, turnId, req, res); }
        if (req.method === 'POST' && action === 'cancel') { await bodyJSON(req); await conversations.refresh(projectId); return json(res, 200, { turn: await conversations.cancel(projectId, turnId) }); }
        throw fail('这个对话入口不支持当前操作。', 405);
      }
      if (url.pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, { tasks: tasks.list(url.searchParams.get('projectId')) });
      if (url.pathname === '/api/projects' && req.method === 'GET') {
        return json(res, 200, { projects: listImportableProjects(tasks) });
      }
      const snapshotMatch = url.pathname.match(/^\/api\/projects\/([\w-]{1,160})\/import-snapshot$/);
      if (snapshotMatch && req.method === 'GET') {
        return json(res, 200, projectImportSnapshot(tasks, snapshotMatch[1]));
      }
      if (url.pathname === '/api/tasks' && req.method === 'POST') {
        if (!publicConfig(config).configured) throw fail(publicConfig(config).message, 503);
        return json(res, 202, { task: await tasks.create(await bodyJSON(req)) });
      }
      const match = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})(?:\/(resume|cancel))?$/);
      if (match) {
        if (req.method === 'GET' && !match[2]) return json(res, 200, { task: tasks.get(match[1]) });
        if (req.method === 'POST' && match[2]) {
          await bodyJSON(req);
          if (match[2] === 'resume' && !publicConfig(config).configured) throw fail(publicConfig(config).message, 503);
          return json(res, 200, { task: await tasks[match[2]](match[1]) });
        }
        throw fail('这个任务入口不支持当前操作。', 405);
      }
      if (url.pathname.startsWith('/api/')) throw fail('找不到这个服务入口。', 404);
      if (!['GET', 'HEAD'].includes(req.method)) throw fail('页面入口只支持读取。', 405);
      let name = decodeURIComponent(url.pathname);
      if (name === '/') name = '/index.html';
      const file = path.resolve(distDir, '.' + name);
      const dist = await realpath(distDir).catch(() => null);
      const actual = await realpath(file).catch(() => null);
      if (!dist || !actual || !actual.startsWith(dist + path.sep)) throw fail('页面尚未构建或文件不存在，请先运行 npm run build。', 404);
      const bytes = await readFile(actual);
      res.writeHead(200, { 'Content-Type': types[path.extname(actual)] || 'application/octet-stream', 'Cache-Control': path.extname(actual) === '.html' ? 'no-cache' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) { if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '本地服务未能完成操作，请检查运行终端后重试。' }); else res.end(); }
  });
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    const reject = status => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    try {
      const host = req.headers.host || '';
      if (req.method !== 'GET' || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || (req.headers.origin && !allowedOrigins.has(req.headers.origin))) return reject(403);
      const url = new URL(req.url, `http://${host}`);
      const route = url.pathname.match(/^\/api\/conversations\/([\w-]{1,160})\/turns\/([\w-]{1,160})\/socket$/);
      if (!route || url.search) return reject(404);
      await conversations.refresh(route[1]);
      conversations.find(route[1], route[2]);
      sockets.handleUpgrade(req, socket, head, client => conversations.socket(route[1], route[2], client));
    } catch (error) { reject(error.status || 400); }
  });
  return { server, tasks, conversations, library, libraryBatches, publicationFeedback, full15, independentReviews, candidateRechecks, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = await loadConfig();
    const { server, close } = await createRuntime({ config });
    server.on('error', async error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${config.port} 已被使用，请关闭旧服务或修改 TALEWICK_PORT。` : '本地服务启动失败。'); await close(); process.exitCode = 1; });
    server.listen(config.port, '127.0.0.1', () => { console.log(`Talewick：http://127.0.0.1:${config.port}\n${publicConfig(config).message}\n任务与稿件保存在：${config.runsDir}`); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await close(); server.close(); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
