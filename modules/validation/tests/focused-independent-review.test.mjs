import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  READING_FOCUS_VERSION, withLiteraryReadingFocus, getLiteraryReadingFocusDefinitions,
  prepareWholeQualityEvaluation, validateStandaloneIndependentReading, validateBlindPairReview,
  validateGoalAudit, wholeQualitySha256,
} from '../runtime/focused-whole-quality-evaluation.mjs';
import {
  startIndependentReview, resumeIndependentReview, normalizeIndependentReviewRequest,
  getIndependentReviewVersions, buildIndependentReviewPartialReport, recoverIndependentReviewPositions,
} from '../runtime/independent-review-task.mjs';

const chapters = [
  { id: 'ch-1', title: '门口', body: '林遥站在门口，把母亲递来的伞放回木架，想了一会儿，还是没有回答那个关于去留的问题。雨慢慢停了。' },
  { id: 'ch-2', title: '车站', body: '她拿着两张车票，一直等到广播第二次响起，才把回程那张收进衣袋，转身向售票窗口走去。' },
];
const basic = () => ({ caseId: 'generic-literary-fixture', mode: 'compare', baselineChapters: structuredClone(chapters), candidate: { mode: 'no_change', chapters: structuredClone(chapters) }, goals: [] });
const focus = () => withLiteraryReadingFocus(basic());
async function scoped(fn) { const root = await mkdtemp(join(tmpdir(), 'focused-review-')); try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); } }
const snapshot = async root => {
  const out = {};
  async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else out[path] = createHash('sha256').update(await readFile(path)).digest('hex'); } }
  await walk(root); return out;
};
function fixture(mutate = () => {}) {
  const calls = [];
  return { calls, analyze: async input => {
    calls.push(structuredClone({ ...input, signal: undefined }));
    const record = structuredClone(input.packet.responseContract.example);
    // Fixtures exercise the public response contract, not literary judgments.
    mutate(record, input, calls.length);
    return { outputText: JSON.stringify(record), receipt: { provider: 'local-fixture', invocationId: `fixture-${calls.length}`, contextId: `context-${calls.length}`, inputHash: input.inputHash } };
  } };
}
function hasForbidden(value) {
  if (Array.isArray(value)) return value.some(hasForbidden);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => ['bindings', 'baseline', 'candidate', 'goals', 'goalPacket', 'privateBinding', 'role', 'materials', 'diagnosis'].includes(key) || hasForbidden(child));
}

test('opt-in canonicalizes and hashes fixed focus definitions without mutating caller; legacy default remains v2', async () => {
  const request = basic(), before = structuredClone(request), enriched = withLiteraryReadingFocus(request);
  assert.deepEqual(request, before);
  assert.equal(enriched.readingFocusVersion, READING_FOCUS_VERSION);
  assert.deepEqual(enriched, normalizeIndependentReviewRequest(enriched));
  assert.deepEqual(normalizeIndependentReviewRequest({ ...request, readingFocusVersion: READING_FOCUS_VERSION }), enriched);
  assert.notEqual(wholeQualitySha256(request), wholeQualitySha256(enriched));
  assert.deepEqual(normalizeIndependentReviewRequest(request), request);
  assert.equal((await getIndependentReviewVersions()).protocolVersion, 'whole-quality-evaluation-2');
  assert.match((await getIndependentReviewVersions()).toolVersion, /^[a-f0-9]{64}$/);
  assert.equal((await getIndependentReviewVersions('whole-quality-evaluation-3')).protocolVersion, 'whole-quality-evaluation-3');
  enriched.readingFocusDefinitions[0].title = 'caller mutation';
  assert.notEqual(getLiteraryReadingFocusDefinitions()[0].title, 'caller mutation');
  assert.throws(() => normalizeIndependentReviewRequest(enriched), { code: 'READING_FOCUS_DEFINITIONS' });
  assert.throws(() => normalizeIndependentReviewRequest({ ...request, readingFocusVersion: 'future' }), { code: 'READING_FOCUS_VERSION' });
  assert.throws(() => withLiteraryReadingFocus({ ...request, readingFocusDefinitions: getLiteraryReadingFocusDefinitions() }), { code: 'READING_FOCUS_VERSION' });
  const reordered = focus(); reordered.readingFocusDefinitions.reverse();
  assert.throws(() => normalizeIndependentReviewRequest(reordered), { code: 'READING_FOCUS_DEFINITIONS' });
});

