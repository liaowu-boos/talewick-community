import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(JSON.stringify(canonical(value)));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function reviewSourceBinding(task) {
  if (!task?.id || !hash(task.requestHash) || !task.report) return undefined;
  return { schemaVersion: 'product-review-source-binding-1', reviewTaskId: task.id,
    requestHash: task.requestHash, sourceReportSha256: digest(task.report) };
}

/** Select a native replay by the protocol exported by that module. Never down-convert v3. */
async function nativeBoundTransport(version) {
  const legacy = await import('../../../validation/runtime/review-evidence-audit-bound.mjs');
  if (version === legacy.BOUND_AUDIT_VERSION) return { assemble: legacy.assembleBoundReviewEvidenceAudit, premiseCoverageRequired: false };
  let current;
  try { current = await import('../../../validation/runtime/review-evidence-audit-bound-v3.mjs'); }
  catch (cause) { throw Object.assign(new Error('AUDIT_NATIVE_TRANSPORT_UNAVAILABLE'), { code: 'AUDIT_NATIVE_TRANSPORT_UNAVAILABLE', cause }); }
  assert.equal(version, current.BOUND_AUDIT_VERSION, 'AUDIT_NATIVE_TRANSPORT_UNSUPPORTED');
  return { assemble: current.assembleBoundReviewEvidenceAudit, premiseCoverageRequired: true };
}

/** Read-only projection: replay the registered transport with its own strict assembler.
 * Missing batches, bounded regressions and changed source reports never yield a complete display.
 * This does not create a product task, replace a seal, dispatch a model or accept a browser verdict. */
