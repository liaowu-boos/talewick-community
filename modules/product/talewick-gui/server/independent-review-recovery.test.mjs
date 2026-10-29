import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IndependentReviewService, independentReviewRequestHash as hash } from './independent-review-service.mjs';
import { productManuscriptRevision } from './full15-service.mjs';

const chapters = [{ id: 'c1', title: '一', body: '同一句。同一句。' }], stageId = '04-reader-2-second';
const input = { projectId: 'recovery-project', requestId: 'original', mode: 'single', title: '原稿', chapters,
  manuscriptRevision: productManuscriptRevision('原稿', chapters), caseId: 'recovery-case' };
const action = (mode = 'whitespace_only', requestId = mode) => ({ requestId, stageId, mode });
async function settled(service, id) {
  for (let i = 0; i < 400; i++) { const task = service.get(id); if (!['queued', 'running'].includes(task.status) && !service.busy) return task; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Recovery queue did not settle');
}
async function fixture(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'talewick-position-recovery-')), counters = { starts: 0, recovery: 0, resume: 0, position: 0 };
  let state, service;
  const adapter = {
    getIndependentReviewVersions: async () => ({ protocolVersion: 'fixture', rulesVersion: 'fixture', toolVersion: 'fixture' }),
    startIndependentReview: async args => {
      counters.starts++;
      const runDir = path.join(args.runRoot, 'original', 'run'); await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, 'sealed-earlier.json'), '{"original":"sealed"}\n');
      await writeFile(path.join(runDir, 'raw-response.txt'), 'Original failed response\n');
      state = { status: 'needs_attention', runDir, requestHash: hash(args.request), progress: { phase: 'stage_needs_attention', completedStages: 3, totalStages: 7 }, report: null,
        error: { code: 'QUOTE_POSITION_NOT_UNIQUE', message: 'Repeated quote', stage: stageId, recoverable: false } };
      return structuredClone(state);
    },
    readIndependentReviewProgress: async () => structuredClone(state),
    recoverIndependentReviewPositions: async args => {
      counters.recovery++;
      assert.equal(args.runDir, state.runDir); assert.equal(args.requestHash, state.requestHash);
      if (args.mode === 'position_repair') { await args.analyzePositionRepair(); state = { ...state, status: 'queued', error: null }; }
      return structuredClone(state);
    },
    resumeIndependentReview: async args => {
      counters.resume++; assert.equal(args.runDir, state.runDir);
      state = { ...state, status: 'complete', error: null, progress: { phase: 'complete', completedStages: 7, totalStages: 7 }, report: { automaticAdoption: false, literaryPass: 'NOT_COMPUTED' } };
      return structuredClone(state);
    },
  };
  const options = { rootDir, adapter, analyze: async () => assert.fail('ordinary analysis is validation-owned'),
    prepareRequest: value => ({ request: { caseId: value.caseId, mode: value.mode, baselineChapters: value.chapters } }) };
  service = await new IndependentReviewService(options).init();
  t.after(async () => { await service.close(); await rm(rootDir, { recursive: true, force: true }); });
  const task = await service.start(input); await settled(service, task.id);
  return { service, options, task, counters, rootDir, adapter, get state() { return state; }, set state(value) { state = value; },
    setService(value) { service = value; } };
}

test('same-task recovery is serialized/idempotent, preserves raw and seals, then resumes only after acceptance', async t => {
  const f = await fixture(t), original = f.service.tasks.get(f.task.id), frozen = await readFile(path.join(f.rootDir, f.task.id, 'request.json'));
  f.service.analyzePositionRepair = async () => { f.counters.position++; };
  const raw = await readFile(path.join(f.state.runDir, 'raw-response.txt')), seal = await readFile(path.join(f.state.runDir, 'sealed-earlier.json'));
  const [first, duplicate] = await Promise.all([f.service.recover(f.task.id, action('position_repair')), f.service.recover(f.task.id, action('position_repair'))]);
  assert.equal(first.id, f.task.id); assert.equal(duplicate.id, f.task.id);
  const done = await settled(f.service, f.task.id); assert.equal(done.status, 'complete');
  assert.deepEqual(f.counters, { starts: 1, recovery: 1, resume: 1, position: 1 });
  assert.equal(f.service.list().length, 1); assert.equal(f.service.tasks.get(done.id).requestHash, original.requestHash);
  assert.deepEqual(await readFile(path.join(f.rootDir, done.id, 'request.json')), frozen);
  assert.deepEqual(await readFile(path.join(f.state.runDir, 'raw-response.txt')), raw);
  assert.deepEqual(await readFile(path.join(f.state.runDir, 'sealed-earlier.json')), seal);
  assert.equal(done.recoveries[0].originalError.code, 'QUOTE_POSITION_NOT_UNIQUE');
  assert.equal((await f.service.recover(done.id, action('position_repair'))).id, done.id);
  assert.equal(f.counters.recovery, 1);
  await assert.rejects(f.service.recover(done.id, action('whitespace_only', 'position_repair')), { code: 'RECOVERY_REQUEST_CONFLICT' });
  await assert.rejects(f.service.retry(done.id), { code: 'REVIEW_RERUN_FORBIDDEN' });
});

