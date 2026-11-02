import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndependentReviewEvidenceAuditAnalyze } from './independent-review-analyze.mjs';
import { createModel } from './model.mjs';
import { SEMANTIC_EVIDENCE_AUDIT_STAGE, SEMANTIC_EVIDENCE_AUDIT_MODEL_POLICY } from './model-policy.mjs';

const input = { stage: 'review_evidence_audit', instruction: 'Return the closed evidence audit JSON schema.',
  inputHash: 'a'.repeat(64), packet: { originalOpinions: ['固定意见'], manuscripts: ['完整正文'] } };
const config = { baseURL: 'https://api.deepseek.com', apiKey: 'synthetic-not-a-key', model: 'deepseek-v4-pro', timeoutMs: 2000 };
const sse = (content, finish = 'stop') => new Response(`data: ${JSON.stringify({ id: 'synthetic-audit', choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });

test('exact validation interface maps to isolated semantic stage and rawResponse with bound receipt/attempt', async () => {
  const calls = [], attempts = [];
  const analyze = createIndependentReviewEvidenceAuditAnalyze({ model: { complete: async options => {
    calls.push(options); await options.onAttempt({ attempt: 1, stage: options.stage });
    await options.onReceipt({ provider: 'synthetic', invocationId: 'i1', contextId: 'c1' }); return '{"audit":true}';
  } } });
  const result = await analyze({ ...input, onAttempt: value => attempts.push(value) });
  assert.equal(calls.length, 1); assert.equal(calls[0].stage, SEMANTIC_EVIDENCE_AUDIT_STAGE);
  assert.equal(calls[0].modelPolicy, SEMANTIC_EVIDENCE_AUDIT_MODEL_POLICY); assert.equal(calls[0].allowRecovery, false);
  assert.deepEqual(JSON.parse(calls[0].user), { inputHash: input.inputHash, packet: input.packet });
  assert.deepEqual(Object.keys(result).sort(), ['rawResponse', 'receipt']); assert.equal(result.rawResponse, '{"audit":true}');
  assert.equal(result.receipt.inputHash, input.inputHash); assert.equal(attempts.length, 1);
  await assert.rejects(analyze({ ...input, stage: 'goal_audit' }), { code: 'review_analyze_input_invalid' });
  assert.equal(calls.length, 1);
});

test('actual native request body uses Pro, low, JSON, bounded output and no recovery POST', async () => {
  for (const finish of ['stop', 'length']) {
    const sent = [], attempts = [];
    const model = createModel(config, async (_url, options) => { sent.push(JSON.parse(options.body)); return sse('{"ok":true}', finish); });
    const analyze = createIndependentReviewEvidenceAuditAnalyze({ model });
    const operation = analyze({ ...input, onAttempt: value => attempts.push(value) });
    if (finish === 'stop') assert.equal((await operation).rawResponse, '{"ok":true}');
    else await assert.rejects(operation, /长度上限/);
    assert.equal(sent.length, 1); assert.equal(sent[0].model, 'deepseek-v4-pro');
    assert.equal(sent[0].reasoning_effort, 'low'); assert.deepEqual(sent[0].response_format, { type: 'json_object' });
    assert.equal(sent[0].max_tokens, 65536); assert.equal(sent[0].messages.length, 2);
    assert.equal(attempts.length, 1); assert.equal(attempts[0].stage, SEMANTIC_EVIDENCE_AUDIT_STAGE);
  }
});

test('non-DeepSeek request keeps its provider policy and audits cannot reuse context', async () => {
  const sent = [];
  const model = createModel({ ...config, baseURL: 'https://example.invalid/v1', model: 'synthetic-model' }, async (_url, options) => {
    sent.push(JSON.parse(options.body)); return new Response(JSON.stringify({ id: 'non-native', choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  });
  await createIndependentReviewEvidenceAuditAnalyze({ model })(input);
  assert.equal(sent[0].model, 'synthetic-model'); assert.equal(sent[0].reasoning_effort, undefined); assert.equal(sent[0].thinking, undefined);
  let count = 0;
  const analyze = createIndependentReviewEvidenceAuditAnalyze({ model: { complete: async options => {
    count++; options.onReceipt({ provider: 'synthetic', invocationId: `i${count}`, contextId: 'reused' }); return '{}';
  } } });
  await analyze(input); await assert.rejects(analyze(input), { code: 'review_context_reused' });
});
