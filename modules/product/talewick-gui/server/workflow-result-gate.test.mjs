import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorkflowResultReady } from './workflow-result-gate.mjs';
import { ADJUDICATION_VERSION, ADJUDICATION_RELIABILITY_VERSION, ADJUDICATION_CONTINUITY_VERSION, adjudicationFingerprint, createAdjudicationInput, adjudicateReview } from '../../../validation/runtime/review-adjudication.mjs';
import { manuscriptFingerprint } from '../../../validation/runtime/checks.mjs';
const spec = { reviewPolicyVersion: ADJUDICATION_VERSION };
const continuitySpec = { reviewPolicyVersion: ADJUDICATION_CONTINUITY_VERSION };
async function valid() {
  const chapters = [{ id: 'ch-1', title: '门口', body: '她第二次把手放在门把上。这一次，她终于听清屋内那声叹息，却没有推门。' }];
  const review = { manuscriptSha256: manuscriptFingerprint(chapters), issues: [], summary: '没有需要强制修订的问题；重复动作改变了读者认识。' };
  const result = { chapters, review };
  result.reviewAdjudication = await adjudicateReview({ input: createAdjudicationInput(result), model: { complete() { throw Error('No model allowed'); } } });
  return result;
}
async function validReliability() {
  const result = await valid();
  result.reviewAdjudication = await adjudicateReview({
    input: createAdjudicationInput({ chapters: result.chapters, review: result.review,
      protocolVersion: ADJUDICATION_RELIABILITY_VERSION }),
    model: { complete() { throw Error('No model allowed'); } }
  });
  return result;
}
async function validIncompleteContinuity() {
  const chapters = [{ id: 'ch-1', title: '交接', body: '她把钥匙放在柜台上，注明只供周末清点。周一，她按约回来搬走最后两箱。' }];
  const manuscriptSha256 = manuscriptFingerprint(chapters);
  const originalReview = { manuscriptSha256, issues: [], summary: '一般审稿没有提出必修；事件链检查另有失败记录。' };
  const hex = value => value.repeat(64);
  const review = { ...originalReview, continuityChainFailure: {
    schemaVersion: 'continuity-chain-failure-1', chainSchemaVersion: 'continuity-chain-review-3',
    status: 'continuity_chain_incomplete', inputHash: hex('1'), manuscriptSha256,
    reportSha256: adjudicationFingerprint(originalReview), primaryRequestSha256: hex('2'),
    primaryResponseSha256: hex('3'), repairSchemaVersion: 'continuity-chain-format-repair-1',
    repairRequestSha256: hex('4'), repairResponseSha256: hex('5'), failureCode: 'REPAIR_SCOPE',
    repairAttempted: true, semanticAcceptance: false, automaticRevisionEligible: false,
    historicalObservations: []
  } };
  const result = { chapters, review, qualityCheckStatus: 'incomplete',
    warnings: ['事件链检查未完成；已保留原始与唯一纠正响应的绑定失败状态，这不是检查通过，也未授权自动修订。'] };
  result.reviewAdjudication = await adjudicateReview({
    input: createAdjudicationInput({ chapters, review, protocolVersion: ADJUDICATION_CONTINUITY_VERSION }),
    model: { complete() { throw Error('No model allowed'); } }
  });
  return result;
}
test('legacy task without policy remains compatible without inventing approval', () => {
  const result = { chapters: [] }; const before = structuredClone(result);
  assertWorkflowResultReady(result, {}); assert.deepEqual(result, before);
});
test('current workflow cannot complete with missing review or adjudication', async () => {
  for (const field of ['review', 'reviewAdjudication']) {
    const result = await valid(); delete result[field];
    assert.throws(() => assertWorkflowResultReady(result, spec), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  }
});
test('bound no-must-fix record permits meaningful repetition without forcing changes', async () => {
  const result = await valid(), before = structuredClone(result);
  assertWorkflowResultReady(result, spec); assert.deepEqual(result, before);
  assert.equal(result.reviewAdjudication.status, 'not_required');
});
test('explicit reliability protocol remains projectable and ready', async () => {
  const result = await validReliability(), before = structuredClone(result);
  assertWorkflowResultReady(result, { reviewPolicyVersion: ADJUDICATION_RELIABILITY_VERSION });
  assert.deepEqual(result, before);
});
test('changed manuscript cannot reuse old adjudication', async () => {
  const result = await valid(); result.chapters[0].body += '后来她走了。';
  assert.throws(() => assertWorkflowResultReady(result, spec), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
});
test('new must-fix allegation is not confirmed by an old no-must-fix record', async () => {
  const result = await valid(); result.review.issues.push({ chapterId: 'ch-1', severity: 'must_fix', quote: '把手放在门把上', explanation: '疑似重复，尚待上下文核对。' });
  assert.throws(() => assertWorkflowResultReady(result, spec), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
});
test('unrecognized policy and forged records fail closed', async () => {
  const result = await valid();
  assert.throws(() => assertWorkflowResultReady(result, { reviewPolicyVersion: 'future' }), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  result.reviewAdjudication.status = 'completed';
  assert.throws(() => assertWorkflowResultReady(result, spec), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
});
test('bound continuity failure is deliverable only as explicitly incomplete', async () => {
  const result = await validIncompleteContinuity(), before = structuredClone(result);
  assertWorkflowResultReady(result, continuitySpec); assert.deepEqual(result, before);
  assert.equal(result.reviewAdjudication.status, 'not_required');
  assert.equal(result.review.continuityChainFailure.semanticAcceptance, false);
  assert.equal(result.review.continuityChainFailure.automaticRevisionEligible, false);
});
test('continuity incomplete delivery rejects missing status, warning, failure boundary, and policy mismatch', async () => {
  const cases = [
    result => { delete result.qualityCheckStatus; },
    result => { result.qualityCheckStatus = 'complete'; },
    result => { result.warnings = ['检查结束。']; },
    result => { delete result.review.continuityChainFailure; },
    result => { result.review.continuityChainFailure.semanticAcceptance = true; },
  ];
  for (const mutate of cases) {
    const result = await validIncompleteContinuity(); mutate(result);
    assert.throws(() => assertWorkflowResultReady(result, continuitySpec), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  }
  const mismatched = await validIncompleteContinuity();
  assert.throws(() => assertWorkflowResultReady(mismatched, spec), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
});
