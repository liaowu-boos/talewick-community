import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateText } from 'ai';
import { createModel } from './model.mjs';
import { createAgentModel, createAIController } from './agent-ai-sdk.mjs';
import { createRuntime } from './index.mjs';
import { FOLLOWUP_CONTINUITY_MODEL_POLICY, WHOLE_QUALITY_MODEL_POLICY, NATIVE_DEEPSEEK_REASONING_POLICY, withNativeDeepSeekReasoningDefault } from './model-policy.mjs';
import fixture from '../scripts/native-policy-fixture.cjs';

async function transport(t) {
  let baseURL = process.env.TALEWICK_POLICY_SIMULATION_URL;
  if (baseURL) assert.match(baseURL, /^http:\/\/127\.0\.0\.1:\d+\/deepseek$/, 'Only a local mock may receive these requests');
  else {
    const server = http.createServer(fixture);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    baseURL = `http://127.0.0.1:${server.address().port}/deepseek`;
  }
  const sent = [];
  const fetch = async (url, init) => {
    assert.equal(String(url), `${baseURL}/chat/completions`, 'External calls are forbidden');
    const body = JSON.parse(init.body); sent.push(body);
    return globalThis.fetch(url, init);
  };
  return { sent, fetch, config: { baseURL, apiKey: 'local-synthetic-key', model: 'deepseek-flash', agentProvider: 'deepseek', timeoutMs: 10000, idleTimeoutMs: 10000, engine: 'ai-sdk' } };
}
const input = stage => ({ stage, system: 'Synthetic HTTP request-body test.', user: '{"fixture":true}', maxTokens: 6000 });

test('real plain HTTP defaults business and library relevance to low while retaining special-stage settings', async t => {
  const { config, sent, fetch } = await transport(t), model = createModel(config, fetch);
  for (const stage of ['requirements', 'planning', 'draft:ch-1', 'material-evidence', 'library-relevance']) {
    assert.equal(await model.complete(input(stage)), '{"ok":true}');
    const body = sent.at(-1);
    assert.equal(body.reasoning_effort, 'low', stage);
    assert.equal(body.model, 'deepseek-flash'); assert.equal(body.max_tokens, 32768);
    assert.deepEqual(body.messages, [{ role: 'system', content: input(stage).system }, { role: 'user', content: input(stage).user }]);
  }
  for (const [stage, modelPolicy, thinking, effort, tokens] of [
    ['library-analysis', undefined, 'disabled', undefined, 6000],
    ['full15-check', undefined, 'enabled', 'low', 65536],
    ['continuity-chain-review', FOLLOWUP_CONTINUITY_MODEL_POLICY, 'enabled', 'low', 65536],
    ['whole-quality:cross-chapter:extract', WHOLE_QUALITY_MODEL_POLICY, 'enabled', 'low', 32768],
    ['whole-quality:cross-chapter:extract:format-repair', WHOLE_QUALITY_MODEL_POLICY, 'disabled', undefined, 32768],
    ['whole-quality:cross-chapter:adjudicate:format-repair', WHOLE_QUALITY_MODEL_POLICY, 'disabled', undefined, 32768],
  ]) {
    await model.complete({ ...input(stage), modelPolicy });
    const body = sent.at(-1);
    assert.deepEqual(body.thinking, { type: thinking }, stage);
    assert.equal(body.reasoning_effort, effort, stage); assert.equal(body.max_tokens, tokens, stage);
  }
  assert.equal(sent.length, 11, 'one HTTP request per successful stage');
});

test('existing length recovery stays disabled with the same original input and one recovery', async t => {
  const { config, sent, fetch } = await transport(t);
  assert.equal(await createModel(config, fetch).complete({ ...input('planning'), user: 'RECOVERY_FIXTURE' }), '{"ok":true}');
  assert.equal(sent.length, 2); assert.equal(sent[0].reasoning_effort, 'low');
  assert.deepEqual(sent[1].thinking, { type: 'disabled' }); assert.equal(sent[1].reasoning_effort, undefined);
  assert.deepEqual(sent[1].messages, sent[0].messages); assert.equal(sent[0].max_tokens, 32768); assert.equal(sent[1].max_tokens, 16000);
});

