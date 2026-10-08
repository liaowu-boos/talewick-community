import test from 'node:test';
import assert from 'node:assert/strict';
import {runWorkflow} from '../workflow.mjs';
import {compileReferenceStrategy} from './reference-strategy.mjs';

const stop=Error('bounded capture');
const request={kind:'create',idea:'写宇航员在维修中重新理解搭档过去的隐瞒，3000字3章。',context:{instruction:'保留失重环境、原有时间线和完整结局。',priorDraft:'旧方案：必须原谅父亲。'},sourceIds:['synthetic-library']};
const ready={summary:request.idea,genre:'科幻',pointOfView:'第三人称',setting:'空间站',targetHanMin:3000,targetHanMax:3000,targetChapterCount:3,requiredElements:[request.idea,request.context.instruction],prohibitions:[],assumptions:[],usesChapter4Cut:false,completeEnding:true};
const choice={status:'selected',mechanism:'reinterpret_past_action',basis:'/idea',quote:'重新理解搭档过去的隐瞒',reason:'明确要求重新理解过去行为'};
async function capture(responses,key='knowledge') {
 const saved={},calls=[],queries=[];
 await assert.rejects(runWorkflow({request,model:{complete:async input=>{calls.push(input);assert.ok(calls.length<=responses.length);return JSON.stringify(responses[calls.length-1]);}},
  retrieveKnowledge:async query=>{queries.push(structuredClone(query));return {contractVersion:'v04-contract-1',packetId:'synthetic-empty',query,status:'uncovered',materials:[],candidates:[],usedChars:0,limits:['仅供接口验证的空库']};},
  checkpoint:async(k,v)=>{saved[k]=structuredClone(v);if(k===key)throw stop;}}),e=>e===stop);
 return {saved,calls,queries};
}
test('same requirements call compiles selected mechanism; target and original instructions survive unchanged',async()=>{
 const x=await capture([{...ready,referenceStrategy:choice}]);
 assert.equal(x.calls.length,1);assert.equal(x.calls[0].stage,'requirements');
 assert.match(x.calls[0].system,/referenceStrategy/);
 assert.equal(JSON.parse(x.calls[0].user).referenceOnlyContext[0].value,request.context.priorDraft);
 assert.equal(x.queries.length,1);assert.equal(x.queries[0].query,compileReferenceStrategy(choice,request).referenceQuestion);
 assert.deepEqual(JSON.parse(x.queries[0].context).targetUse.requirements,ready);
 assert.equal(x.queries[0].recall,undefined);assert.deepEqual(x.queries[0].sourceIds,request.sourceIds);
 const r=x.saved.requestSpec.requirements;assert.deepEqual(r.requiredElements,ready.requiredElements);
 assert.equal(r.userRequirementSources.find(s=>s.path==='/idea').text,request.idea);
 assert.equal(r.referenceStrategy.origin,'model_selected_program_template');
});
test('invented quotation, extra condition and competing freeform query cannot become a saved search',async()=>{
 for(const bad of [{...choice,quote:'必须原谅父亲'}, {...choice,condition:'必须宇航员'}]) {
  const x=await capture([{...ready,referenceStrategy:bad},{...ready,referenceStrategy:choice}]);
  assert.deepEqual(x.calls.map(c=>c.stage),['requirements','requirements:repair']);assert.equal(x.queries.length,1);
 }
 const x=await capture([{...ready,referenceStrategy:choice,referenceQuestion:'必须找到空间站故事'},{...ready,referenceStrategy:choice}]);
 assert.match(JSON.parse(x.calls[1].user).fieldErrors,/不能.*并存/);assert.equal(x.queries.length,1);
});
test('saved typed requirements resume without reselection or requery and reach author with complete specifications',async()=>{
 const x=await capture([{...ready,referenceStrategy:choice}]),before=structuredClone(x.saved);
 await assert.rejects(runWorkflow({request,artifacts:x.saved,retrieveKnowledge:async()=>assert.fail('no requery'),model:{complete:async input=>{
  assert.equal(input.stage,'planning');const v=JSON.parse(input.user);
  assert.deepEqual(v.requirements,x.saved.requestSpec.requirements);assert.deepEqual(v.request.context,request.context);throw stop;
 }}}),e=>e===stop);
 assert.deepEqual(x.saved,before);
});
test('specific facts stay on original question route; absence does not force a mechanism',async()=>{
 const q='空间站某型号设备的允许检修扭矩是多少？';
 const x=await capture([{...ready,referenceQuestion:q,referenceIntent:{purpose:'facts',basis:['/idea'],evidenceNeeds:['该型号手册的明确扭矩规格'],contextNeeds:[]}}]);
 assert.equal(x.queries[0].query,q);assert.equal(x.saved.requestSpec.requirements.referenceStrategy,undefined);
 assert.equal(JSON.parse(x.queries[0].context).referenceNeed.purpose,'facts');
});
