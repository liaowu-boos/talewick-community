import { createHash } from 'node:crypto';
import { knowledgeForAuthor, validateRetrieval, validateRelevanceSummary } from './knowledge.mjs';
import { FOLLOWUP_POLICY, selectNeed } from './reference-needs.mjs';
import { mergeFollowupMaterials } from '../../../data/runtime/followup-materials.mjs';
import { MATERIAL_USE_EVIDENCE_POLICY } from './material-use-evidence.mjs';
import { PLANNING_FOLLOWUP_DECISION_POLICY } from './planning-followup-decisions.mjs';
const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const followupHash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const copy=structuredClone;
const same=(a,b)=>followupHash(a)===followupHash(b);
const ensure=(ok,message)=>{if(!ok)throw Error(`补查保存点无效：${message}`);};
const chars=materials=>materials.reduce((n,m)=>n+m.content.length,0);
const slots=['planning','review'];
export const AUTHOR_MATERIAL_POLICY='author-material-decisions-1';
const key=(s,k)=>`followup:${s}:${k}`;
const noQueryStatuses=['not_requested','rejected','deferred_no_consumer','duplicate_need','skipped_budget','not_connected'];
export function createFollowup({request,requestSpec,knowledge,saved,persist,retrieveKnowledge,signal}) {
 ensure(requestSpec.authorMaterialPolicyVersion===undefined||requestSpec.authorMaterialPolicyVersion===AUTHOR_MATERIAL_POLICY,'未知作者材料政策');
 ensure(requestSpec.planningFollowupDecisionMode===undefined||requestSpec.planningFollowupDecisionMode===PLANNING_FOLLOWUP_DECISION_POLICY,'未知规划补查材料决定政策');
 const authorPolicyEnabled=requestSpec.authorMaterialPolicyVersion===AUTHOR_MATERIAL_POLICY;
 const stopOnFailure=requestSpec.retrievalFailurePolicyVersion==='stop-on-retrieval-failure-1';
 const failScreen=()=>{throw Object.assign(Error('补充材料筛选服务未完成或返回结果不兼容，后续写作或修订已停止；已有稿件和筛选记录已保留，请检查服务后重试。'),{code:'RETRIEVAL_UNAVAILABLE'});};
 const evidencePolicyEnabled=requestSpec.materialEvidencePolicyVersion===MATERIAL_USE_EVIDENCE_POLICY;
 if(requestSpec.followupPolicyVersion!==undefined)ensure(requestSpec.followupPolicyVersion===FOLLOWUP_POLICY&&['dynamic','disabled'].includes(requestSpec.followupPolicy?.mode),'未知补查政策');
 const enabled=requestSpec.followupPolicyVersion===FOLLOWUP_POLICY&&requestSpec.followupPolicy?.mode==='dynamic';
 const body0={parentHash:null,materials:copy(knowledge.materials),retainedMaterials:copy(knowledge.materials),retainedChars:chars(knowledge.materials)};
 const initial={...body0,hash:followupHash(body0)};
 let current=copy(initial);
 const snapshots=[copy(initial)],known=new Map([[initial.hash,initial]]),records={};
 const binding={policyVersion:FOLLOWUP_POLICY,inputFingerprint:requestSpec.inputFingerprint};
 const checkBinding=v=>ensure(v?.policyVersion===binding.policyVersion&&v.inputFingerprint===binding.inputFingerprint,'任务/政策绑定不一致');
 const contextValue=(slot,c)=>slot==='planning'?{plan:c.plan}:{chapters:c.initialChapters??c.chapters,issues:c.issues};
 const decisionHash=(slot,raw,c)=>followupHash({slot,raw,context:contextValue(slot,c)});
 const packetFor=s=>({...copy(knowledge),packetId:`active-${s.hash}`,coverage:s.materials.length?'partial':'uncovered',materials:copy(s.materials),
  retrieval:{contractVersion:'v04-contract-1',status:'versioned_active_view',initialPacketId:knowledge.packetId??null,initialSnapshotHash:initial.hash,snapshotHash:s.hash,limits:['版本化材料视图；具体检索状态见独立槽记录，不代表已采用。']}});
 const viewFor=(s,materialDecisions,{forPlanning=false}={})=>knowledgeForAuthor(s.hash===initial.hash?knowledge:packetFor(s),
  {materialDecisions:authorPolicyEnabled?materialDecisions:undefined,decisionMaterials:s.retainedMaterials,
   requireAdoptDecision:evidencePolicyEnabled&&!forPlanning});
 // 使用本次实际输入中的方案决定重算作者视图；旧任务没有显式标记，保留原视图。
 const planningStages=['planning','agent:replan','planning:material-decisions'];
 const decisionsFor=(stage,input)=>stage==='planning:material-decisions'?input.plan?.materialDecisions
  :stage==='planning'||stage==='agent:replan'?input.previousPlan?.materialDecisions
  :stage.startsWith('draft:')?input.plan?.materialDecisions:input.materialDecisions;
 function queryFor(slot,need,c,parent){
  const target=slot==='planning'?{...need.target,goal:c.plan.chapters[need.target.chapterNumber-1].goal.slice(0,600)}:need.target;
  return {contractVersion:'v04-contract-1',evidenceType:'narrative',query:need.question,stage:slot==='planning'?'writing':'revision',
   context:JSON.stringify({summary:requestSpec.requirements.summary.slice(0,1000),target,reason:need.reason,factsPriority:'本篇实际正文优先；外部来源不得替换本篇身份和经历'}),recall:copy(need.recall),budget:{maxCandidates:20,maxUnits:6,maxChars:Math.min(12000,30000-parent.retainedChars)},...(request.sourceIds!==undefined?{sourceIds:[...new Set(request.sourceIds)]}:{})};
 }
 function preparedValue(start,result,parent){
  validateRetrieval(result,start.query);
  const m=mergeFollowupMaterials({retained:parent.retainedMaterials,active:parent.materials,result});
  const body={parentHash:parent.hash,materials:m.active,retainedMaterials:m.retained,retainedChars:m.chargedChars};
  return {status:result.status==='matched'?(m.accepted.length?'prepared':'no_additions'):result.status,retrievalStatus:result.status,
   reason:result.status==='matched'?'材料已准备；实际收到见consumerBindings，采用与效果未核验':stopOnFailure&&result.status==='unavailable'?'补充材料筛选失败，暂停后续写作或修订':'未获得可用补充材料',need:copy(start.need),query:copy(start.query),queryHash:start.queryHash,result:copy(result),
   delta:{accepted:m.accepted,dropped:m.dropped,superseded:m.superseded},snapshot:{...body,hash:followupHash(body)},acceptedCount:m.accepted.length,droppedCount:m.dropped.length};
 }
 const failedValue=(start,status)=>({status,reason:status==='unavailable'?'补查失败或合同不兼容，不自动重试':'结果未完整保存，沿用旧材料',need:copy(start.need),query:copy(start.query),queryHash:start.queryHash,acceptedCount:0,droppedCount:0});
 function verifyStored(slot,parent){
  const start=saved[key(slot,'started')],commit=saved[key(slot,'commit')];
  if(start){checkBinding(start);ensure(start.slot===slot&&start.parentSnapshotHash===parent.hash,'槽位或父快照变化');ensure(followupHash(start.query)===start.queryHash&&followupHash(start.need)===start.needHash,'查询/需要哈希变化');}
  if(!commit)return null;
  checkBinding(commit);ensure(commit.slot===slot&&commit.parentSnapshotHash===parent.hash,'提交槽位/父快照变化');ensure(commit.valueHash===followupHash(commit.value),'提交哈希变化');
  if(start){ensure(commit.startedHash===followupHash(start)&&commit.decisionHash===start.decisionHash,'开始与提交绑定变化');
   const expected=commit.value.snapshot?preparedValue(start,commit.value.result,parent):failedValue(start,commit.value.status);
   ensure(commit.value.snapshot||['unavailable','interrupted_no_requery'].includes(commit.value.status),'非法终态');
   ensure(same(expected,commit.value),'结果、delta、快照或计费与重新计算不符');
  }else{ensure(commit.startedHash===null&&noQueryStatuses.includes(commit.value.status)&&!commit.value.snapshot&&!commit.value.result&&!commit.value.query&&!commit.value.delta&&commit.value.acceptedCount===0&&commit.value.droppedCount===0,'未查询提交携带非法材料');}
  if(commit.value.snapshot)known.set(commit.value.snapshot.hash,copy(commit.value.snapshot));
  return commit;
 }
 function stageKind(stage,input){
  ensure(input&&typeof input==='object'&&!Array.isArray(input),'调用输入类型无效');
  if(['review','revisionReview','agent:reviewManuscript'].includes(stage)){
   ensure(Array.isArray(input.chapters)&&input.requirements&&!input.knowledge&&!input.selectedMaterials,'中立审稿输入无效');return 'neutral';
  }
  if(['planning','agent:replan'].includes(stage)){
   if(input.originalInput!==undefined){ensure(typeof input.invalidResponse==='string'&&typeof input.fieldErrors==='string'&&input.originalInput?.originalInput===undefined,'规划修复输入无效');input=input.originalInput;}
   ensure(input.request&&input.requirements&&input.knowledge&&!input.currentChapter&&!input.chapters,'规划输入无效');
   if(stage==='agent:replan')ensure(input.previousPlan!==undefined&&input.feedback!==undefined,'重规划输入无效');return 'author';
  }
  if(stage==='planning:material-decisions'){
   ensure(request.kind==='create'&&requestSpec.planningFollowupDecisionMode===PLANNING_FOLLOWUP_DECISION_POLICY
    &&input.policyVersion===PLANNING_FOLLOWUP_DECISION_POLICY&&input.plan&&Array.isArray(input.plan.materialDecisions)
    &&input.knowledge&&Array.isArray(input.knowledge.materials)&&Array.isArray(input.addedMaterialIds)&&input.addedMaterialIds.length>0
    &&typeof input.activeSnapshotHash==='string'&&/^[a-f0-9]{64}$/.test(input.activeSnapshotHash)&&!input.currentChapter&&!input.chapters,'规划补查材料决定输入无效');return 'author';
  }
  if(stage==='requestedRevision'){
   ensure(request.kind==='revise'&&Array.isArray(input.chapters)&&typeof input.instruction==='string'&&Array.isArray(input.selectedMaterials),'指定修订输入无效');return 'author';
  }
  const draft=/^draft:(ch-([1-9]|1[0-2]))$/.exec(stage);
  if(draft){ensure(request.kind==='create'&&input.currentChapter?.id===draft[1]&&input.chapterIndex===Number(draft[2])&&Array.isArray(input.previousChapters)&&input.knowledge,'逐章输入/章号无效');return 'author';}
  const revision=/^(?:revision|agent:reviseChapter):(.{1,160})$/.exec(stage);
  if(revision){ensure(!request.quoteSource&&input.currentChapter?.id===revision[1]&&Array.isArray(input.issues)&&input.knowledge,'章节修订输入无效');return 'author';}
  ensure(false,'未知业务调用stage');
 }
 function verifyBindings(){
  for(const [id,r] of Object.entries(saved).filter(([k])=>k.startsWith('knowledge-returned:')))ensure(saved[id.slice('knowledge-returned:'.length)]&&r.useHash===followupHash(saved[id.slice('knowledge-returned:'.length)]),'孤立或不匹配的调用返回');
  for(const [id,v] of Object.entries(saved).filter(([k])=>k.startsWith('knowledge-use:'))){
   checkBinding(v);ensure(v.authorMaterialPolicyVersion===requestSpec.authorMaterialPolicyVersion,'作者材料政策绑定变化');const kind=stageKind(v.stage,v.input),prefix=`knowledge-use:${v.stage}:`;
   ensure(id.startsWith(prefix)&&/^[1-9][0-9]*$/.test(id.slice(prefix.length))&&v.inputHash===followupHash(v.input),'调用输入绑定变化');
   ensure(v.neutralReview===(kind==='neutral')&&(kind==='neutral'?v.snapshotHash===null:v.snapshotHash!==null),'调用中立标记/快照类型变化');
   const actualInput=v.input.originalInput??v.input;
   if(v.snapshotHash!==null){const s=known.get(v.snapshotHash);ensure(s,'调用引用未知快照');
    if(v.stage==='planning:material-decisions')ensure(actualInput.activeSnapshotHash===v.snapshotHash,'决定输入与active快照不符');
    if(actualInput.knowledge)ensure(same(actualInput.knowledge,viewFor(s,decisionsFor(v.stage,actualInput),
     {forPlanning:planningStages.includes(v.stage)})),'作者输入与快照不符');
    else ensure(same(actualInput.selectedMaterials,s.materials)&&same(actualInput.style,knowledge.style),'选中材料输入与快照不符');
   }else ensure(!actualInput.knowledge&&!actualInput.selectedMaterials,'无快照却有材料输入');
   const returned=saved[`knowledge-returned:${id}`];if(returned)ensure(returned.useHash===followupHash(v),'调用返回与输入绑定变化');
  }
 }
 // Recompute every stored material snapshot before trusting any later call binding.
 if(enabled){
  ensure(Object.keys(saved).filter(k=>k.startsWith('followup:')).every(k=>slots.some(slot=>[key(slot,'started'),key(slot,'commit')].includes(k))),'未知补查保存点');
  let parent=initial;for(const slot of slots){const commit=verifyStored(slot,parent);if(commit?.value.snapshot)parent=commit.value.snapshot;}verifyBindings();
  const plan=saved.agentPlan?.plan??saved.plan;
  const initialChapters=request.kind==='revise'?saved.requestedRevision:plan?.chapters?.map(c=>saved[`draft:${c.id}`]);
  for(const slot of slots){
   const c=slot==='planning'?{plan}:{chapters:initialChapters,issues:saved.review?.issues};
   const raw=slot==='planning'?plan?.referenceNeeds:saved.review?.referenceNeeds;
   if(saved[key(slot,'commit')]&&(slot==='planning'?plan:saved.review))ensure(saved[key(slot,'commit')].decisionHash===decisionHash(slot,raw,c),'保存提交与实际阶段产物不一致');
  }
 }
 async function terminal(slot,value,decision,start=null){
  const commit={...binding,slot,decisionHash:decision,parentSnapshotHash:current.hash,startedHash:start?followupHash(start):null,value:copy(value),valueHash:followupHash(value)};
  await persist(key(slot,'commit'),commit);records[slot]=copy(value);
 }
 async function consume(slot,raw,context={},noConsumer=false){
  if(!enabled)return;ensure(slots.includes(slot),'未知槽位');if(records[slot]){if(stopOnFailure&&['unavailable','interrupted_no_requery'].includes(records[slot].status))failScreen();return;}
  const decision=decisionHash(slot,raw,context),started=saved[key(slot,'started')],commit=verifyStored(slot,current);
  if(started){
   const original=selectNeed(raw,slot,{...context,chapters:context.initialChapters??context.chapters});
   ensure(original.status==='eligible'&&same(original.need,started.need)&&started.decisionHash===decision,'开始记录与本次需要/上下文不同');
   ensure(same(started.query,queryFor(slot,original.need,context,current)),'查询与本次范围/预算不同');
  }
  if(commit){
   ensure(commit.decisionHash===decision,'提交与本次需要/上下文不同');
   if(stopOnFailure&&['unavailable','interrupted_no_requery'].includes(commit.value.status)){
    if(typeof retrieveKnowledge!=='function')failScreen();
    const historyKey=`retrieval-failure-history:${slot}:${Object.keys(saved).filter(k=>k.startsWith(`retrieval-failure-history:${slot}:`)).length+1}`;
    await persist(historyKey,{started:copy(started),commit:copy(commit)});
    signal?.throwIfAborted();let value;
    try{const response=await retrieveKnowledge(copy(started.query),{signal});signal?.throwIfAborted();value=preparedValue(started,response,current);}
    catch(error){if(error?.code==='INVALID_HISTORY'||signal?.aborted||error?.name==='AbortError'||['CANCELLED','ABORT_ERR'].includes(error?.code))throw error;await terminal(slot,failedValue(started,'unavailable'),decision,started);failScreen();}
    await terminal(slot,value,decision,started);if(value.status==='unavailable')failScreen();current=copy(value.snapshot);known.set(current.hash,current);snapshots.push(copy(current));return;
   }
   records[slot]=copy(commit.value);if(commit.value.snapshot){current=copy(commit.value.snapshot);snapshots.push(copy(current));}return;
  }
  if(started){await terminal(slot,failedValue(started,'interrupted_no_requery'),decision,started);if(stopOnFailure)failScreen();return;}
  const selected=selectNeed(raw,slot,context);
  if(selected.status!=='eligible'){await terminal(slot,{...selected,acceptedCount:0,droppedCount:0},decision);return;}
  const need=selected.need;
  if(slot==='review'&&!noConsumer){
   if(context.chapterId!==need.target.chapterId)return;
   if(!context.consumerIssues?.some(i=>i.severity==='must_fix'&&i.evidenceVerified&&i.chapterId===need.target.chapterId&&i.quote===need.target.quote))return;
  }
  if(noConsumer||request.quoteSource){await terminal(slot,{status:'deferred_no_consumer',reason:'没有合法后续修订消费者',need,acceptedCount:0,droppedCount:0},decision);return;}
  const seen=slots.some(s=>s!==slot&&saved[key(s,'started')]&&same({question:saved[key(s,'started')].need.question,recall:saved[key(s,'started')].need.recall},{question:need.question,recall:need.recall}));
  if(seen){await terminal(slot,{status:'duplicate_need',reason:'已尝试同一需要',need,acceptedCount:0,droppedCount:0},decision);return;}
  if(current.retainedChars>=30000||typeof retrieveKnowledge!=='function'){await terminal(slot,{status:current.retainedChars>=30000?'skipped_budget':'not_connected',reason:'无可用补查预算或接口',need,acceptedCount:0,droppedCount:0},decision);return;}
  const query=queryFor(slot,need,context,current),start={...binding,slot,decisionHash:decision,parentSnapshotHash:current.hash,need,needHash:followupHash(need),query,queryHash:followupHash(query)};
  await persist(key(slot,'started'),start);signal?.throwIfAborted();
  let value;
  try{const response=await retrieveKnowledge(copy(query),{signal});signal?.throwIfAborted();value=preparedValue(start,response,current);}
  catch(error){
   if(error?.code==='INVALID_HISTORY'||signal?.aborted||error?.name==='AbortError'||['CANCELLED','ABORT_ERR'].includes(error?.code))throw error;
   // Never persist an arbitrary response that did not pass the complete packet/merge contract.
   await terminal(slot,failedValue(start,'unavailable'),decision,start);if(stopOnFailure)failScreen();return;
  }
  await terminal(slot,value,decision,start);if(stopOnFailure&&value.status==='unavailable')failScreen();current=copy(value.snapshot);known.set(current.hash,current);snapshots.push(copy(current));
 }
 return {enabled,consume,activeKnowledge:()=>packetFor(current),view:({materialDecisions,forPlanning=false}={})=>enabled?viewFor(current,materialDecisions,{forPlanning}):knowledgeForAuthor(knowledge,
  {materialDecisions:authorPolicyEnabled?materialDecisions:undefined,requireAdoptDecision:evidencePolicyEnabled&&!forPlanning}),
  finishReview:(raw,context)=>consume('review',raw,context,true),
  async bindCall(stage,user){
   if(!enabled)return;verifyBindings();stageKind(stage,user);
   const actualInput=user.originalInput??user,materialInput=actualInput.knowledge||actualInput.selectedMaterials,prefix=`knowledge-use:${stage}:`,n=Object.keys(saved).filter(k=>k.startsWith(prefix)).length+1,id=prefix+n;
   const v={...binding,...(authorPolicyEnabled?{authorMaterialPolicyVersion:AUTHOR_MATERIAL_POLICY}:{}),stage,snapshotHash:materialInput?current.hash:null,input:copy(user),inputHash:followupHash(user),neutralReview:!materialInput&&/review/i.test(stage)};
   await persist(id,v);verifyBindings();return id;
  },
  async confirmCall(id){if(enabled&&id)await persist(`knowledge-returned:${id}`,{useHash:followupHash(saved[id])});},
  summary:()=>{verifyBindings();return {policyVersion:FOLLOWUP_POLICY,initialSnapshotHash:initial.hash,activeSnapshotHash:current.hash,retainedChars:current.retainedChars,activeChars:chars(current.materials),
   slots:slots.map(slot=>({slot,...(records[slot]?{status:records[slot].status,reason:records[slot].reason,question:records[slot].need?.question,focus:records[slot].need?.recall.focus,retrievalStatus:records[slot].retrievalStatus,...(records[slot].result?.relevanceReview!==undefined?{relevanceReview:validateRelevanceSummary(records[slot].result)}:{}),limits:records[slot].result?.limits??[],delta:records[slot].delta??null,queryHash:records[slot].queryHash,snapshotHash:records[slot].snapshot?.hash,acceptedCount:records[slot].acceptedCount,droppedCount:records[slot].droppedCount}:{status:'not_requested',reason:'本任务无此触发',acceptedCount:0,droppedCount:0})})),
   snapshots:snapshots.map(s=>({hash:s.hash,parentHash:s.parentHash,activeMaterialIds:s.materials.map(m=>m.id),materials:s.materials.map(({id,title,use,sha256,references})=>({id,title,use,sha256,references})),retainedChars:s.retainedChars})),
   consumerBindings:Object.entries(saved).filter(([k])=>k.startsWith('knowledge-use:')).map(([id,v])=>({id,stage:v.stage,snapshotHash:v.snapshotHash,inputHash:v.inputHash,neutralReview:v.neutralReview,outcome:saved[`knowledge-returned:${id}`]?'response_returned':'prepared_or_unknown'})),suppliedNotAdopted:true};},
 };
}
