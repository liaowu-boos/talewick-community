import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IndependentReviewService, INDEPENDENT_REVIEW_LOCAL_FILE_WAIT, independentReviewRequestHash } from './independent-review-service.mjs';
import { productManuscriptRevision } from './full15-service.mjs';

const chapters = [{ id: 'c1', title: '第一章', body: '她把钥匙放回桌上。' }];
const input = extra => ({ projectId: 'project-1', requestId: 'review-request-1', caseId: 'case-1', title: '钥匙', chapters,
  manuscriptRevision: productManuscriptRevision('钥匙', chapters), mode: 'single', ...extra });
const prepared = value => value.mode === 'single'
  ? { request: { caseId: value.caseId, mode: 'single', baselineChapters: value.chapters }, provenance: { role: 'source' } }
  : { request: { caseId: value.caseId, mode: 'compare', baselineChapters: value.chapters,
      candidate: { mode: 'revised', chapters: [{ ...chapters[0], body: '她把钥匙交回失主。' }] },
      goals: [{ id: 'g1', statement: '归还钥匙', claimType: 'editorial_hypothesis', sourceEvidence: [{ chapterId: 'c1', quote: '钥匙', start: 2 }], counterCase: [{ chapterId: 'c1', quote: '桌上', start: 7 }], expectedEffect: '行动更明确', failureCriterion: '仍未归还', requiredOutcomes: [{ id: 'o1', dimension: 'action', description: '归还' }] }] }, provenance: { role: 'full_candidate', sourceTaskId: value.sourceTaskId } };

const result = (args, request) => ({ schemaVersion: 'independent-review-task-1', status: 'complete', runDir: path.join(args.runRoot, 'independent-review-test'),
  requestHash: independentReviewRequestHash(request), versions: { protocolVersion: 'whole-quality-evaluation-1', rulesVersion: 'rules-1', toolVersion: 'tool-1' },
  progress: { phase: 'complete', completedStages: request.mode === 'single' ? 2 : 7, totalStages: request.mode === 'single' ? 2 : 7 },
  report: { schemaVersion: 'independent-review-report-1', mode: request.mode, automaticAdoption: false, literaryPass: 'NOT_COMPUTED', records: [], path: '/private/report.json', receipt: { provider: 'synthetic', invocationId: 'secret-invocation', contextId: 'secret-context' } }, error: null });

async function settled(service, id) {
  for (let i = 0; i < 400; i++) { const task = service.get(id); if (!['queued', 'running'].includes(task.status) && !service.busy) return task; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('timeout');
}

async function fixture(t, start) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-independent-review-'));
  const starts = [], resumes = [];
  const adapter = { getIndependentReviewVersions: async () => ({ protocolVersion: 'whole-quality-evaluation-1', rulesVersion: 'rules-1', toolVersion: 'tool-1' }),
    startIndependentReview: async args => { starts.push(args); await args.onProgress({ phase: 'created', completedStages: 0, totalStages: args.request.mode === 'single' ? 2 : 7, runDir: path.join(args.runRoot, 'independent-review-test') }); return start ? start(args) : result(args, args.request); },
    resumeIndependentReview: async args => { resumes.push(args); const request = service.tasks.get([...service.tasks.keys()][0]).frozen.request; return { ...result({ runRoot: path.dirname(args.runDir) }, request), runDir: args.runDir }; } };
  const service = await new IndependentReviewService({ rootDir, adapter, analyze: async () => assert.fail('fixture adapter owns analysis'), prepareRequest: prepared }).init();
  t.after(async () => { await service.close(); await rm(rootDir, { recursive: true, force: true }); });
  return { service, starts, resumes, rootDir };
}

test('single review freezes a server-owned request and hides paths and provenance', async t => {
  const f = await fixture(t); const task = await f.service.start(input()); const done = await settled(f.service, task.id);
  assert.equal(done.status, 'complete'); assert.equal(done.mode, 'single'); assert.equal(f.starts.length, 1);
  assert.deepEqual(f.starts[0].request.baselineChapters, chapters);
  assert.equal(f.starts[0].runRoot, path.join(await realpath(f.rootDir), 'runs'));
  for (const key of ['runDir', 'requestHash', 'frozen', 'result']) assert.equal(Object.hasOwn(done, key), false);
  assert.equal(done.report.automaticAdoption, false); assert.equal(done.report.literaryPass, 'NOT_COMPUTED');
  assert.equal(Object.hasOwn(done.report, 'path'), false); assert.equal(Object.hasOwn(done.report, 'receipt'), false);
});

