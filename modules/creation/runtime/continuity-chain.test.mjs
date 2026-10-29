import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {reviewWorkflowContinuityChain, continuityChainWarnings} from './continuity-chain.mjs';
import {runWorkflow} from './workflow.mjs';
import {mergeStateReview} from './state-review.mjs';
import {manuscriptFingerprint} from '../../validation/runtime/checks.mjs';
import {adjudicationFingerprint, createAdjudicationInput, ADJUDICATION_CONTINUITY_VERSION, ADJUDICATION_CONTINUITY_STAGE}
  from '../../validation/runtime/review-adjudication.mjs';
import {prepareContinuityChainReview, inspectContinuityChainReview, validateContinuityChainFailureEnvelope}
  from '../../validation/runtime/continuity-chain-review.mjs';

const version = 'continuity-chain-review-3';
const sha = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const chapters = [
  {id:'ch-1',title:'旧约',body:'合同上没有写招牌拆除的责任。'},
  {id:'ch-2',title:'验房',body:'合同已经写明招牌必须拆除。'},
];
const review = {summary:'合成协议测试，保留未决事项。',manuscriptSha256:manuscriptFingerprint(chapters),
  issues:[{chapterId:'ch-1',category:'STORY_COMPREHENSION_BLOCKER',severity:'must_fix',
    quote:chapters[0].body,explanation:'合成一般审稿意见，必须独立裁定。',suggestion:'核对原约定',evidenceVerified:true}],
  strengths:['保留场景'],limitations:['只用于协议测试'],readingObservations:[],
  stateReviewProvenance:{status:'synthetic_already_reviewed'}};

function fixture(selectedVersion = version) {
  const input = prepareContinuityChainReview({chapters,report:review},
    selectedVersion ? {version:selectedVersion} : {});
  const wire = {inputHash:input.inputHash,manuscriptSha256:input.manuscriptSha256,reportSha256:input.reportSha256,
    checkedChapterIds:chapters.map(c=>c.id),coverage:{status:'complete',omissions:[]},
    evidence:chapters.map(c=>({chapterId:c.id,fragmentStart:1,fragmentEnd:1,role:'narration',actor:'许照',relevance:'合成约定位置'})),
    anchors:[1,2].map(n=>({id:`a${n}`,eventRef:'同一合同的约定',facet:'handover_status',
      state:n===1?'未写责任':'写明责任',certainty:'stated',timeFrame:'current',evidence:n})),
    transitions:[{id:'t1',fromAnchorId:'a1',toAnchorId:'a2',relation:'same_event',certainty:'stated',
      reason:'合成同一约定',evidence:[1,2]}],
    cases:[{id:'contract',kind:'handover',subject:'同一合同的招牌拆除责任',impact:'major',assessment:'contradiction',
      reason:'仅合成门槛测试，不代表真实事实判断。',anchorIds:['a1','a2'],transitionIds:['t1'],focusAnchorId:'a2',
      repairScope:{assessment:'cross_chapter',reason:'两个章节'},identity:{assessment:'same',reason:'合成同一合同',evidence:[1,2]},
      alternatives:[{explanation:'是否另一份合同',assessment:'ruled_out',evidence:[1,2]}],
      gap:{status:'none',description:'合成对照'},searchedChapterIds:chapters.map(c=>c.id)}],
    retention:{majorUnknownCaseIds:[],contradictionCaseIds:['contract'],nonLocalContradictionCaseIds:['contract']}};
  const rawResponse = JSON.stringify(wire), prefix = `review:chain:${input.inputHash}`;
  return {input,wire,rawResponse,prefix,store:{
    [`${prefix}:input`]:input,
    [`${prefix}:started`]:{inputHash:input.inputHash,requestSha256:input.requestSha256},
    [`${prefix}:response`]:{inputHash:input.inputHash,requestSha256:input.requestSha256,
      rawResponse,responseSha256:adjudicationFingerprint(rawResponse)},
  }};
}

function memoryStep(store, writes = [], {readOnly = false} = {}) {
  return async (key, execute) => {
    if (Object.hasOwn(store,key)) return clone(store[key]);
    assert.equal(readOnly,false,`unexpected checkpoint ${key}`);
    const value = await execute();
    writes.push(key); store[key] = clone(value); return value;
  };
}
const noModel = {complete:async()=>assert.fail('unexpected model call')};
const chainArgs = (step, overrides={}) => ({key:'review',chapters,review,requirements:{},version,
  model:noModel,step,...overrides});

