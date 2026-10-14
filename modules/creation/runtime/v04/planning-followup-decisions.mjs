import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {normalizeMaterialUseEvidence} from './material-use-evidence.mjs';

export const PLANNING_FOLLOWUP_DECISION_POLICY='planning-followup-decisions-1';
export const PLANNING_FOLLOWUP_DECISION_CONTRACT=`本次调用只判断最终方案之后新增的补查材料，不重写或补充故事方案。只返回一个JSON对象，且唯一顶层字段为materialDecisions。
materialDecisions必须只包含addedMaterialIds中的每个id且各一次，不得重复已有决定、遗漏、增加材料或改变id；顺序与addedMaterialIds一致。每项沿用现有材料决定合同：materialId、decision(adopt或decline)、reason、limitations。adopt还必须包含mechanism、1–3段逐字见于该材料原文块的sourceQuotes，以及指向当前plan真实章场的target={chapterNumber,sceneNumber}；decline不得包含target、mechanism或sourceQuotes。采用与拒用都须写具体限制。
当前plan的情节、章节、篇幅、心理／情绪设计、referenceNeeds和已有materialDecisions均为只读。不得新增章节、改写场景、调整篇幅、替换已有决定或声称材料已经在正文落实。只判断新增材料能否以受限机制服务当前既定方案；不能安全采用时decline。`;

const copy=structuredClone;
const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const planningFollowupDecisionHash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(canonical(value))).digest('hex');
const ensure=(ok,message)=>{if(!ok)throw Error(`规划补查材料决定无效：${message}`);};
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&isDeepStrictEqual(Object.keys(value).sort(),[...keys].sort());
const withoutDecisions=plan=>{const value=copy(plan);delete value.materialDecisions;return value;};

export function createPlanningFollowupDecisionInput({plan,knowledge,activeSnapshotHash,addedMaterialIds}){
 ensure(plan&&typeof plan==='object'&&!Array.isArray(plan)&&Array.isArray(plan.chapters)&&Array.isArray(plan.materialDecisions),'当前方案或已有材料决定缺失');
 ensure(knowledge&&typeof knowledge==='object'&&!Array.isArray(knowledge)&&Array.isArray(knowledge.materials),'当前active材料视图缺失');
 ensure(typeof activeSnapshotHash==='string'&&/^[a-f0-9]{64}$/.test(activeSnapshotHash),'active snapshot哈希无效');
 ensure(Array.isArray(addedMaterialIds)&&addedMaterialIds.length>0&&addedMaterialIds.length<=100
  &&addedMaterialIds.every(id=>typeof id==='string'&&id.length>0)&&new Set(addedMaterialIds).size===addedMaterialIds.length,'新增材料id无效');
 const byId=new Map(knowledge.materials.map(material=>[material.id,material]));
 ensure(byId.size===knowledge.materials.length&&addedMaterialIds.every(id=>byId.has(id)),'新增材料不在当前active snapshot');
 const existingIds=new Set(plan.materialDecisions.map(item=>item.materialId));
 ensure(addedMaterialIds.every(id=>!existingIds.has(id)),'新增材料已有决定，不能覆盖');
 return {policyVersion:PLANNING_FOLLOWUP_DECISION_POLICY,planSha256:planningFollowupDecisionHash(plan),activeSnapshotHash,
  addedMaterialIds:[...addedMaterialIds],plan:copy(plan),existingMaterialDecisions:copy(plan.materialDecisions),knowledge:copy(knowledge),
  newMaterials:addedMaterialIds.map(id=>copy(byId.get(id)))};
}

export function createPlanningFollowupResponseReceipt(input,rawResponse){
 ensure(input?.policyVersion===PLANNING_FOLLOWUP_DECISION_POLICY,'输入政策版本无效');
 ensure(typeof rawResponse==='string'&&rawResponse.trim(),'模型响应为空');
 return {policyVersion:PLANNING_FOLLOWUP_DECISION_POLICY,input:copy(input),inputHash:planningFollowupDecisionHash(input),
  rawResponse,responseSha256:planningFollowupDecisionHash(rawResponse)};
}

