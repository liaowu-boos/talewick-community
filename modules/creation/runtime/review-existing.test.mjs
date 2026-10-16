import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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
test('existing manuscript enters review before any edit, uses real separate adjudication and full reread',async()=>{
 const model=fixture(),a={};const r=await runWorkflow({...options,model,checkpoint:async(k,v)=>a[k]=v});
 assert.deepEqual(model.calls.map(c=>c.stage),['requirements','review','review-adjudication','revision:ch-2','revisionReview']);
 assert.deepEqual(JSON.parse(model.calls[1].user).chapters,existing.chapters);
 assert.equal(a.review.phase,'existing_manuscript');assert.equal(a.requestedRevision,undefined);
 assert.equal(r.chapters[0].body,first);assert.equal(r.chapters[1].body,second.replace(quote,fixed));
 assert.equal(a.requestSpec.runtimeVersion,'review-existing-workflow-1');assert.equal(a.requestSpec.reviewPolicyVersion,'review-adjudication-3');assert.equal(r.reviewAdjudication.schemaVersion,'review-adjudication-3');assert.equal(r.revisionApplied,true);
 assert.equal(r.review.manuscriptSha256,manuscriptFingerprint(r.chapters));
});
test('reject and uncertain keep all source bytes without manufacturing edits',async()=>{
 for(const decision of ['reject','uncertain']){
 const m=fixture({decision}),r=await runWorkflow({...options,model:m});assert.deepEqual(r.chapters,existing.chapters);assert.equal(r.revisionApplied,false);assert.equal(m.calls.some(c=>c.stage.startsWith('revision:')),false);}
});
test('no-op replacement is not reported as prose revision',async()=>{
 const m=fixture(),base=m.complete;m.complete=async args=>args.stage==='revision:ch-2'?JSON.stringify({replacements:JSON.parse(args.user).revisionScope.ranges.map(r=>({...r,replacement:r.quote}))}):args.stage==='revisionReview'?JSON.stringify({...review,issues:[]}):base(args);
 const r=await runWorkflow({...options,model:m});assert.equal(r.revisionApplied,false);assert.deepEqual(r.chapters,existing.chapters);
});
test('interruption resumes actual source/review/adjudication; incompatible old mode and missing policy reject',async()=>{
 const a={},checkpoint=async(k,v)=>a[k]=structuredClone(v),m=fixture({failOnce:true});
 await assert.rejects(runWorkflow({...options,model:m,artifacts:a,checkpoint}),/synthetic interruption/);
 const r=await runWorkflow({...options,model:m,artifacts:a,checkpoint});assert.equal(r.chapters[1].body,second.replace(quote,fixed));assert.equal(m.calls.filter(c=>c.stage==='review-adjudication').length,1);
 await assert.rejects(runWorkflow({request:existing,model:m,artifacts:a}),/执行版本/);
 a.requestSpec.reviewPolicyVersion='review-adjudication-2';await assert.rejects(runWorkflow({...options,model:m,artifacts:a}),/执行版本/);a.requestSpec.reviewPolicyVersion='review-adjudication-3';delete a.requestSpec.boundedRevisionPolicyVersion;await assert.rejects(runWorkflow({...options,model:m,artifacts:a}),/有界修订策略/);
});
test('unsafe response and protection conflict never checkpoint edited manuscript',async()=>{
 for(const mode of [{badResponse:true},{protectTarget:true}]){
 const a={},m=fixture(mode);await assert.rejects(runWorkflow({...options,model:m,checkpoint:async(k,v)=>a[k]=v}));
 assert.deepEqual(a.existingManuscript.chapters,existing.chapters);assert.equal(a['revision:1:ch-2'],undefined);assert.equal(a.requestedRevision,undefined);}
});
test('versioned mode refuses controller and selection before model calls',async()=>{
 const m=fixture();await assert.rejects(runWorkflow({...options,model:m,controller:{runtimeVersion:'injected'}}));
 await assert.rejects(runWorkflow({...options,model:m,request:{...existing,quoteSource:{chapterId:'ch-2',start:0}}}));assert.equal(m.calls.length,0);
});
test('reusable runner retains raw failures and checkpoints; resume does not repeat completed calls',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'review-existing-'));const original=join(dir,'original.json');await writeFile(original,JSON.stringify(existing));const sourceFiles=[{path:original,sha256:sha(JSON.stringify(existing))}];const output=join(dir,'run');try{
 const m=fixture({failOnce:true});await assert.rejects(runReviewExisting({request:existing,model:m,outputDirectory:output,sourceFiles:[{path:original,sha256:'0'.repeat(64)}]}),/SHA/);assert.equal(m.calls.length,0);await assert.rejects(runReviewExisting({request:existing,model:m,outputDirectory:output,sourceFiles}),/synthetic interruption/);
 assert.ok((await readdir(output)).some(f=>f.endsWith('.failure.json')));
 const r=await runReviewExisting({request:existing,model:m,outputDirectory:output,sourceFiles,resume:true});assert.equal(r.revisionApplied,true);
 assert.equal(m.calls.filter(c=>c.stage==='review-adjudication').length,1);
 const source=JSON.parse(await readFile(join(output,'source.json'),'utf8'));assert.deepEqual(source.request.chapters,existing.chapters);
 await assert.rejects(runReviewExisting({request:existing,model:m,outputDirectory:output,sourceFiles}),/非空/);
 await assert.rejects(runReviewExisting({request:{...existing,title:'changed'},model:m,outputDirectory:output,sourceFiles,resume:true}),/原稿不一致/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
