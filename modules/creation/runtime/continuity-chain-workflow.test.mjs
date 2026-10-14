import test from 'node:test';
import assert from 'node:assert/strict';
import {runWorkflow} from './workflow.mjs';
import {reviewWorkflowContinuityChain, continuityChainWarnings, inheritContinuityDisputes} from './continuity-chain.mjs';
import {manuscriptFingerprint} from '../../validation/runtime/checks.mjs';

const chapters = [
  {id:'ch-1', title:'等候', body:'她说：“后天再来。”'},
  {id:'ch-2', title:'门外', body:'第二天，门仍然关着。'},
];
const report = {manuscriptSha256:manuscriptFingerprint(chapters), summary:'未发现必修。', issues:[], limitations:[]};

function unknownWire(user) {
  const input = JSON.parse(user), ids=input.chapters.map(c=>c.id);
  return JSON.stringify({inputHash:input.inputHash, manuscriptSha256:input.manuscriptSha256,
    reportSha256:input.reportSha256, checkedChapterIds:ids, coverage:{status:'complete', omissions:[]},
    evidence:input.chapters.map(c=>({chapterId:c.id,fragmentStart:1,fragmentEnd:1,
      role:'narration',actor:'叙述者',relevance:'时间锚点。'})),
    anchors:ids.map((_,i)=>({id:`a${i}`, eventRef:`场景${i}`, facet:'time_anchor', state:`相对日${i}`,
      certainty:'stated',timeFrame:'current',evidence:i+1})),
    transitions:[{id:'t',fromAnchorId:'a0',toAnchorId:'a1',relation:'unknown',certainty:'unknown',
      reason:'缺少共同日期起点。',evidence:[]}],
    cases:[{id:'unknown-time',kind:'timeline',subject:'回店期限',impact:'major',assessment:'unknown',
      reason:'两章没有足够信息绑定相对日期。',anchorIds:['a0','a1'],transitionIds:['t'],focusAnchorId:'a0',
      repairScope:{assessment:'unknown',reason:'尚不能定位错误。'},
      identity:{assessment:'unresolved',reason:'共同起点未知。',evidence:[]},
      alternatives:[{explanation:'可能并非同一起点。',assessment:'unresolved',evidence:[]}],
      gap:{status:'event_relation_missing',description:'两章日期关系未交代。'},searchedChapterIds:ids}],
    retention:{majorUnknownCaseIds:['unknown-time'],contradictionCaseIds:[],nonLocalContradictionCaseIds:[]}});
}

function failedFormatRepair(user) {
  const wire=JSON.parse(unknownWire(user));
  wire.cases[0].repairScope={assessment:'local_anchor',reason:'unknown 仍错误保留局部修订范围。'};
  const repairRawResponse=JSON.stringify(wire);
  return {repairRawResponse,primaryRawResponse:repairRawResponse.replace(',"retention":',',,"retention":')};
}

function store() {
  const saved = {};
  return {saved, step:async(key, execute)=>{
    if (!Object.hasOwn(saved,key)) saved[key]=structuredClone(await execute());
    return structuredClone(saved[key]);
  }};
}

test('chain bridge retains a major unknown even when both review and adjudication have no must_fix', async()=>{
  const journal=store(), calls=[];
  const model={complete:async args=>{calls.push(args);return unknownWire(args.user);}};
  const args={key:'review',chapters,review:report,requirements:{},model,step:journal.step};
  const merged=await reviewWorkflowContinuityChain(args);
  assert.deepEqual(merged.issues,[]);
  assert.equal(merged.continuityChain.retainedDisputes[0].caseId,'unknown-time');
  assert.equal(continuityChainWarnings(merged).length,1);
  assert.deepEqual(await reviewWorkflowContinuityChain(args),merged);
  assert.equal(calls.length,1);
  assert.equal(calls[0].stage,'continuity-chain-review');
  assert.equal(JSON.parse(calls[0].user).schemaVersion,'continuity-chain-review-2');
  assert.equal(JSON.parse(calls[0].user).evidenceBudget,undefined);
  assert.equal(Object.values(journal.saved).some(v=>typeof v?.rawResponse==='string'),true);
});

