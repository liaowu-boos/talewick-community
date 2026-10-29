import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { manuscriptFingerprint } from '../../../validation/runtime/checks.mjs';
import { CandidateRecheckService, PRODUCT_RECHECK_VERSION } from './candidate-rechecks.mjs';

const chapters = [{ id: 'one', title: '一', body: '房门关上。' }, { id: 'two', title: '二', body: '钥匙还在桌上。' }];
function fixture(root, overrides = {}) {
  const task = { id: 'source-1', projectId: 'project-1', requestId: 'revise-1', status: 'completed', revisionMode: 'whole-manuscript-v2',
    result: { chapters: structuredClone(chapters), wholeRevision: { schemaVersion: 'whole-manuscript-quality-1',
      status: 'candidate_ready_cross_check_incomplete' } } };
  const tasks = { get(id) { if (id !== task.id) throw Object.assign(new Error('missing'), { status: 404 }); return task; },
    requests: new Map([[task.id, { projectId: task.projectId, requestId: task.requestId, kind: 'revise',
      revisionMode: task.revisionMode, chapters: structuredClone(chapters) }]]) };
  const service = new CandidateRecheckService({ rootDir: root, tasks, model: { complete() { throw new Error('provider must not be called in this test'); } },
    runRecheck: async ({ prepared, artifacts }) => {
      const result = { binding: prepared.binding, status: 'reviewed_no_reported_conflict',
        crossChapterResult: { implementationVersion: 'cross-chapter-review-r08', counts: { confirmed_conflict: 0, ambiguous: 0 }, findings: [] } };
      await artifacts.checkpoint('test:sealed', result);
      artifacts.store['test:sealed'] = result;
      return result;
    },
    checkAdoption: async ({ result, sourceTaskId, candidateChapters, checkerVersion, artifacts }) => ({
      eligible: result?.status === 'reviewed_no_reported_conflict' && result.binding.sourceTaskId === sourceTaskId
        && result.binding.candidateSHA === manuscriptFingerprint(candidateChapters)
        && checkerVersion === PRODUCT_RECHECK_VERSION && artifacts['test:sealed']?.status === result.status,
      reason: 'test_replay',
    }), ...overrides });
  return { task, tasks, service };
}

test('server-owned async task is append-only and binds project, source, checker and full candidate', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-recheck-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { task, service } = fixture(root); await service.init();
  await assert.rejects(service.start({ projectId: 'project-1', sourceTaskId: task.id, result: { status: 'passed' } }), { code: 'INPUT_FIELDS' });
  await assert.rejects(service.start({ projectId: 'other-project', sourceTaskId: task.id }), { code: 'SOURCE_TASK_MISMATCH' });
  const started = await service.start({ projectId: 'project-1', sourceTaskId: task.id });
  for (let i = 0; i < 30 && service.records.get(started.id).status === 'queued'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  for (let i = 0; i < 30 && service.records.get(started.id).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const saved = service.records.get(started.id);
  assert.equal(saved.status, 'reviewed_no_reported_conflict');
  assert.equal(saved.candidateSha256, manuscriptFingerprint(chapters));
  assert.equal(saved.prepared.binding.checkerVersion, PRODUCT_RECHECK_VERSION);
  assert.equal(task.result.wholeRevision.status, 'candidate_ready_cross_check_incomplete');
  assert.equal((await service.authorize(started.id, { projectId: 'project-1', sourceTaskId: task.id })).gate.eligible, true);
  await assert.rejects(service.authorize(started.id, { projectId: 'other-project', sourceTaskId: task.id }), { code: 'RECHECK_NOT_FOUND' });
  task.result.chapters[1].body = '另一版。';
  await assert.rejects(service.authorize(started.id, { projectId: 'project-1', sourceTaskId: task.id }), { code: 'RECHECK_NOT_ELIGIBLE' });
  assert.equal(service.list('project-1')[0].gate.eligible, false);
});

test('interrupted queue is retained and never auto-dispatched on restart', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-recheck-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '00000000-0000-4000-8000-000000000001';
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, `${id}.json`), JSON.stringify({ id, projectId: 'project-1', sourceTaskId: 'source-1',
    candidateSha256: manuscriptFingerprint(chapters), checkerVersion: PRODUCT_RECHECK_VERSION,
    createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', status: 'running', artifacts: {}, result: null }));
  const { service } = fixture(root, { runRecheck() { throw new Error('must not restart'); } });
  await service.init();
  assert.equal(service.records.get(id).status, 'interrupted');
  assert.equal(service.records.get(id).error.code, 'PROCESS_INTERRUPTED');
});
