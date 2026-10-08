import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.mjs';
import { recoveryTextLimit, RECOVERY_BUDGET_VERSION } from './model-policy.mjs';
const config={apiKey:'offline-placeholder',baseURL:'https://example.invalid',model:'deepseek-flash',agentProvider:'deepseek',timeoutMs:2000,idleTimeoutMs:1500};
const args={stage:'planning',maxTokens:6000,system:'original planning contract',user:'original full input'};
const response=(content,finish='stop',reasoning='')=>new Response(`data: ${JSON.stringify({choices:[{delta:{content,reasoning_content:reasoning},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:finish}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
test('recorded empty-thinking stop then 6K length failure uses one larger planning recovery without changing input',async()=>{
 // Reconstruct the recorded outcome/budget pattern, not a successful real-model replay.
 const sent=[],attempts=[];const complete=JSON.stringify({chapters:[{body:'合成方案'.repeat(2000)}]});
 const model=createModel(config,async(_url,init)=>{
  const body=JSON.parse(init.body);sent.push({body,signal:init.signal});
  if(sent.length===1)return response('','stop','omitted reasoning reconstructed for offline outcome replay');
  return body.max_tokens===6000?response(complete.slice(0,6000),'length'):response(complete);
 });
 assert.equal(await model.complete({...args,onAttempt:async a=>attempts.push(a)}),complete);
 assert.equal(sent.length,2);assert.deepEqual(sent.map(x=>x.body.max_tokens),[32768,16000]);
 assert.deepEqual(sent[1].body.thinking,{type:'disabled'});assert.deepEqual(sent[0].body.messages,sent[1].body.messages);assert.equal(sent[0].signal,sent[1].signal);
 assert.equal(attempts[1].recoveryBudgetVersion,RECOVERY_BUDGET_VERSION);
});
test('planning recovery has bounded floor, respects larger requests, and never changes other stages',()=>{
 for(const stage of ['planning','agent:replan']){
  assert.equal(recoveryTextLimit(stage,6000),16000);assert.equal(recoveryTextLimit(stage,20000),20000);assert.equal(recoveryTextLimit(stage,999999),32768);
  assert.throws(()=>recoveryTextLimit(stage,NaN));assert.throws(()=>recoveryTextLimit(stage,0));
 }
 assert.equal(recoveryTextLimit('review',6000),6000);assert.equal(recoveryTextLimit('library-analysis',6000),6000);
});
test('second length remains failure even for valid JSON; never publishes it or sends a third POST',async()=>{
 let calls=0;const attempts=[];const model=createModel(config,async()=>++calls===1?response('','stop','reasoning'):response('{"chapters":[]}','length'));
 await assert.rejects(model.complete({...args,onAttempt:async x=>attempts.push(x)}),/长度上限/);assert.equal(calls,2);assert.equal(attempts[1].maxOutputTokens,16000);
});
test('cancel after persisted primary diagnostics prevents recovery dispatch',async()=>{
 const abort=new AbortController();let calls=0;const model=createModel(config,async()=>{calls++;return response('','stop','reasoning');});
 await assert.rejects(model.complete({...args,signal:abort.signal,onAttempt:async()=>abort.abort(new Error('cancelled before recovery'))}),/cancelled before recovery/);assert.equal(calls,1);
});
test('diagnostic persistence failure never triggers unrecorded recovery',async()=>{
 let calls=0;const model=createModel(config,async()=>{calls++;return response('','stop','reasoning');});
 await assert.rejects(model.complete({...args,onAttempt:async()=>{throw Error('audit persistence failed');}}),/audit persistence failed/);assert.equal(calls,1);
});
