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
export const PRODUCT_READING_FOCUS_VERSION = 'literary-reading-six-1';
export const PRODUCT_PARAGRAPH_CITATION_MODE = 'paragraph_refs_v1';

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
  if (Object.hasOwn(input, 'readingFocusDefinitions') && !Object.hasOwn(input, 'readingFocusVersion')) throw fail('READING_FOCUS_VERSION', '阅读维度定义必须绑定明确的评审方式。');
  if (Object.hasOwn(input, 'readingFocusVersion') && input.readingFocusVersion !== PRODUCT_READING_FOCUS_VERSION) throw fail('READING_FOCUS_VERSION', '不支持这套阅读维度定义。');
  if (Object.hasOwn(input, 'modelCitationMode') && (input.modelCitationMode !== PRODUCT_PARAGRAPH_CITATION_MODE
    || input.readingFocusVersion !== PRODUCT_READING_FOCUS_VERSION)) throw fail('MODEL_CITATION_MODE', '段落证据定位仅支持明确启用的六项阅读维度新评阅。');
  return { projectId: input.projectId, requestId: input.requestId, manuscriptRevision: input.manuscriptRevision,
    title: input.title, chapters, mode: input.mode, ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
    ...(input.selection !== undefined ? { selection: [...input.selection] } : {}), ...(input.caseId ? { caseId: input.caseId } : {}),
    ...(Object.hasOwn(input, 'readingFocusVersion') ? { readingFocusVersion: input.readingFocusVersion } : {}),
    ...(Object.hasOwn(input, 'modelCitationMode') ? { modelCitationMode: input.modelCitationMode } : {}),
    ...(Object.hasOwn(input, 'readingFocusDefinitions') ? { readingFocusDefinitions: structuredClone(input.readingFocusDefinitions) } : {}) };
}

const submissionHash = input => digest({ projectId: input.projectId, title: input.title, chapters: input.chapters,
  manuscriptRevision: input.manuscriptRevision, mode: input.mode, ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
  ...(input.selection !== undefined ? { selection: input.selection } : {}), ...(input.caseId ? { caseId: input.caseId } : {}),
  ...(input.readingFocusVersion ? { readingFocusVersion: input.readingFocusVersion, readingFocusDefinitions: input.readingFocusDefinitions } : {}),
  ...(Object.hasOwn(input, 'modelCitationMode') ? { modelCitationMode: input.modelCitationMode } : {}) });

function validatePrepared(prepared, input) {
  if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared) || !prepared.request || typeof prepared.request !== 'object' || Array.isArray(prepared.request)) throw fail('REVIEW_INPUT_UNAVAILABLE', '未能建立受信任的独立评阅输入。', 409);
  const request = structuredClone(prepared.request);
  if (request.readingFocusVersion !== input.readingFocusVersion
    || canonical(request.readingFocusDefinitions) !== canonical(input.readingFocusDefinitions)) throw fail('READING_FOCUS_BINDING', '阅读维度与本次明确选择不一致。', 409);
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

/** Auxiliary display data, built only after the adapter's read-only six-seal replay. */
export function buildIndependentReviewPartialSnapshots({ task, partialReport: partial, modelCitationRequestHash }) {
  const ensure = condition => { if (!condition) throw fail('PARTIAL_SNAPSHOT_BINDING_INVALID', '冻结稿件与部分评阅的绑定未通过核对。', 409); };
  const request = task?.frozen?.request, binding = partial?.privateBinding;
  const { reportSha256, ...body } = partial ?? {};
  const requestHash = task?.modelCitationMode === undefined ? digest(request)
    : typeof modelCitationRequestHash === 'function' && modelCitationRequestHash({ request, modelCitationMode: task.modelCitationMode });
  ensure(task?.status === 'needs_attention' && task.mode === 'compare' && request?.mode === 'compare'
    && partial?.schemaVersion === 'independent-review-partial-blind-report-1' && partial.completeBlindReview === true
    && partial.completedBlindStages === 6 && partial.goalAuditStatus === 'needs_attention'
    && partial.taskStatus === 'needs_attention' && partial.automaticAdoption === false && partial.literaryPass === 'NOT_COMPUTED'
    && digest(body) === reportSha256 && partial.requestHash === task.requestHash && requestHash === task.requestHash
    && partial.caseId === task.caseId && request.caseId === task.caseId && partial.runDir === task.runDir);
  ensure(binding && /^whole-quality-private-binding-[123]$/.test(binding.schemaVersion) && binding.caseId === task.caseId
    && canonical(Object.keys(binding.bindings ?? {}).sort()) === canonical(['A', 'B'])
    && canonical(Object.values(binding.bindings).sort()) === canonical(['baseline', 'candidate']));
  const baseline = validateChapters(request.baselineChapters), candidate = request.candidate?.mode === 'no_change'
    ? baseline : request.candidate?.mode === 'revised' ? validateChapters(request.candidate.chapters) : null;
  ensure(candidate && digest(baseline) === binding.baselineManuscriptSha256 && digest(candidate) === binding.candidateManuscriptSha256
    && digest(baseline) === task.manuscriptSha256
    && productManuscriptRevision(task.frozen.title, baseline) === task.manuscriptRevision);
  const snapshots = ['A', 'B'].map(blindId => {
    const role = binding.bindings[blindId], chapters = role === 'baseline' ? baseline : candidate;
    return { blindId, role, manuscriptSha256: digest(chapters), title: task.frozen.title, chapters: structuredClone(chapters) };
  });
  const byAlias = new Map(snapshots.map(item => [item.blindId, item]));
  const checkQuotes = value => {
    if (Array.isArray(value)) return value.forEach(checkQuotes);
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'quote')) {
      const snapshot = byAlias.get(value.blindId), chapter = snapshot?.chapters.find(item => item.id === value.chapterId);
      ensure(chapter && typeof value.quote === 'string' && value.quote.length > 0 && Number.isSafeInteger(value.start)
        && value.start >= 0 && chapter.body.slice(value.start, value.start + value.quote.length) === value.quote);
    }
    Object.values(value).forEach(checkQuotes);
  };
  ensure(Array.isArray(partial.readerBindings) && partial.readerBindings.length === 2);
  for (const reader of partial.readerBindings) {
    ensure(Array.isArray(reader.order) && reader.order.length === 2 && new Set(reader.order.map(item => item.blindId)).size === 2);
    for (const slot of reader.order) {
      const snapshot = byAlias.get(slot.blindId);
      ensure(snapshot && slot.role === snapshot.role && slot.manuscriptSha256 === snapshot.manuscriptSha256);
    }
  }
  // Opinion/merge/seal validity comes from validation's replay, not a second protocol implementation.
  checkQuotes(partial.independentReadings); checkQuotes(partial.blindPairReviews);
  return { schemaVersion: 'independent-review-partial-snapshots-1', reviewTaskId: task.id, caseId: task.caseId,
    requestHash: task.requestHash, partialReportSha256: reportSha256, snapshots };
}

