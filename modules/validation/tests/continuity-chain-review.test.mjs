import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTINUITY_CHAIN_STAGE, CONTINUITY_CHAIN_LIMITS, CONTINUITY_CHAIN_VERSION,
  CONTINUITY_CHAIN_REPAIR_VERSION,
  prepareContinuityChainReview, inspectContinuityChainReview, validateContinuityChainReview,
  createContinuityChainAdjudicationInput, validateContinuityChainAdjudicationInput, runContinuityChainReview,
  createContinuityChainRepairInput, inspectContinuityChainRepairResponse,
  validateContinuityChainRepairResult, repairContinuityChainReview,
} from '../runtime/continuity-chain-review.mjs';
import {
  ADJUDICATION_VERSION, ADJUDICATION_RELIABILITY_VERSION, ADJUDICATION_CONTINUITY_VERSION,
  ADJUDICATION_CONTINUITY_STAGE, ADJUDICATION_CONTINUITY_REPAIR_STAGE,
  createAdjudicationInput, createAdjudicationRepairInput, normalizeAdjudication, adjudicateReview,
} from '../runtime/review-adjudication.mjs';
import {continuityChainScenarios, continuityChainExpectedResults, getContinuityChainScenario} from './fixtures/continuity-chain-scenarios.mjs';

const clone = structuredClone;
const cite = (input, chapterId, pattern, role = 'narration') => {
  const chapter = input.modelInput.chapters.find(item => item.id === chapterId);
  const index = chapter.fragments.findIndex(fragment => fragment.text.includes(pattern));
  assert.notEqual(index,-1,`missing fixture fragment: ${chapterId}/${pattern}`);
  return {chapterId,fragmentStart:index+1,fragmentEnd:index+1,role,actor:'固定夹具叙述主体',relevance:'固定夹具中的事件锚点；语义标签仍由独立验证决定。'};
};
const anchor = (id,eventRef,facet,state,evidence,extra={}) => ({id,eventRef,facet,state,certainty:'stated',timeFrame:'current',evidence,...extra});
const transition = (id,fromAnchorId,toAnchorId,relation,evidence,extra={}) => ({id,fromAnchorId,toAnchorId,relation,certainty:'stated',reason:'固定夹具给定的事件关系。',evidence,...extra});

