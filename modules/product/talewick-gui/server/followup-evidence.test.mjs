import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from './index.mjs';
import { CandidateRecheckService,PRODUCT_RECHECK_VERSION } from './candidate-rechecks.mjs';
import { projectRevisionEvidenceFailure } from './revision-evidence-failure.mjs';
import { revisionEvidenceAllowsAdoption } from '../src/model/revision-evidence-gate.mjs';
import { followupEvidenceFixture } from './fixtures/followup-evidence.mjs';
import { inspectStoredWholeQualityPlanFactsFailure,assertWholeQualityResult } from '../../../creation/runtime/whole-manuscript-quality.mjs';
import { manuscriptFingerprint } from '../../../validation/runtime/checks.mjs';

const bundle = await build({ stdin:{contents:`export {RevisionEvidenceDetails,RevisionEvidenceFailureDetails} from './src/features/RevisionEvidenceDetails.tsx';
export {readRuntimeTask} from './src/model/runtime.ts';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';`,
  resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'tsx'},bundle:true,platform:'node',format:'esm',write:false,
  banner:{js:`import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(fileURLToPath(import.meta.url))});`} });
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const render = (value,failed = false) => ui.renderToStaticMarkup(ui.createElement(failed ? ui.RevisionEvidenceFailureDetails : ui.RevisionEvidenceDetails,{value}));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('actual CREATION/VALIDATION results remain collapsed model checks; broken, no-change and missing never imply approval', async () => {
  for (const options of [{},{sceneStatus:'broken'},{preserve:true}]) {
    const f = followupEvidenceFixture(options), result = await f.run(), whole = result.wholeRevision;
    assertWholeQualityResult(result,whole.requestSpec);
    const evidence = whole.quality.revisionEvidence, before = JSON.stringify(result), html = render(evidence);
    for (const label of ['方案事实核对','场景复读','模型判断仍可能出错','五类前提','不代表事实正确']) assert.ok(html.includes(label),label);
    assert.ok(!html.includes('<details open')); assert.equal(JSON.stringify(result),before);
    assert.equal(evidence.planFacts.bindings.sourceTaskId,`whole-quality:${whole.requestSpec.inputFingerprint}`);
    assert.equal(evidence.sceneDependencies.bindings.candidateManuscriptSha256,manuscriptFingerprint(result.chapters));
    if (options.sceneStatus === 'broken') {
      assert.match(html,/场景衔接存在问题/); assert.match(html,/发现衔接问题/);
      assert.equal(whole.adoption.atomicGroups[0].recommendation,'not_recommended');
      assert.equal(revisionEvidenceAllowsAdoption({whole,policy:f.request.revisionEvidencePolicy}),false);
    } else if (options.preserve) {
      assert.match(html,/正文未改动，未发起场景复读/); assert.ok(!f.calls.includes('whole-quality:scene-check'));
    } else {
      assert.equal(revisionEvidenceAllowsAdoption({whole,policy:f.request.revisionEvidencePolicy}),true);
      // The auxiliary gate follows CREATION's scene grouping for linked plan IDs;
      // the full assertion is still required on server authorization.
      const linked = structuredClone(whole);linked.candidateRevision.replacements[0].appliedPlanItemIds.push('plan-linked');
      assert.equal(revisionEvidenceAllowsAdoption({whole:linked,policy:f.request.revisionEvidencePolicy,planItemIds:['plan-linked']}),true);
      assert.equal(revisionEvidenceAllowsAdoption({whole:linked,policy:f.request.revisionEvidencePolicy,planItemIds:['unbound-plan']}),false);
      linked.quality.revisionEvidence.blockedPlanItemIds.push('plan-1');
      assert.equal(revisionEvidenceAllowsAdoption({whole:linked,policy:f.request.revisionEvidencePolicy,planItemIds:['plan-linked']}),false);
      const forged = structuredClone(whole);delete forged.quality.revisionEvidence;
      assert.equal(revisionEvidenceAllowsAdoption({whole:forged,policy:f.request.revisionEvidencePolicy}),false);
    }
  }
  assert.match(render(undefined),/未进行新核对/);
  assert.match(render({schemaVersion:'whole-quality-revision-evidence-1'}),/核对记录不完整/);
});

