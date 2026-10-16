import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {stateTransitionHints} from './state-transition-hints.mjs';
import {createContinuityLocationInput} from '../../validation/runtime/continuity-locations.mjs';
import {reviewStates,STATE_REVIEW_SYSTEM} from './state-review.mjs';
import {adjudicationFingerprint} from '../../validation/runtime/review-adjudication.mjs';
import {runWorkflow} from './workflow.mjs';
import {runReviewExisting} from './review-existing.mjs';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBusinessTools} from './business-tools.mjs';
import {manuscriptFingerprint} from '../../validation/runtime/checks.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const request={kind:'create',idea:'写一篇归来后重读退信的短篇，保留反复和未决。'};
const requirements={summary:'归来重读',targetHanMin:1,targetHanMax:1000,targetChapterCount:2,requiredElements:[],prohibitions:[],assumptions:[],completeEnding:true,usesChapter4Cut:false};
const plan={title:'退信',premise:'重读旧信',ending:'保持未决',chapters:[1,2].map(n=>({title:'场景'+n,goal:'重读与等待',scenes:['重读旧信'],continuity:'保持未决',targetHanMin:40,targetHan:100,targetHanMax:150})),characterArcs:[{character:'她',experience:'读信',belief:'未知',desire:'未知',fear:'未知',change:'未决',expression:'缩手'}],emotionalScenes:[1,2].map(()=>({experience:'计划尚未发生',cognition:'尚未读信的计划与正文不符',action:'重读',expression:'沉默',development:'保留反复',echo:'认识加深而非新事实'})),choiceCausality:[{id:'choice-1',chapterNumber:2,character:'她',pressure:'想知道退信原因又怕再次失望',choice:'再次读信但不答应对方',immediateConsequence:'对方仍得不到答复',carryForward:'后续关系保持未决',unresolvedBoundary:'是否重建联系未知'}],materialDecisions:[],psychologyLimitations:[]};
const first='她已经读到回执，知道信已退回。她把手缩回袖口。';
const quote='她第一次知道信已退回。',second='他又来，她仍把手缩回袖口；他这才看见磨破的边。\n\n'+quote+'\n\n她没有答应。';
const fixed='她又想到那封退回的信，还是没有答应。';
const problem={chapterId:'ch-2',category:'continuity',severity:'must_fix',quote,explanation:'同一人已读过同一事实却写成初知；合成测试裁定，不代表真实文学判断。',suggestion:'承接已知事实'};
const review={summary:'仍保持未决',issues:[problem],strengths:['回环语境有变化'],limitations:[],readingObservations:[]};
const retrieval=async q=>({contractVersion:'v04-contract-1',packetId:'empty',query:q,status:'uncovered',materials:[],candidates:[],usedChars:0,limits:[]});
function fixture({decision='confirm',failOnce=false,badResponse=false,protectTarget=false,legacyResponse=false}={}) {
 const calls=[];let failed=false;
 return {calls,complete:async args=>{
  calls.push(args);const u=JSON.parse(args.user);
  if(args.stage==='requirements')return JSON.stringify(requirements);
  if(args.stage==='planning')return JSON.stringify(plan);
  if(args.stage==='draft:ch-1')return first;
  if(args.stage==='draft:ch-2'){assert.equal(u.previousChapters[0].body,first);assert.equal(u.plan.emotionalScenes[1].cognition,plan.emotionalScenes[1].cognition);return second;}
  if(args.stage==='review')return JSON.stringify(protectTarget?{...review,readingObservations:[{observation:'合成保护冲突',evidence:[{chapterId:'ch-2',quote}],revisionScope:{chapterIds:['ch-2'],preserve:[quote],action:'保留',reason:'边界检查'}}]}:review);
  if(args.stage==='review-adjudication')return JSON.stringify({inputHash:u.inputHash,manuscriptSha256:u.manuscriptSha256,sourceReviewSha256:u.sourceReviewSha256,checkedChapterIds:u.chapters.map(c=>c.id),decisions:u.issues.map(x=>({issueId:x.issueId,issueSha256:x.issueSha256,decision,reason:'仅用于协议检查的合成裁定',scope:'text_internal',supportingEvidence:[{chapterId:x.issue.chapterId,quote:x.issue.quote,role:'narration',actor:'她',relevance:'合成逐字证据'}],counterEvidence:[],alternativeExplanation:{assessment:decision==='confirm'?'ruled_out':'unresolved',reason:'合成检查'},characterKnowledge:{assessment:'respected',reason:'合成检查人物已知信息'}}))});
  if(['agent:reviseChapter:ch-2','revision:ch-2'].includes(args.stage)){
   if(legacyResponse){assert.equal(u.revisionScope,undefined);return second.replace(quote,fixed);}
   assert.deepEqual(u.manuscriptContext.map(c=>c.body),[first,second]);assert.equal(u.revisionScope.bodySha256,sha(second));
   if(failOnce&&!failed){failed=true;throw Error('synthetic interruption');}
   return badResponse?'擅自返回整章正文':JSON.stringify({replacements:[{...u.revisionScope.ranges[0],replacement:fixed}]});
  }
  if(['agent:reviewManuscript','revisionReview'].includes(args.stage)){assert.equal(Object.hasOwn(u,'plan'),false);assert.equal(u.chapters[1].body,second.replace(quote,fixed));return JSON.stringify({...review,issues:[]});}
  throw Error('unexpected stage '+args.stage);
 }};
}

