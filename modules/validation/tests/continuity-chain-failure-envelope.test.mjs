import test from 'node:test';
import assert from 'node:assert/strict';
import {createContinuityInput} from '../runtime/continuity-review.mjs';
import {
  CONTINUITY_CHAIN_V3_VERSION,prepareContinuityChainReview,createContinuityChainFormatRepairInput,
  createContinuityChainFailureEnvelope,validateContinuityChainFailureEnvelope,
  extractContinuityChainFailureHistoricalObservations,
} from '../runtime/continuity-chain-review.mjs';
import {ADJUDICATION_CONTINUITY_VERSION,createAdjudicationInput} from '../runtime/review-adjudication.mjs';

function fixture() {
  const chapters=[{id:'ch-1',title:'一',body:'柜子还在。'},{id:'ch-2',title:'二',body:'交接单写柜子已搬走。'}];
  const source=createContinuityInput({chapters});
  const report={manuscriptSha256:source.manuscriptSha256,summary:'一般审稿保留。',issues:[{
    chapterId:'ch-1',severity:'must_fix',quote:'柜子还在。',explanation:'一般审稿已有问题。',suggestion:'独立核对。',category:'GENERAL_REVIEW',
  }]};
  const input=prepareContinuityChainReview({chapters,report},{version:CONTINUITY_CHAIN_V3_VERSION});
  const wire={inputHash:input.inputHash,manuscriptSha256:input.manuscriptSha256,reportSha256:input.reportSha256,
    checkedChapterIds:['ch-1','ch-2'],coverage:{status:'complete',omissions:[]},evidence:[
      {chapterId:'ch-1',fragmentStart:1,fragmentEnd:1,role:'narration',actor:'叙述者',relevance:'早先状态。'},
      {chapterId:'ch-2',fragmentStart:1,fragmentEnd:1,role:'narration',actor:'叙述者',relevance:'交接状态。'},
    ],anchors:[
      {id:'a1',eventRef:'早先',facet:'physical_state',state:'仍在',certainty:'stated',timeFrame:'current',evidence:1},
      {id:'a2',eventRef:'交接',facet:'handover_status',state:'已搬走',certainty:'stated',timeFrame:'current',evidence:2},
    ],transitions:[{id:'t1',fromAnchorId:'a1',toAnchorId:'a2',relation:'unknown',certainty:'unknown',reason:'中间动作缺失。',evidence:[]}],
    cases:[{id:'case-low-cabinet',kind:'handover',subject:'矮柜去向',impact:'major',assessment:'unknown',reason:'缺少中间动作。',
      anchorIds:['a1','a2'],transitionIds:['t1'],focusAnchorId:'a1',repairScope:{assessment:'local_anchor',reason:'失败返回仍保留非法scope。'},
      identity:{assessment:'same',reason:'同一柜子。',evidence:[1,2]},alternatives:[{explanation:'可能另行搬走。',assessment:'unresolved',evidence:[]}],
      gap:{status:'event_relation_missing',description:'缺少中间动作。'},searchedChapterIds:['ch-1','ch-2']}],
    retention:{majorUnknownCaseIds:['case-low-cabinet'],contradictionCaseIds:[],nonLocalContradictionCaseIds:[]}};
  const repairRawResponse=JSON.stringify(wire),needle='"reason":"失败返回仍保留非法scope。"}';
  const primaryRawResponse=repairRawResponse.replace(needle,'"reason":"失败返回仍保留非法scope。","","":""}');
  const repairInput=createContinuityChainFormatRepairInput({input,invalidResponse:primaryRawResponse});
  const failureArgs={input,primaryRawResponse,repairInput,repairRawResponse,failureCode:'REPAIR_SCOPE'};
  return {chapters,report,failureArgs};
}