test('a successful cross recheck cannot authorize a scene-blocked candidate; prior omission stays compatible', async () => {
  const f = followupEvidenceFixture({sceneStatus:'broken'}), result = await f.run();
  const task = {id:'source-evidence',projectId:f.request.projectId,requestId:f.request.requestId,status:'completed',revisionMode:f.request.revisionMode,result};
  let adoptionCalls = 0;
  const tasks = {get:() => task,requests:new Map([[task.id,f.request]])};
  const service = new CandidateRecheckService({rootDir:'unused',tasks,model:{complete:async()=>assert.fail('No model expected')},
    checkAdoption:async() => {adoptionCalls++;return {eligible:true};}});
  const record = {id:'recheck',projectId:task.projectId,sourceTaskId:task.id,status:'reviewed_no_reported_conflict',checkerVersion:PRODUCT_RECHECK_VERSION,
    candidateSha256:manuscriptFingerprint(result.chapters),result:{binding:{sourceTaskId:task.id,candidateSHA:manuscriptFingerprint(result.chapters)}}};
  service.records.set(record.id,record);
  assert.equal(service.project(record).gate.reason,'revision_evidence_blocked');
  await assert.rejects(service.authorize(record.id,{projectId:task.projectId,sourceTaskId:task.id}),{code:'REVISION_EVIDENCE_BLOCKED'});
  assert.equal(adoptionCalls,0);
  assert.equal(revisionEvidenceAllowsAdoption({whole:{requestSpec:{}}}),true);
});

test('failed facts use CREATION strict replay and exact assertions; invalid or missing bindings expose no details', async () => {
  const f = followupEvidenceFixture({blockedPlan:true});
  await assert.rejects(f.run(),{code:'WHOLE_QUALITY_PLAN_FACTS_UNVERIFIED'});
  const task = {id:'source-failure',projectId:f.request.projectId,requestId:f.request.requestId,kind:f.request.kind,
    revisionMode:f.request.revisionMode,baseRevision:f.request.baseRevision,status:'failed',failure:{recoverable:false}};
  const before = JSON.stringify({request:f.request,artifacts:f.artifacts}), count = f.calls.length;
  const project = artifacts => projectRevisionEvidenceFailure(task,f.request,artifacts,inspectStoredWholeQualityPlanFactsFailure);
  const view = await project(f.artifacts);assert.ok(view);
  assert.equal(view.status,'blocked');assert.equal(view.automaticAdoption,false);
  const html = render(view,true);
  for (const label of ['未生成完成结果','原断言','她一直解释。','她关了门，没有再解释。','存在反证','修正前的初次核对']) assert.ok(html.includes(label),label);
  assert.ok(!html.includes('<details open'));assert.equal(f.calls.length,count);
  assert.equal(JSON.stringify({request:f.request,artifacts:f.artifacts}),before);
  const publicText = JSON.stringify(view);
  for (const key of ['rawResponse','stageReceipts','responseBindings','responseContract','referenceMaterials','system','input']) assert.ok(!publicText.includes(`"${key}"`),key);
  for (const mutate of [
    a => {a.requestSpec.sourceManuscriptSha256 = '0'.repeat(64);},
    a => {a['whole-quality:plan-facts:initial:primary-response'].rawResponse += ' ';},
    a => {delete a['whole-quality:plan-facts:recheck:receipt'];},
  ]) {const altered = structuredClone(f.artifacts);mutate(altered);assert.equal(await project(altered),undefined);}
  assert.equal(await projectRevisionEvidenceFailure({...task,status:'completed'},f.request,f.artifacts,inspectStoredWholeQualityPlanFactsFailure),undefined);
  assert.ok(!f.calls.some(stage=>['whole-quality:feasibility','whole-quality:revision'].includes(stage)));
  assert.equal(f.calls.filter(stage=>stage==='whole-quality:plan-correction').length,1);
});