function publicReport(value, depth = 0) {
  if (depth > 30) return null;
  if (Array.isArray(value)) return value.map(item => publicReport(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !privateReportKeys.has(key)).map(([key, item]) => [key, publicReport(item, depth + 1)]));
}

function publicTask(task, recoveryCapabilities) {
  const copy = structuredClone(task);
  delete copy.frozen; delete copy.runDir; delete copy.requestHash; delete copy.result;
  delete copy.protocolVersion; delete copy.rulesVersion; delete copy.toolVersion;
  delete copy.inputHash; delete copy.sealedStageIds;
  delete copy.pendingRecovery; delete copy.partialReport; delete copy.partialSnapshotProjection; delete copy.partialSnapshotUnavailable;
  delete copy.pendingInvalidReadingRetry; delete copy.invalidReadingRetry;
  if (copy.recoveries) copy.recoveries = copy.recoveries.map(({ requestHash, runDir, inputHash, trustedAudit, ...entry }) => entry);
  if (copy.invalidReadingRetries) copy.invalidReadingRetries = copy.invalidReadingRetries.map(({ requestHash, runDir, inputHash, inspectionHash, inspection, ...entry }) => entry);
  if (recoveryCapabilities) copy.recoveryCapabilities = recoveryCapabilities;
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
  constructor({ rootDir, adapter, analyze, analyzePositionRepair, zeroDispatchAuditForTask, readingFocus, prepareRequest, taskFileState = independentReviewFileState, taskFileRead = readFile }) {
    this.rootDir = rootDir; this.adapter = adapter; this.analyze = analyze; this.prepareRequest = prepareRequest;
    this.analyzePositionRepair = analyzePositionRepair;
    this.zeroDispatchAuditForTask = zeroDispatchAuditForTask;
    this.readingFocus = readingFocus;
    this.taskFileState = taskFileState; this.taskFileRead = taskFileRead;
    this.tasks = new Map(); this.waiting = new Map(); this.adapterWaiting = new Map(); this.controllers = new Map(); this.writes = new Map();
    this.mutations = Promise.resolve(); this.busy = false; this.closed = false;
  }
  available() { return Boolean(this.adapter && this.analyze && this.prepareRequest && typeof this.adapter.getIndependentReviewVersions === 'function' && typeof this.adapter.startIndependentReview === 'function' && typeof this.adapter.resumeIndependentReview === 'function'); }
  async versions(protocolVersion) { return this.available() ? this.adapter.getIndependentReviewVersions(protocolVersion) : null; }
  modelCitationModes() {
    return this.readingFocusVersions().length && typeof this.adapter.getIndependentReviewRequestHash === 'function'
      && typeof this.adapter.getIndependentReviewModelCitationModes === 'function'
      && this.adapter.getIndependentReviewModelCitationModes()?.includes(PRODUCT_PARAGRAPH_CITATION_MODE)
      ? [PRODUCT_PARAGRAPH_CITATION_MODE] : [];
  }
  requestHashFor(request, modelCitationMode) {
    if (modelCitationMode === undefined) return digest(request);
    if (modelCitationMode !== PRODUCT_PARAGRAPH_CITATION_MODE || typeof this.adapter?.getIndependentReviewRequestHash !== 'function') throw fail('MODEL_CITATION_UNAVAILABLE', '段落证据定位尚未接通；原记录保持不变。', 503);
    const value = this.adapter.getIndependentReviewRequestHash({ request, modelCitationMode });
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw fail('MODEL_CITATION_HASH', '证据定位方式未形成有效的冻结输入绑定。', 409);
    return value;
  }
  readingFocusVersions() {
    return this.available() && this.readingFocus?.READING_FOCUS_VERSION === PRODUCT_READING_FOCUS_VERSION
      && typeof this.readingFocus.withLiteraryReadingFocus === 'function' && typeof this.readingFocus.getLiteraryReadingFocusDefinitions === 'function'
      && typeof this.adapter.normalizeIndependentReviewRequest === 'function' ? [PRODUCT_READING_FOCUS_VERSION] : [];
  }
  focusedInput(input) {
    if (!input.readingFocusVersion) return input;
    if (!this.readingFocusVersions().includes(input.readingFocusVersion)) throw fail('READING_FOCUS_UNAVAILABLE', '六项阅读维度评审尚未接通；历史任务保持原样。', 503);
    const definitions = this.readingFocus.getLiteraryReadingFocusDefinitions();
    if (Object.hasOwn(input, 'readingFocusDefinitions') && canonical(input.readingFocusDefinitions) !== canonical(definitions)) throw fail('READING_FOCUS_DEFINITIONS', '阅读维度必须与服务端固定定义及顺序一致。');
    return { ...input, readingFocusDefinitions: definitions };
  }
  recoveryCapabilities() {
    const local = this.available() && typeof this.adapter.recoverIndependentReviewPositions === 'function'
      && typeof this.adapter.readIndependentReviewProgress === 'function';
    return { whitespace_only: local, position_repair: local && typeof this.analyzePositionRepair === 'function' };
  }
  invalidReadingRetryAvailable() {
    return this.available() && typeof this.adapter.readIndependentReviewProgress === 'function'
      && typeof this.adapter.inspectInvalidIndependentReadingRetry === 'function'
      && typeof this.adapter.retryInvalidIndependentReading === 'function';
  }
  async inspectInvalidReadingRetry(task) {
    if (!this.invalidReadingRetryAvailable()) throw fail('INVALID_READING_RETRY_UNAVAILABLE', '一次无效初读重读尚未接通。', 503);
    if (task.status !== 'needs_attention' || !task.runDir || !validId(task.error?.stage)) throw fail('INVALID_READING_RETRY_STATE', '当前没有可重新独立阅读的无效初读阶段。', 409);
    if (task.invalidReadingRetries?.some(entry => entry.stageId === task.error.stage)) throw fail('INVALID_READING_RETRY_LIMIT', '这个阶段已经请求过一次独立重读；原记录保留，不会补发。', 409);
    await this.boundStoredTask(task);
    const inspection = await this.adapter.inspectInvalidIndependentReadingRetry({ runDir: task.runDir, requestHash: task.requestHash, stageId: task.error.stage });
    if (!inspection || typeof inspection.eligible !== 'boolean') throw fail('INVALID_READING_RETRY_INSPECTION', '无效初读重读资格未通过校验。', 409);
    if (inspection.eligible && (inspection.stageId !== task.error.stage || !/^[a-f0-9]{64}$/.test(inspection.inspectionHash ?? '') || inspection.reservation != null)) throw fail('INVALID_READING_RETRY_INSPECTION', '无效初读重读绑定或次数未通过校验。', 409);
    return inspection;
  }
  async invalidReadingRetryProjection(task) {
    const projection = { available: this.invalidReadingRetryAvailable(), eligible: false, remainingAttempts: 0 };
    if (!projection.available) return projection;
    try {
      const inspection = await this.inspectInvalidReadingRetry(task);
      return { ...projection, eligible: inspection.eligible, remainingAttempts: inspection.eligible ? 1 : 0,
        stageId: task.error.stage, reason: /^[A-Z0-9_]+$/.test(inspection.reason ?? '') ? inspection.reason : inspection.eligible ? 'ELIGIBLE' : 'NOT_ELIGIBLE' };
    } catch (error) { return { ...projection, reason: error?.code || 'INVALID_READING_RETRY_INSPECTION' }; }
  }
  interruptInvalidReadingRetry(task) {
    const entry = task.invalidReadingRetries?.find(item => item.requestId === task.pendingInvalidReadingRetry);
    if (!active.has(task.status) || entry?.status !== 'running') return false;
    entry.status = 'interrupted'; entry.finishedAt = now();
    task.status = 'needs_attention'; task.error = { code: 'INVALID_READING_RETRY_OUTCOME_UNKNOWN', message: '这次独立重读曾被中断，原响应与新尝试均保留；不会自动补发。', recoverable: false };
    delete task.pendingInvalidReadingRetry; task.updatedAt = now(); return true;
  }
  project(task) { return publicTask(task, this.recoveryCapabilities()); }
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
    if (!frozen || typeof frozen !== 'object' || Array.isArray(frozen)
      || this.requestHashFor(frozen.request, task.modelCitationMode) !== task.requestHash || frozen.request?.caseId !== task.caseId) throw new Error('invalid independent review binding');
    if (Object.hasOwn(task, 'modelCitationMode') || Object.hasOwn(frozen.submission ?? {}, 'modelCitationMode')) {
      if (task.modelCitationMode !== PRODUCT_PARAGRAPH_CITATION_MODE || frozen.submission?.modelCitationMode !== task.modelCitationMode
        || task.readingFocusVersion !== PRODUCT_READING_FOCUS_VERSION || task.inputHash !== submissionHash(frozen.submission)) throw fail('MODEL_CITATION_BINDING', '保存的证据定位方式与冻结输入不一致。', 409);
    }
    if (task.readingFocusVersion !== undefined || frozen.request?.readingFocusVersion !== undefined) {
      if (task.readingFocusVersion !== PRODUCT_READING_FOCUS_VERSION || frozen.request.readingFocusVersion !== task.readingFocusVersion
        || frozen.submission?.readingFocusVersion !== task.readingFocusVersion
        || canonical(frozen.submission?.readingFocusDefinitions) !== canonical(frozen.request.readingFocusDefinitions)
        || task.inputHash !== submissionHash(frozen.submission)) throw new Error('invalid independent reading focus binding');
    }
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
    if (this.interruptInvalidReadingRetry(task)) await this.saveTask(task);
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
        if (this.interruptInvalidReadingRetry(task)) await this.saveTask(task);
        if (task.runDir) {
          const dataless = await this.adapterDatalessFiles(task);
          if (dataless.length) { this.tasks.set(task.id, task); this.installAdapterWaiting(task, dataless); continue; }
        }
        if (active.has(task.status) && task.pendingRecovery && task.recoveries?.find(item => item.requestId === task.pendingRecovery)?.status === 'running') {
          const recovery = task.recoveries.find(item => item.requestId === task.pendingRecovery);
          recovery.status = 'interrupted'; recovery.finishedAt = now();
          task.status = 'needs_attention'; task.error = { code: 'RECOVERY_OUTCOME_UNKNOWN', message: '引文恢复曾被中断，已保留原记录；不会自动重发。', recoverable: false };
          delete task.pendingRecovery; task.updatedAt = now(); await this.saveTask(task);
        } else if (active.has(task.status)) {
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
  list(projectId) { return [...this.tasks.values()].filter(task => !projectId || task.projectId === projectId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(task => this.project(task)); }
  get(id) { const task = this.tasks.get(id); if (!task) throw fail('NOT_FOUND', '找不到这次独立评阅。', 404); return this.project(task); }
  async boundStoredTask(task) {
    const loaded = await this.readTask(task.id);
    if (loaded.waiting) throw fail('LOCAL_FILE_WAIT', INDEPENDENT_REVIEW_LOCAL_FILE_WAIT, 409);
    if (loaded.task.requestHash !== task.requestHash || loaded.task.runDir !== task.runDir
      || loaded.task.projectId !== task.projectId || loaded.task.sourceTaskId !== task.sourceTaskId || loaded.task.modelCitationMode !== task.modelCitationMode
      || canonical(loaded.task.frozen) !== canonical(task.frozen)) throw fail('REVIEW_BINDING_CHANGED', '独立评阅的冻结输入已改变，已停止恢复。', 409);
    const dataless = await this.adapterDatalessFiles(task);
    if (dataless.length) throw fail('LOCAL_FILE_WAIT', INDEPENDENT_REVIEW_LOCAL_FILE_WAIT, 409);
    if (task.modelCitationMode !== undefined && task.runDir) await this.assertCitationMetadata(task);
  }
  async assertCitationMetadata(task) {
    const file = path.join(path.dirname(task.runDir), 'task.json'), state = await this.taskFileState(file);
    if (!state.available) throw fail('LOCAL_FILE_WAIT', INDEPENDENT_REVIEW_LOCAL_FILE_WAIT, 409);
    const meta = JSON.parse(await this.taskFileRead(file, 'utf8'));
    if (meta.modelCitationMode !== task.modelCitationMode || meta.requestHash !== task.requestHash || meta.caseId !== task.caseId
      || meta.mode !== task.mode || path.resolve(meta.runDir ?? '') !== path.resolve(task.runDir)) throw fail('MODEL_CITATION_BINDING', '证据定位方式与冻结评阅运行记录不一致；已停止操作。', 409);
  }
  async read(id) {
    const value = this.get(id), task = this.tasks.get(id);
    if (task.modelCitationMode !== undefined) await this.boundStoredTask(task);
    value.invalidReadingRetry = await this.invalidReadingRetryProjection(task);
    if (task.status !== 'needs_attention' || task.mode !== 'compare' || !task.runDir
      || typeof this.adapter?.buildIndependentReviewPartialReport !== 'function') return value;
    try {
      await this.boundStoredTask(task);
      const partial = await this.adapter.buildIndependentReviewPartialReport({ runDir: task.runDir, requestHash: task.requestHash });
      const { reportSha256, ...body } = partial ?? {};
      if (body.schemaVersion !== 'independent-review-partial-blind-report-1' || body.requestHash !== task.requestHash
        || body.runDir !== task.runDir || body.caseId !== task.caseId || reportSha256 !== digest(body)
        || body.taskStatus !== 'needs_attention' || body.completeBlindReview !== true || body.completedBlindStages !== 6
        || body.goalAuditStatus !== 'needs_attention' || body.automaticAdoption !== false || body.literaryPass !== 'NOT_COMPUTED') throw fail('PARTIAL_REPORT_BINDING_INVALID', '部分盲评记录未通过绑定校验。', 409);
      // This separately derived projection is checksummed by validation and by
      // the coordinator importer. Redaction would invalidate that checksum.
      value.partialReport = structuredClone(partial);
      try { value.partialSnapshotProjection = buildIndependentReviewPartialSnapshots({ task, partialReport: partial, modelCitationRequestHash: this.adapter.getIndependentReviewRequestHash }); }
      catch (error) { value.partialSnapshotUnavailable = { code: error?.code || 'PARTIAL_SNAPSHOT_UNAVAILABLE', message: '冻结稿件绑定尚未通过核对；评阅意见保留，已停止引文跳转。' }; }
    } catch (error) {
      value.partialReportUnavailable = { code: error?.code || 'PARTIAL_REPORT_UNAVAILABLE', message: '部分盲评记录尚未通过完整回放，原失败记录保留。' };
    }
    return value;
  }
  async readList(projectId) { return Promise.all(this.list(projectId).map(task => this.read(task.id))); }
  retryInvalidReading(id, input) { return this.mutate(() => this.retryInvalidReadingTask(id, input)); }
  async retryInvalidReadingTask(id, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
      || !validId(input.requestId) || !validId(input.stageId)) throw fail('INVALID_READING_RETRY_INPUT', '独立重读请求只允许操作标识与当前失败阶段。');
    const task = this.tasks.get(id); this.get(id);
    if (this.waiting.has(id) || this.adapterWaiting.has(id)) throw fail('LOCAL_FILE_WAIT', INDEPENDENT_REVIEW_LOCAL_FILE_WAIT, 409);
    await this.boundStoredTask(task);
    const inputHash = digest(input), duplicate = task.invalidReadingRetries?.find(entry => entry.requestId === input.requestId);
    if (duplicate) {
      if (duplicate.inputHash !== inputHash) throw fail('INVALID_READING_RETRY_CONFLICT', '同一独立重读操作标识对应了不同阶段。', 409);
      return this.project(task);
    }
    if (!this.invalidReadingRetryAvailable()) throw fail('INVALID_READING_RETRY_UNAVAILABLE', '一次无效初读重读尚未接通。', 503);
    if (task.status !== 'needs_attention' || task.error?.stage !== input.stageId) throw fail('INVALID_READING_RETRY_STATE', '只能重新独立阅读当前引用无效的阶段。', 409);
    const current = await this.adapter.readIndependentReviewProgress({ runDir: task.runDir, requestHash: task.requestHash });
    this.checkAdapterResult(task, current);
    if (current.status !== 'needs_attention' || current.error?.stage !== input.stageId) throw fail('INVALID_READING_RETRY_STAGE', '当前失败阶段已变化，已停止独立重读。', 409);
    const inspection = await this.inspectInvalidReadingRetry(task);
    if (!inspection.eligible) throw fail('INVALID_READING_RETRY_NOT_ELIGIBLE', '当前阶段不符合一次无效初读重读条件；已有记录保留。', 409);
    const entry = { ...input, inputHash, inspectionHash: inspection.inspectionHash, inspection: structuredClone(inspection),
      requestHash: task.requestHash, runDir: task.runDir, status: 'queued', createdAt: now(),
      originalError: structuredClone(task.error), originalProgress: structuredClone(current.progress) };
    task.invalidReadingRetries = [...(task.invalidReadingRetries ?? []), entry]; task.pendingInvalidReadingRetry = input.requestId;
    task.status = 'queued'; task.updatedAt = now(); task.progress = { ...task.progress, phase: 'invalid_reading_retry_queued' };
    await this.saveTask(task); this.schedule(); return this.project(task);
  }
  auditedRecoveryAvailable() {
    return typeof this.zeroDispatchAuditForTask === 'function' && typeof this.analyzePositionRepair === 'function'
      && typeof this.adapter?.inspectIndependentReviewZeroDispatchRecovery === 'function'
      && typeof this.adapter?.recoverIndependentReviewPositionsAfterAuditedNonDispatch === 'function';
  }
  recover(id, input) { return this.mutate(() => this.recoverTask(id, input)); }
  async recoverTask(id, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3
      || !validId(input.requestId) || !validId(input.stageId) || !['whitespace_only', 'position_repair', 'audited_nondispatch'].includes(input.mode)) throw fail('RECOVERY_INPUT_INVALID', '恢复请求必须指定请求标识、失败阶段和引文恢复方式。');
    const task = this.tasks.get(id); this.get(id);
    if (this.waiting.has(id) || this.adapterWaiting.has(id)) throw fail('LOCAL_FILE_WAIT', INDEPENDENT_REVIEW_LOCAL_FILE_WAIT, 409);
    await this.boundStoredTask(task);
    const inputHash = digest(input), duplicate = task.recoveries?.find(item => item.requestId === input.requestId);
    if (duplicate) {
      if (duplicate.inputHash !== inputHash) throw fail('RECOVERY_REQUEST_CONFLICT', '同一恢复请求标识对应了不同操作。', 409);
      return this.project(task);
    }
    const audited = input.mode === 'audited_nondispatch';
    if (!(audited ? this.auditedRecoveryAvailable() : this.recoveryCapabilities()[input.mode])) throw fail('RECOVERY_UNAVAILABLE', '该引文恢复方式尚未接通。', 503);
    if (task.status !== 'needs_attention' || !task.runDir) throw fail('RECOVERY_STATE_INVALID', '仅可恢复原任务当前失败的引文定位阶段。', 409);
    const current = await this.adapter.readIndependentReviewProgress({ runDir: task.runDir, requestHash: task.requestHash });
    this.checkAdapterResult(task, current);
    if (current.status !== 'needs_attention' || current.error?.stage !== input.stageId) throw fail('RECOVERY_STAGE_MISMATCH', '失败阶段或冻结版本已变化，已停止恢复。', 409);
    if (!(audited ? ['POSITION_REPAIR_EXHAUSTED'] : ['QUOTE_NOT_FOUND', 'QUOTE_POSITION_NOT_UNIQUE']).includes(current.error?.code)) throw fail('RECOVERY_NOT_POSITION_FAILURE', '这次失败不是可恢复的引文定位问题，不会重抽判断。', 409);
    const attempted = task.recoveries?.find(item => item.stageId === input.stageId && item.mode === input.mode);
    if (attempted) throw fail('RECOVERY_LIMIT_REACHED', '这个阶段的该种引文恢复已尝试，原结果保留，不会重复执行。', 409);
    let trustedAudit;
    if (audited) {
      const audit = await this.zeroDispatchAuditForTask({ reviewTaskId: task.id, projectId: task.projectId, sourceTaskId: task.sourceTaskId,
        stageId: input.stageId, runDir: task.runDir, requestHash: task.requestHash });
      if (!audit || audit.reviewTaskId !== task.id || typeof audit.witnessPath !== 'string' || !path.isAbsolute(audit.witnessPath)
        || typeof audit.witnessSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(audit.witnessSHA256)) throw fail('RECOVERY_TRUSTED_AUDIT_REQUIRED', '缺少与原任务绑定的服务端未发出凭证。', 409);
      trustedAudit = { reviewTaskId: audit.reviewTaskId, witnessPath: audit.witnessPath, witnessSHA256: audit.witnessSHA256 };
      if (input.requestId !== `audited-position-${trustedAudit.witnessSHA256}`) throw fail('RECOVERY_AUDIT_REQUEST_ID', '此次恢复标识必须绑定服务端固定凭证。', 409);
      const eligibility = await this.adapter.inspectIndependentReviewZeroDispatchRecovery({ runDir: task.runDir, requestHash: task.requestHash, audit: structuredClone(trustedAudit) });
      if (eligibility?.eligible !== true || eligibility.reviewTaskId !== task.id || eligibility.stageId !== input.stageId
        || eligibility.requestHash !== task.requestHash || eligibility.witnessSHA256 !== trustedAudit.witnessSHA256) throw fail('RECOVERY_AUDIT_BINDING_INVALID', '未发出凭证与当前失败阶段不一致，已停止恢复。', 409);
    }
    const recovery = { ...input, inputHash, requestHash: task.requestHash, runDir: task.runDir, status: 'queued', createdAt: now(), originalError: structuredClone(task.error), validationError: structuredClone(current.error) };
    if (trustedAudit) Object.assign(recovery, { trustedAudit, witnessSHA256: trustedAudit.witnessSHA256 });
    task.recoveries = [...(task.recoveries ?? []), recovery]; task.pendingRecovery = input.requestId;
    task.status = 'queued'; task.updatedAt = now(); task.progress = { ...task.progress, phase: 'position_recovery_queued' };
    await this.saveTask(task); this.schedule(); return this.project(task);
  }
  checkAdapterResult(task, result) {
    if (!result || typeof result !== 'object' || !storedStatuses.has(result.status) || typeof result.runDir !== 'string'
      || result.requestHash !== task.requestHash || (task.runDir && result.runDir !== task.runDir)) throw fail('ADAPTER_RESULT_INVALID', '独立评阅适配器返回了不匹配的任务结果。');
  }
  start(input) { return this.mutate(() => this.startTask(input)); }
  async startTask(raw) {
    if (!this.available()) throw fail('INDEPENDENT_REVIEW_UNAVAILABLE', '独立全文评阅适配器或模型调用收据尚未接通。', 503);
    await this.refreshWaiting();
    const input = this.focusedInput(validateCreateInput(raw)), inputHash = submissionHash(input);
    if (input.modelCitationMode !== undefined && !this.modelCitationModes().includes(input.modelCitationMode)) throw fail('MODEL_CITATION_UNAVAILABLE', '段落证据定位尚未接通；不会按其他方式启动。', 503);
    const duplicate = [...this.tasks.values()].find(task => task.projectId === input.projectId && task.requestId === input.requestId);
    if (duplicate) {
      if (duplicate.inputHash !== inputHash) throw fail('REQUEST_CONFLICT', '同一评阅请求标识对应了不同输入。', 409);
      return publicTask(duplicate);
    }
    const caseId = input.caseId ?? `review-${randomUUID()}`;
    let trusted = await this.prepareRequest({ ...structuredClone(input), caseId });
    if (input.readingFocusVersion) trusted = { ...trusted, request: this.adapter.normalizeIndependentReviewRequest(this.readingFocus.withLiteraryReadingFocus(trusted.request)) };
    const prepared = validatePrepared(trusted, input);
    const requestHash = this.requestHashFor(prepared.request, input.modelCitationMode);
    const sameActive = [...this.tasks.values()].find(task => task.projectId === input.projectId && task.inputHash === inputHash && active.has(task.status));
    if (sameActive) return publicTask(sameActive);
    manuscriptText(input.title, input.chapters);
    const manuscriptSha256 = sha256(canonical(input.chapters));
    const versions = await this.versions(input.readingFocusVersion ? 'whole-quality-evaluation-3' : undefined);
    const task = { id: randomUUID(), projectId: input.projectId, requestId: input.requestId, caseId: prepared.request.caseId,
      mode: input.mode, ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}), status: 'queued',
      manuscriptRevision: input.manuscriptRevision, manuscriptSha256, requestHash, inputHash, createdAt: now(), updatedAt: now(),
      progress: { phase: 'queued', completedStages: 0, totalStages: input.mode === 'single' ? 2 : 7 }, report: null, error: null,
      ...(input.readingFocusVersion ? { readingFocusVersion: input.readingFocusVersion } : {}),
      ...(input.modelCitationMode !== undefined ? { modelCitationMode: input.modelCitationMode } : {}),
      ...(versions?.protocolVersion ? { protocolVersion: versions.protocolVersion } : {}), ...(versions?.rulesVersion ? { rulesVersion: versions.rulesVersion } : {}), ...(versions?.toolVersion ? { toolVersion: versions.toolVersion } : {}),
      frozen: { request: prepared.request, submission: input, provenance: prepared.provenance, title: input.title, manuscriptRevision: input.manuscriptRevision } };
    await this.write(task.id, 'request.json', task.frozen); await this.saveTask(task); this.tasks.set(task.id, task); this.schedule(); return publicTask(task);
  }
  schedule() { setImmediate(() => { void this.pump(); }); }
  async pump() {
    if (this.busy || this.closed) return;
    const task = [...this.tasks.values()].find(value => value.status === 'queued' && !this.waiting.has(value.id) && !this.adapterWaiting.has(value.id)); if (!task) return;
    this.busy = true; const controller = new AbortController(); this.controllers.set(task.id, controller);
    const recovery = task.recoveries?.find(item => item.requestId === task.pendingRecovery);
    const readingRetry = task.invalidReadingRetries?.find(item => item.requestId === task.pendingInvalidReadingRetry);
    if (recovery) { recovery.status = 'running'; recovery.startedAt = now(); }
    if (readingRetry) { readingRetry.status = 'running'; readingRetry.startedAt = now(); }
    task.status = 'running'; task.updatedAt = now(); task.error = null; await this.saveTask(task);
    try {
      const runRoot = path.join(this.rootDir, 'runs'); await mkdir(runRoot, { recursive: true, mode: 0o700 });
      if (task.runDir) {
        const dataless = await this.adapterDatalessFiles(task);
        if (dataless.length) { this.installAdapterWaiting(task, dataless); return; }
      }
      if (task.modelCitationMode !== undefined) await this.boundStoredTask(task);
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
      let result;
      if (readingRetry) {
        await this.boundStoredTask(task);
        if (!this.invalidReadingRetryAvailable()) throw fail('INVALID_READING_RETRY_UNAVAILABLE', '一次无效初读重读尚未接通。', 503);
        if (readingRetry.requestHash !== task.requestHash || readingRetry.runDir !== task.runDir
          || readingRetry.stageId !== readingRetry.inspection?.stageId || readingRetry.inspectionHash !== readingRetry.inspection?.inspectionHash
          || readingRetry.inputHash !== digest({ requestId: readingRetry.requestId, stageId: readingRetry.stageId })) throw fail('INVALID_READING_RETRY_BINDING', '保存的独立重读操作与冻结任务不一致。', 409);
        result = await this.adapter.retryInvalidIndependentReading({ runDir: task.runDir, requestHash: task.requestHash,
          stageId: readingRetry.stageId, inspectionHash: readingRetry.inspectionHash, analyze: this.analyze, signal: controller.signal, onProgress: progress });
        this.checkAdapterResult(task, result);
        if (['queued', 'interrupted'].includes(result.status) && !controller.signal.aborted) {
          if (!Number.isSafeInteger(readingRetry.originalProgress?.completedStages)
            || result.progress?.completedStages !== readingRetry.originalProgress.completedStages + 1) throw fail('INVALID_READING_RETRY_UNSEALED', '重新阅读尚未形成有效封存；已停止后续阶段。', 409);
          result = await this.adapter.resumeIndependentReview({ runDir: task.runDir, requestHash: task.requestHash, analyze: this.analyze, signal: controller.signal, onProgress: progress });
        }
      } else if (recovery) {
        await this.boundStoredTask(task);
        if (recovery.mode === 'audited_nondispatch') {
          if (!this.auditedRecoveryAvailable()) throw fail('RECOVERY_UNAVAILABLE', '服务端未发出凭证恢复尚未接通。', 503);
          const audit = recovery.trustedAudit;
          if (!audit || audit.reviewTaskId !== task.id || recovery.requestId !== `audited-position-${audit.witnessSHA256}`
            || audit.witnessSHA256 !== recovery.witnessSHA256) throw fail('RECOVERY_AUDIT_BINDING_INVALID', '保存的恢复凭证绑定无效。', 409);
          result = await this.adapter.recoverIndependentReviewPositionsAfterAuditedNonDispatch({ runDir: task.runDir, requestHash: task.requestHash,
            audit: structuredClone(audit), analyzePositionRepair: this.analyzePositionRepair, signal: controller.signal, onProgress: progress });
        } else result = await this.adapter.recoverIndependentReviewPositions({ runDir: task.runDir, requestHash: task.requestHash,
          mode: recovery.mode, ...(recovery.mode === 'position_repair' ? { analyzePositionRepair: this.analyzePositionRepair } : {}), signal: controller.signal, onProgress: progress });
        this.checkAdapterResult(task, result);
        if (['queued', 'interrupted'].includes(result.status) && !controller.signal.aborted) result = await this.adapter.resumeIndependentReview({ runDir: task.runDir, requestHash: task.requestHash, analyze: this.analyze, signal: controller.signal, onProgress: progress });
      } else result = task.runDir
        ? await this.adapter.resumeIndependentReview({ runDir: task.runDir, requestHash: task.requestHash, analyze: this.analyze, signal: controller.signal, onProgress: progress })
        : await this.adapter.startIndependentReview({ runRoot, request: structuredClone(task.frozen.request),
          ...(task.modelCitationMode !== undefined ? { modelCitationMode: task.modelCitationMode } : {}),
          analyze: this.analyze, signal: controller.signal, onProgress: progress });
      if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      this.checkAdapterResult(task, result);
      if (task.modelCitationMode !== undefined) await this.assertCitationMetadata({ ...task, runDir: result.runDir });
      task.status = result.status; task.runDir = result.runDir; task.result = structuredClone(result); task.report = structuredClone(result.report ?? null);
      task.progress = structuredClone(result.progress ?? task.progress); task.error = result.error ? structuredClone(result.error) : null;
      task.protocolVersion = result.versions?.protocolVersion ?? task.protocolVersion; task.rulesVersion = result.versions?.rulesVersion ?? task.rulesVersion; task.toolVersion = result.versions?.toolVersion ?? task.toolVersion;
    } catch (error) {
      task.status = controller.signal.aborted ? 'cancelled' : 'needs_attention';
      task.error = projectIndependentReviewFailure(error, controller.signal.aborted);
    } finally {
      if (recovery) { recovery.status = task.status; recovery.finishedAt = now(); recovery.resultError = structuredClone(task.error); delete task.pendingRecovery; }
      if (readingRetry) { readingRetry.status = task.status; readingRetry.finishedAt = now(); readingRetry.resultError = structuredClone(task.error); delete task.pendingInvalidReadingRetry; }
      task.updatedAt = now(); await this.saveTask(task); this.controllers.delete(task.id); this.busy = false; this.schedule();
    }
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
    if (old.invalidReadingRetries?.length && old.status !== 'interrupted') throw fail('REVIEW_RERUN_FORBIDDEN', '一次无效初读重读的原记录与新尝试均保留；不会新建任务补发。', 409);
    if (['needs_attention', 'complete', 'stale'].includes(old.status)) throw fail('REVIEW_RERUN_FORBIDDEN', '保留已有评阅与失败记录；不会重新生成已完成阶段或重抽判断。引文定位失败请使用恢复当前阶段。', 409);
    if (old.status === 'interrupted' && old.runDir) { old.status = 'queued'; old.error = null; old.updatedAt = now(); await this.saveTask(old); this.schedule(); return publicTask(old); }
    const task = { ...structuredClone(old), id: randomUUID(), requestId: `retry-${randomUUID()}`, linkedAttemptId: old.id, status: 'queued', createdAt: now(), updatedAt: now(), report: null, error: null, progress: { phase: 'queued', completedStages: 0, totalStages: old.progress.totalStages } };
    delete task.runDir; delete task.result;
    delete task.recoveries; delete task.pendingRecovery;
    task.sealedStageIds = [];
    await this.write(task.id, 'request.json', task.frozen); await this.saveTask(task); this.tasks.set(task.id, task); this.schedule(); return publicTask(task);
  }
  async close() { this.closed = true; for (const controller of this.controllers.values()) controller.abort(); while (this.busy) await new Promise(resolve => setTimeout(resolve, 5)); await Promise.allSettled(this.writes.values()); }
}

