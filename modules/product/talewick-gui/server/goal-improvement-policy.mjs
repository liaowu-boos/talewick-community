export const GOAL_IMPROVEMENT_POLICY_VERSION = 'whole-quality-goal-opportunity-policy-1';

/** Only an explicit new request opts in; omitted historical requests stay omitted. */
export function validateGoalImprovementPolicy(value, request) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'maxOpportunitiesPerGoal,mode,schemaVersion'
    || value.schemaVersion !== GOAL_IMPROVEMENT_POLICY_VERSION || value.mode !== 'assess_incremental'
    || value.maxOpportunitiesPerGoal !== 1 || request.kind !== 'revise' || request.revisionMode !== 'whole-manuscript-v2'
    || !request.writingGoals?.goals?.length) {
    throw Object.assign(new Error('目标增量评估需要整稿修订、明确写作目标和有效的单次评估策略。'), { status: 400, code: 'GOAL_IMPROVEMENT_POLICY_INVALID' });
  }
  return structuredClone(value);
}
