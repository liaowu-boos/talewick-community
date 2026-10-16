import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { engineBinding } from './engines.mjs';
import { LOCAL_FILE_WAIT_MESSAGE, TaskService, localTaskFileState } from './tasks.mjs';

const result = { title: '钥匙', chapters: [{ id: 'c1', title: '第一章', body: '她把钥匙放回桌上。' }], review: { summary: '固定测试响应。' }, warnings: [], checks: {}, knowledge: {} };
const request = extra => ({ projectId: 'project-1', requestId: 'request-1', kind: 'create', idea: '一篇关于归还钥匙的短篇小说', context: {}, materials: [{ title: '线索.txt', content: '门还开着。' }], style: null, baseRevision: 'initial', ...extra });
const storedTask = (id, input, extra = {}) => ({ id, projectId: input.projectId, requestId: input.requestId, kind: input.kind, ...engineBinding('fixed'), status: 'interrupted', stage: '已中断', createdAt: '2026-10-15T01:00:00.000Z', updatedAt: '2026-10-15T01:00:00.000Z', baseRevision: input.baseRevision, ...extra });
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Build a bound failure checkpoint from synthetic inputs, never a captured model response.
const { runWholeManuscriptQualityRevision, inspectStoredWholeQualityReadingFailure } = await import('../../../creation/runtime/whole-manuscript-quality.mjs');
const syntheticExhaustedReadingArtifacts = {};
await assert.rejects(runWholeManuscriptQualityRevision({
  request: { ...request(), kind: 'revise', revisionMode: 'whole-manuscript-v2', projectTitle: '合成钥匙测试', chapters: result.chapters, instruction: '检查动作是否清楚。' },
  model: { complete: async () => '{}' },
  checkpoint: async (key, value) => { syntheticExhaustedReadingArtifacts[key] = structuredClone(value); },
}), { code: 'WHOLE_QUALITY_FORMAT_FAILED' });
assert.equal(inspectStoredWholeQualityReadingFailure(syntheticExhaustedReadingArtifacts).exhausted, true);

async function seed(root, id, input, taskExtra = {}, artifacts = {}) {
  const folder = path.join(root, id);
  await mkdir(folder, { recursive: true });
  await Promise.all([
    writeFile(path.join(folder, 'task.json'), json(storedTask(id, input, taskExtra))),
    writeFile(path.join(folder, 'request.json'), json(input)),
    writeFile(path.join(folder, 'artifacts.json'), json(artifacts)),
  ]);
  return folder;
}

async function snapshot(folder) {
  const entries = await Promise.all(['task.json', 'request.json', 'artifacts.json'].map(async name => [name, await readFile(path.join(folder, name))]));
  return Object.fromEntries(entries);
}

async function until(fn) {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'talewick-local-files-'));
  const blocked = new Set();
  const reads = [];
  const taskFileState = async file => blocked.has(file) ? { available: false, reason: 'dataless' } : { available: true };
  const taskFileRead = async (...args) => { reads.push(args[0]); return readFile(...args); };
  const services = [];
  t.after(async () => {
    for (const service of services) await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, blocked, reads, taskFileState, taskFileRead, services };
}

test('startup skips dataless payloads, preserves bytes, and continues loading other tasks', async t => {
  const f = await fixture(t);
  const blockedId = '11111111-1111-4111-8111-111111111111';
  const readyId = '22222222-2222-4222-8222-222222222222';
  const blockedRequest = request();
  const blockedFolder = await seed(f.root, blockedId, blockedRequest, { status: 'running', stage: '生成正文', result });
  await seed(f.root, readyId, request({ projectId: 'project-2', requestId: 'request-2' }), { status: 'completed', stage: '完成', result });
  f.blocked.add(path.join(blockedFolder, 'request.json'));
  f.blocked.add(path.join(blockedFolder, 'artifacts.json'));
  const before = await snapshot(blockedFolder);
  let workflowCalls = 0;
  const service = new TaskService({ runsDir: f.root, model: { complete() { throw new Error('model must not run'); } }, workflow: async () => { workflowCalls++; return result; }, taskFileState: f.taskFileState, taskFileRead: f.taskFileRead });
  f.services.push(service);

  await Promise.race([
    service.init(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('startup blocked on a local placeholder')), 1000)),
  ]);

  const waiting = service.get(blockedId);
  assert.equal(waiting.status, 'interrupted');
  assert.equal(waiting.stage, '等待本地文件下载');
  assert.equal(waiting.error, LOCAL_FILE_WAIT_MESSAGE);
  assert.equal(waiting.result.title, result.title, 'readable inline result metadata remains visible');
  assert.deepEqual(waiting.result.chapters, result.chapters);
  assert.equal(service.get(readyId).status, 'completed', 'other tasks still load');
  assert.equal(workflowCalls, 0);
  assert.deepEqual(f.reads.map(file => path.relative(f.root, file)).sort(), [
    `${blockedId}/task.json`,
    `${readyId}/artifacts.json`,
    `${readyId}/request.json`,
    `${readyId}/task.json`,
  ].sort(), 'startup never opens dataless request or artifact files');
  await service.close();
  const after = await snapshot(blockedFolder);
  for (const name of Object.keys(before)) {
    assert.deepEqual(after[name], before[name]);
    assert.equal(sha256(after[name]), sha256(before[name]));
  }
});

