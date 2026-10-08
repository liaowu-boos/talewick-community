import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLibraryBatchQueue } from './library-batches.mjs';

const evidence = path.join(realpathSync(tmpdir()), 'talewick-batch-tests');
const hash = text => createHash('sha256').update(text).digest('hex');
const sources = (start = 0) => Array.from({ length: 10 }, (_, i) => ({ sourceId: `source-${start + i}`,
  sourceSha256: hash(`synthetic source ${start + i}`), textVersion: `text-v2-${start + i}`, expectedAnalysisVersion: null }));
const result = (request, status = 'completed') => ({ operationId: request.operationId, source: structuredClone(request.source), status,
  result: { resultId: 'result-' + request.source.sourceId, analysisVersion: 'analysis-' + request.source.sourceId,
    analysisSha256: hash('synthetic analysis for ' + request.source.sourceId), reviewRecordId: 'review-' + request.source.sourceId,
    reviewOutcome: status === 'completed' ? 'approved' : 'rejected', literalEvidence: 'passed', indexStatus: status === 'completed' ? 'ready' : 'blocked' }, errorCode: null });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, processOne, options = {}) {
  await mkdir(evidence, { recursive: true });
  const rootDir = await mkdtemp(path.join(evidence, '.queue-test-'));
  let queue = await createLibraryBatchQueue({ rootDir, processOne, ...options });
  t.after(async () => { await queue.close().catch(() => {}); await rm(rootDir, { recursive: true, force: true }); });
  return { rootDir, get queue() { return queue; }, async reopen(nextProcess = processOne) {
    await queue.close(); queue = await createLibraryBatchQueue({ rootDir, processOne: nextProcess }); return queue;
  } };
}
const disk = async root => JSON.parse(await readFile(path.join(root, 'queue.json'), 'utf8'));
const pause = () => new Promise(resolve => setImmediate(resolve));

for (const concurrency of [2, 4]) test(`100 checked, batches of ten, concurrency ${concurrency}, no interleaved batches`, async t => {
  let current = 0, peak = 0, calls = 0, gate = deferred(); const activeBatches = new Set(), overlaps = [];
  const f = await fixture(t, async request => {
    calls++; current++; peak = Math.max(peak, current); activeBatches.add(request.batchId);
    if (activeBatches.size > 1) overlaps.push([...activeBatches]);
    const ready = gate.promise;
    if (current === concurrency || calls % 10 === 0) { gate.resolve(); gate = deferred(); }
    await ready; await pause(); current--; if (!current) activeBatches.clear();
    return result(request);
  }, { concurrency });
  for (let i = 0; i < 10; i++) await f.queue.addBatch({ batchId: `batch-${i}`, sources: sources(i * 10) });
  assert.equal(f.queue.progress().attempts, 0, 'registration/open never dispatch');
  const p = await f.queue.run();
  assert.equal(p.checked, 100); assert.equal(p.completed, 100); assert.equal(p.goalMet, true);
  assert.equal(p.attempts, 100); assert.equal(p.failedAttempts, 0); assert.equal(calls, 100);
  assert.equal(peak, concurrency); assert.deepEqual(overlaps, []);
  assert.equal(p.batches.length, 10); assert.ok(p.batches.every(b => b.checked === 10));
  await f.reopen(async () => assert.fail('bound results must not run twice'));
  assert.equal((await f.queue.run()).checked, 100);
});

