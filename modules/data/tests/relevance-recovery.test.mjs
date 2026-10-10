import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {packRelevanceInput,expandRelevanceInput} from '../runtime/relevance-payload.mjs';
import {RELEVANCE_VERSION,RELEVANCE_SYSTEM,assessPreparedRelevance,incompleteRelevanceCoverage} from '../runtime/relevance.mjs';
import {createLibraryService} from '../runtime/library.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
function prepared(count=12){
 const candidates=Array.from({length:count},(_,i)=>{
  const content=`【原文参考；不作为已发布分析】\n候选${i}的完整原文。`;
  return {candidateId:`candidate-${i}`,use:'raw_reference',sourceId:`source-${i}`,sourceSha256:hash(`source-${i}`),textVersion:`text-${i}`,analysisVersion:`analysis-${i}`,indexVersion:'library-index-3.3',preparedMaterialId:`material-${i}`,content,contentSha256:hash(content),references:[{sourceId:`source-${i}`,sourceSha256:hash(`source-${i}`),textVersion:`text-${i}`,analysisVersion:`analysis-${i}`,lineStart:1,lineEnd:1}],limitations:[]};
 });
 const input={schemaVersion:RELEVANCE_VERSION,query:{query:'某人物获知新信息后重解另一人旧事',context:'表达机制参考'},candidates};
 const modelInput=packRelevanceInput(input),inputHash=hash(JSON.stringify(modelInput));
 return {input,modelInput,inputHash,user:JSON.stringify({inputHash,...modelInput}),system:RELEVANCE_SYSTEM};
}
function reply(user,{dropLast=false,type=false,badHash=false,badEvidence=false,reverse=false}={}){
 const {inputHash,...wire}=JSON.parse(user),input=expandRelevanceInput(wire);
 const selected=dropLast?input.candidates.slice(0,-1):input.candidates;
 const decisions=selected.map(c=>({candidateId:c.candidateId,relevance:'irrelevant',reason:'该窗无所问关系链'}));
 if(badEvidence&&decisions.length)decisions[0]={candidateId:decisions[0].candidateId,relevance:'usable',reason:'伪证据',evidenceIds:['999']};
 if(reverse)decisions.reverse();
 return JSON.stringify({inputHash:badHash?'f'.repeat(64):inputHash,decisions,...(type?{type:'json_object'}:{})});
}

test('pure 11/12 coverage gap rechecks all twelve in three separately bound groups',async()=>{
 const p=prepared(),calls=[],events=[];
 const result=await assessPreparedRelevance(p,{normalGroupSize:20,assessRelevance:async request=>{calls.push(request);return reply(request.user,{dropLast:calls.length===1});},onAttempt:async event=>events.push(event)});
 assert.equal(result.recovered,true);assert.equal(result.decisions.length,12);assert.equal(calls.length,4);
 assert.deepEqual(calls.slice(1).map(c=>expandRelevanceInput((({inputHash,...wire})=>wire)(JSON.parse(c.user))).candidates.length),[4,4,4]);
 assert.equal(new Set(calls.map(c=>JSON.parse(c.user).inputHash)).size,4);
 assert.deepEqual(events.find(e=>e.phase==='incomplete').missingCandidateIds,['candidate-11']);
 assert.equal(events.filter(e=>e.phase==='response').length,4);
 assert.equal(events.filter(e=>e.phase==='validated').length,3);
});

test('known JSON type with a pure gap can recover; mixed bad evidence and gap cannot',async()=>{
 const p=prepared();let calls=0;
 assert.deepEqual(incompleteRelevanceCoverage(reply(p.user,{dropLast:true,type:true}),p),['candidate-11']);
 assert.equal(incompleteRelevanceCoverage(reply(p.user,{dropLast:true,badEvidence:true}),p),null);
 const okay=await assessPreparedRelevance(p,{normalGroupSize:20,assessRelevance:async request=>{calls++;return reply(request.user,{dropLast:calls===1,type:calls===1});}});
 assert.equal(okay.decisions.length,12);assert.equal(calls,4);
 calls=0;
 await assert.rejects(assessPreparedRelevance(p,{normalGroupSize:20,assessRelevance:async request=>{calls++;return reply(request.user,{dropLast:true,badEvidence:true});}}));
 assert.equal(calls,1);
});

