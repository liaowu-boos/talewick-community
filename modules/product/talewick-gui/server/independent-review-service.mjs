import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, writeFile, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { manuscriptText, productManuscriptRevision } from './full15-service.mjs';

const now = () => new Date().toISOString();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = value => sha256(canonical(value));
export const independentReviewRequestHash = value => digest(value);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const validId = value => typeof value === 'string' && /^[\w-]{1,160}$/.test(value);
const active = new Set(['queued', 'running']);
const terminal = new Set(['complete', 'interrupted', 'cancelled', 'needs_attention', 'stale']);
const storedStatuses = new Set([...active, ...terminal]);
const files = ['task.json', 'request.json'];
const execFileAsync = promisify(execFile);

export const INDEPENDENT_REVIEW_LOCAL_FILE_WAIT = '独立评阅任务文件正在等待下载。原任务、正文与已有结果保持不变。';

/** Metadata-only check; never opens a Darwin dataless placeholder. */
export async function independentReviewFileState(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile()) return { available: false, reason: 'not_file' };
    if (process.platform !== 'darwin') return { available: true };
    const { stdout } = await execFileAsync('/usr/bin/stat', ['-f', '%Sf', file], { encoding: 'utf8' });
    const flags = String(stdout).trim().split(',').map(value => value.trim()).filter(Boolean);
    return flags.includes('dataless') ? { available: false, reason: 'dataless' } : { available: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { available: false, reason: 'missing' };
    throw error;
  }
}

function validateChapters(value, label = '稿件') {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw fail('INVALID_MANUSCRIPT', `${label}需要包含 1–30 个章节。`);
  const ids = new Set();
  return value.map(chapter => {
    if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter) || typeof chapter.id !== 'string' || !chapter.id.trim()
      || ids.has(chapter.id) || typeof chapter.title !== 'string' || /[\r\n]/.test(chapter.title)
      || typeof chapter.body !== 'string' || !chapter.body.trim() || chapter.body.length > 100000) throw fail('INVALID_MANUSCRIPT', `${label}章节格式不正确。`);
    ids.add(chapter.id);
    return { id: chapter.id, title: chapter.title, body: chapter.body };
  });
}

function validateCreateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_REQUEST', '独立评阅请求格式不正确。');
  if (!validId(input.projectId) || !validId(input.requestId)) throw fail('INVALID_REQUEST', '独立评阅任务标识无效。');
  if (!['single', 'compare'].includes(input.mode)) throw fail('INVALID_REQUEST', '评阅模式必须是单稿或候选比较。');
  if (typeof input.manuscriptRevision !== 'string' || input.manuscriptRevision.length > 256) throw fail('INVALID_REQUEST', '稿件版本无效。');
  if (typeof input.title !== 'string' || input.title.length > 2000 || /[\r\n]/.test(input.title)) throw fail('INVALID_REQUEST', '作品标题格式不正确。');
  const chapters = validateChapters(input.chapters);
  const expectedRevision = productManuscriptRevision(input.title, chapters);
  if (expectedRevision !== input.manuscriptRevision) throw fail('MANUSCRIPT_VERSION_MISMATCH', '提交的稿件版本与正文不一致，请保存当前版本后重试。', 409);
  if (input.sourceTaskId !== undefined && !validId(input.sourceTaskId)) throw fail('INVALID_REQUEST', '关联修订任务标识无效。');
  if (input.mode === 'compare' && !input.sourceTaskId) throw fail('SOURCE_TASK_REQUIRED', '候选比较必须关联已完成的整稿修订任务。', 409);
  if (input.selection !== undefined && (!Array.isArray(input.selection) || input.selection.length > 100 || input.selection.some(value => !validId(value)) || new Set(input.selection).size !== input.selection.length)) throw fail('INVALID_REQUEST', '候选修改组选择无效。');
  if (input.caseId !== undefined && !validId(input.caseId)) throw fail('INVALID_REQUEST', '评阅案例标识无效。');
  return { projectId: input.projectId, requestId: input.requestId, manuscriptRevision: input.manuscriptRevision,
    title: input.title, chapters, mode: input.mode, ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
    ...(input.selection !== undefined ? { selection: [...input.selection] } : {}), ...(input.caseId ? { caseId: input.caseId } : {}) };
}

