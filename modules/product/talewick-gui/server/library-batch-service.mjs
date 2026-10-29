import { mkdir, open, readFile, rename, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createLibraryBatchQueue, assertLibraryBatchLocalFile, libraryBatchFileState } from './library-batches.mjs';
import { decodeImport } from './library.mjs';
import { LIBRARY_LIMITS } from '../../../data/runtime/library.mjs';
import { inspectAnalysisReview } from '../../../data/runtime/analysis-review.mjs';

export const LIBRARY_BATCH_SERVICE_VERSION = 'library-batch-service-1';
const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && /^[\w-]{1,160}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const version = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value);
const issue = code => Object.assign(new Error(code), { code });
const require = (ok, code = 'INVALID_BATCH_INPUT') => { if (!ok) throw issue(code); };
const safeCodes = new Set(['INVALID_BATCH_INPUT', 'INVALID_INPUT', 'INVALID_ENCODING', 'INPUT_TOO_LARGE', 'FILE_TOO_LARGE',
  'REQUEST_CONFLICT', 'CAPACITY_EXCEEDED', 'BATCH_CONFLICT', 'DUPLICATE_SOURCE', 'BATCH_TARGET_CAPACITY',
  'BATCH_SERVICE_CLOSED', 'BATCH_SERVICE_BUSY', 'BATCH_STORE_BUSY', 'BATCH_STORE_INVALID', 'BATCH_STORE_CONFLICT',
  'BATCH_STORE_SYMLINK', 'BATCH_LOCAL_FILE_WAIT', 'BATCH_QUEUE_HALTED', 'SOURCE_BINDING_CONFLICT', 'RESULT_BINDING_CONFLICT',
  'CHECKED_RESULT_REQUIRED', 'DATA_INTERFACE_MISSING', 'DATA_CLOSE_FAILED', 'DATA_WAIT_FAILED', 'UNKNOWN_BATCH', 'INTERRUPTED',
  'STORAGE_FAILED', 'PROCESSING_FAILED', 'INVALID_ANALYSIS', 'CANCELLED']);
const safe = error => issue(safeCodes.has(error?.code) ? error.code
  : error?.code === 'INDEX_UNAVAILABLE' ? 'CHECKED_RESULT_REQUIRED'
    : ['VERSION_CONFLICT', 'SOURCE_BINDING', 'VERSION_NOT_FOUND', 'NOT_FOUND', 'TASK_BUSY'].includes(error?.code) ? 'SOURCE_BINDING_CONFLICT' : 'PROCESSING_FAILED');
const now = () => new Date().toISOString();
const allItems = queue => queue.progress().batches.flatMap(b => b.items.map(item => ({ ...item, batchId: b.batchId })));

function prepare(input) {
  require(input?.bytes instanceof Uint8Array);
  require(input.bytes.length <= LIBRARY_LIMITS.maxBytes, 'INPUT_TOO_LARGE');
  const decoded = decodeImport({ requestId: input.requestId, fileName: input.fileName,
    completeness: input.completeness, sourceNote: input.sourceNote, contentBase64: Buffer.from(input.bytes).toString('base64') });
  decoded.sourceNote ??= '';
  const bytes = decoded.bytes;
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch { throw issue('INVALID_ENCODING'); }
  require(text.trim() && !text.includes('\0'), 'INVALID_ENCODING');
  const normalized = text.replace(/\r\n|\r/g, '\n');
  require(normalized.length <= LIBRARY_LIMITS.maxTextChars, 'INPUT_TOO_LARGE');
  const metadata = { requestId: decoded.requestId, fileName: decoded.fileName, completeness: decoded.completeness,
    sourceNoteSha256: hash(decoded.sourceNote), sourceSha256: hash(bytes) };
  return { input: decoded, metadata, legacyTextSha256: hash(text), textSha256: hash(normalized) };
}