export function createPlanningFollowupDecisionStart(input){
 ensure(input?.policyVersion===PLANNING_FOLLOWUP_DECISION_POLICY,'输入政策版本无效');
 return {policyVersion:PLANNING_FOLLOWUP_DECISION_POLICY,input:copy(input),inputHash:planningFollowupDecisionHash(input)};
}

export function validatePlanningFollowupDecisionStart(start,input){
 const expected=createPlanningFollowupDecisionStart(input);
 ensure(isDeepStrictEqual(start,expected),'开始保存点的输入或哈希已变化');
 return copy(start);
}

export function validatePlanningFollowupResponseReceipt(receipt,input){
 const expected=createPlanningFollowupResponseReceipt(input,receipt?.rawResponse);
 ensure(isDeepStrictEqual(receipt,expected),'响应保存点的输入、响应或哈希已变化');
 return copy(receipt);
}

function normalizedPatch(output,input){
 ensure(exactKeys(output,['materialDecisions'])&&Array.isArray(output.materialDecisions),'输出只能包含materialDecisions数组');
 ensure(output.materialDecisions.length===input.addedMaterialIds.length,'新增材料决定数量不符');
 const byId=new Map(input.newMaterials.map(material=>[material.id,material]));
 return output.materialDecisions.map((item,index)=>{
  const common=['materialId','decision','reason','limitations'];
  const keys=item?.decision==='adopt'?[...common,'mechanism','sourceQuotes','target']:common;
  ensure(exactKeys(item,keys),'材料决定字段越界或缺失');
  ensure(item.materialId===input.addedMaterialIds[index]&&byId.has(item.materialId),'决定id、顺序或材料绑定不符');
  ensure(typeof item.reason==='string'&&item.reason.trim()&&Array.isArray(item.limitations),'决定理由或限制缺失');
  const base={materialId:item.materialId,decision:item.decision,reason:item.reason.trim(),limitations:item.limitations.map(value=>typeof value==='string'?value.trim():value),status:'author_declared_not_text_verified'};
  return {...base,...normalizeMaterialUseEvidence(item,byId.get(item.materialId),input.plan.chapters)};
 });
}

export function createPlanningFollowupDecisionCommit({input,responseReceipt,output,normalizePlan}){
 validatePlanningFollowupResponseReceipt(responseReceipt,input);
 ensure(typeof normalizePlan==='function','缺少当前任务方案归一化器');
 const patch=normalizedPatch(output,input);
 const merged={...copy(input.plan),materialDecisions:[...copy(input.existingMaterialDecisions),...patch]};
 const plan=normalizePlan(merged);
 ensure(isDeepStrictEqual(withoutDecisions(plan),withoutDecisions(input.plan)),'受限决定阶段改变了方案情节、篇幅或其他规划字段');
 ensure(isDeepStrictEqual(plan.materialDecisions.slice(0,input.existingMaterialDecisions.length),input.existingMaterialDecisions),'已有材料决定被改变');
 ensure(isDeepStrictEqual(plan.materialDecisions.slice(input.existingMaterialDecisions.length),patch),'新增材料决定归一化结果不一致');
 return {policyVersion:PLANNING_FOLLOWUP_DECISION_POLICY,inputHash:responseReceipt.inputHash,responseSha256:responseReceipt.responseSha256,
  beforePlanSha256:input.planSha256,afterPlanSha256:planningFollowupDecisionHash(plan),activeSnapshotHash:input.activeSnapshotHash,
  addedMaterialIds:[...input.addedMaterialIds],materialDecisions:copy(patch),plan:copy(plan)};
}

export function validatePlanningFollowupDecisionCommit(commit,args){
 const expected=createPlanningFollowupDecisionCommit(args);
 ensure(isDeepStrictEqual(commit,expected),'决定提交的方案、决定、输入或输出绑定已变化');
 return copy(commit);
}
