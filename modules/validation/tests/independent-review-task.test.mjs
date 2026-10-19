import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, cp, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  startIndependentReview,
  resumeIndependentReview,
  readIndependentReviewProgress,
} from '../runtime/independent-review-task.mjs';
import {
  validateWholeQualityProtocolArtifacts,
  wholeQualitySha256,
} from '../runtime/whole-quality-evaluation.mjs';

const baseline = [
  { id: 'ch-1', title: '门口', body: '林遥站在门口。她没有回答母亲的问题。雨水沿着伞骨落下。' },
  { id: 'ch-2', title: '车站', body: '她拿着车票，却仍等母亲替她决定去留。广播响了两遍。' },
];
const candidateChapters = [
  { id: 'ch-1', title: '门口', body: '林遥站在门口，对母亲说：“我自己决定去南城。”雨水沿着伞骨落下。' },
  { id: 'ch-2', title: '车站', body: '她撕掉返程票，独自登上去南城的车。广播响了两遍。' },
];
const goal = {
  id: 'g-agency', statement: '让林遥的离开成为她自己的选择', claimType: 'editorial_hypothesis',
  sourceEvidence: [{ chapterId: 'ch-2', quote: '仍等母亲替她决定去留', start: baseline[1].body.indexOf('仍等母亲替她决定去留') }],
  counterCase: [{ chapterId: 'ch-1', quote: '没有回答母亲的问题', start: baseline[0].body.indexOf('没有回答母亲的问题') }],
  expectedEffect: '读者看见她明确选择并采取行动', failureCriterion: '仍由母亲代为决定，或只有表态没有行动',
  requiredOutcomes: [{ id: 'o-action', dimension: 'action', description: '林遥执行自己的离开决定' }],
};

const singleRequest = chapters => ({ caseId: 'single-case', mode: 'single', baselineChapters: chapters ?? baseline });
const compareRequest = () => ({ caseId: 'compare-case', mode: 'compare', baselineChapters: baseline, candidate: { mode: 'revised', chapters: candidateChapters }, goals: [goal] });
const noChangeRequest = () => ({ caseId: 'no-change-case', mode: 'compare', baselineChapters: baseline, candidate: { mode: 'no_change', chapters: baseline }, goals: [] });

