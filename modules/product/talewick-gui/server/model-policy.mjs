export const isLibraryStage = stage => stage === 'library-relevance' || stage === 'library-analysis' || stage === 'library-analysis-revision' || stage === 'library-review';
export const isFull15Stage = stage => stage === 'full15-cold-read' || stage === 'full15-check';
export const FOLLOWUP_CONTINUITY_MODEL_POLICY = 'followup-continuity-json-1';
export const WHOLE_REVISION_MODEL_POLICY = 'whole-manuscript-json-1';
export const WHOLE_QUALITY_MODEL_POLICY = 'whole-manuscript-quality-json-1';
export const INDEPENDENT_REVIEW_MODEL_POLICY = 'independent-review-json-1';
const FOLLOWUP_CONTINUITY_STAGES = new Set([
  'planning:material-decisions',
  'continuity-chain-review',
  'review-adjudication:continuity-v4',
  'review-adjudication:repair:continuity-v4',
]);
export const isFollowupContinuityStage = stage => FOLLOWUP_CONTINUITY_STAGES.has(stage);
const WHOLE_REVISION_STAGES = new Set([
  'whole-revision:diagnosis', 'whole-revision:diagnosis:format-repair', 'whole-revision:diagnosis:repair',
  'whole-revision:plan', 'whole-revision:plan:format-repair', 'whole-revision:plan:repair',
  'whole-revision:revision', 'whole-revision:revision:format-repair', 'whole-revision:revision:repair',
  'whole-revision:reread', 'whole-revision:reread:format-repair', 'whole-revision:reread:repair',
]);
export const isWholeRevisionStage = stage => WHOLE_REVISION_STAGES.has(stage);
const WHOLE_QUALITY_STAGES = new Set(['reading', 'applicability', 'plan', 'feasibility', 'revision', 'reread', 'material-evidence'].flatMap(name => [`whole-quality:${name}`, `whole-quality:${name}:format-repair`]));
export const isWholeQualityStage = stage => WHOLE_QUALITY_STAGES.has(stage);
const CROSS_CHAPTER_REVIEW_STAGES = new Set([
  'whole-quality:cross-chapter:extract',
  'whole-quality:cross-chapter:adjudicate',
  'whole-quality:cross-chapter:extract:format-repair',
  'whole-quality:cross-chapter:adjudicate:format-repair',
]);
export const isCrossChapterReviewStage = stage => CROSS_CHAPTER_REVIEW_STAGES.has(stage);
const CROSS_CHAPTER_THINKING_STAGES = new Set([
  'whole-quality:cross-chapter:extract',
  'whole-quality:cross-chapter:adjudicate',
]);
const CROSS_CHAPTER_NO_THINKING_STAGES = new Set([
  'whole-quality:cross-chapter:extract:format-repair',
  'whole-quality:cross-chapter:adjudicate:format-repair',
]);
export const crossChapterThinkingMode = stage => CROSS_CHAPTER_THINKING_STAGES.has(stage) ? 'enabled' : CROSS_CHAPTER_NO_THINKING_STAGES.has(stage) ? 'disabled' : undefined;
const INDEPENDENT_REVIEW_STAGES = new Set(['independent-reading', 'blind-pair', 'goal-audit', 'position-repair'].map(name => `independent-review:${name}`));
export const isIndependentReviewStage = stage => INDEPENDENT_REVIEW_STAGES.has(stage);
export const agentProviderFor = config => config.agentProvider || (new URL(config.baseURL).hostname === 'api.deepseek.com' ? 'deepseek' : 'openai-compatible');

export const NATIVE_DEEPSEEK_REASONING_POLICY = 'native-deepseek-explicit-low-1';
export const NATIVE_DEEPSEEK_DEFAULT_REASONING_EFFORT = 'low';

/** Execution default only: explicit stage/SDK settings and disabled thinking win.
 * This does not change token budgets, task bindings, or historical checkpoints. */
export function withNativeDeepSeekReasoningDefault(config, body) {
  if (agentProviderFor(config) !== 'deepseek' || body.thinking?.type === 'disabled' || body.reasoning_effort !== undefined) return body;
  return { ...body, reasoning_effort: NATIVE_DEEPSEEK_DEFAULT_REASONING_EFFORT };
}

// Current Flash and legacy V4 aliases share the thinking/streaming contract.
export const usesDeepSeekThinking = config => agentProviderFor(config) === 'deepseek' &&
  (config.model === 'deepseek-flash' || /^deepseek-v4-(?:flash(?:-vision-exp)?|pro)$/.test(config.model ?? ''));

const BUSINESS_STAGES = new Set(['requirements', 'requirements:repair', 'planning', 'planning:material-decisions', 'material-evidence', 'agent:replan', 'review', 'agent:reviewManuscript', 'revisionReview', 'review-adjudication', 'review-adjudication:repair', 'review-adjudication:continuity-v4', 'review-adjudication:repair:continuity-v4', 'requestedRevision', 'continuity-review', 'continuity-chain-review', ...WHOLE_REVISION_STAGES]);
export const isBusinessStage = stage => typeof stage === 'string' && (BUSINESS_STAGES.has(stage) || isWholeQualityStage(stage) || isCrossChapterReviewStage(stage) || isIndependentReviewStage(stage) || /^(draft|revision|agent:reviseChapter):[\w-]+$/.test(stage));

