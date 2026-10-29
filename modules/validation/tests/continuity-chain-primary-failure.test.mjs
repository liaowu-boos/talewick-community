import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {manuscriptFingerprint} from '../runtime/checks.mjs';
import {ContinuityError} from '../runtime/continuity-review.mjs';
import {createAdjudicationInput, ADJUDICATION_CONTINUITY_VERSION} from '../runtime/review-adjudication.mjs';
import {
  prepareContinuityChainReview, CONTINUITY_CHAIN_V3_VERSION,
  inspectContinuityChainReview, validateContinuityChainReview,
  CONTINUITY_CHAIN_PRIMARY_FAILURE_VERSION, isContinuityChainPrimaryFailureError,
  createContinuityChainPrimaryFailureEnvelope, validateContinuityChainFailureEnvelope,
  extractContinuityChainFailureHistoricalObservations,
  createContinuityChainFormatRepairInput, createContinuityChainFailureEnvelope,
} from '../runtime/continuity-chain-review.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(version = CONTINUITY_CHAIN_V3_VERSION) {
  const chapters = [
    {id:'one', title:'来电', body:'房东说合同没有规定招牌由谁拆。'},
    {id:'two', title:'交接', body:'房东说同一份合同规定招牌须由租户拆。'},
  ];
  const report = {manuscriptSha256:manuscriptFingerprint(chapters), issues:[{
    chapterId:'two', category:'STORY_COMPREHENSION_BLOCKER', severity:'must_fix',
    quote:chapters[1].body, explanation:'核查两次合同说法的差别。', suggestion:'先独立核查。',
  }]};
  const input = prepareContinuityChainReview({chapters,report}, {version});
  const wire = {
    inputHash:input.inputHash, manuscriptSha256:input.manuscriptSha256, reportSha256:input.reportSha256,
    checkedChapterIds:['one','two'], coverage:{status:'complete',omissions:[]},
    evidence:chapters.map(c => ({chapterId:c.id,fragmentStart:1,fragmentEnd:1,role:'narration',actor:'房东',relevance:'同一合同的拆除义务说法。'})),
    anchors:['未规定','规定租户拆'].map((state,i) => ({id:`a${i}`,eventRef:'同一合同',facet:'handover_status',state,certainty:'stated',timeFrame:'current',evidence:i+1})),
    transitions:[{id:'t',fromAnchorId:'a0',toAnchorId:'a1',relation:'after',certainty:'stated',reason:'后一次通话。',evidence:[1,2]}],
    cases:[{id:'contract',kind:'handover',subject:'招牌拆除义务',impact:'major',assessment:'contradiction',reason:'两次合同说法相冲突。',
      anchorIds:['a0','a1'],transitionIds:['t'],focusAnchorId:'a1',repairScope:{assessment:'cross_chapter',reason:'涉及两章。'},
      identity:{assessment:'same',reason:'同一合同。',evidence:[1,2]},
      alternatives:[{explanation:'换了合同。',assessment:'ruled_out',evidence:[1,2]}],
      gap:{status:'none',description:'未标记缺口。'},searchedChapterIds:['one','two']}],
    retention:{majorUnknownCaseIds:[],contradictionCaseIds:['contract'],nonLocalContradictionCaseIds:['contract']},
  };
  return {chapters,report,input,wire,args:{input,primaryRawResponse:JSON.stringify(wire),failureCode:'CASE_FACETS'}};
}

test('same primary raw still fails; envelope and history stay unverified without mutating inputs', () => {
  const {args} = fixture(), before = structuredClone(args);
  assert.throws(() => inspectContinuityChainReview(args.primaryRawResponse,args.input), {code:'CASE_FACETS'});
  const envelope = createContinuityChainPrimaryFailureEnvelope(args);
  assert.equal(envelope.schemaVersion,CONTINUITY_CHAIN_PRIMARY_FAILURE_VERSION);
  assert.equal(envelope.primaryResponseSha256,sha(args.primaryRawResponse));
  assert.equal(envelope.status,'continuity_chain_incomplete');
  for (const field of ['repairAttempted','semanticAcceptance','automaticRevisionEligible']) assert.equal(envelope[field],false);
  assert.equal(Object.hasOwn(envelope,'repairResponseSha256'),false);
  assert.deepEqual(validateContinuityChainFailureEnvelope(envelope,args),envelope);
  assert.deepEqual(extractContinuityChainFailureHistoricalObservations(args),envelope.historicalObservations);
  const [observation] = envelope.historicalObservations;
  assert.equal(observation.case.reportedAssessment,'contradiction');
  assert.equal(observation.semanticValidity,'unverified');
  assert.equal(observation.revisionEligible,false);
  assert.equal(observation.explicitlyClosed,false);
  assert.equal(observation.sourceResponseSha256,sha(args.primaryRawResponse));
  assert.deepEqual(args,before);
  assert.throws(() => inspectContinuityChainReview(args.primaryRawResponse,args.input), {code:'CASE_FACETS'});
});

test('even whitespace changes to the original raw invalidate a sealed envelope', () => {
  const {args} = fixture(), envelope = createContinuityChainPrimaryFailureEnvelope(args);
  assert.throws(() => validateContinuityChainFailureEnvelope(envelope,{...args,primaryRawResponse:args.primaryRawResponse+'\n'}), {code:'CONTINUITY_FAILURE_TAMPER'});
  for (const mutate of [
    v => v.primaryResponseSha256='0'.repeat(64),
    v => v.semanticAcceptance=true,
    v => v.historicalObservations[0].case.reportedAssessment='explained',
    v => v.historicalObservations[0].revisionEligible=true,
  ]) {
    const changed = structuredClone(envelope); mutate(changed);
    assert.throws(() => validateContinuityChainFailureEnvelope(changed,args), {code:'CONTINUITY_FAILURE_TAMPER'});
  }
});

