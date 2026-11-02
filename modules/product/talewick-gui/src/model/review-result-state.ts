import type { IndependentReviewTask } from './independent-review.ts';
import type { EvidenceAuditTask } from './review-evidence-audit.ts';
import { independentReviewSnapshotForEvidence, isPartialBlindReport, type IndependentReviewView } from './independent-review-view.ts';

export interface ReviewSourceBinding {
  schemaVersion: 'product-review-source-binding-1';
  reviewTaskId: string;
  requestHash: string;
  sourceReportSha256: string;
}
export interface AnonymousComparisonBinding {
  schemaVersion: 'product-anonymous-comparison-1';
  source: ReviewSourceBinding;
  registrationSHA256: string;
  sharedInputSHA256: string;
  manuscriptSHA256ByBlindId: { A: string; B: string };
}
export interface EventGroundingGate {
  schemaVersion: 'review-evidence-audit-event-grounding-1-gate' | 'review-evidence-audit-event-grounding-2-gate';
  policyVersion: 'event-state-and-time-grounding-1' | 'event-state-and-time-grounding-2';
  status: 'structurally_consistent' | 'needs_review';
  needsReview: boolean;
  issues: { code: string; JSONPointer: string; detail: unknown; severity: string }[];
  proof: { versions: { policyVersion: string; toolVersion: string }; bindingHash: string; targetId: string; targetSHA: string;
    assessmentSHA256: string; eventGroundingSHA256: string; originalAssessmentUnchanged: true; sameDayAndEventStateRemainSemanticClaims: true };
  automaticAdoption: false;
  semanticAccuracy: 'NOT_VERIFIED';
}
export interface ReviewPremiseCoverageGate {
  status: 'structurally_consistent' | 'needs_review';
  needsReview: boolean;
  issues: { code: string; JSONPointer?: string; detail?: unknown; severity?: string }[];
  schemaVersion: 'complete-claim-premise-coverage-1-gate';
  proof: { versions: { policyVersion: 'complete-claim-premise-coverage-1'; toolVersion: string }; bindingHash: string; requestHash: string;
    targetId: string; targetSHA: string; assessmentSHA256: string; eventGroundingSHA256: string; coverageSHA256: string;
    originalAssessmentUnchanged: true; externalCanonicalAndEventGatesRequired: true };
  automaticAdoption: false;
  semanticAccuracy: 'NOT_VERIFIED';
}
/** Host-only projection of the unchanged VALIDATION gate, never a browser POST body. */
export interface ReviewEventGrounding {
  schemaVersion: 'product-event-grounding-projection-1' | 'product-event-grounding-projection-2';
  premiseCoverageRequired?: boolean;
  premiseCoveragePassed?: boolean;
  premiseCoverageGates?: ReviewPremiseCoverageGate[];
  premiseCoverageBinding?: { versions: { policyVersion: 'complete-claim-premise-coverage-1'; toolVersion: string }; bindingHash: string; requestHash: string };
  source: ReviewSourceBinding;
  policyVersion: 'event-state-and-time-grounding-1' | 'event-state-and-time-grounding-2';
  toolVersion: string;
  bindingHash: string;
  registrationHash: string;
  transportVersion: string;
  transportToolVersion: string;
  canonicalAuditComplete: true;
  eventGroundingPassed: boolean;
  completeEvidenceReview: boolean;
  semanticAccuracyProven: false;
  coverage: { expected: number; completed: number; complete: true };
  checks: { targetId: string; targetSHA: string; gate: EventGroundingGate }[];
  automaticAdoption: false;
  semanticAccuracy: 'NOT_VERIFIED';
}

const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function sameReviewSource(a: ReviewSourceBinding | undefined, b: ReviewSourceBinding | undefined, id: string) {
  return !!a && !!b && a.schemaVersion === 'product-review-source-binding-1' && b.schemaVersion === a.schemaVersion
    && a.reviewTaskId === id && b.reviewTaskId === id && sha(a.requestHash) && a.requestHash === b.requestHash
    && sha(a.sourceReportSha256) && a.sourceReportSha256 === b.sourceReportSha256;
}
export function anonymousReviewComparison(task: IndependentReviewTask): boolean {
  const b = task.anonymousComparison;
  return !!b && b.schemaVersion === 'product-anonymous-comparison-1' && task.mode === 'compare'
    && sameReviewSource(task.reviewSourceBinding, b.source, task.id) && sha(b.registrationSHA256) && sha(b.sharedInputSHA256)
    && object(b.manuscriptSHA256ByBlindId) && Object.keys(b.manuscriptSHA256ByBlindId).sort().join(',') === 'A,B'
    && sha(b.manuscriptSHA256ByBlindId.A) && sha(b.manuscriptSHA256ByBlindId.B);
}