const submissionHash = input => digest({ projectId: input.projectId, title: input.title, chapters: input.chapters,
  manuscriptRevision: input.manuscriptRevision, mode: input.mode, ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
  ...(input.selection !== undefined ? { selection: input.selection } : {}), ...(input.caseId ? { caseId: input.caseId } : {}) });

function validatePrepared(prepared, input) {
  if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared) || !prepared.request || typeof prepared.request !== 'object' || Array.isArray(prepared.request)) throw fail('REVIEW_INPUT_UNAVAILABLE', '未能建立受信任的独立评阅输入。', 409);
  const request = structuredClone(prepared.request);
  if (request.mode !== input.mode || !validId(request.caseId)) throw fail('REVIEW_INPUT_INVALID', '独立评阅输入与本次任务不一致。', 409);
  const baseline = validateChapters(request.baselineChapters, '评阅原稿');
  if (canonical(baseline) !== canonical(input.chapters)) throw fail('REVIEW_BASELINE_MISMATCH', '关联任务中的原稿与当前固定版本不一致。', 409);
  request.baselineChapters = baseline;
  if (input.mode === 'single') {
    if (request.candidate !== undefined || request.goals !== undefined) throw fail('REVIEW_INPUT_INVALID', '单稿评阅不能混入候选身份或修订目标。', 409);
  } else {
    if (!request.candidate || !['revised', 'no_change'].includes(request.candidate.mode)) throw fail('REVIEW_INPUT_INVALID', '候选比较缺少有效候选稿。', 409);
    if (request.candidate.mode === 'revised') request.candidate.chapters = validateChapters(request.candidate.chapters, '候选稿');
    if (!Array.isArray(request.goals) || (request.candidate.mode === 'revised' && !request.goals.length)) throw fail('REVIEW_INPUT_INVALID', '修订候选缺少修订前冻结的目标与证据。', 409);
  }
  return { request, provenance: prepared.provenance && typeof prepared.provenance === 'object' && !Array.isArray(prepared.provenance) ? structuredClone(prepared.provenance) : {} };
}

const privateReportKeys = new Set(['path', 'runDir', 'receipt', 'receipts', 'provider', 'invocationId', 'contextId', 'privateBinding', 'packet', 'instruction', 'outputText', 'rawOutput']);
function publicReport(value, depth = 0) {
  if (depth > 30) return null;
  if (Array.isArray(value)) return value.map(item => publicReport(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !privateReportKeys.has(key)).map(([key, item]) => [key, publicReport(item, depth + 1)]));
}

function publicTask(task) {
  const copy = structuredClone(task);
  delete copy.frozen; delete copy.runDir; delete copy.requestHash; delete copy.result;
  delete copy.protocolVersion; delete copy.rulesVersion; delete copy.toolVersion;
  delete copy.inputHash; delete copy.sealedStageIds;
  if (copy.report) copy.report = publicReport(copy.report);
  return copy;
}

export function projectIndependentReviewFailure(error, cancelled = false) {
  if (cancelled) return { code: 'cancelled', message: '独立评阅已取消；固定稿件与已封存记录仍然保留。', recoverable: false };
  if (error?.code === 'provider_outcome_unknown') return { code: error.code, message: '模型调用结果未知；不会自动重发。请保留现场并新建一次评阅。', recoverable: false };
  return { code: error?.code || 'review_failed', message: error?.publicMessage || '独立评阅没有形成可验证结果；固定稿件和已封存阶段仍然保留。', recoverable: false };
}