async function withRoot(callback) {
  const root = await mkdtemp(join(tmpdir(), 'independent-review-test-'));
  try { return await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function firstQuote(manuscript) {
  const chapter = manuscript.chapters[0], quote = chapter.body.slice(0, chapter.body.indexOf('。') + 1);
  return { blindId: manuscript.blindId, chapterId: chapter.id, quote, start: null };
}

function responseFor(input) {
  const protocol = input.packet.protocolPacket;
  if (input.stage === 'independent_reading') {
    return { schemaVersion: 'whole-quality-independent-reading-1', packetSha256: protocol.packetSha256, readerId: protocol.readerId,
      entries: [{ blindId: 'M', readScope: 'whole', overallImpression: '完整阅读全文后形成的独立意见。', claims: [{ id: `claim-${protocol.readerId}-${protocol.packetSha256.slice(0, 6)}`, claimType: 'hard_fact', statement: '开篇明确写出人物所处位置。', evidence: [firstQuote(protocol.manuscripts[0])] }] }] };
  }
  if (input.stage === 'blind_pair') {
    return { schemaVersion: protocol.schemaVersion, packetSha256: protocol.packetSha256, readerId: protocol.readerId,
      independentRecordSha256: input.packet.independentRecordSha256, preference: 'no_clear_preference',
      comparisons: [{ id: `comparison-${protocol.readerId}`, claimType: 'editorial_hypothesis', statement: '两稿在主动选择的显性程度上不同。', severeHarm: protocol.schemaVersion.endsWith('-2') ? { status: 'none', blindIds: [], evidence: [] } : false, evidence: protocol.manuscripts.map(firstQuote) }] };
  }
  const baselineManuscript = protocol.baseline, candidateManuscript = protocol.candidate;
  if (protocol.goals.length === 0) return { schemaVersion: 'whole-quality-goal-audit-1', packetSha256: protocol.packetSha256, blindPairRecordSha256s: input.packet.blindPairRecordSha256s, goalAssessments: [] };
  const baselineQuote = { blindId: baselineManuscript.blindId, chapterId: 'ch-2', quote: '仍等母亲替她决定去留', start: null };
  const candidateQuote = { blindId: candidateManuscript.blindId, chapterId: 'ch-2', quote: '独自登上去南城的车', start: null };
  return { schemaVersion: 'whole-quality-goal-audit-1', packetSha256: protocol.packetSha256,
    blindPairRecordSha256s: input.packet.blindPairRecordSha256s,
    goalAssessments: [{ goalId: 'g-agency', status: 'implemented', rationale: '候选把等待他人决定改为本人执行离开。', failureCriterionMet: false,
      outcomes: [{ outcomeId: 'o-action', status: 'implemented', baselineEvidence: [baselineQuote], candidateEvidence: [candidateQuote], explanation: '候选出现了实际登车动作。' }] }] };
}

function fixtureAnalyze({ context = index => `context-${index}`, beforeReturn } = {}) {
  const calls = [];
  const analyze = async input => {
    const index = calls.length; calls.push(structuredClone({ ...input, signal: undefined }));
    await beforeReturn?.(input, index);
    return { outputText: JSON.stringify(responseFor(input)), receipt: { provider: 'fixture', invocationId: `invoke-${index}`, contextId: context(index), inputHash: input.inputHash } };
  };
  return { analyze, calls };
}

function downgradeProtocolArtifacts(bundle, privateBinding) {
  const body = structuredClone(bundle); delete body.bundleSha256; body.schemaVersion = 'whole-quality-evaluation-1';
  body.blindPairPackets = body.blindPairPackets.map(packet => {
    const next = structuredClone(packet); delete next.packetSha256;
    next.schemaVersion = 'whole-quality-blind-pair-1'; delete next.instructions.severeHarmAttributionRequired;
    return { ...next, packetSha256: wholeQualitySha256(next) };
  });
  const legacyBundle = { ...body, bundleSha256: wholeQualitySha256(body) };
  const legacyBinding = { ...privateBinding, schemaVersion: 'whole-quality-private-binding-1', bundleSha256: legacyBundle.bundleSha256 };
  validateWholeQualityProtocolArtifacts({ protocolVersion: legacyBundle.schemaVersion, bundle: legacyBundle, privateBinding: legacyBinding });
  return { legacyBundle, legacyBinding };
}

function recursivelyHasKey(value, forbidden) {
  if (Array.isArray(value)) return value.some(item => recursivelyHasKey(item, forbidden));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => forbidden.has(key) || recursivelyHasKey(item, forbidden));
}

test('single mode seals two independent readings, resolves unique quotes, and never aggregates a literary pass', async () => withRoot(async root => {
  const fixture = fixtureAnalyze(); let created;
  const result = await startIndependentReview({ runRoot: root, request: singleRequest(), analyze: fixture.analyze,
    onProgress: async event => { if (event.type === 'created') { created = event; await stat(join(event.runDir, '..', 'task.json')); } } });
  assert.equal(result.status, 'complete'); assert.equal(fixture.calls.length, 2); assert.ok(created?.runDir);
  assert.deepEqual(fixture.calls.map(call => call.stage), ['independent_reading', 'independent_reading']);
  assert.equal(new Set(fixture.calls.map((_, index) => `context-${index}`)).size, 2);
  assert.equal(result.report.schemaVersion, 'independent-review-single-result-1');
  assert.equal(result.report.readerViews.length, 2); assert.equal(result.report.automaticAdoption, false); assert.equal(result.report.literaryPass, 'NOT_COMPUTED');
  assert.equal(result.report.completionEvidence.disclosurePhase, 'after_all_stages_completed');
  assert.equal(result.report.completionEvidence.manuscript.role, 'baseline');
  assert.equal(result.report.completionEvidence.manuscript.manuscriptSha256, result.report.manuscriptSha256);
  assert.deepEqual(result.report.completionEvidence.manuscript.chapters, baseline);
  for (const stage of ['01-reader-1-single', '02-reader-2-single']) {
    const sealed = JSON.parse(await readFile(join(result.runDir, 'stages', stage, 'sealed.json'), 'utf8'));
    assert.equal(sealed.record.entries[0].claims[0].evidence[0].start, 0);
    assert.equal(sealed.positionResolution.entries.length, 1);
  }
}));

test('compare mode runs exactly four isolated single reads, two blind pairs, then one goal audit', async () => withRoot(async root => {
  const fixture = fixtureAnalyze();
  const result = await startIndependentReview({ runRoot: root, request: compareRequest(), analyze: fixture.analyze });
  assert.equal(result.status, 'complete', JSON.stringify(result.error)); assert.equal(fixture.calls.length, 7);
  assert.deepEqual(fixture.calls.map(call => call.stage), ['independent_reading', 'independent_reading', 'independent_reading', 'independent_reading', 'blind_pair', 'blind_pair', 'goal_audit']);
  assert.equal(new Set(fixture.calls.map((_, index) => `context-${index}`)).size, 7);
  const forbidden = new Set(['bindings', 'baseline', 'candidate', 'goals', 'goalPacket', 'privateBinding', 'role', 'completionEvidence', 'manuscriptBindings']);
  fixture.calls.slice(0, 6).forEach(call => assert.equal(recursivelyHasKey(call.packet, forbidden), false));
  fixture.calls.forEach(call => { assert.match(call.instruction, /闭合 JSON Schema/); assert.match(call.instruction, /结构示例/); });
  const firstHashes = fixture.calls.slice(0, 2).map(call => call.packet.protocolPacket.manuscripts[0].manuscriptSha256);
  assert.notEqual(firstHashes[0], firstHashes[1], 'reader order must be reversed');
  assert.equal(result.report.adoptionBoundary, 'eligible_for_editorial_consideration');
  assert.equal(result.report.schemaVersion, 'whole-quality-evaluation-result-2');
  assert.equal(result.report.automaticAdoption, false); assert.equal(result.report.literaryPass, 'NOT_COMPUTED');
  assert.equal(result.report.divergentReadings.preferenceDivergence, false);
  const evidence = result.report.completionEvidence;
  assert.equal(evidence.schemaVersion, 'independent-review-compare-completion-evidence-2');
  assert.equal(evidence.disclosurePhase, 'after_all_stages_completed');
  assert.equal(evidence.independentReadings.length, 2); assert.equal(evidence.blindPairReviews.length, 2);
  assert.equal(evidence.independentReadings.every(item => item.record.entries.length === 2), true);
  assert.deepEqual(evidence.independentReadings.map(item => item.recordSha256), result.report.evidenceTrace.independentRecordSha256s);
  assert.deepEqual(evidence.blindPairReviews.map(item => item.recordSha256), result.report.evidenceTrace.pairRecordSha256s);
  assert.equal(evidence.goalAudit.recordSha256, result.report.evidenceTrace.goalRecordSha256);
  assert.equal(evidence.goalAudit.record.goalAssessments.length, 1);
  assert.deepEqual(evidence.frozenGoals, [goal]);
  assert.equal(evidence.frozenGoals[0].statement, '让林遥的离开成为她自己的选择');
  assert.equal(evidence.frozenGoals[0].expectedEffect, '读者看见她明确选择并采取行动');
  assert.equal(evidence.frozenGoals[0].failureCriterion, '仍由母亲代为决定，或只有表态没有行动');
  assert.deepEqual(evidence.frozenGoals[0].requiredOutcomes, goal.requiredOutcomes);
  assert.deepEqual(new Set(Object.keys(evidence.manuscriptBindings)), new Set(['A', 'B']));
  for (const snapshot of Object.values(evidence.manuscriptBindings)) {
    const expected = snapshot.role === 'baseline' ? baseline : candidateChapters;
    assert.deepEqual(snapshot.chapters, expected);
    assert.equal(snapshot.blindId === 'A' || snapshot.blindId === 'B', true);
  }
}));

test('a v2 task cannot resume with a self-consistent v1 bundle and private binding', async () => withRoot(async root => {
  const initial = fixtureAnalyze({ beforeReturn: () => { throw Object.assign(new Error('not sent'), { definitelyNotDispatched: true }); } });
  const interrupted = await startIndependentReview({ runRoot: root, request: compareRequest(), analyze: initial.analyze });
  assert.equal(interrupted.status, 'interrupted'); assert.equal(initial.calls.length, 1);
  const bundlePath = join(interrupted.runDir, 'controller', 'bundle.json');
  const bindingPath = join(interrupted.runDir, 'controller', 'private-binding.json');
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
  const privateBinding = JSON.parse(await readFile(bindingPath, 'utf8'));
  const { legacyBundle, legacyBinding } = downgradeProtocolArtifacts(bundle, privateBinding);
  await writeFile(bundlePath, `${JSON.stringify(legacyBundle, null, 2)}\n`);
  await writeFile(bindingPath, `${JSON.stringify(legacyBinding, null, 2)}\n`);
  let resumeCalls = 0;
  const resumed = await resumeIndependentReview({ runDir: interrupted.runDir, requestHash: interrupted.requestHash, analyze: async () => { resumeCalls += 1; } });
  assert.equal(resumed.status, 'needs_attention');assert.equal(resumed.error.code, 'TASK_PROTOCOL_BINDING');assert.equal(resumeCalls, 0);
  assert.equal((await readIndependentReviewProgress({ runDir: interrupted.runDir, requestHash: interrupted.requestHash })).error.code, 'TASK_PROTOCOL_BINDING');
}));

test('completed v2 reports cannot be read as v1 result and completion evidence', async () => withRoot(async root => {
  const fixture = fixtureAnalyze();
  const completed = await startIndependentReview({ runRoot: root, request: compareRequest(), analyze: fixture.analyze });
  assert.equal(completed.status, 'complete');assert.equal(fixture.calls.length, 7);
  const resultPath = join(completed.runDir, 'result.json'), report = JSON.parse(await readFile(resultPath, 'utf8'));
  report.schemaVersion = 'whole-quality-evaluation-result-1';
  report.completionEvidence.schemaVersion = 'independent-review-compare-completion-evidence-1';
  await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  const read = await readIndependentReviewProgress({ runDir: completed.runDir, requestHash: completed.requestHash });
  assert.equal(read.status, 'needs_attention');assert.equal(read.error.code, 'TASK_PROTOCOL_BINDING');assert.deepEqual(read.report, report);
  report.schemaVersion = 'whole-quality-evaluation-result-2'; delete report.completionEvidence;
  await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  const missingCompletion = await readIndependentReviewProgress({ runDir: completed.runDir, requestHash: completed.requestHash });
  assert.equal(missingCompletion.status, 'needs_attention');assert.equal(missingCompletion.error.code, 'TASK_PROTOCOL_BINDING');
}));

test('completion evidence and identity bindings do not exist before all seven compare stages finish', async () => withRoot(async root => {
  const initial = fixtureAnalyze({ beforeReturn: (_input, index) => {
    if (index === 6) throw Object.assign(new Error('goal audit was not sent'), { definitelyNotDispatched: true });
  } });
  const interrupted = await startIndependentReview({ runRoot: root, request: compareRequest(), analyze: initial.analyze });
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.progress.completedStages, 6); assert.equal(interrupted.report, null);
  assert.equal(initial.calls.slice(0, 6).some(call => recursivelyHasKey(call.packet, new Set(['bindings', 'baseline', 'candidate', 'goals', 'role', 'completionEvidence', 'manuscriptBindings']))), false);
  await assert.rejects(stat(join(interrupted.runDir, 'result.json')), error => error.code === 'ENOENT');
  const resumed = await resumeIndependentReview({ runDir: interrupted.runDir, requestHash: interrupted.requestHash,
    analyze: fixtureAnalyze({ context: index => `goal-resume-context-${index}` }).analyze });
  assert.equal(resumed.status, 'complete', JSON.stringify(resumed.error));
  assert.equal(resumed.report.completionEvidence.disclosurePhase, 'after_all_stages_completed');
}));