test('real tool controller request uses low and a completed checkpoint without policy metadata stays readable', async t => {
  const { config, sent, fetch } = await transport(t);
  const controller = createAIController({ config, agentModel: createAgentModel(config, fetch) });
  let journal;
  const ctx = { input: {}, requirements: {}, plan: { title: 'Synthetic plan', chapters: [] }, knowledge: {},
    loadState: () => journal, saveState: async (_key, value) => { journal = structuredClone(value); }, step: async (_key, fn) => fn() };
  const result = await controller.plan(ctx);
  assert.equal(sent.length, 1); assert.equal(sent[0].reasoning_effort, 'low');
  assert.ok(sent[0].tools.some(tool => tool.function.name === 'approve_plan'));
  assert.equal(sent[0].tool_choice, 'auto'); assert.equal(sent[0].max_tokens, 32768);
  assert.equal(result.trace[0].action, 'approve_plan');
  assert.equal(journal.modelExecutionPolicy, undefined);
  const saved = structuredClone(journal);
  assert.deepEqual(await controller.plan(ctx), result); assert.deepEqual(journal, saved); assert.equal(sent.length, 1);
});

test('real SDK serialization preserves explicit effort and disabled thinking', async t => {
  const { config, sent, fetch } = await transport(t), model = createAgentModel(config, fetch);
  for (const [providerOptions, expectedEffort, expectedThinking] of [
    [undefined, 'low', undefined],
    [{ deepseek: { reasoningEffort: 'high' } }, 'high', undefined],
    [{ deepseek: { thinking: { type: 'disabled' }, reasoningEffort: 'high' } }, undefined, 'disabled'],
  ]) {
    await generateText({ model, prompt: 'Synthetic SDK request.', maxOutputTokens: 1800, maxRetries: 0, providerOptions });
    assert.equal(sent.at(-1).reasoning_effort, expectedEffort);
    assert.equal(sent.at(-1).thinking?.type, expectedThinking); assert.equal(sent.at(-1).max_tokens, 1800);
  }
});

test('non-DeepSeek plain and SDK requests keep their payload settings', async t => {
  const { config, sent, fetch } = await transport(t);
  const compatible = { ...config, agentProvider: 'openai-compatible', model: 'compatible-fixture' };
  await createModel(compatible, fetch).complete(input('planning'));
  await generateText({ model: createAgentModel(compatible, fetch), prompt: 'Synthetic compatible request.', maxOutputTokens: 1800, maxRetries: 0 });
  assert.equal(sent.length, 2);
  for (const body of sent) { assert.equal(body.model, compatible.model); assert.equal(body.reasoning_effort, undefined); assert.equal(body.thinking, undefined); }
  assert.equal(sent[0].max_tokens, 6000); assert.equal(sent[1].max_tokens, 1800);
  const explicit = { reasoning_effort: 'max', thinking: { type: 'disabled' }, max_tokens: 1234 };
  assert.equal(withNativeDeepSeekReasoningDefault(compatible, explicit), explicit);
  assert.equal(withNativeDeepSeekReasoningDefault(config, explicit), explicit);
});

test('runtime HTTP reports the current execution policy without adding requirements to saved tasks', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'talewick-low-policy-'));
  const config = { runsDir: dir, baseURL: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-flash', engine: 'fixed', port: 0 };
  const runtime = await createRuntime({ config, model: { complete: () => { throw Error('No provider allowed'); } }, library: null, full15Adapter: null, independentReviewAdapter: null });
  t.after(async () => { await runtime.close(); await new Promise(resolve => runtime.server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}/api/runtime`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.modelExecutionPolicy, { version: NATIVE_DEEPSEEK_REASONING_POLICY, nativeDeepSeekDefaultReasoningEffort: 'low', applied: true, explicitStageSettingsTakePrecedence: true });
  assert.deepEqual(runtime.tasks.list(), []);
});