test('a failed recovery group never supplies a partial decision set',async()=>{
 const p=prepared();let calls=0;
 await assert.rejects(assessPreparedRelevance(p,{normalGroupSize:20,assessRelevance:async request=>{calls++;return reply(request.user,{dropLast:calls===1,badHash:calls===3});}}));
 assert.equal(calls,3);
});

test('initial call and recovery share one deadline; group does not restart timeout',async()=>{
 const p=prepared(),events=[];let calls=0,secondStart=0;
 const started=Date.now();
 await assert.rejects(assessPreparedRelevance(p,{timeoutMs:220,normalGroupSize:20,assessRelevance:async(request,{signal})=>{
  calls++;
  if(calls===1){await new Promise(resolve=>setTimeout(resolve,130));return reply(request.user,{dropLast:true});}
  secondStart=Date.now();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 },onAttempt:async event=>events.push(event)}),{code:'RELEVANCE_DEADLINE'});
 assert.equal(calls,2);assert(secondStart-started>=100);assert(Date.now()-secondStart<160);
 assert(events.some(e=>e.kind==='recovery'&&e.phase==='failed'&&e.errorCode==='RELEVANCE_DEADLINE'));
});

test('caller cancellation during recovery prevents later groups',async()=>{
 const p=prepared(),controller=new AbortController();let calls=0;
 await assert.rejects(assessPreparedRelevance(p,{signal:controller.signal,normalGroupSize:20,assessRelevance:async request=>{
  calls++;if(calls===1)return reply(request.user,{dropLast:true});
  controller.abort(Error('cancelled by caller'));return new Promise(()=>{});
 }}),/cancelled by caller/);
 assert.equal(calls,2);
});

test('twelve candidates use three normal groups and canonical original order',async()=>{
 const p=prepared(),calls=[],events=[];
 const result=await assessPreparedRelevance(p,{assessRelevance:async request=>{calls.push(request);return reply(request.user,{reverse:true});},onAttempt:async event=>events.push(event)});
 assert.equal(result.grouped,true);assert.equal(result.recovered,false);assert.equal(calls.length,3);
 assert.deepEqual(result.decisions.map(d=>d.candidateId),p.input.candidates.map(c=>c.candidateId));
 assert.deepEqual(calls.map(c=>expandRelevanceInput((({inputHash,...wire})=>wire)(JSON.parse(c.user))).candidates.length),[4,4,4]);
 assert.equal(events.filter(e=>e.kind==='normal'&&e.phase==='response').length,3);
 assert.equal(events.filter(e=>e.phase==='incomplete').length,0);
});

test('normal-group pure gaps re-evaluate every item only within each group, bounded at fifteen calls',async()=>{
 const p=prepared(20),calls=[];
 const result=await assessPreparedRelevance(p,{assessRelevance:async request=>{
  calls.push(request);const count=expandRelevanceInput((({inputHash,...wire})=>wire)(JSON.parse(request.user))).candidates.length;
  return reply(request.user,{dropLast:count===4});
 }});
 assert.equal(result.grouped,true);assert.equal(result.recovered,true);assert.equal(result.decisions.length,20);assert.equal(calls.length,15);
 assert.deepEqual(calls.map(c=>expandRelevanceInput((({inputHash,...wire})=>wire)(JSON.parse(c.user))).candidates.length),Array.from({length:5},()=>[4,2,2]).flat());
});