test('pilot ten stays 10/100; failed attempts and needs_review are not checked', async t => {
  const f = await fixture(t, async request => {
    if (request.source.sourceId === 'source-0') throw Error('PRIVATE_PROVIDER_BODY_SHOULD_NOT_BE_SAVED');
    return result(request, request.source.sourceId === 'source-1' ? 'needs_review' : 'completed');
  });
  await f.queue.addBatch({ batchId: 'pilot10', sources: sources() });
  const p = await f.queue.run();
  assert.equal(p.checked, 8); assert.equal(p.failed, 1); assert.equal(p.failedAttempts, 1); assert.equal(p.needs_review, 1);
  assert.equal(p.attempts, 10); assert.equal(p.targetCount, 100); assert.equal(p.remainingChecked, 92); assert.equal(p.goalMet, false);
  assert.doesNotMatch(await readFile(path.join(f.rootDir, 'queue.json'), 'utf8'), /PRIVATE_PROVIDER_BODY/);
  const next = await f.reopen(async () => assert.fail('terminal failure/review is not an automatic retry'));
  assert.equal((await next.run()).attempts, 10);
});

test('empty run does not prevent a later registered batch from running', async t => {
  const f = await fixture(t, async request => result(request));
  assert.equal((await f.queue.run()).registered, 0);
  await f.queue.addBatch({ batchId: 'later', sources: sources() });
  assert.equal((await f.queue.run()).checked, 10);
});

test('a ready source-text index with rejected analysis remains needs_review across recovery', async t => {
  const f = await fixture(t, async request => {
    const value = result(request, 'needs_review');
    value.result.indexStatus = 'ready';
    return value;
  });
  await f.queue.addBatch({ batchId: 'raw-index-only', sources: sources() });
  const progress = await f.queue.run();
  assert.equal(progress.checked, 0);
  assert.equal(progress.needs_review, 10);
  assert.equal(progress.goalMet, false);
  await f.reopen(async () => assert.fail('raw-index readiness does not authorize a retry or promotion'));
  const restored = await f.queue.run();
  assert.equal(restored.checked, 0);
  assert.equal(restored.needs_review, 10);
});

test('registration is idempotent, atomic, bound to order/version, and stops on conflict', async t => {
  const f = await fixture(t, async request => result(request));
  await Promise.all([f.queue.addBatch({ batchId: 'same', sources: sources() }), f.queue.addBatch({ batchId: 'same', sources: sources() })]);
  assert.equal(f.queue.progress().registered, 10);
  const changed = sources(); changed[0].textVersion = 'text-changed';
  await assert.rejects(f.queue.addBatch({ batchId: 'same', sources: changed }), { code: 'BATCH_CONFLICT' });
  const p = await f.queue.run(); assert.equal(p.attempts, 0); assert.equal(p.halted, true); assert.equal(p.registered, 10);
});

test('missing versions, partial batches and target overflow cannot register', async t => {
  const f = await fixture(t, async request => result(request));
  const bad = sources(); delete bad[0].expectedAnalysisVersion;
  await assert.rejects(f.queue.addBatch({ batchId: 'bad', sources: bad }), { code: 'INVALID_BATCH_INPUT' });
  await assert.rejects(f.queue.addBatch({ batchId: 'bad', sources: sources().slice(1) }), { code: 'INVALID_BATCH_INPUT' });
  assert.equal(f.queue.progress().registered, 0);
  for (let i = 0; i < 10; i++) await f.queue.addBatch({ batchId: 'batch-' + i, sources: sources(i * 10) });
  await assert.rejects(f.queue.addBatch({ batchId: 'extra', sources: sources(100) }), { code: 'BATCH_TARGET_CAPACITY' });
  assert.equal(f.queue.progress().registered, 100);
});

test('same source cannot be counted again under another batch or version', async t => {
  const f = await fixture(t, async request => result(request));
  await f.queue.addBatch({ batchId: 'first', sources: sources() });
  const duplicate = sources(10); duplicate[0] = { ...sources()[0], textVersion: 'changed' };
  await assert.rejects(f.queue.addBatch({ batchId: 'second', sources: duplicate }), { code: 'SOURCE_BINDING_CONFLICT' });
  assert.equal(f.queue.progress().halted, true); assert.equal(f.queue.progress().registered, 10);
});

