import test from 'node:test';
import assert from 'node:assert/strict';
import {runWorkflow} from '../workflow.mjs';
import {retrievalQuery,validateReferenceQuestion} from './knowledge.mjs';
const request={kind:'create',idea:'合成接口测试：写一位渡船工完成最后一次摆渡，3000字3章。',context:{instruction:'保留人物选择与结局，不借用来源人物。'},materials:[],sourceIds:['fixture-source']};
const ready={summary:'完成最后一次摆渡',genre:'当代',pointOfView:'第三人称限制',setting:'渡口',targetHanMin:3000,targetHanMax:3000,targetChapterCount:3,requiredElements:['实际完成工作','对过去的理解改变但不免除责任'],prohibitions:['不复制来源人物'],assumptions:[],usesChapter4Cut:false,completeEnding:true};
const question='怎样用完成日常工作的行动组织情绪变化，而不是只用心理独白解释？';
const expectedSources=[{path:'/idea',text:request.idea},{path:'/context/instruction',text:request.context.instruction}];
const stop=Error('fixed stop');
async function capture({input=request,responses=[ready],key='requestSpec',connected=true}={}){
 const artifacts={},calls=[],queries=[];
 const opts={request:input,model:{complete:async a=>{calls.push(a);assert.ok(calls.length<=responses.length);return JSON.stringify(responses[calls.length-1]);}},checkpoint:async(k,v)=>{artifacts[k]=structuredClone(v);if(k===key)throw stop;}};
 if(connected)opts.retrieveKnowledge=async q=>{queries.push(structuredClone(q));return {contractVersion:'v04-contract-1',packetId:'mock-empty',query:structuredClone(q),status:'uncovered',materials:[],candidates:[],usedChars:0,limits:['固定空响应，不是来源判断']};};
 await assert.rejects(runWorkflow(opts),e=>e===stop);return {artifacts,calls,queries};
}
test('strict referenceQuestion boundaries, including no silent trimming',()=>{
 for(const x of [null,0,false,[],{},'', ' ', ' q','q ','q\n','字'.repeat(241)])assert.throws(()=>validateReferenceQuestion(x),/referenceQuestion/);
 for(const x of ['问','字'.repeat(240),question])assert.equal(validateReferenceQuestion(x),x);
});
test('new primary question uses same requirements call; request/context and all specifications survive',async()=>{
 const r=await capture({responses:[{...ready,referenceQuestion:question,retrievalHints:{focus:'scene',queries:[]}}],key:'knowledge'});
 assert.equal(r.calls.length,1);assert.equal(r.calls[0].stage,'requirements');assert.equal(r.calls[0].maxTokens,2500);assert.match(r.calls[0].system,/referenceQuestion/);
 const sent=JSON.parse(r.calls[0].user);assert.equal(sent.idea,request.idea);assert.deepEqual(sent.context,request.context);
 assert.equal(r.queries[0].query,question);assert.deepEqual(JSON.parse(r.queries[0].context).targetUse.requirements,ready);assert.deepEqual(r.queries[0].recall,{focus:'scene',queries:[]});
 const {referenceQuestion:q,retrievalHints:h,...kept}=r.artifacts.requestSpec.requirements;assert.deepEqual(kept,{...ready,userRequirementSources:expectedSources});assert.equal(q,question);
});
test('all invalid fields enter one existing repair; double invalid cannot save requirements',async()=>{
 for(const value of [null,0,false,[],{},'', ' ', ' q','q ','字'.repeat(241)]){
  const r=await capture({responses:[{...ready,referenceQuestion:value},{...ready,referenceQuestion:question}]});assert.deepEqual(r.calls.map(x=>x.stage),['requirements','requirements:repair']);
  const repair=JSON.parse(r.calls[1].user);assert.match(repair.fieldErrors,/referenceQuestion/);assert.deepEqual(repair.originalRequest.context,request.context);
 }
 let calls=0;await assert.rejects(runWorkflow({request,model:{complete:async()=>{calls++;return JSON.stringify({...ready,referenceQuestion:null});}},checkpoint:async()=>assert.fail('no success')}),/连续两次/);assert.equal(calls,2);
});
test('absent reference question preserves legacy query while new normalization records exact sources',async()=>{
 const r=await capture();assert.deepEqual(r.artifacts.requestSpec.requirements,{...ready,userRequirementSources:expectedSources});assert.deepEqual(retrievalQuery(request,ready,30000),{contractVersion:'v04-contract-1',evidenceType:'narrative',query:'完成最后一次摆渡\n合成接口测试：写一位渡船工完成最后一次摆渡，3000字3章。\n人物经历如何改变认知、行动与表达；场景情绪积累及前后回应',stage:'planning',context:JSON.stringify({summary:ready.summary,genre:ready.genre,setting:ready.setting,pointOfView:ready.pointOfView,requiredElements:ready.requiredElements,prohibitions:ready.prohibitions}),budget:{maxCandidates:20,maxUnits:6,maxChars:12000},sourceIds:['fixture-source']});
 const unconnected=await capture({connected:false});assert.doesNotMatch(unconnected.calls[0].system,/referenceQuestion/);
});
test('expression and pure fact questions are passed verbatim without topic fallback or hidden extra purpose',()=>{
 for(const q of [question,'摆渡船发动机冷却水异常时应核对哪些厂家规定的事实？']){
  const req={...ready,referenceQuestion:q};const result=retrievalQuery(request,req,19);assert.equal(result.query,q);assert.equal(result.budget.maxChars,19);assert.deepEqual(result.sourceIds,request.sourceIds);
  assert.equal(result.stage,'planning');assert.equal(Object.hasOwn(result,'recall'),false);assert.deepEqual(JSON.parse(result.context).targetUse.requirements,ready);
 }
 const rq=retrievalQuery({...request,kind:'revise',instruction:'修改',chapters:[{id:'ch-1',body:'旧稿'}]},{...ready,referenceQuestion:question},17);assert.equal(rq.stage,'revision');assert.equal(rq.query,question);
});
test('new context retains long complete constraints or rejects oversized input without slicing',()=>{
 const extended={...ready,requiredElements:['完整条件'.repeat(1600)],referenceQuestion:question};const q=retrievalQuery(request,extended,30000);assert.ok(q.context.length>6000);assert.deepEqual(JSON.parse(q.context).targetUse.requirements.requiredElements,extended.requiredElements);
 assert.throws(()=>retrievalQuery(request,{...extended,requiredElements:['条件'.repeat(4500)]},30000),/8000/);
});
test('newly generated default and question-bearing snapshots resume without requirement calls or requery, preserving saved snapshots',async()=>{
 for(const req of [ready,{...ready,referenceQuestion:question}]){
  const {artifacts}=await capture({responses:[req],key:'knowledge'}),before=structuredClone(artifacts);let n=0;
  await assert.rejects(runWorkflow({request,artifacts,retrieveKnowledge:async()=>assert.fail('no requery'),model:{complete:async a=>{n++;assert.equal(a.stage,'planning');const sent=JSON.parse(a.user);assert.deepEqual(sent.requirements,{...req,userRequirementSources:expectedSources});throw stop;}}}),e=>e===stop);
  assert.equal(n,1);assert.deepEqual(artifacts,before);
 }
});
test('exhausted shared budget prevents retrieval even with a primary question',async()=>{
 const r=await capture({input:{...request,materials:[{id:'selected',content:'字'.repeat(30000)}]},responses:[{...ready,referenceQuestion:question}],key:'knowledge'});assert.equal(r.queries.length,0);assert.equal(r.artifacts.knowledge.retrieval.status,'skipped_budget');
});