function wireFor(id) {
  const source = getContinuityChainScenario(id), input = prepareContinuityChainReview({chapters:source.chapters,report:source.report});
  const ids = source.chapters.map(item => item.id), expected = continuityChainExpectedResults[id];
  let evidence, anchors, transitions, kind, alternatives, gap;
  if (id === 'synthetic-timeline-conflict') {
    evidence = [cite(input,'ch-1','三天之内'),cite(input,'ch-3','第二天早上'),cite(input,'ch-4','后天下午'),cite(input,'ch-6','第二天上午'),cite(input,'ch-9','第三天早上')];
    anchors = evidence.map((_,i) => anchor(`a${i+1}`,['合同三日期限起点','第二天早上清店','同日下午验房措辞','随后再次称第二天上午','后文又称第三天早上'][i],'time_anchor',['三天内交钥匙且看房日为后天','第二天早上','仍称看房日为后天','再次出现第二天上午','第三天早上'][i],i+1));
    transitions = [transition('t1','a1','a2','next_day',[1,2]),transition('t2','a2','a3','same_event',[2,3]),transition('t3','a3','a4','next_day',[3,4]),transition('t4','a4','a5','after',[4,5])];
    kind='timeline'; alternatives=[{explanation:'把每个“第二天/第三天”改用不同起点解释。',assessment:'ruled_out',evidence:[1,2,3,4,5]}]; gap={status:'none',description:'锚点和相邻事件关系均有正文位置。'};
  } else if (id === 'synthetic-handover-conflict') {
    evidence=[cite(input,'ch-10','只剩展架'),cite(input,'ch-10','两间空的'),cite(input,'ch-10','管理员先签'),cite(input,'ch-10','天黑以后')];
    anchors=[anchor('a1','签单前现场','site_availability','展架和工具仍在',1),anchor('a2','正式交接口头确认','handover_status','宣称两间空的',2),anchor('a3','正式签字及钥匙移交','access_rights','接收方收走全部钥匙',3),anchor('a4','签字后清运','physical_state','天黑后才搬走大件',4)];
    transitions=[transition('t1','a1','a2','same_event',[1,2]),transition('t2','a2','a3','after',[2,3]),transition('t3','a3','a4','after',[3,4])];
    kind='handover'; alternatives=[{explanation:'签字前已清空或交接单明确接受全部遗留物。',assessment:'ruled_out',evidence:[1,2,3,4]}]; gap={status:'none',description:'签字、钥匙和后续清运状态均有正文位置。'};
  } else if (id === 'explicit-reschedule-counterexample') {
    evidence=[cite(input,'a','原定周三'),cite(input,'b','改到周五'),cite(input,'c','十年前'),cite(input,'d','三天后')];
    anchors=[anchor('a1','原定日期','time_anchor','周三',1),anchor('a2','补签改期','time_anchor','改到周五',2),anchor('a3','旧合同回忆','time_anchor','十年前的周三',3,{timeFrame:'flashback'}),anchor('a4','实际履行','time_anchor','周五',4)];
    transitions=[transition('t1','a1','a2','rescheduled',[1,2]),transition('t2','a2','a3','flashback',[3]),transition('t3','a2','a4','elapsed',[2,4])];
    kind='timeline'; alternatives=[{explanation:'正文明确改期、非连续日期跳转并标出另一份旧合同回忆。',assessment:'plausible',evidence:[2,3,4]}]; gap={status:'none',description:'日期变化由明确改期和插叙解释。'};
  } else if (id === 'temporary-key-counterexample') {
    evidence=[cite(input,'a','备用钥匙临时交给'),cite(input,'b','双方这才移交')];
    anchors=[anchor('a1','临时施工许可','access_rights','备用钥匙临时交付且原方保留主钥匙和进店权',1),anchor('a2','正式交接','handover_status','归还备用钥匙并接受列明遗留物后正式移交',2)];
    transitions=[transition('t1','a1','a2','after',[1,2])]; kind='handover';
    alternatives=[{explanation:'临时钥匙、保留访问权和明确接受遗留物解释了状态变化。',assessment:'plausible',evidence:[1,2]}]; gap={status:'none',description:'临时与正式交接边界明确。'};
  } else if (id === 'insufficient-date-boundary') {
    evidence=[cite(input,'a','后天再来'),cite(input,'b','第二天')];
    anchors=[anchor('a1','人物相对日期','time_anchor','后天',1,{certainty:'stated'}),anchor('a2','叙述相对日期','time_anchor','第二天',2,{certainty:'stated'})];
    transitions=[transition('t1','a1','a2','unknown',[],{certainty:'unknown'})]; kind='timeline';
    alternatives=[{explanation:'缺少共同起点或场景连接。',assessment:'unresolved',evidence:[]}]; gap={status:'event_relation_missing',description:'无法把两个相对日期绑定到同一计数起点。'};
  } else {
    evidence=[cite(input,'a','主钥匙在小禾'),cite(input,'b','小江用主钥匙')];
    anchors=[anchor('a1','上午持有','holder','小禾持有主钥匙',1),anchor('a2','三天后使用','holder','小江使用主钥匙',2)];
    transitions=[transition('t1','a1','a2','unknown',[],{certainty:'unknown'})]; kind='object_custody';
    alternatives=[{explanation:'中间可能发生了未写出的合法转交。',assessment:'unresolved',evidence:[]}]; gap={status:'evidence_missing',description:'缺少交付、借用或取用过程，不能确认矛盾。'};
  }
  const local=id==='synthetic-handover-conflict', focusAnchorId=id==='synthetic-timeline-conflict'?'a3':id==='synthetic-handover-conflict'?'a2':'a1';
  const repairScope=expected==='contradiction'?(local?{assessment:'local_anchor',reason:'争点可定位到签单时的局部场景。'}:{assessment:'cross_chapter',reason:'需要统一多个章节的日期锚，不能交给单章受限修订。'}):{assessment:'unknown',reason:'本例不形成局部修订候选。'};
  const caseItem={id:'case-1',kind,subject:`${id} 的主链`,impact:'major',assessment:expected,
    reason:'固定夹具的预封存判断，用于校验协议结构而非证明模型语义。',anchorIds:anchors.map(a=>a.id),transitionIds:transitions.map(t=>t.id),
    focusAnchorId,repairScope,identity:{assessment:'same',reason:'夹具把锚点声明为同一事件链或同一具体对象。',evidence:[1,evidence.length]},alternatives,gap,searchedChapterIds:ids};
  const crossChapter = new Set(evidence.map(e=>e.chapterId)).size>1;
  const wire={inputHash:input.inputHash,manuscriptSha256:input.manuscriptSha256,reportSha256:input.reportSha256,
    checkedChapterIds:ids,coverage:{status:'complete',omissions:[]},evidence,anchors,transitions,cases:[caseItem],
    retention:{majorUnknownCaseIds:expected==='unknown'&&crossChapter?['case-1']:[],contradictionCaseIds:expected==='contradiction'?['case-1']:[],
      nonLocalContradictionCaseIds:expected==='contradiction'&&!local?['case-1']:[]}};
  return {source,input,wire,parse:()=>inspectContinuityChainReview(JSON.stringify(wire),input)};
}