/** Legacy absence means not requested; absence on the new projection is never a pass. */
export function premiseCoverageState(p: ReviewEventGrounding) {
  if (p.schemaVersion === 'product-event-grounding-projection-1' && p.premiseCoverageRequired === undefined) return 'not_requested' as const;
  if (p.premiseCoverageRequired === false) return 'not_requested' as const;
  if (p.premiseCoverageRequired !== true || typeof p.premiseCoveragePassed !== 'boolean'
    || !Array.isArray(p.premiseCoverageGates) || !p.premiseCoverageGates.length
    || p.premiseCoverageGates.length !== p.coverage?.expected) return 'missing' as const;
  if (!Array.isArray(p.checks)) return 'invalid_binding' as const;
  const binding = p.premiseCoverageBinding;
  if (!binding) return 'missing' as const;
  if (binding.versions?.policyVersion !== 'complete-claim-premise-coverage-1' || !sha(binding.versions.toolVersion)
    || !sha(binding.bindingHash) || !sha(binding.requestHash)) return 'invalid_binding' as const;
  if (new Set(p.premiseCoverageGates.map(g => g?.proof?.targetId)).size !== p.checks.length) return 'invalid_binding' as const;
  for (const gate of p.premiseCoverageGates) {
    const proof = gate?.proof, event = p.checks.find(c => c.targetId === proof?.targetId);
    if (!proof || !event || gate.schemaVersion !== 'complete-claim-premise-coverage-1-gate'
      || proof.targetSHA !== event.targetSHA || proof.versions?.policyVersion !== binding.versions.policyVersion
      || proof.versions.toolVersion !== binding.versions.toolVersion || proof.bindingHash !== binding.bindingHash
      || proof.requestHash !== binding.requestHash || proof.assessmentSHA256 !== event.gate.proof.assessmentSHA256
      || proof.eventGroundingSHA256 !== event.gate.proof.eventGroundingSHA256 || !sha(proof.coverageSHA256)
      || proof.originalAssessmentUnchanged !== true || proof.externalCanonicalAndEventGatesRequired !== true
      || gate.automaticAdoption !== false || gate.semanticAccuracy !== 'NOT_VERIFIED' || !Array.isArray(gate.issues)) return 'invalid_binding' as const;
  }
  if (!p.premiseCoveragePassed || p.premiseCoverageGates.some(g => g.needsReview !== false || g.status !== 'structurally_consistent')) return 'needs_attention' as const;
  return 'checked' as const;
}

