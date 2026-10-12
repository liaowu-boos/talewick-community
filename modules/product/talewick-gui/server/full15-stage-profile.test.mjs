import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createFull15Analyze, adaptFull15PromptForInlineTransport } from './full15-analyze.mjs';
import { createModel } from './model.mjs';
import { full15ReasoningEffort, isFull15Stage, outputTokenLimit } from './model-policy.mjs';
import { projectFull15Failure } from './full15-service.mjs';
import { analysisFailureCode, analysisFailureEvidence } from '../../../validation/runtime/full15-task.mjs';

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const packet = '{"schema_version":"synthetic-full15-packet","source_sha256":"' + 'b'.repeat(64) + '","text":"固定全文"}\n';
const chunk = { index: 0, start_char: 0, end_char: packet.length, sha256: sha256(packet), text: packet };
const manifest = { schema_version: 'full15-packet-read-1', stage: 'cold_read', packet_sha256: sha256(packet), chunk_char_limit: 12000, chunk_count: 1 };
const coldPrompt = '# Full15 冷读任务\n只可通过 REVIEW_ENTRY 指定的 `packet-manifest`、`packet-chunk` 只读命令逐片加载它。\n只记录有明确原文证据的必要疑点。';
const checkPrompt = '# Full15 正式检查任务\n只可通过 REVIEW_ENTRY 指定的 `packet-manifest`、`packet-chunk` 只读命令逐片加载该 packet。\n冷读记录是待核对线索，不是真值。';
const payload = { stage: 'cold_read', contextKey: 'fixed-context', prompt: coldPrompt, manifest,
  packetSha256: manifest.packet_sha256, sourceSha256: 'b'.repeat(64), rulesVersion: 'rules', chunks: [chunk] };
