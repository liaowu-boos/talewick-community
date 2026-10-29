import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IndependentReviewService, independentReviewRequestHash as hash } from './independent-review-service.mjs';
import { productManuscriptRevision } from './full15-service.mjs';

const chapters = [{ id: 'c1', title: '记录', body: '同一句。同一句。' }], stageId = '04-reader-2-second', witnessSHA256 = 'a'.repeat(64);
const input = { projectId: 'synthetic-audit', requestId: 'original', caseId: 'synthetic-case', mode: 'single', title: '记录', chapters,
  manuscriptRevision: productManuscriptRevision('记录', chapters) };
const action = { requestId: `audited-position-${witnessSHA256}`, stageId, mode: 'audited_nondispatch' };
async function settled(service, id) {
  for (let i = 0; i < 400; i++) { const value = service.get(id); if (!['queued', 'running'].includes(value.status) && !service.busy) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Synthetic recovery did not settle');
}
async function fixture(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'talewick-audited-recovery-'));
  const calls = { inspect: 0, audited: 0, position: 0, resume: 0 }; let state, service;
  const adapter = {
    getIndependentReviewVersions: () => ({ protocolVersion: 'synthetic' }),
    startIndependentReview: async args => {
      const runDir = path.join(args.runRoot, 'original', 'run'); await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, 'original-raw.txt'), 'Unchanged failed opinion');
      state = { runDir, requestHash: hash(args.request), status: 'needs_attention', report: null,
        progress: { phase: 'stage_needs_attention', completedStages: 3, totalStages: 7 },
        error: { code: 'QUOTE_POSITION_NOT_UNIQUE', stage: stageId, message: 'Original ambiguous citation', recoverable: false } };
      return structuredClone(state);
    },
    readIndependentReviewProgress: () => structuredClone(state),
    recoverIndependentReviewPositions: () => {
      state.error = { ...state.error, code: 'POSITION_REPAIR_EXHAUSTED', message: 'Preserved blocked position attempt' };
      return structuredClone(state);
    },
    inspectIndependentReviewZeroDispatchRecovery: args => {
      calls.inspect++; assert.equal(service.get(task.id).status, 'needs_attention');
      assert.equal(service.get(task.id).recoveries.length, 1, 'preflight precedes product mutation');
      assert.equal(args.runDir, state.runDir); assert.equal(args.requestHash, state.requestHash);
      return { eligible: true, reviewTaskId: args.audit.reviewTaskId, witnessSHA256: args.audit.witnessSHA256,
        stageId, requestHash: state.requestHash };
    },
    recoverIndependentReviewPositionsAfterAuditedNonDispatch: async args => {
      calls.audited++; assert.equal(args.audit.reviewTaskId, task.id); assert.equal(args.audit.witnessSHA256, witnessSHA256);
      assert.equal(args.runDir, state.runDir); assert.equal(args.requestHash, state.requestHash);
      await args.analyzePositionRepair(); state.status = 'queued'; state.error = null;
      state.progress.completedStages = 4; return structuredClone(state);
    },
    resumeIndependentReview: args => {
      calls.resume++; assert.equal(state.progress.completedStages, 4); assert.equal(args.runDir, state.runDir);
      state.status = 'complete'; state.progress.completedStages = 7; state.report = { automaticAdoption: false, literaryPass: 'NOT_COMPUTED' };
      return structuredClone(state);
    },
  };
  const options = { rootDir, adapter, analyze: async () => assert.fail('ordinary model must not rerun'),
    analyzePositionRepair: async () => { calls.position++; }, prepareRequest: value => ({ request: { caseId: value.caseId, mode: 'single', baselineChapters: value.chapters } }) };
  service = await new IndependentReviewService(options).init();
  t.after(async () => { await service.close(); await rm(rootDir, { recursive: true, force: true }); });
  const task = await service.start(input); await settled(service, task.id);
  await service.recover(task.id, { requestId: 'original-blocked-repair', stageId, mode: 'position_repair' }); await settled(service, task.id);
  const audit = { reviewTaskId: task.id, witnessPath: path.join(rootDir, 'trusted-witness.json'), witnessSHA256 };
  const resolver = binding => {
    assert.deepEqual(binding, { reviewTaskId: task.id, projectId: input.projectId, sourceTaskId: undefined, stageId, runDir: state.runDir, requestHash: state.requestHash });
    return structuredClone(audit);
  };
  return { service, options, adapter, task, audit, resolver, calls, rootDir, get state() { return state; }, setService(value) { service = value; } };
}

test('trusted preflight appends one same-task operation, keeps old failure and private audit, then resumes only unsealed stages', async t => {
  const f = await fixture(t); f.service.zeroDispatchAuditForTask = f.resolver;
  const prior = structuredClone(f.service.get(f.task.id).recoveries[0]);
  const requestFile = path.join(f.rootDir, f.task.id, 'request.json'), frozen = await readFile(requestFile);
  const [first, duplicate] = await Promise.all([f.service.recover(f.task.id, action), f.service.recover(f.task.id, action)]);
  assert.equal(first.id, f.task.id); assert.equal(duplicate.id, f.task.id);
  const done = await settled(f.service, f.task.id); assert.equal(done.status, 'complete');
  assert.deepEqual(f.calls, { inspect: 1, audited: 1, position: 1, resume: 1 });
  assert.deepEqual(done.recoveries[0], prior); assert.equal(done.recoveries.length, 2);
  assert.equal(done.recoveries[1].originalError.code, 'POSITION_REPAIR_EXHAUSTED');
  assert.equal(done.recoveries[1].trustedAudit, undefined); assert.equal(done.recoveries[1].witnessSHA256, witnessSHA256);
  assert.ok(!JSON.stringify(done).includes(f.audit.witnessPath));
  assert.deepEqual(f.service.tasks.get(done.id).recoveries[1].trustedAudit, f.audit);
  assert.deepEqual(await readFile(requestFile), frozen); assert.equal(await readFile(path.join(f.state.runDir, 'original-raw.txt'), 'utf8'), 'Unchanged failed opinion');
  await f.service.recover(done.id, action); assert.equal(f.calls.audited, 1);
});