test('new compare executes 4 isolated + 2 reversed pair + 1 goal; all six focuses and quote guidance are recorded and hash-bound', async () => scoped(async root => {
  const f = fixture((record, input) => {
    if (input.stage === 'independent_reading') {
      record.entries[0].focusAssessments.forEach(item => { item.counterEvidence = structuredClone(item.evidence); item.evidence[0].start = null; });
    }
  });
  const result = await startIndependentReview({ runRoot: root, request: focus(), analyze: f.analyze });
  assert.equal(result.status, 'complete', JSON.stringify(result.error)); assert.equal(f.calls.length, 7);
  assert.equal(result.versions.protocolVersion, 'whole-quality-evaluation-3');
  assert.equal(result.report.schemaVersion, 'whole-quality-evaluation-result-3');
  assert.equal(result.report.automaticAdoption, false); assert.equal(result.report.literaryPass, 'NOT_COMPUTED');
  for (const call of f.calls.slice(0, 6)) {
    assert.equal(hasForbidden(call.packet), false);
    assert.equal(call.packet.protocolPacket.readingFocusVersion, READING_FOCUS_VERSION);
    assert.deepEqual(call.packet.protocolPacket.readingFocusDefinitions, getLiteraryReadingFocusDefinitions());
    assert.match(call.instruction, /20–80/); assert.match(call.instruction, /不能拼接或省略/);
    assert.equal(call.inputHash, wholeQualitySha256({ stage: call.stage, packet: call.packet, instruction: call.instruction }));
    if (call.stage === 'independent_reading') assert.equal(call.packet.protocolPacket.manuscripts.length, 1);
  }
  assert.deepEqual(f.calls[4].packet.protocolPacket.instructions.order, [...f.calls[5].packet.protocolPacket.instructions.order].reverse());
  const evidence = result.report.completionEvidence;
  assert.equal(evidence.schemaVersion, 'independent-review-compare-completion-evidence-3');
  for (const { record } of evidence.independentReadings) for (const entry of record.entries) {
    assert.equal(entry.focusAssessments.length, 6); assert.equal(entry.claims.length, 0);
    for (const item of entry.focusAssessments) {
      assert.equal(item.claimType, 'editorial_hypothesis'); assert.ok(item.uncertainty);
      for (const cite of [...item.evidence, ...item.counterEvidence]) { assert.equal(cite.blindId, entry.blindId); assert.equal(cite.start, 0); }
    }
  }
  for (const { record } of evidence.blindPairReviews) { assert.equal(record.comparisons.length, 6); assert.equal(record.preference, 'no_clear_preference'); }
  assert.equal((await resumeIndependentReview({ runDir: result.runDir, requestHash: result.requestHash, analyze: () => { throw Error('must not rerun'); } })).status, 'complete');
}));

test('six literary observations reject missing, duplicate, factual, unbalanced, fabricated and scored responses', async () => scoped(async root => {
  const f = fixture(), result = await startIndependentReview({ runRoot: root, request: focus(), analyze: f.analyze });
  assert.equal(result.status, 'complete');
  const packet = f.calls[0].packet.protocolPacket, base = f.calls[0].packet.responseContract.example;
  const check = (edit, code) => { const record = structuredClone(base); edit(record.entries[0].focusAssessments, record); assert.throws(() => validateStandaloneIndependentReading(packet, record), { code }); };
  check(items => items.pop(), 'FOCUS_ASSESSMENT_COVERAGE');
  check(items => { items[1].focusId = items[0].focusId; }, 'FOCUS_ASSESSMENT');
  check(items => { items[0].claimType = 'hard_fact'; }, 'FOCUS_ASSESSMENT');
  check(items => { items[0].uncertainty = ' '; }, 'FOCUS_EVIDENCE_OR_UNCERTAINTY');
  check(items => { items[0].evidence = []; }, 'FOCUS_EVIDENCE_OR_UNCERTAINTY');
  check(items => { items[0].counterEvidence = [{ ...items[0].evidence[0], quote: '并不存在的反例' }]; }, 'FOCUS_EVIDENCE_QUOTE');
  check(items => { items[0].counterEvidence = [{ ...items[0].evidence[0], blindId: 'A' }]; }, 'FOCUS_BLIND_ID');
  check(items => { items[0].score = 10; }, 'SCORE_OR_VOTE_FORBIDDEN');
  const changedPacket = structuredClone(packet); changedPacket.readingFocusDefinitions[0].description = 'specific diagnosis'; delete changedPacket.packetSha256; changedPacket.packetSha256 = wholeQualitySha256(changedPacket);
  assert.throws(() => validateStandaloneIndependentReading(changedPacket, { ...base, packetSha256: changedPacket.packetSha256 }), { code: 'READING_FOCUS_DEFINITIONS' });
  const { publicBundle } = prepareWholeQualityEvaluation(focus());
  const pair = structuredClone(f.calls[4].packet.responseContract.example); pair.comparisons[0].evidence.pop();
  assert.throws(() => validateBlindPairReview(publicBundle, pair), { code: 'FOCUS_TWO_SIDED_EVIDENCE' });
}));

