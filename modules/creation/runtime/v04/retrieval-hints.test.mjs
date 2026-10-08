import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runWorkflow} from '../workflow.mjs';
import {retrievalQuery,validateRecall,validateRetrieval,knowledgeForAuthor} from './knowledge.mjs';
import {freezeRetrieval,inspectFrozenKnowledge} from './check-retrieval.mjs';
const request={kind:'create',idea:'合成联调需求，非用户创作：修钟师归还旧钟，3000字3章。',context:{},materials:[]};
const ready={summary:'合成联调需求，非用户创作',genre:'当代',pointOfView:'第三人称',setting:'旧街',targetHanMin:3000,targetHanMax:3000,targetChapterCount:3,requiredElements:[],prohibitions:[],assumptions:[],usesChapter4Cut:false,completeEnding:true};
const hints={focus:'echo',queries:['归还物品时兑现旧承诺','从拒绝到主动交还的行动变化']};
const hash=v=>createHash('sha256').update(v).digest('hex');
const stop=new Error('checkpoint stop');
const packet=q=>({contractVersion:'v04-contract-1',packetId:'SYNTHETIC_HINT_TEST',query:structuredClone(q),status:'matched',materials:[{id:'raw',title:'合成材料',kind:'retrieved',use:'raw_reference',content:'他把旧钟交还给客人。',sha256:hash('他把旧钟交还给客人。'),references:[{sourceId:'synthetic',sourceSha256:hash('合成来源'),textVersion:'t1',analysisVersion:'a1',unitIds:[],lineStart:1,lineEnd:1}],selectionReason:'仅合同测试',limitations:['合成非复核']}],candidates:[],usedChars:'他把旧钟交还给客人。'.length,limits:['仅工程验证']});
async function capture({input=request,responses=[ready],connected=true,key='requestSpec'}={}){
 const artifacts={},calls=[],queries=[];
 const options={request:input,model:{complete:async args=>{calls.push(args);assert.ok(calls.length<=responses.length);return JSON.stringify(responses[calls.length-1]);}},checkpoint:async(k,v)=>{artifacts[k]=v;if(k===key)throw stop;}};
 if(connected)options.retrieveKnowledge=async q=>{queries.push(structuredClone(q));return packet(q);};
 await assert.rejects(runWorkflow(options),e=>e===stop);
 return {artifacts,calls,queries};
}
const bad=[null,[],{}, {focus:'scene'}, {queries:[]},{focus:'all',queries:[]},{focus:'scene',queries:[],extra:1}, {focus:'scene',queries:'x'},{focus:'scene',queries:['']},{focus:'scene',queries:[' x']},{focus:'scene',queries:['x ']},{focus:'scene',queries:['x','x']},{focus:'scene',queries:[1]},{focus:'scene',queries:['字'.repeat(121)]},{focus:'scene',queries:['a','b','c','d']}];
test('strict recall object requires exact keys, unique bounded already-trimmed strings',()=>{
 for(const v of bad)assert.throws(()=>validateRecall(v),/recall/);
 for(const focus of ['scene','ending','echo'])for(const queries of [[],['字'.repeat(120)],['a','b','c']])assert.deepEqual(validateRecall({focus,queries}),{focus,queries});
 assert.throws(()=>validateRecall(new Date()),/recall/);
});
test('new hints remain within the existing 2500-token requirements call and preserve actual query and checkpoint',async()=>{
 const {artifacts,calls,queries}=await capture({responses:[{...ready,retrievalHints:hints}],key:'knowledge'});
 assert.equal(calls.length,1);assert.equal(calls[0].stage,'requirements');assert.equal(calls[0].maxTokens,2500);assert.match(calls[0].system,/retrievalHints/);
 assert.equal(queries.length,1);assert.deepEqual(queries[0].recall,hints);assert.deepEqual(queries[0].budget,{maxCandidates:20,maxUnits:6,maxChars:12000});
 assert.deepEqual(artifacts.requestSpec.requirements.retrievalHints,hints);assert.deepEqual(artifacts.knowledge.retrieval.query,queries[0]);
 const view=knowledgeForAuthor(artifacts.knowledge);assert.deepEqual(view.recall,hints);view.recall.queries.push('no leak');assert.deepEqual(artifacts.knowledge.retrieval.query.recall,hints);
 const frozen=await freezeRetrieval({request,requirements:artifacts.requestSpec.requirements,result:packet(queries[0])});assert.deepEqual(inspectFrozenKnowledge(JSON.parse(JSON.stringify(frozen))).authorView.recall,hints);
});
test('absent hints preserve legacy query and explicitly add source records to new requirements; unconnected prompt has no hint contract',async()=>{
 const expected={...ready,userRequirementSources:[{path:'/idea',text:request.idea}]};
 const plain=await capture({connected:false}),connected=await capture();assert.deepEqual(plain.artifacts.requestSpec.requirements,expected);assert.deepEqual(connected.artifacts.requestSpec.requirements,expected);
 assert.doesNotMatch(plain.calls[0].system,/retrievalHints/);assert.match(connected.calls[0].system,/retrievalHints/);
 const q=retrievalQuery(request,ready,30000);assert.equal(Object.hasOwn(q,'recall'),false);assert.equal(Object.hasOwn(knowledgeForAuthor({materials:[],style:null,limits:[]}), 'recall'),false);
 assert.deepEqual(retrievalQuery(request,{...ready,retrievalHints:undefined},30000),q);
 const fresh=retrievalQuery(request,{...ready,retrievalHints:hints},30000);delete fresh.recall;assert.deepEqual(fresh,q);
});
test('every malformed hint enters existing single repair; two failures never save success',async()=>{
 for(const value of bad){const result=await capture({responses:[{...ready,retrievalHints:value},ready]});assert.deepEqual(result.calls.map(c=>c.stage),['requirements','requirements:repair']);assert.match(JSON.parse(result.calls[1].user).fieldErrors,/recall\/retrievalHints/);assert.equal(Object.hasOwn(result.artifacts.requestSpec.requirements,'retrievalHints'),false);}
 let n=0;await assert.rejects(runWorkflow({request,model:{complete:async()=>{n++;return JSON.stringify({...ready,retrievalHints:null});}},checkpoint:async()=>assert.fail('invalid checkpoint')}),/连续两次/);assert.equal(n,2);
});
test('both recall sides are strict and binding cannot change hints or add/drop fields',()=>{
 const q=retrievalQuery(request,{...ready,retrievalHints:hints},30000);
 for(const v of bad){assert.throws(()=>validateRetrieval(packet({...q,recall:v}),q),/recall/);assert.throws(()=>validateRetrieval(packet(q),{...q,recall:v}),/recall/);}
 const changed=packet({...q,recall:{focus:'scene',queries:[]}});assert.throws(()=>validateRetrieval(changed,q),/实际查询/);
 const old=retrievalQuery(request,ready,30000);assert.throws(()=>validateRetrieval(packet(old),q),/实际查询/);assert.throws(()=>validateRetrieval(packet(q),old),/实际查询/);
});
test('revision preserves original stage, context, source scope and remaining budget',async()=>{
 const input={kind:'revise',instruction:'合成联调需求：修改归还旧钟时的前后呼应。',chapters:[{id:'ch-1',body:'合成旧稿。'}],sourceIds:['source-a','source-a'],materials:[]};
 const fixed={...ready,targetHanMin:null,targetHanMax:null,retrievalHints:{focus:'ending',queries:['归还物品后关系如何结束']}};
 const {artifacts,calls}=await capture({input,responses:[fixed]});assert.equal(calls.length,1);assert.equal(artifacts.requestSpec.requirements.targetChapterCount,1);
 const q=retrievalQuery(input,artifacts.requestSpec.requirements,17),old=retrievalQuery(input,{...artifacts.requestSpec.requirements,retrievalHints:undefined},17);const {recall,...unchanged}=q;assert.deepEqual(unchanged,old);assert.equal(q.stage,'revision');assert.equal(q.budget.maxChars,17);assert.deepEqual(q.sourceIds,['source-a']);assert.equal(recall.focus,'ending');
});
test('legacy and hint-bearing checkpoints resume without requirements calls or requery and expose frozen author view',async()=>{
 for(const req of [ready,{...ready,retrievalHints:hints}]){
  const {artifacts}=await capture({responses:[req],key:'knowledge'});const before=structuredClone(artifacts);let planning=0;
  await assert.rejects(runWorkflow({request,artifacts,retrieveKnowledge:async()=>assert.fail('no requery'),model:{complete:async args=>{assert.equal(args.stage,'planning');planning++;const payload=JSON.parse(args.user);assert.deepEqual(payload.knowledge.recall,req.retrievalHints);throw stop;}}}),e=>e===stop);
  assert.equal(planning,1);assert.deepEqual(artifacts,before);
 }
});

test('hints cannot enlarge the remaining shared budget or trigger retrieval when it is exhausted',async()=>{
 const input={...request,materials:[{id:'selected',content:'字'.repeat(30000)}]};
 const {artifacts,calls,queries}=await capture({input,responses:[{...ready,retrievalHints:hints}],key:'knowledge'});
 assert.equal(calls.length,1);assert.equal(queries.length,0);assert.equal(artifacts.knowledge.retrieval.status,'skipped_budget');
 const q=retrievalQuery(request,{...ready,retrievalHints:hints},5),result=packet(q);
 assert.equal(q.budget.maxChars,5);assert.throws(()=>validateRetrieval(result,q),/字符预算/);
});