test('resume and duplicate request ids stay blocked while local files await download', async t => {
  const f = await fixture(t);
  const id = '33333333-3333-4333-8333-333333333333';
  const input = request();
  const folder = await seed(f.root, id, input);
  f.blocked.add(path.join(folder, 'request.json'));
  f.blocked.add(path.join(folder, 'artifacts.json'));
  const before = await snapshot(folder);
  let workflowCalls = 0;
  let modelCalls = 0;
  const service = await new TaskService({ runsDir: f.root, model: { complete() { modelCalls++; throw new Error('forbidden'); } }, workflow: async () => { workflowCalls++; return result; }, taskFileState: f.taskFileState, taskFileRead: f.taskFileRead }).init();
  f.services.push(service);

  await assert.rejects(service.resume(id), error => error.status === 409 && error.message === LOCAL_FILE_WAIT_MESSAGE);
  await assert.rejects(service.create(input), error => error.status === 409 && /等待下载/.test(error.message));
  assert.equal(workflowCalls, 0);
  assert.equal(modelCalls, 0);
  assert.deepEqual((await readdir(f.root)).filter(name => /^[a-f0-9-]{36}$/.test(name)), [id]);
  const after = await snapshot(folder);
  for (const name of Object.keys(before)) assert.deepEqual(after[name], before[name]);
});

test('resume reloads and validates hydrated files before continuing the original request', async t => {
  const f = await fixture(t);
  const id = '44444444-4444-4444-8444-444444444444';
  const input = request();
  const folder = await seed(f.root, id, input, {}, { checkpoint: { kept: true } });
  f.blocked.add(path.join(folder, 'request.json'));
  f.blocked.add(path.join(folder, 'artifacts.json'));
  let received;
  const service = await new TaskService({ runsDir: f.root, model: { complete() { throw new Error('model must not run'); } }, workflow: async args => { received = { request: structuredClone(args.request), artifacts: structuredClone(args.artifacts) }; return structuredClone(result); }, taskFileState: f.taskFileState, taskFileRead: f.taskFileRead }).init();
  f.services.push(service);
  assert.equal(service.get(id).error, LOCAL_FILE_WAIT_MESSAGE);

  f.blocked.clear();
  assert.equal((await service.resume(id)).id, id);
  await until(() => service.get(id).status === 'completed' && !service.busy);
  assert.equal(received.request.projectId, input.projectId);
  assert.equal(received.request.requestId, input.requestId);
  assert.equal(received.request.idea, input.idea);
  assert.deepEqual(received.request.materials, input.materials, 'resume uses the original hydrated materials');
  assert.deepEqual(received.artifacts, { checkpoint: { kept: true } });
  assert.equal(service.get(id).result.title, result.title);
  assert.deepEqual(service.get(id).result.chapters, result.chapters);
  assert.deepEqual(JSON.parse(await readFile(path.join(folder, 'request.json'), 'utf8')), input);
});

