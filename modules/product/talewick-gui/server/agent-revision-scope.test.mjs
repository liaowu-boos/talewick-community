import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { createAIController } from './agent-ai-sdk.mjs';
import { manuscriptFingerprint } from '../../../validation/runtime/checks.mjs';
import { createAdjudicationInput, normalizeAdjudication, adjudicateReview } from '../../../validation/runtime/review-adjudication.mjs';
import { bindRevisionScope, applyBoundedRevision, automaticRevisionScope, BOUNDED_REVISION_POLICY } from '../../../creation/runtime/bounded-revision.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
const original = {id:'ch-1',title:'门口',body:'😀她再次握住门把。\n钥匙已经交给邻居，却又说钥匙还在自己口袋。\n她仍没有推门。'};
const quote = '钥匙还在自己口袋';
const range = {start:original.body.indexOf(quote),end:original.body.indexOf(quote)+quote.length,quote};
const protection = {start:0,end:'😀她再次握住门把。'.length,quote:'😀她再次握住门把。'};
const scope = {bodySha256:sha(original.body),ranges:[range],preserve:[protection]};
function adjudication(chapters, review, decision='confirm') {
 const input=createAdjudicationInput({chapters,review,requirements:{}});
 const item=input.modelInput.issues[0];
 const response={inputHash:input.inputHash,manuscriptSha256:input.manuscriptSha256,sourceReviewSha256:input.sourceReviewSha256,checkedChapterIds:chapters.map(c=>c.id),decisions:[{issueId:item.issueId,issueSha256:item.issueSha256,decision,reason:'离线协议夹具，不代表文学判断',scope:'text_internal',supportingEvidence:[{chapterId:'ch-1',quote,role:'narration',actor:'她',relevance:'道具状态核对'}],counterEvidence:[],alternativeExplanation:{assessment:decision==='confirm'?'ruled_out':'unresolved',reason:'测试绑定'},characterKnowledge:{assessment:'not_applicable',reason:'测试绑定'}}]};
 return normalizeAdjudication(JSON.stringify(response),input);
}
function fixture({withScope=true, suppliedScope=scope, failResponse=false, failTransport=false, decision='confirm', correction, policy, observations=[]}={}) {
 const chapters=[structuredClone(original)];
 const review={manuscriptSha256:manuscriptFingerprint(chapters),issues:[{chapterId:'ch-1',severity:'must_fix',quote,explanation:'核对前后钥匙状态',evidenceVerified:true}],readingObservations:observations};
 let journal; let calls=0;let forwarded;let schemaSeen=false;let hashSeen=false;let fail=failResponse;let transport=failTransport;let steps=0;
 const effects=new Map();
 const model=new MockLanguageModelV4({provider:'offline-scope',modelId:'explicit-test',doGenerate:async options=>{
  steps++;
  const advertised=options.tools.find(t=>t.name==='revise_chapter');
  if(advertised){assert.ok(advertised.inputSchema.properties.revisionScope);assert.equal(advertised.inputSchema.required.includes('revisionScope'),false);schemaSeen=true;}
  const read=options.prompt.filter(m=>m.role==='tool').flatMap(m=>m.content).find(p=>p.toolName==='read_chapter');
  if(read){assert.equal(read.output.value.bodySha256,sha(original.body));hashSeen=true;}
  const trace=journal?.trace.map(t=>t.action)??[];
  const rejected=journal?.rejections?.length;
  if (rejected && calls === 0) {
    assert.equal(journal.pending, null, 'bad parameters must not leave a pending intent');
    assert.equal(journal.state.chapters[0].body, original.body);
    assert.equal(journal.trace.some(t=>t.action==='revise_chapter'), false);
  }
  let name=!trace.includes('read_chapter')?'read_chapter':!trace.includes('revise_chapter')&&(!rejected||correction)?'revise_chapter':journal.state.dirty?'review_manuscript':'finish_review';
  const input={reason:'离线调度，仅验证工程通路',...(['read_chapter','revise_chapter'].includes(name)?{chapterId:'ch-1'}:{}),...(name==='revise_chapter'?{issueIndexes:[0],...(rejected&&correction==='omit'?{}:withScope?{revisionScope:rejected&&correction==='correct'?scope:suppliedScope}:{})}:{})};
  return {content:[{type:'tool-call',toolCallId:`scope-${steps}`,toolName:name,input:JSON.stringify(input)}],finishReason:{unified:'tool-calls',raw:'tool_calls'},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}},warnings:[]};
 }});
 const context={...(policy?{boundedRevisionPolicyVersion:policy}:{}),input:{},requirements:{},chapters,review,reviewAdjudication:adjudication(chapters,review,decision),
  loadState:()=>structuredClone(journal),saveState:async(_k,v)=>{journal=structuredClone(v);},
  step:async(k,fn)=>{if(effects.has(k))return structuredClone(effects.get(k));const v=await fn();effects.set(k,structuredClone(v));return v;},
  reviseChapter:async args=>{calls++;forwarded=structuredClone(args);const bound=args.revisionScope??{bodySha256:sha(args.chapters[0].body),ranges:[range]};bindRevisionScope(args.chapters[0],args.issues,bound);if(transport)throw Error('mock transport interrupted after request');return applyBoundedRevision(args.chapters[0],args.issues,bound,{replacements:[{...bound.ranges[0],...(fail?{end:bound.ranges[0].end+1}:{}),replacement:bound.ranges[0].quote.replace(quote,'钥匙已经不在自己口袋')}]});},
  reviewManuscript:async next=>({manuscriptSha256:manuscriptFingerprint(next),issues:[]}),
  adjudicateReview:async(chapters,review)=>adjudicateReview({input:createAdjudicationInput({chapters,review,requirements:{}})}),
 };
 const controller=createAIController({config:{agentProvider:'openai-compatible'},agentModel:model});
 return {run:()=>controller.review(context),get state(){return journal;},get calls(){return calls;},get forwarded(){return forwarded;},get schemaSeen(){return schemaSeen;},get hashSeen(){return hashSeen;},recover:()=>{fail=false;transport=false;}};
}
test('real SDK exposes optional scope and forwards exact UTF16 ranges/preserve through authorized tool',async()=>{
 const f=fixture();const result=await f.run();assert(f.schemaSeen&&f.hashSeen);assert.equal(f.calls,1);assert.deepEqual(f.forwarded.revisionScope,scope);
 assert.equal(result.chapters[0].body,original.body.slice(0,range.start)+'钥匙已经不在自己口袋'+original.body.slice(range.end));
 assert.equal(result.chapters[0].body.slice(0,protection.end),protection.quote);
 assert.deepEqual(result.trace.map(t=>t.action),['read_chapter','revise_chapter','review_manuscript','finish_review']);
});
test('legacy SDK call without scope stays absent so workflow can derive default bounds',async()=>{
 const f=fixture({withScope:false});await f.run();assert.equal(f.calls,1);assert.equal(Object.hasOwn(f.forwarded,'revisionScope'),false);
});
test('scope cannot authorize an independently uncertain issue',async()=>{
 const f=fixture({decision:'uncertain'});const result=await f.run();assert.equal(f.calls,0);assert.equal(result.chapters[0].body,original.body);assert(f.state.rejections.some(x=>x.action==='revise_chapter'));
});
test('stale explicit scope is rejected before business call and may remain unresolved',async()=>{
 const f=fixture({suppliedScope:{...scope,bodySha256:'0'.repeat(64)}});const result=await f.run();
 assert.equal(f.calls,0);assert.equal(result.chapters[0].body,original.body);assert.equal(f.state.pending,null);
 assert.equal(f.state.rejections.length,1);assert.match(f.state.rejections[0].reason,/显式修订范围/);
 assert.equal(f.state.trace.some(t=>t.action==='revise_chapter'),false);
});
for (const correction of ['omit','correct']) test(`stale scope rejection then ${correction} in same SDK run revises once and rereads`,async()=>{
 const f=fixture({suppliedScope:{...scope,bodySha256:'0'.repeat(64)},correction});const result=await f.run();
 assert.equal(f.calls,1);assert.equal(f.state.rejections.length,1);assert.equal(f.state.pending,null);
 assert.deepEqual(result.trace.map(t=>t.action),['read_chapter','revise_chapter','review_manuscript','finish_review']);
 if(correction==='omit')assert.equal(Object.hasOwn(f.forwarded,'revisionScope'),false);
 else assert.deepEqual(f.forwarded.revisionScope,scope);
});
for (const [label,invalid] of [
 ['quote mismatch',{...scope,ranges:[{...range,quote:'不存在的原句'}]}],
 ['protected overlap',{...scope,preserve:[range]}],
 ['overlapping ranges',{...scope,ranges:[range,range]}],
]) test(`${label} is rejected before pending or revision model call`,async()=>{
 const f=fixture({suppliedScope:invalid});await f.run();assert.equal(f.calls,0);assert.equal(f.state.pending,null);assert.equal(f.state.rejections.length,1);assert.equal(f.state.state.chapters[0].body,original.body);
});
test('out-of-bound response retains original and exact pending intent; resume reuses scope then rereads',async()=>{
 const f=fixture({failResponse:true});await assert.rejects(f.run());assert.equal(f.state.state.chapters[0].body,original.body);assert.deepEqual(f.state.pending.input.revisionScope,scope);assert.equal(f.state.state.done,false);
 f.recover();const result=await f.run();assert.equal(f.calls,2);assert.equal(f.state.pending,null);assert.equal(result.trace.filter(t=>t.action==='revise_chapter').length,1);assert(result.trace.some(t=>t.action==='review_manuscript'));
});