test('explicit v3 bridge selects the location-budget protocol while the default stays v2', async()=>{
  const journal=store(), calls=[];
  const merged=await reviewWorkflowContinuityChain({key:'review',chapters,review:report,requirements:{},
    version:'continuity-chain-review-3',step:journal.step,
    model:{complete:async args=>{calls.push(args);return unknownWire(args.user);}}});
  const input=JSON.parse(calls[0].user);
  assert.equal(input.schemaVersion,'continuity-chain-review-3');
  assert.equal(input.evidenceBudget.maxLocations,12);
  assert.equal(input.evidenceBudget.maxQuoteUtf16PerLocation,800);
  assert.equal(merged.continuityChain.schemaVersion,'continuity-chain-review-3');
  await assert.rejects(reviewWorkflowContinuityChain({key:'other',chapters,review:report,requirements:{},
    version:'continuity-chain-review-4',step:store().step,model:{complete:async()=>{throw new Error('must not call');}}}),
  {code:'CONTINUITY_CHAIN_CHECKPOINT_MISMATCH'});
});

test('v3 saves one returned format-repair failure and resumes without another model call', async()=>{
  const journal=store(),calls=[];let repairRawResponse;
  const model={complete:async args=>{
    calls.push(args);const value=JSON.parse(args.user);
    if(value.originalRequest)return repairRawResponse;
    const failed=failedFormatRepair(args.user);repairRawResponse=failed.repairRawResponse;
    return failed.primaryRawResponse;
  }};
  const args={key:'review',chapters,review:report,requirements:{},version:'continuity-chain-review-3',model,step:journal.step};
  const merged=await reviewWorkflowContinuityChain(args);
  assert.equal(calls.length,2);
  assert.equal(merged.continuityChain,undefined);
  assert.equal(merged.continuityChainFailure.status,'continuity_chain_incomplete');
  assert.equal(merged.continuityChainFailure.failureCode,'REPAIR_SCOPE');
  assert.equal(merged.continuityChainFailure.semanticAcceptance,false);
  assert.equal(merged.continuityChainFailure.automaticRevisionEligible,false);
  assert.deepEqual(merged.continuityChainFailure.historicalObservations.map(item=>item.case.id),['unknown-time']);
  assert.ok(Object.keys(journal.saved).some(key=>key.endsWith(':failure')));
  assert.ok(continuityChainWarnings(merged).some(w=>w.includes('事件链检查未完成')));
  const same=inheritContinuityDisputes({...report},merged);
  assert.deepEqual(same.continuityChainFailure,merged.continuityChainFailure);
  const changedChapters=chapters.map(item=>({...item,body:item.body+'后来又过了一天。'}));
  const changed=inheritContinuityDisputes({...report,manuscriptSha256:manuscriptFingerprint(changedChapters)},merged);
  assert.equal(changed.continuityChainFailure,undefined);
  assert.deepEqual(changed.continuityChainFailureHistory,[merged.continuityChainFailure]);
  assert.deepEqual(changed.continuityProtocolHistory.map(item=>item.case.id),['unknown-time']);
  assert.deepEqual(await reviewWorkflowContinuityChain(args),merged);
  assert.equal(calls.length,2);
  const failureKey=Object.keys(journal.saved).find(key=>key.endsWith(':failure'));
  journal.saved[failureKey].semanticAcceptance=true;
  await assert.rejects(reviewWorkflowContinuityChain(args),{code:'CONTINUITY_FAILURE_TAMPER'});
  assert.equal(calls.length,2);
});