test('hydration with a changed binding rejects resume without running work or rewriting files', async t => {
  const f = await fixture(t);
  const id = '55555555-5555-4555-8555-555555555555';
  const taskInput = request();
  const folder = await seed(f.root, id, request({ requestId: 'different-request' }));
  await writeFile(path.join(folder, 'task.json'), json(storedTask(id, taskInput)));
  f.blocked.add(path.join(folder, 'request.json'));
  f.blocked.add(path.join(folder, 'artifacts.json'));
  const before = await snapshot(folder);
  let workflowCalls = 0;
  const service = await new TaskService({ runsDir: f.root, model: { complete() { throw new Error('forbidden'); } }, workflow: async () => { workflowCalls++; return result; }, taskFileState: f.taskFileState, taskFileRead: f.taskFileRead }).init();
  f.services.push(service);

  f.blocked.clear();
  await assert.rejects(service.resume(id), error => error.status === 409 && /绑定校验未通过/.test(error.message));
  assert.equal(workflowCalls, 0);
  const after = await snapshot(folder);
  for (const name of Object.keys(before)) assert.deepEqual(after[name], before[name]);
});

test('materialized task files pass the platform metadata check', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'talewick-local-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'task.json');
  await writeFile(file, '{}\n');
  assert.deepEqual(await localTaskFileState(file), { available: true });
});

test('a dataless task index is tracked and rechecked before resume or new work', async t => {
  const f = await fixture(t);
  const id = '66666666-6666-4666-8666-666666666666';
  const input = request();
  const folder = await seed(f.root, id, input);
  f.blocked.add(path.join(folder, 'task.json'));
  let workflowCalls = 0;
  const service = await new TaskService({ runsDir: f.root, model: {}, workflow: async () => { workflowCalls++; return result; }, taskFileState: f.taskFileState, taskFileRead: f.taskFileRead }).init();
  f.services.push(service);

  await assert.rejects(service.resume(id), error => error.status === 409 && error.message === LOCAL_FILE_WAIT_MESSAGE);
  await assert.rejects(service.create(input), error => error.status === 409 && error.message === LOCAL_FILE_WAIT_MESSAGE);
  assert.equal(workflowCalls, 0);
  assert.equal(f.reads.some(file => file === path.join(folder, 'task.json')), false);

  f.blocked.clear();
  assert.equal((await service.resume(id)).id, id);
  await until(() => service.get(id).status === 'completed' && !service.busy);
  assert.equal(workflowCalls, 1);
});

test('create rechecks a hydrated task index and unlocks unrelated new work without the old id', async t => {
  const f = await fixture(t);
  const id = '77777777-7777-4777-8777-777777777777';
  const oldInput = request();
  const folder = await seed(f.root, id, oldInput, { status: 'running' });
  f.blocked.add(path.join(folder, 'task.json'));
  let workflowCalls = 0;
  const service = await new TaskService({ runsDir: f.root, model: {}, workflow: async () => { workflowCalls++; return structuredClone(result); }, taskFileState: f.taskFileState, taskFileRead: f.taskFileRead }).init();
  f.services.push(service);
  assert.deepEqual(service.list(), []);

  f.blocked.clear();
  const created = await service.create(request({ projectId: 'project-2', requestId: 'request-2' }));
  assert.notEqual(created.id, id);
  assert.equal(service.get(id).status, 'interrupted', 'the hydrated old task becomes visible without knowing its id');
  await until(() => service.get(created.id).status === 'completed' && !service.busy);
  assert.equal(workflowCalls, 1, 'only the explicitly submitted new task runs');
});

test('create rechecks hydrated payloads and returns the original task for an identical request id', async t => {
  const f = await fixture(t);
  const id = '88888888-8888-4888-8888-888888888888';
  const input = request();
  const folder = await seed(f.root, id, input);
  f.blocked.add(path.join(folder, 'request.json'));
  f.blocked.add(path.join(folder, 'artifacts.json'));
  let workflowCalls = 0;
  const service = await new TaskService({ runsDir: f.root, model: {}, workflow: async () => { workflowCalls++; return result; }, taskFileState: f.taskFileState, taskFileRead: f.taskFileRead }).init();
  f.services.push(service);

  f.blocked.clear();
  const recovered = await service.create(input);
  assert.equal(recovered.id, id);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(workflowCalls, 0);
  assert.deepEqual((await readdir(f.root)).filter(name => /^[a-f0-9-]{36}$/.test(name)), [id]);
});

