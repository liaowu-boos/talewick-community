export const REVISION_EVIDENCE_POLICY_VERSION = 'whole-quality-revision-evidence-policy-1';
export const REVISION_EVIDENCE_VERSION = 'whole-quality-revision-evidence-1';

/** Absence is intentional: never retrofit independent checks onto a saved task. */
export function validateRevisionEvidencePolicy(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || value.schemaVersion !== REVISION_EVIDENCE_POLICY_VERSION
    || value.mode !== 'required') {
    throw Object.assign(new Error('修订依据策略须为已知版本的 required，不能包含额外字段。'),
      { code: 'WHOLE_QUALITY_REVISION_EVIDENCE_POLICY' });
  }
  return structuredClone(value);
}