test('v2 keeps throwing the returned format-repair failure and never creates a failure envelope', async()=>{
  const journal=store();let calls=0,repairRawResponse;
  const args={key:'review',chapters,review:report,requirements:{},step:journal.step,model:{complete:async input=>{
    calls++;const value=JSON.parse(input.user);
    if(value.originalRequest)return repairRawResponse;
    const failed=failedFormatRepair(input.user);repairRawResponse=failed.repairRawResponse;
    return failed.primaryRawResponse;
  }}};
  await assert.rejects(reviewWorkflowContinuityChain(args),{code:'REPAIR_SCOPE'});
  await assert.rejects(reviewWorkflowContinuityChain(args),{code:'REPAIR_SCOPE'});
  assert.equal(calls,2);
  assert.equal(Object.keys(journal.saved).some(key=>key.endsWith(':failure')),false);
});

test('saved chain response, parsed result and merge cannot be replaced on resume', async()=>{
  for (const suffix of [':input',':started',':response',':result',':merge','review']) {
    const journal=store();let calls=0;
    const args={key:'review',chapters,review:report,requirements:{},step:journal.step,
      model:{complete:async a=>{calls++;return unknownWire(a.user);}}};
    await reviewWorkflowContinuityChain(args);
    const key=Object.keys(journal.saved).find(k=>suffix==='review'?k==='review':k.endsWith(suffix));
    assert.ok(key);
    if(suffix===':response') journal.saved[key].rawResponse='{}';
    else if(suffix==='review') journal.saved[key].continuityChain.retainedDisputes=[];
    else journal.saved[key].tampered=true;
    await assert.rejects(reviewWorkflowContinuityChain(args));
    assert.equal(calls,1);
  }
});

test('invalid response remains saved and is not silently called again after a failed parse', async()=>{
  const journal=store();let calls=0;
  const args={key:'review',chapters,review:report,requirements:{},step:journal.step,
    model:{complete:async()=>{calls++;return '{}';}}};
  await assert.rejects(reviewWorkflowContinuityChain(args));
  await assert.rejects(reviewWorkflowContinuityChain(args));
  assert.equal(calls,1);
  assert.ok(Object.keys(journal.saved).some(k=>k.endsWith(':response')));
  assert.equal(journal.saved.review,undefined);
});

test('one relationship correction reuses the original raw and a failed correction never loops on resume', async()=>{
  for(const repairWorks of [true,false]){
    const journal=store();let calls=0;
    const model={complete:async args=>{
      calls++;const u=JSON.parse(args.user);
      if(u.originalRequest){
        const wire=JSON.parse(u.invalidResponse);
        if(repairWorks)wire.cases[0].anchorIds=['a0','a1'];
        return JSON.stringify(wire);
      }
      const wire=JSON.parse(unknownWire(args.user));wire.anchors.push({...wire.anchors[0],id:'a2'});
      wire.cases[0].anchorIds=['a0','a2'];return JSON.stringify(wire);
    }};
    const args={key:'review',chapters,review:report,requirements:{},model,step:journal.step};
    if(repairWorks){
      const result=await reviewWorkflowContinuityChain(args);assert.equal(result.continuityChain.retainedDisputes.length,1);
      await reviewWorkflowContinuityChain(args);
    }else{
      await assert.rejects(reviewWorkflowContinuityChain(args),{code:'CASE_TRANSITIONS'});
      await assert.rejects(reviewWorkflowContinuityChain(args),{code:'CASE_TRANSITIONS'});
    }
    assert.equal(calls,2);assert.equal(Object.keys(journal.saved).filter(k=>k.endsWith(':response')).length,2);
  }
});

test('one JSON recovery is checkpointed, flagged for independent reading and never re-called on resume', async()=>{
  const journal=store();let calls=0, valid;
  const args={key:'review',chapters,review:report,requirements:{},step:journal.step,model:{complete:async input=>{
    calls++;
    if (calls===1) {valid=unknownWire(input.user);return valid.replace(',"retention":',',,"retention":');}
    return valid;
  }}};
  const result=await reviewWorkflowContinuityChain(args);
  assert.equal(result.continuityFormatRecovery.newAutomaticRevisionsAllowed,false);
  assert.ok(continuityChainWarnings(result).some(w=>w.includes('仅完成格式恢复')));
  assert.deepEqual(await reviewWorkflowContinuityChain(args),result);
  assert.equal(calls,2);
  assert.equal(Object.keys(journal.saved).filter(key=>key.endsWith(':response')).length,2);
});

