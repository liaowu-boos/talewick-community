import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTINUITY_CHAIN_VERSION, CONTINUITY_CHAIN_V3_VERSION,
  CONTINUITY_CHAIN_SYSTEM, CONTINUITY_CHAIN_V3_SYSTEM,
  prepareContinuityChainReview, inspectContinuityChainReview,
  createContinuityChainHistoricalObservation, validateContinuityChainHistoricalObservation,
} from '../runtime/continuity-chain-review.mjs';
import {createContinuityInput} from '../runtime/continuity-review.mjs';

function sourceFor(chapters) {
  const input=createContinuityInput({chapters});
  return {chapters,report:{manuscriptSha256:input.manuscriptSha256,issues:[],summary:'离线预算夹具。'}};
}

function emptyWire(input,evidence,anchors=[]) {
  return {inputHash:input.inputHash,manuscriptSha256:input.manuscriptSha256,reportSha256:input.reportSha256,
    checkedChapterIds:input.modelInput.chapters.map(item=>item.id),coverage:{status:'complete',omissions:[]},
    evidence,anchors,transitions:[],cases:[],retention:{majorUnknownCaseIds:[],contradictionCaseIds:[],nonLocalContradictionCaseIds:[]}};
}

test('v2 stays the default while explicit v3 exposes an executable 12 by 800 budget', () => {
  const source=sourceFor([{id:'ch-1',title:'一',body:'一句短正文。'}]);
  const v2=prepareContinuityChainReview(source),v3=prepareContinuityChainReview(source,{version:CONTINUITY_CHAIN_V3_VERSION});
  const p2=JSON.parse(v2.user),p3=JSON.parse(v3.user);
  assert.equal(v2.schemaVersion,CONTINUITY_CHAIN_VERSION);
  assert.equal(v2.schemaVersion,'continuity-chain-review-2');
  assert.equal(Object.hasOwn(p2,'evidenceBudget'),false);
  assert.equal(p2.responseSchema.properties.evidence.maxItems,6);
  assert.equal(v2.system,CONTINUITY_CHAIN_SYSTEM);
  assert.equal(v3.schemaVersion,'continuity-chain-review-3');
  assert.equal(v3.schemaVersion,CONTINUITY_CHAIN_V3_VERSION);
  assert.deepEqual(p3.evidenceBudget,{
    maxLocations:12,maxQuoteUtf16PerLocation:800,maxEvidenceReferencesPerField:6,maxAnchors:48,
    range:'same-chapter-inclusive-fragment-ids',
    quoteLengthFormula:'fragments[fragmentEnd-1].end - fragments[fragmentStart-1].start',
    limitsAreCapsNotTargets:true,shareLocationOnlyWhenQuoteSupportsEveryAnchor:true,
    overflow:'coverage-bounded-with-named-omissions',
  });
  assert.equal(p3.responseSchema.properties.evidence.maxItems,12);
  assert.equal(p3.responseSchema.properties.anchors.items.properties.evidence.maximum,12);
  assert.equal(v3.system,CONTINUITY_CHAIN_V3_SYSTEM);
  assert(v3.system.includes('必须小于等于800'));
  assert(v3.system.includes('不能删减已识别的major unknown'));
  assert.throws(()=>prepareContinuityChainReview(source,{version:'continuity-chain-review-99'}),{code:'UNSUPPORTED_CHAIN_VERSION'});
});

