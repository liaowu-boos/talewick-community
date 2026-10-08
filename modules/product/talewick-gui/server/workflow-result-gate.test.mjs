import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorkflowResultReady } from './workflow-result-gate.mjs';
import { ADJUDICATION_VERSION, createAdjudicationInput, adjudicateReview } from '../../../validation/runtime/review-adjudication.mjs';
import { manuscriptFingerprint } from '../../../validation/runtime/checks.mjs';
const spec = { reviewPolicyVersion: ADJUDICATION_VERSION };
async function valid() {
  const chapters = [{ id: 'ch-1', title: '门口', body: '她第二次把手放在门把上。这一次，她终于听清屋内那声叹息，却没有推门。' }];
  const review = { manuscriptSha256: manuscriptFingerprint(chapters), issues: [], summary: '没有需要强制修订的问题；重复动作改变了读者认识。' };
  const result = { chapters, review };
  result.reviewAdjudication = await adjudicateReview({ input: createAdjudicationInput(result), model: { complete() { throw Error('No model allowed'); } } });
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