test('a truncated normal-group JSON is rebound to smaller complete groups',async()=>{
 const p=prepared(),calls=[],events=[];
 const result=await assessPreparedRelevance(p,{assessRelevance:async request=>{
  calls.push(request);
  if(calls.length===2)return '{"inputHash":"truncated';
  return reply(request.user);
 },onAttempt:async event=>events.push(event)});
 assert.equal(result.grouped,true);assert.equal(result.recovered,true);assert.equal(result.decisions.length,12);
 assert.deepEqual(result.decisions.map(d=>d.candidateId),p.input.candidates.map(c=>c.candidateId));
 assert.deepEqual(calls.map(c=>expandRelevanceInput((({inputHash,...wire})=>wire)(JSON.parse(c.user))).candidates.length),[4,4,2,2,4]);
 const recovery=events.find(e=>e.kind==='normal'&&e.index===1&&e.phase==='recoverable');
 assert.equal(recovery.recoveryReason,'invalid_json');
 assert.deepEqual(recovery.missingCandidateIds,p.input.candidates.slice(4,8).map(c=>c.candidateId));
 assert.equal(events.filter(e=>e.kind==='normal-recovery'&&e.phase==='validated').length,2);
});

test('complete group with omitted usable evidence IDs is rebound without reusing its labels',async()=>{
 const p=prepared(),calls=[],events=[];
 const result=await assessPreparedRelevance(p,{assessRelevance:async request=>{
  calls.push(request);
  if(calls.length===2){
   const {inputHash,...wire}=JSON.parse(request.user),input=expandRelevanceInput(wire);
   return JSON.stringify({inputHash,decisions:input.candidates.map((candidate,index)=>index<2
    ?{candidateId:candidate.candidateId,relevance:'usable',reason:'有据但漏写编号'}
    :{candidateId:candidate.candidateId,relevance:'irrelevant',reason:'不适用'})});
  }
  return reply(request.user);
 },onAttempt:async event=>events.push(event)});
 assert.equal(result.grouped,true);assert.equal(result.recovered,true);assert.equal(result.decisions.length,12);
 assert.deepEqual(result.decisions.map(d=>d.candidateId),p.input.candidates.map(c=>c.candidateId));
 assert.deepEqual(calls.map(c=>expandRelevanceInput((({inputHash,...wire})=>wire)(JSON.parse(c.user))).candidates.length),[4,4,2,2,4]);
 const recovery=events.find(e=>e.kind==='normal'&&e.index===1&&e.phase==='recoverable');
 assert.equal(recovery.recoveryReason,'missing_evidence_ids');
 assert.deepEqual(recovery.missingCandidateIds,p.input.candidates.slice(4,8).map(c=>c.candidateId));
});

test('missing evidence recovery never masks an invalid present selection or a single-candidate omission',async()=>{
 const p=prepared(4);let calls=0;
 await assert.rejects(assessPreparedRelevance(p,{normalGroupSize:20,assessRelevance:async request=>{
  calls++;const {inputHash,...wire}=JSON.parse(request.user),input=expandRelevanceInput(wire);
  return JSON.stringify({inputHash,decisions:input.candidates.map((candidate,index)=>index===0
   ?{candidateId:candidate.candidateId,relevance:'usable',reason:'漏写编号'}
   :index===1?{candidateId:candidate.candidateId,relevance:'usable',reason:'坏编号',evidenceIds:['999']}
   :{candidateId:candidate.candidateId,relevance:'irrelevant',reason:'不适用'})});
 }}),{code:'RELEVANCE_EVIDENCE_INVALID'});
 assert.equal(calls,1);
 const one=prepared(1);calls=0;
 await assert.rejects(assessPreparedRelevance(one,{normalGroupSize:20,assessRelevance:async request=>{
  calls++;const {inputHash,...wire}=JSON.parse(request.user),input=expandRelevanceInput(wire),candidate=input.candidates[0];
  return JSON.stringify({inputHash,decisions:[{candidateId:candidate.candidateId,relevance:'usable',reason:'漏写编号'}]});
 }}),{code:'RELEVANCE_EVIDENCE_INVALID'});
 assert.equal(calls,1);
});

