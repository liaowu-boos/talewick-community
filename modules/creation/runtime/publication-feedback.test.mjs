import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildPublicationFeedbackRequest,parsePublicationFeedbackResponse,analyzePublicationFeedback,feedbackExperimentBrief} from './publication-feedback.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const body='  她再次读信。\r\n😀她仍没有答应。  ';
function publication(){return {schemaVersion:'publication-feedback-v1',id:'p1',revision:2,createdAt:'2026-09-30T01:00:00.000Z',updatedAt:'2026-09-30T02:00:00.000Z',workId:'w1',title:'测试短稿',text:body,textSha256:sha(body),textVersionLabel:'v1',chars:body.length,platform:'合成平台',account:'合成账号',genre:'现实',traffic:'organic',publishedAt:null,publicUrl:null,presentationNote:'',notes:'',observations:[{id:'o1',createdAt:'2026-09-30T02:00:00.000Z',observedAt:'2026-09-30T02:00:00.000Z',windowHours:null,moderation:{status:'rejected',reason:'',category:'unknown'},metrics:{impressions:0,reads:null,completions:null,likes:0,comments:null,favorites:null,follows:null},metricDefinition:'',metricsComparable:false,notes:''}],reviews:[],decisions:[]};}
const assessment={facts:['退稿未给理由'],gaps:['缺阅读数'],limitations:['曝光不可归因'],rates:{readRate:null,completionRate:null},literaryQuality:'not_established'};
const comparison={comparable:false,reasons:['账号不同，观察窗未知'],items:[],causality:'not_established'};
function report(inputHash){return {schemaVersion:'publication-feedback-review-v1',inputHash,summary:'缺少理由和阅读数据，不能判断文学效果。',observations:[{kind:'platform',statement:'退稿原因未知',observationIds:['o1'],quote:null},{kind:'text',statement:'现稿重复读信动作，尚不能认定需删除。',observationIds:[],quote:'她再次读信。'}],hypotheses:[{id:'h1',claim:'呈现说明可能影响阅读入口，待验证。',observationIds:['o1'],quotes:['😀她仍没有答应。'],alternatives:['曝光差异或平台分发波动'],limitations:['仅一部作品，退稿理由未知'],testPlan:{change:'下一部仅调整呈现说明',keepFixed:'平台账号题材口径时间窗，保留心理与反复',targetMetric:'同口径阅读率',successCriterion:'有可比曝光与读取定义后判断支持、反例或未决'}}],limitations:['观察不能证明因果或确定受众']};}
function bound(p=publication()){const request=buildPublicationFeedbackRequest({publication:p,assessment,comparison});return {p,request,value:report(request.inputHash)};}