for (const [name, change, code] of [
  ['saved original alone', value => { value.result = { sourceStored: true }; }, 'INVALID_PROCESS_RESULT'],
  ['unapproved analysis', value => { value.result.reviewOutcome = 'rejected'; }, 'CHECKED_RESULT_REQUIRED'],
  ['unready index', value => { value.result.indexStatus = 'blocked'; }, 'CHECKED_RESULT_REQUIRED'],
  ['wrong source version', value => { value.source.textVersion = 'changed'; }, 'SOURCE_BINDING_CONFLICT'],
  ['wrong operation', value => { value.operationId = 'other'; }, 'SOURCE_BINDING_CONFLICT'],
]) test(`${name} cannot complete a source and halts further dispatch`, async t => {
  let calls = 0;
  const f = await fixture(t, async request => { calls++; const value = result(request); change(value); return value; });
  await f.queue.addBatch({ batchId: 'batch', sources: sources() });
  const p = await f.queue.run(); assert.equal(p.checked, 0); assert.equal(p.haltCode, code); assert.ok(calls <= 2); assert.ok(p.queued >= 8);
});

test('durably committed result survives provider return failure and is not repeated after reopen', async t => {
  let calls = 0;
  const f = await fixture(t, async (request, { commitResult }) => {
    calls++; const value = result(request); await commitResult(value); await commitResult(value);
    throw Error('synthetic connection closed after durable commit');
  });
  await f.queue.addBatch({ batchId: 'batch', sources: sources() });
  assert.equal((await f.queue.run()).checked, 10); assert.equal(calls, 10);
  await f.reopen(async () => { calls++; assert.fail('no replay'); });
  assert.equal((await f.queue.run()).attempts, 10); assert.equal(calls, 10);
});

test('conflicting second result halts the queue and keeps the first bound result', async t => {
  const f = await fixture(t, async (request, { commitResult }) => {
    const value = result(request); await commitResult(value);
    const different = structuredClone(value); different.result.analysisSha256 = '0'.repeat(64);
    await commitResult(different);
  });
  await f.queue.addBatch({ batchId: 'batch', sources: sources() });
  const p = await f.queue.run(); assert.equal(p.haltCode, 'RESULT_BINDING_CONFLICT'); assert.ok(p.checked >= 1 && p.checked <= 2);
  for (const item of (await disk(f.rootDir)).batches[0].items.filter(i => i.outcome)) assert.notEqual(item.outcome.result.analysisSha256, '0'.repeat(64));
});

