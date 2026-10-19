import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateRequest, TaskService } from './tasks.mjs';
import { createWorkflowRouter, WHOLE_MANUSCRIPT_QUALITY_MODE, WHOLE_MANUSCRIPT_REVISION_MODE } from './workflow-engine.mjs';
import { assertWorkflowResultReady } from './workflow-result-gate.mjs';
import { WHOLE_QUALITY_MODEL_POLICY } from './model-policy.mjs';

const chapter = { id: 'ch-1', title: '第一章', body: '门开了。她没有进去。' };
const request = (extra = {}) => ({ projectId: 'quality-project', requestId: 'quality-request', kind: 'revise', revisionMode: WHOLE_MANUSCRIPT_QUALITY_MODE,
  idea: '保留克制表达。', context: {}, materials: [], style: null, chapters: [chapter], instruction: '核对情绪递进，只修改证据充分的问题。', quote: '', baseRevision: 'manuscript-v1-fixture', ...extra });
const requestSpec = { schemaVersion: 'whole-manuscript-quality-request-1', kind: 'revise', revisionMode: WHOLE_MANUSCRIPT_QUALITY_MODE,
  inputFingerprint: 'a'.repeat(64), sourceManuscriptSha256: 'b'.repeat(64), sourceChapterIds: ['ch-1'], sourceBaseRevision: 'manuscript-v1-fixture', objective: 'fixture' };
const result = { title: '测试稿', chapters: [chapter], warnings: ['候选不会自动覆盖工作稿。'], revisionApplied: false, baseRevision: 'manuscript-v1-fixture',
  wholeRevision: { schemaVersion: 'whole-manuscript-quality-1', status: 'no_change', requestSpec, sourceChapters: [chapter], plan: {}, candidateRevision: null,
    actualChanges: [], diff: { changedChapterIds: [], unchangedChapterIds: ['ch-1'], chapters: [] }, reread: {}, unresolvedItems: [], stageReceipts: [], modelCalls: { primaryCalls: 3, formatRepairCalls: 0 },
    adoption: { status: 'not_applied', requiredBaseRevision: 'manuscript-v1-fixture', sourceManuscriptSha256: 'b'.repeat(64), atomicGroups: [] },
    quality: { independentReading: {}, sceneChanges: [], issuePriorities: [], retrieval: { byIssue: {}, suppliedMaterialIds: [], callbackCalls: 0 }, materialUse: [], feasibility: [], unresolved: [], newDraftGuidance: null } } };

test('whole quality request is explicit and retains v1 validation compatibility', () => {
  assert.equal(validateRequest(request()).revisionMode, WHOLE_MANUSCRIPT_QUALITY_MODE);
  assert.equal(validateRequest(request({ revisionMode: WHOLE_MANUSCRIPT_REVISION_MODE })).revisionMode, WHOLE_MANUSCRIPT_REVISION_MODE);
  for (const invalid of [request({ quote: '门开了。' }), request({ quoteSource: { chapterId: 'ch-1', start: 0 } }), request({ existingReviewMode: 'legacy' }), request({ createStateReviewMode: 'legacy' }), request({ revisionMode: 'whole-manuscript-v3' }), request({ kind: 'create' })]) {
    assert.throws(() => validateRequest(invalid));
  }
});

test('workflow router injects production retrieval only into whole quality runtime', async () => {
  const retrieveKnowledge = async () => ({ status: 'uncovered' });
  const queryNarrativeObservations = async () => ({ status: 'uncovered' });
  let qualityArgs, v1Args;
  const router = createWorkflowRouter({ config: {}, retrieveKnowledge, queryNarrativeObservations,
    wholeQualityRunner: async args => { qualityArgs = args; return result; },
    wholeRevisionRunner: async args => { v1Args = args; return result; } });
  assert.equal(await router({ request: request(), artifacts: {}, checkpoint() {}, progress() {} }), result);
  assert.equal(qualityArgs.retrieveKnowledge, retrieveKnowledge);
  assert.equal(qualityArgs.queryNarrativeObservations, queryNarrativeObservations);
  assert.equal(qualityArgs.modelPolicy, WHOLE_QUALITY_MODEL_POLICY);
  assert.equal(await router({ request: request({ revisionMode: WHOLE_MANUSCRIPT_REVISION_MODE }), artifacts: {}, checkpoint() {}, progress() {} }), result);
  assert.equal(v1Args.retrieveKnowledge, undefined, 'v1 receives its unchanged argument shape');
  assert.equal(v1Args.queryNarrativeObservations, undefined, 'v1 does not receive observation recall');
});

test('quality result gate requires exact request/spec mode binding and uses its own assertion', async () => {
  let calls = 0;
  await assertWorkflowResultReady(result, requestSpec, request(), undefined, (value, spec) => { calls++; assert.equal(value, result); assert.equal(spec, requestSpec); });
  assert.equal(calls, 1);
  await assert.rejects(Promise.resolve().then(() => assertWorkflowResultReady(result, { ...requestSpec, revisionMode: WHOLE_MANUSCRIPT_REVISION_MODE }, request(), () => {}, () => {})), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  await assert.rejects(Promise.resolve().then(() => assertWorkflowResultReady(result, requestSpec, request({ revisionMode: WHOLE_MANUSCRIPT_REVISION_MODE }), () => {}, () => {})), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
});

test('TaskService applies the quality model policy and saves only asserted candidates', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'talewick-quality-product-'));
  let asserted = 0, observedPolicy;
  const service = await new TaskService({ runsDir: root, model: { complete: async ({ modelPolicy }) => { observedPolicy = modelPolicy; return '{"ok":true}'; } },
    wholeQualityAssert: (value, spec) => { asserted++; assert.equal(value.wholeRevision.schemaVersion, 'whole-manuscript-quality-1'); assert.equal(spec.revisionMode, WHOLE_MANUSCRIPT_QUALITY_MODE); },
    workflow: async ({ checkpoint, model }) => { await checkpoint('requestSpec', requestSpec); await model.complete({ stage: 'whole-quality:reading', system: 'fixture', user: 'fixture' }); return structuredClone(result); } }).init();
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const created = await service.create(request());
  let task = created;
  for (let index = 0; index < 100 && task.status !== 'completed' && task.status !== 'failed'; index += 1) { await new Promise(resolve => setTimeout(resolve, 10)); task = service.get(created.id); }
  assert.equal(task.status, 'completed'); assert.equal(asserted, 1); assert.equal(observedPolicy, WHOLE_QUALITY_MODEL_POLICY);
  assert.equal(task.revisionMode, WHOLE_MANUSCRIPT_QUALITY_MODE); assert.equal(task.result.review, undefined); assert.equal(task.result.reviewAdjudicationBinding, undefined);
  assert.equal(JSON.parse(await readFile(path.join(root, task.id, 'request.json'), 'utf8')).revisionMode, WHOLE_MANUSCRIPT_QUALITY_MODE);
});