function assertSource(row, source, expectedAnalysis = false) {
  require(row && !row.duplicateOf && row.sourceId === source.sourceId && row.sourceSha256 === source.sourceSha256
    && row.textVersion === source.textVersion && !row.activeRevisionId, 'SOURCE_BINDING_CONFLICT');
  if (expectedAnalysis || source.expectedAnalysisVersion !== null) {
    require((row.analysis?.version ?? null) === source.expectedAnalysisVersion, 'SOURCE_BINDING_CONFLICT');
  }
}

// Persist only bindings and allowlisted errors here. DATA retains original responses,
// failed drafts, review history and version archives in its own directory.
function observation(row) {
  return { status: row.status, indexStatus: row.indexStatus ?? null, indexVersion: row.indexVersion ?? null,
    analysisVersion: row.analysis?.version ?? null, analysisSha256: row.analysis ? hash(JSON.stringify(row.analysis)) : null,
    reviewRecordId: row.analysis?.validation?.semanticReview?.recordId ?? null,
    errorCode: row.error ? safe(row.error).code : null };
}
const snapshot = row => ({ sourceId: row.sourceId, sourceSha256: row.sourceSha256, textVersion: row.textVersion,
  ...observation(row), semanticReviewSha256: row.analysis?.validation?.semanticReview ? hash(JSON.stringify(row.analysis.validation.semanticReview)) : null,
  activeRevisionId: row.activeRevisionId ?? null, revisionIds: row.revisionIds ?? [], deferred: row.deferred ?? false });

