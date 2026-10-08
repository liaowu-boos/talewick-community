import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskService, projectPartialDraft } from './tasks.mjs';
const plans = Array.from({length:8},(_,i)=>({id:`ch-${i+1}`,title:`第${i+1}章`}));
const artifacts = () => ({plan:{chapters:plans},...Object.fromEntries([...plans].reverse().map(c=>[`draft:${c.id}`,{...c,body:`已存正文 ${c.id}`}]))});
const task = {kind:'create',status:'failed',engine:'fixed'};
test('projection uses plan order, preserves all eight chapters, and isolates returned objects',()=>{
 const a=artifacts(), p=projectPartialDraft(task,a);assert.deepEqual(p.chapters.map(c=>c.id),plans.map(c=>c.id));assert.equal(p.availableChapterCount,8);assert.equal(p.expectedChapterCount,8);assert.equal(p.status,'unreviewed_partial');p.chapters[0].body='changed';assert.equal(a['draft:ch-1'].body,'已存正文 ch-1');assert.equal(task.status,'failed');assert.equal(task.result,undefined);
});
test('missing and damaged chapters are omitted with honest counts; foreign chapters ignored',()=>{
 const a=artifacts();delete a['draft:ch-2'];a['draft:ch-3'].body=' ';a['draft:ch-4'].id='other';a['draft:ch-5'].title='wrong';a['draft:foreign']={id:'foreign',title:'foreign',body:'foreign'};
 const p=projectPartialDraft(task,a);assert.equal(p.availableChapterCount,4);assert.equal(p.expectedChapterCount,8);assert.deepEqual(p.chapters.map(c=>c.id),['ch-1','ch-6','ch-7','ch-8']);
});
test('invalid plans, no drafts, non-create and completed tasks never fabricate a projection',()=>{
 for(const a of [null,[],{}, {plan:{chapters:plans}}, {plan:{chapters:[plans[0],plans[0]]}}, {...artifacts(),agentPlan:null}])assert.equal(projectPartialDraft(task,a),undefined);
 for(const status of ['running','queued','completed','needs_input'])assert.equal(projectPartialDraft({...task,status},artifacts()),undefined);
 assert.equal(projectPartialDraft({...task,kind:'revise'},artifacts()),undefined);assert.equal(projectPartialDraft({...task,result:{}},artifacts()),undefined);
});
test('Agent uses only controlled plan; all recoverable states retain their identity',()=>{
 const a=artifacts();assert.equal(projectPartialDraft({...task,engine:'ai-sdk'},a),undefined);a.agentPlan={plan:{chapters:[plans[7],plans[0]]}};
 for(const status of ['failed','interrupted','cancelled']){const t={...task,status,engine:'ai-sdk'};assert.deepEqual(projectPartialDraft(t,a).chapters.map(c=>c.id),['ch-8','ch-1']);assert.equal(t.status,status);}
});
test('API get/list and disk restart expose saved draft after review failure, without replay or persisted projection',async()=>{
 const runsDir=await mkdtemp(path.join(tmpdir(),'partial-draft-test-'));let modelCalls=0, workflowCalls=0,service;
 try {
  service=await new TaskService({runsDir,model:{complete:async()=>{modelCalls++;throw Error('forbidden');}},workflow:async({checkpoint})=>{workflowCalls++;for(const [k,v]of Object.entries(artifacts()))await checkpoint(k,v);throw Error('review failed');}}).init();
  const created=await service.create({projectId:'test',requestId:'request',kind:'create',idea:'fixture',baseRevision:'base'});
  for(let i=0;i<200&&service.get(created.id).status!=='failed';i++)await new Promise(r=>setTimeout(r,10));
  const before=service.get(created.id);assert.equal(before.status,'failed');assert.equal(before.partialDraft.availableChapterCount,8);assert.equal(before.result,undefined);assert.deepEqual(service.list('test')[0],before);
  await service.close(); // Wait for the final task write before comparing disk snapshots.
  const saved=await readFile(path.join(runsDir,created.id,'task.json'),'utf8');assert.equal(JSON.parse(saved).partialDraft,undefined);
  service=await new TaskService({runsDir,model:{complete:async()=>{throw Error('forbidden');}},workflow:async()=>{throw Error('replay forbidden');}}).init();
  assert.deepEqual(service.get(created.id),before);assert.equal(await readFile(path.join(runsDir,created.id,'task.json'),'utf8'),saved);assert.equal(modelCalls,0);assert.equal(workflowCalls,1);
 }finally{await service?.close();await rm(runsDir,{recursive:true,force:true});}
});
