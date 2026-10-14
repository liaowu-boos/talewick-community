import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const CONTRACT_VERSION = 'v04-contract-1';
export const MAX_SOURCE_BYTES = 1024 * 1024;
const summaries = ['contractVersion', 'activeRevisionId', 'duplicateOf', 'sourceId', 'title', 'fileName', 'sourceSha256', 'textVersion', 'completeness', 'status', 'indexStatus', 'processingStage', 'progress', 'createdAt', 'updatedAt', 'error'];
const errors = {
  REVIEW_RETRY_NOT_ALLOWED: [409, '这次尝试目前不能仅重试复核。请刷新历史核对资格；内容需要修改时请创建新修订。', false],
  REVIEW_UNAVAILABLE: [503, '复核服务尚不可用，本次未创建尝试。请联系本机服务管理者检查复核配置。', false],
  VERSION_CONFLICT: [409, '当前分析版本已变化，请刷新详情并核对后重新提交修订。输入意见已保留。', false],
  REVISION_NOT_FOUND: [404, '找不到这次修订，请刷新修订历史。', false],
  VERSIONED_REVISION_REQUIRED: [409, '已有修订历史，请查看具体尝试的可用操作；符合条件时可仅重试复核，内容修改请新建修订。', false],
  INVALID_ENCODING: [400, '文字编码无效，请使用 UTF-8 或带 BOM 的 UTF-16 文本。', false],
  INVALID_QUERY: [400, '材料查询格式不正确。', false],
  REQUEST_CONFLICT: [409, '该上传请求已用于不同内容，请重新选择文件。', false],
  TASK_BUSY: [409, '这份资料仍在处理中，请等待或取消后重试。', true],
  REVIEW_REJECTED: [409, '语义复核未通过，原文、分析与复核意见已保留；此状态不支持直接重试拆解。', false],
  ANALYSIS_REQUIRED: [409, '请先完成拆解，再加入检索。', true],
  CANCELLED: [409, '操作已取消，已保存内容保留。', false],
  INPUT_TOO_LARGE: [413, '当前拆解服务每篇最多 128,000 字节、24,000 字符，请减少文本长度。', false],
  CAPACITY_EXCEEDED: [413, '资料库容量已达上限，本次未导入。', false],
  SERVICE_CLOSED: [503, '资料服务已关闭，请重启后台后重试。', true],
  STORAGE_FAILED: [503, '资料保存失败，请检查后台存储后重试。', true],
  SOURCE_BINDING: [503, '原文版本校验失败，暂时无法读取或检索。', true],
  STORE_BUSY: [409, '资料目录已由另一服务使用。', true],
  STORE_VERSION: [503, '此资料库版本暂不兼容，请保留原目录并使用对应服务。', false],
  INVALID_ANALYSIS: [503, '拆解或复核格式校验未通过；已保存内容保留，请展开详情查看诊断与恢复方式。', true],
  PROCESSING_FAILED: [503, '拆解处理失败，已保留完成部分，可重试。', true],
  INTERRUPTED: [503, '拆解已中断，已保存内容保留，可重试。', true],
  INVALID_INPUT: [400, '资料请求格式不正确。', false],
  INVALID_CURSOR: [400, '资料分页位置无效，请刷新列表。', false],
  NOT_FOUND: [404, '找不到这份资料或指定版本。', false],
  SOURCE_NOT_FOUND: [404, '找不到这份资料。', false],
  VERSION_NOT_FOUND: [404, '找不到这个原文版本。', false],
  CONFLICT: [409, '请求与已保存资料冲突，请刷新后重试。', false],
  REQUEST_ID_CONFLICT: [409, '上传请求已用于另一份内容。', false],
  FILE_TOO_LARGE: [413, '单篇资料不能超过 1 MiB，请缩小文件。', false],
  LIBRARY_UNAVAILABLE: [503, '资料拆解服务尚未接入或暂不可用。', true],
  MODEL_UNAVAILABLE: [503, '分析模型暂不可用，请检查后台配置。', true],
  INDEX_UNAVAILABLE: [503, '资料索引暂不可用。', true],
};
function issue(code) { return Object.assign(new Error(code), { code }); }
function publicError(error) {
  const code = Object.hasOwn(errors, error?.code) ? error.code : 'LIBRARY_UNAVAILABLE';
  const [status, message, retryable] = errors[code];
  return { status, error: { code, message, retryable } };
}
function summary(source) {
  const result = Object.fromEntries(summaries.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  if (result.error) result.error = publicError(result.error).error;
  if (source.analysisDraft && result.error?.code === 'INVALID_ANALYSIS') result.error.message = '拆解结构或引文定位未通过校验，候选和诊断已保存，可在详情中查看并重试拆解。';
  return result;
}
function detail(source, includeAnalysis) {
  return { ...summary(source), ...(includeAnalysis && source.analysis ? { analysis: source.analysis } : {}), ...(includeAnalysis && source.analysisDraft ? { analysisDraft: source.analysisDraft } : {}) };
}
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw issue('INVALID_INPUT'); return value; }
function string(value, max, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim()) || /[\u0000]/u.test(value)) throw issue('INVALID_INPUT');
  return value;
}
export function decodeImport(body) {
  object(body);
  const requestId = string(body.requestId, 160);
  if (!/^[\w-]+$/.test(requestId)) throw issue('INVALID_INPUT');
  const fileName = string(body.fileName, 255);
  if (/[\\/\r\n]/.test(fileName) || fileName === '.' || fileName === '..') throw issue('INVALID_INPUT');
  const completeness = body.completeness ?? 'unknown';
  if (!['full', 'first_four', 'unknown'].includes(completeness)) throw issue('INVALID_INPUT');
  const sourceNote = string(body.sourceNote, 2000, true);
  const encoded = body.contentBase64;
  if (typeof encoded !== 'string') throw issue('INVALID_INPUT');
  if (encoded.length > 4 * Math.ceil(MAX_SOURCE_BYTES / 3)) throw issue('FILE_TOO_LARGE');
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw issue('INVALID_INPUT');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_SOURCE_BYTES) throw issue('FILE_TOO_LARGE');
  if (bytes.toString('base64') !== encoded) throw issue('INVALID_INPUT');
  return { requestId, fileName, completeness, sourceNote, bytes };
}

