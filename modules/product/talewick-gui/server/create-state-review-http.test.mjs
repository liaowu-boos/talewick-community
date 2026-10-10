import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRuntime } from './index.mjs';
import { CREATE_STATE_REVIEW_MODE } from './tasks.mjs';
import { engineBinding } from './engines.mjs';

const output = { title: '路由接线', chapters: [{ id: 'ch-1', title: '章节', body: '完整正文。' }], review: { summary: '合成审阅。' }, checks: {}, warnings: [] };
const request = (projectId, requestId) => ({ projectId, requestId, kind: 'create', idea: '合成路由任务', context: {}, materials: [], style: null, chapters: [], instruction: '', quote: '', baseRevision: 'base' });
async function seed(root, projectId, mode) {
  const id = randomUUID(), folder = path.join(root, id), input = request(projectId, `request-${projectId}`);
  await mkdir(folder, { recursive: true });
  const task = { id, projectId, requestId: input.requestId, kind: 'create', ...engineBinding('ai-sdk'), status: 'interrupted', stage: 'review', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), baseRevision: input.baseRevision };
  const artifacts = { requestSpec: { runtimeVersion: 'fixture', ...(mode ? { createStateReviewMode: mode } : {}) } };
  for (const [name, value] of Object.entries({ 'task.json': task, 'request.json': input, 'artifacts.json': artifacts })) await writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  return id;
}
async function api(base, route, body) { const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
async function done(base, id) { for (let i = 0; i < 500; i++) { const value = (await api(base, `/api/tasks/${id}`)).body.task; if (!['queued', 'running'].includes(value.status)) return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('task did not settle'); }

test('HTTP binds new create mode, preserves legacy resume, and restores saved new-mode resume', async t => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-create-state-http-'));
  const legacyId = await seed(runsDir, 'legacy-project');
  const resumedId = await seed(runsDir, 'mode-project', CREATE_STATE_REVIEW_MODE);
  const seen = new Map();
  const runtime = await createRuntime({ config: { runsDir, port: 0, baseURL: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture', engine: 'ai-sdk', timeoutMs: 1000 }, model: { complete: async () => assert.fail('workflow fixture owns this test') }, library: null,
    workflow: async args => { seen.set(args.request.projectId, args.createStateReviewMode); if (!args.artifacts.requestSpec) await args.checkpoint('requestSpec', { runtimeVersion: 'fixture', ...(args.createStateReviewMode ? { createStateReviewMode: args.createStateReviewMode } : {}) }); return structuredClone(output); } });
  t.after(async () => { await runtime.close(); if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve)); await rm(runsDir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { runtime.server.once('error', reject); runtime.server.listen(0, '127.0.0.1', resolve); }); const base = `http://127.0.0.1:${runtime.server.address().port}`;

  const submitted = await api(base, '/api/tasks', request('new-project', 'new-request')); assert.equal(submitted.status, 202);
  assert.equal((await done(base, submitted.body.task.id)).status, 'completed'); assert.equal(seen.get('new-project'), CREATE_STATE_REVIEW_MODE);

  assert.equal((await api(base, `/api/tasks/${legacyId}/resume`, {})).status, 200); assert.equal((await done(base, legacyId)).status, 'completed'); assert.equal(seen.get('legacy-project'), undefined);
  assert.equal((await api(base, `/api/tasks/${resumedId}/resume`, {})).status, 200); assert.equal((await done(base, resumedId)).status, 'completed'); assert.equal(seen.get('mode-project'), CREATE_STATE_REVIEW_MODE);
});