test('response checkpoint loss does not cause a second semantic decision after resume', async()=>{
  const journal=store();let calls=0,failWrite=true;
  const step=async(key,execute)=>{
    if(key.endsWith(':response')&&failWrite) { await execute();failWrite=false;throw new Error('disk write failed'); }
    return journal.step(key,execute);
  };
  const args={key:'review',chapters,review:report,requirements:{},step,
    model:{complete:async a=>{calls++;return unknownWire(a.user);}}};
  await assert.rejects(reviewWorkflowContinuityChain(args),/disk write failed/);
  await assert.rejects(reviewWorkflowContinuityChain(args),{code:'CONTINUITY_CHAIN_INTERRUPTED'});
  assert.equal(calls,1);
});

test('a reread omitting an earlier major unknown cannot silently close that historical observation', async()=>{
  const first=await reviewWorkflowContinuityChain({key:'first',chapters,review:report,requirements:{},
    model:{complete:async a=>unknownWire(a.user)},step:store().step});
  const revised=chapters.map(c=>({...c,body:c.body+'她等了一会儿。'}));
  const nextReport=inheritContinuityDisputes({...report,manuscriptSha256:manuscriptFingerprint(revised)},first);
  const next=await reviewWorkflowContinuityChain({key:'next',chapters:revised,review:nextReport,requirements:{},
    model:{complete:async a=>{
      const w=JSON.parse(unknownWire(a.user));w.evidence=[];w.anchors=[];w.transitions=[];w.cases=[];
      w.retention={majorUnknownCaseIds:[],contradictionCaseIds:[],nonLocalContradictionCaseIds:[]};return JSON.stringify(w);
    }},step:store().step});
  assert.deepEqual(next.continuityChain.retainedDisputes,[]);
  assert.equal(next.continuityDisputeHistory[0].sourceManuscriptSha256,first.manuscriptSha256);
  assert.equal(next.continuityDisputeHistory[0].revisionEligible,false);
  assert.ok(continuityChainWarnings(next).some(w=>w.includes('未再次提及不代表已解决')));
});

test('a bound protocol-failure observation remains unverified and cannot authorize revision', async()=>{
  const hash='0'.repeat(64);
  const observation={schemaVersion:'continuity-chain-unverified-observation-1',
    sourceProtocolVersion:'continuity-chain-review-2',sourceInputHash:hash,
    sourceManuscriptSha256:hash,sourceRequestSha256:hash,sourceResponseSha256:hash,
    failureCode:'LOCATION_QUOTE_BUDGET',case:{id:'case-low-cabinet',kind:'handover',subject:'矮柜交接',
      impact:'major',reportedAssessment:'unknown',reportedReason:'原响应协议失败，语义未经确认。'},
    status:'protocol_failed_unverified_historical_observation',semanticValidity:'unverified',
    revisionEligible:false,explicitlyClosed:false};
  const withHistory=inheritContinuityDisputes(report,undefined,[observation]);
  const merged=await reviewWorkflowContinuityChain({key:'review',chapters,review:withHistory,requirements:{},
    version:'continuity-chain-review-3',step:store().step,model:{complete:async a=>unknownWire(a.user)}});
  assert.deepEqual(merged.continuityProtocolHistory,[observation]);
  assert.equal(merged.continuityProtocolHistory[0].revisionEligible,false);
  assert.ok(continuityChainWarnings(merged).some(w=>w.includes('未经验证的历史观察')));
  assert.throws(()=>inheritContinuityDisputes(report,undefined,[{...observation,revisionEligible:true}]),
    {code:'CONTINUITY_CHAIN_CHECKPOINT_MISMATCH'});
});