const existing={kind:'revise',title:'退信',instruction:'从全文核对真实问题，保留有效反复、心理和未决，只修获准局部。',chapters:[{id:'ch-1',title:'一',body:first},{id:'ch-2',title:'二',body:second}]};
const options={request:existing,existingReviewMode:'review-existing-v1',followupMode:'fixed_materials'};

function stateResponse(args,{issue=true,unknown=false,stale=false,empty=false}={}){
 const u=JSON.parse(args.user);assert.equal(u.review,undefined);assert.equal(u.previousIssues,undefined);assert.equal(u.cases,undefined);
 const cite=(n,needle)=>({chapterId:u.chapters[n].id,fragmentStart:u.chapters[n].fragments.find(f=>f.text.includes(needle)).id,fragmentEnd:u.chapters[n].fragments.find(f=>f.text.includes(needle)).id,role:'narration',actor:'她'});
 return JSON.stringify({inputHash:stale?'0'.repeat(64):u.inputHash,manuscriptSha256:u.manuscriptSha256,checkedChapterIds:u.chapters.map(c=>c.id),checkedDimensions:['knowledge','obligation','physical_state','time','promise'],coverage:{status:'complete',omissions:[]},comparisons:empty?[]:[{id:'synthetic-case',dimension:'knowledge',subject:'同一封信退回的已知事实',identity:'same',time:'ordered_events',before:{state:'早已知道',certainty:'stated',evidence:cite(0,'知道信已退回')},after:{state:'当作首次得知',certainty:'stated',evidence:cite(1,'第一次知道')},alternatives:[{explanation:'是否只是公开谈起而非新得知，合成语句明确写知道',status:unknown?'unresolved':'ruled_out',evidence:[0,1]}],counterEvidence:[],assessment:unknown?'unknown':'conflict_candidate',reason:'仅合成测试，不代表真实稿文学结论',issue:issue?{evidenceIndex:1,category:'STORY_COMPREHENSION_BLOCKER',severity:'must_fix',explanation:'合成已知事实重置',suggestion:'只承接已知信息，保留回环'}:null}]});
}
function cappedResponse(args,{corrected=false}={}){
 const value=JSON.parse(stateResponse(args,{issue:false}));
 value.comparisons=Array.from({length:8},(_,index)=>({...value.comparisons[0],id:`comparison-${index+1}`}));
 if(corrected)value.coverage={status:'bounded',omissions:['八条记录已占满，其余状态转移未逐项记录']};
 return JSON.stringify(value);
}
test('eight comparisons with complete coverage get one format feedback call; both raw responses remain bound',async()=>{
 const calls=[],rejected=[];
 const model={complete:async args=>{
  calls.push(args);
  if(calls.length===2){
   const retry=JSON.parse(args.user);
   assert.equal(retry.invalidResponse,cappedResponse(calls[0]));
   assert.equal(retry.fieldError,'状态专审达到记录上限');
   assert.equal(retry.inputHash,JSON.parse(calls[0].user).inputHash);
   assert.equal(args.system,calls[0].system);
   return cappedResponse(args,{corrected:true});
  }
  return cappedResponse(args);
 }};
 const result=await reviewStates({chapters:existing.chapters,requirements,model,onRejectedResponse:x=>rejected.push(x)});
 assert.equal(calls.length,2);assert.equal(result.coverage.status,'bounded');assert.equal(result.comparisons.length,8);
 assert.equal(rejected.length,1);assert.equal(rejected[0].rawResponse,cappedResponse(calls[0]));
 assert.equal(rejected[0].failurePhase,'validation');assert.equal(rejected[0].formatRetryClass,'coverage_limit');assert.equal(rejected[0].formatRetryReserved,true);
 assert.deepEqual(result.rejectedResponses,rejected);
 assert.equal(result.responseSha256,adjudicationFingerprint(result.rawResponse));
});
test('a second capped response fails closed without a third call and archives both attempts',async()=>{
 const rejected=[],calls=[];
 const model={complete:async args=>{calls.push(args);return cappedResponse(args);}};
 await assert.rejects(reviewStates({chapters:existing.chapters,requirements,model,onRejectedResponse:x=>rejected.push(x)}),
  error=>error.code==='STATE_REVIEW_REJECTED'&&error.message==='状态专审达到记录上限');
 assert.equal(calls.length,2);assert.deepEqual(rejected.map(x=>x.attempt),[1,2]);
 assert.deepEqual(rejected.map(x=>x.formatRetryReserved),[true,false]);
 assert.equal(rejected[0].inputHash,rejected[1].inputHash);
});
test('cancellation after archiving a capped response prevents the correction call',async()=>{
 const controller=new AbortController();let calls=0;
 const model={complete:async args=>{calls++;return cappedResponse(args);}};
 await assert.rejects(reviewStates({chapters:existing.chapters,requirements,model,signal:controller.signal,
  onRejectedResponse:()=>controller.abort(new Error('cancelled after archive'))}),/cancelled after archive/);
 assert.equal(calls,1);
});
test('invalid JSON and unsupported must_fix are archived exactly and never consume or dispatch format repair',async()=>{
 for(const kind of ['json','semantic']){
  const rejected=[];let calls=0,raw;
  const model={complete:async args=>{calls++;if(kind==='json')raw='{"inputHash":';else{const value=JSON.parse(stateResponse(args));value.comparisons[0].alternatives[0].status='plausible';raw=JSON.stringify(value);}return raw;}};
  await assert.rejects(reviewStates({chapters:existing.chapters,requirements,model,onRejectedResponse:x=>rejected.push(x)}),
   error=>error.code==='STATE_REVIEW_REJECTED');
  assert.equal(calls,1);assert.equal(rejected.length,1);assert.equal(rejected[0].rawResponse,raw);
  assert.equal(rejected[0].responseSha256,adjudicationFingerprint(raw));assert.equal(rejected[0].attempt,1);
  assert.equal(rejected[0].failurePhase,kind==='json'?'json':'validation');
  if(kind==='semantic')assert.equal(rejected[0].error,'状态专审候选缺少支持，不能升必修');
  assert.equal(rejected[0].formatRetryClass,'not_format_retryable');assert.equal(rejected[0].formatRetryReserved,false);
  assert.equal(rejected[0].recovery,'resume_unfinished_state_review_with_fresh_response');
 }
});
function v2model({decision='confirm',stateFail=false,uncertainState=false}={}){
 const m=fixture({decision}),base=m.complete;
 m.complete=async args=>{
  if(args.stage==='continuity-review'){
   m.calls.push(args);const u=JSON.parse(args.user);const empty=!u.chapters[1].fragments.some(f=>f.text.includes('第一次知道'));
   return stateResponse(args,{empty,stale:stateFail,unknown:uncertainState});
  }
  if(args.stage==='review'){m.calls.push(args);return JSON.stringify({...review,issues:[]});}
  return base(args);
 };
 return m;
}
const v2={...options,existingReviewMode:'review-existing-v2'};
test('v2 discovers model candidates outside general review, then independently adjudicates, bounds and rereads both views',async()=>{
 const m=v2model(),a={};const result=await runWorkflow({...v2,model:m,checkpoint:async(k,v)=>a[k]=v});
 assert.deepEqual(m.calls.map(c=>c.stage),['requirements','review','continuity-review','review-adjudication','revision:ch-2','revisionReview','continuity-review']);
 assert.equal(a['review:general'].issues.length,0);assert.equal(a['review:state'].issues.length,1);assert.equal(a.review.issues.length,1);
 assert.equal(a.requestSpec.runtimeVersion,'review-existing-workflow-2');assert.equal(result.chapters[0].body,first);assert.equal(result.chapters[1].body,second.replace(quote,fixed));
 assert.equal(a['revisionReview:state'].manuscriptSha256,result.review.manuscriptSha256);assert.equal(a['revisionReview:state'].issues.length,0);
 assert.equal(JSON.parse(m.calls.find(c=>c.stage==='review-adjudication').user).issues[0].issue.explanation.includes('状态对照'),true);
 const count=m.calls.length;await runWorkflow({...v2,model:m,artifacts:a});assert.equal(m.calls.length,count);
 await assert.rejects(runWorkflow({...options,model:m,artifacts:a}),/执行版本/);
});
test('v2 independent reject preserves originals and does not promote state candidates to authorization',async()=>{
 const m=v2model({decision:'reject'});const result=await runWorkflow({...v2,model:m});assert.equal(result.revisionApplied,false);assert.deepEqual(result.chapters,existing.chapters);assert.equal(m.calls.some(c=>c.stage.startsWith('revision:')),false);
});
test('invalid state binding or unresolved must_fix fails closed and retains actual general review',async()=>{
 for(const mode of [{stateFail:true},{uncertainState:true}]){
 const m=v2model(mode),a={};await assert.rejects(runWorkflow({...v2,model:m,checkpoint:async(k,v)=>a[k]=v}),e=>e.code==='STATE_REVIEW_REJECTED');
 assert.equal(a['review:general'].issues.length,0);assert.equal(a.review,undefined);assert.equal(m.calls.some(c=>c.stage==='review-adjudication'),false);assert.deepEqual(a.existingManuscript.chapters,existing.chapters);
 const archived=Object.entries(a).filter(([key])=>key.startsWith('review:state:rejected:'));
 assert.equal(archived.length,1);assert.equal(archived[0][1].rawResponse,stateResponse(m.calls.find(call=>call.stage==='continuity-review'),{stale:mode.stateFail,unknown:mode.uncertainState}));
 assert.equal(archived[0][1].formatRetryReserved,false);assert.equal(archived[0][1].failurePhase,'validation');
 }
});
test('state comparison without explicit model issue is never upgraded even if marked conflict_candidate',async()=>{
 const model={complete:async args=>stateResponse(args,{issue:false})};const result=await reviewStates({chapters:existing.chapters,requirements,model});assert.equal(result.comparisons.length,1);assert.equal(result.issues.length,0);assert.equal(result.semanticAcceptance,false);
});
test('unknown and meaningful repetition have safe no-edit exits; malformed locations have no fuzzy recovery',async()=>{
 for(const assessment of ['unknown','meaningful_repetition','explained']){
 const model={complete:async args=>{const v=JSON.parse(stateResponse(args,{issue:false}));v.comparisons[0].assessment=assessment;v.comparisons[0].alternatives[0].status='plausible';return JSON.stringify(v);}};
 assert.equal((await reviewStates({chapters:existing.chapters,requirements,model})).issues.length,0);
 }
 let calls=0,raw;const rejected=[],bad={complete:async args=>{calls++;const v=JSON.parse(stateResponse(args));v.comparisons[0].after.evidence.fragmentEnd=100000;raw=JSON.stringify(v);return raw;}};
 await assert.rejects(reviewStates({chapters:existing.chapters,requirements,model:bad,onRejectedResponse:x=>rejected.push(x)}),/位置无效/);assert.equal(calls,1);
 assert.equal(rejected.length,1);assert.equal(rejected[0].rawResponse,raw);assert.equal(rejected[0].error,'状态专审引文位置无效');assert.equal(rejected[0].formatRetryReserved,false);
});
test('v2 stops after two allowed rounds, retaining remaining candidates and actual no-op status',async()=>{
 const m=v2model(),base=m.complete;
 m.complete=async args=>{
  if(args.stage==='revision:ch-2'){m.calls.push(args);const u=JSON.parse(args.user);return JSON.stringify({replacements:u.revisionScope.ranges.map(r=>({...r,replacement:r.quote}))});}
  if(args.stage==='revisionReview'){m.calls.push(args);return JSON.stringify({...review,issues:[]});}
  return base(args);
 };
 const r=await runWorkflow({...v2,model:m});assert.equal(m.calls.filter(c=>c.stage==='revision:ch-2').length,2);assert.equal(m.calls.filter(c=>c.stage==='continuity-review').length,3);assert.equal(r.revisionApplied,false);assert.deepEqual(r.chapters,existing.chapters);assert.equal(r.review.issues.some(i=>i.severity==='must_fix'),true);
});
test('state review failure resumes general checkpoint without repeating general model call',async()=>{
 const a={},bad=v2model({stateFail:true});await assert.rejects(runWorkflow({...v2,model:bad,checkpoint:async(k,v)=>a[k]=v}));
 const good=v2model({decision:'reject'});await runWorkflow({...v2,model:good,artifacts:a});assert.deepEqual(good.calls.map(c=>c.stage),['continuity-review','review-adjudication']);
});
test('ordinary archived state failure does not consume the one coverage format repair on resume',async()=>{
 const artifacts={},bad=v2model({uncertainState:true});await assert.rejects(runWorkflow({...v2,model:bad,checkpoint:async(k,v)=>artifacts[k]=v}));
 const resumed=v2model({decision:'reject'}),base=resumed.complete;let continuityCalls=0;
 resumed.complete=async args=>{
  if(args.stage==='continuity-review'){resumed.calls.push(args);continuityCalls++;return cappedResponse(args,{corrected:continuityCalls===2});}
  return base(args);
 };
 const result=await runWorkflow({...v2,model:resumed,artifacts,checkpoint:async(k,v)=>artifacts[k]=v});
 assert.equal(result.revisionApplied,false);assert.equal(continuityCalls,2);
 const archived=Object.entries(artifacts).filter(([key])=>key.startsWith('review:state:rejected:')).map(([,value])=>value);
 assert.equal(archived.length,2);assert.equal(archived[0].formatRetryClass,'not_format_retryable');assert.equal(archived[0].formatRetryReserved,false);
 assert.equal(archived[1].formatRetryClass,'coverage_limit');assert.equal(archived[1].formatRetryReserved,true);
});