/** Missing peer module is an explicit unavailable state; import/startup bugs still surface. */
export async function loadLibraryService({ rootDir, model, processingConcurrency = 2, narrativeObservationProjector,
  moduleURL = new URL('../../../data/runtime/library.mjs', import.meta.url), relevanceModuleURL = new URL('./relevance.mjs', moduleURL) }) {
  if (narrativeObservationProjector !== undefined && typeof narrativeObservationProjector !== 'function') throw new TypeError('Data narrative observation projector must be a function');
  try { await access(moduleURL); } catch (error) { if (error.code === 'ENOENT') return { library: null, available: false }; throw error; }
  const { createLibraryService } = await import(moduleURL.href || moduleURL);
  if (typeof createLibraryService !== 'function') throw new TypeError('Data library must export createLibraryService');
  const { createRelevanceAssessor } = await import(relevanceModuleURL.href || relevanceModuleURL);
  if (typeof createRelevanceAssessor !== 'function') throw new TypeError('Data relevance must export createRelevanceAssessor');
  const assessRelevance = createRelevanceAssessor({ model });
  if (typeof assessRelevance !== 'function') throw new TypeError('Data relevance assessor must be a function');
  const library = await createLibraryService({ rootDir, model, assessRelevance, processingConcurrency,
    ...(narrativeObservationProjector ? { narrativeObservationProjector } : {}) });
  for (const method of ['importSource', 'list', 'get', 'readSource', 'retry', 'cancel', 'retrieve', 'close']) {
    if (typeof library?.[method] !== 'function') throw new TypeError(`Data library missing ${method}`);
  }
  return { library, available: true };
}