test('transport failure after revision starts keeps pending and requires explicit resume plus reread',async()=>{
 const f=fixture({failTransport:true});await assert.rejects(f.run());
 assert.equal(f.calls,1);assert.deepEqual(f.state.pending.input.revisionScope,scope);assert.equal(f.state.state.chapters[0].body,original.body);assert.equal(f.state.state.done,false);assert.equal(f.state.rejections,undefined);
 f.recover();const result=await f.run();assert.equal(f.calls,2);assert.equal(f.state.pending,null);assert.equal(result.trace.filter(t=>t.action==='revise_chapter').length,1);assert(result.trace.some(t=>t.action==='review_manuscript'));
});

test('new policy derives and freezes omitted scope before execution, preserving exact repeated action',async()=>{
 const observations=[{evidenceVerified:true,revisionScope:{scopeVerified:true,chapterIds:['ch-1'],preserve:[protection.quote]}}];
 const f=fixture({withScope:false,policy:BOUNDED_REVISION_POLICY,observations});const result=await f.run();
 const expected=automaticRevisionScope(original,[{chapterId:'ch-1',quote}],observations);
 assert.deepEqual(f.forwarded.revisionScope,expected);assert.deepEqual(expected.preserve,[protection]);assert.equal(f.calls,1);assert.equal(f.state.pending,null);
 assert.equal(result.chapters[0].body.slice(0,protection.end),protection.quote);
 assert(result.trace.some(t=>t.action==='review_manuscript'));
});
test('new policy automatic protection conflict rejects before dispatch with no full-chapter fallback',async()=>{
 const f=fixture({withScope:false,policy:BOUNDED_REVISION_POLICY,observations:[{evidenceVerified:true,revisionScope:{scopeVerified:true,chapterIds:['ch-1'],preserve:[quote]}}]});
 const result=await f.run();assert.equal(f.calls,0);assert.equal(f.state.pending,null);assert.equal(f.state.rejections.length,1);assert.equal(result.chapters[0].body,original.body);
});

test('derived automatic scope is persisted exactly for response failure and resume',async()=>{
 const f=fixture({withScope:false,policy:BOUNDED_REVISION_POLICY,failResponse:true});await assert.rejects(f.run());
 const frozen=structuredClone(f.state.pending.input.revisionScope);assert.deepEqual(frozen,automaticRevisionScope(original,[{chapterId:'ch-1',quote}]));assert.equal(f.state.state.chapters[0].body,original.body);
 f.recover();await f.run();assert.deepEqual(f.forwarded.revisionScope,frozen);assert.equal(f.calls,2);assert.equal(f.state.pending,null);
});
test('explicit scope expanded into an unrelated preceding paragraph is rejected before pending',async()=>{
 const expanded={bodySha256:sha(original.body),ranges:[{start:0,end:range.end,quote:original.body.slice(0,range.end)}],preserve:[]};
 const f=fixture({suppliedScope:expanded});const result=await f.run();
 assert.equal(f.calls,0);assert.equal(f.state.pending,null);assert.equal(f.state.rejections.length,1);assert.equal(result.chapters[0].body,original.body);
});
