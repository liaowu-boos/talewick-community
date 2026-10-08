export type Completeness = 'full' | 'first_four' | 'unknown';
export interface SourceSummary {
  contractVersion: 'v04-contract-1'; sourceId: string; title: string; fileName: string;
  activeRevisionId?: string; duplicateOf?: string; sourceSha256: string; textVersion: string; completeness: Completeness;
  status: 'deferred' | 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'interrupted' | 'cancelled';
  deferred?: boolean;
  /** Explicit data-layer index-only work; absence preserves legacy behavior. */
  processingStage?: 'index';
  indexStatus: 'pending' | 'ready' | 'failed' | 'stale';
  progress: { completed: number; total: number | null; label: string };
  createdAt: string; updatedAt: string; error?: { code: string; message: string; retryable: boolean };
}
export interface AnalysisDiagnostic { code: string; path: string; message: string; lineStart?: number; lineEnd?: number }
export const reviewCheckLabels = {
  fact_attribution: '事实归属', inference_strength: '推断强度', evidence_scope: '引用及摘要范围',
  cross_unit_links: '跨单元联系', text_scope: '文本范围', reader_effect_hypothesis: '读者作用假说',
};
export const reviewCheckStatusLabels = { passed: '通过', needs_revision: '需修订', not_applicable: '不适用' };
export interface ReviewCheck {
  id: keyof typeof reviewCheckLabels; status: keyof typeof reviewCheckStatusLabels; notes: string[]; unitIds: string[];
}
export interface SourceDetail extends SourceSummary {
  revisionCount?: number;
  analysisDraft?: { responseVersion: string; textVersion: string; candidate: unknown; diagnostics: AnalysisDiagnostic[]; createdAt: string };
  analysis?: { version: string; textVersion: string; coverage: { scope: Completeness; notes: string[] };
    validation?: { semanticReview?: { recordId: string; sourceId: string; textVersion: string; analysisVersion: string; approved: boolean; diagnostics?: AnalysisDiagnostic[]; rubricVersion?: string; checks?: ReviewCheck[]; outcome?: 'approved' | 'rejected' | 'failed'; notes: string[]; reviewedAt: string; method: string } };
    reviewStatus: 'candidate' | 'checked' | 'needs_review'; overview: string; limitations: string[];
    units: { id: string; title: string; locator: { lineStart: number; lineEnd: number }; event: string;
      psychology: string; emotion: string; expression: string; readerEffectHypothesis: string;
      evidence: { quote: string; lineStart: number; lineEnd: number }[]; relatedUnitIds: string[] }[] };
}
export interface SourceText { sourceId: string; textVersion: string; sourceSha256: string; text: string; encoding: string }
const base = '/api/library/sources';
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(typeof body.error === 'string' ? body.error : body.error?.message || '资料服务暂时无法访问，请重试。'), { code: typeof body.error?.code === 'string' ? body.error.code : undefined, httpStatus: response.status });
  return body;
}
export const libraryAPI = {
  list: (cursor?: string, signal?: AbortSignal) => request<{ items: SourceSummary[]; nextCursor: string | null }>(`${base}?limit=40${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }),
  get: (id: string, signal?: AbortSignal) => request<{ source: SourceDetail }>(`${base}/${encodeURIComponent(id)}?analysis=1`, { signal }),
  text: (id: string, version: string, signal?: AbortSignal) => request<{ source: SourceText }>(`${base}/${encodeURIComponent(id)}/text?version=${encodeURIComponent(version)}`, { signal }),
  retryRevisionReview: (id: string, revisionId: string, expectedAnalysisVersion: string, signal?: AbortSignal) => request<{ attempt: RevisionSummary }>(`${base}/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/review`, { method: 'POST', signal, body: JSON.stringify({ expectedAnalysisVersion }) }),
  revisions: (id: string, signal?: AbortSignal) => request<{ items: RevisionSummary[] }>(`${base}/${encodeURIComponent(id)}/revisions`, { signal }),
  revision: (id: string, revisionId: string, signal?: AbortSignal) => request<{ attempt: RevisionDetail }>(`${base}/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}`, { signal }),
  revise: (id: string, expectedAnalysisVersion: string, instructions: string, signal?: AbortSignal) => request<{ attempt: RevisionSummary }>(`${base}/${encodeURIComponent(id)}/revisions`, { method: 'POST', signal, body: JSON.stringify({ expectedAnalysisVersion, instructions }) }),
  historicalAnalysis: (id: string, version: string, signal?: AbortSignal) => request<{ source: { analysis: NonNullable<SourceDetail['analysis']> } }>(`${base}/${encodeURIComponent(id)}/analysis?version=${encodeURIComponent(version)}`, { signal }),
  action: (id: string, action: 'retry' | 'cancel', stage?: 'analysis' | 'index', signal?: AbortSignal) => request<{ source: SourceDetail }>(`${base}/${encodeURIComponent(id)}/${action}`, { method: 'POST', signal, body: JSON.stringify(stage ? { stage } : {}) }),
  async upload(file: File, completeness: Completeness, requestId: string) {
    if (file.size > 128_000) throw new Error('当前拆解服务每篇最多 128,000 字节、24,000 字符，请减少文件大小后重试。');
    if (!/\.(txt|md)$/i.test(file.name)) throw new Error('请选择 TXT 或 Markdown 文件。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return request<{ source: SourceDetail }>(base, { method: 'POST', body: JSON.stringify({ requestId, fileName: file.name, contentBase64: btoa(binary), completeness, sourceNote: '' }) });
  },
};
export const indexRebuildActive = (source: SourceSummary) => source.processingStage === 'index' && !source.activeRevisionId && ['queued', 'running'].includes(source.status);
export const sourceStatus = (source: SourceSummary) => source.activeRevisionId && ['queued', 'running'].includes(source.status) ? (source.status === 'queued' ? '等待修订' : '修订处理中') : indexRebuildActive(source) ? (source.status === 'queued' ? '等待重建索引' : '正在重建索引') : ({ deferred: '已登记，等待开始', queued: '等待拆解', running: '正在拆解', completed: '拆解完成', partial: '已保存部分结果', failed: '拆解失败', interrupted: '拆解已中断', cancelled: '已取消' })[source.status];

export const canCancelSource = (source: SourceSummary) => ['deferred', 'queued', 'running'].includes(source.status);
export function canRetryAnalysis(source: SourceDetail, batchManaged = false) {
  const review = source.analysis?.validation?.semanticReview;
  return !batchManaged && !source.deferred && !source.revisionCount && source.error?.retryable !== false
    && !(review && !review.approved && review.outcome !== 'failed') && source.indexStatus !== 'stale'
    && ['failed', 'interrupted', 'cancelled', 'partial'].includes(source.status);
}

// Drafts are never evidence of an indexable analysis.
export function canRetryIndex(source: SourceDetail) {
  return Boolean(source.analysis) && !source.deferred && !['deferred', 'queued', 'running'].includes(source.status) && ['failed', 'stale'].includes(source.indexStatus);
}
export function failureStage(source: SourceDetail) {
  if (['deferred', 'queued', 'running'].includes(source.status)) return sourceStatus(source);
  if (source.analysisDraft) return '拆解校验未通过';
  const review = source.analysis?.validation?.semanticReview;
  if (review?.outcome === 'failed') return review.diagnostics?.some(d => d.code === 'REVIEW_INVALID_JSON') ? '复核响应格式错误' : '复核处理失败';
  if (review && !review.approved) return '复核未通过';
  if (source.error?.code === 'INVALID_ANALYSIS' && !source.analysis) return '拆解校验未通过';
  if (source.analysis && source.indexStatus === 'failed') return '索引未完成';
  return sourceStatus(source);
}
// Display only reader-facing fields; never dump raw JSON, prompts or markup.
export function candidateText(candidate: unknown): string {
  if (typeof candidate === 'string') return '候选内容未形成可展示的结构，请查看诊断后重试拆解。';
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return '暂无可展示的候选内容。';
  const value = candidate as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof value.overview === 'string') lines.push(value.overview);
  if (Array.isArray(value.units)) for (const unit of value.units) {
    if (!unit || typeof unit !== 'object') continue;
    for (const [key, label] of [['title', '单元'], ['event', '事件'], ['psychology', '心理'], ['emotion', '情绪'], ['expression', '表达'], ['readerEffectHypothesis', '读者感受假设']]) {
      if (typeof unit[key] === 'string') lines.push(`${label}：${unit[key]}`);
    }
    if (Array.isArray(unit.evidence)) for (const evidence of unit.evidence) {
      if (!evidence || typeof evidence !== 'object') continue;
      if (value.evidenceMode === 'source-lines-v1') {
        if (Number.isInteger(evidence.lineStart) && Number.isInteger(evidence.lineEnd)) lines.push(`未核对引用位置：原文第 ${evidence.lineStart}–${evidence.lineEnd} 行（范围尚未通过校验）`);
      } else if (typeof evidence.quote === 'string') lines.push(`未核对引文：${evidence.quote}`);
    }
  }
  return lines.join('\n\n') || '暂无可展示的候选内容，请查看诊断。';
}
export function diagnosticText(diagnostic: AnalysisDiagnostic) {
  const unit = /units\[(\d+)\]|units\.(\d+)/.exec(diagnostic.path);
  const location = unit ? `第 ${Number(unit[1] ?? unit[2]) + 1} 个分析单元` : '分析内容';
  const range = diagnostic.lineStart === undefined ? '' : `，原文第 ${diagnostic.lineStart}${diagnostic.lineEnd === undefined ? '' : `–${diagnostic.lineEnd}`} 行`;
  return `${location}${range}：${diagnostic.message}`;
}

export interface RevisionSummary {
  kind?: 'analysis_revision' | 'review_only'; derivedFromRevisionId?: string; canRetryReview?: boolean;
  revisionId: string; parentAnalysisVersion: string; analysisVersion?: string; textVersion: string;
  status: 'queued' | 'running' | 'reviewing' | 'approved' | 'needs_review' | 'rejected' | 'failed' | 'cancelled' | 'interrupted' | 'published';
  createdAt: string; updatedAt: string;
}
export interface RevisionDetail extends RevisionSummary { inputCandidateFingerprint?: string; instructions: string; candidate?: unknown; diagnostics: AnalysisDiagnostic[]; error?: {code:string;message:string} }
export const revisionStatus = {queued:'等待修订',running:'正在修订分析',reviewing:'正在复核修订',approved:'复核通过，等待发布',needs_review:'候选待复核，未发布',rejected:'修订复核未通过，未发布',failed:'修订处理失败，未发布',cancelled:'修订已取消',interrupted:'修订已中断',published:'修订已发布'};
export const revisionActive = (status: RevisionSummary['status']) => ['queued','running','reviewing','approved'].includes(status);

// A structured 4xx response explicitly rejects acceptance; transport/5xx failures may be ambiguous.
export function revisionRequestRejected(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const error = reason as { code?: unknown; httpStatus?: unknown };
  return (error.code === 'REVIEW_UNAVAILABLE' && error.httpStatus === 503) || typeof error.code === 'string' && typeof error.httpStatus === 'number' && error.httpStatus >= 400 && error.httpStatus < 500;
}

export const revisionLabel = (attempt: RevisionSummary) => attempt.kind === 'review_only' && ['queued', 'running', 'reviewing'].includes(attempt.status) ? (attempt.status === 'queued' ? '等待再次复核' : '正在再次复核') : revisionStatus[attempt.status];

export type BatchActionKey = 'run' | 'recover' | `cancel:${string}`;
export interface BatchCounts {
  registered: number; queued: number; running: number; completed: number; checked: number;
  needs_review: number; failed: number; cancelled: number; recoveryRequired: number;
}
export interface LibraryBatch extends BatchCounts {
  batchId: string;
  items: { source: { sourceId: string }; cancelRequested: boolean; recoveryRequired: boolean }[];
}
export interface BatchProgress extends BatchCounts {
  targetCount: number; batchSize: number; batches: LibraryBatch[];
  halted: boolean; closing: boolean; closed: boolean; requiresReopen: boolean;
  drainStatus: 'not_requested' | 'pending' | 'complete' | 'failed';
  registrations: { batchId: string; saved: number; sources: ({ sourceId: string } | null)[] }[];
}
export interface BatchPublicError { code: string; message: string }
export interface BatchResponse {
  queue: BatchProgress;
  actions: Partial<Record<BatchActionKey, { status: 'running' | 'completed' | 'failed'; startedAt: string; finishedAt?: string; error?: BatchPublicError }>>;
}
export interface BatchImport {
  batchId: string;
  sources: { requestId: string; fileName: string; contentBase64: string; completeness: Completeness; sourceNote: string }[];
}

// Only this error class and the router's public error projection may reach the batch UI.
class BatchRequestError extends Error {}
export const batchPublicMessage = (error?: BatchPublicError) => typeof error?.code === 'string' && typeof error.message === 'string'
  ? error.message : '批量操作未完成，已保存的资料和记录保留。';
export const batchErrorMessage = (error: unknown) => error instanceof BatchRequestError ? error.message : '暂时无法确认批量任务状态，请刷新核对；已保存的资料保留。';

export async function prepareBatchImport(files: File[], completeness: Completeness): Promise<BatchImport> {
  if (files.length !== 10) throw new BatchRequestError('每批请恰好选择 10 份文件；尚未登记或开始拆解。');
  for (const file of files) {
    if (!/\.(txt|md)$/i.test(file.name)) throw new BatchRequestError('请选择 TXT 或 Markdown 文件；本批尚未登记。');
    if (!file.size || file.size > 128_000) throw new BatchRequestError('每份文件须非空且不超过 128,000 字节、24,000 字符；本批尚未登记。');
  }
  const batchId = crypto.randomUUID();
  const sources = await Promise.all(files.map(async file => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { requestId: crypto.randomUUID(), fileName: file.name, contentBase64: btoa(binary), completeness, sourceNote: '' };
  }));
  if (new Set(sources.map(source => source.contentBase64)).size !== 10) throw new BatchRequestError('选中的文件包含相同原文，请更换后再登记；重复文件不能计入 10 篇。');
  return { batchId, sources };
}

const batchBase = '/api/library/batches';
async function batchRequest(options: RequestInit, path = ''): Promise<BatchResponse> {
  const response = await fetch(`${batchBase}${path}`, { ...options, headers: { 'Content-Type': 'application/json' } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new BatchRequestError(batchPublicMessage(body?.error));
  if (!body?.queue || !Array.isArray(body.queue.batches) || !Array.isArray(body.queue.registrations) || !body.actions)
    throw new BatchRequestError('批量状态尚未读取完整，请刷新核对。');
  return body;
}
export const libraryBatchAPI = {
  progress: (signal?: AbortSignal) => batchRequest({ signal }),
  register: (payload: BatchImport) => batchRequest({ method: 'POST', body: JSON.stringify(payload) }),
  action: (key: BatchActionKey) => batchRequest({ method: 'POST', body: '{}' }, key.startsWith('cancel:') ? `/${encodeURIComponent(key.slice(7))}/cancel` : `/${key}`),
};

// Synchronous reservations also cover two clicks before React has rendered a disabled button.
export function createBatchRequestGate() {
  const pending = new Set<string>();
  let revision = 0;
  return {
    pending,
    revision: () => revision,
    begin(key: string) { if (pending.has(key)) return null; pending.add(key); return ++revision; },
    finish(key: string) { pending.delete(key); revision++; },
    accepts(ticket: number) { return ticket === revision; },
  };
}

export function batchActionAllowed(state: BatchResponse | null, key: BatchActionKey, pending: readonly string[] = [], stale = false): boolean {
  if (!state || stale || pending.includes(key)) return false;
  const { queue, actions } = state;
  const active = (action: string) => pending.includes(action) || actions[action as BatchActionKey]?.status === 'running';
  if (queue.closed || queue.closing || queue.requiresReopen || queue.drainStatus === 'failed' || active(key)) return false;
  if (key.startsWith('cancel:')) {
    const batch = queue.batches.find(value => value.batchId === key.slice(7));
    return !active('recover') && Boolean(batch && (batch.queued + batch.running > 0 || batch.recoveryRequired > 0));
  }
  if (pending.length || Object.values(actions).some(action => action?.status === 'running') || queue.running) return false;
  if (key === 'run') return !queue.halted && queue.recoveryRequired === 0 && queue.queued > 0;
  return queue.batches.length > 0;
}
export function batchRegistrationAllowed(state: BatchResponse | null, pending: readonly string[] = [], stale = false, continuingBatchId?: string) {
  return Boolean(state && !stale && !pending.length && !Object.values(state.actions).some(action => action?.status === 'running')
    && !state.queue.running && !state.queue.halted && !state.queue.closed && !state.queue.closing
    && !state.queue.requiresReopen && state.queue.drainStatus !== 'failed'
    && (state.queue.registrations.length < 10 || state.queue.registrations.some(batch => batch.batchId === continuingBatchId)));
}
export function batchStateLabel(batch: BatchCounts, activeRun = false, cancelling = false): string {
  if (cancelling) return '正在取消，等待后台结束';
  if (batch.recoveryRequired) return '已中断，待恢复核对';
  if (batch.running) return '进行中';
  if (batch.queued) return activeRun ? '等待处理' : '已登记，等待开始';
  if (batch.failed) return '有失败，记录已保留';
  if (batch.needs_review) return '有待修订结果';
  if (batch.cancelled) return batch.cancelled === batch.registered ? '已取消' : '已结束，部分取消';
  return batch.checked === batch.registered && batch.registered > 0 ? '已完成并通过复核' : '结果待核对';
}
export function batchCountsText(counts: BatchCounts) {
  return `已登记 ${counts.registered} 篇 · 等待 ${counts.queued} · 进行 ${counts.running} · 完成 ${counts.checked} · 待修订 ${counts.needs_review} · 失败 ${counts.failed} · 取消 ${counts.cancelled}`;
}