test('saved v3 primary rejection seals an incomplete review and resumes with no primary or repair call',async()=>{
  const f=fixture(),store=clone(f.store),writes=[];
  assert.throws(()=>inspectContinuityChainReview(f.rawResponse,f.input),{code:'CASE_FACETS'});
  const result=await reviewWorkflowContinuityChain(chainArgs(memoryStep(store,writes)));
  const failure=result.continuityChainFailure;
  assert.equal(failure.status,'continuity_chain_incomplete');
  assert.equal(failure.failureCode,'CASE_FACETS');assert.equal(failure.repairAttempted,false);
  assert.equal(failure.semanticAcceptance,false);assert.equal(failure.automaticRevisionEligible,false);
  assert.equal(failure.primaryResponseSha256,sha(f.rawResponse));
  assert.equal(failure.historicalObservations.length,1);
  assert.equal(failure.historicalObservations[0].semanticValidity,'unverified');
  assert.equal(failure.historicalObservations[0].revisionEligible,false);
  assert.deepEqual(result,{...review,continuityChainFailure:failure});
  assert.deepEqual(writes,[`${f.prefix}:primary-failure`,'review']);
  assert.equal(store[`${f.prefix}:failure`],undefined);assert.equal(store[`${f.prefix}:result`],undefined);
  for(const [key,value] of Object.entries(f.store))assert.deepEqual(store[key],value);
  validateContinuityChainFailureEnvelope(failure,{input:f.input,primaryRawResponse:f.rawResponse,failureCode:'CASE_FACETS'});
  const bound=createAdjudicationInput({chapters,review:result,requirements:{},protocolVersion:ADJUDICATION_CONTINUITY_VERSION});
  assert.equal(bound.modelInput.issues.length,review.issues.length);
  assert.equal(bound.modelInput.issues.some(i=>i.issue.continuityCaseId),false);
  assert.match(continuityChainWarnings(result).join('\n'),/未完成/);
  assert.doesNotMatch(continuityChainWarnings(result).join('\n'),/唯一纠正响应/);
  assert.deepEqual(await reviewWorkflowContinuityChain(chainArgs(memoryStep(store,[],{readOnly:true}))),result);
});

test('a new primary rejection is archived after its single original call without requesting repair',async()=>{
  const f=fixture(),store={},calls=[];
  const result=await reviewWorkflowContinuityChain(chainArgs(memoryStep(store),{
    model:{complete:async args=>{calls.push(args);return f.rawResponse;}},
  }));
  assert.equal(calls.length,1);assert.equal(result.continuityChainFailure.repairAttempted,false);
  assert.deepEqual(await reviewWorkflowContinuityChain(chainArgs(memoryStep(store,[],{readOnly:true}))),result);
});

test('primary failure replay rejects modified raw, forged envelope and replaced merged review',async()=>{
  const f=fixture(),base=clone(f.store);
  await reviewWorkflowContinuityChain(chainArgs(memoryStep(base)));
  for(const mutate of [
    store=>{store[`${f.prefix}:primary-failure`].automaticRevisionEligible=true;},
    store=>{const receipt=store[`${f.prefix}:response`];const raw=JSON.parse(receipt.rawResponse);
      raw.cases[0].reason='篡改后的观察';receipt.rawResponse=JSON.stringify(raw);
      receipt.responseSha256=adjudicationFingerprint(receipt.rawResponse);},
    store=>{store.review.issues=[];},
    store=>{store[`${f.prefix}:primary-failure`].failureCode='INVALID_FIELDS';},
  ]) {
    const store=clone(base);mutate(store);
    await assert.rejects(reviewWorkflowContinuityChain(chainArgs(memoryStep(store,[],{readOnly:true}))));
  }
});

test('default v2 still rejects primary CASE_FACETS, and valid v2 and v3 retain their success paths',async()=>{
  const f=fixture();
  // null deliberately selects the frozen v2 default.
  const old=fixture(null);
  await assert.rejects(reviewWorkflowContinuityChain(chainArgs(memoryStep(clone(old.store)),{version:undefined})),{code:'CASE_FACETS'});
  for(const selectedVersion of [undefined,version]) {
    const current=selectedVersion?f:old,store={};const valid=clone(current.wire);valid.anchors[1].facet='holder';
    const result=await reviewWorkflowContinuityChain(chainArgs(memoryStep(store),{
      version:selectedVersion,model:{complete:async()=>JSON.stringify(valid)},
    }));
    assert.equal(result.continuityChainFailure,undefined);
    assert.equal(result.continuityChain.schemaVersion,selectedVersion??'continuity-chain-review-2');
    assert.deepEqual(await reviewWorkflowContinuityChain(chainArgs(memoryStep(store,[],{readOnly:true}),{version:selectedVersion})),result);
  }
});

