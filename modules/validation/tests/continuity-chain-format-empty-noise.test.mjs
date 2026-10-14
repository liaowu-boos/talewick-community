import test from 'node:test';
import assert from 'node:assert/strict';
import {createContinuityInput} from '../runtime/continuity-review.mjs';
import {
  CONTINUITY_CHAIN_V3_VERSION,CONTINUITY_CHAIN_FORMAT_REPAIR_SYSTEM,
  prepareContinuityChainReview,inspectContinuityChainReview,createContinuityChainFormatRepairInput,
  inspectContinuityChainFormatRepairResponse,validateContinuityChainFormatRepairResult,
} from '../runtime/continuity-chain-review.mjs';

function fixture(version=CONTINUITY_CHAIN_V3_VERSION) {
  const chapters=[{id:'ch-1',title:'一',body:'钥匙一直由林岚保管。'},{id:'ch-2',title:'二',body:'后来林岚把钥匙交给胡姐。'}];
  const source=createContinuityInput({chapters});
  const report={manuscriptSha256:source.manuscriptSha256,issues:[],summary:'格式噪声夹具。'};
  const input=prepareContinuityChainReview({chapters,report},{version});
  assert(input.modelInput.chapters.every(chapter=>chapter.fragments.length===1));
  const wire={inputHash:input.inputHash,manuscriptSha256:input.manuscriptSha256,reportSha256:input.reportSha256,
    checkedChapterIds:['ch-1','ch-2'],coverage:{status:'complete',omissions:[]},evidence:[
      {chapterId:'ch-1',fragmentStart:1,fragmentEnd:1,role:'narration',actor:'叙述者',relevance:'早先柜子状态。'},
      {chapterId:'ch-2',fragmentStart:1,fragmentEnd:1,role:'narration',actor:'叙述者',relevance:'后续交接状态。'},
    ],anchors:[
      {id:'a1',eventRef:'早先状态',facet:'physical_state',state:'柜子仍在',certainty:'stated',timeFrame:'current',evidence:1},
      {id:'a2',eventRef:'确认单',facet:'handover_status',state:'柜子已抬走',certainty:'stated',timeFrame:'current',evidence:2},
    ],transitions:[{id:'t1',fromAnchorId:'a1',toAnchorId:'a2',relation:'after',certainty:'stated',reason:'正文明确后来交接。',evidence:[1,2]}],
    cases:[{id:'case-key',kind:'handover',subject:'钥匙交接',impact:'ordinary',assessment:'explained',reason:'后文明确交接解释持有人变化。',
      anchorIds:['a1','a2'],transitionIds:['t1'],focusAnchorId:'a1',repairScope:{assessment:'local_anchor',reason:'explained不能使用local_anchor。'},
      identity:{assessment:'same',reason:'同一钥匙。',evidence:[1,2]},alternatives:[{explanation:'明确交接解释状态变化。',assessment:'plausible',evidence:[1,2]}],
      gap:{status:'none',description:'前后状态和交接均有证据。'},searchedChapterIds:['ch-1','ch-2']}],
    retention:{majorUnknownCaseIds:[],contradictionCaseIds:[],nonLocalContradictionCaseIds:[]}};
  const valid=JSON.stringify(wire),needle='"reason":"explained不能使用local_anchor。"}';
  assert(valid.includes(needle));
  return {input,wire,valid,needle};
}

test('v3 format snapshot accepts only exact empty-field syntax noise and repairs explained local scope', () => {
  const f=fixture(),invalid=f.valid.replace(f.needle,'"reason":"explained不能使用local_anchor。","","":""}');
  assert.throws(()=>inspectContinuityChainReview(invalid,f.input),{code:'RESPONSE_JSON'});
  const repair=createContinuityChainFormatRepairInput({input:f.input,invalidResponse:invalid});
  assert.equal(repair.system,CONTINUITY_CHAIN_FORMAT_REPAIR_SYSTEM);
  assert.deepEqual(repair.preservation.cases[0].slice(0,7),['case-key','handover','钥匙交接','ordinary','explained','后文明确交接解释持有人变化。','a1']);
  const corrected=structuredClone(f.wire);
  corrected.cases[0].repairScope={assessment:'cross_chapter',reason:'case锚点跨两章，且explained不能使用local_anchor。'};
  const result=inspectContinuityChainFormatRepairResponse(JSON.stringify(corrected),repair);
  assert.equal(result.result.cases[0].assessment,'explained');
  assert.equal(result.result.cases[0].repairScope.assessment,'cross_chapter');
  assert.deepEqual(result.result.retention.majorUnknownCaseIds,[]);
  assert.deepEqual(validateContinuityChainFormatRepairResult(result,repair),result);
});

test('non-empty extra semantics beside the empty noise are rejected before preservation', () => {
  const f=fixture(),invalid=f.valid.replace(f.needle,'"reason":"explained不能使用local_anchor。","","":"","evil":"meaning"}');
  assert.throws(()=>inspectContinuityChainReview(invalid,f.input),{code:'RESPONSE_JSON'});
  assert.throws(()=>createContinuityChainFormatRepairInput({input:f.input,invalidResponse:invalid}),{code:'INVALID_FIELDS'});
});

test('v2 keeps its frozen format-repair system while using the same strict empty-noise recognizer', () => {
  const f=fixture('continuity-chain-review-2'),invalid=f.valid.replace(f.needle,'"reason":"explained不能使用local_anchor。","","":""}');
  const repair=createContinuityChainFormatRepairInput({input:f.input,invalidResponse:invalid});
  assert.equal(repair.system,CONTINUITY_CHAIN_FORMAT_REPAIR_SYSTEM);
  assert(repair.system.includes('非法local_anchor改成unknown或有跨章锚支持的cross_chapter'));
});
