import { prepareReviewEvidenceAudit } from '../runtime/review-evidence-audit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, unlink, mkdtemp } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { startIndependentReview, readIndependentReviewProgress, getIndependentReviewRequestHash } from '../runtime/independent-review-task.mjs';
import { withLiteraryReadingFocus } from '../runtime/focused-whole-quality-evaluation.mjs';
import { DELIVERY_EVIDENCE_POLICY, prepareEvidenceDelivery } from '../runtime/independent-review-delivery-evidence.mjs';
import { prepareCodexAnchorPacket, resolveCodexAnchorResponse } from '../runtime/independent-review-short-anchors.mjs';
import { createModel } from '../../product/talewick-gui/server/model.mjs';
import { createIndependentReviewAnalyze } from '../../product/talewick-gui/server/independent-review-analyze.mjs';
const output = process.env.TALEWICK_EVIDENCE_OUTPUT ? resolve(process.env.TALEWICK_EVIDENCE_OUTPUT) : await mkdtemp(join(tmpdir(), 'talewick-delivery-evidence-'));
await mkdir(output, { recursive: true });
const sha = x => createHash('sha256').update(x).digest('hex');
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const stages = ['01-reader-1-first', '02-reader-2-first', '03-reader-1-second', '04-reader-2-second', '05-reader-1-pair', '06-reader-2-pair', '07-goal-audit'];
const baseline = [{ id: 'c', title: '门前', body: '甲把伞放在门边，等乙走近。乙说她明日离开，眼睛仍看着门外的雨。甲没有问她的去处。' }];
const candidate = [{ ...baseline[0], body: baseline[0].body + '他把回程车票撕开，留在桌上。' }];
function request() { return withLiteraryReadingFocus({ caseId: 'synthetic-delivery-only', mode: 'compare', baselineChapters: baseline, candidate: { mode: 'revised', chapters: candidate }, goals: [{ id: 'g', statement: '增加选择的后果', claimType: 'editorial_hypothesis', sourceEvidence: [{ chapterId: 'c', quote: baseline[0].body, start: 0 }], counterCase: [{ chapterId: 'c', quote: baseline[0].body, start: 0 }], expectedEffect: '选择可见', failureCriterion: '没有行动', requiredOutcomes: [{ id: 'o', dimension: 'action', description: '新增动作' }] }] }); }
const config = { baseURL: 'https://api.deepseek.com', apiKey: 'synthetic-unused', model: 'deepseek-v4-flash', timeoutMs: 3000 };
function stream(content, i) {
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: `offline-${i}`, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(chunk({ content }) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}
async function replay(name, { enabled = true, mutateRaw, mutateReturn, onProgress, beforeFetch } = {}) {
  const root = join(output, name); await mkdir(root, { recursive: true });
  const calls = []; let runDir;
  // Actual product transport, with the fetch boundary replaced by an in-memory SSE source.
  const model = createModel(config, async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(init.body), decoded = JSON.parse(body.messages[1].content), i = calls.length;
    await beforeFetch?.({ i, runDir, decoded, body });
    const sealedBeforeSend = [];
    for (const id of stages) try { await readFile(join(runDir, 'stages', id, 'sealed.json')); sealedBeforeSend.push(id); } catch {}
    const response = structuredClone(decoded.packet.responseContract.example);
    mutateRaw?.(response, i);
    const raw = JSON.stringify(response);
    calls.push({ stageId: decoded.packet.taskStageId, requestBody: init.body, requestBodySHA256: sha(init.body), sealedBeforeSend, raw });
    return stream(raw, `${name}-${i}`);
  });
  const bridge = createIndependentReviewAnalyze({ model });
  const result = await startIndependentReview({ runRoot: root, request: request(),
    modelCitationMode: 'paragraph_refs_v1', ...(enabled ? { evidencePolicy: DELIVERY_EVIDENCE_POLICY } : {}),
    analyze: async input => { const returned = await bridge(input); mutateReturn?.(returned, calls.length - 1); return returned; },
    onProgress: async event => { if (event.type === 'created') runDir = event.runDir; await onProgress?.(event, runDir); } }).catch(error => { if (name !== 'missing-seal') throw error; return { status: 'rejected', error: { code: error.code, message: error.message } }; });
  await writeFile(join(root, 'fetch-observations.json'), JSON.stringify(calls, null, 2));
  await writeFile(join(root, 'result-summary.json'), JSON.stringify({ status: result.status, error: result.error, runDir, requestHash: result.requestHash, calls: calls.length, externalRequests: 0 }, null, 2));
  return { result, calls, runDir };
}
async function attempt(runDir, id) { const d = join(runDir, 'stages', id, 'attempts'); return join(d, (await readdir(d))[0]); }
function forbiddenKeys(x) { return x && typeof x === 'object' && (Object.keys(x).some(k => ['computedDifferenceAudit', 'supplement', 'priorSeals', 'baseline', 'candidate', 'goals', 'privateBinding'].includes(k)) || Object.values(x).some(forbiddenKeys)); }

