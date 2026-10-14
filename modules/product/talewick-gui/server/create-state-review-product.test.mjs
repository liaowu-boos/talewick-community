import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskService, CREATE_STATE_REVIEW_MODE, FOLLOWUP_CONTINUITY_MODEL_POLICY } from './tasks.mjs';
import { engineBinding } from './engines.mjs';

const request = (kind = 'create', suffix = randomUUID()) => ({ projectId: `project-${suffix}`, requestId: `request-${suffix}`, kind, idea: '合成接线任务', context: {}, materials: [], style: null, chapters: kind === 'revise' ? [{ id: 'ch-1', title: '旧章', body: '旧正文。' }] : [], instruction: kind === 'revise' ? '核对旧正文。' : '', quote: '', baseRevision: 'base' });
const output = { title: '接线结果', chapters: [{ id: 'ch-1', title: '章节', body: '完整正文。' }], review: { summary: '合成审阅。' }, checks: {}, warnings: [] };
async function settled(service, id) { for (let i = 0; i < 500; i++) { const task = service.get(id); if (!['queued', 'running'].includes(task.status) && !service.busy) return task; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('task did not settle'); }
async function seed(root, { mode, kind = 'create' } = {}) {
  const id = randomUUID(), folder = path.join(root, id), input = request(kind);
  await mkdir(folder, { recursive: true });
  const task = { id, projectId: input.projectId, requestId: input.requestId, kind, ...engineBinding('ai-sdk'), status: 'interrupted', stage: 'review', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), baseRevision: input.baseRevision };
  const artifacts = { requestSpec: { runtimeVersion: 'fixture', ...(mode === undefined ? {} : { createStateReviewMode: mode }) } };
  for (const [name, value] of Object.entries({ 'task.json': task, 'request.json': input, 'artifacts.json': artifacts })) await writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  return { id, artifacts };
}
async function fixture(t, seeded) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'talewick-create-state-product-')), seen = [], modelPolicies = [];
  if (seeded) await seeded(root);
  const service = await new TaskService({ runsDir: root, engine: 'ai-sdk', model: { complete: async args => { modelPolicies.push(args.modelPolicy); return '{}'; } }, workflow: async args => {
    seen.push(args.createStateReviewMode);
    await args.model.complete({ stage: 'continuity-chain-review', system: 'fixture', user: 'fixture' });
    if (!args.artifacts.requestSpec) await args.checkpoint('requestSpec', { runtimeVersion: 'fixture', ...(args.createStateReviewMode ? { createStateReviewMode: args.createStateReviewMode } : {}) });
    return structuredClone(output);
  } }).init();
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, service, seen, modelPolicies };
}

test('new ai-sdk create binds create-state-review-v3 and persists its policy boundary', async t => {
  const f = await fixture(t), submitted = await f.service.create(request('create'));
  assert.equal((await settled(f.service, submitted.id)).status, 'completed');
  assert.deepEqual(f.seen, [CREATE_STATE_REVIEW_MODE]);
  assert.deepEqual(f.modelPolicies, [FOLLOWUP_CONTINUITY_MODEL_POLICY]);
  const artifacts = JSON.parse(await readFile(path.join(f.root, submitted.id, 'artifacts.json'), 'utf8'));
  const task = JSON.parse(await readFile(path.join(f.root, submitted.id, 'task.json'), 'utf8'));
  assert.equal(artifacts.requestSpec.createStateReviewMode, CREATE_STATE_REVIEW_MODE);
  assert.equal(Object.hasOwn(task, 'createStateReviewMode'), false, 'requestSpec becomes the durable binding after its checkpoint');
});

test('legacy create resume with requestSpec but no mode stays on the old path', async t => {
  let seeded; const f = await fixture(t, async root => { seeded = await seed(root); });
  await f.service.resume(seeded.id); assert.equal((await settled(f.service, seeded.id)).status, 'completed');
  assert.deepEqual(f.seen, [undefined]);
  assert.deepEqual(f.modelPolicies, [undefined]);
  assert.equal(JSON.parse(await readFile(path.join(f.root, seeded.id, 'artifacts.json'), 'utf8')).requestSpec.createStateReviewMode, undefined);
});

test('legacy v1 create resume follows its saved mode without followup policy', async t => {
  let seeded; const f = await fixture(t, async root => { seeded = await seed(root, { mode: 'create-state-review-v1' }); });
  await f.service.resume(seeded.id); assert.equal((await settled(f.service, seeded.id)).status, 'completed');
  assert.deepEqual(f.seen, ['create-state-review-v1']);
  assert.deepEqual(f.modelPolicies, [undefined]);
});

test('legacy v2 create resume retains its saved mode and followup policy', async t => {
  let seeded; const f = await fixture(t, async root => { seeded = await seed(root, { mode: 'create-state-review-v2' }); });
  await f.service.resume(seeded.id); assert.equal((await settled(f.service, seeded.id)).status, 'completed');
  assert.deepEqual(f.seen, ['create-state-review-v2']);
  assert.deepEqual(f.modelPolicies, [FOLLOWUP_CONTINUITY_MODEL_POLICY]);
});

test('v3 create resume follows the mode saved in requestSpec', async t => {
  let seeded; const f = await fixture(t, async root => { seeded = await seed(root, { mode: CREATE_STATE_REVIEW_MODE }); });
  await f.service.resume(seeded.id); assert.equal((await settled(f.service, seeded.id)).status, 'completed');
  assert.deepEqual(f.seen, [CREATE_STATE_REVIEW_MODE]);
  assert.deepEqual(f.modelPolicies, [FOLLOWUP_CONTINUITY_MODEL_POLICY]);
});

test('new revise task never receives create state review mode', async t => {
  const f = await fixture(t), submitted = await f.service.create(request('revise'));
  assert.equal((await settled(f.service, submitted.id)).status, 'completed');
  assert.deepEqual(f.seen, [undefined]);
  assert.deepEqual(f.modelPolicies, [undefined]);
});