export async function projectBoundReviewEvidenceAudit({ sourceTask, boundPrepared, responses, savedAssembly, assembleBound }) {
  const source = reviewSourceBinding(sourceTask); assert(source, 'REVIEW_SOURCE_REQUIRED');
  const prepared = boundPrepared?.compact?.canonicalPrepared, binding = prepared?.binding;
  assert.equal(binding?.sourceReviewTaskId, source.reviewTaskId, 'AUDIT_SOURCE_TASK_BINDING');
  assert.equal(binding?.sourceRequestHash, source.requestHash, 'AUDIT_SOURCE_REQUEST_BINDING');
  assert.equal(binding?.sourceReportSha256, source.sourceReportSha256, 'AUDIT_SOURCE_REPORT_BINDING');
  // Loaded only for this new transport. Reading an old task does not require the optional module.
  const native = await nativeBoundTransport(boundPrepared.registration?.versions?.version);
  // Optional SERVER-ONLY closure from readWithProof: that read has already
  // rechecked every source/seal/raw byte and replayed this exact native protocol.
  // Its closure rejects any different prepared/responses. Never accept it from HTTP.
  const replay = assembleBound === undefined ? native.assemble : assembleBound;
  assert.equal(typeof replay, 'function', 'AUDIT_ASSEMBLER_REQUIRED');
  const assembly = replay({ boundPrepared, responses });
  const transport = boundPrepared.registration?.versions;
  assert.equal(typeof transport?.version, 'string'); assert(hash(transport.sourceSHA256));
  assert.equal(assembly.schemaVersion, `${transport.version}-assembled`, 'AUDIT_TRANSPORT_VERSION_BINDING');
  assert.equal(assembly.registrationHash, boundPrepared.registrationHash, 'AUDIT_REGISTRATION_BINDING');
  assert.equal(assembly.canonicalAuditComplete, true);
  assert.equal(typeof assembly.completeEvidenceReview, 'boolean');
  assert.equal(assembly.automaticAdoption, false); assert.equal(assembly.semanticAccuracyProven, false);
  if (savedAssembly !== undefined) assert.deepEqual(assembly, savedAssembly, 'AUDIT_SAVED_ASSEMBLY_CHANGED');
  // A missing optional layer is legacy-only. The new protocol must provide its own gates.
  if (native.premiseCoverageRequired) {
    const coverage = boundPrepared.coveragePrepared;
    assert(coverage && boundPrepared.eventPrepared && boundPrepared.registration.enablePremiseCoverage === true, 'AUDIT_PREMISE_COVERAGE_REQUIRED');
    assert(Array.isArray(assembly.premiseCoverageGates), 'AUDIT_PREMISE_COVERAGE_MISSING');
    assert.equal(typeof assembly.premiseCoveragePassed, 'boolean', 'AUDIT_PREMISE_COVERAGE_MISSING');
    assert.equal(coverage.input.requestHash, prepared.requestHash);
    assert.deepEqual(coverage.input.targets, prepared.packet.targets);
    assert.deepEqual(coverage.input.manuscripts, prepared.packet.manuscripts);
    assert.equal(assembly.premiseCoverageGates.length, prepared.packet.targets.length);
    assert.equal(new Set(assembly.premiseCoverageGates.map(g => g.proof.targetId)).size, prepared.packet.targets.length);
    for (const target of prepared.packet.targets) {
      const gate = assembly.premiseCoverageGates.find(g => g.proof.targetId === target.targetId);
      const eventGate = assembly.eventGates.find(g => g.proof.targetId === target.targetId);
      assert(gate && eventGate, 'AUDIT_COVERAGE_TARGET_BINDING');
      assert.equal(gate.schemaVersion, `${coverage.versions.policyVersion}-gate`);
      assert.deepEqual(gate.proof.versions, coverage.versions);
      assert.equal(gate.proof.bindingHash, coverage.bindingHash);
      assert.equal(gate.proof.requestHash, prepared.requestHash);
      assert.equal(gate.proof.targetSHA, target.targetSHA);
      assert.equal(gate.proof.assessmentSHA256, eventGate.proof.assessmentSHA256);
      assert.equal(gate.proof.eventGroundingSHA256, eventGate.proof.eventGroundingSHA256);
      assert(hash(gate.proof.coverageSHA256));
      assert.equal(gate.proof.originalAssessmentUnchanged, true);
      assert.equal(gate.proof.externalCanonicalAndEventGatesRequired, true);
      assert.equal(gate.automaticAdoption, false); assert.equal(gate.semanticAccuracy, 'NOT_VERIFIED');
    }
    assert.equal(assembly.premiseCoveragePassed, assembly.premiseCoverageGates.every(g => !g.needsReview));
    assert.equal(assembly.completeEvidenceReview, assembly.canonicalAuditComplete && assembly.eventGroundingPassed === true
      && assembly.premiseCoveragePassed, 'AUDIT_THREE_LAYER_COMPLETION');
  }
  const event = boundPrepared.eventPrepared;
  const display = { sourceReviewTaskId: source.reviewTaskId,
    status: assembly.completeEvidenceReview ? 'complete' : 'needs_attention',
    report: structuredClone(assembly.canonical.result), targets: structuredClone(prepared.packet.targets),
    auditPolicyVersion: prepared.versions.policyVersion,
    canonicalAuditComplete: assembly.canonicalAuditComplete,
    completeEvidenceReview: assembly.completeEvidenceReview,
    semanticAccuracyProven: assembly.semanticAccuracyProven,
    automaticAdoption: assembly.automaticAdoption };
  if (event) {
    assert.deepEqual(event.manuscripts, prepared.packet.manuscripts, 'AUDIT_MANUSCRIPT_BINDING');
    const checks = prepared.packet.targets.map(target => {
      const gate = assembly.eventGates.find(g => g.proof.targetId === target.targetId);
      assert(gate && gate.proof.targetSHA === target.targetSHA, 'AUDIT_EVENT_TARGET_BINDING');
      assert.equal(gate.proof.bindingHash, event.bindingHash, 'AUDIT_EVENT_TEXT_BINDING');
      assert.deepEqual(gate.proof.versions, event.versions, 'AUDIT_EVENT_VERSION_BINDING');
      return { targetId: target.targetId, targetSHA: target.targetSHA, gate: structuredClone(gate) };
    });
    assert.equal(checks.length, assembly.eventGates.length);
    display.eventGroundingPolicyVersion = event.versions.policyVersion;
    display.eventGrounding = { schemaVersion: 'product-event-grounding-projection-2', source,
      premiseCoverageRequired: native.premiseCoverageRequired,
      ...(native.premiseCoverageRequired ? { premiseCoverageGates: structuredClone(assembly.premiseCoverageGates), premiseCoveragePassed: assembly.premiseCoveragePassed,
        premiseCoverageBinding: { versions: structuredClone(boundPrepared.coveragePrepared.versions), bindingHash: boundPrepared.coveragePrepared.bindingHash, requestHash: prepared.requestHash } } : {}),
      registrationHash: assembly.registrationHash, transportVersion: transport.version, transportToolVersion: transport.sourceSHA256, policyVersion: event.versions.policyVersion,
      toolVersion: event.versions.toolVersion, bindingHash: event.bindingHash,
      canonicalAuditComplete: assembly.canonicalAuditComplete,
      eventGroundingPassed: assembly.eventGroundingPassed, completeEvidenceReview: assembly.completeEvidenceReview,
      semanticAccuracyProven: assembly.semanticAccuracyProven,
      coverage: { expected: checks.length, completed: checks.length, complete: true },
      checks, automaticAdoption: false, semanticAccuracy: 'NOT_VERIFIED' };
  }
  return { assembly, display };
}

