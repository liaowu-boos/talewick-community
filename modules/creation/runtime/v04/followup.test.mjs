import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createFollowup,followupHash} from './followup.mjs';
import {FOLLOWUP_POLICY,referenceNeedsField} from './reference-needs.mjs';
import {createWorkflowRouter} from '../../../product/talewick-gui/server/workflow-engine.mjs';
import {makeAgentModels,configFor} from '../../../product/talewick-gui/scripts/agent-runtime-smoke.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
// Preserve legacy whole-chapter mocks only when the resumed request has no bounded scope.
function coinRevisionResponse(args, legacyResponse) {
 const input=JSON.parse(args.user);
 if(input.revisionScope===undefined)return legacyResponse;
 assert.equal(input.revisionScope.ranges.length,1);
 const range=input.revisionScope.ranges[0];assert.equal(range.quote,'铜钱');
 assert.equal(input.currentChapter.body.slice(range.start,range.end),range.quote);
 return JSON.stringify({replacements:[{...range,replacement:'银币'}]});
}

const planningNeed={question:'如何通过归还物品兑现承诺',reason:'方案缺少前后动作参考',basis:'insufficient_context',recall:{focus:'echo',queries:['归还物品']},target:{chapterNumber:2}};
const reviewNeed={question:'如何交代支付物件的来源',reason:'本篇交接缺失',basis:'new_reference_need',recall:{focus:'scene',queries:['付钱之前取出钱币']},target:{chapterId:'ch-2',quote:'铜钱'}};
const materialContent=line=>`【原文参考；不作为已发布分析】\n第${line}段合成正文。`;
const material=(line)=>({id:`m${line}`,title:'合成参考',kind:'retrieved',use:'raw_reference',content:materialContent(line),sha256:hash(materialContent(line)),references:[{sourceId:'s',sourceSha256:hash('source'),textVersion:'t1',analysisVersion:'a1',unitIds:[],lineStart:line,lineEnd:line}],selectionReason:'工程替身',limitations:['非语义效果']});
const result=(q,n)=>({contractVersion:'v04-contract-1',packetId:`p${n}`,query:structuredClone(q),status:'matched',materials:[material(n)],candidates:[],usedChars:material(n).content.length,limits:['工程替身']});
async function workflowFixture({engine='fixed',withNeeds=true,reviewDecision='revise',replan=false,artifacts={},failure,invalidNeed=false,
 strictEvidence=false,explicitDecisionMode=false,followupDecision='adopt',checkpointFailure}={}){
 const models=makeAgentModels({reviewDecision,replan}),queries=[],calls=[],request={kind:'create',idea:'合成工程，不是真实创作：修钟',context:{},materials:[]};
 let checkpointFailed=false;
 const model={complete:async args=>{
  calls.push({stage:args.stage,input:JSON.parse(args.user)});
  if(failure)await failure(args);
  if(args.stage==='planning:material-decisions'){
   const input=JSON.parse(args.user),materialId=input.addedMaterialIds[0];
   if(followupDecision==='wrong-id')return JSON.stringify({materialDecisions:[{materialId:'m10',decision:'decline',reason:'越界旧材料',limitations:['不能覆盖已有决定']}]});
   if(followupDecision==='bad-quote')return JSON.stringify({materialDecisions:[{materialId,decision:'adopt',reason:'尝试采用',limitations:['仅借结构'],mechanism:'以归还动作兑现承诺',sourceQuotes:['不存在的来源逐字短引'],target:{chapterNumber:2,sceneNumber:1}}]});
   if(followupDecision==='decline')return JSON.stringify({materialDecisions:[{materialId,decision:'decline',reason:'与既定方案没有安全对应',limitations:['不迁移具体人物与物件']}]});
   return JSON.stringify({materialDecisions:[{materialId,decision:'adopt',reason:'可服务既定归还场景',limitations:['只借动作与承诺的因果，不迁移人物身份'],mechanism:'以归还动作兑现承诺',sourceQuotes:['第20段合成正文。'],target:{chapterNumber:2,sceneNumber:1}}]});
  }
  if(args.stage==='revision:ch-2')return coinRevisionResponse(args,'她把银币交给师傅。');
  const response=await models.model.complete(args);
  if(args.stage==='requirements'&&strictEvidence){const value=JSON.parse(response);value.referenceQuestion='如何通过归还物品兑现承诺';value.referenceIntent={purpose:'expression',evidenceNeeds:['来源展示人物通过归还物品兑现承诺'],contextNeeds:[],basis:['/idea']};return JSON.stringify(value);}
  if(args.stage==='agent:reviseChapter:ch-2')return coinRevisionResponse(args,response);
  if(['planning','agent:replan','review'].includes(args.stage)){
   const value=JSON.parse(response);
   if(args.stage==='review')for(const i of value.issues)i.severity='must_fix';
   if(strictEvidence&&args.stage!=='review')value.materialDecisions=[{materialId:'m10',decision:'decline',reason:'初始材料不适合既定方案',limitations:['不迁移具体人物与物件']}];
   if(withNeeds&&(!strictEvidence||args.stage!=='review'))value.referenceNeeds=invalidNeed?null:[args.stage==='review'?reviewNeed:{...planningNeed,question:args.stage==='agent:replan'?'最终方案如何交还旧物':planningNeed.question}];
   return JSON.stringify(value);
  }return response;
 }};
 const router=createWorkflowRouter({config:configFor('/tmp/unused-followup'),agentModel:models.agentModel,retrieveKnowledge:async q=>{queries.push(structuredClone(q));return result(q,queries.length*10);}});
 const run=()=>router({request,engine,model,artifacts,...(strictEvidence||explicitDecisionMode?{planningFollowupDecisionMode:'planning-followup-decisions-1'}:{}),checkpoint:async(k,v)=>{
  if(checkpointFailure===k&&!checkpointFailed){checkpointFailed=true;throw Error(`checkpoint failed: ${k}`);}artifacts[k]=structuredClone(v);
 }});
 return {run,artifacts,queries,calls,models};
}
test('real fixed and SDK router use exactly two slots without additional model stages or changing controller decisions',async()=>{
 for(const engine of ['fixed','ai-sdk']){
  const baseline=await workflowFixture({engine,withNeeds:false,replan:engine==='ai-sdk'});await baseline.run();
  const fixture=await workflowFixture({engine,replan:engine==='ai-sdk'});const output=await fixture.run();
  assert.equal(fixture.artifacts.requestSpec.boundedRevisionPolicyVersion,'bounded-paragraph-revision-1');
  assert.ok(fixture.calls.find(c=>c.stage.includes('revision:')||c.stage.includes('reviseChapter:')).input.revisionScope);
  if(process.env.FOLLOWUP_EVIDENCE_DIR){const {writeFile}=await import('node:fs/promises');await writeFile(`${process.env.FOLLOWUP_EVIDENCE_DIR}/${engine}.json`,JSON.stringify({provenance:'fixed-model-responses-not-provider',queries:fixture.queries,calls:fixture.calls,decisions:fixture.models.decisions,artifacts:fixture.artifacts,result:output},null,2));}
  assert.equal(fixture.queries.length,3);assert.deepEqual(fixture.queries.map(q=>q.stage),['planning','writing','revision']);
  assert.deepEqual(fixture.calls.map(c=>c.stage),baseline.calls.map(c=>c.stage));
  if(engine==='ai-sdk'){assert.deepEqual(fixture.models.decisions.map(d=>d.action),baseline.models.decisions.map(d=>d.action));assert.equal(fixture.queries[1].query,'最终方案如何交还旧物');}
  assert.equal(output.knowledge.materials.length,1);assert.equal(output.activeKnowledge.materials.length,3);
  assert.equal(output.followupRetrieval.slots[0].acceptedCount,1);assert.equal(output.followupRetrieval.slots[1].acceptedCount,1);
  for(const c of fixture.calls.filter(c=>/review/i.test(c.stage)))assert.equal(c.input.knowledge,undefined);
  assert.equal(fixture.calls.find(c=>c.stage==='draft:ch-1').input.knowledge.materials.length,2);
  assert.equal(fixture.calls.find(c=>c.stage.includes('revision:')||c.stage.includes('reviseChapter:')).input.knowledge.materials.length,3);
  const before=structuredClone(fixture.artifacts),count=fixture.queries.length;assert.deepEqual(await fixture.run(),output);assert.equal(fixture.queries.length,count);assert.deepEqual(fixture.artifacts,before);
 }
});
test('SDK finish without revision does not consume initial review query slot',async()=>{
 const f=await workflowFixture({engine:'ai-sdk',reviewDecision:'finish'});const output=await f.run();assert.equal(f.queries.length,2);assert.equal(output.followupRetrieval.slots[1].status,'deferred_no_consumer');
});
test('invalid need is rejected without plan format repair or new model calls',async()=>{
 const f=await workflowFixture({invalidNeed:true});const output=await f.run();assert.equal(f.queries.length,1);assert.equal(f.calls.filter(c=>c.stage==='planning').length,1);assert.ok(output.followupRetrieval.slots.every(s=>s.status==='rejected'));
});
test('non-expression create task may persist the explicit mode and completes without a decision call',async()=>{
 const f=await workflowFixture({explicitDecisionMode:true});const output=await f.run();
 assert.equal(f.artifacts.requestSpec.planningFollowupDecisionMode,'planning-followup-decisions-1');
 assert.equal(f.artifacts.requestSpec.materialEvidencePolicyVersion,undefined);
 assert.equal(f.calls.some(c=>c.stage==='planning:material-decisions'),false);
 assert.equal(f.artifacts.planningFollowupDecisionStarted,undefined);assert.ok(output.chapters.length>0);
});
test('non-expression explicit mode remains a no-op across resume even when planning added material',async()=>{
 const f=await workflowFixture({explicitDecisionMode:true});const first=await f.run(),queryCount=f.queries.length,callCount=f.calls.length;
 assert.equal(first.followupRetrieval.slots[0].acceptedCount,1);assert.equal(f.calls.some(c=>c.stage==='planning:material-decisions'),false);
 assert.deepEqual(await f.run(),first);assert.equal(f.queries.length,queryCount);assert.equal(f.calls.length,callCount);
 assert.equal(f.artifacts.planningFollowupDecisionResponse,undefined);assert.equal(f.artifacts.planningFollowupDecisionCommit,undefined);
});
test('explicit planning followup decision adopts only the new material before chapter one without replanning',async()=>{
 const f=await workflowFixture({strictEvidence:true});const output=await f.run();
 assert.equal(f.artifacts.requestSpec.planningFollowupDecisionMode,'planning-followup-decisions-1');
 assert.equal(f.artifacts.requestSpec.materialEvidencePolicyVersion,'source-use-evidence-1');
 assert.equal(f.queries.length,2);assert.deepEqual(f.queries.map(q=>q.stage),['planning','writing']);
 assert.equal(f.calls.filter(c=>c.stage==='planning:material-decisions').length,1);
 const receipt=f.artifacts.planningFollowupDecisionResponse,commit=f.artifacts.planningFollowupDecisionCommit;
 assert.deepEqual(receipt.input.addedMaterialIds,['m20']);assert.equal(receipt.input.activeSnapshotHash,output.followupRetrieval.activeSnapshotHash);
 assert.deepEqual(commit.materialDecisions.map(item=>[item.materialId,item.decision]),[['m20','adopt']]);
 assert.deepEqual(commit.plan.materialDecisions.map(item=>[item.materialId,item.decision]),[['m10','decline'],['m20','adopt']]);
 const before=structuredClone(f.artifacts.plan),after=structuredClone(commit.plan);delete before.materialDecisions;delete after.materialDecisions;assert.deepEqual(after,before);
 assert.deepEqual(f.calls.find(c=>c.stage==='draft:ch-1').input.knowledge.materials.map(item=>item.id),['m20']);
});
test('planning followup decline excludes the new material and no additions make no decision call',async()=>{
 const declined=await workflowFixture({strictEvidence:true,followupDecision:'decline'});await declined.run();
 assert.deepEqual(declined.artifacts.planningFollowupDecisionCommit.plan.materialDecisions.map(item=>item.decision),['decline','decline']);
 assert.deepEqual(declined.calls.find(c=>c.stage==='draft:ch-1').input.knowledge.materials,[]);
 const none=await workflowFixture({strictEvidence:true,withNeeds:false});await none.run();
 assert.equal(none.calls.some(c=>c.stage==='planning:material-decisions'),false);assert.equal(none.artifacts.planningFollowupDecisionResponse,undefined);assert.equal(none.artifacts.planningFollowupDecisionCommit,undefined);
});
test('invalid planning followup evidence and cancellation stop before every chapter write',async()=>{
 for(const followupDecision of ['bad-quote','wrong-id']){
  const f=await workflowFixture({strictEvidence:true,followupDecision});await assert.rejects(f.run(),/材料|决定id/);
  assert.ok(f.artifacts.planningFollowupDecisionResponse);assert.equal(f.artifacts.planningFollowupDecisionCommit,undefined);assert.equal(f.calls.some(c=>c.stage.startsWith('draft:')),false);
 }
 const cancelled=await workflowFixture({strictEvidence:true,failure:async args=>{if(args.stage==='planning:material-decisions')throw Object.assign(Error('cancelled'),{name:'AbortError'});}});
 await assert.rejects(cancelled.run(),/cancelled/);assert.equal(cancelled.artifacts.planningFollowupDecisionResponse,undefined);assert.equal(cancelled.calls.some(c=>c.stage.startsWith('draft:')),false);
 const cancelledResume=await workflowFixture({strictEvidence:true,artifacts:cancelled.artifacts});await assert.rejects(cancelledResume.run(),/不会重新询问或重新判断/);
 assert.equal(cancelledResume.queries.length,0);assert.equal(cancelledResume.calls.some(c=>c.stage==='planning:material-decisions'||c.stage.startsWith('draft:')),false);
});
test('response checkpoint loss is terminal on resume and never rejudges the material',async()=>{
 const f=await workflowFixture({strictEvidence:true,checkpointFailure:'planningFollowupDecisionResponse'});
 await assert.rejects(f.run(),/checkpoint failed/);assert.ok(f.artifacts.planningFollowupDecisionStarted);assert.equal(f.artifacts.planningFollowupDecisionResponse,undefined);
 assert.equal(f.calls.filter(c=>c.stage==='planning:material-decisions').length,1);assert.equal(f.calls.some(c=>c.stage.startsWith('draft:')),false);
 await assert.rejects(f.run(),/不会重新询问或重新判断/);assert.equal(f.queries.length,2);assert.equal(f.calls.filter(c=>c.stage==='planning:material-decisions').length,1);
});
test('decision commit checkpoint resumes without retrieval or model rejudgment',async()=>{
 const f=await workflowFixture({strictEvidence:true,checkpointFailure:'planningFollowupDecisionCommit'});
 await assert.rejects(f.run(),/checkpoint failed/);assert.equal(f.queries.length,2);assert.equal(f.calls.filter(c=>c.stage==='planning:material-decisions').length,1);assert.equal(f.calls.some(c=>c.stage.startsWith('draft:')),false);
 await f.run();assert.equal(f.queries.length,2);assert.equal(f.calls.filter(c=>c.stage==='planning:material-decisions').length,1);assert.ok(f.artifacts.planningFollowupDecisionCommit);
});
test('tampered decision receipt is rejected before resume can draft or requery',async()=>{
 const complete=await workflowFixture({strictEvidence:true});await complete.run();const artifacts=structuredClone(complete.artifacts);
 artifacts.planningFollowupDecisionResponse.inputHash='0'.repeat(64);
 const resumed=await workflowFixture({strictEvidence:true,artifacts});await assert.rejects(resumed.run(),/响应保存点/);
 assert.equal(resumed.queries.length,0);assert.equal(resumed.calls.some(c=>c.stage.startsWith('draft:')||c.stage==='planning:material-decisions'),false);
});
test('unknown create-state-review modes fail before a model call',async()=>{
 const {runWorkflow}=await import('../workflow.mjs');let calls=0;
 await assert.rejects(runWorkflow({request:{kind:'create',idea:'测试',context:{},materials:[]},createStateReviewMode:'create-state-review-v999',model:{complete:async()=>{calls++;return '{}';}}}),/未知新建创作/);
 assert.equal(calls,0);
});
function stateFixture({saved={},retrieve,checkpoint,signal,knowledge}={}){
 const base=knowledge??{materials:[],style:null,limits:[]};
 const requestSpec={inputFingerprint:'input',requirements:{summary:'测试'},followupPolicyVersion:FOLLOWUP_POLICY,followupPolicy:{mode:'dynamic'}};
 return {saved,manager:createFollowup({request:{kind:'create'},requestSpec,knowledge:base,saved,signal,retrieveKnowledge:retrieve??(async q=>result(q,1)),persist:async(k,v)=>{await checkpoint?.(k,v);saved[k]=structuredClone(v);}})};
}
const planContext={plan:{chapters:[{goal:'检查'},{goal:'归还'}]}};
test('started/query/commit crash boundaries never duplicate a query or expose an uncommitted snapshot',async()=>{
 for(const when of ['started','commit']){
  let count=0;const saved={};const first=stateFixture({saved,retrieve:async q=>{count++;return result(q,1);},checkpoint:async k=>{if(k.endsWith(when))throw Error('disk failed');}});
  await assert.rejects(first.manager.consume('planning',[planningNeed],planContext),/disk failed/);assert.equal(first.manager.view().materials.length,0);assert.equal(count,when==='started'?0:1);
  const recovery=stateFixture({saved,retrieve:async()=>{count++;throw Error('must not query after started');}});
  if(when==='commit'){await recovery.manager.consume('planning',[planningNeed],planContext);assert.equal(count,1);assert.equal(recovery.manager.summary().slots[0].status,'interrupted_no_requery');}
 }
});
test('cancel/unavailable/uncovered attempts are terminal; tampered parent/query commits are rejected',async()=>{
 const abort=new AbortController(),saved={};let count=0;
 const f=stateFixture({saved,signal:abort.signal,retrieve:async q=>{count++;abort.abort();return result(q,1);}});
 await assert.rejects(f.manager.consume('planning',[planningNeed],planContext));
 const recovery=stateFixture({saved,retrieve:async()=>assert.fail('no requery')});await recovery.manager.consume('planning',[planningNeed],planContext);assert.equal(count,1);
 for(const mode of ['unavailable','uncovered']){
  let attempts=0;const s={};const f=stateFixture({saved:s,retrieve:async q=>{attempts++;if(mode==='unavailable')throw Error('offline');return {...result(q,1),status:'uncovered',materials:[],usedChars:0};}});
  await f.manager.consume('planning',[planningNeed],planContext);const r=stateFixture({saved:s,retrieve:async()=>assert.fail('terminal')});await r.manager.consume('planning',[planningNeed],planContext);assert.equal(attempts,1);
  s['followup:planning:started'].query.query='tampered';assert.throws(()=>stateFixture({saved:s}),/哈希/);
 }
});
test('legacy policy missing stays untouched; full retained budget skips, quote drift rejects, repeated semantic query is bounded',async()=>{
 const legacy=createFollowup({request:{},requestSpec:{},knowledge:{materials:[],limits:[]},saved:{},persist:async()=>assert.fail('legacy write'),retrieveKnowledge:async()=>assert.fail('legacy query')});await legacy.consume('planning',[planningNeed],planContext);assert.equal(legacy.enabled,false);
 const f=stateFixture({knowledge:{materials:[{id:'selected',content:'字'.repeat(30000)}],limits:[]}});await f.manager.consume('planning',[planningNeed],planContext);assert.equal(f.manager.summary().slots[0].status,'skipped_budget');
 const r=stateFixture();await r.manager.consume('review',[reviewNeed],{chapters:[{id:'ch-2',body:'银币'}],issues:[{chapterId:'ch-2',quote:'铜钱',severity:'must_fix',evidenceVerified:true}],chapterId:'ch-2',consumerIssues:[]});assert.equal(r.manager.summary().slots[1].status,'rejected');
});
test('need strict validation does not pass model-owned source scope or budgets',()=>{
 for(const n of [{...planningNeed,sourceIds:['other']},{...planningNeed,recall:{focus:'echo',queries:[' x']}},{...planningNeed,target:{chapterNumber:2,extra:true}}])assert.equal(referenceNeedsField([n]).referenceNeeds,null);
 assert.deepEqual(referenceNeedsField(undefined),{});
});

