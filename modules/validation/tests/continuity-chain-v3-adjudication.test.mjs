import test from 'node:test';
import assert from 'node:assert/strict';
import {createContinuityInput} from '../runtime/continuity-review.mjs';
import {
  CONTINUITY_CHAIN_V3_VERSION,
  prepareContinuityChainReview,inspectContinuityChainReview,createContinuityChainAdjudicationInput,
} from '../runtime/continuity-chain-review.mjs';
import {ADJUDICATION_CONTINUITY_VERSION,createAdjudicationInput} from '../runtime/review-adjudication.mjs';

const historical=[{caseId:'case-low-cabinet',status:'protocol_failed_unverified_historical_observation',
  revisionEligible:false,explicitlyClosed:false}];

function fixture(version) {
  const chapters=[
    {id:'a',title:'一',body:'第一天，矮柜还在墙角。'},
    {id:'b',title:'二',body:'交接单写柜子已经抬走。'},
  ];
  const continuityInput=createContinuityInput({chapters});
  const report={manuscriptSha256:continuityInput.manuscriptSha256,issues:[],summary:'离线贯通夹具。',continuityDisputeHistory:structuredClone(historical)};
  const input=prepareContinuityChainReview({chapters,report},version?{version}:{});
  const chapterIds=chapters.map(item=>item.id);
  const evidence=input.modelInput.chapters.map(chapter=>({chapterId:chapter.id,fragmentStart:1,fragmentEnd:1,
    role:'narration',actor:'叙述者',relevance:'柜子状态。'}));
  const wire={inputHash:input.inputHash,manuscriptSha256:input.manuscriptSha256,reportSha256:input.reportSha256,
    checkedChapterIds:chapterIds,coverage:{status:'complete',omissions:[]},evidence,
    anchors:[
      {id:'a1',eventRef:'第三天早上',facet:'physical_state',state:'矮柜仍在',certainty:'stated',timeFrame:'current',evidence:1},
      {id:'a2',eventRef:'正式交接单',facet:'handover_status',state:'柜子已抬走',certainty:'stated',timeFrame:'current',evidence:2},
    ],
    transitions:[{id:'t1',fromAnchorId:'a1',toAnchorId:'a2',relation:'unknown',certainty:'unknown',reason:'中间处置未写。',evidence:[]}],
    cases:[{id:'case-low-cabinet-v3',kind:'handover',subject:'矮柜去向',impact:'major',assessment:'unknown',reason:'缺少中间处置。',
      anchorIds:['a1','a2'],transitionIds:['t1'],focusAnchorId:'a1',repairScope:{assessment:'unknown',reason:'不能局部自动修。'},
      identity:{assessment:'same',reason:'同一矮柜。',evidence:[1,2]},alternatives:[{explanation:'可能另行抬走。',assessment:'unresolved',evidence:[]}],
      gap:{status:'event_relation_missing',description:'缺少处置关系。'},searchedChapterIds:chapterIds}],
    retention:{majorUnknownCaseIds:['case-low-cabinet-v3'],contradictionCaseIds:[],nonLocalContradictionCaseIds:[]}};
  const continuity=inspectContinuityChainReview(JSON.stringify(wire),input);
  const merge=createContinuityChainAdjudicationInput({chapters,input,continuity,review:report});
  return {chapters,report,input,continuity,merge};
}

test('frozen v2 adjudication system and input hash remain exact', () => {
  const value=fixture();
  assert.equal(value.merge.adjudicationInput.inputHash,'29790c0f650255631ac518d5e357440072ce3cafd960d5017a91cf646bc50af5');
  assert(value.merge.adjudicationInput.system.includes('本版本只供显式continuity-chain-review-2合并结果使用。'));
  assert(!value.merge.adjudicationInput.system.includes('continuity-chain-review-3合并结果'));
});

test('v3 response flows through merge and v4 input while retaining historical and current unknowns', () => {
  const value=fixture(CONTINUITY_CHAIN_V3_VERSION),merged=value.merge.mergedReview;
  assert.equal(value.input.schemaVersion,'continuity-chain-review-3');
  assert.equal(merged.continuityChain.schemaVersion,'continuity-chain-review-3');
  assert.deepEqual(merged.continuityDisputeHistory,historical);
  assert.equal(merged.continuityDisputeHistory[0].revisionEligible,false);
  assert.equal(merged.continuityDisputeHistory[0].explicitlyClosed,false);
  assert.deepEqual(merged.continuityChain.candidateCaseIds,[]);
  assert.deepEqual(merged.continuityChain.retainedDisputes.map(item=>[item.caseId,item.status]),
    [['case-low-cabinet-v3','retained_unknown_not_revision_eligible']]);
  assert.equal(value.merge.adjudicationInput.schemaVersion,ADJUDICATION_CONTINUITY_VERSION);
  assert(value.merge.adjudicationInput.system.includes('continuity-chain-review-3合并结果使用；裁定门槛与v2相同。'));
  assert(!value.merge.adjudicationInput.system.includes('本版本只供显式continuity-chain-review-2合并结果使用。'));
  assert.deepEqual(value.merge.adjudicationInput.modelInput.issues,[]);
  const rebuilt=createAdjudicationInput({chapters:value.chapters,review:merged,protocolVersion:ADJUDICATION_CONTINUITY_VERSION});
  assert.deepEqual(rebuilt,value.merge.adjudicationInput);
});
