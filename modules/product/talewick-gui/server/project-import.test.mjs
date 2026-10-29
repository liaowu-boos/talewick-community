import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRuntime } from './index.mjs';
import { projectImportSnapshot, listImportableProjects } from './project-import.mjs';
import { createProjectImportFixture, installProjectImportFixture, saveProjectImportFixture } from './fixtures/project-import.mjs';

function memoryTasks(fixture, options) {
  const tasks = {tasks:new Map(),requests:new Map(),artifacts:new Map(),
    list(projectId) { return [...this.tasks.values()].filter(t=>!projectId||t.projectId===projectId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(t=>structuredClone(t)); }};
  installProjectImportFixture(tasks,fixture,options);return tasks;
}

test('real GET restores saved whole source and candidate separately while preserving failed create bytes and making no model request', async t => {
  const fixture=await createProjectImportFixture(),runsDir=await mkdtemp(path.join(os.tmpdir(),'talewick-import-http-'));
  await saveProjectImportFixture(runsDir,fixture);
  const failedFile=path.join(runsDir,fixture.failed.id,'task.json'),before=await readFile(failedFile,'utf8');let modelCalls=0;
  const runtime=await createRuntime({config:{runsDir,apiKey:'synthetic',baseURL:'http://127.0.0.1:1',model:'synthetic',port:0},
    model:{complete:async()=>{modelCalls++;assert.fail('GET must not dispatch any model request');}},
    workflow:async()=>assert.fail('GET must not start a workflow'),library:null,full15Adapter:null,independentReviewAdapter:null,
    publicationFeedback:{list:async()=>[],close:async()=>{}}});
  runtime.server.listen(0,'127.0.0.1');await once(runtime.server,'listening');
  t.after(async()=>{runtime.server.closeAllConnections();await new Promise(resolve=>runtime.server.close(resolve));await runtime.close();await rm(runsDir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${runtime.server.address().port}`;
  const listing=await (await fetch(`${url}/api/projects`)).json();
  assert.deepEqual(listing.projects,[{id:fixture.task.projectId,title:fixture.request.projectTitle,updatedAt:fixture.task.updatedAt,
    baselineProvenance:'whole_revision_source',sourceTaskId:fixture.task.id,baselineQualityCheckStatus:'incomplete'}]);
  const response=await fetch(`${url}/api/projects/${fixture.task.projectId}/import-snapshot`),snapshot=await response.json();
  assert.equal(response.status,200);assert.equal(snapshot.schemaVersion,'talewick-project-import-snapshot-2');
  assert.equal(snapshot.baseline,null);assert.equal(snapshot.baselineRequest,null);
  assert.equal(snapshot.baselineManuscript.provenance,'whole_revision_source');assert.equal(snapshot.baselineManuscript.qualityCheckStatus,'incomplete');
  assert.deepEqual(snapshot.baselineManuscript.chapters,fixture.request.chapters);
  assert.deepEqual(snapshot.revision.result.chapters,fixture.task.result.chapters);
  assert.notDeepEqual(snapshot.baselineManuscript.chapters,snapshot.revision.result.chapters);
  assert.equal(snapshot.history.find(task=>task.id===fixture.failed.id).status,'failed');
  assert.equal(snapshot.history.filter(task=>task.kind==='create').length,1);
  assert.equal(snapshot.revisionRequestSpec.sourceBaseRevision,snapshot.baselineManuscript.baseRevision);
  runtime.tasks.artifacts.get(fixture.task.id).requestSpec.sourceBaseRevision='stale';
  assert.equal((await fetch(`${url}/api/projects/${fixture.task.projectId}/import-snapshot`)).status,409);
  assert.deepEqual((await (await fetch(`${url}/api/projects`)).json()).projects,[]);
  assert.equal(await readFile(failedFile,'utf8'),before);assert.equal(modelCalls,0);
});

test('external manuscript without a create task and no-change whole result can be restored without inventing task history', async () => {
  for(const preserve of [false,true]) {
    const fixture=await createProjectImportFixture({projectId:'external-manuscript',preserve}),tasks=memoryTasks(fixture,{includeFailedCreate:false});
    const snapshot=projectImportSnapshot(tasks,fixture.task.projectId);
    assert.equal(snapshot.history.length,1);assert.equal(snapshot.history[0].kind,'revise');assert.equal(snapshot.baseline,null);
    assert.deepEqual(snapshot.baselineManuscript.chapters,fixture.request.chapters);
    assert.equal(snapshot.revision.result.wholeRevision.status,preserve?'no_change':'candidate_ready');
    assert.equal(listImportableProjects(tasks)[0].baselineProvenance,'whole_revision_source');
  }
});

test('fallback rejects mismatched saved identity, original text/title/version, missing requestSpec and altered result', async () => {
  const fixture=await createProjectImportFixture();
  for(const mutate of [
    t=>{t.requests.get(fixture.task.id).requestId='other-request';},
    t=>{t.requests.get(fixture.task.id).projectId='other-project';},
    t=>{t.requests.get(fixture.task.id).projectTitle+='改题';},
    t=>{t.requests.get(fixture.task.id).chapters[0].body+='篡改';},
    t=>{t.tasks.get(fixture.task.id).baseRevision='stale';},
    t=>{t.tasks.get(fixture.task.id).result.wholeRevision.sourceChapters[0].body+='篡改';},
    t=>{t.tasks.get(fixture.task.id).result.chapters[0].body+='篡改';},
    t=>{t.tasks.get(fixture.task.id).result.title+='改题';},
    t=>{t.tasks.get(fixture.task.id).result.wholeRevision.requestSpec.inputFingerprint='0'.repeat(64);},
    t=>{t.artifacts.get(fixture.task.id).requestSpec.objective+='篡改';},
    t=>{delete t.artifacts.get(fixture.task.id).requestSpec;},
    t=>{t.requests.delete(fixture.task.id);},
  ]) {
    const tasks=memoryTasks(fixture);mutate(tasks);
    assert.throws(()=>projectImportSnapshot(tasks,fixture.task.projectId),{status:409});
    assert.deepEqual(listImportableProjects(tasks),[]);
    assert.equal(tasks.tasks.get(fixture.failed.id).status,'failed');
  }
  for(const status of ['failed','running','interrupted']) {
    const tasks=memoryTasks(fixture);tasks.tasks.get(fixture.task.id).status=status;
    assert.throws(()=>projectImportSnapshot(tasks,fixture.task.projectId),{status:404});
  }
});

test('completed-create import retains v1 response and precedence over whole-source fallback', async () => {
  const fixture=await createProjectImportFixture(),tasks=memoryTasks(fixture);
  const baseline={...fixture.failed,id:'99999999-9999-4999-8999-999999999999',requestId:'fixture-completed-create',status:'completed',
    result:{title:fixture.request.projectTitle,chapters:structuredClone(fixture.request.chapters),review:{summary:'合成已完成创作。'}}};
  tasks.tasks.set(baseline.id,baseline);tasks.requests.set(baseline.id,{projectId:baseline.projectId,requestId:baseline.requestId,kind:'create',idea:'合成旧版'});
  const snapshot=projectImportSnapshot(tasks,baseline.projectId);
  assert.equal(snapshot.schemaVersion,'talewick-project-import-snapshot-1');assert.equal(snapshot.baseline.id,baseline.id);
  assert.equal(snapshot.baselineManuscript,undefined);assert.equal(snapshot.revision.id,fixture.task.id);
  assert.equal(snapshot.history.find(task=>task.id===fixture.failed.id).status,'failed');
  assert.deepEqual(listImportableProjects(tasks),[{id:baseline.projectId,title:baseline.result.title,updatedAt:fixture.task.updatedAt,baselineTaskId:baseline.id}]);
});
