// Standalone orchestration only: no model, library, HTTP, or existing runtime imports.
import { mkdir, open, readFile, rename, unlink, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const LIBRARY_BATCH_VERSION = 'library-batches-1';
export const LIBRARY_BATCH_SIZE = 10;
export const LIBRARY_BATCH_TARGET = 100;
const states = ['queued', 'running', 'completed', 'needs_review', 'failed', 'cancelled'];
const terminal = new Set(states.slice(2));
const conflicts = new Set(['SOURCE_BINDING_CONFLICT', 'RESULT_BINDING_CONFLICT', 'BATCH_CONFLICT']);
const dataConflicts = new Set(['VERSION_CONFLICT', 'SOURCE_BINDING', 'REQUEST_CONFLICT', 'REQUEST_ID_CONFLICT']);
const hash = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const issue = code => Object.assign(new Error(code), { code });
const require = (ok, code = 'INVALID_BATCH_INPUT') => { if (!ok) throw issue(code); };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const version = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value, names) => record(value) && isDeepStrictEqual(Object.keys(value).sort(), [...names].sort());
const items = state => state.batches.flatMap(batch => batch.items);

function sourceBinding(source) {
  require(keys(source, ['sourceId', 'sourceSha256', 'textVersion', 'expectedAnalysisVersion']));
  require(id(source.sourceId) && sha(source.sourceSha256) && version(source.textVersion));
  require(source.expectedAnalysisVersion === null || version(source.expectedAnalysisVersion));
  return { sourceId: source.sourceId, sourceSha256: source.sourceSha256,
    textVersion: source.textVersion, expectedAnalysisVersion: source.expectedAnalysisVersion };
}
const sourceHash = source => hash(JSON.stringify(sourceBinding(source)));
const operation = (queueId, batchId, source) => 'batch-' + hash(JSON.stringify([queueId, batchId, sourceHash(source)]));

function validateOutcome(value, item) {
  require(keys(value, ['operationId', 'source', 'status', 'result', 'errorCode']), 'INVALID_PROCESS_RESULT');
  let source;
  try { source = sourceBinding(value.source); } catch { throw issue('SOURCE_BINDING_CONFLICT'); }
  require(value.operationId === item.operationId && isDeepStrictEqual(source, item.source), 'SOURCE_BINDING_CONFLICT');
  require(terminal.has(value.status), 'INVALID_PROCESS_RESULT');
  if (value.status === 'completed' || value.status === 'needs_review') {
    const r = value.result;
    require(keys(r, ['resultId', 'analysisVersion', 'analysisSha256', 'reviewRecordId', 'reviewOutcome', 'literalEvidence', 'indexStatus']), 'INVALID_PROCESS_RESULT');
    require(id(r.resultId) && version(r.analysisVersion) && sha(r.analysisSha256) && value.errorCode === null, 'INVALID_PROCESS_RESULT');
    if (value.status === 'completed') {
      require(id(r.reviewRecordId) && r.reviewOutcome === 'approved' && r.literalEvidence === 'passed' && r.indexStatus === 'ready', 'CHECKED_RESULT_REQUIRED');
    } else {
      // The data library may index the unchanged source text while withholding
      // rejected analysis. A ready raw index is not an approved decomposition.
      require(['rejected', 'unverified'].includes(r.reviewOutcome) && ['passed', 'failed'].includes(r.literalEvidence)
        && ['blocked', 'ready'].includes(r.indexStatus), 'INVALID_PROCESS_RESULT');
      require(r.reviewOutcome === 'rejected' ? id(r.reviewRecordId) : r.reviewRecordId === null, 'INVALID_PROCESS_RESULT');
    }
  } else {
    require(value.result === null && ['PROCESSING_FAILED', 'CANCELLED', 'INTERRUPTED'].includes(value.errorCode), 'INVALID_PROCESS_RESULT');
    require(value.status === 'cancelled' ? value.errorCode === 'CANCELLED' : value.errorCode !== 'CANCELLED', 'INVALID_PROCESS_RESULT');
  }
  return structuredClone(value);
}

