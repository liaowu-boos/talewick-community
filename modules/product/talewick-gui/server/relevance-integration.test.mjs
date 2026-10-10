import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLibraryService,createRetrieveKnowledge } from './library.mjs';
import { createHash } from 'node:crypto';
import { validateRelevanceReview } from '../../../data/runtime/relevance.mjs';
import { expandRelevanceInput } from '../../../data/runtime/relevance-payload.mjs';
import { prepareWorkflowKnowledge, knowledgeForAuthor } from '../../../creation/runtime/v04/knowledge.mjs';
import { createFollowup } from '../../../creation/runtime/v04/followup.mjs';
import { prepareKnowledge } from '../../../data/runtime/knowledge.mjs';
import { materialView, relevanceReviewText } from '../src/model/material-results.ts';
import { createModel } from './model.mjs';
const analysis={overview:'',coverage:{scope:'full',notes:[]},limitations:[],units:[{id:'u',title:'转轴',event:'检查转轴',psychology:'未知',emotion:'未知',expression:'动作',readerEffectHypothesis:'可能关注结果',locator:{lineStart:1,lineEnd:1},evidence:[{quote:'转轴维护。',lineStart:1,lineEnd:1}],relatedUnitIds:[]}]};
const query={contractVersion:'v04-contract-1',query:'转轴',context:'检修动作',stage:'planning',budget:{maxCandidates:20,maxUnits:6,maxChars:12000}};
const sourceText='转轴维护。';
const failedModes=new Set(['HTTP','length','empty','invalid','missing-evidence','foreign-evidence']);
const event=(content,finish='stop')=>new Response(`data: ${JSON.stringify({choices:[{index:0,delta:{content},finish_reason:finish}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
test('normal DATA loader through existing model transport: bounded recovery without unverified fallback',async()=>{
 const rootDir=await mkdtemp(join(tmpdir(),'relevance-normal-'));let library,calls=0,mode='usable';const stages=[],bodies=[];
 const adapter=createModel({baseURL:'https://example.invalid',agentProvider:'deepseek',apiKey:'fixture',model:'deepseek-flash',timeoutMs:2000},async(_url,init)=>{
  calls++;const b=JSON.parse(init.body);bodies.push(b);const p=JSON.parse(b.messages[1].content);
  const {inputHash,...packed}=p,expanded=expandRelevanceInput(packed);
  assert.equal(p.schemaVersion,'library-relevance-4');
  assert.equal(inputHash,createHash('sha256').update(JSON.stringify(packed)).digest('hex'));
  assert.equal(b.max_tokens,32768);assert.deepEqual(b.thinking,{type:'enabled'});assert.deepEqual(b.response_format,{type:'json_object'});
  assert.ok(p.candidates.length>0&&p.candidates.length<=20);assert.ok(b.messages[1].content.length<=48000);
  for(const c of expanded.candidates){assert.ok(c.content.length<=4800);assert.ok(c.content.endsWith('\n'+sourceText));assert.ok(c.references.every(r=>r.lineStart===1&&r.lineEnd===1));}
  if(mode==='HTTP')return new Response('',{status:503});
  if(mode==='length')return event('{}','length');
  if(mode==='empty')return event('');
  if(mode==='invalid')return event('{}');
  const relevance=['missing-evidence','foreign-evidence','recovered-evidence'].includes(mode)?'usable':mode;
  const omitEvidence=mode==='missing-evidence'||(mode==='recovered-evidence'&&expanded.candidates.length>1);
  return event(JSON.stringify({inputHash,decisions:expanded.candidates.map(c=>({candidateId:c.candidateId,relevance,reason:'固定协议测试，不代表语义准确性',
   ...(omitEvidence?{}:{evidenceIds:mode==='foreign-evidence'?['999999']:relevance==='usable'?['1']:[]})}))}));
 });
 const model={complete:async args=>{
  if(args.stage==='library-analysis')return JSON.stringify(analysis);
  if(args.stage==='library-review')return JSON.stringify({rubricVersion:'analysis-review-v2',approved:true,notes:['固定协议测试'],checks:['fact_attribution','inference_strength','evidence_scope','cross_unit_links','text_scope','reader_effect_hypothesis'].map(id=>({id,status:'passed',notes:['固定协议测试'],unitIds:['u']}))});
  assert.equal(args.stage,'library-relevance');assert.equal(args.maxTokens,6000);
  return adapter.complete({...args,onAttempt:a=>stages.push(a.stage)});
 }};
 try{
  ({library}=await loadLibraryService({rootDir,model}));const retrieve=createRetrieveKnowledge(library);
  assert.equal((await retrieve(query)).materials.length,0);assert.equal(calls,0);
  const source=await library.importSource({requestId:'fixture',fileName:'fixture.txt',bytes:Buffer.from(sourceText)});
  for(let i=0;i<300;i++){if(!['running','queued'].includes((await library.get(source.sourceId)).status))break;await new Promise(r=>setTimeout(r,5));}
  assert.equal((await library.get(source.sourceId)).indexStatus,'ready');
  for(const verdict of ['usable','recovered-evidence','irrelevant','insufficient_context',...failedModes]){
   mode=verdict;const before=calls;const result=await retrieve(query);
   const usable=['usable','recovered-evidence'].includes(verdict);
   assert.equal(calls-before,verdict==='recovered-evidence'?3:verdict==='missing-evidence'?2:1,verdict);
   assert.equal(result.relevanceReview.status,failedModes.has(verdict)?'failed':'completed');
   assert.equal(result.status,usable?'matched':verdict==='irrelevant'?'uncovered':'unavailable');
   if(!usable)assert.equal(result.materials.length,0);
   const receipt=await library.getRelevanceReview(result.relevanceReview.receiptId);
   assert.equal(receipt.schemaVersion,'library-relevance-4');assert.equal(receipt.parserVersion,'library-relevance-parser-6');
   if(!failedModes.has(verdict))for(const decision of receipt.decisions)assert.deepEqual(decision.evidenceQuotes,usable?[sourceText]:undefined);
   if(verdict==='foreign-evidence')assert.equal(receipt.validationError.code,'RELEVANCE_EVIDENCE_INVALID');
   assert.equal(receipt.user,bodies[before].messages[1].content);
   if(['missing-evidence','recovered-evidence'].includes(verdict)){
    assert.equal(receipt.recovery.reason,'missing_evidence_ids');
    assert.equal(receipt.recovery.groups.length,usable?2:1);
    for(const [index,group] of receipt.recovery.groups.entries()){
     assert.equal(group.user,bodies[before+index+1].messages[1].content);
     assert.equal(group.inputHash,JSON.parse(group.user).inputHash);
     assert.equal(group.sent.length,1);
     assert.equal(group.status,usable?'validated':'failed');
    }
    if(!usable)assert.deepEqual(receipt.decisions,[]);
   }
   assert.deepEqual(validateRelevanceReview(result.relevanceReview,{status:result.status,candidateCount:result.candidates.length,materialCount:result.materials.length}),result.relevanceReview);
   if(usable){
    assert.equal(receipt.finalMaterialBindings.length,result.materials.length);
    for(const m of result.materials){
     const binding=receipt.finalMaterialBindings.find(b=>b.materialId===m.id);assert.ok(binding);
     assert.equal(binding.contentSha256,createHash('sha256').update(m.content).digest('hex'));
     assert.ok(binding.candidateIds.length>0);
     for(const id of binding.candidateIds){assert.ok(receipt.sent.some(c=>c.candidateId===id));assert.ok(receipt.decisions.some(d=>d.candidateId===id&&d.relevance==='usable'));}
    }
   }
   assert.equal(result.relevanceReview.user,undefined);assert.equal(result.relevanceReview.rawResponse,undefined);
  }
  const before=calls;await retrieve({...query,sourceIds:[]});assert.equal(calls,before);
  // Actual DATA -> CREATION initial packet and followup -> PRODUCT view.
  mode='usable'; const initialBefore=calls;
  const knowledge=await prepareWorkflowKnowledge({request:{kind:'create',idea:'转轴维护',sourceIds:[source.sourceId]},requirements:{summary:'转轴维护'},prepareKnowledge,retrieveKnowledge:retrieve});
  assert.equal(calls-initialBefore,1);assert.equal(knowledge.retrieval.relevanceReview.status,'completed');
  assert.match(relevanceReviewText(knowledge.retrieval.relevanceReview),/已筛选/);
  const legacy=structuredClone(knowledge);delete legacy.retrieval.relevanceReview;
  assert.deepEqual(knowledgeForAuthor(knowledge),knowledgeForAuthor(legacy));
  const saved={};const options={request:{kind:'create'},requestSpec:{inputFingerprint:'fixture',requirements:{summary:'转轴维护'},followupPolicyVersion:'bounded-followup-1',followupPolicy:{mode:'dynamic'}},knowledge,saved,persist:async(k,v)=>{saved[k]=structuredClone(v);},retrieveKnowledge:retrieve};
  const followup=createFollowup(options),need={question:'怎样检查转轴维护动作',reason:'补充检修动作',basis:'insufficient_context',recall:{focus:'scene',queries:[]},target:{chapterNumber:1}},context={plan:{chapters:[{goal:'检查转轴'}]}};
  const followupBefore=calls;await followup.consume('planning',[need],context);assert.equal(calls-followupBefore,1);
  const result={knowledge,activeKnowledge:followup.activeKnowledge(),followupRetrieval:followup.summary()};
  const view=materialView(result);assert.equal(view.invalid,false);
  assert.match(relevanceReviewText(view.slots.find(s=>s.slot==='planning').relevanceReview),/已筛选/);
  assert.equal(followup.view().relevanceReview,undefined);
  const restored=createFollowup({...options,saved:structuredClone(saved),retrieveKnowledge:async()=>assert.fail('No repeated query')});
  await restored.consume('planning',[need],context);assert.deepEqual(restored.summary(),followup.summary());assert.deepEqual(restored.view(),followup.view());
  const disconnected=await prepareWorkflowKnowledge({request:{kind:'create'},requirements:{summary:'转轴'},prepareKnowledge});
  assert.equal(disconnected.retrieval.status,'not_connected');assert.match(relevanceReviewText(disconnected.retrieval.relevanceReview),/未记录适用性筛选/);
  assert.match(relevanceReviewText(undefined),/未记录/);assert.match(relevanceReviewText(null),/不完整或不兼容/);
  assert.ok(stages.length>0);assert.ok(stages.every(s=>s==='library-relevance'));
 }finally{await library?.close();await rm(rootDir,{recursive:true,force:true});}
});
