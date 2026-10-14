import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRuntime } from './index.mjs';
import { CREATE_STATE_REVIEW_MODE, FOLLOWUP_CONTINUITY_MODEL_POLICY, PLANNING_FOLLOWUP_DECISION_MODE } from './tasks.mjs';
import { engineBinding } from './engines.mjs';

const output = { title: '路由接线', chapters: [{ id: 'ch-1', title: '章节', body: '完整正文。' }], review: { summary: '合成审阅。' }, checks: {}, warnings: [] };
const request = (projectId, requestId) => ({ projectId, requestId, kind: 'create', idea: '合成路由任务', context: {}, materials: [], style: null, chapters: [], instruction: '', quote: '', baseRevision: 'base' });
async function seed(root, projectId, { createStateReviewMode, planningFollowupDecisionMode } = {}) {
  const id = randomUUID(), folder = path.join(root, id), input = request(projectId, `request-${projectId}`);
  await mkdir(folder, { recursive: true });
  const task = { id, projectId, requestId: input.requestId, kind: 'create', ...engineBinding('ai-sdk'), status: 'interrupted', stage: 'review', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), baseRevision: input.baseRevision };
  const artifacts = { requestSpec: { runtimeVersion: 'fixture', ...(createStateReviewMode ? { createStateReviewMode } : {}), ...(planningFollowupDecisionMode ? { planningFollowupDecisionMode } : {}) } };
  for (const [name, value] of Object.entries({ 'task.json': task, 'request.json': input, 'artifacts.json': artifacts })) await writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  return id;
}
async function api(base, route, body) { const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
async function done(base, id) { for (let i = 0; i < 500; i++) { const value = (await api(base, `/api/tasks/${id}`)).body.task; if (!['queued', 'running'].includes(value.status)) return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('task did not settle'); }

test('HTTP binds v3 by default and restores legacy, v2, and v3 requestSpec modes', async t => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-create-state-http-'));
  const legacyId = await seed(runsDir, 'legacy-project');
  const v2Id = await seed(runsDir, 'v2-project', { createStateReviewMode: 'create-state-review-v2', planningFollowupDecisionMode: PLANNING_FOLLOWUP_DECISION_MODE });
  const v3Id = await seed(runsDir, 'v3-project', { createStateReviewMode: CREATE_STATE_REVIEW_MODE, planningFollowupDecisionMode: PLANNING_FOLLOWUP_DECISION_MODE });
  const seen = new Map();
  const runtime = await createRuntime({ full15Adapter: null, config: { runsDir, port: 0, baseURL: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture', engine: 'ai-sdk', timeoutMs: 1000 }, model: { complete: async args => args.modelPolicy }, library: null,
    workflow: async args => { const modelPolicy = await args.model.complete({ stage: 'continuity-chain-review', system: 'fixture', user: 'fixture' }); seen.set(args.request.projectId, { createStateReviewMode: args.createStateReviewMode, planningFollowupDecisionMode: args.planningFollowupDecisionMode, modelPolicy }); if (!args.artifacts.requestSpec) await args.checkpoint('requestSpec', { runtimeVersion: 'fixture', ...(args.createStateReviewMode ? { createStateReviewMode: args.createStateReviewMode } : {}), ...(args.planningFollowupDecisionMode ? { planningFollowupDecisionMode: args.planningFollowupDecisionMode } : {}) }); return structuredClone(output); } });
  t.after(async () => { await runtime.close(); if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve)); await rm(runsDir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { runtime.server.once('error', reject); runtime.server.listen(0, '127.0.0.1', resolve); }); const base = `http://127.0.0.1:${runtime.server.address().port}`;

  const submitted = await api(base, '/api/tasks', request('new-project', 'new-request')); assert.equal(submitted.status, 202);
  assert.equal((await done(base, submitted.body.task.id)).status, 'completed'); assert.deepEqual(seen.get('new-project'), { createStateReviewMode: CREATE_STATE_REVIEW_MODE, planningFollowupDecisionMode: PLANNING_FOLLOWUP_DECISION_MODE, modelPolicy: FOLLOWUP_CONTINUITY_MODEL_POLICY });
  const submittedArtifacts = JSON.parse(await readFile(path.join(runsDir, submitted.body.task.id, 'artifacts.json')));
  assert.equal(submittedArtifacts.requestSpec.createStateReviewMode, CREATE_STATE_REVIEW_MODE);
  assert.equal(submittedArtifacts.requestSpec.planningFollowupDecisionMode, PLANNING_FOLLOWUP_DECISION_MODE);

  assert.equal((await api(base, `/api/tasks/${legacyId}/resume`, {})).status, 200); assert.equal((await done(base, legacyId)).status, 'completed'); assert.deepEqual(seen.get('legacy-project'), { createStateReviewMode: undefined, planningFollowupDecisionMode: undefined, modelPolicy: undefined });
  assert.equal((await api(base, `/api/tasks/${v2Id}/resume`, {})).status, 200); assert.equal((await done(base, v2Id)).status, 'completed'); assert.deepEqual(seen.get('v2-project'), { createStateReviewMode: 'create-state-review-v2', planningFollowupDecisionMode: PLANNING_FOLLOWUP_DECISION_MODE, modelPolicy: FOLLOWUP_CONTINUITY_MODEL_POLICY });
  assert.equal((await api(base, `/api/tasks/${v3Id}/resume`, {})).status, 200); assert.equal((await done(base, v3Id)).status, 'completed'); assert.deepEqual(seen.get('v3-project'), { createStateReviewMode: CREATE_STATE_REVIEW_MODE, planningFollowupDecisionMode: PLANNING_FOLLOWUP_DECISION_MODE, modelPolicy: FOLLOWUP_CONTINUITY_MODEL_POLICY });
});
