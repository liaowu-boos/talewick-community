import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { TaskService, validateRequest } from './tasks.mjs';
import { createRuntime } from './index.mjs';
import { createWorkflowRouter } from './workflow-engine.mjs';
import { assertWorkflowResultReady } from './workflow-result-gate.mjs';
import { productManuscriptRevision } from './full15-service.mjs';
import { fixture } from '../../../creation/runtime/goal-opportunity-fixtures.mjs';
import { runWholeManuscriptQualityRevision } from '../../../creation/runtime/whole-manuscript-quality.mjs';
import { DEEP_REFERENCE_AVAILABILITY_POLICY_VERSION, validateDeepReferenceAvailabilityPolicy } from '../../../creation/runtime/deep-reference-availability.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const policy = () => validateDeepReferenceAvailabilityPolicy({ schemaVersion: DEEP_REFERENCE_AVAILABILITY_POLICY_VERSION, mode: 'require_available' });
function input() {
  const f = fixture({ preserve: true });
  return { ...f.request, projectId: 'reference-policy-fixture', requestId: 'reference-policy-r2', idea: '离线资料就绪测试',
    baseRevision: productManuscriptRevision(f.request.projectTitle, f.request.chapters), deepReferenceAvailabilityPolicy: policy() };
}
const bundled = await build({ stdin: { contents: `export {makeWholeRevisionRequest,readRuntimeBinding} from './src/model/runtime.ts';
export {projectFromImportSnapshot} from './src/model/project-import.ts';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'browser', format: 'esm', write: false });
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('API delegates exact policy validation to CREATION and binds the result gate without upgrading omission', async () => {
  const body = input(); assert.deepEqual(validateRequest(body).deepReferenceAvailabilityPolicy, policy());
  const old = structuredClone(body); delete old.deepReferenceAvailabilityPolicy;
  assert.equal(Object.hasOwn(validateRequest(old), 'deepReferenceAvailabilityPolicy'), false);
  for (const value of [null, {}, [], { ...policy(), mode: 'optional' }, { ...policy(), schemaVersion: 'future' }, { ...policy(), extra: true }])
    assert.throws(() => validateRequest({ ...body, deepReferenceAvailabilityPolicy: value }), { status: 400, code: 'WHOLE_QUALITY_REFERENCE_POLICY' });
  for (const revisionMode of [undefined, 'whole-manuscript-v1']) {
    const other = { ...body, revisionMode }; delete other.writingGoals; delete other.goalImprovementPolicy;
    assert.throws(() => validateRequest(other), { status: 400, code: 'WHOLE_QUALITY_REFERENCE_POLICY' });
  }
  const spec = { revisionMode: body.revisionMode, writingGoals: body.writingGoals, goalImprovementPolicy: body.goalImprovementPolicy, deepReferenceAvailabilityPolicy: policy() };
  let checked = 0; const host = () => { checked++; };
  await assertWorkflowResultReady({}, spec, body, null, host);
  assert.throws(() => assertWorkflowResultReady({}, { ...spec, deepReferenceAvailabilityPolicy: undefined }, body, null, host), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  assert.throws(() => assertWorkflowResultReady({}, spec, old, null, host), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  assert.equal(checked, 1);
});

test('GUI new goal request opts in; ordinary requests and historical persistence stay omitted', () => {
  const body = input(), project = { id: body.projectId, title: body.projectTitle, idea: body.idea, chapters: body.chapters,
    context: { character: '', world: '', plot: '', theme: '' }, libraryIds: [], attachments: [] };
  const state = { styles: [], library: [] }, original = JSON.stringify({ project, state });
  const created = ui.makeWholeRevisionRequest(project, state, 'new-goal', body.instruction, body.writingGoals, body.goalImprovementPolicy);
  assert.deepEqual(created.deepReferenceAvailabilityPolicy, policy()); assert.deepEqual(created.writingGoals, body.writingGoals);
  assert.equal(JSON.stringify({ project, state }), original);
  const ordinary = ui.makeWholeRevisionRequest(project, state, 'ordinary', body.instruction);
  assert.equal(Object.hasOwn(ordinary, 'deepReferenceAvailabilityPolicy'), false);
  const read = request => ui.readRuntimeBinding({ request, baseManuscript: { title: body.projectTitle, chapters: body.chapters } }, body.projectId);
  assert.deepEqual(read(created).request.deepReferenceAvailabilityPolicy, policy());
  const historical = { ...created }; delete historical.deepReferenceAvailabilityPolicy; const before = JSON.stringify(historical);
  assert.equal(Object.hasOwn(read(historical).request, 'deepReferenceAvailabilityPolicy'), false);
  assert.equal(JSON.stringify(historical), before);
  assert.equal(read({ ...created, deepReferenceAvailabilityPolicy: { ...policy(), extra: true } }), undefined);
});

function uncovered(request) {
  const normalized = { problem: { ...structuredClone(request.problem), searchTerms: [...new Set(request.problem.searchTerms.map(x => x.trim()).filter(Boolean))],
    requiredTermGroups: (request.problem.requiredTermGroups ?? []).map(group => [...new Set(group)]) }, dimensions: structuredClone(request.dimensions),
    sourceIds: request.sourceIds ?? null, limit: request.limit, maxFunctionsPerResult: request.maxFunctionsPerResult, maxEvidenceRefsPerResult: request.maxEvidenceRefsPerResult };
  const installId = 'offline-install';
  return { schemaVersion: 'analysis99-problem-query-2', queryId: `deepref-query-${sha(`${JSON.stringify({ installId, request: normalized }, null, 2)}\n`)}`,
    installId, request: normalized, status: 'uncovered', resultCount: 0, limits: {}, boundary: 'Offline empty result is not adoption.',
    retrievalIsUse: false, requiresExplicitAdoption: true, results: [] };
}

test('real localhost API + CREATION: policy persists, data failure resumes with unchanged reading/cross and genuine uncovered completes', { timeout: 45000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'talewick-reference-policy-')), runsDir = path.join(root, 'runs');
  const f = fixture({ preserve: true }), calls = [], body = input();
  let runtime, base, dataReady = false, queries = 0, pauseLegacyPlan = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail('External fetch forbidden'); };
  const close = async () => { if (!runtime) return; await runtime.close(); if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve)); runtime = null; };
  t.after(async () => { await close(); globalThis.fetch = originalFetch; });
  const model = { complete: async args => {
    calls.push(args.stage);
    if (pauseLegacyPlan && args.stage === 'whole-quality:plan') { pauseLegacyPlan = false; throw Error('OFFLINE_LEGACY_PLAN_PAUSE'); }
    if (args.stage.startsWith('fixture-cross:')) return JSON.stringify({ stage: args.stage, immutable: true });
    const result = JSON.parse(await f.model.complete(args));
    if (args.stage === 'whole-quality:reread') result.crossChapterChecks = [];
    return JSON.stringify(result);
  } };
  const crossStages = ['fixture-cross:extract', 'fixture-cross:adjudicate'];
  const reviewCrossChapter = async ({ manuscript, modelPolicy, model: activeModel, artifacts }) => {
    for (const stage of crossStages) {
      const expected = JSON.stringify({ stage, immutable: true });
      if (artifacts.store[stage]) assert.deepEqual(artifacts.store[stage], { rawResponse: expected, sha256: sha(expected) });
      else {
        const rawResponse = await activeModel.complete({ stage }); assert.equal(rawResponse, expected);
        await artifacts.checkpoint(stage, { rawResponse, sha256: sha(rawResponse) });
      }
    }
    return { schemaVersion: 'cross-chapter-review-result-1', modelPolicy, manuscriptSha256: sha(JSON.stringify(manuscript.chapters)),
      checkedChapterIds: manuscript.chapters.map(x => x.id), findings: [], stageReceipts: crossStages.map(stage => ({ stage,
        primaryResponseSha256: artifacts.store[stage]?.sha256 ?? sha(JSON.stringify({ stage, immutable: true })) })) };
  };
  const workflow = createWorkflowRouter({ config: { engine: 'fixed' },
    queryDeepReferences: async request => { queries++; if (!dataReady) throw Object.assign(new Error('private source status.json is cloud-only'), { code: 'INPUT_DATALESS' }); return uncovered(request); },
    wholeQualityRunner: args => runWholeManuscriptQualityRevision({ ...args, reviewCrossChapter, request: { ...args.request,
      crossChapterReview: { enabled: true, contractVersion: 'cross-chapter-review-result-1', integrationVersion: 'whole-quality-cross-chapter-integration-1', modelPolicy: 'offline-cross-policy' } } }),
  });
  const start = async () => {
    runtime = await createRuntime({ config: { runsDir, libraryDir: path.join(root, 'library'), port: 0, engine: 'fixed', apiKey: 'offline-stub', model: 'offline', baseURL: 'http://127.0.0.1:1' },
      workflow, model, library: null, publicationFeedback: { close: async () => {} }, full15Adapter: null, independentReviewAdapter: null,
      independentReviewReadingFocus: null, independentReviewHandoff: null, reviewEvidenceAuditAdapter: null });
    await new Promise((resolve,reject) => { runtime.server.once('error',reject); runtime.server.listen(0,'127.0.0.1',resolve); });
    base = `http://127.0.0.1:${runtime.server.address().port}`;
  };
  const api = async (route, payload) => { const res = await originalFetch(base + route, payload === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); return { status: res.status, body: await res.json() }; };
  const settled = async id => { for (let n = 0; n < 1000; n++) {
    if (!runtime.tasks.busy && ['failed','completed'].includes(runtime.tasks.get(id).status)) return runtime.tasks.get(id);
    await new Promise(resolve => setTimeout(resolve, 5));
  } assert.fail('Task did not settle'); };
  await start();
  const invalid = await api('/api/tasks', { ...body, deepReferenceAvailabilityPolicy: { ...policy(), extra: true } });
  assert.equal(invalid.status, 400); assert.equal(queries, 0); assert.deepEqual(calls, []);
  const created = await api('/api/tasks', body); assert.equal(created.status, 202); const id = created.body.task.id;
  const failed = await settled(id); assert.equal(failed.status, 'failed'); assert.equal(failed.failure.kind, 'reference_unavailable');
  assert.equal(failed.failure.recoverable, true); assert.deepEqual(calls, ['whole-quality:reading', ...crossStages]); assert.equal(queries, 1);
  const dir = path.join(runsDir, id), saved = JSON.parse(await readFile(path.join(dir,'artifacts.json')));
  assert.deepEqual(saved.requestSpec.deepReferenceAvailabilityPolicy, policy());
  const failureKey = Object.keys(saved).find(key => key.includes(':availability-attempt:'));
  assert.equal(saved[failureKey].outcome, 'unavailable'); assert.equal(saved[failureKey].item.result.packet.deepReference.error.diagnostic.causeCode, 'INPUT_DATALESS');
  assert.ok(!saved['whole-quality:retrieval:bundle']); assert.ok(!Object.keys(saved).some(k => k.startsWith('whole-quality:applicability:')));
  const taskBytes = await readFile(path.join(dir,'task.json')), requestBytes = await readFile(path.join(dir,'request.json'));
  const request = JSON.parse(requestBytes); assert.deepEqual(request.deepReferenceAvailabilityPolicy, policy());
  const stripped = { ...body }; delete stripped.deepReferenceAvailabilityPolicy;
  assert.equal((await api('/api/tasks', stripped)).status, 409);
  await close(); calls.length = 0; await start();
  assert.equal((await api(`/api/tasks/${id}`)).body.task.failure.kind, 'reference_unavailable');
  assert.deepEqual(await readFile(path.join(dir,'task.json')), taskBytes); assert.equal(queries, 1); assert.deepEqual(calls, []);
  dataReady = true;
  const resume = await api(`/api/tasks/${id}/resume`, {}); assert.equal(resume.status, 200); assert.equal(resume.body.task.id, id);
  const completed = await settled(id); assert.equal(completed.status, 'completed', JSON.stringify(completed.failure));
  assert.equal(queries, 2); assert.ok(!calls.some(stage => stage === 'whole-quality:reading' || crossStages.includes(stage)));
  assert.deepEqual(completed.result.chapters, request.chapters); assert.equal(completed.result.revisionApplied, false);
  const after = JSON.parse(await readFile(path.join(dir,'artifacts.json')));
  for (const [key,value] of Object.entries(saved)) assert.deepEqual(after[key],value,key);
  assert.deepEqual(await readFile(path.join(dir,'request.json')), requestBytes);
  assert.equal(Object.keys(after).filter(k => k.includes(':availability-attempt:')).length, 2);
  assert.equal((await api(`/api/tasks/${id}/resume`, {})).status, 409);
  const snapshot = await api(`/api/projects/${body.projectId}/import-snapshot`); assert.equal(snapshot.status, 200);
  const imported = ui.projectFromImportSnapshot(snapshot.body, body.projectId);
  assert.deepEqual(imported.runtime.request.deepReferenceAvailabilityPolicy, policy());
  const badSnapshot = structuredClone(snapshot.body); delete badSnapshot.revisionRequest.deepReferenceAvailabilityPolicy;
  assert.throws(() => ui.projectFromImportSnapshot(badSnapshot, body.projectId));
  const tamperRoot = path.join(root,'tamper'); await cp(dir,path.join(tamperRoot,id),{recursive:true});
  const changed = { ...request }; delete changed.deepReferenceAvailabilityPolicy;
  await writeFile(path.join(tamperRoot,id,'request.json'),JSON.stringify(changed));
  const reader = new TaskService({ runsDir: tamperRoot, model, workflow, engine: 'fixed' });
  await assert.rejects(reader.readTaskDirectory(id), /invalid deep reference availability policy binding/);
  // Omitted old requests remain readable and executable without adding the new policy.
  const oldBody = { ...stripped, projectId: 'reference-legacy-fixture', requestId: 'legacy-request' };
  pauseLegacyPlan = true;
  const oldCreated = await api('/api/tasks', oldBody); assert.equal(oldCreated.status, 202);
  const oldId = oldCreated.body.task.id; assert.equal((await settled(oldId)).status, 'failed');
  const oldFile = path.join(runsDir,oldId,'request.json'), oldBytes = await readFile(oldFile);
  assert.equal(Object.hasOwn(JSON.parse(oldBytes),'deepReferenceAvailabilityPolicy'),false);
  const oldArtifacts = JSON.parse(await readFile(path.join(runsDir,oldId,'artifacts.json')));
  assert.equal(Object.hasOwn(oldArtifacts.requestSpec,'deepReferenceAvailabilityPolicy'),false);
  await close(); const count = queries; calls.length = 0; await start();
  assert.equal((await api(`/api/tasks/${oldId}`)).body.task.status,'failed');
  assert.deepEqual(await readFile(oldFile),oldBytes); assert.equal(queries,count); assert.deepEqual(calls,[]);
  assert.equal((await api(`/api/tasks/${oldId}/resume`,{})).status,200);
  assert.equal((await settled(oldId)).status,'completed');
  assert.deepEqual(await readFile(oldFile),oldBytes); assert.equal(queries,count);
  assert.ok(!calls.some(stage => stage === 'whole-quality:reading' || crossStages.includes(stage)));
  assert.equal(Object.hasOwn(runtime.tasks.artifacts.get(oldId).requestSpec,'deepReferenceAvailabilityPolicy'),false);
  if (process.env.PRODUCT_REFERENCE_POLICY_PROOF) await writeFile(process.env.PRODUCT_REFERENCE_POLICY_PROOF,JSON.stringify({
    status:'passed', root, taskId:id, policy:policy(), providerCalls:0, initialFailure:failed.failure,
    scope:'Actual product HTTP/workflow router/CREATION runtime; offline model, DATA and cross-review fixtures, no cloud-file access',
    failureCause:'INPUT_DATALESS', resumeHTTP:resume.status, resultStatus:completed.status, revisionApplied:false,
    readingModelCalls:1, crossModelCalls:2, readingCrossCallsOnResume:0, requiredTaskDataQueries:2,
    originalArtifactsUnchanged:true, failureAttemptPreserved:true, requestSHA256:sha(requestBytes),
    preservedArtifacts:Object.fromEntries(Object.entries(saved).map(([key,value])=>[key,sha(JSON.stringify(value))])),
    noMatchAccepted:true, policyTamperRejected:true, sourceImportPolicyPreserved:true, legacyRequestBytesUnchanged:true, legacyResumeNeverAddsPolicy:true, restartGETRedispatches:0,
  },null,2)+'\n',{flag:'wx'});
});
