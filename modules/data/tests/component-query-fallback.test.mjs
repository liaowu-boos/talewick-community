import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildComponentQueries,runComponentFallback,fingerprint,validateComponentFallbackPolicy,validateComponentFallbackCheckpoint,COMPONENT_FALLBACK_POLICY_VERSION} from '../runtime/component-query-fallback.mjs';

const request = {problem:{problemId:'fixture-goal',statement:'从起点到责任与代价',searchTerms:['起点','责任','承担','代价'],
  requiredTermGroups:[['起点'],['责任','承担'],['代价']],context:{boundaries:['不强制采用']}},
  dimensions:['psychologicalChangeDrivers'],limit:6,maxFunctionsPerResult:3,maxEvidenceRefsPerResult:10};
const components = [{id:'responsibility',facet:'target_mechanism',statement:'责任承担',
  searchTerms:['责任','承担'],requiredTermGroups:[['责任','承担']]}];
const sha = text => createHash('sha256').update(text).digest('hex');
const source = {sourceId:'fixture-source',sourceSha256:sha('完整引文'),sourceTextSha256:sha('完整引文'),textVersion:'text-v2-fixture',title:'fixture'};
const result = {referenceId:'fixture-ref',source,
  analysis:{analysisId:'analysis-fixture',analysisContentVersion:'analysis-v1',originalReviewRecordId:'review-original',
    candidateStatus:'candidate_unreviewed',approved:false,checked:false,active:false,candidateSha256:sha('candidate'),packetSha256:sha('packet')},
  semanticReview:{approvalGranted:false,activeProductionChanged:false,reportSha256:sha('review'),reportPath:'review.json',verdict:'pass_with_caveats',caveats:['未知长期效果'],blockingDefects:[]},
  borrowableWritingFunctions:[{functionId:'psychology:PD1',dimension:'psychologicalChangeDrivers',status:'evidence_bound_hypothesis',
    observablePattern:'起点责任',borrowableFunction:'承担代价',evidenceIds:['e1'],unitIds:['u1'],alternatives:['也可能相反'],limitation:'演员关系未知',matchedProblemTerms:['责任','承担']}],
  exactReferences:[{evidenceId:'e1',unitId:'u1',quote:'完整引文',quoteSha256:sha('完整引文'),locator:{lineStart:1,lineEnd:1,charStart:0,charEnd:4},...source}],
  match:{matchedTerms:['责任','承担'],matchedTermCount:2,requiredMatchedTermCount:2,requiredTermGroupsSatisfied:[['责任','承担']],lexicalScore:2,semanticSimilarityClaimed:false},
  limits:{visibility:{completeness:'unknown'},statements:['仅假说']},retrievalIsUse:false,requiresExplicitAdoption:true};
