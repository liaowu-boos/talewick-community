import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {manuscriptFingerprint} from '../runtime/checks.mjs';
import {ContinuityError} from '../runtime/continuity-review.mjs';
import {createAdjudicationInput,ADJUDICATION_CONTINUITY_VERSION} from '../runtime/review-adjudication.mjs';
import {
  prepareContinuityChainReview,inspectContinuityChainReview,CONTINUITY_CHAIN_V3_VERSION,
  createContinuityChainRepairInput,inspectContinuityChainRepairResponse,validateContinuityChainRepairResult,
  CONTINUITY_CHAIN_RELATION_REPAIR_FAILURE_VERSION,isContinuityChainRelationRepairFailureError,
  createContinuityChainRelationRepairFailureEnvelope,validateContinuityChainFailureEnvelope,
  extractContinuityChainFailureHistoricalObservations,
} from '../runtime/continuity-chain-review.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
function fixture({version=CONTINUITY_CHAIN_V3_VERSION,kind='object_custody',explained=false}={}) {
  const chapters = [
    {id:'one',title:'留存',body:'周宁把唯一原件放进自己的抽屉。'},
    {id:'two',title:'签收',body:'林言签收了周宁交来的同一份原件。'},
  ];
  const report = {manuscriptSha256:manuscriptFingerprint(chapters),issues:[{
    chapterId:'two',severity:'must_fix',quote:chapters[1].body,explanation:'独立核查原件交接。',category:'STORY_COMPREHENSION_BLOCKER',
  }]};
  const input = prepareContinuityChainReview({chapters,report},{version});
  const wire = {inputHash:input.inputHash,manuscriptSha256:input.manuscriptSha256,reportSha256:input.reportSha256,
    checkedChapterIds:['one','two'],coverage:{status:'complete',omissions:[]},
    evidence:chapters.map(c=>({chapterId:c.id,fragmentStart:1,fragmentEnd:1,role:'narration',actor:'周宁',relevance:'原件持有状态。'})),
    anchors:[['a0',1],['a1',1],['a2',2]].map(([id,evidence])=>({id,eventRef:'同一原件',facet:'holder',state:'原件持有人。',certainty:'stated',timeFrame:'current',evidence})),
    transitions:[['cross','a2'],['same','a1']].map(([id,toAnchorId])=>({id,fromAnchorId:'a0',toAnchorId,relation:'after',certainty:'stated',reason:'后续记录。',evidence:[1,2]})),
    cases:[{id:'document',kind,subject:'原件交接',impact:'major',assessment:explained?'explained':'contradiction',reason:'报告中的原件状态观察。',
      anchorIds:explained?['a0','a2']:['a0','a1'],transitionIds:['cross'],focusAnchorId:'a0',
      repairScope:{assessment:explained?'cross_chapter':'local_anchor',reason:'定位原件交接处。'},
      identity:{assessment:'same',reason:'同一份原件。',evidence:[1,2]},
      alternatives:[{explanation:'另有交接。',assessment:'ruled_out',evidence:[1,2]}],
      gap:{status:'none',description:'未列出缺口。'},searchedChapterIds:['one','two']}],
    retention:{majorUnknownCaseIds:[],contradictionCaseIds:explained?[]:['document'],nonLocalContradictionCaseIds:[]},
  };
  const primaryRawResponse=JSON.stringify(wire),repairInput=createContinuityChainRepairInput({input,invalidResponse:primaryRawResponse});
  const repaired=structuredClone(wire);
  if(!explained)repaired.cases[0].transitionIds=['same'];
  return {chapters,report,wire,repaired,args:{input,primaryRawResponse,repairInput,repairRawResponse:JSON.stringify(repaired),failureCode:explained?'EXPLANATION_WITHOUT_EVIDENCE':'CASE_NEEDS_DISTINCT_EVIDENCE'}};
}

