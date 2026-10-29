import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRuntime } from './index.mjs';

import { writingGoalRequest } from './fixtures/writing-goals.mjs';
const request = writingGoalRequest();
async function until(fn) {
  const end = Date.now() + 5000;
  while (true) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('real local HTTP API round-trips writing goals and rejects invalid or changed request identities without model calls', async t => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-writing-goals-http-'));
  let workflowCalls = 0, modelCalls = 0, seenRequest;
  const runtime = await createRuntime({ config: { runsDir, apiKey: 'synthetic', baseURL: 'http://127.0.0.1:1', model: 'synthetic', port: 0 },
    model: { complete: async () => { modelCalls++; assert.fail('writing-goal HTTP validation must not call a model'); } },
    workflow: async ({ request: received }) => { workflowCalls++; seenRequest = received; throw new Error('synthetic workflow stop'); },
    library: null, full15Adapter: null, independentReviewAdapter: null,
    publicationFeedback: { list: async () => [], close: async () => {} } });
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  t.after(async () => { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); await runtime.close(); await rm(runsDir, { recursive: true, force: true }); });
  const root = `http://127.0.0.1:${runtime.server.address().port}`;
  const post = body => fetch(`${root}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const createdResponse = await post(request), created = await createdResponse.json();
  assert.equal(createdResponse.status, 202);
  const failed = await until(async () => {
    const response = await fetch(`${root}/api/tasks/${created.task.id}`), value = await response.json();
    return value.task.status === 'failed' ? value.task : null;
  });
  assert.equal(failed.requestId, request.requestId);
  assert.deepEqual(seenRequest.writingGoals, request.writingGoals);
  const saved = JSON.parse(await readFile(path.join(runsDir, created.task.id, 'request.json'), 'utf8'));
  assert.deepEqual(saved.writingGoals, request.writingGoals);
  assert.equal(workflowCalls, 1); assert.equal(modelCalls, 0);

  const duplicate = await post(request);
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).task.id, created.task.id);
  const changed = structuredClone(request); changed.writingGoals.goals[0].problem.statement += '（改变请求身份）';
  assert.equal((await post(changed)).status, 409);
  const invalidMutations = [
    value => { value.writingGoals.schemaVersion = 'creation-writing-goals-unknown'; },
    value => { value.writingGoals.goals = []; },
    value => { delete value.writingGoals.goals[0].problem; },
    value => { value.writingGoals.goals[0].chapterIds = ['not-a-chapter']; },
  ];
  for (const [index, mutate] of invalidMutations.entries()) {
    const invalid = structuredClone(request); invalid.requestId += `-invalid-${index}`; mutate(invalid);
    assert.equal((await post(invalid)).status, 400);
  }
  assert.equal(workflowCalls, 1); assert.equal(modelCalls, 0);
});