function response(req=request, results=[result]) {
  const bound={problem:structuredClone(req.problem),dimensions:structuredClone(req.dimensions),sourceIds:req.sourceIds??null,
    limit:req.limit,maxFunctionsPerResult:req.maxFunctionsPerResult,maxEvidenceRefsPerResult:req.maxEvidenceRefsPerResult};
  const installId='fixture-install';
  return {schemaVersion:'analysis99-problem-query-2',queryId:'deepref-query-'+sha(JSON.stringify({installId,request:bound},null,2)+'\n'),installId,
    request:bound,results:structuredClone(results),resultCount:results.length,status:results.length?'covered':'uncovered',
    matchingPolicy:{version:'analysis99-positive-function-fields-1',effectiveSearchTerms:req.problem.searchTerms},
    limits:{},boundary:'fixture only',retrievalIsUse:false,requiresExplicitAdoption:true};
}
function setup() {
  const originalResponse=response();
  return {enabled:true,originalRequest:structuredClone(request),originalResponse,components:structuredClone(components),
    assessment:{queryId:originalResponse.queryId,responseSha256:fingerprint(originalResponse),outcome:'all_supplied_inapplicable',
      supplied:[{materialId:'fixture-ref',functionIds:['psychology:PD1']}],
      decisions:[{materialId:'fixture-ref',fit:'inapplicable',reason:'fixture反向机制'}]},
    query:async q=>response(q)};
}
test('显式子机制移除起点必要门槛，原请求/范围/上下文/上限保留',()=>{
  const original=structuredClone(request);original.sourceIds=['allowed'];
  const before=fingerprint(original);const [planned]=buildComponentQueries({originalRequest:original,components});
  assert.equal(fingerprint(original),before);
  assert.deepEqual(planned.request.problem.requiredTermGroups,[['责任','承担']]);
  assert.deepEqual(planned.request.problem.context,original.problem.context);
  assert.deepEqual(planned.request.sourceIds,['allowed']);assert.equal(planned.request.limit,6);
  assert.ok(planned.parentGroupsNotRequiredForThisComponent.some(g=>g.includes('起点')));
});
test('默认关闭，原始响应完整保留',async()=>{
  const s=setup();s.enabled=false;s.query=()=>assert.fail('must not query');
  const r=await runComponentFallback(s);assert.equal(r.status,'not_attempted');assert.equal(r.queryCalls,0);
  assert.deepEqual(r.original.response,s.originalResponse);
});
for (const outcome of ['not_queried','unavailable','not_supplied','not_assessed','not_adopted','applicable_exists']) {
  test(`${outcome}不能当作全部不适用`,async()=>{
    const s=setup();s.assessment.outcome=outcome;s.query=()=>assert.fail('must not query');
    assert.equal((await runComponentFallback(s)).queryCalls,0);
  });
}
test('陈旧判断拒绝，不调用query',async()=>{
  const s=setup();s.assessment.responseSha256='0'.repeat(64);s.query=()=>assert.fail('must not query');
  await assert.rejects(runComponentFallback(s),{code:'STALE_ASSESSMENT'});
});
test('遗漏某个已供给判断不能触发',async()=>{
  const s=setup();s.assessment.decisions=[];await assert.rejects(runComponentFallback(s),{code:'ASSESSMENT_COVERAGE'});
});
test('已适用项不能伪报全部不适用',async()=>{
  const s=setup();s.assessment.decisions[0].fit='direct_fit';await assert.rejects(runComponentFallback(s),{code:'ASSESSMENT_COVERAGE'});
});
test('未供给函数保持未评估，不把整个返回集合判不适用',async()=>{
  const s=setup();s.originalResponse.results[0].borrowableWritingFunctions.push({...structuredClone(result.borrowableWritingFunctions[0]),functionId:'psychology:PD2'});
  s.assessment.responseSha256=fingerprint(s.originalResponse);
  const r=await runComponentFallback(s);assert.deepEqual(r.trigger.unsuppliedFunctionsNotAssessed,[{materialId:'fixture-ref',functionId:'psychology:PD2'}]);
});
test('局部命中保留完整引用与限制，演员/完整目标恒unknown，原记录不变',async()=>{
  const s=setup(),before=fingerprint(s.originalResponse);const r=await runComponentFallback(s);const c=r.candidatePool[0];
  assert.equal(r.status,'component_candidates');assert.equal(c.matchScope,'only_component');
  assert.equal(c.semanticFit,'unknown');assert.equal(c.sameActorChain,'unknown');assert.equal(c.wholeGoalCoverage,'unknown');
  assert.equal(c.supplied,false);assert.equal(c.adopted,false);assert.equal(c.analysis.approved,false);
  assert.deepEqual(c.exactReferences,result.exactReferences);assert.deepEqual(c.limits,result.limits);
  assert.equal(c.function.limitation,result.borrowableWritingFunctions[0].limitation);
  assert.equal(fingerprint(s.originalResponse),before);
});
test('同函数多路命中去重，保留两条查询来源，不拼成完整目标',async()=>{
  const s=setup();s.components.push({...s.components[0],id:'second-component',facet:'cost_mechanism'});
  const r=await runComponentFallback(s);assert.equal(r.candidatePool.length,1);assert.equal(r.candidatePool[0].retrievedBy.length,2);
  assert.equal(r.candidatePool[0].wholeGoalCoverage,'unknown');
});
test('真实空结果有界返回，不声称全库不存在',async()=>{
  const s=setup();s.query=async q=>response(q,[]);const r=await runComponentFallback(s);
  assert.equal(r.status,'no_component_hits');assert.match(r.absenceScope,/whole_corpus_semantics_unknown/u);
});
test('原始真空结果可触发，但非空响应不能假称无命中',async()=>{
  const s=setup();s.originalResponse=response(request,[]);s.assessment={queryId:s.originalResponse.queryId,
    responseSha256:fingerprint(s.originalResponse),outcome:'no_hits'};
  assert.equal((await runComponentFallback(s)).queryCalls,1);
  s.originalResponse=response();s.assessment.queryId=s.originalResponse.queryId;s.assessment.responseSha256=fingerprint(s.originalResponse);
  await assert.rejects(runComponentFallback(s),{code:'FALSE_NO_HITS'});
});
test('查询失败与无命中分开，失败后池为空且不重试',async()=>{
  const s=setup();s.query=async()=>{throw Object.assign(new Error('missing'),{code:'INPUT_DATALESS'});};
  const r=await runComponentFallback(s);assert.equal(r.status,'query_error');assert.equal(r.error.code,'INPUT_DATALESS');
  assert.equal(r.queryCalls,1);assert.deepEqual(r.candidatePool,[]);
});
test('缺少某完整功能的引用即失败关闭',async()=>{
  const s=setup();s.query=async q=>{const r=response(q);r.results[0].exactReferences=[];return r;};
  const r=await runComponentFallback(s);assert.equal(r.status,'query_error');assert.equal(r.error.code,'DEEP_COMPARE_FUNCTION');
});
test('不能切换来源安装或升格状态',async()=>{
  for (const mutation of [r=>{r.installId='changed';},r=>{r.results[0].analysis.approved=true;}]) {
    const s=setup();s.query=async q=>{const r=response(q);mutation(r);return r;};
    assert.equal((await runComponentFallback(s)).status,'query_error');
  }
});
test('不接受作品ID定向参数、不允许无限拆分',()=>{
  assert.throws(()=>buildComponentQueries({originalRequest:request,components:[{...components[0],sourceIds:['target']}]}),{code:'COMPONENT_FIELDS'});
  assert.throws(()=>buildComponentQueries({originalRequest:request,components:Array.from({length:4},(_,i)=>({...components[0],id:'c'+i}))}),{code:'COMPONENT_LIMIT'});
});
test('共同policy严格字段、类型、数量；同名参数冲突拒绝',async()=>{
  const policy={schemaVersion:COMPONENT_FALLBACK_POLICY_VERSION,enabled:true,components};
  assert.deepEqual(validateComponentFallbackPolicy(policy),policy);
  assert.equal(validateComponentFallbackPolicy(undefined),null);
  assert.throws(()=>validateComponentFallbackPolicy({...policy,budget:{maxChars:24000}}),{code:'COMPONENT_POLICY'});
  assert.throws(()=>validateComponentFallbackPolicy({...policy,enabled:'true'}),{code:'COMPONENT_POLICY'});
  const s=setup();s.policy={...policy,enabled:false};
  await assert.rejects(runComponentFallback(s),{code:'POLICY_CONFLICT'});
});
test('实际legacy供应也须全部审查，不能只保留deep拒用项',async()=>{
  const s=setup();s.assessment.supplied.push({materialId:'legacy-ref',side:'legacy',functionIds:[],contentSha256:sha('legacy')});
  await assert.rejects(runComponentFallback(s),{code:'ASSESSMENT_COVERAGE'});
  s.assessment.decisions.push({materialId:'legacy-ref',fit:'inapplicable',reason:'legacy实际不适用'});
  assert.equal((await runComponentFallback(s)).status,'component_candidates');
  s.assessment.decisions[1].fit='direct_fit';
  await assert.rejects(runComponentFallback(s),{code:'ASSESSMENT_COVERAGE'});
});
test('有legacy实际供应不能把空deep响应当作整体无命中',async()=>{
  const s=setup();s.originalResponse=response(request,[]);
  s.assessment={queryId:s.originalResponse.queryId,responseSha256:fingerprint(s.originalResponse),outcome:'no_hits',
    supplied:[{materialId:'legacy-ref',side:'legacy',functionIds:[],contentSha256:sha('legacy')}],decisions:[]};
  await assert.rejects(runComponentFallback(s),{code:'FALSE_NO_HITS'});
});
test('中断前缀恢复只执行剩余组件，完整终态恢复零query',async()=>{
  const s=setup();s.components.push({...s.components[0],id:'second'});
  const control=new AbortController();let saved,calls=0;
  s.query=async q=>{calls++;return response(q);};s.signal=control.signal;
  s.onCheckpoint=cp=>{saved=cp;if(cp.status==='in_progress'&&cp.runs.length===1)control.abort();};
  await assert.rejects(runComponentFallback(s),{name:'AbortError'});assert.equal(calls,1);
  assert.equal(saved.status,'in_progress');assert.deepEqual(saved.candidatePool,[]);
  const next={...s,signal:undefined,onCheckpoint:undefined,checkpoint:saved};
  const completed=await runComponentFallback(next);assert.equal(calls,2);assert.equal(completed.queryCalls,2);
  assert.equal(completed.status,'component_candidates');
  assert.deepEqual(validateComponentFallbackCheckpoint({...next,checkpoint:completed}),completed);
  assert.deepEqual(await runComponentFallback({...next,checkpoint:completed,query:()=>assert.fail('must not requery')}),completed);
});
test('恢复时改变组件/原响应/判断绑定均拒绝',async()=>{
  const s=setup(),completed=await runComponentFallback(s);
  await assert.rejects(runComponentFallback({...s,checkpoint:completed,components:[{...components[0],id:'changed'}]}),{code:'CHECKPOINT_STALE'});
  const changed={...s,checkpoint:completed,assessment:{...s.assessment,decisions:[{...s.assessment.decisions[0],reason:'new reason'}]}};
  await assert.rejects(runComponentFallback(changed),{code:'CHECKPOINT_STALE'});
});
test('伪造pool适用标签即使重算hash也不能恢复',async()=>{
  const s=setup(),completed=await runComponentFallback(s);
  completed.candidatePool[0].semanticFit='direct_fit';
  assert.throws(()=>validateComponentFallbackCheckpoint({...s,checkpoint:completed}),{code:'CHECKPOINT_HASH'});
  const {checkpointSha256,...payload}=completed;completed.checkpointSha256=fingerprint(payload);
  assert.throws(()=>validateComponentFallbackCheckpoint({...s,checkpoint:completed}),{code:'CHECKPOINT_DERIVATION'});
});
test('第二查询失败保留第一响应且不暴露池；失败终态不重试',async()=>{
  const s=setup();s.components.push({...s.components[0],id:'second'});let calls=0;
  s.query=async q=>{if(++calls===2)throw Object.assign(new Error('missing'),{code:'INPUT_DATALESS'});return response(q);};
  const failed=await runComponentFallback(s);assert.equal(failed.status,'query_error');assert.equal(failed.runs.length,1);
  assert.deepEqual(failed.candidatePool,[]);assert.equal(failed.queryCalls,2);
  assert.deepEqual(await runComponentFallback({...s,checkpoint:failed,query:()=>assert.fail('no retry')}),failed);
});
test('保存checkpoint失败向host传播，不启动下一查询',async()=>{
  const s=setup();s.components.push({...s.components[0],id:'second'});let calls=0;
  s.query=async q=>{calls++;return response(q);};
  s.onCheckpoint=cp=>{if(cp.runs.length===1)throw new Error('host persistence failed');};
  await assert.rejects(runComponentFallback(s),/host persistence failed/u);assert.equal(calls,1);
});
test('queryId/引用行窗/source hash与请求上限错误均失败关闭',async()=>{
  for(const mutate of [r=>r.queryId='wrong',r=>r.results[0].exactReferences[0].locator.charEnd++,
    r=>r.results[0].exactReferences[0].sourceSha256=sha('other'),r=>r.results[0].borrowableWritingFunctions[0].dimension='emotionalProgression']) {
    const s=setup();s.query=async q=>{const r=response(q);mutate(r);return r;};
    const failed=await runComponentFallback(s);assert.equal(failed.status,'query_error');assert.deepEqual(failed.candidatePool,[]);
  }
});
test('non-JSON/cyclic/prototype data不能进入恢复hash',()=>{
  assert.throws(()=>fingerprint({value:NaN}),{code:'JSON_SHAPE'});
  assert.throws(()=>fingerprint({time:new Date()}),{code:'JSON_SHAPE'});
  const x={};x.self=x;assert.throws(()=>fingerprint(x),{code:'JSON_SHAPE'});
  assert.throws(()=>fingerprint(JSON.parse('{"__proto__":{}}')),{code:'JSON_SHAPE'});
  assert.throws(()=>fingerprint(new Array(1)),{code:'JSON_SHAPE'});
  const extra=[];extra.hidden='x';assert.throws(()=>fingerprint(extra),{code:'JSON_SHAPE'});
});
test('被拒review、丢失分析ID或附加语义通过标签不能进入局部候选池',async()=>{
  for(const mutate of [r=>r.results[0].semanticReview.verdict='rejected',r=>delete r.results[0].analysis.analysisId,
    r=>r.results[0].match.semanticSimilarityClaimed=true,r=>r.results[0].borrowableWritingFunctions[0].semanticFit='direct_fit']) {
    const s=setup();s.query=async q=>{const r=response(q);mutate(r);return r;};
    const failed=await runComponentFallback(s);assert.equal(failed.status,'query_error');assert.deepEqual(failed.candidatePool,[]);
  }
});
test('限定sourceIds时不能从回调接收范围外来源',async()=>{
  const s=setup();s.originalRequest.sourceIds=['fixture-source'];s.originalResponse=response(s.originalRequest);
  s.assessment.responseSha256=fingerprint(s.originalResponse);s.assessment.queryId=s.originalResponse.queryId;
  s.query=async q=>{const r=response(q);r.results[0].source.sourceId='outside';
    r.results[0].exactReferences.forEach(ref=>ref.sourceId='outside');return r;};
  const failed=await runComponentFallback(s);assert.equal(failed.error.code,'RESULT_SCOPE');
});
test('回调空/截断错误码归一成可恢复失败，终态不重试',async()=>{
  for(const [code,expected] of [[' ','QUERY_ERROR'],['X'+' '.repeat(160)+'Z','X']]) {
    const s=setup();s.query=async()=>{throw Object.assign(new Error('missing'),{code});};
    const failed=await runComponentFallback(s);assert.equal(failed.error.code,expected);
    assert.deepEqual(await runComponentFallback({...s,checkpoint:failed,query:()=>assert.fail('must not retry')}),failed);
  }
});
test('旧分析contentVersion可为显式null，保留candidate/packet哈希而不伪造版本',async()=>{
  const s=setup();s.query=async q=>{const r=response(q);r.results[0].analysis.analysisContentVersion=null;return r;};
  const passed=await runComponentFallback(s);assert.equal(passed.status,'component_candidates');
  assert.equal(passed.candidatePool[0].analysis.analysisContentVersion,null);
  assert.equal(passed.candidatePool[0].analysis.candidateSha256,result.analysis.candidateSha256);
});