test('v3 accepts seven narrow locations while the unchanged v2 schema rejects the same count', () => {
  const source=sourceFor(Array.from({length:7},(_,index)=>({id:`ch-${index+1}`,title:`章${index+1}`,body:`第${index+1}章的短事实。`})));
  const makeEvidence=input=>input.modelInput.chapters.map((chapter,index)=>({chapterId:chapter.id,fragmentStart:1,fragmentEnd:1,
    role:'narration',actor:'叙述者',relevance:`第${index+1}个窄位置。`}));
  const makeAnchors=evidence=>evidence.map((_,index)=>({id:`a${index+1}`,eventRef:`事件${index+1}`,facet:'physical_state',
    state:`状态${index+1}`,certainty:'stated',timeFrame:'current',evidence:index+1}));
  const v3=prepareContinuityChainReview(source,{version:CONTINUITY_CHAIN_V3_VERSION}),e3=makeEvidence(v3);
  const parsed=inspectContinuityChainReview(JSON.stringify(emptyWire(v3,e3,makeAnchors(e3))),v3);
  assert.equal(parsed.evidence.length,7);
  assert(parsed.evidence.every(item=>item.end-item.start<=800));
  const v2=prepareContinuityChainReview(source),e2=makeEvidence(v2);
  assert.throws(()=>inspectContinuityChainReview(JSON.stringify(emptyWire(v2,e2,makeAnchors(e2))),v2),{code:'LIST_BUDGET'});
});

test('a quote-budget failure can retain a bound case only as an unverified historical observation', () => {
  const source=sourceFor([{id:'ch-1',title:'长章',body:'甲'.repeat(1000)}]);
  const input=prepareContinuityChainReview(source);
  const evidence=[
    {chapterId:'ch-1',fragmentStart:1,fragmentEnd:3,role:'narration',actor:'叙述者',relevance:'故意超过八百字符的失败位置。'},
    {chapterId:'ch-1',fragmentStart:4,fragmentEnd:4,role:'narration',actor:'叙述者',relevance:'第二个不同位置。'},
  ];
  const anchors=[
    {id:'a1',eventRef:'早先状态',facet:'physical_state',state:'甲',certainty:'stated',timeFrame:'current',evidence:1},
    {id:'a2',eventRef:'后续状态',facet:'physical_state',state:'甲',certainty:'unknown',timeFrame:'unknown',evidence:2},
  ];
  const wire={...emptyWire(input,evidence,anchors),transitions:[{id:'t1',fromAnchorId:'a1',toAnchorId:'a2',relation:'unknown',certainty:'unknown',reason:'缺少关系。',evidence:[]}],
    cases:[{id:'case-major-unknown',kind:'object_custody',subject:'失败响应中的重大未知',impact:'major',assessment:'unknown',reason:'仅是失败响应报告的观察。',
      anchorIds:['a1','a2'],transitionIds:['t1'],focusAnchorId:'a1',repairScope:{assessment:'unknown',reason:'尚未验证。'},
      identity:{assessment:'unresolved',reason:'尚未验证。',evidence:[]},alternatives:[{explanation:'可能有省略动作。',assessment:'unresolved',evidence:[]}],
      gap:{status:'evidence_missing',description:'协议失败。'},searchedChapterIds:['ch-1']}],
    retention:{majorUnknownCaseIds:['case-major-unknown'],contradictionCaseIds:[],nonLocalContradictionCaseIds:[]}};
  const raw=JSON.stringify(wire);
  assert.throws(()=>inspectContinuityChainReview(raw,input),{code:'LOCATION_QUOTE_BUDGET'});
  const args={input,invalidResponse:raw,failureCode:'LOCATION_QUOTE_BUDGET',caseId:'case-major-unknown'};
  const saved=createContinuityChainHistoricalObservation(args);
  assert.equal(saved.status,'protocol_failed_unverified_historical_observation');
  assert.equal(saved.semanticValidity,'unverified');
  assert.equal(saved.revisionEligible,false);
  assert.equal(saved.explicitlyClosed,false);
  assert.equal(saved.case.reportedAssessment,'unknown');
  assert.deepEqual(validateContinuityChainHistoricalObservation(saved,args),saved);
  assert.throws(()=>createContinuityChainHistoricalObservation({...args,failureCode:'RESPONSE_JSON'}),{code:'HISTORICAL_OBSERVATION_FAILURE_MISMATCH'});
});
