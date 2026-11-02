import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { SEMANTIC_EVIDENCE_AUDIT_MODEL_POLICY, SEMANTIC_EVIDENCE_AUDIT_STAGE } from './model-policy.mjs';
import { independentReviewFileState } from './independent-review-service.mjs';

export const PRODUCT_EVIDENCE_AUDIT_VERSION = 'review-evidence-audit-product-1';
export const PRODUCT_EVIDENCE_AUDIT_FORMAT_NORMALIZATION_VERSION = 'citation-check-reason-alias-1';
export const PRODUCT_EVIDENCE_AUDIT_POLICY_VERSION = 'fact-premise-decomposition-and-two-axes-3';
const LEGACY_AUDIT_POLICY = 'original-citation-and-whole-text-1';
const factAuditPolicies = new Set(['fact-subclaims-and-two-axes-2', PRODUCT_EVIDENCE_AUDIT_POLICY_VERSION]);
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => JSON.stringify(value, null, 2) + '\n';
const idOK = value => typeof value === 'string' && /^[\w-]{1,160}$/.test(value);
const shaOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const now = () => new Date().toISOString();
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const methods = ['prepareReviewEvidenceAudit', 'runReviewEvidenceAudit', 'readReviewEvidenceAudit', 'getReviewEvidenceAuditVersions'];
const states = new Set(['queued', 'running', 'complete', 'needs_attention', 'interrupted']);