test('local failed recovery is bounded; semantic failures never call resume or rerun the goal', async t => {
  const f = await fixture(t);
  f.adapter.recoverIndependentReviewPositions = async () => {
    f.counters.recovery++; f.state = { ...f.state, error: { code: 'IMPLEMENTED_WITHOUT_CHANGE_EVIDENCE', stage: stageId, message: 'Unchanged passage is not implemented', recoverable: false } };
    return structuredClone(f.state);
  };
  await f.service.recover(f.task.id, action()); const done = await settled(f.service, f.task.id);
  assert.equal(done.status, 'needs_attention'); assert.equal(done.error.code, 'IMPLEMENTED_WITHOUT_CHANGE_EVIDENCE');
  assert.equal(done.report, null); assert.equal(done.recoveries[0].originalError.code, 'QUOTE_POSITION_NOT_UNIQUE');
  assert.equal(f.counters.resume, 0); assert.equal(f.counters.position, 0);
  await f.service.recover(done.id, action()); assert.equal(f.counters.recovery, 1);
  f.service.analyzePositionRepair = async () => assert.fail('semantic rejection must not call repair');
  await assert.rejects(f.service.recover(done.id, action('position_repair')), { code: 'RECOVERY_NOT_POSITION_FAILURE' });
  await assert.rejects(f.service.retry(done.id), { code: 'REVIEW_RERUN_FORBIDDEN' });
});

test('absent callback, injected repairs, wrong stage, changed input and repeated attempts fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.recover(f.task.id, action('position_repair')), { code: 'RECOVERY_UNAVAILABLE' });
  await assert.rejects(f.service.recover(f.task.id, { ...action(), repairs: [] }), { code: 'RECOVERY_INPUT_INVALID' });
  await assert.rejects(f.service.recover(f.task.id, { ...action(), stageId: '07-goal-audit' }), { code: 'RECOVERY_STAGE_MISMATCH' });
  await f.service.recover(f.task.id, action()); await settled(f.service, f.task.id);
  await assert.rejects(f.service.recover(f.task.id, action('whitespace_only', 'different-key')), { code: 'RECOVERY_LIMIT_REACHED' });
  const requestFile = path.join(f.rootDir, f.task.id, 'request.json'), saved = JSON.parse(await readFile(requestFile));
  saved.request.baselineChapters[0].body += '篡改'; await writeFile(requestFile, JSON.stringify(saved));
  await assert.rejects(f.service.recover(f.task.id, action())); assert.equal(f.counters.recovery, 1);
});

test('uncertain in-progress recovery is not automatically resent after process restart', async t => {
  const f = await fixture(t); await f.service.close();
  const task = f.service.tasks.get(f.task.id), request = action('position_repair');
  task.status = 'running'; task.pendingRecovery = request.requestId;
  task.recoveries = [{ ...request, inputHash: hash(request), requestHash: task.requestHash, runDir: task.runDir, status: 'running', originalError: task.error }];
  await f.service.saveTask(task);
  const next = await new IndependentReviewService({ ...f.options, analyzePositionRepair: async () => assert.fail('no resend') }).init(); f.setService(next);
  assert.equal(next.get(task.id).status, 'needs_attention'); assert.equal(next.get(task.id).error.code, 'RECOVERY_OUTCOME_UNKNOWN');
  assert.equal(next.get(task.id).recoveries[0].status, 'interrupted');
  await next.recover(task.id, request); assert.equal(f.counters.recovery, 0);
});

test('partial report is separate and strictly derived, never a canonical complete report or a count-only projection', async t => {
  const f = await fixture(t), task = f.service.tasks.get(f.task.id); task.mode = 'compare'; await f.service.saveTask(task);
  const body = { schemaVersion: 'independent-review-partial-blind-report-1', runDir: task.runDir, requestHash: task.requestHash, caseId: task.caseId,
    taskStatus: 'needs_attention', completeBlindReview: true, completedBlindStages: 6, goalAuditStatus: 'needs_attention', automaticAdoption: false, literaryPass: 'NOT_COMPUTED',
    isolatedReadings: [{ record: { entries: [{ overallImpression: 'Negative judgment stays' }] } }], readerBindings: [], privateBinding: { secret: true } };
  f.adapter.buildIndependentReviewPartialReport = async () => ({ ...body, reportSha256: hash(body) });
  const before = await readFile(path.join(f.rootDir, task.id, 'task.json'));
  const visible = await f.service.read(task.id); assert.equal(visible.status, 'needs_attention'); assert.equal(visible.report, null);
  assert.equal(visible.partialReport.completeBlindReview, true); assert.equal(visible.runDir, undefined);
  assert.deepEqual(visible.partialReport, { ...body, reportSha256: hash(body) }, 'partial checksum projection is returned byte-for-field unchanged');
  assert.equal(visible.error.code, 'QUOTE_POSITION_NOT_UNIQUE');
  assert.deepEqual(await readFile(path.join(f.rootDir, task.id, 'task.json')), before, 'GET does not persist projections over the task');
  f.adapter.buildIndependentReviewPartialReport = async () => { throw Object.assign(Error('invalid seal'), { code: 'PERSISTED_STAGE_SEAL_INVALID' }); };
  const rejected = await f.service.read(task.id); assert.equal(rejected.partialReport, undefined); assert.equal(rejected.partialReportUnavailable.code, 'PERSISTED_STAGE_SEAL_INVALID');
  assert.equal(f.counters.recovery, 0); assert.equal(f.counters.resume, 0);
});
