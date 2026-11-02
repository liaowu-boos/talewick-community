import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.mjs';
import { WHOLE_QUALITY_MODEL_POLICY, isWholeQualityStage } from './model-policy.mjs';
import { classifyTaskFailure } from './task-failure.mjs';

const stages = ['component-applicability','plan-facts:initial','plan-correction','plan-facts:recheck','scene-check']
  .flatMap(name => [`whole-quality:${name}`, `whole-quality:${name}:format-repair`]);
const config = { baseURL:'http://127.0.0.1:1', agentProvider:'deepseek', apiKey:'offline-fixture', model:'deepseek-v4-pro', timeoutMs:3000, idleTimeoutMs:2500 };
const response = finish => new Response(`data: ${JSON.stringify({ id:'offline-receipt', choices:[{index:0,delta:{content:'{"fixture":true}'},finish_reason:null}] })}\n\n`
  + `data: ${JSON.stringify({ choices:[{index:0,delta:{},finish_reason:finish}] })}\n\ndata: [DONE]\n\n`, {headers:{'Content-Type':'text/event-stream'}});

test('new concrete stages use the existing JSON/low budget and receipts with no automatic transport re-dispatch', async () => {
  for (const stage of stages) {
    const sent = [], receipts = [], attempts = [];
    assert.equal(isWholeQualityStage(stage),true);
    const model = createModel(config, async (_url,init) => { sent.push(JSON.parse(init.body)); return response('stop'); });
    assert.equal(await model.complete({ stage, modelPolicy:WHOLE_QUALITY_MODEL_POLICY, system:'Offline fixed instruction', user:'{"fixture":true}', maxTokens:18000,
      allowRecovery:false, onReceipt:r=>receipts.push(r), onAttempt:a=>attempts.push(a) }), '{"fixture":true}');
    assert.equal(sent.length,1); assert.deepEqual(sent[0].response_format,{type:'json_object'});
    assert.equal(sent[0].reasoning_effort,'low'); assert.equal(sent[0].max_tokens,65536);
    assert.equal(receipts.length,1); assert.ok(attempts.length>0);
    let failures = 0;
    const truncated = createModel(config, async () => { failures++; return response('length'); });
    await assert.rejects(truncated.complete({stage,modelPolicy:WHOLE_QUALITY_MODEL_POLICY,system:'offline',user:'{}',maxTokens:18000,allowRecovery:false}),/长度上限/);
    assert.equal(failures,1,'format handling remains owned by the bounded CREATION stage');
  }
  assert.equal(isWholeQualityStage('whole-quality:plan-facts:retry-again'),false);
});

test('one bounded plan correction exhausted remains non-resumable and does not claim a content pass', () => {
  const value = classifyTaskFailure({ code:'WHOLE_QUALITY_PLAN_FACTS_UNVERIFIED', recoverable:false },'whole-quality:plan-facts:recheck');
  assert.equal(value.recoverable,false); assert.equal(value.kind,'review_output');
  assert.match(value.message,/问题或未核实/); assert.match(value.message,/不会再次抽取判断/);
});