test('six sealed scenarios cover two conflicts, two explicit explanations and two evidence boundaries', () => {
  assert.equal(continuityChainScenarios.length,6);
  assert.deepEqual(Object.values(continuityChainExpectedResults).sort(),['contradiction','contradiction','explained','explained','unknown','unknown']);
  for (const source of continuityChainScenarios) {
    assert.equal(Object.hasOwn(source,'expectation'),false);
    const f=wireFor(source.id), payload=JSON.parse(f.input.user);
    assert.deepEqual(Object.keys(payload.report).sort(),['issues','manuscriptSha256','summary']);
    assert.equal(payload.report.summary,'固定离线复核输入。');
    for (const scenario of continuityChainScenarios) assert.equal(f.input.user.includes(scenario.id),false);
    assert.equal(Object.hasOwn(payload,'id'),false);
    assert.equal(JSON.stringify(payload).includes('expected'),false);
    const parsed=f.parse(); assert.equal(parsed.cases[0].assessment,continuityChainExpectedResults[source.id]);
    assert.deepEqual(validateContinuityChainReview(parsed,f.input),parsed);
  }
});

test('Synthetic timeline and handover conflicts expose explicit multi-anchor chains rather than sample keywords', () => {
  const time=wireFor('synthetic-timeline-conflict').parse(), handover=wireFor('synthetic-handover-conflict').parse();
  assert.equal(time.anchors.length,5); assert.equal(time.transitions.length,4); assert.deepEqual(time.retention.contradictionCaseIds,['case-1']);
  assert.deepEqual(time.retention.nonLocalContradictionCaseIds,['case-1']); assert.deepEqual(handover.retention.nonLocalContradictionCaseIds,[]);
  assert.deepEqual(new Set(time.anchors.map(a=>a.facet)),new Set(['time_anchor']));
  assert.deepEqual(new Set(handover.anchors.map(a=>a.facet)),new Set(['site_availability','handover_status','access_rights','physical_state']));
  assert.equal(time.semanticValidity,'not_programmatically_verified'); assert.equal(handover.systemGo,false);
});

test('contradiction cannot retain an unknown transition, open gap or plausible alternative', () => {
  for (const edit of [
    w=>{w.transitions[0].relation='unknown';w.transitions[0].certainty='unknown';w.transitions[0].evidence=[];},
    w=>{w.cases[0].gap={status:'event_relation_missing',description:'仍缺事件关系。'};},
    w=>{w.cases[0].alternatives[0].assessment='plausible';},
  ]) {
    const f=wireFor('synthetic-timeline-conflict'); edit(f.wire); assert.throws(()=>f.parse());
  }
});

test('major cross-chapter unknown is retained exactly and cannot be promoted by changing one label', () => {
  const f=wireFor('insufficient-date-boundary'); assert.deepEqual(f.parse().retention.majorUnknownCaseIds,['case-1']);
  const missing=wireFor('insufficient-date-boundary'); missing.wire.retention.majorUnknownCaseIds=[];
  assert.throws(()=>missing.parse(),{code:'RETENTION_MISMATCH'});
  const promoted=wireFor('insufficient-date-boundary'); promoted.wire.cases[0].assessment='contradiction'; promoted.wire.retention={majorUnknownCaseIds:[],contradictionCaseIds:['case-1'],nonLocalContradictionCaseIds:[]};
  assert.throws(()=>promoted.parse());
});

