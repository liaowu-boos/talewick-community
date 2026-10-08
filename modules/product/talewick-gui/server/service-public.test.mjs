import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskService } from './tasks.mjs';
import { adjudicationFixture } from '../scripts/review-adjudication-fixtures.mjs';

test('get and list add binding diagnostics without changing saved task, raw review, or manuscript', () => {
  const service = new TaskService({ runsDir: '/unused', model: {}, workflow: () => { throw new Error('must not run'); } });
  const result = adjudicationFixture(); delete result.reviewAdjudicationBinding;
  const task = { id: 'test', projectId: 'project', kind: 'create', status: 'completed', createdAt: '2026-09-21', result };
  const before = structuredClone(task); service.tasks.set(task.id, task);
  const projected = service.get(task.id);
  assert.equal(projected.result.reviewAdjudicationBinding.status, 'bound');
  assert.deepEqual(projected.result.reviewAdjudication, result.reviewAdjudication);
  assert.deepEqual(service.list('project')[0], projected);
  projected.result.reviewAdjudication.decisions[0].decision = 'reject';
  projected.result.chapters[0].body = 'modified projection';
  assert.deepEqual(service.tasks.get(task.id), before);
});

test('legacy task init retains fixed-workflow-1; resume refuses without executing or changing checkpoints', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'talewick-legacy-version-'));
  const id = '00000000-0000-4000-8000-000000000001';
  const folder = path.join(root, id); await mkdir(folder);
  const task = { id, projectId: 'project', requestId: 'request', kind: 'create', status: 'interrupted', stage: 'review', createdAt: '2026-09-01', updatedAt: '2026-09-01' };
  const request = { projectId: 'project', requestId: 'request', kind: 'create', idea: '合成旧任务', baseRevision: 'legacy', chapters: [] };
  const artifacts = { 'draft:ch-1': { id: 'ch-1', title: '旧章节', body: '保存的历史正文。' } };
  for (const [name, value] of Object.entries({ 'task.json': task, 'request.json': request, 'artifacts.json': artifacts })) await writeFile(path.join(folder, name), JSON.stringify(value));
  const service = new TaskService({ runsDir: root, model: { complete() { throw new Error('no calls allowed'); } }, workflow() { throw new Error('no workflow allowed'); } });
  try {
    await service.init();
    assert.equal(service.get(id).engine, 'fixed'); assert.equal(service.get(id).engineVersion, 'fixed-workflow-1');
    await assert.rejects(service.resume(id), error => error.status === 409);
    assert.equal(service.get(id).status, 'interrupted');
    assert.deepEqual(JSON.parse(await readFile(path.join(folder, 'task.json'), 'utf8')), task);
    assert.deepEqual(JSON.parse(await readFile(path.join(folder, 'artifacts.json'), 'utf8')), artifacts);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
