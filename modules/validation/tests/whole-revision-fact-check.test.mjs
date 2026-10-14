import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareWholeRevisionFactChecks,inspectWholeRevisionFactCheckResponse,validateWholeRevisionFactCheckResult,
  runWholeRevisionFactChecks,WHOLE_REVISION_FACT_CHECK_VERSION,
} from '../runtime/whole-revision-fact-check.mjs';

const baseline=[
  {id:'ch-1',title:'第一天',body:'第一天早上，钥匙还在林岚手里。钟声响了。'},
  {id:'ch-2',title:'交接前',body:'第二天下午，她把钥匙放在台面，又收回口袋。'},
  {id:'ch-3',title:'第三天',body:'第三天下午，林岚当面把钥匙交给胡姐。钟声又响了。'},
];
const candidate=[
  {...baseline[0],body:'第一天早上，钥匙还在林岚手里。她把交接日期写在纸上。钟声响了。'},
  baseline[1],
  {...baseline[2],body:'第三天下午，林岚核对日期后，当面把钥匙交给胡姐。钟声又响了。'},
];
const units=[
  {id:'handover-key',kind:'handover',subject:'铺面钥匙正式交接',chapterIds:['ch-1','ch-3'],question:'候选稿是否保持第三天下午才正式交钥匙？'},
  {id:'custody-key',kind:'object_custody',subject:'钥匙持有人',chapterIds:['ch-1','ch-2','ch-3'],question:'钥匙持有人变化是否有明确动作连接？'},
];
const prepared=()=>prepareWholeRevisionFactChecks({baselineChapters:baseline,candidateChapters:candidate,units});

function citation(input,chapterId,needle,version='candidate'){
  const body=input.modelInput.chapters.find(item=>item.chapterId===chapterId)[version].body;
  assert(body.includes(needle));return {version,chapterId,quote:needle};
}
function response(input,assessment='consistent'){
  const support=assessment==='unknown'
    ? [citation(input,input.unit.chapterIds[0],'钥匙还在林岚手里')]
    : [citation(input,'ch-1','第一天早上，钥匙还在林岚手里。'),citation(input,'ch-3','第三天下午，林岚核对日期后，当面把钥匙交给胡姐。')];
  return JSON.stringify({inputHash:input.inputHash,unitId:input.unit.id,checkedChapterIds:input.unit.chapterIds,
    assessment,finding:assessment==='unknown'?'第二天的放下与收回不足以证明正式交接。':'候选稿保留了第一天持有与第三天正式交接。',
    supportingEvidence:support,counterEvidence:assessment==='unknown'?[citation(input,'ch-2','她把钥匙放在台面，又收回口袋。')]:[],
    missingFacts:assessment==='unknown'?['第二天放置是否被胡姐接受并不明确。']:[]});
}

test('small unit protocol binds exact quotes and never turns unknown into revision authority',()=>{
  const batch=prepared(),consistent=inspectWholeRevisionFactCheckResponse(response(batch.unitInputs[0]),batch.unitInputs[0]);
  assert.equal(consistent.assessment,'consistent');
  assert.equal(consistent.supportingEvidence.length,2);
  assert.equal(consistent.automaticRevisionEligible,false);
  assert.equal(consistent.semanticValidity,'not_programmatically_verified');
  assert.deepEqual(validateWholeRevisionFactCheckResult(consistent,batch.unitInputs[0]),consistent);
  const unknown=inspectWholeRevisionFactCheckResponse(response(batch.unitInputs[1],'unknown'),batch.unitInputs[1]);
  assert.equal(unknown.assessment,'unknown');
  assert.equal(unknown.missingFacts.length,1);
  assert.equal(unknown.systemGo,false);
});