test('request preserves full original, null versus zero, unknown rejection and confounds with safe history summaries',()=>{
 const p=publication();p.reviews=[{report:{summary:'OLD_SUMMARY'},rawResponse:'PRIVATE_RAW_MARKER'}];p.decisions=[{reason:'OLD_REASON'}];const before=structuredClone(p);
 const r=buildPublicationFeedbackRequest({publication:p,assessment,comparison}),u=JSON.parse(r.user);
 assert.equal(r.stage,'publication-feedback-review');assert.equal(r.maxTokens,6000);assert.equal(r.observedRevision,2);assert.equal(r.textSha256,sha(body));
 assert.equal(u.publication.text,body);assert.equal(u.publication.observations[0].metrics.impressions,0);assert.equal(u.publication.observations[0].metrics.reads,null);assert.equal(u.publication.observations[0].moderation.reason,'');assert.deepEqual(u.assessment,assessment);assert.deepEqual(u.comparison,comparison);assert.equal(u.publication.latestObservationId,'o1');
 assert.equal(r.user.includes('PRIVATE_RAW_MARKER'),false);assert.equal(u.feedbackHistory.reviews[0].summary,'OLD_SUMMARY');assert.equal(u.feedbackHistory.decisions[0].reason,'OLD_REASON');assert.match(r.system,/曝光少不能推出正文差/);assert.match(r.system,/不预设目标读者/);assert.deepEqual(p,before);
});
test('input binding changes with observation, revision or original bytes but ignores object key order',()=>{
 const p=publication(),h=buildPublicationFeedbackRequest({publication:p,assessment}).inputHash;
 assert.equal(buildPublicationFeedbackRequest({publication:Object.fromEntries(Object.entries(p).reverse()),assessment}).inputHash,h);
 for(const change of [q=>q.revision++,q=>q.observations[0].metrics.reads=0,q=>{q.text+='新';q.textSha256=sha(q.text);}]){const q=structuredClone(p);change(q);assert.notEqual(buildPublicationFeedbackRequest({publication:q,assessment}).inputHash,h);}
 p.text+='篡改';assert.throws(()=>buildPublicationFeedbackRequest({publication:p}),e=>e.code==='TEXT_HASH_MISMATCH');
});
test('no observations blocks before any model call, including model configuration errors',async()=>{
 let calls=0;const p=publication();p.observations=[];
 await assert.rejects(analyzePublicationFeedback({publication:p,model:{complete:async()=>{calls++;}}}),e=>e.code==='NO_OBSERVATIONS'&&e.status===400);assert.equal(calls,0);
 await assert.rejects(analyzePublicationFeedback({publication:publication()}),e=>e.code==='MODEL_REQUIRED');
});
test('single injected call returns exact binding and raw response without claiming validated quality',async()=>{
 const p=publication();let calls=0;const result=await analyzePublicationFeedback({publication:p,assessment,comparison,model:{complete:async args=>{calls++;assert.equal(args.stage,'publication-feedback-review');assert.equal(args.maxTokens,6000);const u=JSON.parse(args.user);return JSON.stringify(report(u.inputHash));}}});
 assert.equal(calls,1);assert.equal(result.status,'completed');assert.equal(result.textSha256,p.textSha256);assert.equal(result.observedRevision,p.revision);assert.deepEqual(JSON.parse(result.rawResponse),result.report);assert.equal(result.report.qualityPass,undefined);assert.equal(result.report.hypotheses[0].confirmed,undefined);
});
test('strict response rejects unknown status fields at every layer, duplicate IDs, foreign observations and invented quotes',()=>{
 const {p,request,value}=bound();
 for(const mutate of [r=>r.qualityPass=true,r=>r.observations[0].confirmed=true,r=>r.hypotheses[0].adopted=true,r=>r.hypotheses[0].testPlan.status='approved',r=>r.hypotheses.push(structuredClone(r.hypotheses[0])),r=>r.hypotheses[0].observationIds=['foreign'],r=>r.hypotheses[0].quotes=['她答应了。'],r=>r.observations[1].quote='她再次读信。\\n😀她仍没有答应。',r=>r.hypotheses[0].quotes=['😀她仍没有答应。伪造'],r=>r.inputHash='0'.repeat(64),r=>r.schemaVersion='other']){
  const x=structuredClone(value);mutate(x);assert.throws(()=>parsePublicationFeedbackResponse(JSON.stringify(x),{publication:p,inputHash:request.inputHash}));
 }
});
test('facts require source IDs or text quotes, while insufficient data permits no hypotheses',()=>{
 const {p,request,value}=bound();value.observations[0].observationIds=[];
 assert.throws(()=>parsePublicationFeedbackResponse(JSON.stringify(value),{publication:p,inputHash:request.inputHash}),e=>e.code==='MISSING_EVIDENCE');
 value.observations=[];value.hypotheses=[];const parsed=parsePublicationFeedbackResponse(JSON.stringify(value),{publication:p,inputHash:request.inputHash});assert.deepEqual(parsed.hypotheses,[]);
});
test('parser preserves actual multiline quotation and trims normal strings, without accepting fences',()=>{
 const {p,request,value}=bound();value.hypotheses[0].quotes=['她再次读信。\r\n😀她仍没有答应。'];value.summary='  数据不足  ';
 const parsed=parsePublicationFeedbackResponse(JSON.stringify(value),{publication:p,inputHash:request.inputHash});assert.equal(parsed.summary,'数据不足');assert.equal(parsed.hypotheses[0].quotes[0],value.hypotheses[0].quotes[0]);
 assert.throws(()=>parsePublicationFeedbackResponse('```json\n'+JSON.stringify(value)+'\n```',{publication:p,inputHash:request.inputHash}));
});
test('transport failure and malformed output never trigger repair or sampling',async()=>{
 for(const complete of [async()=>{throw Object.assign(Error('合成传输失败'),{code:'SYNTHETIC'});},async()=>'{bad']){let count=0;await assert.rejects(analyzePublicationFeedback({publication:publication(),model:{complete:async args=>{count++;return complete(args);}}}));assert.equal(count,1);}
});
test('in-flight publication mutation cannot rewrite the analyzed revision or original',async()=>{
 const p=publication(),original=structuredClone(p);const result=await analyzePublicationFeedback({publication:p,model:{complete:async args=>{const u=JSON.parse(args.user);p.text='后改稿';p.textSha256=sha(p.text);p.revision++;p.observations[0].id='changed';return JSON.stringify(report(u.inputHash));}}});
 assert.equal(result.observedRevision,original.revision);assert.equal(result.textSha256,original.textSha256);assert.deepEqual(result.report.hypotheses[0].observationIds,['o1']);
});
test('cancellation before and after dispatch cannot produce a completed report',async()=>{
 const pre=new AbortController();pre.abort();let calls=0;
 await assert.rejects(analyzePublicationFeedback({publication:publication(),signal:pre.signal,model:{complete:async()=>{calls++;}}}));assert.equal(calls,0);
 const active=new AbortController();await assert.rejects(analyzePublicationFeedback({publication:publication(),signal:active.signal,model:{complete:async args=>{calls++;active.abort();return JSON.stringify(report(JSON.parse(args.user).inputHash));}}}));assert.equal(calls,1);
});
test('experiment brief binds a saved hypothesis and remains provisional without mutating history',()=>{
 const {p,request,value}=bound();p.reviews=[{id:'r1',status:'completed',textSha256:p.textSha256,observedRevision:2,inputHash:request.inputHash,report:value}];p.revision=3;const before=structuredClone(p);
 const brief=feedbackExperimentBrief({publication:p,reviewId:'r1',hypothesisId:'h1'});assert.match(brief,/待验证假说/);assert.match(brief,/不回改旧稿/);assert.ok(brief.includes(p.textSha256));assert.ok(brief.includes(request.inputHash));assert.ok(brief.includes('"observationIds": [\n    "o1"')||brief.includes('"o1"'));assert.match(brief,/历史复盘绑定/);assert.deepEqual(p,before);
 assert.throws(()=>feedbackExperimentBrief({publication:p,reviewId:'r1',hypothesisId:'missing'}));p.reviews[0].status='failed';assert.throws(()=>feedbackExperimentBrief({publication:p,reviewId:'r1',hypothesisId:'h1'}));p.reviews[0].status='completed';p.reviews[0].textSha256='0'.repeat(64);assert.throws(()=>feedbackExperimentBrief({publication:p,reviewId:'r1',hypothesisId:'h1'}));
});
test('finite budgets, dangerous metadata and accessors fail before model work',()=>{
 const {p,request,value}=bound();value.observations=Array.from({length:41},()=>value.observations[0]);assert.throws(()=>parsePublicationFeedbackResponse(JSON.stringify(value),{publication:p,inputHash:request.inputHash}));
 assert.throws(()=>parsePublicationFeedbackResponse('{"__proto__":{}}',{publication:p,inputHash:request.inputHash}));
 let read=false;Object.defineProperty(p,'notes',{get(){read=true;return 'bad';},enumerable:true});assert.throws(()=>buildPublicationFeedbackRequest({publication:p}));assert.equal(read,false);
});
function withSavedReview(){const {p,request,value}=bound();p.reviews=[{id:'r1',status:'completed',textSha256:p.textSha256,observedRevision:2,inputHash:request.inputHash,report:value}];return p;}
function savedPlan(id,change){return {id,createdAt:'2026-09-30T03:00:00.000Z',reviewId:'r1',hypothesisId:'h1',action:'plan_test',status:'testing',plan:{change,keepFixed:'用户固定项',targetMetric:'用户指定指标',successCriterion:'用户判断标准',baselinePublicationIds:['baseline1']}};}
test('brief uses latest matching saved user plan and its immutable identity/time, not original model suggestion',()=>{
 const p=withSavedReview();p.decisions=[savedPlan('d1','旧计划'),savedPlan('d2','用户最新变更'),{...savedPlan('d3','别的假说'),hypothesisId:'other'}];const before=structuredClone(p);
 const b=feedbackExperimentBrief({publication:p,reviewId:'r1',hypothesisId:'h1'});
 assert.match(b,/用户最新变更/);assert.ok(b.includes('"decisionId": "d2"'));assert.ok(b.includes('2026-09-30T03:00:00.000Z'));assert.match(b,/baseline1/);assert.equal(b.includes('下一部仅调整呈现说明'),false);assert.equal(b.includes('旧计划'),false);assert.equal(b.includes('别的假说'),false);assert.deepEqual(p,before);
 const candidate=feedbackExperimentBrief({publication:withSavedReview(),reviewId:'r1',hypothesisId:'h1'});assert.match(candidate,/仅为模型候选建议/);assert.match(candidate,/model_candidate/);
});
test('rejected or withdrawn plans cannot be reused until a new valid matching plan is appended',()=>{
 for(const action of ['reject','withdraw']){
  const p=withSavedReview();p.decisions=[savedPlan('d1','原计划'),{id:'end',reviewId:'r1',hypothesisId:'h1',action,status:action==='reject'?'rejected':'withdrawn'}];
  assert.throws(()=>feedbackExperimentBrief({publication:p,reviewId:'r1',hypothesisId:'h1'}),e=>e.code==='PLAN_INACTIVE');
  p.decisions.push({...savedPlan('unrelated','无关计划'),reviewId:'other'});assert.throws(()=>feedbackExperimentBrief({publication:p,reviewId:'r1',hypothesisId:'h1'}),e=>e.code==='PLAN_INACTIVE');
  p.decisions.push(savedPlan('d2','重新制定计划'));const b=feedbackExperimentBrief({publication:p,reviewId:'r1',hypothesisId:'h1'});assert.match(b,/重新制定计划/);assert.ok(b.includes('"decisionId": "d2"'));
 }
});
test('hypotheses and overall report require nonempty concrete alternative and limitation strings',()=>{
 const {p,request,value}=bound();
 for(const mutate of [v=>v.hypotheses[0].alternatives=[],v=>v.hypotheses[0].limitations=[],v=>v.limitations=[],v=>v.hypotheses[0].alternatives=['  '],v=>v.hypotheses[0].limitations=[''],v=>v.limitations=['\n']]){const v=structuredClone(value);mutate(v);assert.throws(()=>parsePublicationFeedbackResponse(JSON.stringify(v),{publication:p,inputHash:request.inputHash}));}
});

