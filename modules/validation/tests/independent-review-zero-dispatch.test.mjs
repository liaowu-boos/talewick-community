import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  startIndependentReview, recoverIndependentReviewPositions, readIndependentReviewProgress, resumeIndependentReview,
  inspectIndependentReviewZeroDispatchRecovery, recoverIndependentReviewPositionsAfterAuditedNonDispatch,
} from '../runtime/independent-review-task.mjs';
import { withLiteraryReadingFocus } from '../runtime/focused-whole-quality-evaluation.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const read = async p => JSON.parse(await readFile(p, 'utf8'));
const write = (p, v) => writeFile(p, JSON.stringify(v, null, 2) + '\n');
const witnessName = 'witness.json';
const stageId = '01-reader-1-single';
const body = '她站着。窗开了。她站着。门关了。';
async function snapshot(root) {
  const out = {};
  async function walk(path) { for (const e of await readdir(path, { withFileTypes: true })) { const p = join(path, e.name); if (e.isDirectory()) await walk(p); else out[p] = sha(await readFile(p)); } }
  await walk(root); return out;
}
async function scoped(fn, focused = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zero-dispatch-test-')));
  try { return await fn(await setup(root, focused)); } finally { await rm(root, { recursive: true, force: true }); }
}
async function setup(root, focused) {
  let request = { caseId: 'audited-local-fixture', mode: 'single', baselineChapters: [{ id: 'ch', title: '窗边', body }] };
  if (focused) request = withLiteraryReadingFocus(request);
  const initial = await startIndependentReview({ runRoot: root, request, analyze: async input => {
    const record = structuredClone(input.packet.responseContract.example);
    const evidence = focused ? record.entries[0].focusAssessments[0].evidence : record.entries[0].claims[0].evidence;
    evidence[0] = { blindId: 'M', chapterId: 'ch', quote: '她站着。', start: null };
    return { outputText: JSON.stringify(record), receipt: { provider: 'fixture', invocationId: 'initial', contextId: 'initial', inputHash: input.inputHash } };
  } });
  assert.equal(initial.error.code, 'QUOTE_POSITION_NOT_UNIQUE');
  const stopped = await recoverIndependentReviewPositions({ runDir: initial.runDir, requestHash: initial.requestHash, mode: 'position_repair', analyzePositionRepair: async () => {
    // Reproduce createModel swallowing the underlying pre-dispatch balance error.
    throw new Error('无法连接模型服务，请检查模型地址和网络后重试。');
  } });
  assert.equal(stopped.error.code, 'POSITION_REPAIR_EXHAUSTED');
  const taskParent = dirname(stopped.runDir), eventsPath = join(taskParent, 'events.ndjson');
  const events = (await readFile(eventsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const start = events.find(e => e.type === 'position_repair_started'), failed = events.find(e => e.type === 'position_repair_failed');
  const at = new Date(Date.parse(failed.at) + 1000).toISOString();
  const segment = join(root, 'audited-provider-segment'), provider = join(segment, 'provider'); await mkdir(join(provider, 'wire'), { recursive: true });
  const account = { caseId: 'provider-fixture', openingCount: 1819, closingCount: 1819, attemptedPosts: 0, blocked: true, durabilityFailure: false, providerInFlight: false, receipts: [], modelPolicy: { version: 'fixture' }, completedAt: at };
  const balance = { checkedAt: start.at, httpStatus: 200, available: false, balances: [{ currency: 'CNY', total: '-0.28' }], observedCumulativeGenerationPosts: 1819, generationPostsThisCheck: 0 };
  const terminal = { id: 'review-fixture', caseId: request.caseId, mode: request.mode, status: 'needs_attention', report: null, error: stopped.error, progress: stopped.progress,
    recoveries: [{ stageId, mode: 'position_repair', status: 'needs_attention', originalError: initial.error, resultError: stopped.error }] };
  await write(join(segment, 'accounting.json'), account); await write(join(provider, 'accounting.json'), account);
  await write(join(provider, 'balance.json'), balance);
  await write(join(provider, 'session.json'), { caseId: account.caseId, openingCount: 1819, modelPolicy: account.modelPolicy, startedAt: start.at });
  await write(join(provider, 'opening-state.json'), { currentAuthorization: { sameExperimentUsed: 1819, providerInFlight: false } });
  await writeFile(join(provider, 'provider-ledger.ndjson'), ''); await write(join(segment, 'task-final.json'), terminal);
  const files = await Promise.all([join(segment, 'accounting.json'), ...['accounting.json', 'balance.json', 'session.json', 'opening-state.json', 'provider-ledger.ndjson'].map(n => join(provider, n)), join(segment, 'task-final.json')].map(async path => { const b = await readFile(path); return { path, bytes: b.length, sha256: sha(b) }; }));
  const witness = { schemaVersion: 'analysis99-provider-not-sent-witness-1', at, reviewTaskId: terminal.id, stageId, originalAttemptId: start.originalAttemptId,
    localRepairAttemptId: start.attemptId, openingCount: 1819, closingCount: 1819, attemptedPosts: 0, providerInFlight: false, wireDirectory: join(provider, 'wire'), wireFiles: 0,
    balance, files, doesNotResetCounter: true, doesNotAuthorizeUnknownOutcomeRetry: true };
  const witnessPath = join(root, witnessName); await write(witnessPath, witness);
  const audit = { reviewTaskId: terminal.id, witnessPath, witnessSHA256: sha(await readFile(witnessPath)) };
  const origin = join(stopped.runDir, 'stages', stageId, 'attempts', start.originalAttemptId);
  return { root, runDir: stopped.runDir, requestHash: stopped.requestHash, audit, witness, origin, segment, provider, eventsPath, focused };
}
async function repin(f) { await write(f.audit.witnessPath, f.witness); f.audit.witnessSHA256 = sha(await readFile(f.audit.witnessPath)); }
async function repinFile(f, path) { const b = await readFile(path), row = f.witness.files.find(f => f.path === path); row.bytes = b.length; row.sha256 = sha(b); await repin(f); }
function correction(input) {
  const problem = input.packet.invalidCitations[0];
  assert.deepEqual(problem.exactCandidates.map(c => c.start), [0, 8]);
  return { outputText: JSON.stringify({ repairs: [{ JSONPointer: problem.JSONPointer, quote: problem.quote, start: 8 }] }),
    receipt: { provider: 'fixture', invocationId: 'repair-real-slot', contextId: 'repair-real-slot', inputHash: input.inputHash } };
}

for (const focused of [false, true]) test(`audited 0POST continuation preserves raw/events/counter, strictly replays and never repeats a seal (${focused ? 'v3' : 'v2'})`, async () => scoped(async f => {
  const before = await snapshot(f.root), prefix = await readFile(f.eventsPath, 'utf8');
  const eligibility = await inspectIndependentReviewZeroDispatchRecovery(f);
  assert.equal(eligibility.eligible, true); assert.equal(eligibility.blockedRepairAttemptId, f.witness.localRepairAttemptId);
  assert.deepEqual(await snapshot(f.root), before, 'inspection is read-only');
  let count = 0;
  const result = await recoverIndependentReviewPositionsAfterAuditedNonDispatch({ ...f, analyzePositionRepair: async input => { count++; return correction(input); } });
  assert.equal(result.status, 'queued', JSON.stringify(result.error)); assert.equal(count, 1);
  const after = await snapshot(f.root);
  for (const [path, digest] of Object.entries(before)) if (path !== f.eventsPath) assert.equal(after[path], digest, `original bytes changed: ${path}`);
  assert.ok((await readFile(f.eventsPath, 'utf8')).startsWith(prefix));
  const proof = await read(join(f.origin, 'position-recovery.json'));
  assert.equal(proof.repair.auditedNonDispatch.witnessSHA256, f.audit.witnessSHA256);
  assert.equal(proof.repair.auditedNonDispatch.blockedRepairAttemptId, f.witness.localRepairAttemptId);
  const progress = await readIndependentReviewProgress(f); assert.equal(progress.status, 'queued'); assert.equal(progress.progress.completedStages, 1);
  let forbidden = 0;
  await assert.rejects(recoverIndependentReviewPositionsAfterAuditedNonDispatch({ ...f, analyzePositionRepair: () => { forbidden++; } }), { code: 'POSITION_RECOVERY_NOT_ELIGIBLE' });
  assert.equal(forbidden, 0);
  // Archive must remain replayable even after a temporary provider segment is no longer accessible.
  await rm(f.segment, { recursive: true, force: true });
  assert.equal((await readIndependentReviewProgress(f)).status, 'queued');
  let stages = 0;
  const complete = await resumeIndependentReview({ ...f, analyze: async input => {
    stages++; assert.equal(input.packet.taskStageId, '02-reader-2-single');
    return { outputText: JSON.stringify(input.packet.responseContract.example), receipt: { provider: 'fixture', invocationId: 'last', contextId: 'last', inputHash: input.inputHash } };
  } });
  assert.equal(complete.status, 'complete', JSON.stringify(complete.error)); assert.equal(stages, 1);
}, focused));

test('no witness never changes an unknown failure; claimed 0POST alone is insufficient', async () => scoped(async f => {
  const before = await snapshot(f.root); let calls = 0;
  await assert.rejects(recoverIndependentReviewPositions({ ...f, mode: 'position_repair', analyzePositionRepair: () => { calls++; } }), { code: 'POSITION_RECOVERY_NOT_ELIGIBLE' });
  await assert.rejects(inspectIndependentReviewZeroDispatchRecovery({ ...f, audit: { definitelyNotDispatched: true } }));
  assert.equal(calls, 0); assert.deepEqual(await snapshot(f.root), before);
}));

const negativeCases = [
  ['wrong witness hash', async f => { f.audit.witnessSHA256 = '0'.repeat(64); }, 'ZERO_DISPATCH_WITNESS_HASH'],
  ['wrong trusted task', async f => { f.audit.reviewTaskId = 'other'; }, 'ZERO_DISPATCH_WITNESS_IDENTITY'],
  ['wrong original attempt', async f => { f.witness.originalAttemptId = 'other'; await repin(f); }, 'ZERO_DISPATCH_WITNESS_IDENTITY'],
  ['wrong repair attempt', async f => { f.witness.localRepairAttemptId = 'other'; await repin(f); }, 'ZERO_DISPATCH_REPAIR_INPUT'],
  ['missing evidence', async f => { f.witness.files.pop(); await repin(f); }, 'ZERO_DISPATCH_EVIDENCE_COVERAGE'],
  ['changed file', async f => { await writeFile(join(f.provider, 'provider-ledger.ndjson'), 'sent'); }, 'ZERO_DISPATCH_EVIDENCE_HASH'],
  ['rehash nonempty ledger', async f => { const path = join(f.provider, 'provider-ledger.ndjson'); await writeFile(path, '{"sent":true}\n'); await repinFile(f, path); }, 'ZERO_DISPATCH_LEDGER_NOT_EMPTY'],
  ['wire is nonempty', async f => { await writeFile(join(f.provider, 'wire', '001-request.json'), '{}'); }, 'ZERO_DISPATCH_WIRE_NOT_EMPTY'],
  ['accounting proves sent', async f => {
    for (const path of [join(f.provider, 'accounting.json'), join(f.segment, 'accounting.json')]) { const a = await read(path); a.attemptedPosts = 1; a.closingCount = 1820; await write(path, a); await repinFile(f, path); }
  }, 'ZERO_DISPATCH_ACCOUNTING_NOT_EMPTY'],
  ['inflight true', async f => { const path = join(f.provider, 'opening-state.json'); const a = await read(path); a.currentAuthorization.providerInFlight = true; await write(path, a); await repinFile(f, path); }, 'ZERO_DISPATCH_OPENING_STATE'],
  ['receipt/response exists', async f => { await writeFile(join(f.origin, 'position-repair', 'raw-response.txt'), '{}'); }, 'ZERO_DISPATCH_REPAIR_HAS_RESPONSE_OR_EXTRA_FILES'],
  ['old repair input changed', async f => { await writeFile(join(f.origin, 'position-repair', 'instruction.txt'), 'changed'); }, 'ZERO_DISPATCH_REPAIR_INPUT'],
];
for (const [name, mutate, code] of negativeCases) test(`zero-dispatch rejects ${name} before dispatch or mutation`, async () => scoped(async f => {
  await mutate(f); const before = await snapshot(f.root); let calls = 0;
  await assert.rejects(recoverIndependentReviewPositionsAfterAuditedNonDispatch({ ...f, analyzePositionRepair: () => { calls++; } }), { code });
  assert.equal(calls, 0); assert.deepEqual(await snapshot(f.root), before);
}));

test('unknown audited continuation outcome consumes its sole reservation; same valid witness cannot retry', async () => scoped(async f => {
  let calls = 0;
  const result = await recoverIndependentReviewPositionsAfterAuditedNonDispatch({ ...f, analyzePositionRepair: async () => { calls++; throw Error('unknown delivery outcome'); } });
  assert.equal(result.status, 'needs_attention'); assert.equal(result.error.code, 'POSITION_REPAIR_EXHAUSTED');
  const before = await snapshot(f.root);
  await assert.rejects(recoverIndependentReviewPositionsAfterAuditedNonDispatch({ ...f, analyzePositionRepair: () => { calls++; } }), { code: 'ZERO_DISPATCH_CONTINUATION_ALREADY_RESERVED' });
  assert.equal(calls, 1); assert.deepEqual(await snapshot(f.root), before);
}));

test('audited authorization still rejects an inexact position and cannot be reused', async () => scoped(async f => {
  let calls = 0;
  const result = await recoverIndependentReviewPositionsAfterAuditedNonDispatch({ ...f, analyzePositionRepair: async input => {
    calls++; const r = correction(input); const value = JSON.parse(r.outputText); value.repairs[0].start = 9; r.outputText = JSON.stringify(value); return r;
  } });
  assert.equal(result.status, 'needs_attention'); assert.equal(result.progress.completedStages, 0);
  await assert.rejects(recoverIndependentReviewPositionsAfterAuditedNonDispatch({ ...f, analyzePositionRepair: () => { calls++; } }));
  assert.equal(calls, 1);
}));

test('tampered archived evidence invalidates recovered seal, while original failed raw survives', async () => scoped(async f => {
  const original = await readFile(join(f.origin, 'raw-response.txt'));
  assert.equal((await recoverIndependentReviewPositionsAfterAuditedNonDispatch({ ...f, analyzePositionRepair: correction })).status, 'queued');
  const path = join(f.origin, 'position-repair-after-audited-nondispatch', 'authorization.json'), saved = await read(path);
  saved.snapshots[0].base64 = Buffer.from('{}').toString('base64'); await write(path, saved);
  assert.equal((await readIndependentReviewProgress(f)).status, 'needs_attention');
  assert.deepEqual(await readFile(join(f.origin, 'raw-response.txt')), original);
}));