test('real exhausted whole-quality checkpoint stays readable but cannot replay the invalid repair response', async t => {
  const f = await fixture(t);
  const id = '66666666-6666-4666-8666-666666666666';
  const input = request({
    requestId: 'whole-quality-failed-r1', kind: 'revise', revisionMode: 'whole-manuscript-v2',
    chapters: result.chapters, instruction: '从当前原稿重新检查整稿', quote: '',
  });
  const folder = await seed(f.root, id, input, {
    kind: 'revise', revisionMode: 'whole-manuscript-v2', engine: 'ai-sdk', engineVersion: 'ai-sdk-7.0.93-talewick-2', status: 'failed',
    stage: 'whole-quality:reading:repair-response',
    failure: { kind: 'unknown', phase: 'step', retryScope: 'unfinished_step', message: '当前步骤未完成。已完成步骤已保存；继续任务时只会运行未完成步骤。' },
    error: '当前步骤未完成。已完成步骤已保存；继续任务时只会运行未完成步骤。',
    modelAttempts: [
      { stage: 'whole-quality:reading', mode: 'primary', finishReason: 'stop' },
      { stage: 'whole-quality:reading:format-repair', mode: 'primary', finishReason: 'stop' },
    ],
  }, structuredClone(syntheticExhaustedReadingArtifacts));
  const before = await snapshot(folder);
  let workflowCalls = 0;
  let modelCalls = 0;
  const service = await new TaskService({
    runsDir: f.root,
    model: { complete() { modelCalls++; throw new Error('model must not run'); } },
    workflow: async () => { workflowCalls++; return result; },
    taskFileState: f.taskFileState,
    taskFileRead: f.taskFileRead,
  }).init();
  f.services.push(service);

  const loaded = service.get(id);
  assert.equal(loaded.status, 'failed');
  assert.equal(loaded.failure.recoverable, false);
  assert.match(loaded.failure.message, /原稿、诊断输入和已保存现场仍保留/);
  assert.match(loaded.failure.message, /重新发起整稿修订/);
  await assert.rejects(service.resume(id), error => error.status === 409 && /重新发起整稿修订/.test(error.message));
  assert.equal(workflowCalls, 0);
  assert.equal(modelCalls, 0);
  const after = await snapshot(folder);
  for (const name of Object.keys(before)) {
    assert.deepEqual(after[name], before[name], `${name} remains byte-exact`);
    assert.equal(sha256(after[name]), sha256(before[name]));
  }
});

test('a helper-confirmed valid saved repair followed by a later failure remains recoverable', async t => {
  const f = await fixture(t);
  const id = '99999999-9999-4999-8999-999999999999';
  const input = request({ requestId: 'whole-quality-valid-repair-r1', kind: 'revise', revisionMode: 'whole-manuscript-v2',
    chapters: result.chapters, instruction: '继续已验证的整稿修订', quote: '' });
  await seed(f.root, id, input, {
    kind: 'revise', revisionMode: 'whole-manuscript-v2', status: 'failed', stage: 'whole-quality:reading:repair-response',
    failure: { kind: 'unknown', phase: 'step', retryScope: 'unfinished_step', message: '保存后续结果时失败。' }, error: '保存后续结果时失败。',
    modelAttempts: [{ stage: 'whole-quality:reading' }, { stage: 'whole-quality:reading:format-repair' }],
  }, { readingCheckpoints: 'hash-bound valid repair fixture' });
  let workflowCalls = 0;
  const service = await new TaskService({
    runsDir: f.root, model: {}, workflow: async () => { workflowCalls++; return structuredClone(result); },
    taskFileState: f.taskFileState, taskFileRead: f.taskFileRead,
    inspectStoredWholeQualityReadingFailure: artifacts => {
      assert.equal(artifacts.readingCheckpoints, 'hash-bound valid repair fixture');
      return { schemaVersion: 'whole-quality-reading-failure-inspection-1', stage: 'whole-quality:reading', exhausted: false, reason: 'repair_valid' };
    },
  }).init();
  f.services.push(service);

  assert.equal(service.get(id).failure.recoverable, undefined);
  const resumed = await service.resume(id);
  assert.equal(resumed.id, id);
  assert.equal(resumed.status, 'queued');
  await until(() => workflowCalls === 1);
  assert.equal(workflowCalls, 1);
});