test('compare input comes from the trusted resolver and requires a linked source task', async t => {
  const seen = []; const f = await fixture(t); f.service.prepareRequest = value => { seen.push(value); return prepared(value); };
  await assert.rejects(f.service.start(input({ requestId: 'compare-missing', mode: 'compare' })), error => error.code === 'SOURCE_TASK_REQUIRED');
  const task = await f.service.start(input({ requestId: 'compare-1', mode: 'compare', sourceTaskId: 'source-task-1', candidate: { forged: true }, goals: [{ forged: true }] }));
  const done = await settled(f.service, task.id);
  assert.equal(done.status, 'complete'); assert.equal(done.mode, 'compare'); assert.equal(seen[0].candidate, undefined); assert.equal(seen[0].goals, undefined);
  assert.equal(f.starts[0].request.candidate.chapters[0].body, '她把钥匙交回失主。');
});

test('request id is idempotent for the same frozen input and conflicts after text changes', async t => {
  const f = await fixture(t); const first = await f.service.start(input()); const duplicate = await f.service.start(input()); assert.equal(duplicate.id, first.id);
  const changed = [{ ...chapters[0], body: '她把钥匙留在门边。' }];
  await assert.rejects(f.service.start(input({ chapters: changed, manuscriptRevision: productManuscriptRevision('钥匙', changed) })), error => error.code === 'REQUEST_CONFLICT' && error.status === 409);
  await settled(f.service, first.id); assert.equal(f.starts.length, 1);
});

test('generated case ids stay idempotent and the full submitted version participates in conflicts', async t => {
  const f = await fixture(t); const withoutCase = input(); delete withoutCase.caseId;
  const first = await f.service.start(withoutCase), duplicate = await f.service.start(withoutCase); assert.equal(duplicate.id, first.id);
  await assert.rejects(f.service.start({ ...withoutCase, title: '另一把钥匙', manuscriptRevision: productManuscriptRevision('另一把钥匙', chapters) }),
    error => error.code === 'REQUEST_CONFLICT' && error.status === 409);
  await settled(f.service, first.id); assert.equal(f.starts.length, 1);
});

test('validation adapter events drive visible phase and sealed-stage progress', async t => {
  let release; const f = await fixture(t, async args => {
    await args.onProgress({ type: 'created', runDir: path.join(args.runRoot, 'independent-review-test'), totalStages: 2 });
    await args.onProgress({ type: 'dispatch_started', stageId: '01-reader-1-single' });
    await args.onProgress({ type: 'stage_sealed', stageId: '01-reader-1-single' });
    await new Promise(resolve => { release = resolve; }); return result(args, args.request);
  });
  const task = await f.service.start(input({ requestId: 'progress-events' }));
  for (let i = 0; i < 1000 && typeof release !== 'function'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof release, 'function');
  assert.equal(f.service.get(task.id).progress.phase, 'stage_sealed'); assert.equal(f.service.get(task.id).progress.completedStages, 1);
  release(); assert.equal((await settled(f.service, task.id)).status, 'complete');
});

