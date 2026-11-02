import { validateRevisionEvidencePolicy } from '../../../../creation/runtime/revision-evidence-policy.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0)
  && new Set(value).size === value.length;
const bounded = value => object(value) && value.semanticAccuracyEstablished === false
  && value.automaticAdoption === false && value.literaryPass === 'NOT_ASSESSED';

/** An additional gate only. It never grants adoption or replaces host replay/cross checks. */
export function revisionEvidenceAllowsAdoption({ whole, policy, planItemIds }) {
  const evidence = whole?.quality?.revisionEvidence, savedPolicy = whole?.requestSpec?.revisionEvidencePolicy;
  if (policy === undefined && savedPolicy === undefined && evidence === undefined) return true;
  try {
    if (!validateRevisionEvidencePolicy(policy) || !validateRevisionEvidencePolicy(savedPolicy)
      || !validateRevisionEvidencePolicy(evidence?.policy)) return false;
  } catch { return false; }
  if (evidence.schemaVersion !== 'whole-quality-revision-evidence-1'
    || !bounded(evidence.planFacts) || evidence.planFacts.schemaVersion !== 'revision-plan-fact-result-1'
    || evidence.planFacts.status !== 'clear' || evidence.planFacts.clearForExecution !== true
    || !bounded(evidence.sceneDependencies) || evidence.sceneDependencies.schemaVersion !== 'revision-independent-scene-result-1'
    || !['clear','blocked','incomplete'].includes(evidence.sceneDependencies.status)
    || !strings(evidence.blockedPlanItemIds) || !strings(evidence.sceneDependencies.blockedGroupIds)
    || !strings(evidence.sceneDependencies.unblockedGroupIds)) return false;
  const replacements = whole?.candidateRevision?.replacements;
  if (!Array.isArray(replacements) || replacements.some(item => !object(item) || !strings(item.appliedPlanItemIds) || !item.appliedPlanItemIds.length)) return false;
  const changed = replacements.filter(item => item.sourceQuote !== item.replacement);
  const allIds = [...new Set(changed.flatMap(item => item.appliedPlanItemIds))], ids = planItemIds ?? allIds;
  if (!strings(ids) || !ids.length || ids.some(id => !allIds.includes(id))) return false;
  // CREATION's revisionSceneInput binds each actual replacement to its first
  // applied plan ID. Linked plan items share that same checked scene group.
  const groups = [...new Set(changed.filter(item => item.appliedPlanItemIds.some(id => ids.includes(id)))
    .map(item => item.appliedPlanItemIds[0]))];
  return groups.length > 0 && groups.every(id => !evidence.blockedPlanItemIds.includes(id)
    && !evidence.sceneDependencies.blockedGroupIds.includes(id) && evidence.sceneDependencies.unblockedGroupIds.includes(id));
}