const config = { baseURL: 'https://api.deepseek.com', apiKey: 'synthetic-only', model: 'deepseek-flash', agentProvider: 'deepseek', timeoutMs: 2000, idleTimeoutMs: 2000 };
const event = (id, delta, finish_reason = null) => `data: ${JSON.stringify({ id, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const response = ({ id = 'chatcmpl-fixed', content = '{"scope":{"full_text_read":true,"read_chunks":[0]}}', finish = 'stop', reasoning } = {}) =>
  new Response(event(id, { content, ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) })
    + event(id, {}, finish) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });

test('Full15 stages alone receive 65536 and explicit low thinking', () => {
  for (const stage of ['full15-cold-read', 'full15-check']) {
    assert.equal(isFull15Stage(stage), true);
    assert.equal(outputTokenLimit(config, 65536, stage), 65536);
    assert.equal(full15ReasoningEffort(config, stage), 'low');
  }
  for (const stage of ['review', 'continuity-review', 'planning', 'library-relevance']) {
    assert.equal(isFull15Stage(stage), false);
    assert.equal(full15ReasoningEffort(config, stage), undefined);
  }
  assert.equal(outputTokenLimit(config, 65536, 'review'), 32768);
  assert.equal(outputTokenLimit(config, 65536, 'continuity-review'), 65536, 'existing continuity policy is unchanged');
});

test('ordinary review, creation and library request semantics remain unchanged', async () => {
  const cases = [
    ['review', 6000, 32768, undefined, undefined, { type: 'json_object' }],
    ['draft:ch-1', 6500, 32768, undefined, undefined, undefined],
    ['library-analysis', 6000, 6000, { type: 'disabled' }, undefined, { type: 'json_object' }],
    ['library-relevance', 6000, 32768, { type: 'enabled' }, undefined, { type: 'json_object' }],
  ];
  for (const [stage, maxTokens, expectedMax, thinking, effort, format] of cases) {
    const bodies = [];
    const model = createModel(config, async (_url, init) => { bodies.push(JSON.parse(init.body)); return response({ id: `chatcmpl-${stage}` }); });
    await model.complete({ stage, system: 'unchanged-system', user: 'unchanged-user', maxTokens, allowRecovery: false });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].max_tokens, expectedMax, stage);
    assert.deepEqual(bodies[0].thinking, thinking, stage);
    assert.equal(bodies[0].reasoning_effort, effort, stage);
    assert.deepEqual(bodies[0].response_format, format, stage);
  }
});

test('inline transport replaces command-only wording while preserving diagnostic rules', () => {
  for (const prompt of [coldPrompt, checkPrompt]) {
    const adapted = adaptFull15PromptForInlineTransport(prompt);
    assert.doesNotMatch(adapted, /只可通过 REVIEW_ENTRY/);
    assert.match(adapted, /无工具的单次 provider API 调用/);
    assert.match(adapted, /不得尝试调用、模拟或声称执行这些命令/);
    assert.match(adapted, /只替换.*传输方式/);
  }
  assert.match(adaptFull15PromptForInlineTransport(coldPrompt), /只记录有明确原文证据的必要疑点/);
  assert.match(adaptFull15PromptForInlineTransport(checkPrompt), /冷读记录是待核对线索，不是真值/);
  assert.throws(() => adaptFull15PromptForInlineTransport('unversioned prompt'), error => error.code === 'full15_transport_contract_mismatch');
});

test('actual cold-read and check prompts produce conflict-free provider system/user messages', async () => {
  const actual = {
    cold_read: await readFile(new URL('../../../creation/novel-review/prompts/cold_read.md', import.meta.url), 'utf8'),
    check: await readFile(new URL('../../../creation/novel-review/prompts/check.md', import.meta.url), 'utf8'),
  };
  assert.equal(sha256(actual.cold_read), 'ff1f4b4389dc22e3aa8f67de38fbb490a3a6cc36c3884d013c0a35e35db974a0');
  assert.equal(sha256(actual.check), '3565c221824f12506163d8e4093a23225323690ad4bbbf44c81efda5452a9035');
  for (const stage of ['cold_read', 'check']) {
    const bodies = [];
    const model = createModel(config, async (_url, init) => { bodies.push(JSON.parse(init.body)); return response({ id: `chatcmpl-${stage}` }); });
    await createFull15Analyze({ model })({ ...payload, stage, prompt: actual[stage], manifest: { ...manifest, stage } });
    assert.equal(bodies.length, 1);
    const [systemMessage, userMessage] = bodies[0].messages;
    assert.equal(systemMessage.role, 'system');
    assert.doesNotMatch(systemMessage.content, /只可通过 REVIEW_ENTRY/);
    assert.match(systemMessage.content, /当前上下文不存在 REVIEW_ENTRY/);
    assert.match(systemMessage.content, stage === 'cold_read' ? /C03、C04/ : /C02–C05/);
    const sent = JSON.parse(userMessage.content);
    assert.equal(sent.transport.command_tools_available, false);
    assert.equal(sent.inline_packet.manifest.stage, stage);
    assert.deepEqual(sent.inline_packet.chunks, [chunk]);
    assert.equal(bodies[0].tools, undefined);
  }
});

test('cold read sends one bounded request with the complete inline manifest and chunks', async () => {
  const bodies = [];
  const model = createModel(config, async (_url, init) => { bodies.push(JSON.parse(init.body)); return response(); });
  const result = await createFull15Analyze({ model })(payload);
  assert.equal(bodies.length, 1);
  const body = bodies[0];
  assert.equal(body.max_tokens, 65536);
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'low');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.tools, undefined);
  assert.doesNotMatch(body.messages[0].content, /只可通过 REVIEW_ENTRY/);
  const sent = JSON.parse(body.messages[1].content);
  assert.deepEqual(sent.transport, { schema_version: 'full15-inline-transport-1', mode: 'inline_verified_packet', command_tools_available: false,
    context_key: payload.contextKey, source_sha256: payload.sourceSha256, rules_version: payload.rulesVersion });
  assert.deepEqual(sent.inline_packet.manifest, manifest);
  assert.deepEqual(sent.inline_packet.chunks, [chunk]);
  assert.deepEqual(result.receipt.deliveredChunkIndices, [0]);
  assert.equal(result.receipt.invocationId, 'chatcmpl-fixed');
});

test('check uses its dedicated stage, one request and no hidden recovery', async () => {
  const calls = [];
  const checkManifest = { ...manifest, stage: 'check' };
  const analyze = createFull15Analyze({ model: { complete: async args => {
    calls.push(args);
    await args.onReceipt({ provider: 'deepseek', invocationId: 'chatcmpl-check', contextId: 'chatcmpl-check' });
    return '{"scope":{"full_text_read":true,"read_chunks":[0]}}';
  } } });
  await analyze({ ...payload, stage: 'check', prompt: checkPrompt, manifest: checkManifest });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stage, 'full15-check');
  assert.equal(calls[0].allowRecovery, false);
  assert.equal(calls[0].maxTokens, 65536);
});

test('a complete length response is classified, receipted and never called provider_outcome_unknown', async () => {
  let calls = 0;
  const model = createModel(config, async () => { calls++; return response({ id: 'chatcmpl-length', content: '', finish: 'length', reasoning: 'bounded synthetic reasoning' }); });
  await assert.rejects(createFull15Analyze({ model })(payload), error => {
    assert.equal(error.code, 'provider_output_length_limit');
    assert.equal(error.providerResponseComplete, true);
    assert.equal(error.maxOutputTokens, 65536);
    assert.equal(error.finishReason, 'length');
    assert.equal(error.receipt.invocationId, 'chatcmpl-length');
    assert.equal(error.receipt.packetSha256, payload.packetSha256);
    assert.deepEqual(error.receipt.deliveredChunkIndices, [0]);
    assert.notEqual(error.code, 'provider_outcome_unknown');
    const projected = projectFull15Failure(error);
    assert.equal(projected.code, 'provider_output_length_limit');
    assert.match(projected.message, /完整返回.*长度上限终态/);
    assert.equal(analysisFailureCode(error), 'provider_output_length_limit');
    assert.notEqual(analysisFailureCode(error), 'provider_outcome_unknown');
    assert.deepEqual(analysisFailureEvidence(error), {
      providerResponseComplete: true, finishReason: 'length', maxOutputTokens: 65536,
      receipt: { provider: 'deepseek', invocationId: 'chatcmpl-length', contextId: 'chatcmpl-length',
        packetSha256: payload.packetSha256, deliveredChunkIndices: [0] },
    });
    return true;
  });
  assert.equal(calls, 1);
});

test('only failures without a known code remain provider_outcome_unknown', () => {
  assert.equal(analysisFailureCode(new Error('transport vanished before a response')), 'provider_outcome_unknown');
  assert.equal(analysisFailureCode({ code: 'provider_output_length_limit' }), 'provider_output_length_limit');
});

test('tampered inline manifests or chunks fail before any model call', async t => {
  for (const [name, override] of [
    ['manifest count', { manifest: { ...manifest, chunk_count: 2 } }],
    ['chunk hash', { chunks: [{ ...chunk, sha256: '0'.repeat(64) }] }],
    ['packet hash', { packetSha256: '1'.repeat(64), manifest: { ...manifest, packet_sha256: '1'.repeat(64) } }],
  ]) await t.test(name, async () => {
    let calls = 0;
    const analyze = createFull15Analyze({ model: { complete: async () => { calls++; } } });
    await assert.rejects(analyze({ ...payload, ...override }));
    assert.equal(calls, 0);
  });
});