const request={kind:'create',idea:'写两章等候的短篇，保留未决。'};
function worker() {
  const calls=[], chainInputs=[];
  return {calls,chainInputs,complete:async args=>{
    calls.push(args.stage);
    const input=JSON.parse(args.user);
    if(args.stage==='requirements') return JSON.stringify({summary:'等候',targetHanMin:1,targetHanMax:1000,
      targetChapterCount:2,assumptions:[],requiredElements:[],prohibitions:[]});
    if(args.stage==='planning') return JSON.stringify({title:'未定的日子',premise:'等待',ending:'未决',
      chapters:chapters.map(c=>({title:c.title,goal:'等待',scenes:['等候开门'],continuity:'未决',targetHanMin:40,targetHan:100,targetHanMax:150}))});
    if(args.stage.startsWith('draft:')) return chapters.find(c=>`draft:${c.id}`===args.stage).body;
    if(args.stage==='review') return JSON.stringify({summary:'没有必修。',issues:[],strengths:[],limitations:[]});
    if(args.stage==='continuity-review') return JSON.stringify({inputHash:input.inputHash,
      manuscriptSha256:input.manuscriptSha256,checkedChapterIds:input.chapters.map(c=>c.id),
      checkedDimensions:['knowledge','obligation','physical_state','time','promise'],
      coverage:{status:'complete',omissions:[]},comparisons:[],
      hintChecks:input.transitionHints.hints.map(h=>({hintId:h.id,status:'explained',comparisonIds:[],reason:'不构成事实重置。'}))});
    if(args.stage==='continuity-chain-review') {chainInputs.push(input);return unknownWire(args.user);}
    throw new Error(`unexpected ${args.stage}`);
  }};
}

function formatFailureWorker() {
  const value=worker(),complete=value.complete;let repairRawResponse;
  value.complete=async args=>{
    if(args.stage!=='continuity-chain-review')return complete(args);
    value.calls.push(args.stage);const input=JSON.parse(args.user);
    if(input.originalRequest)return repairRawResponse;
    value.chainInputs.push(input);
    const failed=failedFormatRepair(args.user);repairRawResponse=failed.repairRawResponse;
    return failed.primaryRawResponse;
  };
  return value;
}

test('actual v2 creation workflow invokes chain once and carries unresolved chain into the final result', async()=>{
  const artifacts={}, model=worker(), checkpoint=async(k,v)=>{artifacts[k]=v;};
  const args={request,createStateReviewMode:'create-state-review-v2',model,artifacts,checkpoint};
  const result=await runWorkflow(args);
  assert.equal(artifacts.requestSpec.reviewPolicyVersion,'review-adjudication-4');
  assert.equal(artifacts.requestSpec.runtimeVersion,'fixed-workflow-create-state-review-2');
  assert.equal(model.chainInputs[0].schemaVersion,'continuity-chain-review-2');
  assert.equal(model.chainInputs[0].evidenceBudget,undefined);
  assert.equal(model.calls.filter(s=>s==='continuity-chain-review').length,1);
  assert.deepEqual(result.chapters,chapters);
  assert.equal(result.reviewAdjudication.revisionEligibleIssueIds.length,0);
  assert.equal(result.review.continuityChain.retainedDisputes.length,1);
  assert.ok(result.warnings.some(w=>w.includes('重大证据缺口')));
  const count=model.calls.length;
  assert.deepEqual(await runWorkflow(args),result);
  assert.equal(model.calls.length,count);
  await assert.rejects(runWorkflow({...args,createStateReviewMode:'create-state-review-v1'}),/执行版本/);
  assert.equal(model.calls.length,count);
  artifacts.result.review.continuityChain.retainedDisputes=[];
  await assert.rejects(runWorkflow(args),/最终结果/);
});