export function createRetrieveKnowledge(library) {
  return async (query, { signal } = {}) => {
    signal?.throwIfAborted();
    if (library) {
      try { const result = await library.retrieve(query, { signal }); signal?.throwIfAborted(); return result; }
      catch (error) { if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'CANCELLED') throw signal?.reason ?? error; }
    }
    signal?.throwIfAborted();
    return { contractVersion: CONTRACT_VERSION, packetId: `unavailable-${randomUUID()}`, status: 'unavailable', query, materials: [], candidates: [], usedChars: 0, limits: ['资料检索服务暂不可用，本次未取得自动材料。'] };
  };
}

const revisionKeys = ['revisionId', 'kind', 'derivedFromRevisionId', 'canRetryReview', 'parentAnalysisVersion', 'analysisVersion', 'textVersion', 'status', 'createdAt', 'updatedAt', 'publishedAt'];
function revisionSummary(value) { return Object.fromEntries(revisionKeys.filter(key => value[key] !== undefined).map(key => [key, value[key]])); }
function revisionDetail(value) {
  let candidate = value.candidate;
  if (!candidate && typeof value.analysisResponse?.rawResponse === 'string') { try { candidate = JSON.parse(value.analysisResponse.rawResponse); } catch {} }
  return { ...revisionSummary(value), instructions: value.instructions, candidate, inputCandidateFingerprint: value.inputCandidateFingerprint,
    diagnostics: [...(value.analysisResponse?.diagnostics ?? []), ...(value.reviewResponse?.diagnostics ?? [])],
    ...(value.error ? { error: publicError(value.error).error } : {}) };
}
/** Call after the existing host/origin checks. Retains bodyJSON's 2 MiB wire cap. */
export function createLibraryRouter({ library, json, bodyJSON }) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/library/')) return false;
    try {
      const revisions = url.pathname.match(/^\/api\/library\/sources\/([\w-]{1,160})\/(revisions|analysis)(?:\/([\w-]{1,160}))?(\/review)?$/);
      if (revisions) {
        const [, sourceId, kind, revisionId, reviewAction] = revisions;
        if (reviewAction && (kind !== 'revisions' || !revisionId)) throw issue('NOT_FOUND');
        const allowed = reviewAction ? ['POST'] : kind === 'revisions' && !revisionId ? ['GET', 'POST'] : ['GET'];
        if (!allowed.includes(req.method)) { json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '此入口不支持当前操作。', retryable: false } }); return true; }
        if (!library) throw issue('LIBRARY_UNAVAILABLE');
        if (reviewAction) {
          if (typeof library.retryRevisionReview !== 'function') throw issue('REVIEW_UNAVAILABLE');
          const body = object(await bodyJSON(req));
          const expectedAnalysisVersion = string(body.expectedAnalysisVersion, 200);
          const attempt = await library.retryRevisionReview(sourceId, revisionId, { expectedAnalysisVersion });
          json(res, 202, { attempt: revisionSummary(attempt) });
        } else if (kind === 'analysis') {
          if (revisionId || url.searchParams.getAll('version').length !== 1 || typeof library.readAnalysis !== 'function') throw issue('INVALID_INPUT');
          const version = string(url.searchParams.get('version'), 200);
          const record = await library.readAnalysis(sourceId, { analysisVersion: version });
          json(res, 200, { source: { sourceId: record.sourceId, textVersion: record.textVersion, analysis: record.analysis } });
        } else if (req.method === 'POST') {
          if (typeof library.reviseAnalysis !== 'function') throw issue('LIBRARY_UNAVAILABLE');
          const body = object(await bodyJSON(req));
          const expectedAnalysisVersion = string(body.expectedAnalysisVersion, 200);
          const instructions = string(body.instructions, 8000);
          const attempt = await library.reviseAnalysis(sourceId, { expectedAnalysisVersion, instructions });
          json(res, 202, { attempt: revisionSummary(attempt) });
        } else if (revisionId) {
          if (typeof library.getRevision !== 'function') throw issue('LIBRARY_UNAVAILABLE');
          json(res, 200, { attempt: revisionDetail(await library.getRevision(sourceId, revisionId)) });
        } else {
          if (typeof library.listRevisions !== 'function') throw issue('LIBRARY_UNAVAILABLE');
          const result = await library.listRevisions(sourceId);
          json(res, 200, { items: result.items.slice(0, 100).map(revisionSummary) });
        }
        return true;
      }
      const match = url.pathname.match(/^\/api\/library\/sources(?:\/([\w-]{1,160})(?:\/(text|retry|cancel))?)?$/);
      if (!match) throw issue('NOT_FOUND');
      const [, id, action] = match;
      const expected = action === 'retry' || action === 'cancel' ? ['POST'] : id ? ['GET'] : ['GET', 'POST'];
      if (!expected.includes(req.method)) { json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '此资料入口不支持当前操作。', retryable: false } }); return true; }
      if (!library) throw issue('LIBRARY_UNAVAILABLE');
      let payload; let status = 200;
      if (!id && req.method === 'POST') {
        const input = decodeImport(await bodyJSON(req));
        payload = { source: detail(await library.importSource(input), false) }; status = 202;
      } else if (!id) {
        const limits = url.searchParams.getAll('limit'); const cursors = url.searchParams.getAll('cursor');
        if (limits.length > 1 || cursors.length > 1) throw issue('INVALID_INPUT');
        const value = limits[0] ?? '30';
        if (!/^[1-9]\d*$/.test(value) || Number(value) > 100) throw issue('INVALID_INPUT');
        const cursor = cursors[0];
        if (cursor !== undefined && (!cursor || cursor.length > 2048 || /[\u0000-\u001f]/u.test(cursor))) throw issue('INVALID_CURSOR');
        const result = await library.list({ cursor, limit: Number(value) });
        payload = { items: result.items.slice(0, Number(value)).map(summary), nextCursor: result.nextCursor ?? null };
      } else if (action === 'text') {
        const textVersion = string(url.searchParams.get('version') ?? undefined, 160, true);
        if (textVersion === '') throw issue('INVALID_INPUT');
        const source = await library.readSource(id, { textVersion });
        payload = { source: Object.fromEntries(['sourceId', 'textVersion', 'sourceSha256', 'text', 'encoding'].map(key => [key, source[key]])) };
      } else if (action === 'retry') {
        const { stage } = object(await bodyJSON(req));
        if (!['analysis', 'index'].includes(stage)) throw issue('INVALID_INPUT');
        payload = { source: detail(await library.retry(id, { stage }), false) };
      } else if (action === 'cancel') {
        object(await bodyJSON(req)); payload = { source: detail(await library.cancel(id), false) };
      } else {
        if (url.searchParams.getAll('analysis').length > 1) throw issue('INVALID_INPUT');
        const analysis = url.searchParams.get('analysis');
        if (analysis !== null && !['0', '1'].includes(analysis)) throw issue('INVALID_INPUT');
        payload = { source: detail(await library.get(id, { includeAnalysis: analysis === '1' }), analysis === '1') };
        if (analysis === '1' && typeof library.listRevisions === 'function') payload.source.revisionCount = (await library.listRevisions(id)).items.length;
      }
      json(res, status, payload);
    } catch (error) {
      if (error.code === 'CAPACITY_EXCEEDED' && /\/revisions(?:\/[\w-]+\/review)?$/.test(url.pathname)) { json(res, 413, { error: { code: 'CAPACITY_EXCEEDED', message: '这份来源已达到 100 次修订上限，不能再创建新尝试。已有分析与历史保留。', retryable: false } }); return true; }
      // bodyJSON's errors are owned by this HTTP layer; never forward provider messages.
      if (!error.code && [400, 413, 415].includes(error.status)) {
        json(res, error.status, { error: { code: error.status === 413 ? 'REQUEST_TOO_LARGE' : 'INVALID_INPUT', message: error.status === 413 ? '请求正文超过 2 MiB。' : '请求需要有效的 JSON 正文。', retryable: false } });
      } else { const safe = publicError(error); json(res, safe.status, { error: safe.error }); }
    }
    return true;
  };
}