test('normal workflow projects only neutral requirements into state review and hashes that projection',async()=>{
 const marker='NON_NEUTRAL_UPSTREAM_SENTINEL_20260929';
 const neutral={pointOfView:'第三人称',setting:'当代小镇',requiredElements:['保留朋友间的分歧'],prohibitions:['不强制和解'],completeEnding:true,usesChapter4Cut:false};
 const calls=[],artifacts={};let captured;
 const model={complete:async args=>{
  calls.push(args.stage);
  if(args.stage==='requirements')return JSON.stringify({...requirements,...neutral,summary:marker+'摘要解释',assumptions:[marker+'心理解释']});
  if(args.stage==='review')return JSON.stringify({...review,issues:[]});
  if(args.stage==='continuity-review'){
   captured=JSON.parse(args.user);assert.equal(args.user.includes(marker),false);
   assert.deepEqual(captured.requirements,neutral);
   assert.deepEqual(captured.chapters.map(c=>({id:c.id,title:c.title,body:c.fragments.map(f=>f.text).join('')})),existing.chapters);
   const {inputHash,...modelInput}=captured;
   assert.equal(inputHash,adjudicationFingerprint({system:STATE_REVIEW_SYSTEM,modelInput}));
   return stateResponse(args,{empty:true});
  }
  throw Error('unexpected stage '+args.stage);
 }};
 const result=await runWorkflow({...v2,request:{...existing,instruction:existing.instruction+marker},model,checkpoint:async(k,v)=>artifacts[k]=v});
 assert.equal(artifacts.requestSpec.requirements.summary.includes(marker),true);
 assert.equal(artifacts.requestSpec.requirements.assumptions.some(x=>x.includes(marker)),true);
 assert.equal(JSON.stringify(artifacts.requestSpec.requirements.userRequirementSources).includes(marker),true);
 assert.deepEqual(Object.keys(captured.requirements).sort(),Object.keys(neutral).sort());
 assert.deepEqual(calls,['requirements','review','continuity-review']);assert.equal(result.revisionApplied,false);
});

