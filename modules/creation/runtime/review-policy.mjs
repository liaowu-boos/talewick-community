import { isDeepStrictEqual } from 'node:util';
import { createAdjudicationInput, validateAdjudication, revisionEligibleIssues } from '../../validation/runtime/review-adjudication.mjs';

/** Re-check full-text, review and decision bindings at the point of mutation. */
export function authorizedRevisionIssues({ chapters, review, reviewAdjudication, requirements, chapterId, issues }) {
  const input = createAdjudicationInput({ chapters, review, requirements, protocolVersion: reviewAdjudication?.schemaVersion });
  const approved = revisionEligibleIssues(reviewAdjudication, input);
  if (!Array.isArray(issues) || !issues.length || issues.some(issue => issue.chapterId !== chapterId || !approved.some(candidate => isDeepStrictEqual(candidate, issue)))) {
    throw new Error('修订需要与当前全文和原审稿绑定、经证据裁定确认的问题；争议或未确定意见不能自动改稿。');
  }
  return structuredClone(issues);
}

export function checkedReviewAdjudication({ chapters, review, reviewAdjudication, requirements }) {
  return validateAdjudication(reviewAdjudication, createAdjudicationInput({ chapters, review, requirements, protocolVersion: reviewAdjudication?.schemaVersion }));
}
