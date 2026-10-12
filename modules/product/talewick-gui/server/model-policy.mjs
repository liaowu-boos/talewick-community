export const isLibraryStage = stage => stage === 'library-relevance' || stage === 'library-analysis' || stage === 'library-analysis-revision' || stage === 'library-review';
export const isFull15Stage = stage => stage === 'full15-cold-read' || stage === 'full15-check';
export const agentProviderFor = config => config.agentProvider || (new URL(config.baseURL).hostname === 'api.deepseek.com' ? 'deepseek' : 'openai-compatible');

// Current Flash and legacy V4 aliases share the thinking/streaming contract.
export const usesDeepSeekThinking = config => agentProviderFor(config) === 'deepseek' &&
  (config.model === 'deepseek-flash' || /^deepseek-v4-(?:flash(?:-vision-exp)?|pro)$/.test(config.model ?? ''));

const BUSINESS_STAGES = new Set(['requirements', 'requirements:repair', 'planning', 'agent:replan', 'review', 'agent:reviewManuscript', 'revisionReview', 'review-adjudication', 'review-adjudication:repair', 'requestedRevision', 'continuity-review']);
export const isBusinessStage = stage => typeof stage === 'string' && (BUSINESS_STAGES.has(stage) || /^(draft|revision|agent:reviseChapter):[\w-]+$/.test(stage));

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

/** A complete structured plan can exceed the legacy 6K text hint. This changes
 * only the existing no-thinking recovery, never its count or shared deadline. */
export function recoveryTextLimit(stage, requestedTokens) {
  const ceiling = isBusinessStage(stage) ? 32768 : 16000;
  const requested = outputTextLimit(requestedTokens, ceiling);
  return stage === 'planning' || stage === 'agent:replan' ? Math.max(16000, requested) : requested;
}

/** Stage budgets describe the expected text, while V4 counts thinking in the same output limit. */
export function outputTokenLimit(config, requestedTokens = 6000, stage) {
  if (!Number.isFinite(requestedTokens) || requestedTokens <= 0) throw new Error('模型输出预算必须是正数。');
  const thinkingV4 = usesDeepSeekThinking(config);
  // Relevance requests 6000 text tokens; native thinking shares one 32768 total limit.
  if (stage === 'library-relevance') return thinkingV4 ? 32768 : outputTextLimit(requestedTokens, 6000);
  if (!thinkingV4) return Math.min(16000, Math.max(512, Math.ceil(requestedTokens)));
  // Full15 packets need a larger shared thinking + JSON allowance, without
  // changing the budgets of ordinary review, creation or library stages.
  if (isFull15Stage(stage)) return 65536;
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