test('existing relation repair and the one JSON format repair retain success and old failure semantics',async()=>{
  for(const mode of ['relation','format_success','format_failure']) {
    const f=fixture(),wire=clone(f.wire);
    if(mode!=='format_failure')wire.anchors[1].facet='holder';
    const repaired=JSON.stringify(wire);
    if(mode==='relation')wire.cases[0].transitionIds=['missing'];
    const primary=mode==='relation'?JSON.stringify(wire):repaired.slice(0,-1)+',"","":""}';
    const store={},calls=[];
    const result=await reviewWorkflowContinuityChain(chainArgs(memoryStep(store),{
      model:{complete:async args=>{calls.push(args);return calls.length===1?primary:repaired;}},
    }));
    assert.equal(calls.length,2);assert.equal(store[`${f.prefix}:primary-failure`],undefined);
    if(mode==='format_failure') {
      assert.equal(result.continuityChainFailure.schemaVersion,'continuity-chain-failure-1');
      assert.equal(result.continuityChainFailure.repairAttempted,true);
      assert.equal(result.continuityChainFailure.failureCode,'CASE_FACETS');
      assert.ok(store[`${f.prefix}:failure`]);
    } else assert.ok(result.continuityChain);
    assert.deepEqual(await reviewWorkflowContinuityChain(chainArgs(memoryStep(store,[],{readOnly:true}))),result);
  }
});

test('transport errors and started calls without response remain errors and cannot become failure envelopes',async()=>{
  const f=fixture(),store={};let calls=0;
  const transport=Object.assign(new Error('synthetic transport failure'),{code:'CASE_FACETS'});
  await assert.rejects(reviewWorkflowContinuityChain(chainArgs(memoryStep(store),{
    model:{complete:async()=>{calls++;throw transport;}},
  })),error=>error===transport);
  assert.equal(calls,1);assert.equal(store[`${f.prefix}:response`],undefined);
  assert.equal(store[`${f.prefix}:primary-failure`],undefined);assert.equal(store.review,undefined);
  await assert.rejects(reviewWorkflowContinuityChain(chainArgs(memoryStep(store))),{code:'CONTINUITY_CHAIN_INTERRUPTED'});
  assert.equal(calls,1);
});

test('non-allowlisted protocol errors retain their original rejection without a failure envelope',async()=>{
  for(const code of ['RESPONSE_BINDING','INVALID_FIELDS']) {
    const f=fixture(),store=clone(f.store),wire=clone(f.wire);
    if(code==='RESPONSE_BINDING')wire.inputHash='0'.repeat(64);
    else wire.unexpected='extra field';
    const receipt=store[`${f.prefix}:response`];receipt.rawResponse=JSON.stringify(wire);
    receipt.responseSha256=adjudicationFingerprint(receipt.rawResponse);
    await assert.rejects(reviewWorkflowContinuityChain(chainArgs(memoryStep(store,[],{readOnly:true}))),{code});
    assert.equal(store[`${f.prefix}:primary-failure`],undefined);assert.equal(store.review,undefined);
  }
});

test('interruption after primary-failure persistence resumes only the missing review merge',async()=>{
  const f=fixture(),store=clone(f.store),step=memoryStep(store),stop=new Error('synthetic persistence interruption');
  await assert.rejects(reviewWorkflowContinuityChain(chainArgs(async(key,execute)=>{
    if(key==='review')throw stop;
    return step(key,execute);
  })),error=>error===stop);
  assert.ok(store[`${f.prefix}:primary-failure`]);assert.equal(store.review,undefined);
  const envelope=clone(store[`${f.prefix}:primary-failure`]),writes=[];
  const result=await reviewWorkflowContinuityChain(chainArgs(memoryStep(store,writes)));
  assert.deepEqual(writes,['review']);assert.deepEqual(result.continuityChainFailure,envelope);
  assert.deepEqual(result.issues,review.issues);
});

function readLocalJson(url) {
  const path=fileURLToPath(url);
  // Node Stats does not expose macOS st_flags. Refuse iCloud dataless reads.
  execFileSync('python3',['-c','import os,sys; assert not os.stat(sys.argv[1]).st_flags & 0x40000000, "dataless replay input"',path]);
  return {value:JSON.parse(readFileSync(path,'utf8')),sha256:sha(readFileSync(path))};
}
