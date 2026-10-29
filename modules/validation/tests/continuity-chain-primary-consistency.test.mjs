import test from 'node:test';
import assert from 'node:assert/strict';
import {manuscriptFingerprint} from '../runtime/checks.mjs';
import {ContinuityError} from '../runtime/continuity-review.mjs';
import {createAdjudicationInput,ADJUDICATION_CONTINUITY_VERSION} from '../runtime/review-adjudication.mjs';
import {
  prepareContinuityChainReview,inspectContinuityChainReview,isContinuityChainPrimaryFailureError,
  createContinuityChainPrimaryFailureEnvelope,validateContinuityChainFailureEnvelope,
  extractContinuityChainFailureHistoricalObservations,
} from '../runtime/continuity-chain-review.mjs';

const codes=['CASE_FACETS','CASE_NEEDS_DISTINCT_EVIDENCE'];
function fixture(code,version='continuity-chain-review-3') {
  const chapters=[{id:'one',title:'说明',body:'房东说合同没有写招牌由谁拆。'},{id:'two',title:'条款',body:'房东又说合同写明招牌由租户拆。'}];
  const report={manuscriptSha256:manuscriptFingerprint(chapters),issues:[{chapterId:'two',severity:'must_fix',quote:chapters[1].body,explanation:'核查条款说法。'}]};
  const input=prepareContinuityChainReview({chapters,report},{version});
  const wire={inputHash:input.inputHash,manuscriptSha256:input.manuscriptSha256,reportSha256:input.reportSha256,
    checkedChapterIds:['one','two'],coverage:{status:'complete',omissions:[]},
    evidence:chapters.map(c=>({chapterId:c.id,fragmentStart:1,fragmentEnd:1,role:'narration',actor:'房东',relevance:'条款说法。'})),
    anchors:['a','b'].map((id,i)=>({id,eventRef:'租赁条款',facet:'handover_status',state:'条款说法。',certainty:'stated',timeFrame:'current',evidence:code==='CASE_NEEDS_DISTINCT_EVIDENCE'?1:i+1})),
    transitions:[{id:'t',fromAnchorId:'a',toAnchorId:'b',relation:'after',certainty:'stated',reason:'后续陈述。',evidence:[1,2]}],
    cases:[{id:'contract',kind:'handover',subject:'招牌条款',impact:'major',assessment:'contradiction',reason:'条款说法冲突。',
      anchorIds:['a','b'],transitionIds:['t'],focusAnchorId:'b',repairScope:{assessment:'cross_chapter',reason:'跨章核查。'},
      identity:{assessment:'same',reason:'同一条款。',evidence:[1,2]},alternatives:[{explanation:'另有合同。',assessment:'ruled_out',evidence:[1,2]}],
      gap:{status:'none',description:'未列缺口。'},searchedChapterIds:['one','two']}],
    retention:{majorUnknownCaseIds:[],contradictionCaseIds:['contract'],nonLocalContradictionCaseIds:['contract']}};
  return {chapters,report,wire,args:{input,primaryRawResponse:JSON.stringify(wire),failureCode:code}};
}

