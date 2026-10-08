import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.mjs';
import { isBusinessStage, isLibraryStage, outputTokenLimit } from './model-policy.mjs';
const config = { baseURL:'https://api.deepseek.com',apiKey:'explicit-test-placeholder',model:'deepseek-v4-flash',timeoutMs:1000,idleTimeoutMs:1000 };
const chunk=(delta,finish_reason=null)=>`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`;
for (const modelName of ['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp','deepseek-v4-pro'])
for (const stage of ['library-analysis','library-analysis-revision','library-review']) {
  test(`${modelName}/${stage}: bounded JSON model request, no automatic replay on truncation`,async()=>{
    let calls=0;
    const model=createModel({...config,model:modelName},async(_url,options)=>{
      calls++; const body=JSON.parse(options.body);
      assert.deepEqual(body.response_format,{type:'json_object'});
      assert.equal(body.max_tokens,12000);
      assert.deepEqual(body.thinking,{type:'disabled'});
      return new Response(chunk({reasoning_content:'test reasoning'})+chunk({content:'{"partial":'})+chunk({},'length')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    });
    await assert.rejects(model.complete({stage,system:'JSON',user:'explicit test',maxTokens:12000}),/长度上限/);
    assert.equal(calls,1);assert.equal(isBusinessStage(stage),false);assert.equal(isLibraryStage(stage),true);
    assert.equal(outputTokenLimit({...config,model:modelName},100000,stage),16000);
  });
}

test('library review uses its own JSON budget and returns a complete response in one request',async()=>{
 let calls=0;const attempts=[];
 const model=createModel(config,async(_url,options)=>{
  calls++;const body=JSON.parse(options.body);
  assert.equal(body.max_tokens,2000);assert.deepEqual(body.thinking,{type:'disabled'});
  return new Response(chunk({content:'{"approved":false,"notes":["证据不足"]}'})+chunk({},'stop')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 });
 const response=await model.complete({stage:'library-review',system:'JSON',user:'fixture',maxTokens:2000,onAttempt:a=>attempts.push(a)});
 assert.equal(JSON.parse(response).approved,false);assert.equal(calls,1);assert.equal(attempts[0].mode,'primary');
});

test('library-specific thinking policy does not alter other providers or business stages',async()=>{
 for(const current of [{...config,baseURL:'https://example.invalid',agentProvider:'openai-compatible'}, {...config,model:'other-model'}]){
  const model=createModel(current,async(_url,options)=>{
   assert.equal(JSON.parse(options.body).thinking,undefined);
   return Response.json({choices:[{message:{content:'{}'},finish_reason:'stop'}]});
  });
  await model.complete({stage:'library-analysis',system:'JSON',user:'fixture',maxTokens:12000});
 }
 const model=createModel(config,async(_url,options)=>{
  const body=JSON.parse(options.body);assert.equal(body.thinking,undefined);assert.equal(body.max_tokens,32768);
  return new Response(chunk({content:'{}'})+chunk({},'stop')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 });
 await model.complete({stage:'planning',system:'JSON',user:'fixture'});
});
