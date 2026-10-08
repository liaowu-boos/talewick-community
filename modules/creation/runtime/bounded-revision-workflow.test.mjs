import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runWorkflow} from './workflow.mjs';
import {createBusinessTools} from './business-tools.mjs';
import {manuscriptFingerprint} from '../../validation/runtime/checks.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const request={kind:'create',idea:'写一篇归来后重读退信的短篇，保留反复和未决。'};
const requirements={summary:'归来重读',targetHanMin:1,targetHanMax:1000,targetChapterCount:2,requiredElements:[],prohibitions:[],assumptions:[],completeEnding:true,usesChapter4Cut:false};
const plan={title:'退信',premise:'重读旧信',ending:'保持未决',chapters:[1,2].map(n=>({title:'场景'+n,goal:'重读与等待',scenes:['重读旧信'],continuity:'保持未决',targetHanMin:40,targetHan:100,targetHanMax:150})),characterArcs:[{character:'她',experience:'读信',belief:'未知',desire:'未知',fear:'未知',change:'未决',expression:'缩手'}],emotionalScenes:[1,2].map(()=>({experience:'计划尚未发生',cognition:'尚未读信的计划与正文不符',action:'重读',expression:'沉默',development:'保留反复',echo:'认识加深而非新事实'})),materialDecisions:[],psychologyLimitations:[]};
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
const controller={runtimeVersion:'bounded-test-1',async review(c){
 assert.equal(c.boundedRevisionPolicyVersion,'bounded-paragraph-revision-1');
 const chapter=c.chapters[1],start=chapter.body.indexOf(quote),scope={bodySha256:sha(chapter.body),ranges:[{start,end:start+quote.length,quote}],preserve:[{start:0,end:start,quote:chapter.body.slice(0,start)}]};
 const edited=await c.step('tool:bounded',()=>c.reviseChapter({chapters:c.chapters,chapterId:chapter.id,issues:c.review.issues,review:c.review,reviewAdjudication:c.reviewAdjudication,revisionScope:scope}));
 const chapters=c.chapters.map(x=>x.id===edited.id?edited:x);const reread=await c.reviewManuscript(chapters,c.review.issues);const adjudication=await c.adjudicateReview(chapters,reread);
 return {chapters,review:reread,reviewAdjudication:adjudication,trace:[]};
}};
test('workflow carries actual prior facts, applies bounded correction after adjudication and binds reread to new text',async()=>{
 const model=fixture(),artifacts={},checkpoint=async(k,v)=>{artifacts[k]=structuredClone(v);};const result=await runWorkflow({request,model,retrieveKnowledge:retrieval,controller,artifacts,checkpoint});
 assert.deepEqual(result.chapters.map(c=>c.body),[first,second.replace(quote,fixed)]);assert.equal(result.review.manuscriptSha256,manuscriptFingerprint(result.chapters));
 assert.equal(result.reviewAdjudication.manuscriptSha256,result.review.manuscriptSha256);const count=model.calls.length;assert.deepEqual(await runWorkflow({request,model,retrieveKnowledge:retrieval,controller,artifacts,checkpoint}),result);assert.equal(model.calls.length,count);
});
test('uncertain independent adjudication blocks even an exact bounded scope before the revision model',async()=>{
 const model=fixture({decision:'uncertain'});await assert.rejects(runWorkflow({request,model,retrieveKnowledge:retrieval,controller}),/经证据裁定确认/);assert.equal(model.calls.some(c=>c.stage==='agent:reviseChapter:ch-2'),false);
});
test('interrupted bounded revision resumes saved draft and adjudication without regenerating them',async()=>{
 const model=fixture({failOnce:true}),artifacts={},checkpoint=async(k,v)=>{artifacts[k]=structuredClone(v);};
 await assert.rejects(runWorkflow({request,model,retrieveKnowledge:retrieval,controller,artifacts,checkpoint}),/synthetic interruption/);assert.equal(artifacts['draft:ch-2'].body,second);
 const result=await runWorkflow({request,model,retrieveKnowledge:retrieval,controller,artifacts,checkpoint});assert.equal(result.chapters[1].body,second.replace(quote,fixed));
 assert.equal(model.calls.filter(c=>c.stage==='draft:ch-2').length,1);assert.equal(model.calls.filter(c=>c.stage==='review-adjudication').length,1);
});

test('business adapter preserves legacy no-scope response and does not retry malformed bounded output',async()=>{
 const chapter={id:'ch-2',title:'场景2',body:second},start=second.indexOf(quote),scope={bodySha256:sha(second),ranges:[{start,end:start+quote.length,quote}]};let calls=0,mode='legacy';
 const business=createBusinessTools({input:{},requirements:{},rules:{manuscript:{content:''},planning:{content:''},review:{content:''}},knowledgeView:{materials:[]},call:async()=>{calls++;return mode==='legacy'?'旧接口仍返回整章正文':'{"replacements":[],"body":"擅自整章改写"}';}});
 assert.equal((await business.reviseChapter({chapters:[chapter],chapterId:chapter.id,issues:[problem]})).body,'旧接口仍返回整章正文');
 mode='bounded';await assert.rejects(business.reviseChapter({chapters:[chapter],chapterId:chapter.id,issues:[problem],revisionScope:scope}),error=>error.code==='BOUNDED_REVISION_RESPONSE_REJECTED'&&error.revisionDispatched===true);assert.equal(calls,2);assert.equal(chapter.body,second);
 await assert.rejects(business.reviseChapter({chapters:[chapter],chapterId:chapter.id,issues:[problem],revisionScope:{...scope,bodySha256:'0'.repeat(64)}}),/正文版本/);assert.equal(calls,2);
});