test('same version full raw expansion replaces active context but charges both historical windows',async()=>{
 const old={...material(1),content:'甲\n乙',sha256:hash('甲\n乙')};old.references[0].lineEnd=2;
 const expanded={...material(1),id:'expanded',content:'甲\n乙\n丙',sha256:hash('甲\n乙\n丙')};expanded.references[0].lineEnd=3;
 const f=stateFixture({knowledge:{materials:[old],limits:[]},retrieve:async q=>({...result(q,1),materials:[expanded],usedChars:expanded.content.length})});
 await f.manager.consume('planning',[planningNeed],planContext);assert.deepEqual(f.manager.view().materials.map(m=>m.id),['expanded']);assert.equal(f.manager.summary().retainedChars,old.content.length+expanded.content.length);assert.equal(f.manager.summary().activeChars,expanded.content.length);
 const restored=stateFixture({saved:f.saved,knowledge:{materials:[old],limits:[]},retrieve:async()=>assert.fail('no requery')});await restored.manager.consume('planning',[planningNeed],planContext);assert.deepEqual(restored.manager.summary(),f.manager.summary());
});
test('same need in second slot does not repeat and consumer with unrelated issue does not query',async()=>{
 const f=stateFixture();await f.manager.consume('planning',[planningNeed],planContext);
 const need={...planningNeed,target:reviewNeed.target};const issue={chapterId:'ch-2',quote:'铜钱',severity:'must_fix',evidenceVerified:true};
 await f.manager.consume('review',[need],{chapters:[{id:'ch-2',body:'铜钱'}],issues:[issue],chapterId:'ch-2',consumerIssues:[issue]});assert.equal(f.manager.summary().slots[1].status,'duplicate_need');
 const other=stateFixture({retrieve:async()=>assert.fail('no query')});await other.manager.consume('review',[reviewNeed],{chapters:[{id:'ch-2',body:'铜钱'}],issues:[issue],chapterId:'ch-1',consumerIssues:[]});await other.manager.finishReview([reviewNeed],{chapters:[{id:'ch-2',body:'铜钱'}],issues:[issue]});assert.equal(other.manager.summary().slots[1].status,'deferred_no_consumer');
});