export function eventGroundingState(task: IndependentReviewTask, audit: EvidenceAuditTask) {
  const p = audit.eventGrounding;
  if (!p) return 'not_checked' as const;
  if (audit.sourceReviewTaskId !== task.id || !sameReviewSource(task.reviewSourceBinding, p.source, task.id)
    || !['product-event-grounding-projection-1', 'product-event-grounding-projection-2'].includes(p.schemaVersion) || !['event-state-and-time-grounding-1', 'event-state-and-time-grounding-2'].includes(p.policyVersion)
    || !sha(p.registrationHash) || typeof p.transportVersion !== 'string' || !p.transportVersion || !sha(p.transportToolVersion) || p.canonicalAuditComplete !== true || p.semanticAccuracyProven !== false
    || !sha(p.toolVersion) || !sha(p.bindingHash) || p.automaticAdoption !== false || p.semanticAccuracy !== 'NOT_VERIFIED'
    || !Array.isArray(p.checks) || !p.coverage || p.coverage.complete !== true || !Number.isSafeInteger(p.coverage.expected)
    || p.coverage.expected <= 0 || p.coverage.expected !== p.checks.length || p.coverage.completed !== p.checks.length
    || new Set(p.checks.map(c => c.targetId)).size !== p.checks.length) return 'invalid_binding' as const;
  for (const c of p.checks) {
    const g = c.gate, proof = g?.proof;
    if (!g || g.schemaVersion !== (p.policyVersion === 'event-state-and-time-grounding-1' ? 'review-evidence-audit-event-grounding-1-gate' : 'review-evidence-audit-event-grounding-2-gate') || g.policyVersion !== p.policyVersion
      || !['structurally_consistent', 'needs_review'].includes(g.status) || g.needsReview !== (g.status === 'needs_review')
      || !Array.isArray(g.issues) || g.needsReview !== g.issues.some(i => i.severity === 'error')
      || !proof || proof.targetId !== c.targetId || proof.targetSHA !== c.targetSHA || !sha(c.targetSHA)
      || proof.bindingHash !== p.bindingHash || proof.versions?.policyVersion !== p.policyVersion || proof.versions.toolVersion !== p.toolVersion
      || !sha(proof.assessmentSHA256) || !sha(proof.eventGroundingSHA256) || proof.originalAssessmentUnchanged !== true
      || proof.sameDayAndEventStateRemainSemanticClaims !== true || g.automaticAdoption !== false || g.semanticAccuracy !== 'NOT_VERIFIED') return 'invalid_binding' as const;
  }
  const needsReview = p.checks.some(c => c.gate.needsReview);
  if (p.eventGroundingPassed !== !needsReview || typeof p.completeEvidenceReview !== 'boolean' || needsReview && p.completeEvidenceReview
    || audit.canonicalAuditComplete !== true || audit.completeEvidenceReview !== p.completeEvidenceReview
    || audit.semanticAccuracyProven !== false) return 'invalid_binding' as const;
  const coverageState = premiseCoverageState(p);
  if (coverageState === 'invalid_binding') return 'invalid_binding' as const;
  return needsReview || !p.completeEvidenceReview || ['missing', 'needs_attention'].includes(coverageState) ? 'needs_attention' as const : 'checked' as const;
}

export function reviewResultState(task: IndependentReviewTask, view: IndependentReviewView | null, audits: readonly EvidenceAuditTask[] = []) {
  const partial = isPartialBlindReport(task.partialReport), reportAvailable = Boolean(task.report || partial);
  const complete = reportAvailable && (partial || task.status === 'complete' && task.progress.completedStages === task.progress.totalStages);
  const evidence = view?.evidence ?? [], bound = evidence.filter(e => independentReviewSnapshotForEvidence(view?.snapshots ?? [], e)).length;
  const explicitQuoteFailure = /(?:QUOTE|CITATION|PARAGRAPH_REFERENCE|POSITION_NOT_UNIQUE)/.test(task.error?.code ?? '')
    || audits.some(a => a.sourceReviewTaskId === task.id && /(?:AUDIT_CITATION|QUOTE|ANCHOR_BINDING)/.test(a.error?.code ?? ''));
  const malformed = view?.malformedCitationCount ?? 0;
  const citationBinding = explicitQuoteFailure || malformed > 0 || evidence.length > bound ? 'invalid'
    : evidence.length > 0 ? 'bound' : reportAvailable ? 'incomplete' : 'not_checked';
  const events = audits.map(a => eventGroundingState(task, a));
  const eventSequence = events.includes('invalid_binding') ? 'invalid_binding' : events.includes('needs_attention') ? 'needs_attention'
    : events.includes('checked') ? 'checked' : audits.some(a => a.sourceReviewTaskId === task.id && ['event-state-and-time-grounding-1', 'event-state-and-time-grounding-2'].includes(a.eventGroundingPolicyVersion ?? '') && ['queued', 'running'].includes(a.status)) ? 'pending' : 'not_checked';
  const requiresReview = citationBinding === 'invalid' || ['invalid_binding', 'needs_attention'].includes(eventSequence);
  return { schemaVersion: 'product-review-result-state-1' as const,
    fullTextReading: complete ? 'complete' as const : task.progress.completedStages > 0 ? 'incomplete' as const : 'not_available' as const,
    citationBinding, citations: { displayed: evidence.length, bound, malformed }, eventSequence,
    literaryInterpretation: view?.findings.length ? 'opinions_available' as const : 'not_available' as const,
    requiresReview, qualityPass: false as const, automaticAdoption: false as const };
}