test('conflict/consistent require two candidate chapters and the host uniquely locates exact quotes',()=>{
  const input=prepared().unitInputs[0],wire=JSON.parse(response(input));
  wire.supportingEvidence.pop();
  assert.throws(()=>inspectWholeRevisionFactCheckResponse(JSON.stringify(wire),input),{code:'ASSESSMENT_UNSUPPORTED'});
  const bad=JSON.parse(response(input));bad.supportingEvidence[0].quote='不存在的逐字引文';
  assert.throws(()=>inspectWholeRevisionFactCheckResponse(JSON.stringify(bad),input),{code:'EVIDENCE_QUOTE'});
  const unknownInput=prepared().unitInputs[1],missing=JSON.parse(response(unknownInput,'unknown'));missing.missingFacts=[];
  assert.throws(()=>inspectWholeRevisionFactCheckResponse(JSON.stringify(missing),unknownInput),{code:'UNKNOWN_WITHOUT_GAP'});
});

test('the model never supplies UTF-16 offsets and an ambiguous quote is rejected instead of guessed',()=>{
  const duplicateCandidate=candidate.map(item=>item.id==='ch-1'?{...item,body:item.body+' 钥匙还在林岚手里。'}:item);
  const input=prepareWholeRevisionFactChecks({baselineChapters:baseline,candidateChapters:duplicateCandidate,units}).unitInputs[1];
  const wire={inputHash:input.inputHash,unitId:input.unit.id,checkedChapterIds:input.unit.chapterIds,assessment:'unknown',
    finding:'重复引文不能唯一定位。',supportingEvidence:[{version:'candidate',chapterId:'ch-1',quote:'钥匙还在林岚手里。'}],
    counterEvidence:[],missingFacts:['需要扩大逐字上下文。']};
  assert.equal(Object.hasOwn(wire.supportingEvidence[0],'start'),false);
  assert.throws(()=>inspectWholeRevisionFactCheckResponse(JSON.stringify(wire),input),{code:'EVIDENCE_AMBIGUOUS'});
});

test('one passage may support the chain and qualify its scope without allowing same-role duplicate padding',()=>{
  const input=prepared().unitInputs[0],wire=JSON.parse(response(input));
  wire.counterEvidence.push(structuredClone(wire.supportingEvidence[1]));
  const checked=inspectWholeRevisionFactCheckResponse(JSON.stringify(wire),input);
  assert.equal(checked.supportingEvidence[1].role,'supporting');
  assert.equal(checked.counterEvidence[0].role,'counter');
  const padded=structuredClone(wire);padded.supportingEvidence.push(structuredClone(padded.supportingEvidence[0]));
  assert.throws(()=>inspectWholeRevisionFactCheckResponse(JSON.stringify(padded),input),{code:'DUPLICATE_EVIDENCE'});
});

test('saved unit inputs and raw response checkpoint hashes are fail-closed',async()=>{
  const batch=prepared(),input=structuredClone(batch.unitInputs[0]);input.requestSha256='0'.repeat(64);
  assert.throws(()=>inspectWholeRevisionFactCheckResponse(response(batch.unitInputs[0]),input),{code:'UNIT_INPUT_TAMPER'});
  const artifacts={},model={async complete(){return response(batch.unitInputs[0]);}};
  await runWholeRevisionFactChecks({prepared:batch,model,artifacts,checkpoint:async(key,value)=>{artifacts[key]=structuredClone(value);}});
  const key=Object.keys(artifacts).find(value=>value.includes('handover-key:attempt:1:response'));
  for(const value of Object.keys(artifacts).filter(value=>value.includes('handover-key:result')))delete artifacts[value];
  artifacts[key].responseSha256='0'.repeat(64);
  await assert.rejects(runWholeRevisionFactChecks({prepared:batch,model,artifacts,checkpoint:async()=>{}}),{code:'RESPONSE_CHECKPOINT'});
});

