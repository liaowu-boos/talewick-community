import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createRuntime } from './index.mjs';
import { productManuscriptRevision } from './full15-service.mjs';

async function api(server, route, body) {
  return new Promise(resolve => {
    const raw = body === undefined ? '' : JSON.stringify(body), req = Readable.from(raw ? [Buffer.from(raw)] : []);
    Object.assign(req, { method: body === undefined ? 'GET' : 'POST', url: route,
      headers: { host: '127.0.0.1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) } });
    const res = { writeHead(status) { this.status = status; }, end(value) { resolve({ status: this.status, body: JSON.parse(String(value)) }); } };
    server.emit('request', req, res);
  });
}

test('HTTP recheck accepts task identity only and project snapshot keeps baseline and candidate separate', async t => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-recheck-http-'));
  const runtime = await createRuntime({ config: { runsDir, apiKey: 'synthetic', baseURL: 'http://127.0.0.1:1', model: 'synthetic', port: 0 },
    model: { complete: async () => assert.fail('fixture must not reach provider') }, workflow: async () => assert.fail('no creation expected'),
    library: null, publicationFeedback: { list: async () => [], close: async () => {} }, full15Adapter: null, independentReviewAdapter: null });
  t.after(async () => { await runtime.close(); await rm(runsDir, { recursive: true, force: true }); });
  const projectId = 'analysis99-family-photo', title = '合照';
  const chapters = [{ id: 'c1', title: '第一章', body: '她拿起相片。' }, { id: 'c2', title: '第二章', body: '她把相片放回原处。' }];
  const baseRevision = productManuscriptRevision(title, chapters), baselineId = crypto.randomUUID(), sourceId = crypto.randomUUID();
  const task = (id, kind, result, requestId) => ({ id, projectId, requestId, kind, status: 'completed', stage: 'complete',
    createdAt: '2026-10-23T01:00:00Z', updatedAt: '2026-10-23T01:00:00Z', baseRevision, engine: 'fixed', engineVersion: 'fixed-workflow-1', result });
  runtime.tasks.tasks.set(baselineId, task(baselineId, 'create', { title, chapters, review: { summary: 'fixture' }, checks: {}, knowledge: {}, warnings: [] }, 'base'));
  runtime.tasks.requests.set(baselineId, { projectId, requestId: 'base', kind: 'create', idea: '家庭合照', context: {}, materials: [], style: null, chapters: [], instruction: '', quote: '', baseRevision });
  runtime.tasks.tasks.set(sourceId, { ...task(sourceId, 'revise', { title, chapters, wholeRevision: { schemaVersion: 'whole-manuscript-quality-1',
    status: 'candidate_ready_cross_check_incomplete' } }, 'revise'), revisionMode: 'whole-manuscript-v2' });
  runtime.tasks.requests.set(sourceId, { projectId, requestId: 'revise', kind: 'revise', revisionMode: 'whole-manuscript-v2',
    idea: '家庭合照', context: {}, materials: [], style: null, projectTitle: title, chapters, instruction: '修订', quote: '', baseRevision });
  const otherId = crypto.randomUUID();
  runtime.tasks.tasks.set(otherId, { ...task(otherId, 'create', { title: '另一篇已保存作品', chapters }, 'other-base'),
    projectId: 'saved-project-b', createdAt: '2026-10-23T02:00:00Z', updatedAt: '2026-10-23T02:00:00Z' });
  const projects = await api(runtime.server, '/api/projects');
  assert.equal(projects.status, 200);
  assert.deepEqual(projects.body.projects, [
    { id: 'saved-project-b', title: '另一篇已保存作品', updatedAt: '2026-10-23T02:00:00Z', baselineTaskId: otherId },
    { id: projectId, title, updatedAt: '2026-10-23T01:00:00Z', baselineTaskId: baselineId },
  ]);
  const runtimeStatus = await api(runtime.server, '/api/runtime');
  assert.equal(runtimeStatus.body.deepReferences.available, false);
  const snapshot = await api(runtime.server, `/api/projects/${projectId}/import-snapshot`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.baseline.id, baselineId);
  assert.equal(snapshot.body.revision.id, sourceId);
  const forged = await api(runtime.server, '/api/candidate-rechecks', { projectId, sourceTaskId: sourceId, result: { status: 'passed' } });
  assert.equal(forged.status, 400);
  const submitted = await api(runtime.server, '/api/candidate-rechecks', { projectId, sourceTaskId: sourceId });
  assert.equal(submitted.status, 202);
  assert.equal(submitted.body.task.sourceTaskId, sourceId);
  assert.equal(runtime.tasks.get(sourceId).result.wholeRevision.status, 'candidate_ready_cross_check_incomplete');
  const crossProject = await api(runtime.server, '/api/candidate-rechecks', { projectId: 'wrong-project', sourceTaskId: sourceId });
  assert.equal(crossProject.status, 409);
});