test('a major single-chapter uncertainty is retained with or without an optional wire retention entry', () => {
  for (const listed of [false,true]) {
    const f=wireFor('synthetic-handover-conflict');
    Object.assign(f.wire.cases[0],{assessment:'unknown',repairScope:{assessment:'unknown',reason:'交接边界仍需核实。'},
      gap:{status:'evidence_missing',description:'未明确说明单据是否接受遗留物。'},
      alternatives:[{explanation:'接收方可能接受遗留物。',assessment:'unresolved',evidence:[1,2]}]});
    f.wire.retention={majorUnknownCaseIds:listed?['case-1']:[],contradictionCaseIds:[],nonLocalContradictionCaseIds:[]};
    const result=f.parse();
    const merged=createContinuityChainAdjudicationInput({chapters:f.source.chapters,input:f.input,continuity:result,review:f.source.report});
    assert.deepEqual(merged.continuityEvidence.retainedDisputeCaseIds,['case-1']);
    assert.equal(merged.mergedReview.issues.length,0);
    f.wire.retention.majorUnknownCaseIds=['not-a-case'];
    assert.throws(()=>f.parse(),{code:'RETENTION_MISMATCH'});
  }
});

test('a clean response may contain no evidence, anchors, transitions or cases', () => {
  const f=wireFor('insufficient-date-boundary');
  f.wire.evidence=[]; f.wire.anchors=[]; f.wire.transitions=[]; f.wire.cases=[];
  f.wire.retention={majorUnknownCaseIds:[],contradictionCaseIds:[],nonLocalContradictionCaseIds:[]};
  const parsed=f.parse(); assert.deepEqual(parsed.cases,[]); assert.deepEqual(parsed.evidence,[]);
  assert.equal(parsed.modelReviewPassed,false);
});

test('merge creates only major contradiction candidates and carries unknowns outside the summary', () => {
  const conflict=wireFor('synthetic-handover-conflict'), conflictResult=conflict.parse();
  const args={chapters:conflict.source.chapters,input:conflict.input,continuity:conflictResult,review:conflict.source.report};
  const merged=createContinuityChainAdjudicationInput(args);
  assert.equal(merged.schemaVersion,'continuity-chain-adjudication-merge-1'); assert.equal(merged.adjudicationInput.schemaVersion,ADJUDICATION_CONTINUITY_VERSION);
  assert.equal(merged.mergedReview.summary,conflict.source.report.summary); assert.equal(merged.mergedReview.issues.length,1);
  assert.equal(merged.mergedReview.issues[0].continuityCaseId,'case-1'); assert.deepEqual(merged.continuityEvidence.retainedDisputeCaseIds,[]);
  assert.equal(merged.mergedReview.issues[0].category,'STORY_COMPREHENSION_BLOCKER');
  assert.deepEqual(merged.mergedReview.issues[0].revisionScope.chapterIds,['ch-10']);
  assert(!JSON.stringify(merged.mergedReview.continuityChain).includes(conflict.source.chapters[0].body));
  assert(!Object.hasOwn(merged.mergedReview.continuityChain,'rawResponse'));
  assert(JSON.stringify(merged.mergedReview).length<80000); assert.deepEqual(validateContinuityChainAdjudicationInput(merged,args),merged);

  const unknown=wireFor('unwritten-handoff-boundary'), unknownResult=unknown.parse();
  const unknownArgs={chapters:unknown.source.chapters,input:unknown.input,continuity:unknownResult,review:unknown.source.report};
  const retained=createContinuityChainAdjudicationInput(unknownArgs);
  assert.equal(retained.mergedReview.issues.length,0); assert.deepEqual(retained.continuityEvidence.candidateCaseIds,[]);
  assert.deepEqual(retained.continuityEvidence.retainedDisputeCaseIds,['case-1']);
  assert.equal(retained.mergedReview.continuityChain.retainedDisputes[0].status,'retained_unknown_not_revision_eligible');

  const timeline=wireFor('synthetic-timeline-conflict'), timelineResult=timeline.parse();
  const timelineMerged=createContinuityChainAdjudicationInput({chapters:timeline.source.chapters,input:timeline.input,continuity:timelineResult,review:timeline.source.report});
  assert.equal(timelineMerged.mergedReview.issues.length,0);
  assert.equal(timelineMerged.mergedReview.continuityChain.retainedDisputes[0].status,'retained_contradiction_requires_cross_chapter_revision');
});