test('actual seven-stage runtime + product bridge + product transport seals before reveal, binds UTF8 bytes and preserves raw output', async () => {
  const { result, calls, runDir } = await replay('seven-stage');
  assert.equal(result.status, 'complete', JSON.stringify(result.error)); assert.equal(calls.length, 7);
  await assert.rejects(prepareReviewEvidenceAudit({ sourceReviewTaskId: 'enhanced-case', sourceRunDir: runDir, sourceRequestHash: result.requestHash }),
    { code: 'AUDIT_SOURCE_EVIDENCE_POLICY_UNSUPPORTED' });
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i], body = JSON.parse(c.requestBody), user = JSON.parse(body.messages[1].content);
    assert.deepEqual(c.sealedBeforeSend, stages.slice(0, i));
    if (i < 6) { assert.equal(forbiddenKeys(user), false); assert.doesNotMatch(c.requestBody, /literal-fulltext-difference-audit|changedChapterIds|beforeSHA256/); }
    else { assert.equal(user.supplement.computedDifferenceAudit.allTextIdentical, false); assert.deepEqual(user.supplement.computedDifferenceAudit.changedChapterIds, ['c']); }
    const dir = await attempt(runDir, c.stageId), receipt = await json(join(dir, 'receipt.json')), proof = await json(join(dir, 'delivery-proof.json'));
    assert.equal(await readFile(join(dir, 'raw-response.txt'), 'utf8'), c.raw);
    assert.equal(receipt.requestBodySHA256, sha(c.requestBody));
    assert.equal(receipt.requestBodyByteLength, Buffer.byteLength(c.requestBody));
    assert.equal(receipt.inputHash, user.inputHash); assert.equal(receipt.protocolInputHash, user.inputHash);
    assert.notEqual(receipt.deliveredInputSHA256, receipt.inputHash);
    assert.equal(proof.qualityPass, 'NOT_COMPUTED');
  }
  assert.equal(result.report.literaryPass, 'NOT_COMPUTED'); assert.equal(result.report.automaticAdoption, false);
  assert.equal((await readIndependentReviewProgress({ runDir, requestHash: result.requestHash })).status, 'complete');
});
test('disabled path stays unaugmented and policy changes request identity', async () => {
  const { result, calls, runDir } = await replay('default-off', { enabled: false });
  assert.equal(result.status, 'complete'); assert.equal(calls.length, 7);
  for (const c of calls) assert.doesNotMatch(c.requestBody, /computedDifferenceAudit|本轮通用证据规则/);
  const receipt = await json(join(await attempt(runDir, stages[0]), 'receipt.json'));
  assert.equal(receipt.requestBodySHA256, undefined);
  assert.notEqual(getIndependentReviewRequestHash({ request: request() }), getIndependentReviewRequestHash({ request: request(), evidencePolicy: DELIVERY_EVIDENCE_POLICY }));
});
test('wire receipt mutation blocks sealing, retains raw, and does not dispatch later stages', async () => {
  const { result, calls, runDir } = await replay('bad-receipt', { mutateReturn: returned => { returned.receipt.requestBodySHA256 = '0'.repeat(64); } });
  assert.equal(result.status, 'needs_attention'); assert.equal(result.error.code, 'DELIVERY_EVIDENCE_INVALID'); assert.equal(calls.length, 1);
  const dir = await attempt(runDir, stages[0]); assert.equal(await readFile(join(dir, 'raw-response.txt'), 'utf8'), calls[0].raw);
  await assert.rejects(readFile(join(runDir, 'stages', stages[0], 'sealed.json')));
});
test('missing delivery audit cannot silently downgrade an opted-in task', async () => {
  const { result, calls, runDir } = await replay('missing-delivery', { mutateReturn: returned => { delete returned.deliveryEvidence; } });
  assert.equal(result.status, 'needs_attention'); assert.equal(result.error.code, 'DELIVERY_EVIDENCE_INVALID'); assert.equal(calls.length, 1);
  assert.equal(await readFile(join(await attempt(runDir, stages[0]), 'raw-response.txt'), 'utf8'), calls[0].raw);
});
test('tampered early response prevents goal disclosure even when all six seals exist', async () => {
  const { result, calls } = await replay('corrupt-prior-raw', { onProgress: async (event, runDir) => {
    if (event.type === 'stage_sealed' && event.stageId === stages[5]) await writeFile(join(await attempt(runDir, stages[0]), 'raw-response.txt'), '{}');
  } });
  assert.equal(result.status, 'needs_attention'); assert.equal(calls.length, 6);
  const summary = JSON.parse(await readFile(join(output, 'corrupt-prior-raw', 'result-summary.json')));
  assert.notEqual(summary.error.code, 'PROVIDER_OUTCOME_UNKNOWN');
});
test('failed paragraph reference is retained and never converted into a passing sealed response', async () => {
  const { result, calls, runDir } = await replay('bad-anchor', { mutateRaw: (r, i) => { if (i === 0) r.entries[0].focusAssessments[0].evidence[0].anchorId = 'R9999'; } });
  assert.equal(result.status, 'needs_attention'); assert.equal(calls.length, 1);
  assert.equal(await readFile(join(await attempt(runDir, stages[0]), 'raw-response.txt'), 'utf8'), calls[0].raw);
  assert.match(calls[0].raw, /R9999/); await assert.rejects(readFile(join(runDir, 'stages', stages[0], 'sealed.json')));
});
test('missing sixth seal prevents seventh-stage transport even with six successful replies', async () => {
  const { result, calls } = await replay('missing-seal', { onProgress: async (event, runDir) => {
    if (event.type === 'stage_sealed' && event.stageId === stages[5]) await unlink(join(runDir, 'stages', stages[5], 'sealed.json'));
  } });
  assert.equal(result.status, 'rejected'); assert.equal(result.error.code, 'STAGE_NOT_SEALED'); assert.equal(calls.length, 6);
});
test('completed replay detects saved byte evidence tampering', async () => {
  const { result, runDir } = await replay('tampered-evidence'); assert.equal(result.status, 'complete');
  const p = join(await attempt(runDir, stages[0]), 'delivery-evidence.json'), e = await json(p);
  e.requestBody += ' '; await writeFile(p, JSON.stringify(e));
  assert.equal((await readIndependentReviewProgress({ runDir, requestHash: result.requestHash })).status, 'needs_attention');
});
test('direct early reveal without six proofs is rejected before prompt preparation', () => {
  assert.throws(() => prepareEvidenceDelivery({ stage: 'goal_audit', packet: { taskStageId: stages[6] }, inputHash: 'x', instruction: '合成' },
    { policy: DELIVERY_EVIDENCE_POLICY, stageId: stages[6], protocolInputHash: 'x', priorSeals: [], differenceAudit: {} }));
});
function anchorFixture(body = '甲站在门外。重复。重复。' + '长'.repeat(230) + '乙走近。') {
  const { packet } = prepareCodexAnchorPacket({ caseId: 'short', manuscripts: [{ blindId: 'A', chapters: [{ id: 'c', title: '', body }] }, { blindId: 'B', chapters: [{ id: 'c', title: '', body: '窗边的人放下伞。' }] }], readingFocusDefinitions: [] });
  const a = packet.manuscripts[0].chapters[0].paragraphs[0].anchorId, b = packet.manuscripts[1].chapters[0].paragraphs[0].anchorId;
  const response = { caseId: 'short', manuscriptAssessments: [{ blindId: 'A', assessment: '合成', evidence: [{ anchorId: a, quote: '甲站在门外。' }], counterEvidence: [] }, { blindId: 'B', assessment: '合成', evidence: [{ anchorId: b, quote: '放下伞。' }], counterEvidence: [] }], preference: 'tradeoff', rationale: '不能由引文定位推断文学通过', keyFindings: [] };
  return { packet, response, a, b, promptText: JSON.stringify({ user: JSON.stringify({ packet }) }) };
}
test('short anchors reject wrong anchor, cross boundary, same-anchor ambiguity and duplicate list items; legitimate reuse remains allowed', async () => {
  const records = [];
  for (const [name, change, expected] of [
    ['wrong-anchor', f => { f.response.manuscriptAssessments[0].evidence[0].anchorId = f.b; }, 'WRONG_MANUSCRIPT_ANCHOR'],
    ['cross-boundary', f => { f.response.manuscriptAssessments[0].evidence[0].quote = '长乙'; }, 'QUOTE_NOT_IN_ANCHOR'],
    ['ambiguous', f => { f.response.manuscriptAssessments[0].evidence[0].quote = '重复。'; }, 'QUOTE_AMBIGUOUS_WITHIN_ANCHOR'],
    ['duplicate-list', f => { f.response.manuscriptAssessments[0].evidence.push(structuredClone(f.response.manuscriptAssessments[0].evidence[0])); }, 'DUPLICATE_CITATION_IN_LIST'],
  ]) {
    const f = name === 'cross-boundary' ? anchorFixture('甲站在门外。' + '长'.repeat(234) + '乙') : anchorFixture(); change(f);
    const raw = JSON.stringify(f.response), report = resolveCodexAnchorResponse({ promptText: f.promptText, rawResponse: raw });
    assert.equal(report.passed, false); assert(report.errors.some(e => e.code === expected), JSON.stringify(report));
    assert.equal(report.rawResponseChanged, false); assert.equal(report.derivedResponse, undefined);
    records.push({ name, promptText: f.promptText, rawResponse: raw, report });
  }
  const f = anchorFixture();
  f.response.keyFindings.push({ claimType: 'hard_fact', claim: '合成无依据断言：全体已经离开。', evidence: structuredClone(f.response.manuscriptAssessments[0].evidence), counterEvidence: [], uncertainty: '' });
  const success = resolveCodexAnchorResponse({ promptText: f.promptText, rawResponse: JSON.stringify(f.response) });
  assert.equal(success.passed, true); assert.equal(success.semanticSupportVerified, false); assert.equal(success.qualityPass, 'NOT_COMPUTED');
  records.push({ name: 'valid-reuse-not-semantic-pass', report: success });
  await writeFile(join(output, 'short-anchor-cases.json'), JSON.stringify(records, null, 2));
});