test('HTTP failed task GET/list/restart expose verified details without changing source bytes or enabling retry', {timeout:30000}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),'product-followup-failure-')),runsDir = path.join(root,'runs');
  const f = followupEvidenceFixture({blockedPlan:true,requestId:'failed-plan-http'});
  const originalFetch = globalThis.fetch;let runtime,base,providerCalls = 0;
  globalThis.fetch = async () => {providerCalls++;throw Error('External network forbidden');};
  const close = async () => {if (!runtime) return;await runtime.close();if(runtime.server.listening) await new Promise(resolve=>runtime.server.close(resolve));runtime=null;};
  t.after(async()=>{await close();globalThis.fetch=originalFetch;});
  const start = async () => {
    runtime = await createRuntime({config:{runsDir,libraryDir:path.join(root,'library'),port:0,engine:'fixed',apiKey:'offline',model:'offline',baseURL:'http://127.0.0.1:1'},
      model:f.model,workflow:f.workflow,library:null,publicationFeedback:{close:async()=>{}},full15Adapter:null,independentReviewAdapter:null,
      independentReviewReadingFocus:null,independentReviewHandoff:null,reviewEvidenceAuditAdapter:null});
    await new Promise((resolve,reject)=>{runtime.server.once('error',reject);runtime.server.listen(0,'127.0.0.1',resolve);});
    base=`http://127.0.0.1:${runtime.server.address().port}`;
  };
  const api = async (route,body) => {const response=await originalFetch(base+route,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};};
  await start();const created=await api('/api/tasks',f.request);assert.equal(created.status,202);const id=created.body.task.id;
  for(let n=0;n<1000;n++){if(!runtime.tasks.busy&&runtime.tasks.get(id).status==='failed')break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(runtime.tasks.get(id).status,'failed');
  const folder=path.join(runsDir,id),before={};for(const name of ['task.json','request.json','artifacts.json'])before[name]=await readFile(path.join(folder,name));
  const count=f.calls.length,first=(await api(`/api/tasks/${id}`)).body.task;
  assert.ok(first.revisionEvidenceFailure);assert.equal(first.result,undefined);assert.equal(first.failure.recoverable,false);
  assert.ok(ui.readRuntimeTask(first).revisionEvidenceFailure);
  assert.equal(Object.hasOwn(JSON.parse(before['task.json']),'revisionEvidenceFailure'),false);
  const listed=await api(`/api/tasks?projectId=${f.request.projectId}`);
  assert.deepEqual(listed.body.tasks.find(item=>item.id===id).revisionEvidenceFailure,first.revisionEvidenceFailure);
  assert.equal((await api(`/api/tasks/${id}/resume`,{})).status,409);
  await close();await start();
  assert.deepEqual((await api(`/api/tasks/${id}`)).body.task.revisionEvidenceFailure,first.revisionEvidenceFailure);
  assert.equal(f.calls.length,count);assert.equal(providerCalls,0);
  for(const [name,bytes] of Object.entries(before))assert.deepEqual(await readFile(path.join(folder,name)),bytes);
  if(process.env.PRODUCT_FOLLOWUP_FAILURE_PROOF)await writeFile(process.env.PRODUCT_FOLLOWUP_FAILURE_PROOF,JSON.stringify({status:'passed',root,taskId:id,
    scope:'Real localhost product API + actual CREATION workflow/inspector + VALIDATION checks; synthetic in-process responses only',providerCalls,
    requestSHA256:hash(before['request.json']),taskSHA256:hash(before['task.json']),artifactsSHA256:hash(before['artifacts.json']),
    failedStatusPreserved:true,noResult:true,readOnlyGetListRestart:true,resumeRejected:true,originalBytesUnchanged:true,modelStages:f.calls},null,2)+'\n',{flag:'wx'});
});
