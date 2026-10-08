import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizedRevisionIssues, checkedReviewAdjudication } from './review-policy.mjs';
import { manuscriptFingerprint } from '../../validation/runtime/checks.mjs';
import { createAdjudicationInput, normalizeAdjudication, confirmedIssueIndexes } from '../../validation/runtime/review-adjudication.mjs';
import { syntheticAdjudicationResponse } from '../../validation/tests/fixtures/synthetic-adjudication.mjs';

// Coordinator-specified synthetic labels test the mutation gate, not semantic accuracy.
function state() {
  const chapters = [
    { id: 'a', title: '门外', body: '她站在门外，钥匙仍在口袋。' },
    { id: 'b', title: '天光', body: '她用钥匙开门。天还没亮。' },
    { id: 'c', title: '远处', body: '同一时刻，太阳已经升起。' },
  ];
  const issue = (chapterId, quote, severity = 'must_fix') => ({ chapterId, quote, severity,
    explanation: '合成问题，裁定由测试明确指定。', suggestion: '只修改被授权的局部。', evidenceVerified: true });
  const review = { manuscriptSha256: manuscriptFingerprint(chapters), summary: '合成原审稿',
    issues: [issue('a', '钥匙仍在口袋'), issue('b', '她用钥匙开门', 'optional'),
      issue('b', '天还没亮'), issue('c', '太阳已经升起')] };
  const requirements = { pointOfView: '限知', prohibitions: [] };
  const input = createAdjudicationInput({ chapters, review, requirements });
  const reviewAdjudication = normalizeAdjudication(syntheticAdjudicationResponse(JSON.parse(input.user),
    (_, i) => ['reject', 'confirm', 'uncertain'][i]), input);
  return { chapters, review, requirements, reviewAdjudication };
}
const authorize = (s, issues = [s.review.issues[2]], chapterId = 'b') => authorizedRevisionIssues({ ...s, issues, chapterId });

test('only confirmed original issue indexes authorize; returned issues and original review stay independent', () => {
  const s = state(), original = structuredClone(s);
  assert.deepEqual(confirmedIssueIndexes(s.reviewAdjudication, { chapters: s.chapters, review: s.review, requirements: s.requirements }), [2]);
  const issues = authorize(s);
  assert.deepEqual(issues, [s.review.issues[2]]);
  issues[0].explanation = 'local mutation';
  assert.deepEqual(s, original);
  assert.deepEqual(checkedReviewAdjudication(s), s.reviewAdjudication);
  assert.equal(s.reviewAdjudication.modelReviewPassed, false);
  assert.equal(s.reviewAdjudication.semanticValidity, 'not_programmatically_verified');
});

test('reject, uncertain, optional, mixed and wrong-chapter requests never authorize', () => {
  const s = state();
  for (const index of [0, 1, 3]) assert.throws(() => authorize(s, [s.review.issues[index]], s.review.issues[index].chapterId));
  for (const issues of [[], undefined, null, [undefined], [s.review.issues[2], s.review.issues[1]]]) {
    assert.throws(() => authorizedRevisionIssues({ ...s, issues, chapterId: 'b' }));
  }
  assert.throws(() => authorize(s, [s.review.issues[2]], 'a'));
});

test('an original quote alone cannot authorize altered issue identity or missing adjudication', () => {
  const s = state();
  for (const key of ['quote', 'suggestion', 'explanation', 'severity']) {
    const issue = structuredClone(s.review.issues[2]); issue[key] += ' changed';
    assert.throws(() => authorize(s, [issue]));
  }
  assert.throws(() => authorize({ ...s, reviewAdjudication: undefined }));
  assert.throws(() => authorize({ ...s, review: { ...s.review, issues: [...s.review.issues].reverse() } }));
  assert.throws(() => authorize({ ...s, review: { ...s.review, summary: 'replacement review' } }));
});

test('any chapter change invalidates the whole adjudication, even with an unchanged target quote', () => {
  for (const index of [0, 1, 2]) for (const key of ['body', 'title', 'id']) {
    const s = state(); s.chapters[index][key] += '改';
    assert.throws(() => authorize(s));
    // Rebasing only the review fingerprint does not create a fresh model adjudication.
    s.review.manuscriptSha256 = manuscriptFingerprint(s.chapters);
    assert.throws(() => authorize(s));
  }
  const s = state(); s.requirements.pointOfView = '全知';
  assert.throws(() => authorize(s));
});

test('saved result flags, evidence, origin and source hashes are recomputed before mutation', () => {
  for (const change of [
    a => { a.decisions[0].decision = 'confirm'; a.decisions[0].revisionEligible = true; },
    a => { a.decisions[1].supportingEvidence[0].quote += '伪造'; },
    a => { a.sourceReview.issues[2].explanation += '改'; },
    a => { a.sourceReviewSha256 = '0'.repeat(64); },
    a => { a.origin = 'independent_context_model_call'; },
    a => { a.modelReviewPassed = true; },
    a => { a.semanticValidity = 'passed'; },
  ]) {
    const s = state(); change(s.reviewAdjudication);
    assert.throws(() => checkedReviewAdjudication(s));
    assert.throws(() => authorize(s));
  }
});