/** Durable product queue around the validation-owned independent review adapter. */
export class IndependentReviewService {
  constructor({ rootDir, adapter, analyze, prepareRequest, taskFileState = independentReviewFileState, taskFileRead = readFile }) {
    this.rootDir = rootDir; this.adapter = adapter; this.analyze = analyze; this.prepareRequest = prepareRequest;
    this.taskFileState = taskFileState; this.taskFileRead = taskFileRead;
    this.tasks = new Map(); this.waiting = new Map(); this.adapterWaiting = new Map(); this.controllers = new Map(); this.writes = new Map();
    this.mutations = Promise.resolve(); this.busy = false; this.closed = false;
  }
  available() { return Boolean(this.adapter && this.analyze && this.prepareRequest && typeof this.adapter.getIndependentReviewVersions === 'function' && typeof this.adapter.startIndependentReview === 'function' && typeof this.adapter.resumeIndependentReview === 'function'); }
  async versions() { return this.available() ? this.adapter.getIndependentReviewVersions() : null; }
  validateStored(task, id) {
    if (!task || typeof task !== 'object' || Array.isArray(task) || task.id !== id || !validId(task.projectId) || !validId(task.requestId)
      || !['single', 'compare'].includes(task.mode) || !storedStatuses.has(task.status) || typeof task.manuscriptRevision !== 'string' || typeof task.requestHash !== 'string') throw new Error('invalid independent review task');
    return task;
  }
  async inspect(folder) {
    const states = await Promise.all(files.map(async name => ({ name, ...await this.taskFileState(path.join(folder, name)) })));
    const unavailable = states.filter(state => !state.available);
    if (unavailable.length && !unavailable.some(state => state.reason === 'dataless')) throw new Error('incomplete independent review task');
    return unavailable;
  }
  async readTask(id) {
    const folder = path.join(this.rootDir, id), unavailable = await this.inspect(folder);
    if (unavailable.length) {
      const taskMissing = unavailable.some(item => item.name === 'task.json');
      const task = taskMissing ? undefined : this.validateStored(JSON.parse(await this.taskFileRead(path.join(folder, 'task.json'), 'utf8')), id);
      return { waiting: true, folder, files: unavailable.map(item => item.name), task };
    }
    const [taskText, requestText] = await Promise.all(files.map(name => this.taskFileRead(path.join(folder, name), 'utf8')));
    const task = this.validateStored(JSON.parse(taskText), id), frozen = JSON.parse(requestText);
    if (!frozen || typeof frozen !== 'object' || Array.isArray(frozen) || digest(frozen.request) !== task.requestHash || frozen.request?.caseId !== task.caseId) throw new Error('invalid independent review binding');
    if (task.inputHash === undefined) task.inputHash = submissionHash(frozen.submission ?? { projectId: task.projectId, requestId: task.requestId,
      title: frozen.title ?? '', chapters: frozen.request?.baselineChapters ?? [], manuscriptRevision: task.manuscriptRevision, mode: task.mode,
      ...(task.sourceTaskId ? { sourceTaskId: task.sourceTaskId } : {}) });
    task.frozen = frozen;
    return { waiting: false, folder, task };
  }
  async adapterDatalessFiles(task) {
    if (!task.runDir) return [];
    const root = path.resolve(this.rootDir, 'runs'), runDir = path.resolve(task.runDir);
    if (path.relative(root, runDir).startsWith('..') || path.isAbsolute(path.relative(root, runDir))) throw fail('RUN_BINDING_INVALID', '独立评阅运行目录不属于服务端配置范围。', 409);
    const parent = path.dirname(runDir), required = [path.join(parent, 'task.json'), path.join(parent, 'request.json'), path.join(parent, 'events.ndjson')];
    if (task.mode === 'compare') required.push(path.join(runDir, 'controller', 'bundle.json'), path.join(runDir, 'controller', 'private-binding.json'));
    const found = [];
    const walk = async folder => {
      for (const entry of await readdir(folder, { withFileTypes: true }).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
        const target = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) throw fail('RUN_BINDING_INVALID', '独立评阅运行目录不能包含符号链接。', 409);
        if (entry.isDirectory()) await walk(target); else if (entry.isFile()) found.push(target);
      }
    };
    await walk(parent);
    const states = await Promise.all([...new Set([...required, ...found])].map(async file => ({ file, ...await this.taskFileState(file) })));
    return states.filter(state => !state.available && state.reason === 'dataless').map(state => state.file);
  }
  installAdapterWaiting(task, files) {
    if (!this.adapterWaiting.has(task.id)) this.adapterWaiting.set(task.id, { status: active.has(task.status) ? 'queued' : task.status, files });
    task.status = 'needs_attention'; task.error = { code: 'local_file_wait', message: INDEPENDENT_REVIEW_LOCAL_FILE_WAIT, recoverable: false };
    task.progress = { ...(task.progress ?? {}), phase: 'waiting_local_files' };
  }
  async refreshAdapterWaiting(id) {
    const waiting = this.adapterWaiting.get(id); if (!waiting) return;
    const task = this.tasks.get(id), files = await this.adapterDatalessFiles(task);
    if (files.length) throw fail('LOCAL_FILE_WAIT', INDEPENDENT_REVIEW_LOCAL_FILE_WAIT, 409);
    this.adapterWaiting.delete(id); task.status = waiting.status === 'running' ? 'queued' : waiting.status; task.error = null; task.updatedAt = now(); await this.saveTask(task);
  }
  installWaiting(id, loaded) {
    this.waiting.set(id, { folder: loaded.folder, files: loaded.files });
    if (!loaded.task) return;
    const task = structuredClone(loaded.task);
    task.status = 'needs_attention'; task.error = { code: 'local_file_wait', message: INDEPENDENT_REVIEW_LOCAL_FILE_WAIT, recoverable: false };
    task.progress = { ...(task.progress ?? {}), phase: 'waiting_local_files' };
    this.tasks.set(id, task);
  }
  async reloadWaiting(id) {
    if (!this.waiting.has(id)) return this.tasks.get(id);
    let loaded;
    try { loaded = await this.readTask(id); } catch { throw fail('LOCAL_FILE_BINDING_INVALID', '评阅任务文件已下载，但绑定校验未通过；原文件保持不变。', 409); }
    if (loaded.waiting) throw fail('LOCAL_FILE_WAIT', INDEPENDENT_REVIEW_LOCAL_FILE_WAIT, 409);
    const task = loaded.task;
    if (task.runDir) {
      const dataless = await this.adapterDatalessFiles(task);
      if (dataless.length) { this.tasks.set(id, task); this.waiting.delete(id); this.installAdapterWaiting(task, dataless); return task; }
    }
    if (active.has(task.status)) {
      task.status = task.runDir ? 'queued' : 'needs_attention';
      task.error = task.runDir ? null : { code: 'provider_outcome_unknown', message: '运行目录形成前服务中断；不会自动重发。', recoverable: false };
      task.updatedAt = now(); await this.saveTask(task);
    }
    this.tasks.set(id, task); this.waiting.delete(id); return task;
  }
  async refreshWaiting() {
    for (const id of [...this.waiting.keys()]) {
      try { await this.reloadWaiting(id); } catch (error) { if (error?.code !== 'LOCAL_FILE_WAIT') throw error; }
    }
  }
  async init() {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 }); this.rootDir = await realpath(this.rootDir);
    for (const entry of await readdir(this.rootDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      try {
        const loaded = await this.readTask(entry.name);
        if (loaded.waiting) { this.installWaiting(entry.name, loaded); continue; }
        const task = loaded.task;
        if (task.runDir) {
          const dataless = await this.adapterDatalessFiles(task);
          if (dataless.length) { this.tasks.set(task.id, task); this.installAdapterWaiting(task, dataless); continue; }
        }
        if (active.has(task.status)) {
          task.status = task.runDir ? 'queued' : 'needs_attention';
          task.error = task.runDir ? null : { code: 'provider_outcome_unknown', message: '运行目录形成前服务中断；不会自动重发。', recoverable: false };
          task.updatedAt = now(); await this.saveTask(task);
        }
        this.tasks.set(task.id, task);
      } catch { /* Invalid or incomplete files remain untouched for inspection. */ }
    }
    this.schedule(); return this;
  }
  async write(id, name, value) {
    const folder = path.join(this.rootDir, id); await mkdir(folder, { recursive: true, mode: 0o700 });
    const target = path.join(folder, name), temp = path.join(folder, `.${name}.${randomUUID()}.tmp`), snapshot = structuredClone(value);
    const key = `${id}/${name}`;
    const pending = (this.writes.get(key) || Promise.resolve()).catch(() => {}).then(async () => { await writeFile(temp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 }); await rename(temp, target); });
    this.writes.set(key, pending); try { await pending; } finally { if (this.writes.get(key) === pending) this.writes.delete(key); }
  }
  async saveTask(task) { const saved = structuredClone(task); delete saved.frozen; await this.write(task.id, 'task.json', saved); }
  mutate(fn) { const next = this.mutations.then(fn); this.mutations = next.catch(() => {}); return next; }
  list(projectId) { return [...this.tasks.values()].filter(task => !projectId || task.projectId === projectId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(publicTask); }
  get(id) { const task = this.tasks.get(id); if (!task) throw fail('NOT_FOUND', '找不到这次独立评阅。', 404); return publicTask(task); }
  start(input) { return this.mutate(() => this.startTask(input)); }
  async startTask(raw) {
    if (!this.available()) throw fail('INDEPENDENT_REVIEW_UNAVAILABLE', '独立全文评阅适配器或模型调用收据尚未接通。', 503);
    await this.refreshWaiting();
    const input = validateCreateInput(raw), inputHash = submissionHash(input);
    const duplicate = [...this.tasks.values()].find(task => task.projectId === input.projectId && task.requestId === input.requestId);
    if (duplicate) {
      if (duplicate.inputHash !== inputHash) throw fail('REQUEST_CONFLICT', '同一评阅请求标识对应了不同输入。', 409);
      return publicTask(duplicate);
    }
    const caseId = input.caseId ?? `review-${randomUUID()}`;
    const prepared = validatePrepared(await this.prepareRequest({ ...structuredClone(input), caseId }), input);
    const requestHash = digest(prepared.request);
    const sameActive = [...this.tasks.values()].find(task => task.projectId === input.projectId && task.inputHash === inputHash && active.has(task.status));
    if (sameActive) return publicTask(sameActive);
    manuscriptText(input.title, input.chapters);
    const manuscriptSha256 = sha256(canonical(input.chapters));
    const versions = await this.versions();
    const task = { id: randomUUID(), projectId: input.projectId, requestId: input.requestId, caseId: prepared.request.caseId,
      mode: input.mode, ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}), status: 'queued',
      manuscriptRevision: input.manuscriptRevision, manuscriptSha256, requestHash, inputHash, createdAt: now(), updatedAt: now(),
      progress: { phase: 'queued', completedStages: 0, totalStages: input.mode === 'single' ? 2 : 7 }, report: null, error: null,
      ...(versions?.protocolVersion ? { protocolVersion: versions.protocolVersion } : {}), ...(versions?.rulesVersion ? { rulesVersion: versions.rulesVersion } : {}), ...(versions?.toolVersion ? { toolVersion: versions.toolVersion } : {}),
      frozen: { request: prepared.request, submission: input, provenance: prepared.provenance, title: input.title, manuscriptRevision: input.manuscriptRevision } };
    await this.write(task.id, 'request.json', task.frozen); await this.saveTask(task); this.tasks.set(task.id, task); this.schedule(); return publicTask(task);
  }
  schedule() { setImmediate(() => { void this.pump(); }); }
  async pump() {
    if (this.busy || this.closed) return;
    const task = [...this.tasks.values()].find(value => value.status === 'queued' && !this.waiting.has(value.id) && !this.adapterWaiting.has(value.id)); if (!task) return;
    this.busy = true; const controller = new AbortController(); this.controllers.set(task.id, controller);
    task.status = 'running'; task.updatedAt = now(); task.error = null; await this.saveTask(task);
    try {
      const runRoot = path.join(this.rootDir, 'runs'); await mkdir(runRoot, { recursive: true, mode: 0o700 });
      if (task.runDir) {
        const dataless = await this.adapterDatalessFiles(task);
        if (dataless.length) { this.installAdapterWaiting(task, dataless); return; }
      }
      const progress = async event => {
        if (!event || typeof event !== 'object') return;
        if (typeof event.runDir === 'string') task.runDir = event.runDir;
        const phase = typeof event.type === 'string' ? event.type : typeof event.phase === 'string' ? event.phase : task.progress.phase;
        if (event.type === 'stage_sealed' && typeof event.stageId === 'string' && !(task.sealedStageIds ?? []).includes(event.stageId)) task.sealedStageIds = [...(task.sealedStageIds ?? []), event.stageId];
        task.progress = { ...task.progress, phase,
          completedStages: task.sealedStageIds?.length ?? task.progress.completedStages,
          ...(Number.isSafeInteger(event.totalStages) ? { totalStages: event.totalStages } : {}) };
        task.updatedAt = now(); await this.saveTask(task);
      };
      const result = task.runDir
        ? await this.adapter.resumeIndependentReview({ runDir: task.runDir, requestHash: task.requestHash, analyze: this.analyze, signal: controller.signal, onProgress: progress })
        : await this.adapter.startIndependentReview({ runRoot, request: structuredClone(task.frozen.request), analyze: this.analyze, signal: controller.signal, onProgress: progress });
      if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      if (!result || typeof result !== 'object' || !storedStatuses.has(result.status) || typeof result.runDir !== 'string' || result.requestHash !== task.requestHash) throw fail('ADAPTER_RESULT_INVALID', '独立评阅适配器返回了不匹配的任务结果。');
      task.status = result.status; task.runDir = result.runDir; task.result = structuredClone(result); task.report = structuredClone(result.report ?? null);
      task.progress = structuredClone(result.progress ?? task.progress); task.error = result.error ? structuredClone(result.error) : null;
      task.protocolVersion = result.versions?.protocolVersion ?? task.protocolVersion; task.rulesVersion = result.versions?.rulesVersion ?? task.rulesVersion; task.toolVersion = result.versions?.toolVersion ?? task.toolVersion;
    } catch (error) {
      task.status = controller.signal.aborted ? 'cancelled' : 'needs_attention';
      task.error = projectIndependentReviewFailure(error, controller.signal.aborted);
    } finally { task.updatedAt = now(); await this.saveTask(task); this.controllers.delete(task.id); this.busy = false; this.schedule(); }
  }
  async cancel(id) {
    const task = this.tasks.get(id); this.get(id);
    if (active.has(task.status)) { task.status = 'cancelled'; task.error = projectIndependentReviewFailure(null, true); task.updatedAt = now(); await this.saveTask(task); this.controllers.get(id)?.abort(); }
    return publicTask(task);
  }
  retry(id) { return this.mutate(() => this.retryTask(id)); }
  async retryTask(id) {
    if (!this.available()) throw fail('INDEPENDENT_REVIEW_UNAVAILABLE', '独立全文评阅适配器或模型调用收据尚未接通。', 503);
    if (this.waiting.has(id)) await this.reloadWaiting(id);
    if (this.adapterWaiting.has(id)) await this.refreshAdapterWaiting(id);
    const old = this.tasks.get(id); this.get(id);
    if (active.has(old.status)) throw fail('TASK_ACTIVE', '这次独立评阅仍在运行。', 409);
    if (old.status === 'interrupted' && old.runDir) { old.status = 'queued'; old.error = null; old.updatedAt = now(); await this.saveTask(old); this.schedule(); return publicTask(old); }
    const task = { ...structuredClone(old), id: randomUUID(), requestId: `retry-${randomUUID()}`, linkedAttemptId: old.id, status: 'queued', createdAt: now(), updatedAt: now(), report: null, error: null, progress: { phase: 'queued', completedStages: 0, totalStages: old.progress.totalStages } };
    delete task.runDir; delete task.result;
    task.sealedStageIds = [];
    await this.write(task.id, 'request.json', task.frozen); await this.saveTask(task); this.tasks.set(task.id, task); this.schedule(); return publicTask(task);
  }
  async close() { this.closed = true; for (const controller of this.controllers.values()) controller.abort(); while (this.busy) await new Promise(resolve => setTimeout(resolve, 5)); await Promise.allSettled(this.writes.values()); }
}

export function createIndependentReviewRouter({ service, json, bodyJSON }) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/independent-reviews')) return false;
    if (url.pathname === '/api/independent-reviews' && req.method === 'GET') { json(res, 200, { available: service.available(), versions: await service.versions(), tasks: service.list(url.searchParams.get('projectId')) }); return true; }
    if (url.pathname === '/api/independent-reviews' && req.method === 'POST') { json(res, 202, { task: await service.start(await bodyJSON(req)) }); return true; }
    const match = url.pathname.match(/^\/api\/independent-reviews\/([a-f0-9-]{36})(?:\/(cancel|retry))?$/);
    if (match && req.method === 'GET' && !match[2]) { json(res, 200, { task: service.get(match[1]) }); return true; }
    if (match && req.method === 'POST' && match[2]) { await bodyJSON(req); json(res, match[2] === 'retry' ? 202 : 200, { task: await service[match[2]](match[1]) }); return true; }
    throw fail('METHOD_NOT_ALLOWED', '这个独立评阅入口不支持当前操作。', 405);
  };
}