test('browser audit fields, missing resolver, wrong task/hash/stage or failed witness cannot mutate product state', async t => {
  const f = await fixture(t), file = path.join(f.rootDir, f.task.id, 'task.json'), before = await readFile(file);
  await assert.rejects(f.service.recover(f.task.id, action), { code: 'RECOVERY_UNAVAILABLE' });
  for (const extra of [{ audit: f.audit }, { witnessPath: f.audit.witnessPath }, { definitelyNotDispatched: true }]) {
    await assert.rejects(f.service.recover(f.task.id, { ...action, ...extra }), { code: 'RECOVERY_INPUT_INVALID' });
  }
  f.service.zeroDispatchAuditForTask = () => ({ ...f.audit, reviewTaskId: 'other-task' });
  await assert.rejects(f.service.recover(f.task.id, action), { code: 'RECOVERY_TRUSTED_AUDIT_REQUIRED' });
  f.service.zeroDispatchAuditForTask = f.resolver;
  await assert.rejects(f.service.recover(f.task.id, { ...action, requestId: 'unbound' }), { code: 'RECOVERY_AUDIT_REQUEST_ID' });
  const inspect = f.adapter.inspectIndependentReviewZeroDispatchRecovery;
  for (const mismatch of [{ stageId: '07-goal-audit' }, { requestHash: 'b'.repeat(64) }, { witnessSHA256: 'b'.repeat(64) }, { eligible: false }]) {
    f.adapter.inspectIndependentReviewZeroDispatchRecovery = args => ({ ...inspect(args), ...mismatch });
    await assert.rejects(f.service.recover(f.task.id, action), { code: 'RECOVERY_AUDIT_BINDING_INVALID' });
  }
  f.adapter.inspectIndependentReviewZeroDispatchRecovery = () => { throw Object.assign(Error('Invalid witness'), { code: 'ZERO_DISPATCH_WITNESS_HASH' }); };
  await assert.rejects(f.service.recover(f.task.id, action), { code: 'ZERO_DISPATCH_WITNESS_HASH' });
  assert.deepEqual(await readFile(file), before); assert.equal(f.calls.audited, 0); assert.equal(f.calls.resume, 0);
});

test('audited operation never bypasses semantic judgment or retries a failed/unknown audited slot', async t => {
  const f = await fixture(t); f.service.zeroDispatchAuditForTask = f.resolver;
  f.state.error.code = 'IMPLEMENTED_WITHOUT_CHANGE_EVIDENCE';
  await assert.rejects(f.service.recover(f.task.id, action), { code: 'RECOVERY_NOT_POSITION_FAILURE' });
  assert.equal(f.calls.inspect, 0);
  f.state.error.code = 'POSITION_REPAIR_EXHAUSTED';
  f.adapter.recoverIndependentReviewPositionsAfterAuditedNonDispatch = () => { f.calls.audited++; throw Object.assign(Error('Unknown result'), { code: 'POSITION_REPAIR_EXHAUSTED' }); };
  await f.service.recover(f.task.id, action); const failed = await settled(f.service, f.task.id);
  assert.equal(failed.status, 'needs_attention'); assert.equal(failed.recoveries.length, 2); assert.equal(f.calls.resume, 0);
  await f.service.recover(f.task.id, action); assert.equal(f.calls.audited, 1);
  await assert.rejects(f.service.recover(f.task.id, { ...action, requestId: 'different-request' }), { code: 'RECOVERY_LIMIT_REACHED' });
  await assert.rejects(f.service.retry(f.task.id), { code: 'REVIEW_RERUN_FORBIDDEN' });
});

test('crash after audited operation reservation preserves history and never re-dispatches on startup', async t => {
  const f = await fixture(t); await f.service.close(); const task = f.service.tasks.get(f.task.id);
  task.status = 'running'; task.pendingRecovery = action.requestId;
  task.recoveries.push({ ...action, inputHash: hash(action), trustedAudit: f.audit, witnessSHA256, status: 'running', originalError: task.error });
  await f.service.saveTask(task);
  const reopened = await new IndependentReviewService({ ...f.options, zeroDispatchAuditForTask: f.resolver }).init(); f.setService(reopened);
  assert.equal(reopened.get(task.id).status, 'needs_attention'); assert.equal(reopened.get(task.id).error.code, 'RECOVERY_OUTCOME_UNKNOWN');
  assert.equal(reopened.get(task.id).recoveries[1].status, 'interrupted');
  await reopened.recover(task.id, action); assert.equal(f.calls.audited, 0); assert.equal(f.calls.resume, 0);
});
