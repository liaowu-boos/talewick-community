// Reuse the host validators. Readers never add options to saved requests.
import { validateWritingGoals } from '../../../../creation/runtime/writing-goals.mjs';
import { REVISION_EVIDENCE_POLICY_VERSION, validateRevisionEvidencePolicy } from '../../../../creation/runtime/revision-evidence-policy.mjs';

export function readWritingGoals(value, chapters) {
  try { return validateWritingGoals(value, chapters); }
  catch { return undefined; }
}

export function makeRevisionEvidencePolicy() {
  return validateRevisionEvidencePolicy({ schemaVersion: REVISION_EVIDENCE_POLICY_VERSION, mode: 'required' });
}

export function readRevisionEvidencePolicy(value) {
  try { return validateRevisionEvidencePolicy(value); }
  catch { return undefined; }
}
