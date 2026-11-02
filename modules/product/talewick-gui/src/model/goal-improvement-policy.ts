import type { GoalImprovementPolicy } from './types.ts';

export function makeGoalImprovementPolicy(enabled: boolean): GoalImprovementPolicy | undefined {
  return enabled ? { schemaVersion: 'whole-quality-goal-opportunity-policy-1', mode: 'assess_incremental', maxOpportunitiesPerGoal: 1 } : undefined;
}

export function readGoalImprovementPolicy(value: unknown): GoalImprovementPolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(',') === 'maxOpportunitiesPerGoal,mode,schemaVersion'
    && v.schemaVersion === 'whole-quality-goal-opportunity-policy-1' && v.mode === 'assess_incremental' && v.maxOpportunitiesPerGoal === 1
    ? makeGoalImprovementPolicy(true) : undefined;
}