test('resume calls only the failed unit and never repeats a completed unit',async()=>{
  const batch=prepared(),artifacts={},counts=new Map();
  const model={async complete({user}){
    const payload=JSON.parse(user),input=batch.unitInputs.find(item=>item.unit.id===payload.unitId);
    counts.set(payload.unitId,(counts.get(payload.unitId)??0)+1);
    if(payload.unitId==='custody-key'&&counts.get(payload.unitId)===1)return '{}';
    return response(input,payload.unitId==='custody-key'?'unknown':'consistent');
  }};
  const checkpoint=async(key,value)=>{assert.equal(Object.hasOwn(artifacts,key),false);artifacts[key]=structuredClone(value);};
  const first=await runWholeRevisionFactChecks({prepared:batch,model,artifacts,checkpoint});
  assert.equal(first.status,'incomplete');assert.equal(first.modelCompleteCalls,2);
  assert.equal(counts.get('handover-key'),1);assert.equal(counts.get('custody-key'),1);
  const second=await runWholeRevisionFactChecks({prepared:batch,model,artifacts,checkpoint});
  assert.equal(second.status,'complete');assert.equal(second.modelCompleteCalls,1);
  assert.equal(counts.get('handover-key'),1);assert.equal(counts.get('custody-key'),2);
  assert.deepEqual(second.units.map(item=>[item.unitId,item.assessment]),[['handover-key','consistent'],['custody-key','unknown']]);
  const third=await runWholeRevisionFactChecks({prepared:batch,model,artifacts,checkpoint});
  assert.equal(third.modelCompleteCalls,0);assert.deepEqual(third.units,second.units);
  assert(Object.keys(artifacts).some(key=>key.endsWith('attempt:1:failure')));
  assert(Object.keys(artifacts).some(key=>key.endsWith('attempt:2:response')));
});

test('call failure is isolated, saved as incomplete and does not erase another unit result',async()=>{
  const batch=prepared(),artifacts={},counts=new Map();
  const model={async complete({user}){const payload=JSON.parse(user);counts.set(payload.unitId,(counts.get(payload.unitId)??0)+1);
    if(payload.unitId==='handover-key')throw Object.assign(new Error('offline'),{code:'ECONNRESET'});
    return response(batch.unitInputs[1],'unknown');}};
  const args={prepared:batch,model,artifacts,checkpoint:async(key,value)=>{artifacts[key]=structuredClone(value);}};
  const result=await runWholeRevisionFactChecks(args);
  assert.equal(result.status,'incomplete');
  assert.deepEqual(result.units.map(item=>item.status),['failed','completed']);
  assert.equal(result.modelCompleteCalls,2);
  assert.equal(result.units[0].failure.code,'ECONNRESET');
  assert.equal(result.units[1].assessment,'unknown');
  assert.equal(result.automaticRevisionEligible,false);
  const second=await runWholeRevisionFactChecks(args);
  assert.equal(second.status,'incomplete');assert.equal(second.modelCompleteCalls,1);
  assert.equal(counts.get('handover-key'),2);assert.equal(counts.get('custody-key'),1);
  const third=await runWholeRevisionFactChecks(args);
  assert.equal(third.status,'incomplete');assert.equal(third.modelCompleteCalls,0);
  assert.equal(counts.get('handover-key'),2);assert.equal(counts.get('custody-key'),1);
});

test('a missing provider output consumes its unit attempt and cannot create unbounded resume calls',async()=>{
  const batch=prepared(),artifacts={},counts=new Map();
  const model={async complete({user}){const payload=JSON.parse(user);counts.set(payload.unitId,(counts.get(payload.unitId)??0)+1);
    return payload.unitId==='handover-key'?undefined:response(batch.unitInputs[1],'unknown');}};
  const args={prepared:batch,model,artifacts,checkpoint:async(key,value)=>{artifacts[key]=structuredClone(value);}};
  const first=await runWholeRevisionFactChecks(args),second=await runWholeRevisionFactChecks(args),third=await runWholeRevisionFactChecks(args);
  assert.equal(first.units[0].failure.code,'MODEL_RESPONSE_REQUIRED');
  assert.equal(first.modelCompleteCalls,2);assert.equal(second.modelCompleteCalls,1);assert.equal(third.modelCompleteCalls,0);
  assert.equal(counts.get('handover-key'),2);assert.equal(counts.get('custody-key'),1);
});

test('exported protocol version stays explicit',()=>assert.equal(WHOLE_REVISION_FACT_CHECK_VERSION,'whole-revision-fact-check-1'));
