import { ADJUDICATION_VERSION, ADJUDICATION_RELIABILITY_VERSION, ADJUDICATION_CONTINUITY_VERSION } from '../../../validation/runtime/review-adjudication.mjs';
import { projectReviewAdjudication } from './service-public.mjs';
import { WHOLE_MANUSCRIPT_REVISION_MODE } from './workflow-engine.mjs';

const supportedPolicies = new Set([ADJUDICATION_VERSION, ADJUDICATION_RELIABILITY_VERSION, ADJUDICATION_CONTINUITY_VERSION]);
const currentFailureWarning = '事件链检查未完成；已保留原始与唯一纠正响应的绑定失败状态，这不是检查通过，也未授权自动修订。';
const historicalFailureWarning = '先前正文的事件链检查未完成状态仍作为历史保留；当前结果不能据此宣称全部质量检查完成。';

/** Check only the contract opted into by the saved workflow request specification.
 * Older tasks without a review policy remain readable/resumable. This validates
 * evidence binding, not the semantic truth of a finding or the quality of prose.
 */
const rejection = () => {
  const error = new Error('本次结果的审阅记录未完成或与正文不一致，已保留输出和恢复点，未标记完成。');
  error.code = 'WORKFLOW_RESULT_UNVERIFIED';
  return error;
};

const loadWholeRevisionAssert = async () => {
  const runtime = await import('../../../creation/runtime/whole-manuscript-revision.mjs');
  if (typeof runtime.assertWholeRevisionResult !== 'function') throw new Error('整稿修订运行时未提供结果门禁。');
  return runtime.assertWholeRevisionResult;
};

export function assertWorkflowResultReady(result, requestSpec, request, wholeRevisionAssert) {
  const wholeRequest = request?.revisionMode === WHOLE_MANUSCRIPT_REVISION_MODE;
  const wholeSpec = requestSpec?.revisionMode === WHOLE_MANUSCRIPT_REVISION_MODE;
  if (wholeRequest || wholeSpec) {
    if (!wholeRequest || !wholeSpec) throw rejection();
    return Promise.resolve(wholeRevisionAssert ?? loadWholeRevisionAssert()).then(assertResult => {
      assertResult(result, requestSpec);
    }).catch(() => { throw rejection(); });
  }
  if (requestSpec?.reviewPolicyVersion === undefined) return;
  const reject = () => {
    throw rejection();
  };
  const policy = requestSpec.reviewPolicyVersion;
  if (!supportedPolicies.has(policy) || result?.reviewAdjudication?.schemaVersion !== policy) reject();
  try {
    if (projectReviewAdjudication(result).status !== 'bound') reject();
  } catch { reject(); }
  if (policy !== ADJUDICATION_CONTINUITY_VERSION) return;
  const hasCurrentFailure = result.review?.continuityChainFailure !== undefined;
  const hasHistoricalFailure = Array.isArray(result.review?.continuityChainFailureHistory) &&
    result.review.continuityChainFailureHistory.length > 0;
  const isIncomplete = hasCurrentFailure || hasHistoricalFailure;
  if (isIncomplete) {
    if (result.qualityCheckStatus !== 'incomplete' || !Array.isArray(result.warnings) ||
      (hasCurrentFailure && !result.warnings.includes(currentFailureWarning)) ||
      (hasHistoricalFailure && !result.warnings.includes(historicalFailureWarning))) reject();
  } else if (result.qualityCheckStatus !== undefined) reject();
}