test('rehashing altered snapshot/delta/retained fees cannot detach a commit from the real packet',async()=>{
 const f=stateFixture();await f.manager.consume('planning',[planningNeed],planContext);
 for(const mutate of [v=>{v.snapshot.materials[0].content='伪造';v.snapshot.materials[0].sha256=hash('伪造');},v=>v.snapshot.retainedChars=0,v=>v.delta.accepted=[],v=>v.snapshot.retainedMaterials=[]]){
  const s=structuredClone(f.saved),commit=s['followup:planning:commit'];mutate(commit.value);const {hash:_,...body}=commit.value.snapshot;commit.value.snapshot.hash=followupHash(body);commit.valueHash=followupHash(commit.value);assert.throws(()=>stateFixture({saved:s}),/重新计算/);
 }
 const moved=structuredClone(f.saved);moved['followup:review:started']=moved['followup:planning:started'];delete moved['followup:planning:started'];assert.throws(()=>stateFixture({saved:moved}),/保存点/);
});
test('only validated packets are retained and new need/context cannot replay a previous slot',async()=>{
 const f=stateFixture({retrieve:async()=>({status:'matched',limits:['x'.repeat(500000)]})});await f.manager.consume('planning',[planningNeed],planContext);assert.equal(JSON.stringify(f.saved).includes('x'.repeat(100)),false);assert.equal(f.saved['followup:planning:commit'].value.result,undefined);
 const restored=stateFixture({saved:f.saved});await assert.rejects(restored.manager.consume('planning',[{...planningNeed,question:'不同需求'}],planContext),/本次需要/);
});
test('consumer input must name an existing recomputed snapshot and match its actual material view',async()=>{
 const f=stateFixture();await f.manager.consume('planning',[planningNeed],planContext);await f.manager.bindCall('draft:ch-1',{knowledge:f.manager.view(),currentChapter:{id:'ch-1'},chapterIndex:1,previousChapters:[]});
 const s=structuredClone(f.saved),v=s['knowledge-use:draft:ch-1:1'];v.input.knowledge.materials[0].content='改变';v.inputHash=followupHash(v.input);assert.throws(()=>stateFixture({saved:s}),/作者输入/);
 v.snapshotHash='missing';assert.throws(()=>stateFixture({saved:s}),/未知快照/);
});