test('exhausted repair seals exact primary/input/repair/raw and replays without mutating any value',()=>{
  const {args}=fixture(),before=structuredClone(args);
  assert.throws(()=>inspectContinuityChainReview(args.primaryRawResponse,args.input),{code:'CASE_TRANSITIONS'});
  assert.throws(()=>inspectContinuityChainRepairResponse(args.repairRawResponse,args.repairInput),{code:'CASE_NEEDS_DISTINCT_EVIDENCE'});
  const envelope=createContinuityChainRelationRepairFailureEnvelope(args);
  assert.equal(envelope.schemaVersion,CONTINUITY_CHAIN_RELATION_REPAIR_FAILURE_VERSION);
  assert.equal(envelope.primaryResponseSha256,sha(args.primaryRawResponse));
  assert.equal(envelope.repairResponseSha256,sha(args.repairRawResponse));
  assert.equal(envelope.repairRequestSha256,args.repairInput.requestSha256);
  assert.equal(envelope.primaryFailureCode,'CASE_TRANSITIONS');
  assert.equal(envelope.repairAttempted,true);
  assert.equal(envelope.status,'continuity_chain_incomplete');
  assert.equal(envelope.semanticAcceptance,false);
  assert.equal(envelope.automaticRevisionEligible,false);
  assert.deepEqual(validateContinuityChainFailureEnvelope(envelope,args),envelope);
  assert.deepEqual(extractContinuityChainFailureHistoricalObservations(args),envelope.historicalObservations);
  assert.equal(envelope.historicalObservations.length,2);
  for(const observation of envelope.historicalObservations){
    assert.equal(observation.semanticValidity,'unverified');assert.equal(observation.revisionEligible,false);assert.equal(observation.explicitlyClosed,false);
  }
  assert.deepEqual(args,before);
});

test('both original error routes and remaining relation/facet/content errors can be archived without relaxing gates',()=>{
  const {args,repaired}=fixture();
  const variants=[
    {...args,repairRawResponse:args.primaryRawResponse,failureCode:'CASE_TRANSITIONS'},
    fixture({explained:true}).args,
  ];
  const facets=fixture({kind:'handover'});facets.repaired.cases[0].anchorIds=['a0','a2'];facets.repaired.cases[0].transitionIds=['cross'];
  variants.push({...facets.args,repairRawResponse:JSON.stringify(facets.repaired),failureCode:'CASE_FACETS'});
  repaired.cases[0].assessment='unknown';
  variants.push({...args,repairRawResponse:JSON.stringify(repaired),failureCode:'CONTINUITY_REPAIR_CONTENT_CHANGE'});
  for(const candidate of variants){
    assert.throws(()=>inspectContinuityChainRepairResponse(candidate.repairRawResponse,candidate.repairInput),{code:candidate.failureCode});
    const envelope=createContinuityChainRelationRepairFailureEnvelope(candidate);
    assert.equal(envelope.failureCode,candidate.failureCode);assert.equal(envelope.semanticAcceptance,false);
    assert.deepEqual(validateContinuityChainFailureEnvelope(envelope,candidate),envelope);
  }
  assert.equal(createContinuityChainRelationRepairFailureEnvelope(variants[0]).historicalObservations.length,1,'identical raw sources deduplicate');
  const contentHistory=createContinuityChainRelationRepairFailureEnvelope(variants.at(-1)).historicalObservations;
  assert.deepEqual(contentHistory.map(o=>o.case.reportedAssessment),['contradiction','unknown']);
  assert.deepEqual(contentHistory.map(o=>o.failureCode),['CASE_TRANSITIONS','CONTINUITY_REPAIR_CONTENT_CHANGE']);
});

test('raw whitespace, wrong input, wrong primary, forged repair request, binding, version and error reject',()=>{
  const {args,repaired}=fixture(),envelope=createContinuityChainRelationRepairFailureEnvelope(args);
  assert.throws(()=>validateContinuityChainFailureEnvelope(envelope,{...args,repairRawResponse:args.repairRawResponse+'\n'}),{code:'CONTINUITY_FAILURE_TAMPER'});
  assert.throws(()=>createContinuityChainRelationRepairFailureEnvelope({...args,primaryRawResponse:args.primaryRawResponse+'\n'}),{code:'CONTINUITY_FAILURE_REPAIR_BINDING'});
  const wrongInput=structuredClone(args.input);wrongInput.user+=' ';
  assert.throws(()=>createContinuityChainRelationRepairFailureEnvelope({...args,input:wrongInput}),{code:'INPUT_TAMPER'});
  const repairInput=structuredClone(args.repairInput);repairInput.system+=' ';
  assert.throws(()=>createContinuityChainRelationRepairFailureEnvelope({...args,repairInput}),{code:'CONTINUITY_REPAIR_INPUT_TAMPER'});
  repaired.inputHash='0'.repeat(64);
  assert.throws(()=>createContinuityChainRelationRepairFailureEnvelope({...args,repairRawResponse:JSON.stringify(repaired)}),{code:'CONTINUITY_RELATION_FAILURE_BINDING'});
  assert.throws(()=>createContinuityChainRelationRepairFailureEnvelope({...args,failureCode:'CASE_FACETS'}),{code:'CONTINUITY_FAILURE_NOT_REPRODUCED'});
  assert.throws(()=>createContinuityChainRelationRepairFailureEnvelope(fixture({version:'continuity-chain-review-2'}).args),{code:'CONTINUITY_FAILURE_V3_ONLY'});
});