test('actual v3 creation workflow binds create-state-review-3 and explicitly selects chain v3', async()=>{
  const artifacts={}, model=worker(), checkpoint=async(k,v)=>{artifacts[k]=v;};
  const args={request,createStateReviewMode:'create-state-review-v3',model,artifacts,checkpoint};
  const result=await runWorkflow(args);
  assert.equal(artifacts.requestSpec.createStateReviewMode,'create-state-review-v3');
  assert.equal(artifacts.requestSpec.runtimeVersion,'fixed-workflow-create-state-review-3');
  assert.equal(artifacts.requestSpec.reviewPolicyVersion,'review-adjudication-4');
  assert.equal(result.runtimeVersion,'fixed-workflow-create-state-review-3');
  assert.equal(model.chainInputs.length,1);
  assert.equal(model.chainInputs[0].schemaVersion,'continuity-chain-review-3');
  assert.equal(model.chainInputs[0].evidenceBudget.maxLocations,12);
  assert.equal(model.chainInputs[0].evidenceBudget.maxQuoteUtf16PerLocation,800);
  const count=model.calls.length;
  assert.deepEqual(await runWorkflow(args),result);
  assert.equal(model.calls.length,count);
  await assert.rejects(runWorkflow({...args,createStateReviewMode:'create-state-review-v2'}),/执行版本/);
  assert.equal(model.calls.length,count);
});

test('actual v3 workflow delivers the manuscript with an explicit incomplete quality status after saved repair failure', async()=>{
  const artifacts={},model=formatFailureWorker(),checkpoint=async(k,v)=>{artifacts[k]=v;};
  const args={request,createStateReviewMode:'create-state-review-v3',model,artifacts,checkpoint};
  const result=await runWorkflow(args);
  assert.deepEqual(result.chapters,chapters);
  assert.equal(result.revisionApplied,false);
  assert.equal(result.qualityCheckStatus,'incomplete');
  assert.equal(result.review.continuityChain,undefined);
  assert.equal(result.review.continuityChainFailure.status,'continuity_chain_incomplete');
  assert.equal(result.review.continuityChainFailure.failureCode,'REPAIR_SCOPE');
  assert.equal(result.reviewAdjudication.revisionEligibleIssueIds.length,0);
  assert.ok(result.warnings.some(w=>w.includes('事件链检查未完成')));
  assert.equal(model.calls.filter(stage=>stage==='continuity-chain-review').length,2);
  assert.ok(Object.keys(artifacts).some(key=>key.endsWith(':failure')));
  const count=model.calls.length;
  assert.deepEqual(await runWorkflow(args),result);
  assert.equal(model.calls.length,count);
  artifacts.result.qualityCheckStatus='complete';
  await assert.rejects(runWorkflow(args),/最终结果/);
  assert.equal(model.calls.length,count);
});

test('a controller reread of the identical failed manuscript preserves the failure without new review calls', async()=>{
  const artifacts={},model=formatFailureWorker();
  const controller={runtimeVersion:'failure-controller-1',review:async context=>{
    const review=await context.reviewManuscript(context.chapters,context.review.issues);
    const reviewAdjudication=await context.adjudicateReview(context.chapters,review);
    return {chapters:context.chapters,review,reviewAdjudication,trace:[]};
  }};
  const result=await runWorkflow({request,createStateReviewMode:'create-state-review-v3',controller,model,
    artifacts,checkpoint:async(k,v)=>{artifacts[k]=v;}});
  assert.equal(result.qualityCheckStatus,'incomplete');
  assert.equal(result.review.continuityChainFailure.status,'continuity_chain_incomplete');
  assert.equal(model.calls.filter(stage=>stage==='continuity-chain-review').length,2);
  assert.equal(model.calls.filter(stage=>stage==='review').length,1);
  assert.equal(model.calls.filter(stage=>stage==='continuity-review').length,1);
  assert.equal(model.calls.includes('agent:reviewManuscript'),false);
});

test('legacy create-state-review-v1 never invokes the new chain or changes its adjudication version', async()=>{
  const artifacts={}, model=worker();
  const result=await runWorkflow({request,createStateReviewMode:'create-state-review-v1',model,
    artifacts,checkpoint:async(k,v)=>{artifacts[k]=v;}});
  assert.equal(model.calls.includes('continuity-chain-review'),false);
  assert.equal(artifacts.requestSpec.reviewPolicyVersion,'review-adjudication-2');
  assert.equal(result.review.continuityChain,undefined);
});