test('cancellation stops queued items and signals in-flight work without marking it checked', async t => {
  const ready = deferred(); let calls = 0;
  const f = await fixture(t, async (_, { signal }) => {
    calls++; if (calls === 2) ready.resolve();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await f.queue.addBatch({ batchId: 'batch', sources: sources() }); const work = f.queue.run(); await ready.promise;
  await f.queue.cancelBatch('batch'); const p = await work;
  assert.equal(p.cancelled, 10); assert.equal(p.checked, 0); assert.equal(p.attempts, 2); assert.equal(p.failedAttempts, 0);
});

test('recovery of interrupted running requires bound reconciliation, never automatic replay', async t => {
  const ready = deferred(); let calls = 0;
  const f = await fixture(t, async (_, { signal }) => {
    if (++calls === 2) ready.resolve();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await f.queue.addBatch({ batchId: 'batch', sources: sources() }); const work = f.queue.run(); await ready.promise;
  // Simulates the on-disk state at abrupt process loss; no child process is spawned.
  const interrupted = await disk(f.rootDir);
  await f.queue.cancelBatch('batch'); await work; await f.queue.close();
  await writeFile(path.join(f.rootDir, 'queue.json'), JSON.stringify(interrupted));
  let resumedCalls = 0; const queue = await f.reopen(async request => { resumedCalls++; return result(request); });
  let p = await queue.run(); assert.equal(p.haltCode, 'INTERRUPTED'); assert.equal(p.checked, 0); assert.equal(p.recoveryRequired, 2); assert.equal(resumedCalls, 0);
  const pending = p.batches[0].items.filter(i => i.recoveryRequired);
  for (const item of pending) await queue.reconcile({ operationId: item.operationId, outcome: result(item) });
  p = await queue.run(); assert.equal(resumedCalls, 8); assert.equal(p.checked, 10); assert.equal(p.attempts, 10); assert.equal(p.failedAttempts, 2);
});

test('disk drift and another owner refuse work without clobbering persisted bytes', async t => {
  const f = await fixture(t, async request => result(request));
  await assert.rejects(createLibraryBatchQueue({ rootDir: f.rootDir, processOne: async () => {} }), { code: 'BATCH_STORE_BUSY' });
  await f.queue.addBatch({ batchId: 'batch', sources: sources() });
  const changed = await readFile(path.join(f.rootDir, 'queue.json'), 'utf8') + ' ';
  await writeFile(path.join(f.rootDir, 'queue.json'), changed);
  await assert.rejects(f.queue.run(), { code: 'BATCH_STORE_CONFLICT' });
  assert.equal(f.queue.progress().haltCode, 'BATCH_STORE_CONFLICT');
  assert.equal(await readFile(path.join(f.rootDir, 'queue.json'), 'utf8'), changed);
});

test('concurrency accepts only two or four and persists across reopen', async t => {
  const f = await fixture(t, async request => result(request));
  await assert.rejects(f.queue.setConcurrency(3), { code: 'INVALID_BATCH_INPUT' });
  await f.queue.setConcurrency(4); const q = await f.reopen(); assert.equal(q.progress().concurrency, 4);
});

test('running intent and exact source binding are durable before processOne starts', async t => {
  let f;
  f = await fixture(t, async request => {
    const saved = (await disk(f.rootDir)).batches.flatMap(b => b.items).find(i => i.operationId === request.operationId);
    assert.equal(saved.status, 'running'); assert.equal(saved.attempts.length, 1); assert.deepEqual(saved.source, request.source);
    return result(request);
  });
  await f.queue.addBatch({ batchId: 'batch', sources: sources() }); assert.equal((await f.queue.run()).checked, 10);
});

for (const committed of [false, true]) test(`DATA version conflict stops dispatch, committed=${committed}`, async t => {
  let calls = 0;
  const f = await fixture(t, async (request, { commitResult }) => {
    calls++; if (committed) await commitResult(result(request));
    throw Object.assign(Error('private details'), { code: 'VERSION_CONFLICT' });
  });
  await f.queue.addBatch({ batchId: 'batch', sources: sources() });
  const p = await f.queue.run(); assert.equal(p.haltCode, 'SOURCE_BINDING_CONFLICT'); assert.ok(calls <= 2); assert.equal(p.goalMet, false);
  if (!committed) assert.equal(p.checked, 0);
});

test('a result ID cannot be rebound to another source', async t => {
  const f = await fixture(t, async request => { const value = result(request); value.result.resultId = 'shared-result'; return value; });
  await f.queue.addBatch({ batchId: 'batch', sources: sources() }); const p = await f.queue.run();
  assert.equal(p.checked, 1); assert.equal(p.haltCode, 'RESULT_BINDING_CONFLICT');
});

test('owner markers are never removed or reclaimed automatically', async t => {
  const f = await fixture(t, async request => result(request)); await f.queue.close();
  const owner = JSON.stringify({ pid: 2147480000, token: 'synthetic-stale-owner' });
  await writeFile(path.join(f.rootDir, '.owner.json'), owner);
  await assert.rejects(createLibraryBatchQueue({ rootDir: f.rootDir, processOne: async () => {} }), { code: 'BATCH_STORE_BUSY' });
  assert.equal(await readFile(path.join(f.rootDir, '.owner.json'), 'utf8'), owner);
});