test('a real no-change control still runs seven stages and cannot assert quality gain', async () => withRoot(async root => {
  const fixture = fixtureAnalyze();
  const result = await startIndependentReview({ runRoot: root, request: noChangeRequest(), analyze: fixture.analyze });
  assert.equal(result.status, 'complete', JSON.stringify(result.error)); assert.equal(fixture.calls.length, 7);
  assert.equal(result.report.adoptionBoundary, 'no_change'); assert.equal(result.report.goalFulfillment, 'not_applicable');
  assert.equal(result.report.qualityGain, 'NO_QUALITY_GAIN_ASSERTED'); assert.equal(result.report.divergentReadings.preferenceDivergence, false);
  assert.deepEqual(result.report.completionEvidence.frozenGoals, []);
}));

test('a definitely-not-dispatched interruption resumes, while an unknown provider outcome never auto-resends', async () => withRoot(async root => {
  let calls = 0;
  const interrupted = await startIndependentReview({ runRoot: root, request: singleRequest(), analyze: async () => {
    calls += 1; throw Object.assign(new Error('socket rejected before write'), { code: 'NOT_SENT', definitelyNotDispatched: true });
  } });
  assert.equal(interrupted.status, 'interrupted'); assert.equal(calls, 1);
  const fixture = fixtureAnalyze();
  const resumed = await resumeIndependentReview({ runDir: interrupted.runDir, requestHash: interrupted.requestHash, analyze: fixture.analyze });
  assert.equal(resumed.status, 'complete'); assert.equal(fixture.calls.length, 2);

  const secondRoot = await mkdtemp(join(root, 'unknown-'));
  let unknownCalls = 0;
  const unknown = await startIndependentReview({ runRoot: secondRoot, request: singleRequest(), analyze: async () => { unknownCalls += 1; throw new Error('connection outcome unknown'); } });
  assert.equal(unknown.status, 'needs_attention');
  const after = await resumeIndependentReview({ runDir: unknown.runDir, requestHash: unknown.requestHash, analyze: async () => { unknownCalls += 1; } });
  assert.equal(after.status, 'needs_attention'); assert.equal(unknownCalls, 1);
}));