function validateState(state) {
  require(record(state) && state.schemaVersion === LIBRARY_BATCH_VERSION && id(state.queueId), 'BATCH_STORE_INVALID');
  require(state.targetCount === 100 && state.batchSize === 10 && [2, 4].includes(state.concurrency), 'BATCH_STORE_INVALID');
  require(Number.isSafeInteger(state.revision) && state.revision >= 0 && Array.isArray(state.batches) && state.batches.length <= 10, 'BATCH_STORE_INVALID');
  require(state.halt === null || (record(state.halt) && [...conflicts, 'INVALID_PROCESS_RESULT', 'CHECKED_RESULT_REQUIRED', 'INTERRUPTED'].includes(state.halt.code)), 'BATCH_STORE_INVALID');
  const sources = new Set(), batches = new Set(), resultIds = new Set();
  for (const batch of state.batches) {
    require(id(batch.batchId) && !batches.has(batch.batchId) && Array.isArray(batch.items) && batch.items.length === 10, 'BATCH_STORE_INVALID');
    batches.add(batch.batchId);
    for (const item of batch.items) {
      require(!sources.has(item.source.sourceId) && sourceHash(item.source) === item.sourceBindingSha256, 'BATCH_STORE_INVALID');
      sources.add(item.source.sourceId);
      require(item.operationId === operation(state.queueId, batch.batchId, item.source) && states.includes(item.status), 'BATCH_STORE_INVALID');
      require(Array.isArray(item.attempts) && item.attempts.length <= 1 && typeof item.recoveryRequired === 'boolean' && typeof item.cancelRequested === 'boolean', 'BATCH_STORE_INVALID');
      for (const attempt of item.attempts) require(states.includes(attempt.status) && typeof attempt.failed === 'boolean' && typeof attempt.startedAt === 'string' && (attempt.finishedAt === null || typeof attempt.finishedAt === 'string'), 'BATCH_STORE_INVALID');
      if (item.status === 'queued') require(item.attempts.length === 0 && item.outcome === null, 'BATCH_STORE_INVALID');
      if (item.status === 'running') require(item.attempts.length === 1 && item.outcome === null, 'BATCH_STORE_INVALID');
      if (item.outcome !== null) {
        validateOutcome(item.outcome, item);
        require(item.status === item.outcome.status && item.attempts.length === 1 && !item.recoveryRequired, 'BATCH_STORE_INVALID');
        if (item.outcome.result) { require(!resultIds.has(item.outcome.result.resultId), 'BATCH_STORE_INVALID'); resultIds.add(item.outcome.result.resultId); }
      }
      if (['completed', 'needs_review'].includes(item.status)) require(item.outcome !== null, 'BATCH_STORE_INVALID');
      if (item.recoveryRequired) require(item.status === 'failed' && item.errorCode === 'INTERRUPTED' && item.outcome === null, 'BATCH_STORE_INVALID');
    }
  }
  return state;
}

/** Checked progress is separate from attempts, settled items, and saved original text. */
export function projectLibraryBatchProgress(state) {
  validateState(state);
  const counts = list => {
    const result = Object.fromEntries(states.map(key => [key, list.filter(item => item.status === key).length]));
    return { ...result, registered: list.length, attempts: list.reduce((n, item) => n + item.attempts.length, 0),
      failedAttempts: list.reduce((n, item) => n + item.attempts.filter(a => a.failed).length, 0),
      checked: list.filter(item => item.status === 'completed' && item.outcome?.result?.reviewOutcome === 'approved').length,
      recoveryRequired: list.filter(item => item.recoveryRequired).length };
  };
  const totals = counts(items(state));
  return { schemaVersion: LIBRARY_BATCH_VERSION, queueId: state.queueId, revision: state.revision,
    targetCount: 100, batchSize: 10, concurrency: state.concurrency, halted: state.halt !== null,
    haltCode: state.halt?.code ?? null, ...totals, remainingChecked: 100 - totals.checked,
    goalMet: totals.checked === 100 && state.halt === null,
    batches: state.batches.map(batch => ({ batchId: batch.batchId, ...counts(batch.items),
      items: batch.items.map(item => ({ source: structuredClone(item.source), operationId: item.operationId,
        status: item.status, attempts: item.attempts.length, errorCode: item.errorCode,
        recoveryRequired: item.recoveryRequired, cancelRequested: item.cancelRequested,
        result: item.outcome?.result ? structuredClone(item.outcome.result) : null })) })) };
}

