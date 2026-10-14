import { manuscriptFingerprint } from '../../../validation/runtime/checks.mjs';
import { ADJUDICATION_VERSION, ADJUDICATION_RELIABILITY_VERSION, ADJUDICATION_CONTINUITY_VERSION, adjudicationFingerprint, createAdjudicationInput, validateAdjudication } from '../../../validation/runtime/review-adjudication.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const supportedAdjudicationVersions = new Set([ADJUDICATION_VERSION, ADJUDICATION_RELIABILITY_VERSION, ADJUDICATION_CONTINUITY_VERSION]);

/** Pure public projection. Revalidate the saved record with the production validator;
 * never run a model, edit a review, or authorize/apply a manuscript revision. */
export function projectReviewAdjudication(result) {
  const binding = { status: 'missing', diagnostics: [], manuscriptSha256: manuscriptFingerprint(result.chapters) };
  const value = result.reviewAdjudication;
  if (value === undefined) return binding;
  if (!record(value)) return { ...binding, status: 'invalid', diagnostics: ['裁定记录格式异常。'] };
  if (!supportedAdjudicationVersions.has(value.schemaVersion)) return { ...binding, status: 'unsupported', diagnostics: ['裁定格式版本尚未支持，已保留原始记录。'] };
  if (!record(value.sourceReview) || value.sourceReviewSha256 !== adjudicationFingerprint(value.sourceReview) || value.sourceReview.manuscriptSha256 !== value.manuscriptSha256) {
    return { ...binding, status: 'invalid', diagnostics: ['裁定中的原审稿与其指纹或稿件版本不一致。'] };
  }
  if (value.manuscriptSha256 !== binding.manuscriptSha256 || value.sourceReviewSha256 !== adjudicationFingerprint(result.review)) {
    return { ...binding, status: 'stale', diagnostics: ['裁定对应另一版稿件或原审稿，仅保留为历史记录。'] };
  }
  if (!['completed', 'not_required'].includes(value.status)) return { ...binding, status: 'unverified', diagnostics: ['裁定尚未完成，以下仅保留已有记录。'] };
  try {
    const input = createAdjudicationInput({ chapters: result.chapters, review: result.review,
      ...(result.requirements === undefined ? {} : { requirements: result.requirements }), protocolVersion: value.schemaVersion });
    const checked = validateAdjudication(value, input);
    return { ...binding, status: 'bound', adjudicationSha256: adjudicationFingerprint(checked),
      diagnostics: ['已通过版本、记录完整性和引文校验；不证明裁定的语义判断正确，不自动采纳修改。'] };
  } catch (error) {
    return { ...binding, status: 'invalid', diagnostics: ['裁定记录未通过版本、内容或引文校验；已保留原始记录。', error.code || 'ADJUDICATION_VALIDATION_FAILED'] };
  }
}
