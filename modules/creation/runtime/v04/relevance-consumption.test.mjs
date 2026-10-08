import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateRetrieval,validateRelevanceSummary,knowledgeForAuthor} from './knowledge.mjs';
import {createFollowup,followupHash} from './followup.mjs';
import {runWorkflow} from '../workflow.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const summary={receiptId:'11111111-1111-4111-8111-111111111111',inputHash:'a'.repeat(64),status:'completed',sentCount:1,notReviewedCount:0,usableCount:1,irrelevantCount:0,insufficientContextCount:0};
const query={contractVersion:'v04-contract-1',evidenceType:'narrative',query:'旧物动作',stage:'planning',budget:{maxCandidates:20,maxUnits:6,maxChars:12000}};
const material={id:'raw',title:'原文',kind:'retrieved',use:'raw_reference',content:'归还旧物。',sha256:hash('归还旧物。'),references:[{sourceId:'s',sourceSha256:hash('source'),textVersion:'t',analysisVersion:'a',lineStart:1,lineEnd:1,unitIds:[]}],selectionReason:'固定测试',limitations:['原文参考']};
const packet=(q=query)=>({contractVersion:'v04-contract-1',packetId:'p',query:q,status:'matched',materials:[structuredClone(material)],candidates:[{id:'candidate',sourceId:'s',reason:'固定'}],usedChars:material.content.length,limits:[],relevanceReview:structuredClone(summary)});
test('optional summary strict validation preserves legacy and never promotes raw evidence',()=>{
 const legacy=packet();delete legacy.relevanceReview;assert.deepEqual(validateRetrieval(legacy,query),legacy);assert.equal(validateRelevanceSummary(legacy),undefined);
 const actual=validateRetrieval(packet(),query);assert.deepEqual(actual.relevanceReview,summary);assert.equal(actual.materials[0].use,'raw_reference');assert.equal(actual.materials[0].evidence_status,undefined);
 for(const value of [null,[],{...summary,status:'future'},{...summary,inputHash:null},{...summary,usableCount:0},{...summary,extra:true}])assert.throws(()=>validateRetrieval({...packet(),relevanceReview:value},query));
 const failed={...packet(),status:'unavailable',materials:[],usedChars:0,relevanceReview:{...summary,status:'failed',usableCount:0}};assert.doesNotThrow(()=>validateRetrieval(failed,query));assert.throws(()=>validateRetrieval({...failed,relevanceReview:{...failed.relevanceReview,usableCount:1}},query));
});
test('author whitelist and actual serialized input unchanged by summary',()=>{
 const k={materials:[material],style:null,limits:[],retrieval:packet()},legacy=structuredClone(k);delete legacy.retrieval.relevanceReview;
 assert.deepEqual(knowledgeForAuthor(k),knowledgeForAuthor(legacy));assert.equal(Object.hasOwn(knowledgeForAuthor(k),'relevanceReview'),false);
});
for(const slot of ['planning','review'])test(`${slot} slot preserves/projections validated summary and restores with zero queries`,async()=>{
 const saved={},request={kind:'create'},requestSpec={inputFingerprint:'i',requirements:{summary:'旧物'},followupPolicyVersion:'bounded-followup-1',followupPolicy:{mode:'dynamic'}},knowledge={materials:[],style:null,limits:[]};
 const issue={chapterId:'ch-1',quote:'旧物',severity:'must_fix',evidenceVerified:true};const context=slot==='planning'?{plan:{chapters:[{goal:'归还'}]}}:{chapters:[{id:'ch-1',body:'旧物'}],issues:[issue],consumerIssues:[issue],chapterId:'ch-1'};
 const need={question:'如何归还旧物',reason:'需要原文动作',basis:'insufficient_context',recall:{focus:'scene',queries:[]},target:slot==='planning'?{chapterNumber:1}:{chapterId:'ch-1',quote:'旧物'}};
 let queries=0;const options={request,requestSpec,knowledge,saved,persist:async(k,v)=>{saved[k]=structuredClone(v);},retrieveKnowledge:async q=>{queries++;return packet(q);}};
 const f=createFollowup(options);await f.consume(slot,[need],context);assert.equal(queries,1);assert.deepEqual(f.summary().slots.find(x=>x.slot===slot).relevanceReview,summary);const view=f.view();assert.equal(view.materials[0].use,'raw_reference');assert.equal(view.relevanceReview,undefined);
 const restored=createFollowup({...options,saved:structuredClone(saved),retrieveKnowledge:async()=>assert.fail('No requery')});await restored.consume(slot,[need],context);assert.deepEqual(restored.view(),view);assert.deepEqual(restored.summary(),f.summary());
 const corrupt=structuredClone(saved),commit=corrupt[`followup:${slot}:commit`];commit.value.result.relevanceReview=null;commit.valueHash=followupHash(commit.value);assert.throws(()=>createFollowup({...options,saved:corrupt}));
});
test('saved K0 rejects null/invalid summary before any model or query; legacy remains restorable',async()=>{
 const request={kind:'create',idea:'旧物故事'},saved={},stop=Error('stop');
 const requirements=JSON.stringify({summary:'旧物',targetHanMin:100,targetHanMax:500,targetChapterCount:2});
 await assert.rejects(runWorkflow({request,model:{complete:async a=>{assert.equal(a.stage,'requirements');return requirements;}},retrieveKnowledge:async q=>packet(q),checkpoint:async(k,v)=>{saved[k]=structuredClone(v);if(k==='knowledge')throw stop;}}),e=>e===stop);
 for(const value of [null,{...summary,status:'unknown'},{...summary,status:'failed',inputHash:null}]){const a=structuredClone(saved);a.knowledge.retrieval.relevanceReview=value;let calls=0,queries=0;await assert.rejects(runWorkflow({request,artifacts:a,model:{complete:async()=>{calls++;throw stop;}},retrieveKnowledge:async()=>{queries++;throw stop;}}));assert.equal(calls,0);assert.equal(queries,0);}
 for(const legacy of [false,true]){const a=structuredClone(saved);if(legacy)delete a.knowledge.retrieval.relevanceReview;const original=JSON.stringify(a.knowledge);let queries=0;await assert.rejects(runWorkflow({request,artifacts:a,model:{complete:async args=>{assert.equal(args.stage,'planning');throw stop;}},retrieveKnowledge:async()=>{queries++;throw stop;}}),e=>e===stop);assert.equal(queries,0);assert.equal(JSON.stringify(a.knowledge),original);}
});