test('a later normal group failure discards all earlier valid groups',async()=>{
 const p=prepared();let calls=0;
 await assert.rejects(assessPreparedRelevance(p,{assessRelevance:async request=>{calls++;return reply(request.user,{badHash:calls===2});}}));
 assert.equal(calls,2);
});

test('library receipt preserves every request/response and never supplies failed recovery',async t=>{
 const rootDir=await mkdtemp(join(tmpdir(),'relevance-coverage-'));
 let calls=0,dropCall=1,badCall=Infinity;
 const analysis={overview:'',coverage:{scope:'full',notes:[]},limitations:[],units:[{id:'u',title:'转轴',event:'检查转轴',psychology:'未知',emotion:'未知',expression:'动作',readerEffectHypothesis:'结果待查',locator:{lineStart:1,lineEnd:1},evidence:[{quote:'转轴维护。',lineStart:1,lineEnd:1}],relatedUnitIds:[]}]};
 const lib=await createLibraryService({rootDir,model:{complete:async({user})=>{const value=structuredClone(analysis);value.units[0].evidence[0].quote=JSON.parse(user).lines[0].text;return JSON.stringify(value);}},reviewAnalysis:async()=>({approved:true,notes:['固定测试']}),assessRelevance:async({user})=>{
  calls++;
  const {inputHash,...wire}=JSON.parse(user),input=expandRelevanceInput(wire);
  const decisions=input.candidates.map(c=>({candidateId:c.candidateId,relevance:'usable',reason:'固定协议测试',evidenceIds:['1']}));
  if(calls===dropCall)decisions.pop();
  return JSON.stringify({inputHash:calls===badCall?'f'.repeat(64):inputHash,decisions});
 }});
 t.after(async()=>{await lib.close();await rm(rootDir,{recursive:true,force:true});});
 const source=await lib.importSource({requestId:'coverage-source',fileName:'source.txt',bytes:Buffer.from('转轴维护。')});
 for(let i=0;i<300;i++){if(!['queued','running'].includes((await lib.get(source.sourceId)).status))break;await new Promise(resolve=>setTimeout(resolve,5));}
 const query={contractVersion:'v04-contract-1',query:'转轴',context:'检修动作',stage:'planning',budget:{maxCandidates:20,maxUnits:6,maxChars:12000}};
 const good=await lib.retrieve(query),saved=await lib.getRelevanceReview(good.relevanceReview.receiptId);
 assert.equal(good.status,'matched');assert(good.materials.length>0);assert.equal(calls,3);
 assert.equal(saved.status,'completed');assert.equal(saved.recovery.groups.length,2);
 assert.equal(saved.recovery.groups[0].status,'validated');assert(saved.rawResponse);assert(saved.recovery.groups[0].rawResponse);
 assert.equal(JSON.parse(saved.recovery.groups[0].user).inputHash,saved.recovery.groups[0].inputHash);
 dropCall=calls+1;badCall=calls+2;
 const bad=await lib.retrieve(query),failed=await lib.getRelevanceReview(bad.relevanceReview.receiptId);
 assert.equal(bad.status,'unavailable');assert.equal(bad.materials.length,0);assert.equal(bad.relevanceReview.usableCount,0);assert.equal(calls,5);
 assert.equal(failed.status,'failed');assert.deepEqual(failed.decisions,[]);
 assert.equal(failed.recovery.groups[0].status,'failed');assert(failed.rawResponse);assert(failed.recovery.groups[0].rawResponse);
});