test('format-only recovered local contradiction stays visible but cannot authorize an automatic edit', () => {
  const f=wireFor('synthetic-handover-conflict'), result=f.parse();
  const args={chapters:f.source.chapters,input:f.input,continuity:result,review:f.source.report,formatRecovered:true};
  const merged=createContinuityChainAdjudicationInput(args);
  assert.deepEqual(merged.continuityEvidence.candidateCaseIds,[]);
  assert.equal(merged.mergedReview.issues.length,0);
  assert.equal(merged.mergedReview.continuityChain.retainedDisputes[0].status,'retained_contradiction_requires_independent_reread');
  assert.equal(merged.mergedReview.continuityFormatRecovery.newAutomaticRevisionsAllowed,false);
  assert.deepEqual(validateContinuityChainAdjudicationInput(merged,args),merged);
});

test('v4 requires the continuity envelope and two exact event anchors to confirm', async () => {
  const f=wireFor('synthetic-handover-conflict'), result=f.parse();
  const merged=createContinuityChainAdjudicationInput({chapters:f.source.chapters,input:f.input,continuity:result,review:f.source.report});
  const input=merged.adjudicationInput, issue=input.modelInput.issues[0];
  assert(input.system.includes('连续性裁定协议v4'));
  assert.throws(()=>createAdjudicationInput({chapters:f.source.chapters,review:f.source.report,protocolVersion:ADJUDICATION_CONTINUITY_VERSION}),{code:'CONTINUITY_ENVELOPE_REQUIRED'});
  const eventCitations=[result.evidence[0],result.evidence[1]].map(e=>({chapterId:e.chapterId,quote:e.quote,role:e.role,actor:e.actor,relevance:e.relevance,start:e.start}));
  const response={inputHash:input.inputHash,manuscriptSha256:input.manuscriptSha256,sourceReviewSha256:input.sourceReviewSha256,checkedChapterIds:f.source.chapters.map(c=>c.id),decisions:[{
    issueId:issue.issueId,issueSha256:issue.issueSha256,decision:'confirm',reason:'固定夹具裁定，程序有效不代表语义认证。',scope:'text_internal',
    supportingEvidence:eventCitations,counterEvidence:[],alternativeExplanation:{assessment:'ruled_out',reason:'固定夹具声明已排除。'},characterKnowledge:{assessment:'not_applicable',reason:'本例不依赖人物知情。'},
  }]};
  const validRaw=JSON.stringify(response);
  assert.equal(normalizeAdjudication(validRaw,input).revisionEligibleIssueIds.length,1);
  const calls=[]; await adjudicateReview({input,model:{complete:async args=>{calls.push(args);return validRaw;}}});
  assert.equal(calls.length,1); assert.equal(calls[0].stage,ADJUDICATION_CONTINUITY_STAGE);
  response.decisions[0].supportingEvidence=[eventCitations.at(-1)];
  assert.throws(()=>normalizeAdjudication(JSON.stringify(response),input),{code:'CONTINUITY_CONFIRM_NEEDS_EVENT_CHAIN'});
  assert.equal(createAdjudicationRepairInput(input,JSON.stringify(response)).stage,ADJUDICATION_CONTINUITY_REPAIR_STAGE);
});

test('v2/v3 remain opt-in and do not inherit the v4 continuity system', () => {
  const source=getContinuityChainScenario('insufficient-date-boundary');
  for (const version of [ADJUDICATION_VERSION,ADJUDICATION_RELIABILITY_VERSION]) {
    const input=createAdjudicationInput({chapters:source.chapters,review:source.report,protocolVersion:version});
    assert(!input.system.includes('连续性裁定协议v4'));
  }
});

