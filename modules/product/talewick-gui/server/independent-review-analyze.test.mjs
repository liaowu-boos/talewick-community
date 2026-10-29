import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndependentReviewAnalyze, createIndependentReviewPositionRepairAnalyze } from './independent-review-analyze.mjs';
import { INDEPENDENT_REVIEW_MODEL_POLICY } from './model-policy.mjs';

const call = extra => ({ stage: 'independent_reading', packet: { schemaVersion: 'whole-quality-independent-reading-1', manuscripts: [] }, inputHash: 'a'.repeat(64), instruction: 'Return the closed JSON schema.', ...extra });

test('analyze sends one isolated packet and returns the provider receipt', async () => {
  const received = [];
  const analyze = createIndependentReviewAnalyze({ model: { complete: async options => { received.push(options); await options.onReceipt({ provider: 'synthetic', invocationId: 'inv-1', contextId: 'ctx-1' }); return '{"ok":true}'; } } });
  const result = await analyze(call());
  assert.equal(received.length, 1); assert.equal(received[0].modelPolicy, INDEPENDENT_REVIEW_MODEL_POLICY); assert.equal(received[0].allowRecovery, false);
  assert.equal(JSON.parse(received[0].user).inputHash, 'a'.repeat(64)); assert.equal(result.receipt.contextId, 'ctx-1');
});

test('analyze rejects a reused model context even when the provider returns another invocation', async () => {
  let calls = 0;
  const analyze = createIndependentReviewAnalyze({ model: { complete: async options => { calls++; await options.onReceipt({ provider: 'synthetic', invocationId: `inv-${calls}`, contextId: 'same-context' }); return '{}'; } } });
  await analyze(call());
  await assert.rejects(analyze(call({ inputHash: 'b'.repeat(64) })), error => error.code === 'review_context_reused');
});

test('position repair has its own isolated stage, exact packet/hash receipt and no implicit recovery', async () => {
  const received = [], packet = { originalRawSha256: 'b'.repeat(64), invalidCitationPaths: ['/entries/0/claims/0/evidence/0'] };
  const analyze = createIndependentReviewPositionRepairAnalyze({ model: { complete: async options => {
    received.push(options); options.onReceipt({ provider: 'synthetic', invocationId: 'repair-1', contextId: 'repair-context' }); return '{"repairs":[]}';
  } } });
  const result = await analyze(call({ stage: 'position_repair', packet }));
  assert.equal(received[0].stage, 'independent-review:position-repair'); assert.equal(received[0].allowRecovery, false);
  assert.equal(received[0].modelPolicy, INDEPENDENT_REVIEW_MODEL_POLICY); assert.deepEqual(JSON.parse(received[0].user), { inputHash: 'a'.repeat(64), packet });
  assert.equal(result.receipt.inputHash, 'a'.repeat(64)); assert.equal(result.receipt.contextId, 'repair-context');
  await assert.rejects(analyze(call({ stage: 'goal_audit' })), { code: 'review_analyze_input_invalid' });
  assert.equal(received.length, 1);
});