/** ownsLibrary=false joins only this queue's work and never closes the shared DATA instance. */
export async function createLibraryBatchService({ library, rootDir, concurrency = 2, ownsLibrary = true, fileState = libraryBatchFileState } = {}) {
  require(['registerSource', 'startSource', 'waitSource', 'verifyIndexBinding', 'get', 'readSource', 'cancel', ...(ownsLibrary ? ['close'] : [])].every(key => typeof library?.[key] === 'function'), 'DATA_INTERFACE_MISSING');
  require(typeof rootDir === 'string' && path.isAbsolute(rootDir) && [2, 4].includes(concurrency) && typeof ownsLibrary === 'boolean');
  await assertLibraryBatchLocalFile(rootDir, fileState);
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  require(await realpath(rootDir) === rootDir, 'BATCH_STORE_SYMLINK');
  let state, diskHash = null, serial = Promise.resolve(), submissions = Promise.resolve(), runPromise = null;
  let queue, closing = false, closed = false, closePromise = null, fault = null, drainStatus = 'not_requested';
  let recoveryWork = null, dataClosePromise = null;
  const active = new Map();
  const stateFile = path.join(rootDir, 'service.json');
  // Do this before the queue acquires its owner or reconciles any old state.
  await assertLibraryBatchLocalFile(stateFile, fileState);
  const readState = async () => {
    await assertLibraryBatchLocalFile(stateFile, fileState);
    const stat = await lstat(stateFile);
    require(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 8 * 1024 * 1024, 'BATCH_STORE_INVALID');
    return readFile(stateFile, 'utf8');
  };
  const validate = next => {
    require(next?.schemaVersion === LIBRARY_BATCH_SERVICE_VERSION && next.queueId === queue.progress().queueId
      && Array.isArray(next.batches) && next.batches.length <= 10 && Array.isArray(next.operations) && next.operations.length <= 100, 'BATCH_STORE_INVALID');
    const batches = new Set(), requests = new Set(), ops = new Set();
    for (const batch of next.batches) {
      require(id(batch.batchId) && !batches.has(batch.batchId) && sha(batch.fingerprint)
        && Array.isArray(batch.entries) && batch.entries.length === 10, 'BATCH_STORE_INVALID');
      batches.add(batch.batchId);
      for (const entry of batch.entries) {
        require(id(entry.input?.requestId) && !requests.has(entry.input.requestId) && sha(entry.input.sourceSha256), 'BATCH_STORE_INVALID');
        requests.add(entry.input.requestId);
        if (entry.source) require(id(entry.source.sourceId) && entry.source.sourceSha256 === entry.input.sourceSha256
          && version(entry.source.textVersion) && (entry.source.expectedAnalysisVersion === null || version(entry.source.expectedAnalysisVersion))
          && sha(entry.textSha256), 'BATCH_STORE_INVALID');
      }
    }
    for (const op of next.operations) {
      const entry = next.batches.find(b => b.batchId === op.batchId)?.entries.find(e => isDeepStrictEqual(e.source, op.source));
      require(id(op.operationId) && !ops.has(op.operationId) && entry && Array.isArray(op.events)
        && op.events[0]?.kind === 'bound', 'BATCH_STORE_INVALID');
      ops.add(op.operationId);
    }
    require(next.unsettled === undefined || (Array.isArray(next.unsettled) && next.unsettled.every(op => id(op.operationId)
      && op.errorCode === 'DATA_WAIT_FAILED' && next.batches.some(b => b.entries.some(e => isDeepStrictEqual(e.source, op.source))))), 'BATCH_STORE_INVALID');
    return next;
  };
  const save = async next => {
    if (diskHash !== null) require(hash(await readState()) === diskHash, 'BATCH_STORE_CONFLICT');
    else { try { await lstat(stateFile); throw issue('BATCH_STORE_CONFLICT'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    validate(next);
    const text = JSON.stringify(next), temp = path.join(rootDir, '.service-' + randomUUID() + '.tmp');
    const file = await open(temp, 'wx', 0o600);
    try {
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      await rename(temp, stateFile);
      const dir = await open(rootDir, 'r'); try { await dir.sync(); } finally { await dir.close(); }
    } finally { await unlink(temp).catch(() => {}); }
    diskHash = hash(text); state = next;
  };
  const mutate = fn => {
    const work = serial.then(async () => {
      if (fault) throw fault;
      const next = structuredClone(state), result = fn(next);
      try { await save(next); } catch { fault = issue('BATCH_STORE_CONFLICT'); throw fault; }
      return result;
    });
    serial = work.catch(() => {}); return work;
  };
  const event = (operationId, kind, fields = {}) => mutate(next => {
    next.operations.find(op => op.operationId === operationId).events.push({ kind, at: now(), ...fields });
  });
  const ensureOpen = () => { require(!closing, 'BATCH_SERVICE_CLOSED'); if (fault) throw fault; };
  const entryFor = request => state.batches.find(b => b.batchId === request.batchId)?.entries.find(e => isDeepStrictEqual(e.source, request.source));
  const assertRegistered = request => require(allItems(queue).some(item => item.operationId === request.operationId
    && item.batchId === request.batchId && isDeepStrictEqual(item.source, request.source)), 'SOURCE_BINDING_CONFLICT');
  const assertLineage = (request, row) => {
    if (ownsLibrary) return;
    const original = entryFor(request)?.registrationSnapshot;
    require(original && !row.activeRevisionId && isDeepStrictEqual(row.revisionIds ?? [], original.revisionIds), 'SOURCE_BINDING_CONFLICT');
  };
  const assertBeforeStart = (request, row) => {
    if (ownsLibrary) return;
    assertSource(row, request.source, true);
    require(isDeepStrictEqual(snapshot(row), entryFor(request)?.registrationSnapshot), 'SOURCE_BINDING_CONFLICT');
  };
  async function readBound(request) {
    const entry = entryFor(request); require(entry, 'SOURCE_BINDING_CONFLICT');
    const row = await library.get(request.source.sourceId, { includeAnalysis: true });
    assertSource(row, request.source);
    const original = await library.readSource(row.sourceId, { textVersion: request.source.textVersion });
    require(original.sourceId === row.sourceId && original.textVersion === row.textVersion && original.sourceSha256 === row.sourceSha256
      && typeof original.text === 'string' && hash(original.text) === entry.textSha256, 'SOURCE_BINDING_CONFLICT');
    return row;
  }
  async function verifyResult(request, row, outcome) {
    assertSource(row, request.source); assertLineage(request, row);
    let indexBinding = null;
    if (outcome.result) {
      indexBinding = await library.verifyIndexBinding(row.sourceId, { expectedTextVersion: row.textVersion, expectedAnalysisVersion: row.analysis.version });
      require(indexBinding && indexBinding.sourceId === row.sourceId && indexBinding.sourceSha256 === row.sourceSha256
        && indexBinding.textVersion === row.textVersion && indexBinding.analysisVersion === row.analysis.version
        && indexBinding.analysisSha256 === outcome.result.analysisSha256 && indexBinding.sourceTextSha256 === entryFor(request).textSha256
        && indexBinding.status === row.status && indexBinding.indexStatus === 'ready' && row.indexStatus === 'ready'
        && indexBinding.indexVersion === row.indexVersion && sha(indexBinding.indexSha256), 'SOURCE_BINDING_CONFLICT');
    }
    // A captured wait result can be obsolete even if its own review and seal are
    // valid. Include the complete analysis/review digest and revision lineage.
    const latest = await readBound(request);
    require(isDeepStrictEqual(snapshot(row), snapshot(latest)), 'SOURCE_BINDING_CONFLICT');
    return indexBinding;
  }
  async function cancelRegistered(request, { unstarted = false } = {}) {
    assertRegistered(request);
    if (!ownsLibrary) {
      await readBound(request);
      const row = await library.get(request.source.sourceId, { includeAnalysis: true });
      assertSource(row, request.source);
      assertLineage(request, row);
      if (unstarted) {
        const cancelledOriginal = { ...entryFor(request)?.registrationSnapshot, status: 'cancelled' };
        if (row.status === 'cancelled' && isDeepStrictEqual(snapshot(row), cancelledOriginal)) return row;
        assertBeforeStart(request, row);
      }
      if (['completed', 'partial', 'failed', 'interrupted', 'cancelled'].includes(row.status)) return row;
    }
    return library.cancel(request.source.sourceId);
  }
  async function failedBarrier(request) {
    drainStatus = 'failed'; fault = issue('DATA_WAIT_FAILED');
    // Save uncertainty independently of queue status; reopening must not silently
    // turn a failed join into proof that the underlying provider has settled.
    const work = serial.then(async () => {
      const next = structuredClone(state);
      next.unsettled ??= [];
      if (!next.unsettled.some(op => op.operationId === request.operationId)) next.unsettled.push({
        operationId: request.operationId, source: request.source, errorCode: 'DATA_WAIT_FAILED', at: now() });
      const op = next.operations.find(op => op.operationId === request.operationId);
      if (op) op.events.push({ kind: 'wait_failed', at: now(), errorCode: 'DATA_WAIT_FAILED' });
      try { await save(next); } catch { /* Keep the in-memory fault; never overwrite drifted storage. */ }
    });
    serial = work.catch(() => {}); await work;
  }
  const failed = (request, errorCode = 'PROCESSING_FAILED') => ({ operationId: request.operationId, source: structuredClone(request.source),
    status: errorCode === 'CANCELLED' ? 'cancelled' : 'failed', result: null, errorCode });
  function outcomeFor(request, row) {
    assertSource(row, request.source);
    if (row.status === 'cancelled') return failed(request, 'CANCELLED');
    if (row.status === 'interrupted' || row.status === 'deferred') return failed(request, 'INTERRUPTED');
    if (row.status === 'failed') return failed(request);
    require(['completed', 'partial'].includes(row.status), 'CHECKED_RESULT_REQUIRED');
    const analysis = row.analysis, review = analysis?.validation?.semanticReview;
    require(analysis && version(analysis.version) && analysis.textVersion === row.textVersion, 'SOURCE_BINDING_CONFLICT');
    if (review) require(id(review.recordId) && review.sourceId === row.sourceId && review.textVersion === row.textVersion
      && review.analysisVersion === analysis.version && inspectAnalysisReview(review, analysis).review
      && review.outcome === (review.approved ? 'approved' : 'rejected'), 'SOURCE_BINDING_CONFLICT');
    const literal = analysis.validation?.literalEvidence;
    const complete = row.status === 'completed' && analysis.reviewStatus === 'checked' && review?.approved === true
      && review.outcome === 'approved' && literal === 'passed' && row.indexStatus === 'ready' && version(row.indexVersion);
    const needsReview = row.status === 'partial' && (analysis.reviewStatus === 'needs_review' || (!review && analysis.reviewStatus === 'candidate'))
      && (!review || review.approved === false) && ['passed', 'failed'].includes(literal)
      && ['ready', 'blocked'].includes(row.indexStatus) && (row.indexStatus !== 'ready' || version(row.indexVersion));
    require(complete || needsReview, 'CHECKED_RESULT_REQUIRED');
    const analysisSha256 = hash(JSON.stringify(analysis));
    return { operationId: request.operationId, source: structuredClone(request.source), status: complete ? 'completed' : 'needs_review', errorCode: null,
      result: { resultId: 'data-' + hash(JSON.stringify([row.sourceId, row.textVersion, analysis.version, analysisSha256])),
        analysisVersion: analysis.version, analysisSha256, reviewRecordId: review?.recordId ?? null,
        reviewOutcome: review?.outcome ?? 'unverified', literalEvidence: literal, indexStatus: row.indexStatus } };
  }
  async function persistOutcome(request, outcome, row, indexBinding = null) {
    await mutate(next => {
      const op = next.operations.find(o => o.operationId === request.operationId);
      require(op && isDeepStrictEqual(op.source, request.source), 'SOURCE_BINDING_CONFLICT');
      if (op.outcome) {
        require(isDeepStrictEqual(op.outcome, outcome), 'RESULT_BINDING_CONFLICT');
        if (indexBinding) {
          if (op.evidence?.indexBinding) require(isDeepStrictEqual(op.evidence.indexBinding, indexBinding), 'RESULT_BINDING_CONFLICT');
          else { require(op.evidence, 'RESULT_BINDING_CONFLICT'); op.evidence.indexBinding = structuredClone(indexBinding); }
        }
        return;
      }
      op.outcome = outcome;
      op.events.push({ kind: 'outcome', at: now(), status: outcome.status, errorCode: outcome.errorCode });
      op.evidence = row ? { sourceId: row.sourceId, sourceSha256: row.sourceSha256, textVersion: row.textVersion,
        ...observation(row), semanticReviewSha256: row.analysis?.validation?.semanticReview ? hash(JSON.stringify(row.analysis.validation.semanticReview)) : null,
        indexBinding: indexBinding && structuredClone(indexBinding) } : null;
    });
  }
  async function processOne(request, { signal, commitResult }) {
    let cancelPromise = null, finish, startAttempted = false, workerSettled = false;
    let resolveCancelled, rejectCancelled;
    const cancelledWait = new Promise((resolve, reject) => { resolveCancelled = resolve; rejectCancelled = reject; });
    void cancelledWait.catch(() => {});
    const finished = new Promise(resolve => { finish = resolve; });
    active.set(request.operationId, finished);
    const onAbort = () => {
      if (cancelPromise || !startAttempted || workerSettled) return;
      cancelPromise = Promise.resolve().then(() => cancelRegistered(request));
      void cancelPromise.catch(() => {});
      // A pre-cancel wait for a queued source may still be watching an unrelated
      // occupied slot. A fresh post-cancel wait proves this source itself is idle.
      void cancelPromise.then(() => library.waitSource(request.source.sourceId, { includeAnalysis: true }))
        .then(resolveCancelled, rejectCancelled);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await mutate(next => {
        require(!next.operations.some(op => op.operationId === request.operationId), 'RESULT_BINDING_CONFLICT');
        require(entryFor(request), 'SOURCE_BINDING_CONFLICT');
        next.operations.push({ ...structuredClone(request), events: [{ kind: 'bound', at: now() }], outcome: null, evidence: null });
      });
      if (!signal.aborted && !closing) {
        const row = await readBound(request);
        assertBeforeStart(request, row);
        if (row.status === 'deferred') {
          assertSource(row, request.source, true);
          await event(request.operationId, 'start_intent');
          if (!ownsLibrary) assertBeforeStart(request, await readBound(request));
          if (!signal.aborted && !closing && !fault) {
            startAttempted = true;
            await library.startSource(request.source.sourceId, { expectedTextVersion: request.source.textVersion,
              expectedAnalysisVersion: request.source.expectedAnalysisVersion });
            await event(request.operationId, 'start_accepted');
          }
        } else require(!['queued', 'running'].includes(row.status), 'SOURCE_BINDING_CONFLICT');
      }
      if (signal.aborted || closing) onAbort();
      if (cancelPromise) await cancelPromise;
      // This waits the canonical worker, including a late provider response after
      // visible cancellation. Neither get(status) nor start's receipt is a barrier.
      const row = await Promise.race([library.waitSource(request.source.sourceId, { includeAnalysis: true }), cancelledWait]);
      workerSettled = true;
      assertSource(row, request.source);
      const outcome = signal.aborted ? failed(request, 'CANCELLED') : outcomeFor(request, row);
      const indexBinding = await verifyResult(request, row, outcome);
      await persistOutcome(request, outcome, row, indexBinding);
      // Revalidate after durable journal I/O and immediately before queue binding.
      require(isDeepStrictEqual(await verifyResult(request, row, outcome), indexBinding), 'RESULT_BINDING_CONFLICT');
      await commitResult(outcome);
      return outcome;
    } catch (error) {
      const cleaned = safe(error);
      const wasCancelled = signal.aborted;
      if (!fault && state.operations.some(op => op.operationId === request.operationId) && !wasCancelled) {
        await event(request.operationId, 'failure', { errorCode: cleaned.code });
        if (!state.operations.find(op => op.operationId === request.operationId).outcome) await persistOutcome(request, failed(request));
      }
      try {
        // An accepted start may lose its response. Cancel and join the genuine
        // source call without ever reissuing start or retry.
        if (startAttempted && !workerSettled) {
          onAbort(); if (cancelPromise) await cancelPromise;
          await library.waitSource(request.source.sourceId, { includeAnalysis: true });
          workerSettled = true;
        }
      } catch {
        if (!state.operations.find(op => op.operationId === request.operationId)?.outcome?.result) await commitResult(failed(request));
        if (!ownsLibrary) {
          await failedBarrier(request);
          closing = true; void close().catch(() => {});
          throw issue('DATA_WAIT_FAILED');
        }
        // Only the owning mode may fall back to a global DATA drain.
        closing = true;
        const barrier = closeData(); void close().catch(() => {}); await barrier;
      }
      throw cleaned;
    } finally { signal.removeEventListener('abort', onAbort); active.delete(request.operationId); finish(); }
  }

  try {
    queue = await createLibraryBatchQueue({ rootDir: path.join(rootDir, 'queue'), processOne, concurrency, fileState });
    try { const raw = await readState(); state = validate(JSON.parse(raw)); diskHash = hash(raw); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      require(queue.progress().registered === 0, 'BATCH_STORE_INVALID');
      await save({ schemaVersion: LIBRARY_BATCH_SERVICE_VERSION, queueId: queue.progress().queueId, batches: [], operations: [] });
    }
    for (const item of allItems(queue)) require(entryFor(item), 'BATCH_STORE_INVALID');
    if (state.unsettled?.length) { fault = issue('DATA_WAIT_FAILED'); drainStatus = 'failed'; }
  } catch (error) { if (queue) await queue.close(); throw safe(error); }

  async function addBatch({ batchId, sources } = {}) {
    ensureOpen(); require(!runPromise, 'BATCH_SERVICE_BUSY');
    require(id(batchId) && Array.isArray(sources) && sources.length === 10);
    const prepared = sources.map(prepare); // Validate every byte input before any registration.
    require(new Set(prepared.map(p => p.input.requestId)).size === 10);
    require(new Set(prepared.map(p => p.metadata.sourceSha256)).size === 10, 'DUPLICATE_SOURCE');
    const fingerprint = hash(JSON.stringify(prepared.map(p => p.metadata)));
    const work = submissions.then(async () => {
      ensureOpen();
      const existing = state.batches.find(b => b.batchId === batchId);
      if (existing) require(existing.fingerprint === fingerprint, 'BATCH_CONFLICT');
      else {
        require(!queue.progress().halted, 'BATCH_QUEUE_HALTED');
        require(state.batches.length < 10, 'BATCH_TARGET_CAPACITY');
        const known = state.batches.flatMap(b => b.entries);
        require(prepared.every(p => !known.some(e => e.input.sourceSha256 === p.metadata.sourceSha256)), 'DUPLICATE_SOURCE');
        require(prepared.every(p => !known.some(e => e.input.requestId === p.input.requestId)), 'REQUEST_CONFLICT');
        await mutate(next => next.batches.push({ batchId, fingerprint, entries: prepared.map(p => ({ input: p.metadata, source: null, textSha256: null })), failures: [] }));
      }
      try {
        for (const [i, p] of prepared.entries()) {
          ensureOpen();
          const batch = state.batches.find(b => b.batchId === batchId);
          if (batch.entries[i].source) continue;
          const registered = await library.registerSource(p.input);
          const canonicalId = registered.duplicateOf ?? registered.sourceId;
          const row = await library.get(canonicalId, { includeAnalysis: true });
          require(id(row.sourceId) && version(row.textVersion) && row.sourceSha256 === p.metadata.sourceSha256
            && row.sourceId === canonicalId && !row.duplicateOf && !row.activeRevisionId, 'SOURCE_BINDING_CONFLICT');
          const source = { sourceId: canonicalId, sourceSha256: row.sourceSha256, textVersion: row.textVersion,
            expectedAnalysisVersion: row.analysis?.version ?? null };
          const original = await library.readSource(canonicalId, { textVersion: row.textVersion });
          const textSha256 = row.textVersion === `text-${row.sourceSha256}` ? p.legacyTextSha256 : p.textSha256;
          require(original.sourceId === canonicalId && original.sourceSha256 === row.sourceSha256 && original.textVersion === row.textVersion
            && typeof original.text === 'string' && hash(original.text) === textSha256, 'SOURCE_BINDING_CONFLICT');
          await mutate(next => { const e = next.batches.find(b => b.batchId === batchId).entries[i]; e.source = source; e.textSha256 = textSha256; e.registrationSnapshot = snapshot(row); });
        }
        const batch = state.batches.find(b => b.batchId === batchId), bindings = batch.entries.map(e => e.source);
        require(new Set(bindings.map(b => b.sourceId)).size === 10, 'DUPLICATE_SOURCE');
        const others = state.batches.filter(b => b !== batch).flatMap(b => b.entries);
        require(bindings.every(b => !others.some(e => e.source?.sourceId === b.sourceId)), 'DUPLICATE_SOURCE');
        for (const source of bindings) await readBound({ batchId, source });
        await queue.addBatch({ batchId, sources: bindings }); return progress();
      } catch (error) {
        const cleaned = safe(error);
        if (!fault) await mutate(next => next.batches.find(b => b.batchId === batchId).failures.push({ at: now(), errorCode: cleaned.code }));
        throw cleaned;
      }
    });
    submissions = work.catch(() => {}); return work;
  }
  async function reconcilePending() {
    ensureOpen();
    for (const item of allItems(queue).filter(i => i.recoveryRequired)) {
      const op = state.operations.find(o => o.operationId === item.operationId);
      // A missing intent cannot authorize any DATA call, even if a deferred source exists.
      if (!op) {
        await queue.reconcile({ operationId: item.operationId, outcome: failed(item, 'INTERRUPTED') });
        continue;
      }
      require(isDeepStrictEqual(op.source, item.source), 'SOURCE_BINDING_CONFLICT');
      await readBound(item);
      let row;
      try { row = await library.waitSource(item.source.sourceId, { includeAnalysis: true }); }
      catch (error) { if (!ownsLibrary) { await failedBarrier(item); throw issue('DATA_WAIT_FAILED'); } throw error; }
      const outcome = outcomeFor(item, row);
      const indexBinding = await verifyResult(item, row, outcome);
      if (op.outcome) require(isDeepStrictEqual(op.outcome, outcome), 'RESULT_BINDING_CONFLICT');
      await persistOutcome(item, outcome, row, indexBinding);
      await event(item.operationId, 'reconciled', { status: outcome.status });
      require(isDeepStrictEqual(await verifyResult(item, row, outcome), indexBinding), 'RESULT_BINDING_CONFLICT');
      await queue.reconcile({ operationId: item.operationId, outcome });
    }
    return queue.progress();
  }
  function recover() {
    if (!recoveryWork) recoveryWork = reconcilePending().finally(() => { recoveryWork = null; });
    return recoveryWork;
  }
  function closeData() {
    require(ownsLibrary, 'DATA_WAIT_FAILED');
    if (!dataClosePromise) {
      drainStatus = 'pending';
      dataClosePromise = Promise.resolve().then(() => library.close()).then(() => { drainStatus = 'complete'; }, () => {
        drainStatus = 'failed'; throw issue('DATA_CLOSE_FAILED');
      });
    }
    return dataClosePromise;
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    if (drainStatus === 'not_requested') drainStatus = 'pending';
    closePromise = (async () => {
      await submissions;
      if (recoveryWork) {
        await Promise.allSettled(allItems(queue).filter(i => i.recoveryRequired && state.operations.some(op => op.operationId === i.operationId
          && op.events.some(e => e.kind === 'start_intent'))).map(i => cancelRegistered(i)));
        await recoveryWork.catch(() => {});
      }
      // Queue close signals each worker; processOne cancels and waitSource joins
      // it before queue ownership is released. DATA remains readable until then.
      let queueError;
      try { await queue.close(); await serial; } catch (error) { queueError = error; }
      if (ownsLibrary) await closeData();
      else {
        if (state.unsettled?.length || drainStatus === 'failed') throw issue('DATA_WAIT_FAILED');
        drainStatus = 'complete';
      }
      closed = true;
      if (queueError) throw queueError;
      return progress();
    })();
    return closePromise;
  }
  function progress() {
    return { ...queue.progress(), ownsLibrary, closing, closed, drainStatus, requiresReopen: closing,
      unsettled: structuredClone(state.unsettled ?? []),
      ...(fault ? { halted: true, haltCode: fault.code, goalMet: false } : {}),
      registrations: state.batches.map(b => ({ batchId: b.batchId, saved: b.entries.filter(e => e.source).length,
        failures: structuredClone(b.failures), sources: b.entries.map(e => e.source && structuredClone(e.source)) })) };
  }
  const service = {
    addBatch, progress,
    run() {
      ensureOpen();
      if (!runPromise) {
        runPromise = (async () => {
          await submissions; ensureOpen(); await recover();
          if (!closing) {
            // A later invalid binding must not allow earlier sources to dispatch.
            for (const item of allItems(queue).filter(i => i.status === 'queued')) assertBeforeStart(item, await readBound(item));
            await queue.run();
          }
          return progress();
        })()
          .finally(() => { runPromise = null; });
      }
      return runPromise;
    },
    async recover() { ensureOpen(); require(!runPromise, 'BATCH_SERVICE_BUSY'); await submissions; await recover(); return progress(); },
    async cancelBatch(batchId) {
      ensureOpen(); await submissions;
      const running = new Map(active);
      await queue.cancelBatch(batchId);
      const targets = allItems(queue).filter(i => i.batchId === batchId && (i.cancelRequested || i.recoveryRequired));
      await Promise.all(targets.map(async item => {
        if (running.has(item.operationId)) { await running.get(item.operationId); return; }
        const op = state.operations.find(op => op.operationId === item.operationId);
        if (op?.outcome || (item.attempts && !item.recoveryRequired)) return;
        await cancelRegistered(item, { unstarted: !op?.events.some(e => e.kind === 'start_intent') });
        try { await library.waitSource(item.source.sourceId, { includeAnalysis: true }); }
        catch (error) { if (!ownsLibrary) await failedBarrier(item); throw safe(error); }
      }));
      await Promise.all(targets.map(i => active.get(i.operationId)).filter(Boolean));
      if (drainStatus === 'failed') throw issue('DATA_WAIT_FAILED');
      return progress();
    },
    close,
  };
  return Object.fromEntries(Object.entries(service).map(([name, method]) => [name, name === 'progress' ? method : async (...args) => {
    try { return await method(...args); } catch (error) { throw safe(error); }
  }]));
}