test('wrong input, response binding, error code, malformed JSON, and other protocol errors reject', () => {
  const {args,wire} = fixture();
  const wrongInput = structuredClone(args.input); wrongInput.user+=' ';
  assert.throws(() => createContinuityChainPrimaryFailureEnvelope({...args,input:wrongInput}), {code:'INPUT_TAMPER'});
  assert.throws(() => createContinuityChainPrimaryFailureEnvelope({...args,primaryRawResponse:JSON.stringify({...wire,manuscriptSha256:'0'.repeat(64)})}), {code:'CONTINUITY_PRIMARY_FAILURE_BINDING'});
  assert.throws(() => createContinuityChainPrimaryFailureEnvelope({...args,failureCode:'RESPONSE_JSON'}), {code:'CONTINUITY_PRIMARY_FAILURE_NOT_ALLOWED'});
  assert.throws(() => createContinuityChainPrimaryFailureEnvelope({...args,primaryRawResponse:args.primaryRawResponse.slice(0,-1)}), {code:'RESPONSE_JSON'});
  const invalid = structuredClone(wire); delete invalid.coverage;
  assert.throws(() => createContinuityChainPrimaryFailureEnvelope({...args,primaryRawResponse:JSON.stringify(invalid)}), {code:'INVALID_FIELDS'});
  assert.throws(() => createContinuityChainPrimaryFailureEnvelope(fixture('continuity-chain-review-2').args), {code:'CONTINUITY_FAILURE_V3_ONLY'});
});

test('a valid chain result cannot be relabelled as primary failure; success contract stays intact', () => {
  const {args,wire} = fixture(); wire.anchors[1].facet='holder';
  const raw = JSON.stringify(wire), result = inspectContinuityChainReview(raw,args.input);
  assert.deepEqual(validateContinuityChainReview(result,args.input),result);
  assert.equal(result.modelReviewPassed,false);
  assert.equal(result.systemGo,false);
  assert.throws(() => createContinuityChainPrimaryFailureEnvelope({...args,primaryRawResponse:raw}), {code:'CONTINUITY_FAILURE_NOT_REPRODUCED'});
});

test('only an actual CASE_FACETS ContinuityError qualifies; programming errors escape', t => {
  assert.equal(isContinuityChainPrimaryFailureError(new ContinuityError('CASE_FACETS')),true);
  for (const error of [new ContinuityError('RESPONSE_JSON'), {code:'CASE_FACETS'}, Object.assign(new TypeError('bug'),{code:'CASE_FACETS'}), null])
    assert.equal(isContinuityChainPrimaryFailureError(error),false);
  const {args} = fixture(), originalParse = JSON.parse, bug = new TypeError('injected parser bug');
  t.mock.method(JSON,'parse',function(value,...rest) {
    if (value===args.primaryRawResponse) throw bug;
    return originalParse.call(this,value,...rest);
  });
  assert.throws(() => createContinuityChainPrimaryFailureEnvelope(args),error => error===bug);
});

test('adjudication may process original issues but cannot gain chain issues or acceptance', () => {
  const {args,chapters,report} = fixture(), envelope = createContinuityChainPrimaryFailureEnvelope(args);
  const review = {...report,continuityChainFailure:envelope};
  const prepare = review => createAdjudicationInput({chapters,review,protocolVersion:ADJUDICATION_CONTINUITY_VERSION});
  const input = prepare(review);
  assert.equal(input.modelInput.issues.length,1);
  assert.deepEqual(input.modelInput.issues[0].issue,report.issues[0]);
  assert.equal(input.sourceReview.continuityChainFailure.status,'continuity_chain_incomplete');
  const invented = structuredClone(review); invented.issues[0].continuityCaseId='contract';
  assert.throws(() => prepare(invented), {code:'CONTINUITY_FAILURE_ISSUES'});
  const wrongHash = structuredClone(review); wrongHash.continuityChainFailure.historicalObservations[0].sourceResponseSha256='0'.repeat(64);
  assert.throws(() => prepare(wrongHash), {code:'CONTINUITY_FAILURE_HISTORY'});
  const accepted = structuredClone(review); accepted.continuityChainFailure.automaticRevisionEligible=true;
  assert.throws(() => prepare(accepted), {code:'CONTINUITY_FAILURE_FIELDS'});
});

test('old format-failure envelope, history and v4 adjudication remain supported', () => {
  const {args,chapters,report} = fixture();
  const primaryRawResponse = args.primaryRawResponse.replace(',"manuscriptSha256"',',"","":"","manuscriptSha256"');
  const repairInput = createContinuityChainFormatRepairInput({input:args.input,invalidResponse:primaryRawResponse});
  const oldArgs = {input:args.input,primaryRawResponse,repairInput,repairRawResponse:args.primaryRawResponse,failureCode:'CASE_FACETS'};
  const envelope = createContinuityChainFailureEnvelope(oldArgs);
  assert.equal(envelope.schemaVersion,'continuity-chain-failure-1');
  assert.equal(envelope.repairAttempted,true);
  assert.deepEqual(validateContinuityChainFailureEnvelope(envelope,oldArgs),envelope);
  const {input,repairRawResponse,failureCode} = oldArgs;
  assert.deepEqual(extractContinuityChainFailureHistoricalObservations({input,repairInput,repairRawResponse,failureCode}),envelope.historicalObservations);
  const adjudication = createAdjudicationInput({chapters,review:{...report,continuityChainFailure:envelope},protocolVersion:ADJUDICATION_CONTINUITY_VERSION});
  assert.equal(adjudication.modelInput.issues.length,1);
  assert.deepEqual(adjudication.modelInput.issues[0].issue,report.issues[0]);
});
