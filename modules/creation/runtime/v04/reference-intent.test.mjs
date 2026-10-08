import test from 'node:test';
import assert from 'node:assert/strict';
import {runWorkflow} from '../workflow.mjs';
import {retrievalQuery,validateRetrieval} from './knowledge.mjs';
import {validateReferenceIntent} from './reference-intent.mjs';
const request={kind:'create',idea:'合成题：完成搬迁任务；人物收到信息后改变选择但不免除对方责任。',context:{instruction:'保持已发生事件、人物年龄与时间先后，3000字3章。'},materials:[]};
const req={summary:'搬迁中的选择',genre:'当代',pointOfView:'第三人称',setting:'小城',targetHanMin:3000,targetHanMax:3000,targetChapterCount:3,requiredElements:['完成搬迁','保留责任','人物年龄与时间先后一致'],prohibitions:['不照抄来源'],assumptions:[],usesChapter4Cut:false,completeEnding:true};
const question='新信息怎样通过后续行动改变理解而不取消责任？';
const intent={purpose:'expression',evidenceNeeds:['先前理解或选择','新信息与后续行动的关系','仍保留责任的文本依据'],contextNeeds:['信息出现前后同一人物的对照'],basis:['/idea','/context/instruction']};
const expectedSources=[{path:'/idea',text:request.idea},{path:'/context/instruction',text:request.context.instruction}];
const stop=Error('capture');
async function capture(responses,key='requestSpec') { const artifacts={},calls=[],queries=[];await assert.rejects(runWorkflow({request,model:{complete:async a=>{calls.push(a);assert.ok(calls.length<=responses.length);return JSON.stringify(responses[calls.length-1]);}},retrieveKnowledge:async q=>{queries.push(q);return {contractVersion:'v04-contract-1',packetId:'fixture-empty',query:structuredClone(q),status:'uncovered',materials:[],candidates:[],usedChars:0,limits:['工程空响应']};},checkpoint:async(k,v)=>{artifacts[k]=v;if(k===key)throw stop;}}),e=>e===stop);return {artifacts,calls,queries}; }
test('strict purpose, evidence, context and original-input basis; no mixed catch-all',()=>{
 for(const bad of [null,{}, {...intent,extra:1},{...intent,purpose:'mixed'},{...intent,evidenceNeeds:[]},{...intent,evidenceNeeds:['含糊','含糊']},{...intent,contextNeeds:[' x']},{...intent,basis:['/context/priorDraft']},{...intent,basis:['/instruction']},{...intent,basis:[]}])assert.throws(()=>validateReferenceIntent(bad,{question,request}),/referenceIntent/);
 assert.throws(()=>validateReferenceIntent(intent,{request}),/referenceQuestion/);assert.deepEqual(validateReferenceIntent(intent,{question,request}),intent);
});
test('one requirements call carries new structure and unchanged original context; malformed needs one existing repair',async()=>{
 const normal={...req,referenceQuestion:question,referenceIntent:intent};const x=await capture([normal],'knowledge');assert.equal(x.calls.length,1);assert.equal(x.calls[0].maxTokens,2500);assert.deepEqual(JSON.parse(x.calls[0].user).context,request.context);assert.equal(x.queries.length,1);assert.deepEqual(x.artifacts.requestSpec.requirements,{...normal,userRequirementSources:expectedSources});
 const bad={...normal,referenceIntent:{...intent,purpose:'mixed'}};const fixed=await capture([bad,normal]);assert.deepEqual(fixed.calls.map(a=>a.stage),['requirements','requirements:repair']);assert.match(JSON.parse(fixed.calls[1].user).fieldErrors,/referenceIntent/);
 let n=0;await assert.rejects(runWorkflow({request,model:{complete:async()=>{n++;return JSON.stringify(bad);}},checkpoint:async()=>assert.fail()}),/连续两次/);assert.equal(n,2);
});
test('single expression/fact purposes keep all constraints; performance uses existing evidenceType',()=>{
 for(const purpose of ['expression','facts','performance']){const r={...req,referenceQuestion:question,referenceIntent:{...intent,purpose}},q=retrievalQuery(request,r,11),context=JSON.parse(q.context);assert.equal(q.query,question);assert.equal(q.budget.maxChars,11);assert.equal(context.referenceNeed.purpose,purpose);assert.deepEqual(context.referenceNeed.evidenceNeeds,intent.evidenceNeeds);assert.deepEqual(context.targetUse.requirements,req);assert.equal(q.evidenceType,purpose==='performance'?'performance':'narrative');}
 // Deliberately mismatched text still passes structure. This is not a semantic classifier.
 const q=retrievalQuery(request,{...req,referenceQuestion:'事实问题',referenceIntent:{...intent,purpose:'facts'}},30000);assert.equal(q.query,'事实问题');
});
test('newly generated default, question-only and intent-bearing snapshots restore without requery or requirement regeneration',async()=>{
 for(const r of [req,{...req,referenceQuestion:question},{...req,referenceQuestion:question,referenceIntent:intent}]){const x=await capture([r],'knowledge'),before=structuredClone(x.artifacts);await assert.rejects(runWorkflow({request,artifacts:x.artifacts,retrieveKnowledge:async()=>assert.fail('no requery'),model:{complete:async a=>{assert.equal(a.stage,'planning');const v=JSON.parse(a.user);assert.deepEqual(v.request.context,request.context);assert.deepEqual(v.requirements,{...r,userRequirementSources:expectedSources});throw stop;}}}),e=>e===stop);assert.deepEqual(x.artifacts,before);}
});
test('no implicit multi-query, source scope/budget unchanged, oversized context rejected',()=>{
 const r={...req,referenceQuestion:question,referenceIntent:intent},q=retrievalQuery({...request,sourceIds:['one','one']},r,7);assert.deepEqual(q.sourceIds,['one']);assert.deepEqual(q.budget,{maxCandidates:20,maxUnits:6,maxChars:7});assert.equal(Object.hasOwn(q,'queries'),false);assert.equal(Object.hasOwn(q,'recall'),false);
 assert.throws(()=>retrievalQuery(request,{...r,requiredElements:['字'.repeat(9000)]},30000),/8000/);
 const perf=retrievalQuery(request,{...r,referenceIntent:{...intent,purpose:'performance'}},30000);assert.throws(()=>validateRetrieval({contractVersion:'v04-contract-1',packetId:'x',query:perf,status:'matched',materials:[{}],candidates:[],usedChars:0,limits:[]},perf),/performance/);
});
