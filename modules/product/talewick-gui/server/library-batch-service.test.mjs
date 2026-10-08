import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createLibraryBatchService } from './library-batch-service.mjs';
import { decodeImport } from './library.mjs';
import { createLibraryService } from '../../../data/runtime/library.mjs';
import { ANALYSIS_REVIEW_CHECKS, ANALYSIS_REVIEW_RUBRIC } from '../../../data/runtime/analysis-review.mjs';

// Actual DATA persistence/validation/indexing. Only the model is deterministic.
const evidence = path.join(realpathSync(tmpdir()), 'talewick-batch-tests');
const hash = value => createHash('sha256').update(value).digest('hex');
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { release, promise }; };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function until(check) {
  for (let i = 0; i < 1200; i++) { const result = await check(); if (result) return result; await pause(); }
  assert.fail('deterministic test condition did not settle');
}
const sources = (start = 0) => Array.from({ length: 10 }, (_, i) => decodeImport({ requestId: `input-${start + i}`, fileName: `${start + i}.txt`,
  contentBase64: Buffer.from(`她收起围巾。编号${start + i}。\r\n她没有回头。`).toString('base64') }));
const candidate = () => ({ evidenceMode: 'source-lines-v1', overview: '收起围巾后离开', coverage: { scope: 'unknown', notes: ['合成输入，外部完整度未知'] },
  units: [{ id: 'U1', title: '动作', locator: { lineStart: 1, lineEnd: 2 }, event: '她收起围巾，没有回头', psychology: '动机未知', emotion: '情绪未知',
    expression: '收起围巾的动作', readerEffectHypothesis: '可能使读者注意她的离开', evidence: [{ lineStart: 1, lineEnd: 2 }], relatedUnitIds: [] }], limitations: ['只测接口，不证明文学质量'] });
const review = (approved = true) => ({ approved, notes: ['确定性合成复核'], rubricVersion: ANALYSIS_REVIEW_RUBRIC,
  checks: ANALYSIS_REVIEW_CHECKS.map(id => ({ id, status: !approved && id === 'inference_strength' ? 'needs_revision' : 'passed', notes: ['测试依据'], unitIds: ['U1'] })) });