export function outputTextLimit(requestedTokens, ceiling = 16000) {
  if (!Number.isFinite(requestedTokens) || requestedTokens <= 0) throw new Error('模型输出预算必须是正数。');
  return Math.min(ceiling, Math.max(512, Math.ceil(requestedTokens)));
}

export const RECOVERY_BUDGET_VERSION = 'planning-recovery-text-2';

/** Full15 uses isolated, single-request stages. Low thinking keeps semantic
 * review enabled while reserving room in the shared output budget for JSON. */
export function full15ReasoningEffort(config, stage) {
  return usesDeepSeekThinking(config) && isFull15Stage(stage) ? 'low' : undefined;
}

/** New-task-only structured checks reserve JSON space with bounded low thinking.
 * Historical tasks do not receive this policy profile and retain their budgets. */
export function followupContinuityReasoningEffort(config, stage, modelPolicy) {
  return modelPolicy === FOLLOWUP_CONTINUITY_MODEL_POLICY && usesDeepSeekThinking(config) && isFollowupContinuityStage(stage) ? 'low' : undefined;
}

export function wholeRevisionReasoningEffort(config, stage, modelPolicy) {
  return modelPolicy === WHOLE_REVISION_MODEL_POLICY && usesDeepSeekThinking(config) && isWholeRevisionStage(stage) ? 'low' : undefined;
}

export function wholeQualityReasoningEffort(config, stage, modelPolicy) {
  return modelPolicy === WHOLE_QUALITY_MODEL_POLICY && usesDeepSeekThinking(config) && (isWholeQualityStage(stage) || CROSS_CHAPTER_THINKING_STAGES.has(stage)) ? 'low' : undefined;
}

export function independentReviewReasoningEffort(config, stage, modelPolicy) {
  return modelPolicy === INDEPENDENT_REVIEW_MODEL_POLICY && usesDeepSeekThinking(config) && isIndependentReviewStage(stage) ? 'low' : undefined;
}

/** A complete structured plan can exceed the legacy 6K text hint. This changes
 * only the existing no-thinking recovery, never its count or shared deadline. */
export function recoveryTextLimit(stage, requestedTokens) {
  const ceiling = isBusinessStage(stage) ? 32768 : 16000;
  const requested = outputTextLimit(requestedTokens, ceiling);
  return stage === 'planning' || stage === 'agent:replan' ? Math.max(16000, requested) : requested;
}

/** Stage budgets describe the expected text, while V4 counts thinking in the same output limit. */
export function outputTokenLimit(config, requestedTokens = 6000, stage, modelPolicy) {
  if (!Number.isFinite(requestedTokens) || requestedTokens <= 0) throw new Error('模型输出预算必须是正数。');
  const thinkingV4 = usesDeepSeekThinking(config);
  if (modelPolicy === WHOLE_QUALITY_MODEL_POLICY && isCrossChapterReviewStage(stage)) return 32768;
  // Relevance requests 6000 text tokens; native thinking shares one 32768 total limit.
  if (stage === 'library-relevance') return thinkingV4 ? 32768 : outputTextLimit(requestedTokens, 6000);
  if (!thinkingV4) return (modelPolicy === WHOLE_REVISION_MODEL_POLICY && isWholeRevisionStage(stage))
    || (modelPolicy === WHOLE_QUALITY_MODEL_POLICY && isWholeQualityStage(stage))
    ? outputTextLimit(requestedTokens, 32768) : Math.min(16000, Math.max(512, Math.ceil(requestedTokens)));
  // Full15 packets need a larger shared thinking + JSON allowance, without
  // changing the budgets of ordinary review, creation or library stages.
  if (isFull15Stage(stage)) return 65536;
  if (modelPolicy === FOLLOWUP_CONTINUITY_MODEL_POLICY && isFollowupContinuityStage(stage)) return 65536;
  if (modelPolicy === WHOLE_REVISION_MODEL_POLICY && isWholeRevisionStage(stage)) return 65536;
  if (modelPolicy === WHOLE_QUALITY_MODEL_POLICY && isWholeQualityStage(stage)) return 65536;
  if (modelPolicy === INDEPENDENT_REVIEW_MODEL_POLICY && isIndependentReviewStage(stage)) return 65536;
  // Explicit opt-in for large continuity JSON: shared thinking + text allowance,
  // not a guarantee of complete output. Recovery keeps the requested text cap.
  if (stage === 'continuity-review') return 65536;
  // Other library calls disable V4 thinking; their allowance is for JSON output.
  if (isLibraryStage(stage)) return outputTextLimit(requestedTokens);
  // 所有真实创作阶段共用额度，避免规划能完成、后续章节仍被旧的 16K 截断。
  // 调度器只增加单次余量，不自动重放工具；普通对话维持独立设置。
  if (isBusinessStage(stage) || stage === 'agent:controller') return 32768;
  const contentBudget = Math.min(24576, Math.max(512, Math.ceil(requestedTokens)));
  // This is one bounded total allowance, not an API-enforced split or an automatic retry.
  return Math.min(32768, Math.max(16384, contentBudget + 8192));
}