test('unknown-only v4 result skips adjudication call while preserving retained disputes in sourceReview', async () => {
  const f=wireFor('unwritten-handoff-boundary'), result=f.parse();
  const merged=createContinuityChainAdjudicationInput({chapters:f.source.chapters,input:f.input,continuity:result,review:f.source.report});
  let calls=0; const adjudicated=await adjudicateReview({input:merged.adjudicationInput,model:{complete:async()=>{calls++;throw new Error('unexpected');}}});
  assert.equal(calls,0); assert.equal(adjudicated.status,'not_required');
  assert.equal(adjudicated.sourceReview.continuityChain.retainedDisputes[0].caseId,'case-1');
  assert.deepEqual(adjudicated.retainedDisputeIssueIds,[]);
});

test('runner uses one injected call with the fixed stage and max token budget', async () => {
  const f=wireFor('explicit-reschedule-counterexample'), calls=[];
  const out=await runContinuityChainReview({chapters:f.source.chapters,report:f.source.report,model:{complete:async args=>{calls.push(args);return JSON.stringify(f.wire);}}});
  assert.equal(calls.length,1); assert.equal(calls[0].stage,CONTINUITY_CHAIN_STAGE); assert.equal(calls[0].maxTokens,CONTINUITY_CHAIN_LIMITS.maxTokens);
  assert.equal(calls[0].maxTokens,9000); assert.equal(out.modelCompleteCalls,1); assert.equal(out.result.schemaVersion,CONTINUITY_CHAIN_VERSION);
});

test('public synthetic inputs retain their recorded protocol hashes', () => {
  const expected={
    'synthetic-timeline-conflict':'d05e3f376ee8a56749b28f9c5dc9819a156e0a2e5493151048b30f9da28ebe65',
    'synthetic-handover-conflict':'5b475a275fbb08166e46ef3b22ea37c7657783dd915a81cbdb07ef150cd4f774',
    'explicit-reschedule-counterexample':'f93f86fda4047fd0640c1d03d505a2bbd1659de0a05bfee4064d73d0488a356d',
    'temporary-key-counterexample':'1787f90f7eb70b9e5409f971f89bcfcd4fce8e3bdfefa4e636bf2291b33c95d9',
    'insufficient-date-boundary':'6d4ab737893def0713d58281300f91c6c46a1c2c6baaa03e669b82385a17bc8b',
    'unwritten-handoff-boundary':'45857a8637bb4374c9de3db33f9441f66f27a304a7a7233b8f5a4db7ddf28c04',
  };
  for(const source of continuityChainScenarios) {
    const input=prepareContinuityChainReview({chapters:source.chapters,report:source.report});
    assert.equal(input.inputHash,expected[source.id]);
  }
});

test('one CASE_TRANSITIONS correction keeps the verdict and returns a validated complete result', async () => {
  const f=wireFor('explicit-reschedule-counterexample'), correctedRaw=JSON.stringify(f.wire), invalid=clone(f.wire);
  invalid.cases[0].anchorIds=invalid.cases[0].anchorIds.filter(id=>id!=='a3');
  const invalidRaw=JSON.stringify(invalid), prepared=createContinuityChainRepairInput({input:f.input,invalidResponse:invalidRaw});
  assert.equal(prepared.schemaVersion,CONTINUITY_CHAIN_REPAIR_VERSION);
  assert.equal(prepared.stage,CONTINUITY_CHAIN_STAGE);
  assert.deepEqual(prepared.diagnostics,{code:'CASE_TRANSITIONS',cases:[{caseId:'case-1',invalidTransitionIds:[],missingEndpointAnchorIds:['a3']}]});
  const request=JSON.parse(prepared.user);
  assert.deepEqual(request.originalRequest,JSON.parse(f.input.user));
  assert.equal(JSON.stringify(request).includes('expected'),false);
  const calls=[];
  const repaired=await repairContinuityChainReview({input:f.input,invalidResponse:invalidRaw,model:{complete:async args=>{calls.push(args);return correctedRaw;}}});
  assert.equal(calls.length,1);assert.equal(calls[0].stage,CONTINUITY_CHAIN_STAGE);
  assert.equal(repaired.repaired.result.cases[0].assessment,'explained');
  assert.equal(repaired.repaired.result.cases[0].reason,f.wire.cases[0].reason);
  assert.deepEqual(validateContinuityChainRepairResult(repaired.repaired,repaired.repairInput),repaired.repaired);
});