test('a crash after a persisted dispatch is immediately needs-attention and is never resent', async () => withRoot(async root => {
  const interrupted = await startIndependentReview({ runRoot: root, request: singleRequest(), analyze: async () => {
    throw Object.assign(new Error('not sent'), { definitelyNotDispatched: true });
  } });
  const events = join(interrupted.runDir, '..', 'events.ndjson');
  await appendFile(events, `${JSON.stringify({ at: new Date().toISOString(), type: 'dispatch_started', stageId: '01-reader-1-single', stage: 'independent_reading', attemptId: 'crashed-attempt', inputHash: '0'.repeat(64) })}\n`);
  const snapshot = await readIndependentReviewProgress({ runDir: interrupted.runDir, requestHash: interrupted.requestHash });
  assert.equal(snapshot.status, 'needs_attention'); assert.equal(snapshot.error.code, 'PROVIDER_OUTCOME_UNKNOWN');
  let calls = 0;
  const resumed = await resumeIndependentReview({ runDir: interrupted.runDir, requestHash: interrupted.requestHash, analyze: async () => { calls += 1; } });
  assert.equal(resumed.status, 'needs_attention'); assert.equal(calls, 0);
}));

test('a valid seal survives a crash before stage_sealed and resumes without repeating the model call', async () => withRoot(async root => {
  const initial = fixtureAnalyze({ beforeReturn: (_input, index) => {
    if (index === 1) throw Object.assign(new Error('second stage was not sent'), { definitelyNotDispatched: true });
  } });
  const interrupted = await startIndependentReview({ runRoot: root, request: singleRequest(), analyze: initial.analyze });
  assert.equal(interrupted.status, 'interrupted'); assert.equal(initial.calls.length, 2);
  const eventsPath = join(interrupted.runDir, '..', 'events.ndjson');
  const lines = (await readFile(eventsPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  await writeFile(eventsPath, `${lines.filter(event => !(event.type === 'stage_sealed' && event.stageId === '01-reader-1-single')).map(event => JSON.stringify(event)).join('\n')}\n`);
  const resumedFixture = fixtureAnalyze({ context: index => `resumed-context-${index}` });
  const resumed = await resumeIndependentReview({ runDir: interrupted.runDir, requestHash: interrupted.requestHash, analyze: resumedFixture.analyze });
  assert.equal(resumed.status, 'complete', JSON.stringify(resumed.error)); assert.equal(resumedFixture.calls.length, 1);
  const recoveredEvents = (await readFile(eventsPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(recoveredEvents.some(event => event.type === 'stage_sealed' && event.stageId === '01-reader-1-single' && event.recoveredFromSeal === true), true);
}));

test('a seal with mismatched receipt evidence is blocked and never resent', async () => withRoot(async root => {
  const initial = fixtureAnalyze({ beforeReturn: (_input, index) => {
    if (index === 1) throw Object.assign(new Error('second stage was not sent'), { definitelyNotDispatched: true });
  } });
  const interrupted = await startIndependentReview({ runRoot: root, request: singleRequest(), analyze: initial.analyze });
  const eventsPath = join(interrupted.runDir, '..', 'events.ndjson');
  const lines = (await readFile(eventsPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  await writeFile(eventsPath, `${lines.filter(event => !(event.type === 'stage_sealed' && event.stageId === '01-reader-1-single')).map(event => JSON.stringify(event)).join('\n')}\n`);
  const seal = JSON.parse(await readFile(join(interrupted.runDir, 'stages', '01-reader-1-single', 'sealed.json'), 'utf8'));
  const receiptPath = join(interrupted.runDir, 'stages', '01-reader-1-single', 'attempts', seal.attemptId, 'receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')); receipt.inputHash = '0'.repeat(64);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  let calls = 0;
  const resumed = await resumeIndependentReview({ runDir: interrupted.runDir, requestHash: interrupted.requestHash, analyze: async () => { calls += 1; } });
  assert.equal(resumed.status, 'needs_attention'); assert.equal(resumed.error.code, 'PERSISTED_STAGE_SEAL_INVALID'); assert.equal(calls, 0);
}));

test('context reuse blocks the second stage and keeps the first seal', async () => withRoot(async root => {
  const fixture = fixtureAnalyze({ context: () => 'same-context' });
  const result = await startIndependentReview({ runRoot: root, request: singleRequest(), analyze: fixture.analyze });
  assert.equal(result.status, 'needs_attention'); assert.equal(result.progress.completedStages, 1); assert.equal(fixture.calls.length, 2);
  assert.equal(result.error.code, 'PROVIDER_CONTEXT_REUSED');
  const resumed = await resumeIndependentReview({ runDir: result.runDir, requestHash: result.requestHash, analyze: fixture.analyze });
  assert.equal(resumed.status, 'needs_attention'); assert.equal(fixture.calls.length, 2);
}));

test('ambiguous quote resolution rejects the response and preserves raw and resolution evidence', async () => withRoot(async root => {
  const chapters = [{ id: 'ch-1', title: '重复', body: '重复。重复。' }];
  let call;
  const result = await startIndependentReview({ runRoot: root, request: singleRequest(chapters), analyze: async input => {
    call = input;
    const response = responseFor(input); response.entries[0].claims[0].evidence[0] = { blindId: 'M', chapterId: 'ch-1', quote: '重复', start: null };
    return { outputText: JSON.stringify(response), receipt: { provider: 'fixture', invocationId: 'ambiguous', contextId: 'ambiguous-context', inputHash: input.inputHash } };
  } });
  assert.ok(call); assert.equal(result.status, 'needs_attention'); assert.equal(result.error.code, 'QUOTE_POSITION_NOT_UNIQUE');
  const attempts = await readdir(join(result.runDir, 'stages', '01-reader-1-single', 'attempts'));
  const dir = join(result.runDir, 'stages', '01-reader-1-single', 'attempts', attempts[0]);
  assert.match(await readFile(join(dir, 'raw-response.txt'), 'utf8'), /重复/);
  const failure = JSON.parse(await readFile(join(dir, 'position-resolution-failure.json'), 'utf8'));
  assert.equal(failure.entries[0].matchCount, 2);
}));

test('late return after cancellation is retained but never sealed', async () => withRoot(async root => {
  const controller = new AbortController();
  const fixture = fixtureAnalyze({ beforeReturn: () => controller.abort() });
  const result = await startIndependentReview({ runRoot: root, request: singleRequest(), analyze: fixture.analyze, signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.progress.completedStages, 0); assert.equal(fixture.calls.length, 1);
  assert.equal(await readIndependentReviewProgress({ runDir: result.runDir, requestHash: result.requestHash }).then(value => value.status), 'cancelled');
}));

test('request hash, persisted request, and tool versions make old results stale without mutating the report', async () => withRoot(async root => {
  const fixture = fixtureAnalyze();
  const result = await startIndependentReview({ runRoot: root, request: singleRequest(), analyze: fixture.analyze });
  assert.equal(result.status, 'complete');
  const stale = await readIndependentReviewProgress({ runDir: result.runDir, requestHash: '0'.repeat(64) });
  assert.equal(stale.status, 'stale'); assert.deepEqual(stale.report, result.report);

  const savedRequestPath = join(result.runDir, '..', 'request.json');
  const savedRequest = JSON.parse(await readFile(savedRequestPath, 'utf8'));
  savedRequest.baselineChapters[0].body += '篡改';
  await writeFile(savedRequestPath, `${JSON.stringify(savedRequest, null, 2)}\n`);
  const requestStale = await readIndependentReviewProgress({ runDir: result.runDir, requestHash: result.requestHash });
  assert.equal(requestStale.status, 'stale'); assert.deepEqual(requestStale.report, result.report);

  const secondRoot = await mkdtemp(join(root, 'version-'));
  const versioned = await startIndependentReview({ runRoot: secondRoot, request: singleRequest(), analyze: fixtureAnalyze({ context: index => `version-context-${index}` }).analyze });
  const taskPath = join(versioned.runDir, '..', 'task.json');
  const task = JSON.parse(await readFile(taskPath, 'utf8')); task.versions.toolVersion = '0'.repeat(64);
  await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`);
  const versionStale = await readIndependentReviewProgress({ runDir: versioned.runDir, requestHash: versioned.requestHash });
  assert.equal(versionStale.status, 'stale'); assert.deepEqual(versionStale.report, versioned.report);
}));