/** Separate records and single-dispatch runner: original review files are read-only. */
export class ReviewEvidenceAuditService {
  constructor({ rootDir, reviews, adapter, analyze, fileState = independentReviewFileState }) {
    this.rootDir = path.resolve(rootDir); this.reviews = reviews; this.adapter = adapter; this.analyze = analyze;
    this.fileState = fileState; this.records = new Map(); this.jobs = new Set(); this.inFlight = new Set(); this.writes = new Map();
    this.mutations = Promise.resolve(); this.closed = false;
  }
  available() { return methods.every(key => typeof this.adapter?.[key] === 'function') && typeof this.analyze === 'function'; }
  versions() {
    if (typeof this.adapter?.getReviewEvidenceAuditVersions !== 'function'
      || !this.adapter.getReviewEvidenceAuditPolicyVersions?.().includes(PRODUCT_EVIDENCE_AUDIT_POLICY_VERSION)) return null;
    const versions = this.adapter.getReviewEvidenceAuditVersions({ auditPolicyVersion: PRODUCT_EVIDENCE_AUDIT_POLICY_VERSION });
    return versions?.policyVersion === PRODUCT_EVIDENCE_AUDIT_POLICY_VERSION ? versions : null;
  }
  async local(file) {
    const state = await this.fileState(file);
    if (!state.available) throw fail('AUDIT_LOCAL_FILE_WAIT', '复核记录尚未在本机就绪，原记录保持不变。');
    return readFile(file, 'utf8');
  }
  async directory(folder) {
    try { const info = await lstat(folder); if (!info.isDirectory() || info.isSymbolicLink()) throw fail('AUDIT_DIRECTORY_INVALID', '复核目录不是独立本地目录。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(folder, { recursive: true, mode: 0o700 }); }
  }
  async init() {
    await this.directory(this.rootDir); this.rootDir = await realpath(this.rootDir);
    for (const name of ['records', 'prepared', 'runs']) await this.directory(path.join(this.rootDir, name));
    for (const name of await readdir(path.join(this.rootDir, 'records'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      // Unavailable files are not opened or replaced. Optional audit service may fail closed.
      const record = JSON.parse(await this.local(path.join(this.rootDir, 'records', name)));
      this.assertRecord(record, name.slice(0, -5));
      this.records.set(record.id, record);
    }
    return this;
  }
  assertRecord(record, id) {
    if (!record || record.schemaVersion !== PRODUCT_EVIDENCE_AUDIT_VERSION || record.id !== id || !shaOK(id)
      || !idOK(record.projectId) || !idOK(record.sourceReviewTaskId) || !idOK(record.requestId)
      || !shaOK(record.sourceRequestHash) || !shaOK(record.inputHash) || !shaOK(record.preparedSHA256)
      || !states.has(record.status)) throw fail('AUDIT_RECORD_BINDING', '语义依据复核记录绑定无效。');
    if (Object.hasOwn(record, 'formatNormalizationVersion')
      && record.formatNormalizationVersion !== PRODUCT_EVIDENCE_AUDIT_FORMAT_NORMALIZATION_VERSION)
      throw fail('AUDIT_FORMAT_VERSION', '复核格式规则未被识别，原记录保持不变。');
    if (Object.hasOwn(record, 'auditPolicyVersion') && record.auditPolicyVersion !== LEGACY_AUDIT_POLICY && !factAuditPolicies.has(record.auditPolicyVersion))
      throw fail('AUDIT_POLICY_VERSION', '复核方法未被识别，原记录保持不变。');
    if (record.adapterRunDir) this.resolveRun(record.adapterRunDir);
  }
  resolveRun(relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')
      || !relative.startsWith('runs/')) throw fail('AUDIT_RUN_PATH', '复核运行目录不属于本次独立记录。');
    return path.join(this.rootDir, relative);
  }
  async prepared(record) {
    const text = await this.local(path.join(this.rootDir, 'prepared', `${record.id}.json`));
    if (hash(text) !== record.preparedSHA256) throw fail('AUDIT_PREPARED_BINDING', '冻结复核输入已改变，已停止读取。');
    const prepared = JSON.parse(text);
    if (prepared.requestHash !== record.id || prepared.inputHash !== record.inputHash || text !== bytes(prepared)
      || prepared.formatNormalizationVersion !== record.formatNormalizationVersion
      || prepared.versions?.policyVersion !== (record.auditPolicyVersion ?? LEGACY_AUDIT_POLICY))
      throw fail('AUDIT_PREPARED_BINDING', '复核输入身份或已保存的格式规则不一致。');
    return prepared;
  }
  savedOptions(record) {
    return { auditPolicyVersion: record.auditPolicyVersion, formatNormalizationVersion: record.formatNormalizationVersion };
  }
  async prepareSource(id, options = { auditPolicyVersion: PRODUCT_EVIDENCE_AUDIT_POLICY_VERSION,
    formatNormalizationVersion: PRODUCT_EVIDENCE_AUDIT_FORMAT_NORMALIZATION_VERSION }) {
    if (!idOK(id)) throw fail('AUDIT_SOURCE_ID', '评阅任务标识无效。', 400);
    const { auditPolicyVersion, formatNormalizationVersion } = options;
    if (auditPolicyVersion !== undefined && auditPolicyVersion !== LEGACY_AUDIT_POLICY
      && (!factAuditPolicies.has(auditPolicyVersion)
        || !this.adapter?.getReviewEvidenceAuditPolicyVersions?.().includes(auditPolicyVersion)))
      throw fail('AUDIT_POLICY_UNAVAILABLE', '新复核所需的方法尚未接通，已有记录保持不变。', 503);
    if (formatNormalizationVersion !== undefined && (formatNormalizationVersion !== PRODUCT_EVIDENCE_AUDIT_FORMAT_NORMALIZATION_VERSION
      || !this.adapter?.getReviewEvidenceAuditFormatNormalizationVersions?.().includes(formatNormalizationVersion)))
      throw fail('AUDIT_FORMAT_UNAVAILABLE', '新复核所需的格式校验规则尚未接通，已有记录保持不变。', 503);
    const source = await this.reviews.evidenceAuditSource(id);
    const prepared = await this.adapter.prepareReviewEvidenceAudit({ ...source,
      ...(auditPolicyVersion === undefined ? {} : { auditPolicyVersion }),
      ...(formatNormalizationVersion === undefined ? {} : { formatNormalizationVersion }) });
    if (!shaOK(prepared.requestHash) || !shaOK(prepared.inputHash)) throw fail('AUDIT_PREPARED_BINDING', '复核输入没有有效的冻结绑定。');
    if (prepared.formatNormalizationVersion !== formatNormalizationVersion) throw fail('AUDIT_FORMAT_BINDING', '复核输入未绑定请求的格式规则。');
    if (prepared.versions?.policyVersion !== (auditPolicyVersion ?? LEGACY_AUDIT_POLICY)
      || prepared.auditPolicyVersion !== (factAuditPolicies.has(auditPolicyVersion) ? auditPolicyVersion : undefined))
      throw fail('AUDIT_POLICY_BINDING', '复核输入未绑定保存的方法。');
    return { source, prepared };
  }
  sourceRecords(id) {
    return [...this.records.values()].filter(row => row.sourceReviewTaskId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async save(record, exclusive = false) {
    const target = path.join(this.rootDir, 'records', `${record.id}.json`), text = bytes(record);
    const work = (this.writes.get(record.id) ?? Promise.resolve()).then(async () => {
      if (exclusive) return writeFile(target, text, { flag: 'wx', mode: 0o600 });
      const state = await this.fileState(target);
      if (!state.available) throw fail('AUDIT_LOCAL_FILE_WAIT', '复核记录暂不可写，原文件保持不变。');
      const temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, text, { flag: 'wx', mode: 0o600 }); await rename(temp, target);
    });
    this.writes.set(record.id, work);
    try { await work; } finally { if (this.writes.get(record.id) === work) this.writes.delete(record.id); }
  }
  start(id, input) {
    const work = this.mutations.then(() => this.submit(id, input));
    this.mutations = work.catch(() => {}); return work;
  }
  async submit(id, input) {
    if (!input || Array.isArray(input) || Object.keys(input).join(',') !== 'requestId' || !idOK(input.requestId))
      throw fail('AUDIT_INPUT_FIELDS', '只接收请求标识；正文、评语和复核结果由服务端核对。', 400);
    if (this.closed || !this.available()) throw fail('AUDIT_UNAVAILABLE', '语义依据复核尚未接通，已有评阅保持原样。', 503);
    // An upgrade is not permission to ask again. Replays use the saved policy;
    // the fresh prepare below only verifies the current immutable source.
    const priorRows = this.sourceRecords(id);
    const prior = priorRows.find(row => row.requestId === input.requestId) ?? priorRows[0];
    if (prior) {
      const { source, prepared } = await this.prepareSource(id, this.savedOptions(prior));
      return this.project(prior, prepared, source);
    }
    const { source, prepared } = await this.prepareSource(id);
    if (this.records.has(prepared.requestHash)) throw fail('AUDIT_REQUEST_CONFLICT', '冻结复核标识已属于其他来源，未发起新复核。');
    const frozen = bytes(prepared), record = { schemaVersion: PRODUCT_EVIDENCE_AUDIT_VERSION,
      id: prepared.requestHash, projectId: source.projectId, sourceReviewTaskId: id, sourceRequestHash: source.sourceRequestHash,
      requestId: input.requestId, modelStage: SEMANTIC_EVIDENCE_AUDIT_STAGE, modelPolicy: SEMANTIC_EVIDENCE_AUDIT_MODEL_POLICY,
      formatNormalizationVersion: prepared.formatNormalizationVersion,
      auditPolicyVersion: prepared.auditPolicyVersion,
      inputHash: prepared.inputHash, preparedSHA256: hash(frozen), versions: prepared.versions,
      createdAt: now(), updatedAt: now(), status: 'queued', adapterRunDir: null, modelAttempts: [], error: null };
    // The immutable snapshot is written before queue acceptance. No browser import exists.
    const file = path.join(this.rootDir, 'prepared', `${record.id}.json`);
    try { await writeFile(file, frozen, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST' || await this.local(file) !== frozen) throw error; }
    await this.save(record, true); this.records.set(record.id, record);
    this.inFlight.add(record.id);
    const job = Promise.resolve().then(() => this.process(record)); this.jobs.add(job);
    void job.finally(() => { this.jobs.delete(job); this.inFlight.delete(record.id); }).catch(() => {});
    return this.project(record, prepared, source);
  }
  async process(record) {
    try {
      const { source, prepared } = await this.prepareSource(record.sourceReviewTaskId, this.savedOptions(record));
      if (source.projectId !== record.projectId || source.sourceRequestHash !== record.sourceRequestHash
        || prepared.requestHash !== record.id || hash(bytes(prepared)) !== record.preparedSHA256)
        throw fail('AUDIT_SOURCE_CHANGED', '原评阅或冻结复核输入已改变，未发起复核。');
      record.status = 'running'; record.updatedAt = now(); await this.save(record);
      const update = async progress => {
        if (progress?.requestHash && progress.requestHash !== record.id) throw fail('AUDIT_PROGRESS_BINDING', '复核进度绑定不一致。');
        if (progress?.runDir) {
          const relative = path.relative(this.rootDir, progress.runDir); this.resolveRun(relative); record.adapterRunDir = relative;
        }
        record.updatedAt = now(); await this.save(record);
      };
      const result = await this.adapter.runReviewEvidenceAudit({ prepared, runRoot: path.join(this.rootDir, 'runs'),
        analyze: async call => {
          try { return await this.analyze({ ...call, onAttempt: async attempt => {
            record.modelAttempts.push(structuredClone(attempt)); record.updatedAt = now(); await this.save(record);
          } }); }
          catch (error) {
            if (error.receipt) { record.failureReceipt = structuredClone(error.receipt); await this.save(record); }
            throw error;
          }
        }, onProgress: update });
      await update(result);
      if (!['complete', 'needs_attention'].includes(result?.status)) throw fail('AUDIT_RESULT_STATUS', '复核未返回可核对的终态，已停止补发。');
      record.status = result.status; record.error = result.error ?? null; record.updatedAt = now(); await this.save(record);
    } catch (error) {
      record.status = 'needs_attention'; record.error = { code: error.code || 'AUDIT_STOPPED', message: error.message || '复核未完成，原记录均保留。' };
      record.updatedAt = now(); await this.save(record);
    }
  }
  async project(record, currentPrepared, source) {
    const view = { id: record.id, projectId: record.projectId, sourceReviewTaskId: record.sourceReviewTaskId,
      status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt, report: null, error: record.error ?? null,
      automaticAdoption: false, literaryPass: 'NOT_COMPUTED', originalReviewUnchanged: true,
      ...(record.auditPolicyVersion === undefined ? {} : { auditPolicyVersion: record.auditPolicyVersion }),
      ...(record.formatNormalizationVersion === undefined ? {} : { formatNormalizationVersion: record.formatNormalizationVersion }) };
    try {
      const saved = await this.prepared(record);
      // Full source bytes/bindings must still match. Audit policy/tool hashes may
      // differ after an upgrade; the runner strictly validates the saved input.
      if (currentPrepared && (!saved.sourceSnapshot || !saved.binding
        || !isDeepStrictEqual(saved.sourceSnapshot, currentPrepared.sourceSnapshot)
        || !isDeepStrictEqual(saved.binding, currentPrepared.binding)
        || (source && (source.projectId !== record.projectId || source.sourceRequestHash !== record.sourceRequestHash))))
        throw fail('AUDIT_SOURCE_CHANGED', '原评阅与复核记录不再绑定，已停止展示结果。');
      if (record.adapterRunDir && typeof this.adapter?.readReviewEvidenceAudit === 'function') {
        const runDir = this.resolveRun(record.adapterRunDir);
        if (hash(await this.local(path.join(runDir, 'input.json'))) !== record.preparedSHA256)
          throw fail('AUDIT_RUN_INPUT_BINDING', '运行器输入与产品冻结输入不一致，已停止展示。');
        const replay = await this.adapter.readReviewEvidenceAudit({ runDir, requestHash: saved.requestHash });
        if (replay.requestHash !== record.id || replay.inputHash !== record.inputHash || replay.sourceReviewTaskId !== record.sourceReviewTaskId)
          throw fail('AUDIT_RUN_BINDING', '严格回放未绑定当前保存的复核记录。');
        if (replay.status === 'complete') {
          const report = replay.report;
          if (report?.requestHash !== record.id || report?.sourceReviewTaskId !== record.sourceReviewTaskId
            || report?.sourceRequestHash !== record.sourceRequestHash || report?.automaticAdoption !== false
            || report?.literaryPass !== 'NOT_COMPUTED' || report?.originalReviewUnchanged !== true)
            throw fail('AUDIT_REPORT_BINDING', '复核结果未绑定原评阅。');
          view.status = 'complete'; view.report = report; view.error = null;
          view.targets = saved.packet.targets.map(({ targetId, kind, readerId, original, originalCitations, claimSources }) => ({ targetId, kind, readerId, original, originalCitations,
            ...(Array.isArray(claimSources) ? { claimSources } : {}) }));
        }
        else if (replay.status === 'needs_attention' && !this.inFlight.has(record.id)) { view.status = 'needs_attention'; view.error = replay.error ?? view.error; }
      }
      if (['queued', 'running'].includes(view.status) && !this.inFlight.has(record.id)) {
        view.status = 'interrupted'; view.error = { code: 'AUDIT_INTERRUPTED', message: '复核运行已中断，原现场保留；不会自动重发。' };
      }
    } catch (error) { view.status = 'needs_attention'; view.report = null; view.error = { code: error.code || 'AUDIT_REPLAY_FAILED', message: '复核记录尚未通过绑定核对，原评阅保持原样。' }; }
    return view;
  }
  async list(id) {
    let current, source, eligible = false, reason = null;
    const records = this.sourceRecords(id);
    try {
      if (!methods.every(key => typeof this.adapter?.[key] === 'function')) throw fail('AUDIT_UNAVAILABLE', '语义依据复核尚未接通。', 503);
      ({ source, prepared: current } = await this.prepareSource(id, records.length ? this.savedOptions(records[0]) : undefined)); eligible = true;
    } catch (error) { if (error.status === 404) throw error; reason = error.message || '当前评阅尚不满足复核条件。'; }
    const tasks = await Promise.all(records.map(async row => {
        if (!eligible) return { ...(await this.project(row)), status: 'needs_attention', report: null, targets: [],
          error: { code: 'AUDIT_SOURCE_UNAVAILABLE', message: '来源评阅尚未通过核对，复核结果暂不可展示。' } };
        if (row.auditPolicyVersion === records[0]?.auditPolicyVersion && row.formatNormalizationVersion === records[0]?.formatNormalizationVersion)
          return this.project(row, current, source);
        try {
          const own = await this.prepareSource(id, this.savedOptions(row));
          return this.project(row, own.prepared, own.source);
        } catch {
          return { ...(await this.project(row)), status: 'needs_attention', report: null, targets: [],
            error: { code: 'AUDIT_SOURCE_UNAVAILABLE', message: '来源评阅尚未通过核对，复核结果暂不可展示。' } };
        }
      }));
    return { available: this.available(), eligible, reason, versions: this.versions(), tasks };
  }
  async close() { this.closed = true; await this.mutations; await Promise.allSettled([...this.jobs, ...this.writes.values()]); }
}

export function createReviewEvidenceAuditRouter({ service, json, bodyJSON, canRun }) {
  return async (req, res, url) => {
    const match = url.pathname.match(/^\/api\/independent-reviews\/([\w-]{1,160})\/evidence-audits$/);
    if (!match) return false;
    if (!service) throw fail('AUDIT_UNAVAILABLE', '语义依据复核文件尚未就绪，写作和原评阅仍可使用。', 503);
    if (req.method === 'GET') { json(res, 200, await service.list(match[1])); return true; }
    if (req.method === 'POST') {
      if (!canRun()) throw fail('AUDIT_MODEL_UNAVAILABLE', '模型尚未配置，语义依据复核没有启动。', 503);
      json(res, 202, { task: await service.start(match[1], await bodyJSON(req)) }); return true;
    }
    throw fail('AUDIT_METHOD', '这个复核入口不支持当前操作。', 405);
  };
}