/** Consume the coordinator's frozen same-input provenance, returning only anonymous metadata.
 * The caller verifies referenced source-file bytes/receipts; no filesystem paths or identity map
 * enter the public projection or the review request. This function performs no I/O or dispatch. */
export async function anonymousComparisonBinding({ sourceTask, snapshots, comparisonPrepared,
  registrationBytes, sharedInputBytes, armInputSHA256 }) {
  const source = reviewSourceBinding(sourceTask); assert(source, 'REVIEW_SOURCE_REQUIRED');
  const p = comparisonPrepared, provenance = p?.privateProvenance;
  assert.equal(p?.schemaVersion, 'new-review-entry-1');
  assert.equal(provenance?.kind, 'same-input-two-model-comparison');
  const { getIndependentReviewRequestHash } = await import('../../../validation/runtime/independent-review-task.mjs');
  assert.equal(getIndependentReviewRequestHash({ request: p.request, modelCitationMode: p.modelCitationMode }), p.requestHash, 'COMPARISON_REQUEST_CHANGED');
  assert.equal(p.requestHash, source.requestHash, 'COMPARISON_SOURCE_BINDING');
  assert.equal(p.request.mode, 'compare');
  const registrationSHA256 = sha(registrationBytes), sharedInputSHA256 = sha(sharedInputBytes);
  assert.equal(registrationSHA256, provenance.registrationSHA256, 'REGISTRATION_CHANGED');
  assert.equal(sharedInputSHA256, provenance.sharedInputSHA256, 'SHARED_INPUT_CHANGED');
  assert(Array.isArray(provenance.sourceFiles) && [registrationSHA256, sharedInputSHA256].every(h => provenance.sourceFiles.some(f => f.sha256 === h)), 'PROVENANCE_SOURCE_BINDING');
  assert.deepEqual(armInputSHA256, [sharedInputSHA256, sharedInputSHA256], 'SHARED_INPUT_MISMATCH');
  assert(Array.isArray(snapshots) && snapshots.length === 2);
  assert.deepEqual(snapshots.map(s => s.blindId).sort(), ['A', 'B']);
  assert.deepEqual(snapshots.map(s => s.role).sort(), ['baseline', 'candidate']);
  for (const snapshot of snapshots) {
    const bound = sourceTask.report.completionEvidence?.manuscriptBindings?.[snapshot.blindId];
    assert(bound && bound.blindId === snapshot.blindId && bound.role === snapshot.role, 'ANONYMOUS_MANUSCRIPT_BINDING');
    assert.deepEqual(snapshot.chapters, bound.chapters, 'ANONYMOUS_MANUSCRIPT_BINDING');
    const chapters = snapshot.role === 'baseline' ? p.request.baselineChapters : p.request.candidate.chapters ?? p.request.baselineChapters;
    assert.deepEqual(snapshot.chapters, chapters, 'COMPARISON_MANUSCRIPT_BINDING');
  }
  return { schemaVersion: 'product-anonymous-comparison-1', source, registrationSHA256, sharedInputSHA256,
    manuscriptSHA256ByBlindId: Object.fromEntries(snapshots.map(s => [s.blindId, digest(s.chapters)])) };
}