test('cancel wins over a late adapter result and retry keeps attempt history', async t => {
  let release; t.after(() => release?.());
  const f = await fixture(t, args => new Promise(resolve => { release = () => resolve(result(args, args.request)); }));
  const first = await f.service.start(input());
  for (let i = 0; i < 1000 && typeof release !== 'function'; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(typeof release, 'function', 'wait for the delayed adapter, not merely the running status');
  await f.service.cancel(first.id); release(); assert.equal((await settled(f.service, first.id)).status, 'cancelled');
  f.service.tasks.get(first.id).sealedStageIds = ['old-stage-1', 'old-stage-2'];
  f.service.adapter.startIndependentReview = async args => {
    await args.onProgress({ type: 'dispatch_started', stageId: '01-reader-1-single' });
    const newTask = [...f.service.tasks.values()].find(task => task.linkedAttemptId === first.id);
    assert.equal(f.service.get(newTask.id).progress.completedStages, 0, 'a new attempt cannot inherit completed stages from the failed attempt');
    return result(args, args.request);
  };
  const retry = await f.service.retry(first.id); assert.equal(retry.linkedAttemptId, first.id); assert.notEqual(retry.id, first.id);
  assert.equal((await settled(f.service, retry.id)).status, 'complete'); assert.equal(f.service.get(first.id).status, 'cancelled');
  assert.deepEqual(f.service.tasks.get(first.id).sealedStageIds, ['old-stage-1', 'old-stage-2']);
});

test('a hydrated interrupted run resumes from its sealed directory', async t => {
  const f = await fixture(t); const first = await f.service.start(input()); await settled(f.service, first.id);
  const stored = f.service.tasks.get(first.id); stored.status = 'interrupted'; stored.runDir = path.join(await realpath(f.rootDir), 'runs', 'sealed-run'); await f.service.saveTask(stored);
  const resumed = await f.service.retry(first.id); assert.equal(resumed.id, first.id); await settled(f.service, first.id);
  assert.equal(f.resumes.length, 1, JSON.stringify(f.service.get(first.id))); assert.equal(f.starts.length, 1);
});

test('dataless request payload is never opened and blocks retry until hydrated', async t => {
  const rootDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'talewick-independent-cloud-')));
  const id = '11111111-1111-4111-8111-111111111111', folder = path.join(rootDir, id); await mkdir(folder, { recursive: true });
  const frozen = prepared(input()); const requestHash = independentReviewRequestHash(frozen.request);
  const task = { id, projectId: 'project-1', requestId: 'review-request-1', caseId: 'case-1', mode: 'single', status: 'interrupted', manuscriptRevision: input().manuscriptRevision,
    manuscriptSha256: 'a'.repeat(64), requestHash, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: { phase: 'interrupted', completedStages: 0, totalStages: 2 }, report: null, error: null };
  await writeFile(path.join(folder, 'task.json'), JSON.stringify(task)); await writeFile(path.join(folder, 'request.json'), JSON.stringify(frozen));
  const blocked = new Set([path.join(folder, 'request.json')]), reads = [];
  const adapter = { getIndependentReviewVersions: async () => ({}), startIndependentReview: async () => assert.fail(), resumeIndependentReview: async () => assert.fail() };
  const service = await new IndependentReviewService({ rootDir, adapter, analyze: async () => {}, prepareRequest: prepared,
    taskFileState: async file => blocked.has(file) ? { available: false, reason: 'dataless' } : { available: true },
    taskFileRead: async (...args) => { reads.push(args[0]); return readFile(...args); } }).init();
  t.after(async () => { await service.close(); await rm(rootDir, { recursive: true, force: true }); });
  assert.equal(service.get(id).error.message, INDEPENDENT_REVIEW_LOCAL_FILE_WAIT);
  assert.equal(reads.includes(path.join(folder, 'request.json')), false);
  await assert.rejects(service.retry(id), error => error.code === 'LOCAL_FILE_WAIT');
});

test('dataless files inside a sealed adapter run block resume without model dispatch', async t => {
  const rootDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'talewick-independent-run-cloud-')));
  const id = '22222222-2222-4222-8222-222222222222', folder = path.join(rootDir, id), parent = path.join(rootDir, 'runs', 'independent-review-task-cloud'), runDir = path.join(parent, 'run');
  await mkdir(path.join(runDir, 'controller'), { recursive: true });
  const frozen = { ...prepared(input()), submission: input(), title: '钥匙', manuscriptRevision: input().manuscriptRevision };
  const requestHash = independentReviewRequestHash(frozen.request);
  const task = { id, projectId: 'project-1', requestId: 'cloud-run', caseId: 'case-1', mode: 'single', status: 'interrupted', runDir,
    manuscriptRevision: input().manuscriptRevision, manuscriptSha256: 'a'.repeat(64), requestHash, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: { phase: 'interrupted', completedStages: 1, totalStages: 2 }, report: null, error: null };
  await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'task.json'), JSON.stringify(task)); await writeFile(path.join(folder, 'request.json'), JSON.stringify(frozen));
  await writeFile(path.join(parent, 'task.json'), '{}'); await writeFile(path.join(parent, 'request.json'), '{}'); await writeFile(path.join(parent, 'events.ndjson'), '');
  const blocked = path.join(parent, 'events.ndjson'); let resumes = 0;
  const service = await new IndependentReviewService({ rootDir,
    adapter: { getIndependentReviewVersions: async () => ({}), startIndependentReview: async () => assert.fail(), resumeIndependentReview: async () => { resumes++; } },
    analyze: async () => assert.fail(), prepareRequest: prepared,
    taskFileState: async file => file === blocked ? { available: false, reason: 'dataless' } : { available: true } }).init();
  t.after(async () => { await service.close(); await rm(rootDir, { recursive: true, force: true }); });
  assert.equal(service.get(id).progress.phase, 'waiting_local_files'); assert.equal(service.get(id).error.message, INDEPENDENT_REVIEW_LOCAL_FILE_WAIT);
  await assert.rejects(service.retry(id), error => error.code === 'LOCAL_FILE_WAIT'); assert.equal(resumes, 0);
});
