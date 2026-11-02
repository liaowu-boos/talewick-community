import path from 'node:path';
import { ReviewEvidenceAuditService } from './review-evidence-audits.mjs';
import { projectBoundReviewEvidenceAudit } from './review-display-binding.mjs';

export const BOUND_EVIDENCE_AUDIT_ROOT = 'bound-review-evidence-audits-v1';
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const idOK = value => typeof value === 'string' && /^[\w-]{1,160}$/.test(value);
const denied = async () => { throw fail('AUDIT_LEGACY_READ_ONLY', '历史复核只读，不重新派发。'); };
const invariants = { automaticAdoption: false, literaryPass: 'NOT_COMPUTED', semanticAccuracyProven: false, originalReviewUnchanged: true };
const errorView = error => error ? { code: error.code || 'BOUND_PRODUCT_STOPPED', message: error.message || '复核未完成，原评阅保持原样。',
  ...(typeof error.JSONPointer === 'string' ? { JSONPointer: error.JSONPointer } : {}) } : null;

/** One public endpoint, two separate stores. This facade never calls legacy.start. */
export class ReviewEvidenceAuditFacade {
  constructor({ legacy, bound, reviews }) {
    Object.assign(this, { legacy, bound, reviews }); this.closed = false; this.mutations = Promise.resolve();
  }
  available() { return !this.closed && Boolean(this.legacy?.available() && this.bound?.available()
    && typeof this.bound.listWithProof === 'function'); }
  versions() {
    return { ...(this.legacy?.versions() ?? {}), execution: this.bound?.versions() ?? null };
  }
  async project(view, proof = null) {
    // read()/readProof() contain server-only packets, raw responses and derived wrappers.
    // Whitelist the public status; never spread either of those objects onto HTTP.
    const task = { id: view.id, projectId: view.projectId, sourceReviewTaskId: view.sourceReviewTaskId,
      status: view.status, createdAt: view.createdAt, updatedAt: view.updatedAt ?? view.createdAt,
      report: null, error: errorView(view.error), canonicalAuditComplete: false, completeEvidenceReview: false,
      executionVersion: this.bound.versions().bound, ...invariants };
    const batches = Array.isArray(view.batches) ? view.batches : [];
    task.batches = batches.map(batch => ({ batchId: batch.batchId, status: batch.status, error: errorView(batch.error) }));
    task.progress = { totalBatches: batches.length, completedBatches: batches.filter(b => ['validated', 'needs_attention'].includes(b.status)).length,
      failedBatches: batches.filter(b => b.status === 'needs_attention').length };
    if (!view.report) return task;
    try {
      if (view.report.representation !== 'derived_from_provider_raw_batches') throw fail('BOUND_PRODUCT_REPORT_WRAPPER', '复核结果包装未通过核对。');
      if (!proof || typeof proof.assembleBound !== 'function') throw fail('BOUND_PRODUCT_PROOF_INCOMPLETE', '复核的同次读取证明不完整。');
      const loaded = await this.reviews.readTask(view.sourceReviewTaskId);
      if (loaded.waiting || loaded.task?.status !== 'complete' || loaded.task.projectId !== view.projectId) throw fail('AUDIT_SOURCE_UNAVAILABLE', '来源评阅尚未通过核对。');
      const { display } = await projectBoundReviewEvidenceAudit({ sourceTask: loaded.task,
        boundPrepared: proof.boundPrepared, responses: proof.responses, savedAssembly: proof.savedAssembly, assembleBound: proof.assembleBound });
      if (view.status !== display.status || view.completeEvidenceReview !== display.completeEvidenceReview)
        throw fail('BOUND_PRODUCT_STATUS_BINDING', '运行器状态与严格回放不一致。');
      Object.assign(task, display);
    } catch (error) {
      task.status = 'needs_attention'; task.report = null; task.error = { code: error.code || 'AUDIT_PROJECTION_BINDING',
        message: '复核结果尚未通过来源与封存核对，原评阅保持原样。' };
      task.canonicalAuditComplete = false; task.completeEvidenceReview = false;
    }
    return task;
  }
  async list(id) {
    if (!idOK(id)) throw fail('AUDIT_SOURCE_ID', '评阅任务标识无效。', 400);
    let legacySnapshot, boundRead, boundSnapshot, unavailable = null;
    if (this.legacy) legacySnapshot = await this.legacy.list(id);
    else unavailable = '历史复核文件尚未在本机就绪；为避免重复派发，暂不发起新复核。';
    try { if (this.bound) { boundRead = await this.bound.listWithProof(id); boundSnapshot = boundRead.view; } }
    catch (error) { if (error.status === 404) throw error; unavailable = '复核记录尚未在本机就绪，原记录保留。'; }
    const oldTasks = legacySnapshot?.tasks ?? [];
    const newTasks = await Promise.all((boundRead?.entries ?? []).map(entry => this.project(entry.view, entry.proof)));
    return { available: this.available() && !unavailable, eligible: !unavailable && oldTasks.length === 0
      && Boolean(legacySnapshot?.eligible && boundSnapshot?.eligible),
      reason: unavailable ?? (oldTasks.length ? '已有复核记录，仅回放原记录，不因方法升级重新评阅。'
        : legacySnapshot?.reason ?? boundSnapshot?.error?.message ?? null),
      versions: this.versions(), tasks: [...oldTasks, ...newTasks] };
  }
  start(id, input) {
    const work = this.mutations.then(() => this.submit(id, input)); this.mutations = work.catch(() => {}); return work;
  }
  async submit(id, input) {
    if (!idOK(id) || !input || Array.isArray(input) || Object.keys(input).length !== 1 || !idOK(input.requestId))
      throw fail('AUDIT_INPUT_FIELDS', '只接收请求标识；正文、评语和复核结果由服务端核对。', 400);
    if (this.closed || !this.legacy) throw fail('AUDIT_HISTORY_UNAVAILABLE', '历史复核文件尚未就绪，未发起新复核。', 503);
    // Read the old store before touching the new namespace, including every failure.
    const history = await this.legacy.list(id);
    if (history.tasks.length) {
      const record = this.legacy.sourceRecords(id).find(row => row.requestId === input.requestId);
      return history.tasks.find(task => task.id === record?.id) ?? history.tasks[0];
    }
    if (!history.eligible) throw fail('AUDIT_SOURCE_INELIGIBLE', '当前完整评阅尚不满足复核条件，未派发模型。');
    if (!this.available()) throw fail('AUDIT_BOUND_UNAVAILABLE', '逐批依据复核尚未接通，未回退到旧方法。', 503);
    const prior = await this.bound.listWithProof(id);
    if (prior.entries.length) return this.project(prior.entries[0].view, prior.entries[0].proof);
    const accepted = await this.bound.start(id, input);
    // New registration returns queued status, not a completed response wrapper.
    return this.project(accepted);
  }
  async drain() { await this.mutations; await this.bound?.drain(); }
  async close() { this.closed = true; await this.mutations; await Promise.all([this.legacy?.close(), this.bound?.close()]); }
}

export async function createReviewEvidenceAuditFacade({ runsDir, reviews, adapter, boundAdapter, BoundService, model, runtimeDir }) {
  let legacy = null, bound = null;
  try { legacy = await new ReviewEvidenceAuditService({ rootDir: path.join(runsDir, 'review-evidence-audits'),
    reviews, adapter, analyze: denied }).init(); }
  catch { /* Optional unavailable history is never replaced; it disables new dispatch. */ }
  try { if (typeof BoundService === 'function') bound = await new BoundService({ rootDir: path.join(runsDir, BOUND_EVIDENCE_AUDIT_ROOT),
    reviews, adapter, boundAdapter, model, runtimeDir, maxTargetsPerBatch: 2 }).init(); }
  catch { /* Writing and original seven-stage reading remain available. */ }
  return new ReviewEvidenceAuditFacade({ legacy, bound, reviews });
}