test('library records fixed normal groups as actual requests, not a fictional whole-batch response',async t=>{
 const rootDir=await mkdtemp(join(tmpdir(),'relevance-normal-groups-'));
 let calls=0,badSecond=false,truncateSecond=false;
 const analysis={overview:'',coverage:{scope:'full',notes:[]},limitations:[],units:[{id:'u',title:'转轴',event:'检查转轴',psychology:'未知',emotion:'未知',expression:'动作',readerEffectHypothesis:'结果待查',locator:{lineStart:1,lineEnd:1},evidence:[{quote:'转轴维护甲。',lineStart:1,lineEnd:1}],relatedUnitIds:[]}]};
 const lib=await createLibraryService({rootDir,model:{complete:async({user})=>{const value=structuredClone(analysis);value.units[0].evidence[0].quote=JSON.parse(user).lines[0].text;return JSON.stringify(value);}},reviewAnalysis:async()=>({approved:true,notes:['固定测试']}),assessRelevance:async({user})=>{
  calls++;const {inputHash,...wire}=JSON.parse(user),input=expandRelevanceInput(wire);
  if(truncateSecond&&calls===2)return '{"inputHash":"truncated';
  return JSON.stringify({inputHash:badSecond&&calls===2?'f'.repeat(64):inputHash,decisions:input.candidates.map(c=>({candidateId:c.candidateId,relevance:'irrelevant',reason:'固定协议测试'}))});
 }});
 t.after(async()=>{await lib.close();await rm(rootDir,{recursive:true,force:true});});
 const sources=[];
 for(const suffix of ['甲','乙','丙'])sources.push(await lib.importSource({requestId:`source-${suffix}`,fileName:`${suffix}.txt`,bytes:Buffer.from(`转轴维护${suffix}。`)}));
 for(const source of sources)for(let i=0;i<300;i++){if(!['queued','running'].includes((await lib.get(source.sourceId)).status))break;await new Promise(resolve=>setTimeout(resolve,5));}
 const query={contractVersion:'v04-contract-1',query:'转轴',context:'检修动作',stage:'planning',budget:{maxCandidates:20,maxUnits:6,maxChars:12000}};
 const result=await lib.retrieve(query),receipt=await lib.getRelevanceReview(result.relevanceReview.receiptId);
 assert(receipt.sent.length>4);assert.equal(result.status,'uncovered');assert.equal(receipt.status,'completed');
 assert.equal(receipt.requestMode,'fixed_groups');assert.equal(receipt.user,null);assert.equal(receipt.rawResponse,null);
 assert.equal(receipt.normalReview.groups.length,Math.ceil(receipt.sent.length/4));assert.equal(calls,receipt.normalReview.groups.length);
 assert(receipt.normalReview.groups.every(g=>g.status==='validated'&&g.rawResponse&&g.user&&g.sent.length<=4));
 truncateSecond=true;calls=0;
 const recoveredResult=await lib.retrieve(query),recovered=await lib.getRelevanceReview(recoveredResult.relevanceReview.receiptId);
 assert.equal(recoveredResult.status,'uncovered');assert.deepEqual(recoveredResult.materials,[]);assert.equal(recovered.status,'completed');
 assert.equal(recovered.normalReview.groups[1].status,'recoverable');assert.equal(recovered.normalReview.groups[1].recovery.reason,'invalid_json');
 assert(recovered.normalReview.groups[1].recovery.groups.every(g=>g.status==='validated'&&g.sent.length<=2));
 assert.equal(calls,recovered.normalReview.groups.length+2);
 truncateSecond=false;
 badSecond=true;calls=0;
 const failedResult=await lib.retrieve(query),failed=await lib.getRelevanceReview(failedResult.relevanceReview.receiptId);
 assert.equal(failedResult.status,'unavailable');assert.deepEqual(failedResult.materials,[]);assert.deepEqual(failed.decisions,[]);
 assert.equal(failed.normalReview.groups[0].status,'validated');assert.equal(failed.normalReview.groups[1].status,'failed');
 assert.equal(calls,2);
});
