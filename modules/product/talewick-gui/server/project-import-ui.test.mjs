import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { projectImportSnapshot } from './project-import.mjs';
import { createProjectImportFixture, installProjectImportFixture } from './fixtures/project-import.mjs';

const bundled=await build({stdin:{contents:`export * from './src/model/project-import.ts';
export {parseState} from './src/model/store.ts'; export {createInitialState,createProject} from './src/model/seed.ts';`,
  resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
const ui=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
async function snapshot({preserve=false}={}) {
  const fixture=await createProjectImportFixture({preserve}),tasks={tasks:new Map(),requests:new Map(),artifacts:new Map(),
    list(id){return [...this.tasks.values()].filter(t=>!id||t.projectId===id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}};
  installProjectImportFixture(tasks,fixture);
  return {fixture,tasks,value:projectImportSnapshot(tasks,fixture.task.projectId)};
}

test('UI restores original source/version, candidate and failed history separately and persists honest provenance after reload', async () => {
  const {fixture,value}=await snapshot(),before=structuredClone(value),project=ui.projectFromImportSnapshot(value,fixture.task.projectId);
  assert.deepEqual(project.chapters,fixture.request.chapters);assert.notDeepEqual(project.chapters,fixture.task.result.chapters);
  assert.equal(project.importedBaseline.provenance,'whole_revision_source');assert.equal(project.importedBaseline.qualityCheckStatus,'incomplete');
  assert.equal(project.versions[0].label,'原始全文');assert.deepEqual(project.versions[0].chapters,fixture.request.chapters);
  assert.match(project.messages[0].text,/原稿检查未完成/);
  assert.equal(project.runtime.task.id,fixture.task.id);assert.equal(project.runtime.resultDisposition,'whole-quality-groups');
  assert.equal(project.runtime.candidateRecheckSelection,undefined);
  assert.equal(project.runtimeHistory.find(task=>task.id===fixture.failed.id).status,'failed');
  assert.ok(!project.runtimeHistory.some(task=>task.kind==='create'&&task.status==='completed'));
  assert.deepEqual(value,before,'import cannot mutate the server snapshot');
  const state=ui.createInitialState();state.projects=[project];
  const loaded=ui.parseState(JSON.parse(JSON.stringify(state))).projects[0];
  assert.deepEqual(loaded.importedBaseline,project.importedBaseline);assert.deepEqual(loaded.chapters,project.chapters);
  assert.equal(loaded.runtimeHistory[0].status,'failed');assert.equal(loaded.runtime.task.id,fixture.task.id);
});

test('UI rejects changed source/request/candidate identity or missing saved source proof', async () => {
  const {fixture,value}=await snapshot();
  for(const mutate of [
    v=>{v.baseline={...fixture.failed,status:'completed'};},
    v=>{v.baselineManuscript.provenance='completed_create';},
    v=>{v.baselineManuscript.qualityCheckStatus='passed';},
    v=>{v.baselineManuscript.sourceTaskId='another-task';},
    v=>{v.baselineManuscript.title+='改题';},
    v=>{v.baselineManuscript.chapters[0].body+='改文';},
    v=>{v.revisionRequest.projectId='another-project';},
    v=>{v.revisionRequest.requestId='another-request';},
    v=>{v.revisionRequest.baseRevision='stale';},
    v=>{v.revisionRequestSpec.sourceManuscriptSha256='0'.repeat(64);},
    v=>{delete v.revisionRequestSpec;},
    v=>{v.revision.result.wholeRevision.sourceChapters.pop();},
    v=>{v.revision.status='failed';},
    v=>{v.history=v.history.filter(task=>task.id!==v.revision.id);},
  ]) {
    const changed=structuredClone(value);mutate(changed);
    assert.throws(()=>ui.projectFromImportSnapshot(changed,fixture.task.projectId));
  }
});

test('generic append import preserves existing local edits and candidate choice when another import finishes later', async () => {
  const {fixture,value}=await snapshot(),project=ui.projectFromImportSnapshot(value,fixture.task.projectId),state=ui.createInitialState();
  state.projects=[];ui.appendImportedProject(state,project);
  assert.equal(state.projects.length,1);assert.equal(state.activeProjectId,project.id);
  project.chapters[0].body+='用户正在编辑的内容';project.runtime.resultDisposition='declined';
  const before=structuredClone(project);
  ui.appendImportedProject(state,ui.projectFromImportSnapshot(value,fixture.task.projectId));
  assert.equal(state.projects.length,1);assert.deepEqual(state.projects[0],before);
});

test('UI still imports completed-create v1 and no-change whole source without offering a revision', async () => {
  const {fixture,tasks}=await snapshot();
  const baseline={...fixture.failed,id:'99999999-9999-4999-8999-999999999999',requestId:'old-create',status:'completed',
    result:{title:fixture.request.projectTitle,chapters:fixture.request.chapters,review:{summary:'合成已完成创作。'}}};
  tasks.tasks.set(baseline.id,baseline);tasks.requests.set(baseline.id,{idea:'旧版作品'});
  const legacy=ui.projectFromImportSnapshot(projectImportSnapshot(tasks,baseline.projectId),baseline.projectId);
  assert.equal(legacy.importedBaseline,undefined);assert.equal(legacy.versions[0].label,'封存基线稿');
  assert.deepEqual(legacy.chapters,fixture.request.chapters);
  const unchanged=await snapshot({preserve:true}),project=ui.projectFromImportSnapshot(unchanged.value,unchanged.fixture.task.projectId);
  assert.equal(project.runtime.resultDisposition,'declined');assert.equal(project.importedBaseline.qualityCheckStatus,'incomplete');
});