/** One owner per dedicated root. Opening never dispatches work; run() is explicit. */
export async function createLibraryBatchQueue({ rootDir, processOne, concurrency = 2 }) {
  require(typeof rootDir === 'string' && path.isAbsolute(rootDir) && typeof processOne === 'function' && [2, 4].includes(concurrency));
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  require(await realpath(rootDir) === rootDir, 'BATCH_STORE_SYMLINK');
  const stateFile = path.join(rootDir, 'queue.json'), ownerFile = path.join(rootDir, '.owner.json');
  const owner = { pid: process.pid, token: randomUUID() };
  let ownerHandle;
  try { ownerHandle = await open(ownerFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw issue('BATCH_STORE_BUSY'); throw error; }
  await ownerHandle.writeFile(JSON.stringify(owner)); await ownerHandle.sync(); await ownerHandle.close();
  let state, diskHash = null, serial = Promise.resolve(), pump = null, closing = false, closed = false, fault = null;
  const active = new Map(), controllers = new Map();
  const now = () => new Date().toISOString();
  const assertOwner = async () => require(isDeepStrictEqual(JSON.parse(await readFile(ownerFile, 'utf8')), owner), 'BATCH_STORE_CONFLICT');
  const releaseOwner = async () => { await assertOwner(); await unlink(ownerFile); };
  const readState = async () => {
    const stat = await lstat(stateFile);
    require(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 4 * 1024 * 1024, 'BATCH_STORE_INVALID');
    return readFile(stateFile, 'utf8');
  };
  const save = async next => {
    await assertOwner();
    if (diskHash !== null) require(hash(await readState()) === diskHash, 'BATCH_STORE_CONFLICT');
    else { try { await lstat(stateFile); throw issue('BATCH_STORE_CONFLICT'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    validateState(next);
    const text = JSON.stringify(next), temp = path.join(rootDir, '.queue-' + randomUUID() + '.tmp');
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temp, stateFile);
    const directory = await open(rootDir, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    diskHash = hash(text); state = next;
  };
  const mutate = fn => {
    const work = serial.then(async () => {
      require(!closed, 'BATCH_QUEUE_CLOSED'); if (fault) throw fault;
      const next = structuredClone(state), result = fn(next);
      next.revision++; next.updatedAt = now();
      try { await save(next); } catch (error) { fault = issue('BATCH_STORE_CONFLICT'); controllers.forEach(c => c.abort()); throw fault; }
      return result;
    });
    serial = work.catch(() => {}); return work;
  };
  const halt = (code, operationId = null) => mutate(next => { next.halt = { code, operationId }; });
  const find = (next, operationId) => { const item = items(next).find(i => i.operationId === operationId); require(item, 'UNKNOWN_BATCH_OPERATION'); return item; };
  const commit = (operationId, outcome, reconcile = false) => mutate(next => {
    const item = find(next, operationId), checked = validateOutcome(outcome, item);
    if (item.outcome) { require(isDeepStrictEqual(item.outcome, checked), 'RESULT_BINDING_CONFLICT'); return; }
    require(reconcile ? ['failed', 'cancelled'].includes(item.status) && item.attempts.length === 1 : item.status === 'running', 'RESULT_BINDING_CONFLICT');
    if (checked.result) require(!items(next).some(other => other !== item && other.outcome?.result?.resultId === checked.result.resultId), 'RESULT_BINDING_CONFLICT');
    item.outcome = checked; item.status = checked.status; item.errorCode = checked.errorCode; item.recoveryRequired = false;
    const attempt = item.attempts.at(-1); attempt.status = checked.status; attempt.finishedAt = now();
    if (checked.status === 'failed') attempt.failed = true;
    if (reconcile && next.halt?.code === 'INTERRUPTED' && !items(next).some(i => i.recoveryRequired)) next.halt = null;
  }).catch(async error => { if (conflicts.has(error.code) || ['INVALID_PROCESS_RESULT', 'CHECKED_RESULT_REQUIRED'].includes(error.code)) await halt(error.code, operationId); throw error; });
  try {
    try { const raw = await readState(); state = validateState(JSON.parse(raw)); diskHash = hash(raw); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = { schemaVersion: LIBRARY_BATCH_VERSION, queueId: randomUUID(), revision: 0, targetCount: 100,
        batchSize: 10, concurrency, createdAt: now(), updatedAt: now(), halt: null, batches: [] };
      await save(state);
    }
    if (items(state).some(item => item.status === 'running')) await mutate(next => {
      for (const item of items(next).filter(i => i.status === 'running')) {
        item.status = 'failed'; item.errorCode = 'INTERRUPTED'; item.recoveryRequired = true;
        item.attempts.at(-1).status = 'failed'; item.attempts.at(-1).failed = true; item.attempts.at(-1).finishedAt = now();
      }
      if (!next.halt) next.halt = { code: 'INTERRUPTED', operationId: null };
    });
  } catch (error) { await releaseOwner(); throw error; }

  async function execute(item) {
    const controller = new AbortController(); controllers.set(item.operationId, controller);
    const commitResult = outcome => commit(item.operationId, outcome);
    try {
      if (closing || find(state, item.operationId).cancelRequested) controller.abort();
      controller.signal.throwIfAborted();
      const result = await processOne({ batchId: item.batchId, operationId: item.operationId, source: structuredClone(item.source) }, { signal: controller.signal, commitResult });
      if (result !== undefined) await commitResult(result);
      else require(find(state, item.operationId).outcome !== null, 'INVALID_PROCESS_RESULT');
    } catch (error) {
      if (dataConflicts.has(error.code)) error = issue('SOURCE_BINDING_CONFLICT');
      const conflict = conflicts.has(error.code) || ['INVALID_PROCESS_RESULT', 'CHECKED_RESULT_REQUIRED'].includes(error.code);
      if (conflict && !fault) await halt(error.code, item.operationId);
      if (!fault && find(state, item.operationId).outcome === null) {
        await mutate(next => {
          const saved = find(next, item.operationId);
          saved.status = controller.signal.aborted ? 'cancelled' : 'failed';
          saved.errorCode = controller.signal.aborted ? 'CANCELLED' : 'PROCESSING_FAILED';
          saved.attempts.at(-1).status = saved.status; saved.attempts.at(-1).finishedAt = now();
          if (saved.status === 'failed') saved.attempts.at(-1).failed = true;
        });
      }
    } finally { controllers.delete(item.operationId); }
  }
  async function drain() {
    try {
      await assertOwner(); require(hash(await readState()) === diskHash, 'BATCH_STORE_CONFLICT');
      while (!closing && !fault && state.halt === null) {
        while (active.size < state.concurrency && !closing && state.halt === null) {
          const batch = state.batches.find(b => b.items.some(i => i.status === 'queued' || i.status === 'running' || active.has(i.operationId)));
          const queued = batch?.items.find(i => i.status === 'queued');
          if (!queued) break;
          const claimed = await mutate(next => {
            const item = find(next, queued.operationId);
            if (closing || next.halt !== null || item.status !== 'queued') return null;
            require(item.attempts.length === 0, 'RESULT_BINDING_CONFLICT');
            item.status = 'running'; item.attempts.push({ startedAt: now(), finishedAt: null, status: 'running', failed: false });
            return { ...structuredClone(item), batchId: batch.batchId };
          });
          if (!claimed) break;
          const work = execute(claimed); active.set(claimed.operationId, work);
          void work.finally(() => active.delete(claimed.operationId)).catch(() => {});
        }
        if (!active.size) break;
        await Promise.race(active.values());
      }
      await Promise.all(active.values());
      if (fault) throw fault;
      return projectLibraryBatchProgress(state);
    } catch (error) {
      if (error.code === 'BATCH_STORE_CONFLICT') { fault = error; controllers.forEach(c => c.abort()); }
      await Promise.allSettled(active.values());
      throw error;
    } finally { pump = null; }
  }
  return {
    progress: () => ({ ...projectLibraryBatchProgress(state), ...(fault ? { halted: true, haltCode: fault.code, goalMet: false } : {}) }),
    async addBatch({ batchId, sources }) {
      require(!closing, 'BATCH_QUEUE_CLOSED'); require(id(batchId) && Array.isArray(sources) && sources.length === 10);
      const bindings = sources.map(sourceBinding);
      try { await mutate(next => {
        const existing = next.batches.find(b => b.batchId === batchId);
        if (existing) { require(isDeepStrictEqual(existing.items.map(i => i.source), bindings), 'BATCH_CONFLICT'); return; }
        require(next.halt === null, 'BATCH_QUEUE_HALTED'); require(items(next).length + 10 <= 100, 'BATCH_TARGET_CAPACITY');
        const known = new Set(items(next).map(i => i.source.sourceId));
        for (const source of bindings) { require(!known.has(source.sourceId), 'SOURCE_BINDING_CONFLICT'); known.add(source.sourceId); }
        next.batches.push({ batchId, items: bindings.map(source => ({ source, sourceBindingSha256: sourceHash(source),
          operationId: operation(next.queueId, batchId, source), status: 'queued', attempts: [], outcome: null,
          errorCode: null, recoveryRequired: false, cancelRequested: false })) });
      }); } catch (error) { if (conflicts.has(error.code)) await halt(error.code); throw error; }
      return projectLibraryBatchProgress(state);
    },
    run() { require(!closing, 'BATCH_QUEUE_CLOSED'); if (fault) throw fault; if (!pump) pump = Promise.resolve().then(drain); return pump; },
    async setConcurrency(value) { require([2, 4].includes(value)); await mutate(next => { next.concurrency = value; }); return projectLibraryBatchProgress(state); },
    async cancelBatch(batchId) {
      await mutate(next => {
        const batch = next.batches.find(b => b.batchId === batchId); require(batch, 'UNKNOWN_BATCH');
        for (const item of batch.items) if (item.status === 'queued' || item.status === 'running') {
          item.cancelRequested = true;
          if (item.status === 'queued') { item.status = 'cancelled'; item.errorCode = 'CANCELLED'; }
        }
      });
      for (const item of state.batches.find(b => b.batchId === batchId).items) if (item.cancelRequested) controllers.get(item.operationId)?.abort();
      return projectLibraryBatchProgress(state);
    },
    async reconcile({ operationId, outcome }) { await commit(operationId, outcome, true); return projectLibraryBatchProgress(state); },
    async close() {
      if (closed) return;
      closing = true; controllers.forEach(c => c.abort());
      try { if (pump) await pump; await serial; } finally { closed = true; await releaseOwner(); }
    },
  };
}