test('new mode preserves failed goal and returns strictly read-only six-stage partial; implemented unchanged still rejects', async () => scoped(async root => {
  const request = focus(); request.goals = [{ id: 'g', statement: '相对基线加强选择及代价', claimType: 'editorial_hypothesis', sourceEvidence: [{ chapterId: 'ch-1', quote: chapters[0].body, start: 0 }], counterCase: [{ chapterId: 'ch-2', quote: chapters[1].body, start: 0 }], expectedEffect: '新增行动后果', failureCriterion: '没有新增', requiredOutcomes: [{ id: 'o', dimension: 'action', description: '新增代价' }] }];
  const f = fixture((record, input) => { if (input.stage === 'goal_audit') { record.goalAssessments[0].status = 'implemented'; record.goalAssessments[0].failureCriterionMet = false; record.goalAssessments[0].outcomes[0].status = 'implemented'; } });
  const result = await startIndependentReview({ runRoot: root, request, analyze: f.analyze });
  assert.equal(result.status, 'needs_attention'); assert.equal(result.error.code, 'IMPLEMENTED_WITHOUT_CHANGE_EVIDENCE');
  const before = await snapshot(dirname(result.runDir));
  const partial = await buildIndependentReviewPartialReport({ runDir: result.runDir, requestHash: result.requestHash });
  assert.equal(partial.completeBlindReview, true); assert.equal(partial.completedTaskStages, 6); assert.equal(partial.goalAuditStatus, 'needs_attention'); assert.equal(partial.automaticAdoption, false);
  assert.deepEqual(await snapshot(dirname(result.runDir)), before);
  const { publicBundle } = prepareWholeQualityEvaluation(request), goalRecord = structuredClone(f.calls[6].packet.responseContract.example);
  goalRecord.goalAssessments[0].status = 'not_applicable'; goalRecord.goalAssessments[0].failureCriterionMet = false;
  goalRecord.goalAssessments[0].outcomes[0].status = 'not_applicable';
  assert.equal(validateGoalAudit(publicBundle, goalRecord).ok, true);
}));

test('v3 position-only repair retains six-focus judgments and uses exact candidates; sealed stages never repeat', async () => scoped(async root => {
  const request = withLiteraryReadingFocus({ caseId: 'duplicate-focus', mode: 'single', baselineChapters: [{ id: 'ch', title: '重复', body: '她站着。窗开了。她站着。门关了。' }] });
  const f = fixture((record, input, index) => { if (index === 1) record.entries[0].focusAssessments[0].evidence[0] = { blindId: 'M', chapterId: 'ch', quote: '她站着。', start: null }; });
  const result = await startIndependentReview({ runRoot: root, request, analyze: f.analyze });
  assert.equal(result.error.code, 'QUOTE_POSITION_NOT_UNIQUE');
  let repairCalls = 0;
  const recovered = await recoverIndependentReviewPositions({ runDir: result.runDir, requestHash: result.requestHash, mode: 'position_repair', analyzePositionRepair: async input => {
    repairCalls++;
    const problem = input.packet.invalidCitations[0]; assert.deepEqual(problem.exactCandidates.map(item => item.start), [0, 8]);
    return { outputText: JSON.stringify({ repairs: [{ JSONPointer: problem.JSONPointer, quote: problem.quote, start: 8 }] }), receipt: { provider: 'fixture', invocationId: 'repair', contextId: 'repair-only', inputHash: input.inputHash } };
  } });
  assert.equal(recovered.status, 'queued', JSON.stringify(recovered.error)); assert.equal(repairCalls, 1);
  const seal = JSON.parse(await readFile(join(result.runDir, 'stages/01-reader-1-single/sealed.json')));
  const expected = structuredClone(f.calls[0].packet.responseContract.example); expected.entries[0].focusAssessments[0].evidence[0] = { blindId: 'M', chapterId: 'ch', quote: '她站着。', start: 8 };
  assert.deepEqual(seal.record, expected);
  const next = fixture(); const resumed = await resumeIndependentReview({ runDir: result.runDir, requestHash: result.requestHash, analyze: async input => { const r = await next.analyze(input); r.receipt.contextId = 'last-stage'; return r; } });
  assert.equal(resumed.status, 'complete', JSON.stringify(resumed.error)); assert.equal(next.calls.length, 1);
}));
