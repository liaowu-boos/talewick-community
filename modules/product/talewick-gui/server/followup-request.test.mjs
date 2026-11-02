import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { createRuntime } from './index.mjs';
import { TaskService, validateRequest } from './tasks.mjs';
import { assertWorkflowResultReady } from './workflow-result-gate.mjs';
import { createWholeQualityRequestSpec } from '../../../creation/runtime/whole-manuscript-quality.mjs';
import { followupRequest } from './fixtures/followup-request.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bundle = await build({ stdin: { contents: `export { makeWholeRevisionRequest, readRuntimeBinding } from './src/model/runtime.ts';`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'browser', format: 'esm', write: false });
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('strict shared request validators preserve only explicitly supplied components and evidence policy', async () => {
  const body = followupRequest(), original = JSON.stringify(body);
  assert.deepEqual(validateRequest(body), body);
  const spec = createWholeQualityRequestSpec(body);
  assert.deepEqual(spec.writingGoals, body.writingGoals); assert.deepEqual(spec.revisionEvidencePolicy, body.revisionEvidencePolicy);
  let hostCalls = 0;
  await assertWorkflowResultReady({}, spec, body, undefined, () => { hostCalls++; });
  for (const field of ['writingGoals', 'revisionEvidencePolicy']) {
    const changed = structuredClone(spec); delete changed[field];
    assert.throws(() => assertWorkflowResultReady({}, changed, body, undefined, () => { hostCalls++; }), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  }
  assert.equal(hostCalls, 1);
  for (const policy of [null, {}, [], { ...body.revisionEvidencePolicy, mode: 'optional' }, { ...body.revisionEvidencePolicy, schemaVersion: 'future' }, { ...body.revisionEvidencePolicy, passed: true }])
    assert.throws(() => validateRequest({ ...body, revisionEvidencePolicy: policy }), { status: 400 });
  for (const mutate of [
    goal => { goal.componentFallback.enabled = false; },
    goal => { goal.componentFallback = null; },
    goal => { goal.componentFallback.schemaVersion = 'future'; },
    goal => { goal.componentFallback.components = []; },
    goal => { goal.componentFallback.components[0].facet = 'guessed'; },
    goal => { goal.componentFallback.components[0].sourceIds = ['picked-title']; },
    goal => { goal.componentFallback.components[0].requiredTermGroups = [['not-explicitly-declared']]; },
  ]) { const changed = structuredClone(body); mutate(changed.writingGoals.goals[0]); assert.throws(() => validateRequest(changed), { status: 400 }); }
  const wrongMode = { ...body, revisionMode: 'whole-manuscript-v1' }; delete wrongMode.writingGoals;
  assert.throws(() => validateRequest(wrongMode), { status: 400 });
  const old = followupRequest({ enabled: false });
  assert.equal(Object.hasOwn(validateRequest(old), 'revisionEvidencePolicy'), false);
  assert.equal(Object.hasOwn(validateRequest(old).writingGoals.goals[0], 'componentFallback'), false);
  assert.notEqual(createWholeQualityRequestSpec(old).inputFingerprint, spec.inputFingerprint);
  assert.equal(JSON.stringify(body), original);
});

test('new GUI revisions opt in, but stored old requests remain byte-identical and components are never inferred', () => {
  const body = followupRequest(), project = { id: body.projectId, title: body.projectTitle, idea: body.idea, chapters: body.chapters,
    context: body.context, libraryIds: [], attachments: [] }, state = { styles: [], library: [] };
  const read = request => ui.readRuntimeBinding({ request, baseManuscript: { title: body.projectTitle, chapters: body.chapters } }, body.projectId);
  const newOrdinary = ui.makeWholeRevisionRequest(project, state, 'new-ordinary', body.instruction);
  assert.deepEqual(newOrdinary.revisionEvidencePolicy, body.revisionEvidencePolicy); assert.equal(newOrdinary.writingGoals, undefined);
  const old = followupRequest({ enabled: false }), before = JSON.stringify(old);
  const newGoal = ui.makeWholeRevisionRequest(project, state, 'new-goal', body.instruction, old.writingGoals);
  assert.equal(Object.hasOwn(newGoal.writingGoals.goals[0], 'componentFallback'), false);
  assert.deepEqual(read(body).request, body);
  assert.deepEqual(read(old).request, old); assert.equal(JSON.stringify(old), before);
  const invalid = structuredClone(body); invalid.writingGoals.goals[0].componentFallback.components[0].facet = 'guessed';
  assert.equal(read(invalid), undefined);
  assert.equal(read({ ...body, revisionEvidencePolicy: { ...body.revisionEvidencePolicy, extra: true } }), undefined);
});

test('actual HTTP save/restart/resume binds the exact options, rejects changed IDs and keeps historical omission', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'product-followup-http-')), runsDir = path.join(root, 'runs');
  const requests = [], originalFetch = globalThis.fetch; let runtime, base, providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw Error('External network forbidden'); };
  const close = async () => { if (!runtime) return; await runtime.close(); if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve)); runtime = null; };
  t.after(async () => { await close(); globalThis.fetch = originalFetch; });
  const start = async () => {
    runtime = await createRuntime({ config: { runsDir, libraryDir: path.join(root, 'library'), port: 0, engine: 'fixed', apiKey: 'offline-stub', model: 'offline', baseURL: 'http://127.0.0.1:1' },
      model: { complete: async () => { throw Error('No model dispatch expected'); } },
      workflow: async ({ request, checkpoint }) => { requests.push(structuredClone(request)); await checkpoint('requestSpec', createWholeQualityRequestSpec(request));
        throw Error('Offline stop after the immutable request checkpoint'); },
      library: null, publicationFeedback: { close: async () => {} }, full15Adapter: null, independentReviewAdapter: null,
      independentReviewReadingFocus: null, independentReviewHandoff: null, reviewEvidenceAuditAdapter: null });
    await new Promise((resolve,reject) => { runtime.server.once('error',reject); runtime.server.listen(0,'127.0.0.1',resolve); });
    base = `http://127.0.0.1:${runtime.server.address().port}`;
  };
  const api = async (route, body) => { const response = await originalFetch(base + route, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const settle = async id => { for (let n=0;n<1000;n++) { if (!runtime.tasks.busy && runtime.tasks.get(id).status === 'failed') return;
    await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Task did not settle'); };
  await start();
  const body = followupRequest();
  assert.equal((await api('/api/tasks', { ...body, revisionEvidencePolicy: { ...body.revisionEvidencePolicy, extra: true } })).status, 400);
  assert.equal(requests.length, 0);
  const created = await api('/api/tasks', body); assert.equal(created.status, 202); const id = created.body.task.id; await settle(id);
  const dir = path.join(runsDir, id), before = {};
  for (const name of ['request.json','task.json','artifacts.json']) before[name] = await readFile(path.join(dir,name));
  assert.deepEqual(JSON.parse(before['request.json']), body);
  assert.deepEqual(JSON.parse(before['artifacts.json']).requestSpec.revisionEvidencePolicy, body.revisionEvidencePolicy);
  assert.equal((await api('/api/tasks', body)).body.task.id, id); assert.equal(requests.length, 1);
  const changed = structuredClone(body); changed.writingGoals.goals[0].componentFallback.components[0].statement += '修改';
  assert.equal((await api('/api/tasks', changed)).status, 409);
  const stripped = structuredClone(body); delete stripped.revisionEvidencePolicy;
  assert.equal((await api('/api/tasks', stripped)).status, 409);
  await close(); await start();
  assert.equal((await api(`/api/tasks/${id}`)).body.task.status, 'failed'); assert.equal(requests.length, 1);
  for (const [name,bytes] of Object.entries(before)) assert.deepEqual(await readFile(path.join(dir,name)), bytes);
  // Existing resume ignores replacement input and uses only the saved request.
  assert.equal((await api(`/api/tasks/${id}/resume`, changed)).status, 200); await settle(id);
  assert.deepEqual(requests[1], body); assert.deepEqual(await readFile(path.join(dir,'request.json')), before['request.json']);
  const old = followupRequest({ enabled: false, requestId: 'historical' });
  const legacy = await api('/api/tasks', old); await settle(legacy.body.task.id);
  const oldPath = path.join(runsDir,legacy.body.task.id,'request.json'), oldBytes = await readFile(oldPath);
  await close(); await start();
  assert.equal((await api(`/api/tasks/${legacy.body.task.id}/resume`, {})).status, 200); await settle(legacy.body.task.id);
  assert.deepEqual(requests.at(-1), old); assert.deepEqual(await readFile(oldPath),oldBytes);
  for (const field of ['revisionEvidencePolicy','writingGoals']) {
    const tamperRoot = path.join(root,field); await cp(dir,path.join(tamperRoot,id),{recursive:true});
    const edited = structuredClone(body); delete edited[field];
    await writeFile(path.join(tamperRoot,id,'request.json'),JSON.stringify(edited));
    const reader = new TaskService({ runsDir:tamperRoot, model:{}, workflow:async()=>assert.fail('Tampered task executed') });
    await assert.rejects(reader.readTaskDirectory(id), /invalid .* binding/);
  }
  assert.equal(providerCalls, 0);
  if (process.env.PRODUCT_FOLLOWUP_HTTP_PROOF) await writeFile(process.env.PRODUCT_FOLLOWUP_HTTP_PROOF, JSON.stringify({
    status:'passed', scope:'Actual product localhost HTTP and CREATION request-spec validator; workflow stops at saved specification; no model or provider',
    root, taskId:id, savedRequestSHA256:sha(before['request.json']), options:body.revisionEvidencePolicy,
    componentPreserved:true, restartGetBytesUnchanged:true, resumedFromSavedRequest:true, historicalOmissionPreserved:true,
    sameRequestIdConflict:true, tamperedSavedBindingRejected:true, providerCalls,
  },null,2)+'\n',{flag:'wx'});
});