test('a foreign but valid repair input and successful repair cannot be archived',()=>{
  const {args,repaired}=fixture(),foreign=fixture({explained:true}).args.repairInput;
  assert.throws(()=>createContinuityChainRelationRepairFailureEnvelope({...args,repairInput:foreign}),{code:'CONTINUITY_FAILURE_REPAIR_BINDING'});
  repaired.cases[0].anchorIds=['a0','a2'];repaired.cases[0].transitionIds=['cross'];
  const repairRawResponse=JSON.stringify(repaired),result=inspectContinuityChainRepairResponse(repairRawResponse,args.repairInput);
  assert.deepEqual(validateContinuityChainRepairResult(result,args.repairInput),result);
  assert.throws(()=>createContinuityChainRelationRepairFailureEnvelope({...args,repairRawResponse}),{code:'CONTINUITY_FAILURE_NOT_REPRODUCED'});
});

test('incomplete/non-JSON repair and native programming errors propagate rather than becoming envelopes',t=>{
  const {args,repaired}=fixture();
  assert.throws(()=>createContinuityChainRelationRepairFailureEnvelope({...args,repairRawResponse:args.repairRawResponse.slice(0,-1),failureCode:'RESPONSE_JSON'}),{code:'RESPONSE_JSON'});
  delete repaired.cases;
  assert.throws(()=>createContinuityChainRelationRepairFailureEnvelope({...args,repairRawResponse:JSON.stringify(repaired)}),TypeError);
  assert.equal(isContinuityChainRelationRepairFailureError(new ContinuityError('CASE_NEEDS_DISTINCT_EVIDENCE')),true);
  for(const error of [new TypeError('bug'),Object.assign(new Error('bug'),{code:'CASE_NEEDS_DISTINCT_EVIDENCE'}),{code:'CASE_TRANSITIONS'},null])
    assert.equal(isContinuityChainRelationRepairFailureError(error),false);
  const parse=JSON.parse,bug=new TypeError('parser implementation failure');
  t.mock.method(JSON,'parse',function(value,...rest){if(value===args.repairRawResponse)throw bug;return parse.call(this,value,...rest);});
  assert.throws(()=>createContinuityChainRelationRepairFailureEnvelope(args),error=>error===bug);
});

test('changing any sealed failure binding/history or adding acceptance is rejected',()=>{
  const {args}=fixture(),envelope=createContinuityChainRelationRepairFailureEnvelope(args);
  for(const mutate of [
    v=>v.primaryFailureCode='EXPLANATION_WITHOUT_EVIDENCE',v=>v.repairResponseSha256='0'.repeat(64),
    v=>v.primaryResponseSha256='0'.repeat(64),v=>v.repairRequestSha256='0'.repeat(64),
    v=>v.historicalObservations.shift(),v=>v.historicalObservations[0].case.reportedAssessment='unknown',
    v=>v.semanticAcceptance=true,v=>v.automaticRevisionEligible=true,v=>v.repairAttempted=false,
  ]){
    const changed=structuredClone(envelope);mutate(changed);
    assert.throws(()=>validateContinuityChainFailureEnvelope(changed,args),{code:'CONTINUITY_FAILURE_TAMPER'});
  }
});

test('v4 adjudication preserves original issues; dual-source history cannot become new issues or clearance',()=>{
  const {args,chapters,report}=fixture(),envelope=createContinuityChainRelationRepairFailureEnvelope(args);
  const review={...report,continuityChainFailure:envelope};
  const prepare=review=>createAdjudicationInput({chapters,review,protocolVersion:ADJUDICATION_CONTINUITY_VERSION});
  const input=prepare(review);assert.deepEqual(input.modelInput.issues.map(i=>i.issue),report.issues);
  for(const mutate of [
    v=>v.continuityChainFailure.historicalObservations[0].sourceResponseSha256='0'.repeat(64),
    v=>v.continuityChainFailure.historicalObservations[0].failureCode='CASE_NEEDS_DISTINCT_EVIDENCE',
    v=>v.continuityChainFailure.historicalObservations.push(v.continuityChainFailure.historicalObservations[0]),
  ]){
    const changed=structuredClone(review);mutate(changed);
    assert.throws(()=>prepare(changed),{code:'CONTINUITY_FAILURE_HISTORY'});
  }
  const added=structuredClone(review);added.issues[0].continuityCaseId='document';
  assert.throws(()=>prepare(added),{code:'CONTINUITY_FAILURE_ISSUES'});
  const accepted=structuredClone(review);accepted.continuityChainFailure.automaticRevisionEligible=true;
  assert.throws(()=>prepare(accepted),{code:'CONTINUITY_FAILURE_FIELDS'});
});