export function createIndependentReviewRouter({ service, json, bodyJSON }) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/independent-reviews')) return false;
    if (url.pathname === '/api/independent-reviews' && req.method === 'GET') { json(res, 200, { available: service.available(), versions: await service.versions(), readingFocusVersions: service.readingFocusVersions(), modelCitationModes: service.modelCitationModes(), tasks: await service.readList(url.searchParams.get('projectId')) }); return true; }
    if (url.pathname === '/api/independent-reviews' && req.method === 'POST') { json(res, 202, { task: await service.start(await bodyJSON(req)) }); return true; }
    const match = url.pathname.match(/^\/api\/independent-reviews\/([a-f0-9-]{36})(?:\/(cancel|retry|recover|retry-invalid-reading))?$/);
    if (match && req.method === 'GET' && !match[2]) { json(res, 200, { task: await service.read(match[1]) }); return true; }
    if (match && req.method === 'POST' && match[2]) { const body = await bodyJSON(req), action = match[2] === 'retry-invalid-reading' ? 'retryInvalidReading' : match[2];
      if (body && Object.hasOwn(body, 'modelCitationMode')) throw fail('MODEL_CITATION_IMMUTABLE', '已有评阅的证据定位方式已经冻结，不能在续跑或恢复时切换。', 409);
      json(res, match[2] === 'cancel' ? 200 : 202, { task: await service[action](match[1], body) }); return true; }
    throw fail('METHOD_NOT_ALLOWED', '这个独立评阅入口不支持当前操作。', 405);
  };
}