test('returned unique repair failure builds a bound v3 incomplete envelope and preserves general issues', () => {
  const f=fixture(),failure=createContinuityChainFailureEnvelope(f.failureArgs);
  assert.equal(failure.status,'continuity_chain_incomplete');
  assert.equal(failure.repairAttempted,true);
  assert.equal(failure.semanticAcceptance,false);
  assert.equal(failure.automaticRevisionEligible,false);
  assert.deepEqual(failure.historicalObservations.map(item=>[item.case.id,item.case.reportedAssessment,item.revisionEligible,item.explicitlyClosed]),
    [['case-low-cabinet','unknown',false,false]]);
  assert.deepEqual(extractContinuityChainFailureHistoricalObservations({
    input:f.failureArgs.input,repairInput:f.failureArgs.repairInput,
    repairRawResponse:f.failureArgs.repairRawResponse,failureCode:'REPAIR_SCOPE'}),failure.historicalObservations);
  assert.deepEqual(validateContinuityChainFailureEnvelope(failure,f.failureArgs),failure);
  const review={...f.report,continuityChainFailure:failure};
  const adjudication=createAdjudicationInput({chapters:f.chapters,review,protocolVersion:ADJUDICATION_CONTINUITY_VERSION});
  assert.equal(adjudication.modelInput.issues.length,1);
  assert.equal(adjudication.modelInput.issues[0].issue.category,'GENERAL_REVIEW');
  assert.equal(Object.hasOwn(adjudication.sourceReview,'continuityChain'),false);
  assert.deepEqual(adjudication.sourceReview.continuityChainFailure,failure);
  assert(adjudication.system.includes('检查未完成'));
  assert(adjudication.system.includes('不得采用其中历史观察'));
  assert(adjudication.system.includes('不得因一般审稿issues为空而宣称连续性通过'));
});

test('failure envelope cannot swallow missing returns, mismatches, tampering or chain-derived issues', () => {
  const f=fixture();
  assert.throws(()=>createContinuityChainFailureEnvelope({...f.failureArgs,repairRawResponse:{code:'network'}}),{code:'CONTINUITY_FAILURE_RAW_REQUIRED'});
  assert.throws(()=>createContinuityChainFailureEnvelope({...f.failureArgs,failureCode:'EXPLANATION_WITHOUT_EVIDENCE'}),{code:'CONTINUITY_FAILURE_NOT_REPRODUCED'});
  const badRepair=structuredClone(f.failureArgs.repairInput);badRepair.requestSha256='0'.repeat(64);
  assert.throws(()=>createContinuityChainFailureEnvelope({...f.failureArgs,repairInput:badRepair}));
  const failure=createContinuityChainFailureEnvelope(f.failureArgs),tampered={...failure,semanticAcceptance:true};
  assert.throws(()=>validateContinuityChainFailureEnvelope(tampered,f.failureArgs),{code:'CONTINUITY_FAILURE_TAMPER'});
  const review={...f.report,issues:[{...f.report.issues[0],continuityCaseId:'case-low-cabinet'}],continuityChainFailure:failure};
  assert.throws(()=>createAdjudicationInput({chapters:f.chapters,review,protocolVersion:ADJUDICATION_CONTINUITY_VERSION}),{code:'CONTINUITY_FAILURE_ISSUES'});
  assert.throws(()=>createAdjudicationInput({chapters:f.chapters,review:{...f.report,continuityChainFailure:failure,continuityChain:{}},protocolVersion:ADJUDICATION_CONTINUITY_VERSION}),{code:'CONTINUITY_ENVELOPE_REQUIRED'});
  assert.throws(()=>createAdjudicationInput({chapters:f.chapters,review:{...f.report,summary:'tampered',continuityChainFailure:failure},protocolVersion:ADJUDICATION_CONTINUITY_VERSION}),{code:'CONTINUITY_FAILURE_BINDING'});
});

test('unparseable failed repair preserves the failure envelope with no invented history', () => {
  const f=fixture(),repairRawResponse='not-json';
  const extracted=extractContinuityChainFailureHistoricalObservations({input:f.failureArgs.input,
    repairInput:f.failureArgs.repairInput,repairRawResponse,failureCode:'CONTINUITY_FORMAT_BINDING'});
  assert.deepEqual(extracted,[]);
  const args={...f.failureArgs,repairRawResponse,failureCode:'CONTINUITY_FORMAT_BINDING'};
  const failure=createContinuityChainFailureEnvelope(args);
  assert.deepEqual(failure.historicalObservations,[]);
  const review={...f.report,continuityChainFailure:failure};
  const adjudication=createAdjudicationInput({chapters:f.chapters,review,protocolVersion:ADJUDICATION_CONTINUITY_VERSION});
  assert.deepEqual(adjudication.sourceReview.continuityChainFailure,failure);
  assert.equal(adjudication.modelInput.issues.length,1);
});