test('r03 current snapshot uses observedAt despite reverse append order and preserves history',()=>{
 const p=publication(),newer={...structuredClone(p.observations[0]),id:'new',observedAt:'2026-09-30T04:00:00.000Z'};
 p.observations.unshift(newer);const before=structuredClone(p);
 const u=JSON.parse(buildPublicationFeedbackRequest({publication:p,assessment:{currentObservationId:'o1'}}).user);
 assert.equal(u.publication.currentObservationId,'new');assert.equal(u.publication.latestObservationId,'new');assert.equal(u.publication.observationConflict,false);
 assert.deepEqual(u.publication.observations.map(o=>o.id),['new','o1']);assert.deepEqual(p,before);
});
test('r03 identical latest payloads count once while conflicting ties have no winner',()=>{
 const p=publication();p.observations.push({...structuredClone(p.observations[0]),id:'o2',createdAt:'2026-09-30T05:00:00.000Z'});
 let u=JSON.parse(buildPublicationFeedbackRequest({publication:p,assessment:{currentObservationId:'o2'}}).user);
 assert.equal(u.publication.currentObservationId,'o2');assert.equal(u.publication.observationConflict,false);assert.equal(u.publication.observations.length,2);
 p.observations[1].metrics.reads=0;
 for(const observations of [p.observations,[...p.observations].reverse()]){
  u=JSON.parse(buildPublicationFeedbackRequest({publication:{...p,observations},assessment:{currentObservationId:'o2',observationConflict:false}}).user);
  assert.equal(u.publication.currentObservationId,null);assert.equal(u.publication.latestObservationId,null);assert.equal(u.publication.observationConflict,true);assert.equal(u.publication.observations.length,2);
 }
});
test('r03 identity declarations and cumulative window are explicit with conservative defaults',()=>{
 const p=publication();let u=JSON.parse(buildPublicationFeedbackRequest({publication:p}).user);
 assert.equal(u.publication.workIdentityConfirmed,false);assert.equal(u.publication.accountIdentityConfirmed,false);assert.equal(u.publication.observations[0].windowKind,'unknown');
 p.workIdentityConfirmed=true;p.accountIdentityConfirmed=true;p.observations[0].windowKind='since_publication';
 u=JSON.parse(buildPublicationFeedbackRequest({publication:p}).user);assert.equal(u.publication.workIdentityConfirmed,true);assert.equal(u.publication.accountIdentityConfirmed,true);assert.equal(u.publication.observations[0].windowKind,'since_publication');
});
test('r03 history retains frozen counterexamples across new plans and same normalized claim reviews',()=>{
 const p=withSavedReview();p.reviews[0].report.hypotheses[0].claim='  呈现  影响入口  ';
 const second=structuredClone(p.reviews[0]);second.id='r2';second.report.hypotheses[0].claim='呈现\n影响入口';p.reviews.push(second);
 p.reviews[0].rawResponse='PRIVATE_RAW_RESPONSE';p.reviews[0].config={token:'PRIVATE_CONFIG'};
 const counter={id:'resultA',reviewId:'r1',hypothesisId:'h1',action:'record_result',status:'contradicted',planDecisionId:'planA',result:{publicationIds:['synthetic-next'],conclusion:'contradicts',note:'合成反例'},evidenceBindings:{baseline:{observationId:'frozen0',metrics:{reads:100}},followups:[{observationId:'frozen1',metrics:{reads:10}}]},criterionCheck:{passed:false,kind:'increase'}};
 p.decisions=[savedPlan('planA','合成计划A'),counter,savedPlan('planB','合成计划B'),{...savedPlan('planC','跨复盘计划'),reviewId:'r2'}];
 const before=structuredClone(p),request=buildPublicationFeedbackRequest({publication:p}),h=JSON.parse(request.user).feedbackHistory;
 assert.equal(h.reviews[0].hypotheses[0].normalizedClaim,h.reviews[1].hypotheses[0].normalizedClaim);
 assert.equal(h.decisions.length,4);assert.equal(h.counterexamples.length,1);assert.equal(h.counterexamples[0].normalizedClaim,'呈现 影响入口');
 assert.deepEqual(h.counterexamples[0].evidenceBindings,counter.evidenceBindings);assert.deepEqual(h.counterexamples[0].criterionCheck,counter.criterionCheck);assert.equal(h.counterexamples[0].planDecisionId,'planA');
 assert.equal(request.user.includes('PRIVATE_'),false);assert.deepEqual(p,before);
 p.decisions[1].evidenceBindings.followups[0].metrics.reads=11;assert.notEqual(buildPublicationFeedbackRequest({publication:p}).inputHash,request.inputHash);
});
test('r03 oversized counterexample history fails before dispatch without truncation',async()=>{
 const p=withSavedReview();p.decisions=Array.from({length:100},(_,i)=>({id:`d${i}`,reviewId:'r1',hypothesisId:'h1',action:'record_result',status:'contradicted',result:{conclusion:'contradicts',note:'合'.repeat(4000)}}));const before=structuredClone(p);let calls=0;
 await assert.rejects(analyzePublicationFeedback({publication:p,model:{complete:async()=>{calls++;}}}),e=>e.code==='INPUT_TOO_LARGE');assert.equal(calls,0);assert.deepEqual(p,before);
});
test('r03 brief carries saved criterion while model testPlan remains exactly four fields',()=>{
 for(const criterion of [{kind:'increase'},{kind:'decrease'},{kind:'at_least',value:0.4},{kind:'at_most',value:12},{kind:'approved'}]){
  const p=withSavedReview(),plan=savedPlan('criterion-plan','用户计划');plan.plan.criterion=criterion;p.decisions=[plan];const before=structuredClone(p);
  const b=feedbackExperimentBrief({publication:p,reviewId:'r1',hypothesisId:'h1'});const value=JSON.parse(b.slice(b.indexOf('{')));
  assert.deepEqual(value.experimentPlan.plan.criterion,criterion);assert.equal(value.experimentPlan.decisionId,'criterion-plan');assert.equal(value.experimentPlan.createdAt,plan.createdAt);assert.deepEqual(p,before);
 }
 const {p,request,value}=bound();value.hypotheses[0].testPlan.criterion={kind:'increase'};
 assert.throws(()=>parsePublicationFeedbackResponse(JSON.stringify(value),{publication:p,inputHash:request.inputHash}),e=>e.code==='INVALID_RESPONSE');
});
