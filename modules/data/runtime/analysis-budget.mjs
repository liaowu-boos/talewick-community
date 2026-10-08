// Versioned generation policy; JSON analysis validation remains unchanged.
export const ANALYSIS_BUDGET_VERSION = 'library-analysis-budget-v2';
export const LEGACY_ANALYSIS_BUDGET_VERSION = 'library-analysis-budget-v1';
export const REVIEW_MAX_TOKENS = 2000;
export const REVISION_MAX_TOKENS = 12000;

const concise = ' event 概括有依据的关键事件与因果，减少逐动作重述；各分析字段分别承担自身解释，避免跨字段重复复述。精简措辞时仍保留所有分析层、来源与人物主体、推断强度、有据的不同解释和限制；不为节省输出删去必要单元、证据或跨单元联系。';
const policies = Object.freeze({
  [LEGACY_ANALYSIS_BUDGET_VERSION]: Object.freeze({ version: LEGACY_ANALYSIS_BUDGET_VERSION, maxTokens: 12000,
    userFields: Object.freeze({}), systemSuffix: '' }),
  [ANALYSIS_BUDGET_VERSION]: Object.freeze({ version: ANALYSIS_BUDGET_VERSION, maxTokens: 16000,
    userFields: Object.freeze({ analysisBudgetPolicyVersion: ANALYSIS_BUDGET_VERSION }), systemSuffix: concise }),
});
const invalid = () => Object.assign(new TypeError('Unknown or inconsistent library analysis budget policy'), { code: 'ANALYSIS_BUDGET_INVALID' });

export function analysisBudget(version = ANALYSIS_BUDGET_VERSION) {
  if (typeof version !== 'string' || !Object.hasOwn(policies, version)) throw invalid();
  return policies[version];
}

/** Policy declaration is inside the exact signed request.user; legacy inputs have none. */
export function inspectAnalysisBudgetRequest(request) {
  let user;
  try { user = JSON.parse(request.user); } catch { throw invalid(); }
  if (!user || typeof user !== 'object' || Array.isArray(user) || request.stage !== 'library-analysis') throw invalid();
  const declared = Object.hasOwn(user, 'analysisBudgetPolicyVersion');
  if (declared && user.analysisBudgetPolicyVersion !== ANALYSIS_BUDGET_VERSION) throw invalid();
  const policy = analysisBudget(declared ? ANALYSIS_BUDGET_VERSION : LEGACY_ANALYSIS_BUDGET_VERSION);
  if (request.maxTokens !== policy.maxTokens) throw invalid();
  return policy;
}