test('new automatic must_fix derives paragraphs and actually uses replacements with scope and reread artifacts',async()=>{
 const model=fixture(),artifacts={},checkpoint=async(k,v)=>{artifacts[k]=structuredClone(v);};const result=await runWorkflow({request,model,retrieveKnowledge:retrieval,artifacts,checkpoint});
 assert.equal(artifacts.requestSpec.boundedRevisionPolicyVersion,'bounded-paragraph-revision-1');
 const call=model.calls.find(c=>c.stage==='revision:ch-2'),input=JSON.parse(call.user);assert.equal(input.revisionScope.ranges[0].quote,quote);assert.deepEqual(input.manuscriptContext.map(c=>c.body),[first,second]);
 assert.deepEqual(result.chapters.map(c=>c.body),[first,second.replace(quote,fixed)]);assert.equal(Object.entries(artifacts).find(([k])=>k.startsWith('boundedRevision:'))[1].status,'applied_pending_reread');
 assert.equal(Object.entries(artifacts).find(([k])=>k.startsWith('boundedRevisionCheck:'))[1].status,'reread_recorded');assert.equal(Object.entries(artifacts).find(([k])=>k.startsWith('boundedRevisionCheck:'))[1].semanticAcceptance,false);
});
test('automatic uncertain adjudication makes zero revision calls and preserves all chapter bytes',async()=>{
 const model=fixture({decision:'uncertain'});const result=await runWorkflow({request,model,retrieveKnowledge:retrieval});assert.deepEqual(result.chapters.map(c=>c.body),[first,second]);assert.equal(model.calls.some(c=>c.stage.startsWith('revision:')),false);
});
test('bad automatic response never checkpoints revised text; retry reuses source scope and adjudication',async()=>{
 const artifacts={},checkpoint=async(k,v)=>{artifacts[k]=structuredClone(v);},bad=fixture({badResponse:true});
 await assert.rejects(runWorkflow({request,model:bad,retrieveKnowledge:retrieval,artifacts,checkpoint}),/JSON/);assert.equal(artifacts['revision:1:ch-2'],undefined);assert.equal(artifacts['draft:ch-2'].body,second);assert.equal(Object.keys(artifacts).some(k=>k.startsWith('boundedRevision:')),false);
 const retry=fixture();const result=await runWorkflow({request,model:retry,retrieveKnowledge:retrieval,artifacts,checkpoint});assert.equal(result.chapters[1].body,second.replace(quote,fixed));assert.equal(retry.calls.some(c=>['requirements','planning','review','review-adjudication','draft:ch-1','draft:ch-2'].includes(c.stage)),false);
});
test('protection conflict persists the diagnosis and a retry returns to the same safe checkpoint with no model work',async()=>{
 const artifacts={},checkpoint=async(k,v)=>{artifacts[k]=structuredClone(v);},model=fixture({protectTarget:true});
 await assert.rejects(runWorkflow({request,model,retrieveKnowledge:retrieval,artifacts,checkpoint}),/保护范围/);assert.equal(artifacts['boundedRevisionScope:1:ch-2:blocked'].automaticFallback,false);assert.equal(artifacts['draft:ch-2'].body,second);assert.equal(artifacts.review.issues[0].quote,quote);
 const count=model.calls.length;await assert.rejects(runWorkflow({request,model,retrieveKnowledge:retrieval,artifacts,checkpoint}),/保护范围/);assert.equal(model.calls.length,count);
});
test('legacy snapshot without the new policy keeps the prior complete-chapter revision contract',async()=>{
 const artifacts={},stop=Error('save legacy-schema fixture');await assert.rejects(runWorkflow({request,model:fixture(),retrieveKnowledge:retrieval,checkpoint:async(k,v)=>{assert.equal(k,'requestSpec');artifacts[k]=structuredClone(v);delete artifacts[k].boundedRevisionPolicyVersion;throw stop;}}),e=>e===stop);
 const model=fixture({legacyResponse:true});const result=await runWorkflow({request,model,retrieveKnowledge:retrieval,artifacts});assert.equal(result.chapters[1].body,second.replace(quote,fixed));assert.equal(JSON.parse(model.calls.find(c=>c.stage==='revision:ch-2').user).revisionScope,undefined);
});

test('range preflight errors are distinguishable from dispatched transport failures',async()=>{
 const chapter={id:'ch-2',title:'场景2',body:second},start=second.indexOf(quote),scope={bodySha256:sha(second),ranges:[{start,end:start+quote.length,quote}]};let calls=0;
 const business=createBusinessTools({input:{},requirements:{},rules:{manuscript:{content:''},planning:{content:''},review:{content:''}},knowledgeView:{materials:[]},call:async()=>{calls++;throw Object.assign(new Error('synthetic transport timeout'),{code:'NETWORK_TIMEOUT'});}});
 await assert.rejects(business.reviseChapter({chapters:[chapter],chapterId:chapter.id,issues:[problem],revisionScope:{...scope,bodySha256:'0'.repeat(64)}}),e=>e.code==='BOUNDED_REVISION_SCOPE_REJECTED'&&e.revisionDispatched===false&&e.retryableWithCorrectedScope===true);assert.equal(calls,0);
 await assert.rejects(business.reviseChapter({chapters:[chapter],chapterId:chapter.id,issues:[problem],revisionScope:scope}),e=>e.code==='NETWORK_TIMEOUT'&&e.revisionDispatched===true);assert.equal(calls,1);assert.equal(chapter.body,second);
});