test('one EXPLANATION_WITHOUT_EVIDENCE correction may fix alternatives without re-running the primary review', () => {
  const f=wireFor('temporary-key-counterexample'), invalid=clone(f.wire);
  invalid.cases[0].alternatives[0].assessment='ruled_out';
  const invalidRaw=JSON.stringify(invalid), prepared=createContinuityChainRepairInput({input:f.input,invalidResponse:invalidRaw});
  assert.deepEqual(prepared.diagnostics,{code:'EXPLANATION_WITHOUT_EVIDENCE',cases:[{caseId:'case-1',missing:'stated_explicit_transition_or_evidenced_plausible_alternative'}]});
  const corrected=clone(invalid);corrected.cases[0].alternatives[0].assessment='plausible';
  const parsed=inspectContinuityChainRepairResponse(JSON.stringify(corrected),prepared);
  assert.equal(parsed.result.cases[0].assessment,'explained');
  assert.equal(parsed.result.cases[0].reason,invalid.cases[0].reason);
  assert.equal(parsed.invalidResponseSha256,prepared.invalidResponseSha256);
});

test('an invalid correction is retained and never triggers another completion inside the repair helper', async () => {
  const f=wireFor('explicit-reschedule-counterexample'), invalid=clone(f.wire);invalid.cases[0].anchorIds=invalid.cases[0].anchorIds.filter(id=>id!=='a3');
  const invalidRaw=JSON.stringify(invalid);let calls=0;
  await assert.rejects(repairContinuityChainReview({input:f.input,invalidResponse:invalidRaw,model:{complete:async()=>{calls++;return invalidRaw;}}}),{code:'CASE_TRANSITIONS'});
  assert.equal(calls,1);
});

test('repair cannot change the verdict, evidence graph, binding, or use cancellation to make a call', async () => {
  const f=wireFor('explicit-reschedule-counterexample'), invalid=clone(f.wire);invalid.cases[0].anchorIds=invalid.cases[0].anchorIds.filter(id=>id!=='a3');
  const invalidRaw=JSON.stringify(invalid), prepared=createContinuityChainRepairInput({input:f.input,invalidResponse:invalidRaw});
  const rejudged=clone(f.wire);rejudged.cases[0].assessment='unknown';
  assert.throws(()=>inspectContinuityChainRepairResponse(JSON.stringify(rejudged),prepared),{code:'CONTINUITY_REPAIR_CONTENT_CHANGE'});
  const changedEvidence=clone(f.wire);changedEvidence.anchors[0].state='主机改写';
  assert.throws(()=>inspectContinuityChainRepairResponse(JSON.stringify(changedEvidence),prepared),{code:'CONTINUITY_REPAIR_CONTENT_CHANGE'});
  const conflict=wireFor('synthetic-timeline-conflict'), conflictInvalid=clone(conflict.wire);
  conflictInvalid.cases[0].anchorIds=conflictInvalid.cases[0].anchorIds.filter(id=>id!=='a2');
  const conflictRepair=createContinuityChainRepairInput({input:conflict.input,invalidResponse:JSON.stringify(conflictInvalid)});
  const promoted=clone(conflict.wire);promoted.cases[0].repairScope={assessment:'local_anchor',reason:'试图改变修订资格。'};
  assert.throws(()=>inspectContinuityChainRepairResponse(JSON.stringify(promoted),conflictRepair),{code:'CONTINUITY_REPAIR_CONTENT_CHANGE'});
  const tampered=clone(prepared);tampered.requestSha256='0'.repeat(64);
  assert.throws(()=>inspectContinuityChainRepairResponse(JSON.stringify(f.wire),tampered),{code:'CONTINUITY_REPAIR_INPUT_TAMPER'});
  const badBinding=clone(invalid);badBinding.inputHash='0'.repeat(64);
  assert.throws(()=>createContinuityChainRepairInput({input:f.input,invalidResponse:JSON.stringify(badBinding)}),{code:'CONTINUITY_REPAIR_NOT_ALLOWED'});
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(repairContinuityChainReview({input:f.input,invalidResponse:invalidRaw,signal:controller.signal,model:{complete:async()=>{calls++;return JSON.stringify(f.wire);}}}),{name:'AbortError'});
  assert.equal(calls,0);
  assert.throws(()=>createContinuityChainRepairInput({input:f.input,invalidResponse:'{}'}),{code:'CONTINUITY_REPAIR_NOT_ALLOWED'});
});