const response = request => JSON.stringify(request.stage === 'library-review' ? review() : candidate());
async function fixture(t, { complete = response, processingConcurrency, concurrency = 2, reviewAnalysis, ownsLibrary, wrap = lib => lib } = {}) {
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(path.join(evidence, '.integration-'));
  const dataRoot = path.join(root, 'data'), serviceRoot = path.join(root, 'batch');
  const calls = [], releases = [], services = [], libraries = [];
  const openLibrary = async () => {
    const lib = await createLibraryService({ rootDir: dataRoot, processingConcurrency, reviewAnalysis,
      model: { complete: async request => { calls.push(request); return complete(request); } } });
    libraries.push(lib); return lib;
  };
  let library = await openLibrary(), service = await createLibraryBatchService({ rootDir: serviceRoot, library: wrap(library), concurrency, ownsLibrary });
  services.push(service);
  t.after(async () => {
    releases.forEach(release => release());
    try { for (const s of services) await s.close().catch(() => {}); for (const lib of libraries) await lib.close().catch(() => {}); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  return { root, dataRoot, serviceRoot, calls, get library() { return library; }, get service() { return service; },
    hold() { const held = gate(); releases.push(held.release); return held; },
    async reopen({ beforeOpen, nextWrap = wrap } = {}) {
      await service.close();
      await library.close(); // The fixture host owns shared DATA lifetime.
      if (beforeOpen) await beforeOpen();
      library = await openLibrary();
      service = await createLibraryBatchService({ rootDir: serviceRoot, library: nextWrap(library), concurrency, ownsLibrary });
      services.push(service); return service;
    },
    journal: () => json(path.join(serviceRoot, 'service.json')),
    queue: () => json(path.join(serviceRoot, 'queue', 'queue.json')),
    catalog: () => json(path.join(dataRoot, 'catalog.json')),
  };
}

test('real DATA: bytes, canonical versions, operation intent, approved review and ready index bind end to end', async t => {
  let f;
  f = await fixture(t, { wrap: lib => ({ ...lib, async startSource(id, binding) {
    const queue = await f.queue(), journal = await f.journal();
    const item = queue.batches.flatMap(b => b.items).find(i => i.source.sourceId === id);
    const operation = journal.operations.find(op => op.operationId === item.operationId);
    assert.equal(item.status, 'running'); assert.equal(item.attempts.length, 1);
    assert.deepEqual(operation.source, item.source);
    assert.equal(operation.events.at(-1).kind, 'start_intent');
    assert.deepEqual(binding, { expectedTextVersion: item.source.textVersion, expectedAnalysisVersion: null });
    return lib.startSource(id, binding);
  } }) });
  const input = sources();
  const initial = await f.service.addBatch({ batchId: 'pilot', sources: input });
  assert.equal(initial.registered, 10); assert.equal(f.calls.length, 0);
  const catalog = await f.catalog(); assert.equal(catalog.sources.length, 10); assert.ok(catalog.sources.every(s => s.deferred));
  for (const [i, row] of catalog.sources.entries()) assert.deepEqual(await readFile(path.join(f.dataRoot, 'objects', row.sourceSha256 + '.bin')), input[i].bytes);
  const result = await f.service.run();
  assert.equal(result.checked, 10); assert.equal(result.remainingChecked, 90); assert.equal(result.goalMet, false); assert.equal(f.calls.length, 20);
  const journal = await f.journal();
  for (const item of result.batches[0].items) {
    const row = await f.library.get(item.source.sourceId, { includeAnalysis: true });
    const index = await json(path.join(f.dataRoot, 'indexes', row.sourceId + '.json'));
    const op = journal.operations.find(o => o.operationId === item.operationId);
    assert.equal(row.analysis.reviewStatus, 'checked'); assert.equal(row.analysis.validation.literalEvidence, 'passed');
    assert.equal(item.result.analysisSha256, hash(JSON.stringify(row.analysis)));
    assert.equal(item.result.reviewRecordId, row.analysis.validation.semanticReview.recordId);
    assert.equal(op.evidence.indexVersion, row.indexVersion);
    assert.equal(op.evidence.semanticReviewSha256, hash(JSON.stringify(row.analysis.validation.semanticReview)));
    assert.deepEqual(op.evidence.indexBinding, await f.library.verifyIndexBinding(row.sourceId, { expectedTextVersion: row.textVersion, expectedAnalysisVersion: row.analysis.version }));
    assert.equal(op.evidence.indexBinding.indexSha256, hash(await readFile(path.join(f.dataRoot, 'indexes', row.sourceId + '.json'))));
    assert.equal(item.result.indexBinding, undefined, 'the queue outcome schema remains unchanged');
    assert.ok(index.entries.every(e => e.id.startsWith(row.sourceId + ':'))); assert.equal(index.textVersion, row.textVersion);
    assert.ok(index.entries.some(e => e.use !== 'raw_reference'));
  }
  await writeFile(path.join(evidence, 'real-data-bindings.json'), JSON.stringify({ synthetic: true, progress: result, operations: journal.operations }, null, 2));
  await f.service.addBatch({ batchId: 'pilot', sources: input }); assert.equal((await f.service.run()).attempts, 10);
  const before = JSON.stringify((await f.catalog()).sources);
  await f.reopen(); assert.equal(f.calls.length, 20); assert.equal((await f.service.run()).checked, 10);
  assert.equal(JSON.stringify((await f.catalog()).sources), before); assert.equal(f.calls.length, 20);
});

test('all ten inputs preflight before registration: invalid tenth, duplicate bytes, request conflicts and bounds', async t => {
  const f = await fixture(t);
  for (const change of [a => { a[9].bytes = Buffer.from([255]); }, a => { a[9].bytes = Buffer.alloc(128001, 65); },
    a => { a[9].bytes = Buffer.from('a'.repeat(24001)); }, a => { a[9].bytes = a[0].bytes; },
    a => { a[9].fileName = '../private.txt'; }, a => { a[9].requestId = a[0].requestId; }]) {
    const input = sources(); change(input);
    await assert.rejects(f.service.addBatch({ batchId: 'invalid', sources: input }));
    assert.equal((await f.catalog()).sources.length, 0); assert.equal(f.calls.length, 0);
  }
  await assert.rejects(f.service.addBatch({ batchId: 'nine', sources: sources().slice(1) }));
  await f.service.addBatch({ batchId: 'valid', sources: sources() });
  await assert.rejects(f.service.addBatch({ batchId: 'alias', sources: sources().map((s, i) => ({ ...s, requestId: `alias-${i}`, fileName: `alias-${i}.txt` })) }), { code: 'DUPLICATE_SOURCE' });
  await assert.rejects(f.service.addBatch({ batchId: 'valid', sources: sources(100) }), { code: 'BATCH_CONFLICT' });
  assert.equal((await f.catalog()).sources.length, 10); assert.equal(f.calls.length, 0);
});

for (const afterSave of [false, true]) test(`registration failure preserves saved records and resumes idempotently, lost response=${afterSave}`, async t => {
  let attempts = 0, injected = false;
  const f = await fixture(t, { wrap: lib => ({ ...lib, async registerSource(input) {
    if (++attempts === 4 && !injected) {
      injected = true; if (afterSave) await lib.registerSource(input);
      throw Object.assign(Error('PRIVATE_REGISTER_BODY'), { code: 'untrusted-private-code' });
    }
    return lib.registerSource(input);
  } }) });
  await assert.rejects(f.service.addBatch({ batchId: 'resume', sources: sources() }), error => error.message === 'PROCESSING_FAILED');
  assert.equal((await f.catalog()).sources.length, afterSave ? 4 : 3); assert.equal(f.service.progress().registered, 0);
  assert.equal(f.service.progress().registrations[0].saved, 3); assert.equal(f.calls.length, 0);
  const savedIds = (await f.catalog()).sources.map(s => s.sourceId);
  await f.reopen();
  await f.service.addBatch({ batchId: 'resume', sources: sources() });
  assert.deepEqual((await f.catalog()).sources.slice(0, savedIds.length).map(s => s.sourceId), savedIds);
  assert.equal((await f.catalog()).sources.length, 10); assert.equal(f.calls.length, 0);
  assert.equal((await f.service.run()).checked, 10); assert.equal((await f.journal()).batches[0].failures.length, 1);
  assert.doesNotMatch(await readFile(path.join(f.serviceRoot, 'service.json'), 'utf8'), /PRIVATE_REGISTER_BODY|untrusted-private-code/);
});

test('canonical alias uses old canonical ID and text version, never ten aliases as ten results', async t => {
  const f = await fixture(t);
  const input = sources(), originals = [];
  for (const [i, s] of input.entries()) originals.push(await f.library.registerSource({ ...s, requestId: `old-${i}`, fileName: `old-${i}.txt` }));
  await f.service.addBatch({ batchId: 'aliases', sources: input });
  assert.deepEqual(f.service.progress().batches[0].items.map(i => i.source.sourceId), originals.map(s => s.sourceId));
  assert.equal((await f.catalog()).sources.filter(s => s.duplicateOf).length, 10);
  assert.equal((await f.service.run()).checked, 10); assert.equal(f.calls.length, 20);
});

for (const reviewAnalysis of [undefined, null]) test(`needs_review with a real raw ready index stays unchecked; reviewer=${reviewAnalysis === null ? 'disabled' : 'rejected'}`, async t => {
  const f = await fixture(t, { reviewAnalysis, complete: request => JSON.stringify(request.stage === 'library-review' ? review(false) : candidate()) });
  await f.service.addBatch({ batchId: 'review', sources: sources() }); const p = await f.service.run();
  assert.equal(p.checked, 0); assert.equal(p.needs_review, 10); assert.equal(p.failed, 0);
  for (const item of p.batches[0].items) {
    assert.equal(item.result.indexStatus, 'ready');
    assert.equal(item.result.reviewOutcome, reviewAnalysis === null ? 'unverified' : 'rejected');
    const index = await json(path.join(f.dataRoot, 'indexes', item.source.sourceId + '.json'));
    assert.ok(index.entries.length); assert.ok(index.entries.every(e => e.use === 'raw_reference'));
  }
  const calls = f.calls.length; await f.reopen(); assert.equal((await f.service.run()).needs_review, 10); assert.equal(f.calls.length, calls);
});

test('invalid analysis and review responses retain exact DATA originals; repeated run/reopen never retry failures', async t => {
  const bad = 'PRIVATE_INVALID_MODEL_RESPONSE';
  const f = await fixture(t, { complete: request => request.stage === 'library-analysis' ? JSON.stringify(candidate()) : bad });
  await f.service.addBatch({ batchId: 'failures', sources: sources() });
  const p = await f.service.run(); assert.equal(p.failed, 10); assert.equal(p.failedAttempts, 10); assert.equal(p.checked, 0);
  const drafts = await readdir(path.join(f.dataRoot, 'drafts'));
  const records = await Promise.all(drafts.map(name => json(path.join(f.dataRoot, 'drafts', name))));
  assert.equal(records.filter(r => r.rawResponse === bad).length, 10);
  const before = await f.catalog(); assert.ok(before.sources.every(s => s.analysis.validation.semanticReviewHistory.length === 1));
  const journalBefore = await f.journal();
  assert.doesNotMatch(JSON.stringify(p) + JSON.stringify(journalBefore) + JSON.stringify(await f.queue()), /PRIVATE_INVALID_MODEL_RESPONSE/);
  await f.service.run(); await f.reopen(); await f.service.run(); assert.equal(f.calls.length, 20);
  assert.deepEqual((await f.catalog()).sources, before.sources);
  assert.deepEqual((await f.journal()).operations, journalBefore.operations);
});

for (const processingConcurrency of [undefined, 2, 4]) test(`real DATA call peak ${processingConcurrency ?? 1} with product slots ${processingConcurrency ?? 2}`, async t => {
  let active = 0, peak = 0, f; const live = new Set();
  f = await fixture(t, { concurrency: processingConcurrency ?? 2, processingConcurrency, complete: async request => {
    const key = JSON.parse(request.user).textVersion;
    assert.equal(live.has(key), false); live.add(key); active++; peak = Math.max(peak, active);
    try { await hold.promise; return response(request); } finally { active--; live.delete(key); }
  } });
  const hold = f.hold();
  await f.service.addBatch({ batchId: 'parallel', sources: sources() });
  const running = f.service.run(); await until(() => active === (processingConcurrency ?? 1)); hold.release();
  assert.equal((await running).checked, 10); assert.equal(peak, processingConcurrency ?? 1); assert.equal(active, 0);
});

test('ten real batches reach 100 checked without interleaved batches or extra retries', async t => {
  let f;
  f = await fixture(t, { concurrency: 4, processingConcurrency: 4, wrap: lib => ({ ...lib, async startSource(id, binding) {
    const state = await f.queue(), b = state.batches.find(b => b.items.some(i => i.source.sourceId === id));
    const previous = state.batches.slice(0, state.batches.indexOf(b));
    assert.ok(previous.every(batch => batch.items.every(i => i.status === 'completed')));
    return lib.startSource(id, binding);
  } }) });
  for (let b = 0; b < 10; b++) await f.service.addBatch({ batchId: `batch-${b}`, sources: sources(b * 10) });
  await assert.rejects(f.service.addBatch({ batchId: 'overflow', sources: sources(100) }), { code: 'BATCH_TARGET_CAPACITY' });
  assert.equal(f.calls.length, 0);
  const p = await f.service.run(); assert.equal(p.checked, 100); assert.equal(p.goalMet, true); assert.equal(p.attempts, 100);
  assert.equal((await f.catalog()).sources.length, 100); assert.equal(f.calls.length, 200);
});

test('recovery reads genuine DATA completion after lost queue commit and preserves original failed attempt history', async t => {
  const f = await fixture(t); await f.service.addBatch({ batchId: 'crash', sources: sources() }); await f.service.run();
  const snapshot = await f.queue(), journal = await f.journal();
  const interrupted = snapshot.batches[0].items[0];
  Object.assign(interrupted, { status: 'running', outcome: null, errorCode: null });
  Object.assign(interrupted.attempts[0], { status: 'running', finishedAt: null });
  const op = journal.operations.find(o => o.operationId === interrupted.operationId);
  op.outcome = null; op.evidence = null; op.events = op.events.filter(e => e.kind !== 'outcome');
  await f.reopen({ beforeOpen: async () => {
    await writeFile(path.join(f.serviceRoot, 'queue', 'queue.json'), JSON.stringify(snapshot));
    await writeFile(path.join(f.serviceRoot, 'service.json'), JSON.stringify(journal));
  } });
  assert.equal(f.service.progress().recoveryRequired, 1); assert.equal(f.calls.length, 20);
  const p = await f.service.run(); assert.equal(p.checked, 10); assert.equal(p.attempts, 10); assert.equal(p.failedAttempts, 1);
  assert.equal(p.recoveryRequired, 0); assert.equal(f.calls.length, 20);
  assert.ok((await f.journal()).operations.find(o => o.operationId === op.operationId).events.some(e => e.kind === 'reconciled'));
});

for (const hasIntent of [false, true]) test(`crash before DATA start never replays uncertain operation, intent=${hasIntent}`, async t => {
  const f = await fixture(t); await f.service.addBatch({ batchId: 'before-start', sources: sources() });
  const snapshot = await f.queue(), journal = await f.journal(), item = snapshot.batches[0].items[0];
  Object.assign(item, { status: 'running', attempts: [{ status: 'running', startedAt: new Date().toISOString(), finishedAt: null, failed: false }] });
  if (hasIntent) journal.operations.push({ batchId: 'before-start', operationId: item.operationId, source: item.source,
    events: [{ kind: 'bound' }, { kind: 'start_intent' }], outcome: null, evidence: null });
  await f.reopen({ beforeOpen: async () => {
    await writeFile(path.join(f.serviceRoot, 'queue', 'queue.json'), JSON.stringify(snapshot));
    await writeFile(path.join(f.serviceRoot, 'service.json'), JSON.stringify(journal));
  } });
  const p = await f.service.run(); assert.equal(p.checked, 9); assert.equal(p.failed, 1); assert.equal(p.failedAttempts, 1);
  assert.equal((await f.library.get(item.source.sourceId)).status, 'deferred'); assert.equal(f.calls.length, 18);
  await f.service.run(); assert.equal(f.calls.length, 18);
});

for (const action of ['cancel', 'close']) test(`${action} waits ignored AbortSignal and both owner files remain until underlying DATA promise settles`, async t => {
  const f = await fixture(t, { processingConcurrency: 2, complete: async request => { await held.promise; return response(request); } });
  const held = f.hold(); await f.service.addBatch({ batchId: 'late', sources: sources() });
  await f.service.addBatch({ batchId: 'later-batch', sources: sources(10) });
  const running = f.service.run(); await until(() => f.calls.length === 2);
  let finished = false;
  const stop = (action === 'cancel' ? f.service.cancelBatch('late') : f.service.close()).then(p => { finished = true; return p; });
  await until(() => f.calls.every(c => c.signal.aborted));
  assert.equal(finished, false); assert.equal(f.calls.length, 2);
  assert.equal((await json(path.join(f.dataRoot, 'owner.json'))).pid, process.pid);
  assert.equal((await json(path.join(f.serviceRoot, 'queue', '.owner.json'))).pid, process.pid);
  await until(async () => (await f.catalog()).sources.slice(0, 2).every(s => s.status === 'cancelled'));
  assert.equal(finished, false); assert.equal(f.service.progress().running, 2, 'visible DATA cancellation must not release queue operations');
  const again = action === 'close' ? f.service.close() : f.service.cancelBatch('late'); await pause(); assert.equal(finished, false);
  held.release(); await Promise.all([stop, again, running]); assert.equal(finished, true);
  assert.equal(f.calls.length, action === 'close' ? 2 : 22); assert.equal(f.service.progress().checked, action === 'close' ? 0 : 10);
  if (action === 'close') {
    await assert.rejects(readFile(path.join(f.dataRoot, 'owner.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(f.serviceRoot, 'queue', '.owner.json')), { code: 'ENOENT' });
  } else {
    assert.equal(f.service.progress().closed, false); assert.equal(f.service.progress().requiresReopen, false);
    assert.equal((await json(path.join(f.dataRoot, 'owner.json'))).pid, process.pid);
    assert.equal((await json(path.join(f.serviceRoot, 'queue', '.owner.json'))).pid, process.pid);
  }
  assert.ok((await f.catalog()).sources.slice(0, 2).every(s => s.status === 'cancelled' && !s.analysis));
  if (action === 'close') {
    assert.equal(f.service.progress().batches[1].queued, 10);
    await assert.rejects(f.service.run(), { code: 'BATCH_SERVICE_CLOSED' });
  }
  await f.reopen(); await f.service.run();
  assert.equal(f.calls.filter(c => JSON.parse(c.user).textVersion === f.service.progress().batches[0].items[0].source.textVersion).length, 1);
});

test('live source drift halts dispatch without model calls or private error leakage', async t => {
  let drift = false;
  const f = await fixture(t, { wrap: lib => ({ ...lib, async get(id, options) {
    const row = await lib.get(id, options); if (drift) row.textVersion = 'wrong-version'; return row;
  } }) });
  await f.service.addBatch({ batchId: 'drift', sources: sources() }); drift = true;
  await assert.rejects(f.service.run(), { code: 'SOURCE_BINDING_CONFLICT' });
  assert.equal(f.service.progress().checked, 0); assert.equal(f.calls.length, 0);
});

test('service journal drift and second owner refuse dispatch without overwriting disk', async t => {
  const f = await fixture(t); await f.service.addBatch({ batchId: 'guard', sources: sources() });
  await assert.rejects(createLibraryBatchService({ rootDir: f.serviceRoot, library: f.library }), { code: 'BATCH_STORE_BUSY' });
  const file = path.join(f.serviceRoot, 'service.json'), changed = await readFile(file, 'utf8') + ' ';
  await writeFile(file, changed);
  await f.service.run(); assert.equal(f.calls.length, 0); assert.equal(await readFile(file, 'utf8'), changed);
  assert.equal(f.service.progress().halted, true);
});

test('missing DATA interface fails explicitly and does not fabricate a drain capability', async () => {
  await assert.rejects(createLibraryBatchService({ library: { get() {} }, rootDir: evidence }), { code: 'DATA_INTERFACE_MISSING' });
});

for (const [name, change] of [
  ['review bound to another source', row => { row.analysis.validation.semanticReview.sourceId = 'another'; }],
  ['review bound to another analysis', row => { row.analysis.validation.semanticReview.analysisVersion = 'another'; }],
  ['unverified literal evidence', row => { row.analysis.validation.literalEvidence = 'failed'; }],
  ['candidate status despite approved response', row => { row.analysis.reviewStatus = 'candidate'; }],
  ['unready index', row => { row.indexStatus = 'failed'; }],
]) test(`genuine completed DATA result cannot pass gate after ${name}`, async t => {
  const f = await fixture(t, { wrap: lib => ({ ...lib, async waitSource(id, options) {
    const row = await lib.waitSource(id, options); if (row.status === 'completed' && row.analysis) change(row); return row;
  } }) });
  await f.service.addBatch({ batchId: 'gate', sources: sources() });
  const p = await f.service.run(); assert.equal(p.checked, 0); assert.equal(p.halted, true);
  assert.ok(p.failedAttempts >= 1); assert.ok(f.calls.length >= 2 && f.calls.length <= 4);
  assert.ok((await f.catalog()).sources.some(s => s.analysis?.reviewStatus === 'checked'), 'a real analysis/review preceded the deliberately damaged bridge response');
});

test('lost start response records failure before cancellation and waits the genuine accepted call', async t => {
  let f, injected = false;
  f = await fixture(t, { complete: async request => { await held.promise; return response(request); }, wrap: lib => ({ ...lib, async startSource(id, binding) {
    const result = await lib.startSource(id, binding);
    if (!injected) { injected = true; await until(() => f.calls.length === 1); throw Error('PRIVATE_START_RESPONSE'); }
    return result;
  } }) });
  const held = f.hold(); await f.service.addBatch({ batchId: 'lost', sources: sources() });
  let settled = false;
  const work = f.service.run().then(p => { settled = true; return p; });
  await until(() => f.calls[0]?.signal.aborted); await pause();
  assert.equal(settled, false); assert.equal((await json(path.join(f.dataRoot, 'owner.json'))).pid, process.pid);
  held.release(); const p = await work;
  assert.equal(p.checked, 9); assert.equal(p.failed, 1); assert.equal(p.failedAttempts, 1);
  assert.doesNotMatch(JSON.stringify(await f.journal()) + JSON.stringify(p), /PRIVATE_START_RESPONSE/);
  const calls = f.calls.length; await f.reopen();
  const failedSource = p.batches[0].items.find(i => i.status === 'failed').source;
  await f.service.run();
  assert.equal(f.calls.filter(c => JSON.parse(c.user).textVersion === failedSource.textVersion).length, 1);
  assert.ok(f.calls.length >= calls);
});

test('close rejection is explicit, never reported as a completed underlying drain', async t => {
  const f = await fixture(t, { complete: async request => { await held.promise; return response(request); },
    wrap: lib => ({ ...lib, async close() { throw Error('PRIVATE_CLOSE_BODY'); } }) });
  const held = f.hold(); await f.service.addBatch({ batchId: 'close-failed', sources: sources() });
  const running = f.service.run(); await until(() => f.calls.length === 1);
  const closing = f.service.close(); void closing.catch(() => {});
  await until(() => f.calls[0].signal.aborted); held.release();
  await assert.rejects(closing, error => error.code === 'DATA_CLOSE_FAILED' && error.message === 'DATA_CLOSE_FAILED');
  assert.equal(f.service.progress().closed, false); assert.equal(f.service.progress().drainStatus, 'failed');
  assert.equal((await json(path.join(f.dataRoot, 'owner.json'))).pid, process.pid);
  held.release(); await running; await f.library.close();
});

test('recovery of visible cancelled sources waits each DATA source and reconciles all without retry', async t => {
  const f = await fixture(t, { processingConcurrency: 2, complete: async request => { await held.promise; return response(request); } });
  const held = f.hold(); await f.service.addBatch({ batchId: 'cancel-crash', sources: sources() });
  const running = f.service.run(); await until(() => f.calls.length === 2);
  const snapshot = await f.queue(), journal = await f.journal();
  const cancel = f.service.cancelBatch('cancel-crash'); await until(() => f.calls.every(c => c.signal.aborted));
  held.release(); await Promise.all([running, cancel]);
  await f.reopen({ beforeOpen: async () => {
    await writeFile(path.join(f.serviceRoot, 'queue', 'queue.json'), JSON.stringify(snapshot));
    await writeFile(path.join(f.serviceRoot, 'service.json'), JSON.stringify(journal));
  } });
  assert.equal(f.service.progress().recoveryRequired, 2);
  const p = await f.service.recover(); assert.equal(p.recoveryRequired, 0); assert.equal(p.cancelled, 2);
  assert.equal(p.checked, 0); assert.equal(p.closed, false); assert.equal(f.calls.length, 2);
});

test('failed original DATA operation is read during recovery; analysis failure is never resent', async t => {
  const f = await fixture(t, { complete: () => 'PRIVATE_BAD_ANALYSIS' });
  await f.service.addBatch({ batchId: 'failed-crash', sources: sources() }); await f.service.run();
  const snapshot = await f.queue(), journal = await f.journal(), item = snapshot.batches[0].items[0];
  Object.assign(item, { status: 'running', outcome: null, errorCode: null });
  Object.assign(item.attempts[0], { status: 'running', finishedAt: null, failed: false });
  const op = journal.operations.find(o => o.operationId === item.operationId);
  op.outcome = null; op.evidence = null; op.events = op.events.filter(e => e.kind !== 'outcome');
  await f.reopen({ beforeOpen: async () => {
    await writeFile(path.join(f.serviceRoot, 'queue', 'queue.json'), JSON.stringify(snapshot));
    await writeFile(path.join(f.serviceRoot, 'service.json'), JSON.stringify(journal));
  } });
  const p = await f.service.run(); assert.equal(p.failed, 10); assert.equal(p.failedAttempts, 10); assert.equal(f.calls.length, 10);
  const originals = await readdir(path.join(f.dataRoot, 'drafts'));
  assert.equal(originals.length, 10);
  for (const name of originals) assert.equal((await json(path.join(f.dataRoot, 'drafts', name))).rawResponse, 'PRIVATE_BAD_ANALYSIS');
});

test('DATA rejects a corrupt persisted index on reopen and recovery cannot count it checked', async t => {
  const f = await fixture(t); await f.service.addBatch({ batchId: 'stale-index', sources: sources() }); await f.service.run();
  const snapshot = await f.queue(), item = snapshot.batches[0].items[0];
  Object.assign(item, { status: 'running', outcome: null, errorCode: null });
  Object.assign(item.attempts[0], { status: 'running', finishedAt: null });
  await f.reopen({ beforeOpen: async () => {
    await writeFile(path.join(f.serviceRoot, 'queue', 'queue.json'), JSON.stringify(snapshot));
    await writeFile(path.join(f.dataRoot, 'indexes', item.source.sourceId + '.json'), '{}');
  } });
  assert.equal((await f.library.get(item.source.sourceId)).indexStatus, 'stale');
  await assert.rejects(f.service.run(), { code: 'CHECKED_RESULT_REQUIRED' });
  assert.equal(f.service.progress().checked, 9); assert.equal(f.service.progress().recoveryRequired, 1); assert.equal(f.calls.length, 20);
});

test('legacy canonical text identity and CRLF originals are preserved through a real batch', async t => {
  const f = await fixture(t), input = sources(), originals = [];
  for (const [i, s] of input.entries()) originals.push(await f.library.registerSource({ ...s, requestId: `legacy-${i}`, fileName: `legacy-${i}.txt` }));
  await f.reopen({ beforeOpen: async () => {
    const catalog = await f.catalog();
    for (const [i, row] of catalog.sources.entries()) {
      row.textVersion = `text-${row.sourceSha256}`;
      await writeFile(path.join(f.dataRoot, 'objects', row.sourceSha256 + '.txt'), input[i].bytes);
    }
    await writeFile(path.join(f.dataRoot, 'catalog.json'), JSON.stringify(catalog));
  } });
  await f.service.addBatch({ batchId: 'legacy', sources: input });
  const p = await f.service.run(); assert.equal(p.checked, 10);
  assert.deepEqual(p.batches[0].items.map(i => i.source.sourceId), originals.map(s => s.sourceId));
  for (const [i, item] of p.batches[0].items.entries()) {
    assert.equal(item.source.textVersion, 'text-' + item.source.sourceSha256);
    assert.equal((await f.library.readSource(item.source.sourceId)).text, input[i].bytes.toString());
  }
});

test('concurrent idempotent submission snapshots local bytes before caller mutation', async t => {
  const f = await fixture(t), input = sources(), originalBytes = input.map(s => Buffer.from(s.bytes));
  const first = f.service.addBatch({ batchId: 'snapshot', sources: input });
  const second = f.service.addBatch({ batchId: 'snapshot', sources: input });
  input.forEach(s => s.bytes.fill(0));
  await Promise.all([first, second]);
  assert.equal((await f.catalog()).sources.length, 10); assert.equal(f.calls.length, 0);
  for (const bytes of originalBytes) assert.deepEqual(await readFile(path.join(f.dataRoot, 'objects', hash(bytes) + '.bin')), bytes);
  const running = f.service.run();
  await assert.rejects(f.service.addBatch({ batchId: 'during-run', sources: sources(20) }), { code: 'BATCH_SERVICE_BUSY' });
  assert.equal((await running).checked, 10); assert.equal(f.calls.length, 20);
});

for (const phase of ['process', 'recover']) for (const artifact of ['bytes', 'text', 'index']) test(`real ${artifact} tamper is rejected before ${phase} binding, without repair or new calls`, async t => {
  let f, armed = false, target, changedPath, changed = false;
  f = await fixture(t, { ownsLibrary: false, wrap: lib => ({ ...lib, async waitSource(id, options) {
    const row = await lib.waitSource(id, options);
    if (armed && !changed && id === target && row.status === 'completed') {
      changed = true;
      changedPath = artifact === 'index' ? path.join(f.dataRoot, 'indexes', id + '.json')
        : path.join(f.dataRoot, 'objects', row.sourceSha256 + (artifact === 'bytes' ? '.bin' : '.lf-v2.txt'));
      await writeFile(changedPath, 'SYNTHETIC_FILE_TAMPER');
    }
    return row;
  } }) });
  await f.service.addBatch({ batchId: 'tamper', sources: sources() }); target = f.service.progress().batches[0].items[0].source.sourceId;
  if (phase === 'recover') {
    await f.service.run(); const saved = await f.queue(), item = saved.batches[0].items[0];
    Object.assign(item, { status: 'running', outcome: null, errorCode: null });
    Object.assign(item.attempts[0], { status: 'running', finishedAt: null });
    await f.reopen({ beforeOpen: () => writeFile(path.join(f.serviceRoot, 'queue', 'queue.json'), JSON.stringify(saved)) });
    armed = true;
    await assert.rejects(f.service.recover(), error => ['CHECKED_RESULT_REQUIRED', 'SOURCE_BINDING_CONFLICT'].includes(error.code));
    assert.equal(f.service.progress().checked, 9); assert.equal(f.calls.length, 20);
  } else {
    armed = true; const p = await f.service.run();
    assert.equal(p.batches[0].items[0].status, 'failed'); assert.equal(p.halted, true);
    assert.equal(p.batches[0].items[0].result, null);
  }
  assert.equal(changed, true); assert.equal(await readFile(changedPath, 'utf8'), 'SYNTHETIC_FILE_TAMPER');
  assert.equal((await f.library.get(target)).indexStatus, 'stale');
  const version = f.service.progress().batches[0].items[0].source.textVersion;
  assert.equal(f.calls.filter(c => JSON.parse(c.user).textVersion === version).length, 2);
  assert.equal(f.service.progress().closed, false);
});

test('shared close joins only batch calls; unrelated running and deferred sources remain usable', async t => {
  let f, unrelatedVersion, ownVersions = new Set(), closedLibrary = 0;
  f = await fixture(t, { ownsLibrary: false, processingConcurrency: 2, complete: async request => {
    const version = JSON.parse(request.user).textVersion;
    if (version === unrelatedVersion) await unrelatedHeld.promise;
    if (ownVersions.has(version)) await ownHeld.promise;
    return response(request);
  }, wrap: lib => ({ ...lib, async close() { closedLibrary++; return lib.close(); } }) });
  const unrelatedHeld = f.hold(), ownHeld = f.hold();
  const unrelated = await f.library.registerSource(sources(100)[0]), future = await f.library.registerSource(sources(200)[0]);
  unrelatedVersion = unrelated.textVersion;
  await f.library.startSource(unrelated.sourceId, { expectedTextVersion: unrelated.textVersion, expectedAnalysisVersion: null });
  await until(() => f.calls.length === 1);
  await f.service.addBatch({ batchId: 'shared', sources: sources() });
  ownVersions = new Set(f.service.progress().batches[0].items.map(i => i.source.textVersion));
  const running = f.service.run(); await until(() => f.calls.some(c => ownVersions.has(JSON.parse(c.user).textVersion)));
  let closed = false; const closing = f.service.close().then(() => { closed = true; });
  await until(() => f.calls.some(c => ownVersions.has(JSON.parse(c.user).textVersion) && c.signal.aborted));
  assert.equal(closed, false); assert.equal(f.calls.find(c => JSON.parse(c.user).textVersion === unrelatedVersion).signal.aborted, false);
  ownHeld.release(); await Promise.all([closing, running]);
  assert.equal(f.service.progress().closed, true); assert.equal(f.service.progress().ownsLibrary, false);
  assert.equal(closedLibrary, 0); assert.equal((await f.library.get(unrelated.sourceId)).status, 'running');
  await f.library.startSource(future.sourceId, { expectedTextVersion: future.textVersion, expectedAnalysisVersion: null });
  assert.equal((await f.library.waitSource(future.sourceId, { includeAnalysis: true })).analysis.reviewStatus, 'checked');
  assert.equal((await json(path.join(f.dataRoot, 'owner.json'))).pid, process.pid);
  unrelatedHeld.release(); assert.equal((await f.library.waitSource(unrelated.sourceId)).status, 'completed');
});

test('shared service without queue sources cannot cancel unrelated work or close the library', async t => {
  const cancelled = []; let closedLibrary = 0;
  const f = await fixture(t, { ownsLibrary: false, wrap: lib => ({ ...lib,
    async cancel(id) { cancelled.push(id); return lib.cancel(id); }, async close() { closedLibrary++; return lib.close(); } }) });
  const row = await f.library.registerSource(sources(100)[0]);
  await assert.rejects(f.service.cancelBatch('unknown'), { code: 'UNKNOWN_BATCH' });
  await f.service.close(); assert.deepEqual(cancelled, []); assert.equal(closedLibrary, 0);
  await f.library.startSource(row.sourceId, { expectedTextVersion: row.textVersion, expectedAnalysisVersion: null });
  assert.equal((await f.library.waitSource(row.sourceId)).status, 'completed');
});

test('shared pre-start drift rejects outside analysis without cancelling or dispatching batch work', async t => {
  const cancelled = [];
  const f = await fixture(t, { ownsLibrary: false, wrap: lib => ({ ...lib, async cancel(id) { cancelled.push(id); return lib.cancel(id); } }) });
  await f.service.addBatch({ batchId: 'before-start-drift', sources: sources() });
  const item = f.service.progress().batches[0].items[9];
  await f.library.startSource(item.source.sourceId, { expectedTextVersion: item.source.textVersion, expectedAnalysisVersion: null });
  await f.library.waitSource(item.source.sourceId);
  const calls = f.calls.length;
  await assert.rejects(f.service.run(), { code: 'SOURCE_BINDING_CONFLICT' });
  assert.equal(f.calls.length, calls); assert.equal(calls, 2); assert.equal(f.service.progress().checked, 0);
  await f.service.close(); assert.deepEqual(cancelled, []);
});

for (const point of ['wait-return', 'seal-return', 'after-journal']) test(`shared live revision at ${point} cannot bind captured result or cancel the outside revision`, async t => {
  let f, target, changed = false, oldVersion, newVersion, verifies = 0; const cancelled = [];
  const revise = async lib => {
    if (changed) return;
    changed = true;
    const old = await lib.get(target, { includeAnalysis: true }); oldVersion = old.analysis.version;
    await lib.reviseAnalysis(target, { expectedAnalysisVersion: oldVersion, instructions: '合成测试：按原文修订候选并保留未知信息。' });
    const updated = await lib.waitSource(target, { includeAnalysis: true }); newVersion = updated.analysis.version;
    assert.notEqual(newVersion, oldVersion);
  };
  f = await fixture(t, { ownsLibrary: false, wrap: lib => ({ ...lib,
    async cancel(id) { cancelled.push(id); return lib.cancel(id); },
    async waitSource(id, options) {
      const row = await lib.waitSource(id, options);
      if (id === target && row.status === 'completed' && point === 'wait-return') await revise(lib);
      return row;
    },
    async verifyIndexBinding(id, expected) {
      if (id === target) verifies++;
      if (id === target && point === 'after-journal' && verifies === 2) {
        const op = (await f.journal()).operations.find(op => op.source.sourceId === target);
        assert.ok(op.evidence.indexBinding); await revise(lib);
      }
      const receipt = await lib.verifyIndexBinding(id, expected);
      if (id === target && point === 'seal-return') await revise(lib);
      return receipt;
    },
  }) });
  await f.service.addBatch({ batchId: 'live-drift', sources: sources() }); target = f.service.progress().batches[0].items[0].source.sourceId;
  const p = await f.service.run(); assert.equal(changed, true);
  assert.equal(p.batches[0].items[0].status, 'failed'); assert.equal(p.batches[0].items[0].result, null);
  assert.equal(p.haltCode, 'SOURCE_BINDING_CONFLICT'); assert.equal((await f.library.get(target, { includeAnalysis: true })).analysis.version, newVersion);
  assert.equal(cancelled.includes(target), false); await f.service.close();
  assert.equal((await f.library.get(target)).status, 'completed');
});

test('shared conflict leaves a newer same-source revision running through service close', async t => {
  let f, target, revisionRequest;
  f = await fixture(t, { ownsLibrary: false, processingConcurrency: 2, complete: async request => {
    if (request.stage === 'library-analysis-revision') { revisionRequest = request; await revisionHeld.promise; }
    return response(request);
  }, wrap: lib => ({ ...lib, async waitSource(id, options) {
    const row = await lib.waitSource(id, options);
    if (id === target && row.status === 'completed' && !revisionRequest) {
      await lib.reviseAnalysis(id, { expectedAnalysisVersion: row.analysis.version, instructions: '合成外部修订' });
      await until(() => revisionRequest);
    }
    return row;
  } }) });
  const revisionHeld = f.hold(); await f.service.addBatch({ batchId: 'active-revision', sources: sources() });
  target = f.service.progress().batches[0].items[0].source.sourceId;
  const p = await f.service.run(); assert.equal(p.batches[0].items[0].status, 'failed');
  await f.service.close(); assert.equal(revisionRequest.signal.aborted, false);
  assert.ok((await f.library.get(target)).activeRevisionId);
  revisionHeld.release(); assert.equal((await f.library.waitSource(target)).status, 'completed');
});

test('shared failed wait persists uncertainty, fails the attempt, and never closes global DATA', async t => {
  let f, target, closeCalls = 0, realReturned = false;
  f = await fixture(t, { ownsLibrary: false, complete: async request => { await held.promise; realReturned = true; return response(request); },
    wrap: lib => ({ ...lib,
      async startSource(id, expected) { const row = await lib.startSource(id, expected); if (id === target) await until(() => f.calls.length === 1); return row; },
      async waitSource(id, options) { if (id === target) throw Error('PRIVATE_WAIT_FAILURE'); return lib.waitSource(id, options); },
      async close() { closeCalls++; return lib.close(); },
    }) });
  const held = f.hold(); await f.service.addBatch({ batchId: 'unsettled', sources: sources() });
  target = f.service.progress().batches[0].items[0].source.sourceId;
  const p = await f.service.run(); assert.equal(realReturned, false); assert.equal(closeCalls, 0);
  assert.equal(p.batches[0].items[0].status, 'failed'); assert.equal(p.batches[0].items[0].errorCode, 'PROCESSING_FAILED');
  assert.equal(p.haltCode, 'DATA_WAIT_FAILED'); assert.equal(p.drainStatus, 'failed'); assert.equal(p.closed, false);
  await assert.rejects(f.service.close(), { code: 'DATA_WAIT_FAILED' });
  assert.equal((await json(path.join(f.dataRoot, 'owner.json'))).pid, process.pid);
  assert.equal((await f.journal()).unsettled[0].source.sourceId, target);
  assert.doesNotMatch(JSON.stringify(await f.journal()) + JSON.stringify(p), /PRIVATE_WAIT_FAILURE/);
  const reopened = await createLibraryBatchService({ rootDir: f.serviceRoot, library: f.library, ownsLibrary: false });
  await assert.rejects(reopened.run(), { code: 'DATA_WAIT_FAILED' });
  await assert.rejects(reopened.close(), { code: 'DATA_WAIT_FAILED' });
  assert.equal(realReturned, false); assert.equal(closeCalls, 0);
  held.release(); await f.library.waitSource(target);
});

for (const field of ['analysisSha256', 'sourceTextSha256', 'status']) test(`real index receipt with mismatched ${field} cannot bind a completed queue outcome`, async t => {
  const f = await fixture(t, { ownsLibrary: false, wrap: lib => ({ ...lib, async verifyIndexBinding(id, expected) {
    const verified = await lib.verifyIndexBinding(id, expected);
    return { ...verified, [field]: field === 'status' ? 'failed' : '0'.repeat(64) };
  } }) });
  await f.service.addBatch({ batchId: 'receipt', sources: sources() }); const p = await f.service.run();
  assert.equal(p.checked, 0); assert.equal(p.halted, true);
});

test('shared close of only queued batch sources does not wait for an unrelated occupied slot', async t => {
  let f, outsideVersion;
  f = await fixture(t, { ownsLibrary: false, processingConcurrency: 1, complete: async request => {
    if (JSON.parse(request.user).textVersion === outsideVersion) await outsideHeld.promise;
    return response(request);
  } });
  const outsideHeld = f.hold(), outside = await f.library.registerSource(sources(100)[0]);
  outsideVersion = outside.textVersion;
  await f.library.startSource(outside.sourceId, { expectedTextVersion: outsideVersion, expectedAnalysisVersion: null });
  await until(() => f.calls.length === 1);
  await f.service.addBatch({ batchId: 'waiting-slots', sources: sources() });
  const work = f.service.run();
  await until(async () => (await f.catalog()).sources.filter(s => s.status === 'queued').length === 2);
  let closed = false; const closing = f.service.close().then(() => { closed = true; });
  await until(() => closed);
  assert.equal(f.calls[0].signal.aborted, false); assert.equal(f.calls.length, 1);
  assert.equal((await f.library.get(outside.sourceId)).status, 'running');
  outsideHeld.release(); await Promise.all([closing, work, f.library.waitSource(outside.sourceId)]);
});

test('shared cancellation of an unstarted batch is idempotent and never dispatches a model', async t => {
  const f = await fixture(t, { ownsLibrary: false });
  await f.service.addBatch({ batchId: 'never-start', sources: sources() });
  await f.service.cancelBatch('never-start'); await f.service.cancelBatch('never-start');
  assert.equal(f.service.progress().cancelled, 10); assert.equal(f.calls.length, 0);
  assert.ok((await f.catalog()).sources.every(s => s.status === 'cancelled'));
});
