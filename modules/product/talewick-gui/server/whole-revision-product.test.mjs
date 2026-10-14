import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateRequest, TaskService } from './tasks.mjs';
import { createWorkflowRouter, WHOLE_MANUSCRIPT_REVISION_MODE } from './workflow-engine.mjs';
import { assertWorkflowResultReady } from './workflow-result-gate.mjs';
import { createModel } from './model.mjs';
import { isWholeRevisionStage, outputTokenLimit, WHOLE_REVISION_MODEL_POLICY, wholeRevisionReasoningEffort } from './model-policy.mjs';

const chapter = { id: 'ch-1', title: '第一章', body: '门开了。她没有进去。' };
const request = (extra = {}) => ({ projectId: 'whole-project', requestId: 'whole-request', kind: 'revise', revisionMode: WHOLE_MANUSCRIPT_REVISION_MODE,
  idea: '保留克制表达。', context: {}, materials: [], style: null, chapters: [chapter], instruction: '核对情绪递进，只修改证据充分的问题。', quote: '', baseRevision: 'manuscript-v1-fixture', ...extra });
const requestSpec = { schemaVersion: 'whole-manuscript-request-1', kind: 'revise', revisionMode: WHOLE_MANUSCRIPT_REVISION_MODE,
  inputFingerprint: 'a'.repeat(64), sourceManuscriptSha256: 'b'.repeat(64), sourceChapterIds: ['ch-1'], sourceBaseRevision: 'manuscript-v1-fixture', objective: 'fixture' };
const result = { title: '测试稿', chapters: [chapter], warnings: ['候选未自动覆盖工作稿；AI文学判断仍需用户审阅。'], revisionApplied: false, baseRevision: 'manuscript-v1-fixture',
  wholeRevision: { schemaVersion: 'whole-manuscript-revision-1', status: 'no_change', requestSpec, sourceChapters: [chapter], diagnosis: {}, plan: {}, candidateRevision: null, actualChanges: [], diff: { changedChapterIds: [], unchangedChapterIds: ['ch-1'], chapters: [] }, reread: { schemaVersion: 'whole-revision-reread-1' }, unresolvedItems: [], modelCalls: { primaryCalls: 3, formatRepairCalls: 0 }, adoption: { status: 'not_applied', requiredBaseRevision: 'manuscript-v1-fixture', atomicGroups: [] } } };

test('whole manuscript request is explicit and cannot mix excerpt or legacy review modes', () => {
  assert.equal(validateRequest(request()).revisionMode, WHOLE_MANUSCRIPT_REVISION_MODE);
  for (const invalid of [request({ quote: '门开了。' }), request({ quoteSource: { chapterId: 'ch-1', start: 0 } }), request({ existingReviewMode: 'legacy' }), request({ createStateReviewMode: 'legacy' }), request({ revisionMode: 'unknown' }), request({ kind: 'create' })]) {
    assert.throws(() => validateRequest(invalid));
  }
});

test('workflow router calls only the whole manuscript entry for the explicit mode', async () => {
  let calls = 0, received;
  const router = createWorkflowRouter({ config: {}, wholeRevisionRunner: async args => { calls++; received = args; return result; } });
  assert.equal(await router({ request: request(), artifacts: {}, checkpoint() {}, progress() {} }), result);
  assert.equal(calls, 1); assert.equal(received.request.revisionMode, WHOLE_MANUSCRIPT_REVISION_MODE);
});

test('whole result gate runs without an old reviewPolicyVersion and refuses missing mode binding', async () => {
  let calls = 0;
  await assertWorkflowResultReady(result, requestSpec, request(), (value, spec) => { calls++; assert.equal(value, result); assert.equal(spec, requestSpec); });
  assert.equal(calls, 1);
  await assert.rejects(Promise.resolve().then(() => assertWorkflowResultReady(result, {}, request(), () => { throw Error('must not run'); })), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
});

test('TaskService saves a whole candidate only after the whole result assertion', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'talewick-whole-product-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let asserted = 0;
  const service = await new TaskService({ runsDir: root, model: {}, wholeRevisionAssert: (value, spec) => { asserted++; assert.equal(value.wholeRevision.status, 'no_change'); assert.equal(spec.revisionMode, WHOLE_MANUSCRIPT_REVISION_MODE); },
    workflow: async ({ checkpoint }) => { await checkpoint('requestSpec', requestSpec); return structuredClone(result); } }).init();
  t.after(() => service.close());
  const created = await service.create(request());
  let task = created;
  for (let i = 0; i < 100 && task.status !== 'completed' && task.status !== 'failed'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); task = service.get(created.id); }
  assert.equal(task.status, 'completed'); assert.equal(asserted, 1); assert.equal(task.revisionMode, WHOLE_MANUSCRIPT_REVISION_MODE);
  assert.equal(task.result.review, undefined); assert.equal(task.result.reviewAdjudicationBinding, undefined);
  assert.deepEqual(Object.keys(task.result).sort(), ['baseRevision', 'chapters', 'revisionApplied', 'title', 'warnings', 'wholeRevision']);
  assert.equal(JSON.parse(await readFile(path.join(root, task.id, 'request.json'), 'utf8')).revisionMode, WHOLE_MANUSCRIPT_REVISION_MODE);
});

test('whole stages have isolated JSON and budget policy and are never logged as other', async () => {
  for (const stage of ['whole-revision:diagnosis', 'whole-revision:plan', 'whole-revision:revision', 'whole-revision:reread', 'whole-revision:reread:repair']) assert.equal(isWholeRevisionStage(stage), true);
  const v4 = { baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', agentProvider: 'deepseek' };
  assert.equal(wholeRevisionReasoningEffort(v4, 'whole-revision:diagnosis', WHOLE_REVISION_MODEL_POLICY), 'low');
  assert.equal(outputTokenLimit(v4, 7000, 'whole-revision:revision', WHOLE_REVISION_MODEL_POLICY), 65536);
  const bodies = [], attempts = [];
  const model = createModel({ baseURL: 'https://fixture.invalid', apiKey: 'fixture', model: 'deepseek-chat', agentProvider: 'deepseek', timeoutMs: 1000, idleTimeoutMs: 1000 }, async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, headers: { get: () => null }, json: async () => ({ id: 'fixture-invocation', choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }) };
  });
  assert.equal(await model.complete({ stage: 'whole-revision:plan:repair', system: 'fixture', user: 'fixture', maxTokens: 7000, modelPolicy: WHOLE_REVISION_MODEL_POLICY, onAttempt: attempt => attempts.push(attempt) }), '{"ok":true}');
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' }); assert.equal(bodies[0].max_tokens, 7000);
  assert.equal(attempts[0].stage, 'whole-revision:plan:repair'); assert.equal(attempts[0].mode, 'primary');
});
