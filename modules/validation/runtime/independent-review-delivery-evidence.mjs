import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { augmentReviewPrompt } from './independent-review-evidence-policy.mjs';
export const DELIVERY_EVIDENCE_POLICY = 'sealed-delivery-evidence-v1';
export const bytesHash = value => createHash('sha256').update(value).digest('hex');
export const reviewStageName = stage => `independent-review:${stage.replaceAll('_', '-')}`;
export function baseReviewPrompt({ stage, packet, inputHash, instruction }) {
  return { stage: reviewStageName(stage), system: `${instruction.trim()}\n\n你只可使用本次 user 消息中的冻结 packet。不得引用历史对话、诊断、作者身份、修改计划或未在 packet 中出现的目标。只输出指令要求的闭合 JSON。`, user: JSON.stringify({ inputHash, packet }) };
}
export function prepareEvidenceDelivery(input, context) {
  assert.equal(context?.policy, DELIVERY_EVIDENCE_POLICY);
  const goal = input.stage === 'goal_audit';
  assert.equal(context.stageId, input.packet.taskStageId);
  assert.equal(context.protocolInputHash, input.inputHash);
  assert.equal(context.priorSeals.length, goal ? 6 : 0);
  assert.equal(Object.hasOwn(context, 'differenceAudit'), goal);
  const prepared = augmentReviewPrompt(baseReviewPrompt(input), context.differenceAudit);
  return { ...prepared, contextSHA256: bytesHash(JSON.stringify(context)) };
}
/** Verifies local fetch-boundary bytes; does not establish remote receipt or semantic truth. */
export function validateDeliveryEvidence({ input, context, evidence, receipt }) {
  const expected = prepareEvidenceDelivery(input, context);
  assert.deepEqual(evidence.prompt, expected.prompt);
  assert.deepEqual(evidence.binding, expected.binding);
  assert.equal(evidence.contextSHA256, expected.contextSHA256);
  assert.equal(typeof evidence.requestBody, 'string');
  const body = JSON.parse(evidence.requestBody);
  assert.deepEqual(body.messages, [{ role: 'system', content: expected.prompt.system }, { role: 'user', content: expected.prompt.user }]);
  assert.equal(receipt.protocolInputHash, input.inputHash);
  assert.equal(receipt.inputHash, input.inputHash);
  assert.equal(receipt.deliveredInputSHA256, expected.binding.deliveredInputSHA256);
  assert.equal(receipt.requestBodySHA256, bytesHash(evidence.requestBody));
  assert.equal(receipt.requestBodyByteLength, Buffer.byteLength(evidence.requestBody, 'utf8'));
  assert.equal(evidence.transportReceipt.requestBodySHA256, receipt.requestBodySHA256);
  assert.equal(evidence.transportReceipt.requestBodyByteLength, receipt.requestBodyByteLength);
  for (const key of ['provider', 'invocationId', 'contextId']) assert.equal(evidence.transportReceipt[key], receipt[key]);
  return { schemaVersion: DELIVERY_EVIDENCE_POLICY, protocolInputHash: input.inputHash,
    deliveredInputSHA256: receipt.deliveredInputSHA256, requestBodySHA256: receipt.requestBodySHA256,
    requestBodyByteLength: receipt.requestBodyByteLength, contextSHA256: expected.contextSHA256,
    evidenceSHA256: bytesHash(JSON.stringify(evidence)), receiptSHA256: bytesHash(JSON.stringify(receipt)),
    transportScope: 'local-fetch-request-body-utf8', semanticPass: 'NOT_COMPUTED', qualityPass: 'NOT_COMPUTED' };
}