test('transition hints are bounded deterministic UTF16 source locations, never issues or verdicts',()=>{
 const chapters=[{id:'a',title:'一',body:'😀她早已知道。'+ '她第一次看到雨。'.repeat(30)},{id:'b',title:'二',body:'他第一次走到别处。他再次回想。'}];
 const locations=createContinuityLocationInput({chapters}),h=stateTransitionHints(chapters,locations);
 assert.deepEqual(h,stateTransitionHints(chapters,locations));assert.equal(h.selectedCount,24);assert.ok(h.omittedCount>0);assert.equal(h.hints[1].chapterId,'b');
 for(const x of h.hints){const c=chapters.find(c=>c.id===x.chapterId);assert.equal(c.body.slice(x.start,x.end),x.quote);assert.equal(c.body.slice(x.matchStart,x.matchEnd),x.matched);assert.equal(x.bodySha256,sha(c.body));assert.equal(x.severity,undefined);assert.equal(x.issue,undefined);}
});
function withHintChecks(args,response){
 const u=JSON.parse(args.user),v=JSON.parse(response);v.hintChecks=u.transitionHints.hints.map(h=>({hintId:h.id,status:v.comparisons.length&&h.matched==='第一次'?'compared':'not_applicable',comparisonIds:v.comparisons.length&&h.matched==='第一次'?['synthetic-case']:[],reason:'合成测试：定位不是错误判断，具体事件仍须模型核查'}));
 if(u.transitionHints.omittedCount){v.coverage={status:'bounded',omissions:['定位上限有遗漏']};}
 return JSON.stringify(v);
}
test('v3 explicit first-knowledge claim becomes only a model candidate; separate reject still prevents edit',async()=>{
 const m=v2model({decision:'reject'}),base=m.complete;let hints;
 m.complete=async args=>{
  if(args.stage==='continuity-review'){m.calls.push(args);const u=JSON.parse(args.user);hints=u.transitionHints;assert.equal(u.schemaVersion,'creation-state-review-2');assert.equal(u.requirements.summary,undefined);return withHintChecks(args,stateResponse(args));}
  return base(args);
 };
 const a={},r=await runWorkflow({...options,existingReviewMode:'review-existing-v3',model:m,checkpoint:async(k,v)=>a[k]=v});
 assert.ok(hints.hints.some(h=>h.quote.includes(quote)));assert.equal(a.requestSpec.runtimeVersion,'review-existing-workflow-3');assert.equal(a['review:state'].hintChecks.length,hints.selectedCount);assert.equal(r.revisionApplied,false);assert.deepEqual(r.chapters,existing.chapters);
 assert.equal(m.calls.filter(c=>c.stage==='continuity-review').length,1);assert.equal(m.calls.filter(c=>c.stage==='review-adjudication').length,1);
 await assert.rejects(runWorkflow({...v2,model:m,artifacts:a}),/执行版本/);
});
test('first in another event, deeper understanding and meaningful repetition can all remain unedited',async()=>{
 const chapters=[{id:'one',title:'一',body:'她早已知道信退回。她第一次来到海边。'},{id:'two',title:'二',body:'这才明白父亲为何沉默。她再次想起旧信，仍然没有答应。'}];
 let checks;
 const model={complete:async args=>{const u=JSON.parse(args.user);checks=u.transitionHints.hints.map(h=>({hintId:h.id,status:'explained',comparisonIds:[],reason:'合成判断：不同事件首次、理解深化或有意义回环，非事实重置'}));return JSON.stringify({inputHash:u.inputHash,manuscriptSha256:u.manuscriptSha256,checkedChapterIds:chapters.map(c=>c.id),checkedDimensions:['knowledge','obligation','physical_state','time','promise'],coverage:{status:'complete',omissions:[]},comparisons:[],hintChecks:checks});}};
 const r=await reviewStates({chapters,requirements,model,transitionHintsEnabled:true});assert.ok(checks.length>=4);assert.equal(r.issues.length,0);assert.equal(r.semanticAcceptance,false);
});
test('v3 refuses missing hint checks without retries or automatic candidates',async()=>{
 let calls=0;const model={complete:async args=>{calls++;const v=JSON.parse(withHintChecks(args,stateResponse(args,{empty:true})));v.hintChecks.pop();return JSON.stringify(v);}};
 await assert.rejects(reviewStates({chapters:existing.chapters,requirements,model,transitionHintsEnabled:true}),/覆盖不完整/);assert.equal(calls,1);
});