test('AB explicitly frozen policy never calls dynamic retrieval even if existing JSON returns legal needs',async t=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {prepareExperiment,checkExperiment}=await import('./evaluation/experiment.mjs');const {runWorkflow}=await import('../workflow.mjs');
 const dir=await mkdtemp(join(tmpdir(),'followup-ab-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const models=makeAgentModels(),request={kind:'create',idea:'合成完整故事，修钟',materials:[],context:{}};
 const requirements=JSON.parse(await models.model.complete({stage:'requirements',user:JSON.stringify({kind:'create'})}));
 await prepareExperiment({directory:join(dir,'prepared'),request,requirements:{...requirements,usesChapter4Cut:false},modelSpec:{provider:'fixture',id:'fixed',parameters:{}}});
 const manifest=JSON.parse(await readFile(join(dir,'prepared','manifest.json')));assert.equal(manifest.requestSpec.followupPolicy.reason,'ab_fixed_materials');assert.equal(manifest.requestSpec.followupPolicy.mode,'disabled');assert.equal((await checkExperiment(join(dir,'prepared'))).calls,0);
 const artifacts={requestSpec:manifest.requestSpec,knowledge:{materials:[],style:null,limits:[]}};
 const model={complete:async args=>{const response=await models.model.complete(args);if(['revision:ch-2','agent:reviseChapter:ch-2'].includes(args.stage))return coinRevisionResponse(args,response);if(['planning','review'].includes(args.stage)){const v=JSON.parse(response);v.referenceNeeds=[args.stage==='planning'?planningNeed:reviewNeed];return JSON.stringify(v);}return response;}};
 const result=await runWorkflow({request,artifacts,model,retrieveKnowledge:async()=>assert.fail('AB must not call retrieval'),checkpoint:async(k,v)=>{artifacts[k]=v;}});
 assert.equal(result.followupRetrieval,undefined);assert.equal(artifacts.plan.referenceNeeds,undefined);assert.equal(Object.keys(artifacts).some(k=>k.startsWith('followup:')),false);
});
test('legacy-schema workflow checkpoint restores without adding followup or bounded policy, despite current callbacks',async()=>{
 const f=await workflowFixture({withNeeds:false,failure:async args=>{if(args.stage==='planning')throw Error('pause');}});await assert.rejects(f.run(),/pause/);
 assert.equal(f.artifacts.requestSpec.boundedRevisionPolicyVersion,'bounded-paragraph-revision-1');
 // Build the pre-policy schema explicitly; this is not a provider-generated historical archive.
 const old=structuredClone(f.artifacts);delete old.requestSpec.followupPolicy;delete old.requestSpec.followupPolicyVersion;delete old.requestSpec.boundedRevisionPolicyVersion;for(const k of Object.keys(old))if(k.startsWith('knowledge-use:'))delete old[k];
 const originalSpec=structuredClone(old.requestSpec);
 const resumed=await workflowFixture({artifacts:old});const result=await resumed.run();assert.equal(resumed.queries.length,0);assert.equal(result.followupRetrieval,undefined);assert.equal(old.requestSpec.followupPolicyVersion,undefined);assert.equal(old.plan.referenceNeeds,undefined);assert.deepEqual(old.requestSpec,originalSpec);assert.equal(resumed.calls.find(c=>c.stage==='revision:ch-2').input.revisionScope,undefined);
});

 test('unknown stage and forged neutral marker are refused even with self-consistent input hashes',async()=>{
 const f=stateFixture();await f.manager.consume('planning',[planningNeed],planContext);await f.manager.bindCall('draft:ch-1',{knowledge:f.manager.view(),currentChapter:{id:'ch-1'},chapterIndex:1,previousChapters:[]});
 const s=structuredClone(f.saved),original=s['knowledge-use:draft:ch-1:1'];s['knowledge-use:nonexistent-stage:1']={...original,stage:'nonexistent-stage'};assert.throws(()=>stateFixture({saved:s}),/未知业务/);
 delete s['knowledge-use:nonexistent-stage:1'];original.neutralReview=true;assert.throws(()=>stateFixture({saved:s}),/中立标记/);
 original.neutralReview=false;original.stage='review';s['knowledge-use:review:1']=original;delete s['knowledge-use:draft:ch-1:1'];assert.throws(()=>stateFixture({saved:s}),/中立审稿/);
 });
