import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createModel } from './model.mjs';
import { outputTokenLimit, isLibraryStage } from './model-policy.mjs';
import { loadLibraryService } from './library.mjs';
const config={baseURL:'https://example.invalid',agentProvider:'deepseek',apiKey:'synthetic-placeholder',model:'deepseek-flash',timeoutMs:1000};
const chunk=(delta,finish=null)=>`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
const sse=(content,finish='stop')=>new Response(chunk({content,reasoning_content:'synthetic-private-reasoning'},finish)+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
const ssePlain=(content,finish='stop')=>new Response(chunk({content},finish)+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function blocked(){let controller,cancelled=false;const response=new Response(new ReadableStream({start(c){controller=c;},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});return{response,send:text=>controller.enqueue(new TextEncoder().encode(text)),get cancelled(){return cancelled;}};}
const input={stage:'library-relevance',system:'JSON synthetic system',user:'synthetic full user',maxTokens:6000};
for(const modelName of ['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp','deepseek-v4-pro','deepseek-chat'])
 for(const provider of ['deepseek','openai-compatible']) test(`${provider}/${modelName} relevance: exact thinking policy, JSON, bounded total and one attempt`,async()=>{
 const nativeThinking=provider==='deepseek'&&modelName!=='deepseek-chat',budget=nativeThinking?32768:6000;
 const current={...config,model:modelName,agentProvider:provider};let calls=0; const attempts=[];
 const model=createModel(current,async(url,init)=>{
  calls++;assert.equal(url,'https://example.invalid/chat/completions'); const body=JSON.parse(init.body);
  assert.equal(body.max_tokens,budget);assert.deepEqual(body.response_format,{type:'json_object'});
  assert.deepEqual(body.messages,[{role:'system',content:input.system},{role:'user',content:input.user}]);
  assert.equal(body.stream,nativeThinking);assert.deepEqual(body.thinking,nativeThinking?{type:'enabled'}:undefined);
  assert.equal(body.reasoning_effort,provider==='deepseek'?'low':undefined);assert.equal(body.tools,undefined);
  return nativeThinking?sse('{}'):Response.json({choices:[{message:{content:'{}'},finish_reason:'stop'}]});
 });
 assert.equal(await model.complete({...input,onAttempt:a=>attempts.push(a)}),'{}');assert.equal(calls,1);
 assert.equal(attempts.length,1);assert.equal(attempts[0].stage,'library-relevance');assert.equal(attempts[0].attempt,1);
 assert.equal(attempts[0].mode,'primary');assert.equal(attempts[0].maxOutputTokens,budget);
 assert.doesNotMatch(JSON.stringify(attempts),/synthetic/);
 for(const requested of [6000,12000,100000])assert.equal(outputTokenLimit(current,requested,'library-relevance'),budget);
 assert.equal(isLibraryStage('library-relevance'),true);
});
test('official-host provider inference applies the same relevance policy',async()=>{
 let calls=0;const model=createModel({...config,agentProvider:undefined,baseURL:'https://api.deepseek.com'},async(_url,init)=>{
  calls++;const body=JSON.parse(init.body);assert.equal(body.max_tokens,32768);assert.deepEqual(body.thinking,{type:'enabled'});return sse('{}');
 });
 assert.equal(await model.complete(input),'{}');assert.equal(calls,1);
});
for(const [name,response,message] of [
 ['reasoning only',()=>sse(''),/没有返回正文/],
 ['whitespace only',()=>sse('  \n'),/没有返回正文/],
 ['HTTP',()=>new Response('',{status:503}),/HTTP 503/],
 ['network',()=>{throw Error('synthetic');},/无法连接/],
 ['invalid JSON transport',()=>new Response('invalid',{headers:{'content-type':'application/json'}}),/无法识别/],
])test(`thinking relevance ${name} never downgrades or retries`,async()=>{
 let calls=0;const attempts=[];const model=createModel(config,async(_url,init)=>{
  calls++;const body=JSON.parse(init.body);assert.equal(body.max_tokens,32768);assert.deepEqual(body.thinking,{type:'enabled'});return response();
 });
 await assert.rejects(model.complete({...input,onAttempt:a=>attempts.push(a)}),message);assert.equal(calls,1);
 assert.ok(attempts.every(a=>a.attempt===1&&a.mode==='primary'&&a.maxOutputTokens===32768));
 assert.doesNotMatch(JSON.stringify(attempts),/synthetic|partial/);
});
for(const firstContent of ['{"partial":','{}'])test(`thinking relevance length recovers complete original input once, even when first content is ${firstContent==='{}'?'valid':'partial'} JSON`,async()=>{
 const sent=[],attempts=[];const model=createModel(config,async(_url,init)=>{
  sent.push(init);return sent.length===1?sse(firstContent,'length'):ssePlain('{"complete":true}');
 });
 assert.equal(await model.complete({...input,onAttempt:a=>attempts.push(a)}),'{"complete":true}');
 assert.equal(sent.length,2);assert.equal(sent[0].signal,sent[1].signal);
 const first=JSON.parse(sent[0].body),second=JSON.parse(sent[1].body);
 assert.equal(first.max_tokens,32768);assert.deepEqual(first.thinking,{type:'enabled'});
 assert.equal(second.max_tokens,6000);assert.deepEqual(second.thinking,{type:'disabled'});
 assert.deepEqual(second.messages,first.messages);assert.deepEqual(second.response_format,first.response_format);assert.equal(second.stream,true);
 assert.deepEqual(attempts.map(a=>[a.attempt,a.mode,a.finishReason,a.maxOutputTokens]),[[1,'primary','length',32768],[2,'recovery','stop',6000]]);
});
test('thinking relevance second length fails after two calls, without accepting either JSON fragment',async()=>{
 let calls=0;const attempts=[];const model=createModel(config,async()=>++calls===1?sse('{"partial":','length'):ssePlain('{}','length'));
 await assert.rejects(model.complete({...input,onAttempt:a=>attempts.push(a)}),/长度上限/);
 assert.equal(calls,2);assert.deepEqual(attempts.map(a=>a.finishReason),['length','length']);
});
test('thinking relevance length without reasoning does not recover',async()=>{
 let calls=0;const model=createModel(config,async()=>{calls++;return ssePlain('{"partial":','length');});
 await assert.rejects(model.complete(input),/长度上限/);assert.equal(calls,1);
});
test('relevance recovery shares the original total deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const first=blocked(),second=blocked(),signals=[];let calls=0;
 const result=createModel({...config,timeoutMs:100,idleTimeoutMs:80},async(_url,init)=>{
  calls++;signals.push(init.signal);return calls===1?first.response:second.response;
 }).complete(input);
 const rejected=assert.rejects(result,/已达到本步骤等待上限/);await settle();
 first.send(chunk({reasoning_content:'synthetic-private-reasoning'}));await settle();
 t.mock.timers.tick(70);first.send(chunk({content:'{"partial":'})+chunk({},'length')+'data: [DONE]\n\n');await settle();
 assert.equal(calls,2);assert.equal(signals[0],signals[1]);
 t.mock.timers.tick(31);await rejected;assert.equal(calls,2);assert.equal(second.cancelled,true);
});
test('caller cancellation during relevance recovery stops the second read',async()=>{
 const second=blocked(),caller=new AbortController(),reason=new Error('cancelled by test');let calls=0;
 const result=createModel(config,async()=>++calls===1?sse('{"partial":','length'):second.response).complete({...input,signal:caller.signal});
 const rejected=assert.rejects(result,error=>error===reason);await settle();assert.equal(calls,2);
 caller.abort(reason);await rejected;assert.equal(second.cancelled,true);assert.equal(calls,2);
});
test('cancelled relevance makes no request',async()=>{
 let calls=0;const model=createModel(config,async()=>{calls++;return sse('{}');});const c=new AbortController();c.abort();
 await assert.rejects(model.complete({...input,signal:c.signal}),{name:'AbortError'});assert.equal(calls,0);
});
for(const mode of ['idle','total','cancel'])test(`thinking relevance ${mode} deadline/cancellation never retries`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let controller,cancelled=false,calls=0;
 const response=new Response(new ReadableStream({start(c){controller=c;},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
 const caller=new AbortController();const attempts=[];
 const result=createModel({...config,timeoutMs:100,idleTimeoutMs:40},async(_url,init)=>{
  calls++;const body=JSON.parse(init.body);assert.equal(body.max_tokens,32768);assert.deepEqual(body.thinking,{type:'enabled'});return response;
 }).complete({...input,signal:caller.signal,onAttempt:a=>attempts.push(a)});
 const rejected=assert.rejects(result,mode==='idle'?/长时间未收到生成进展/:mode==='total'?/已达到本步骤等待上限/:{name:'AbortError'});
 const settle=()=>new Promise(resolve=>setImmediate(resolve));await settle();
 const send=text=>controller.enqueue(new TextEncoder().encode(text));
 if(mode==='total'){
  for(let i=0;i<3;i++){t.mock.timers.tick(30);send(chunk({reasoning_content:'synthetic-private-reasoning'}));await settle();}
  t.mock.timers.tick(11);
 }else if(mode==='idle'){
  t.mock.timers.tick(30);send(': keep-alive\n\n'+chunk({content:'',reasoning_content:''}));await settle();t.mock.timers.tick(11);
 }else caller.abort();
 await rejected;assert.equal(calls,1);assert.equal(cancelled,true);assert.deepEqual(attempts,[]);
});
test('normal loader requires and injects the DATA factory, with no missing-capability fallback',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'relevance-loader-'));const moduleURL=pathToFileURL(join(dir,'library.mjs'));
 try{
  const methods=['importSource','list','get','readSource','retry','cancel','retrieve','close'];
  await writeFile(moduleURL,`export function createLibraryService(options){return {options,${methods.map(x=>`${x}(){}`).join(',')}}}`);
  await assert.rejects(loadLibraryService({moduleURL,rootDir:dir,model:{complete(){}}}),{code:'ERR_MODULE_NOT_FOUND'});
  const relevanceModuleURL=pathToFileURL(join(dir,'factory.mjs'));
  await writeFile(relevanceModuleURL,`export function createRelevanceAssessor({model}){return ({system,user},{signal}={})=>model.complete({stage:'library-relevance',system,user,maxTokens:6000,signal});}`);
  const calls=[];const model={complete:async x=>{calls.push(x);return '{}';}};const {library}=await loadLibraryService({moduleURL,relevanceModuleURL,rootDir:dir,model});
  const c=new AbortController();assert.equal(await library.options.assessRelevance({system:'JSON',user:'whole input'},{signal:c.signal}),'{}');
  assert.deepEqual(calls,[{stage:'library-relevance',system:'JSON',user:'whole input',maxTokens:6000,signal:c.signal}]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
