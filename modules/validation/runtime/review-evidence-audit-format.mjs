import { createHash } from 'node:crypto';

export const AUDIT_CITATION_ALIAS_VERSION = 'citation-check-reason-alias-1';
const PROOF_VERSION = 'review-evidence-audit-citation-alias-proof-1';
const sha = value => createHash('sha256').update(value).digest('hex');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
const hash = value => sha(JSON.stringify(sorted(value)));
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const ensure = (condition, code, JSONPointer) => {
  if (!condition) throw Object.assign(new Error(`${code}${JSONPointer ? ` at ${JSONPointer}` : ''}`), { code, JSONPointer });
};

// No judgment processing, loose JSON parsing, evidence replacement, or model calls.
export function normalizeReviewEvidenceAuditCitations({ prepared, rawResponse } = {}) {
  ensure(prepared?.versions?.protocolVersion === 'review-evidence-audit-1'
    && typeof prepared.requestHash === 'string' && typeof prepared.inputHash === 'string', 'AUDIT_FORMAT_BINDING');
  ensure(typeof rawResponse === 'string', 'AUDIT_FORMAT_RAW');
  const parsed = JSON.parse(rawResponse), response = structuredClone(parsed), mappings = [];
  ensure(object(parsed) && Array.isArray(parsed.assessments), 'AUDIT_FORMAT_RESPONSE', '/assessments');
  for (const [i, assessment] of response.assessments.entries()) {
    const base = `/assessments/${i}/originalCitationSupport/citationChecks`, checks = assessment?.originalCitationSupport?.citationChecks;
    ensure(Array.isArray(checks), 'AUDIT_FORMAT_CITATION_CHECKS', base);
    for (const [j, c] of checks.entries()) {
      const path = `${base}/${j}`;
      ensure(object(c), 'AUDIT_FORMAT_CITATION_FIELDS', path);
      const hasReason = Object.hasOwn(c, 'reason'), hasAlias = Object.hasOwn(c, 'explanation');
      ensure(!(hasReason && hasAlias), 'AUDIT_FORMAT_DUAL_REASON', path);
      const key = hasAlias ? 'explanation' : 'reason';
      ensure(same(Object.keys(c).sort(), ['citationId', 'status', 'basis', key].sort()), 'AUDIT_FORMAT_CITATION_FIELDS', path);
      ensure(typeof c[key] === 'string', 'AUDIT_FORMAT_REASON_TYPE', `${path}/${key}`);
      if (!hasAlias) continue;
      mappings.push({ from: `${path}/explanation`, to: `${path}/reason`, originalValue: c.explanation,
        originalValueSha256: sha(c.explanation) });
      c.reason = c.explanation; delete c.explanation;
    }
  }
  return { response, proof: { schemaVersion: PROOF_VERSION, normalizationVersion: AUDIT_CITATION_ALIAS_VERSION,
    protocolVersion: prepared.versions.protocolVersion, sourceToolVersion: prepared.versions.toolVersion,
    requestHash: prepared.requestHash, inputHash: prepared.inputHash, rawResponseSha256: sha(rawResponse),
    originalParsedSha256: hash(parsed), canonicalResponseSha256: hash(response), mappings } };
}

// Readers must reproduce the whole mapping, never accept an edited proof or derived JSON.
export function verifyReviewEvidenceAuditCitationNormalization({ prepared, rawResponse, response, proof } = {}) {
  const expected = normalizeReviewEvidenceAuditCitations({ prepared, rawResponse });
  ensure(same(proof, expected.proof), 'AUDIT_FORMAT_PROOF_MISMATCH');
  ensure(same(response, expected.response), 'AUDIT_FORMAT_RESPONSE_MISMATCH');
  return expected;
}