for(const code of codes)test(`primary ${code} remains a strict unverified failure with exact raw and error binding`,()=>{
  const {chapters,report,wire,args}=fixture(code),before=structuredClone(args);
  assert.throws(()=>inspectContinuityChainReview(args.primaryRawResponse,args.input),{code});
  assert.equal(isContinuityChainPrimaryFailureError(new ContinuityError(code)),true);
  const envelope=createContinuityChainPrimaryFailureEnvelope(args);
  assert.equal(envelope.schemaVersion,'continuity-chain-primary-failure-1');
  assert.equal(envelope.failureCode,code);
  assert.equal(envelope.status,'continuity_chain_incomplete');
  for(const key of ['repairAttempted','semanticAcceptance','automaticRevisionEligible'])assert.equal(envelope[key],false);
  assert.equal(Object.hasOwn(envelope,'repairResponseSha256'),false);
  assert.deepEqual(validateContinuityChainFailureEnvelope(envelope,args),envelope);
  assert.deepEqual(extractContinuityChainFailureHistoricalObservations(args),envelope.historicalObservations);
  assert.equal(envelope.historicalObservations[0].failureCode,code);
  assert.equal(envelope.historicalObservations[0].revisionEligible,false);
  assert.throws(()=>validateContinuityChainFailureEnvelope(envelope,{...args,primaryRawResponse:args.primaryRawResponse+'\n'}),{code:'CONTINUITY_FAILURE_TAMPER'});
  assert.throws(()=>createContinuityChainPrimaryFailureEnvelope({...args,failureCode:codes.find(c=>c!==code)}),{code:'CONTINUITY_FAILURE_NOT_REPRODUCED'});
  for(const key of ['inputHash','manuscriptSha256','reportSha256'])
    assert.throws(()=>createContinuityChainPrimaryFailureEnvelope({...args,primaryRawResponse:JSON.stringify({...wire,[key]:'0'.repeat(64)})}),{code:'CONTINUITY_PRIMARY_FAILURE_BINDING'});
  const tamperedInput=structuredClone(args.input);tamperedInput.user+=' ';
  assert.throws(()=>createContinuityChainPrimaryFailureEnvelope({...args,input:tamperedInput}),{code:'INPUT_TAMPER'});
  const prepare=review=>createAdjudicationInput({chapters,review,protocolVersion:ADJUDICATION_CONTINUITY_VERSION});
  const review={...report,continuityChainFailure:envelope};
  assert.deepEqual(prepare(review).modelInput.issues.map(i=>i.issue),report.issues);
  const invented=structuredClone(review);invented.issues[0].continuityCaseId='contract';
  assert.throws(()=>prepare(invented),{code:'CONTINUITY_FAILURE_ISSUES'});
  const accepted=structuredClone(review);accepted.continuityChainFailure.semanticAcceptance=true;
  assert.throws(()=>prepare(accepted),{code:'CONTINUITY_FAILURE_FIELDS'});
  assert.throws(()=>createContinuityChainPrimaryFailureEnvelope(fixture(code,'continuity-chain-review-2').args),{code:'CONTINUITY_FAILURE_V3_ONLY'});
  assert.deepEqual(args,before);
  assert.throws(()=>inspectContinuityChainReview(args.primaryRawResponse,args.input),{code});
});

test('primary archive and adjudication admit exactly two known errors, not other routes or programming errors',()=>{
  const {chapters,report,wire,args}=fixture('CASE_FACETS');
  const envelope=createContinuityChainPrimaryFailureEnvelope(args);
  for(const code of ['CASE_TRANSITIONS','EXPLANATION_WITHOUT_EVIDENCE','RESPONSE_JSON','INVALID_FIELDS','UNKNOWN_BUG']){
    assert.equal(isContinuityChainPrimaryFailureError(new ContinuityError(code)),false);
    assert.throws(()=>createContinuityChainPrimaryFailureEnvelope({...args,failureCode:code}),{code:'CONTINUITY_PRIMARY_FAILURE_NOT_ALLOWED'});
    const forged=structuredClone(envelope);forged.failureCode=code;
    assert.throws(()=>createAdjudicationInput({chapters,review:{...report,continuityChainFailure:forged},protocolVersion:ADJUDICATION_CONTINUITY_VERSION}),{code:'CONTINUITY_FAILURE_FIELDS'});
  }
  for(const code of codes){
    assert.equal(isContinuityChainPrimaryFailureError(Object.assign(new TypeError('bug'),{code})),false);
    assert.equal(isContinuityChainPrimaryFailureError({code}),false);
  }
  wire.cases[0].transitionIds=['missing'];
  const raw=JSON.stringify(wire);
  assert.throws(()=>inspectContinuityChainReview(raw,args.input),{code:'CASE_TRANSITIONS'});
  assert.throws(()=>createContinuityChainPrimaryFailureEnvelope({...args,primaryRawResponse:raw}),{code:'CASE_TRANSITIONS'});
});
