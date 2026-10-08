import { ADJUDICATION_VERSION } from '../../../validation/runtime/review-adjudication.mjs';
import { projectReviewAdjudication } from './service-public.mjs';

/** Check only the contract opted into by the saved workflow request specification.
 * Older tasks without a review policy remain readable/resumable. This validates
 * evidence binding, not the semantic truth of a finding or the quality of prose.
 */
export function assertWorkflowResultReady(result, requestSpec) {
  if (requestSpec?.reviewPolicyVersion === undefined) return;
  const reject = () => {
    const error = new Error('本次结果的审阅记录未完成或与正文不一致，已保留输出和恢复点，未标记完成。');
    error.code = 'WORKFLOW_RESULT_UNVERIFIED';
    throw error;
  };
  if (requestSpec.reviewPolicyVersion !== ADJUDICATION_VERSION) reject();
  try {
    if (projectReviewAdjudication(result).status !== 'bound') reject();
  } catch { reject(); }
}
