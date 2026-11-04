import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, readdir, unlink, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as audit from '../runtime/review-evidence-audit.mjs';
import * as review from '../runtime/independent-review-task.mjs';
import * as quality from '../runtime/focused-whole-quality-evaluation.mjs';
import { normalizeReviewEvidenceAuditCitations, verifyReviewEvidenceAuditCitationNormalization } from '../runtime/review-evidence-audit-format.mjs';
import { PREMISE_SUPPORT_POLICY, PREMISE_DIMENSIONS } from '../runtime/review-evidence-audit-premises.mjs';

globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
const temp = async () => realpath(await mkdtemp(join(tmpdir(), 'review-evidence-audit-test-')));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const sha = text => createHash('sha256').update(text).digest('hex');
const copy = value => structuredClone(value);
const chapters = [
  { id: 'ch-1', title: '到家', body: '下午三点，我在门口下车。\r\n\r\n她说：“钱已经付清。”\n\n我没有看到转账记录。\n\n' + '空白与中文😀'.repeat(150) },
  { id: 'ch-2', title: '留下', body: '天亮后，她拒绝签字，把工牌放在桌上。\n\n经理把延期三个月写进第二栏。\n\n她推开门走进雨里。' },
];
const request = { caseId: 'evidence-audit-offline-controls', mode: 'compare', baselineChapters: chapters,
  candidate: { mode: 'no_change', chapters },
  goals: [{ id: 'g1', statement: '相对原稿新增选择代价。', claimType: 'editorial_hypothesis',
    sourceEvidence: [{ chapterId: 'ch-2', quote: '天亮后，她拒绝签字，把工牌放在桌上。', start: 0 }],
    counterCase: [{ chapterId: 'ch-1', quote: '下午三点，我在门口下车。', start: 0 }],
    expectedEffect: '新增可见后果。', failureCriterion: '全文未变化。', requiredOutcomes: [{ id: 'o1', dimension: 'action', description: '新增后果。' }] }],
  readingFocusVersion: quality.READING_FOCUS_VERSION, readingFocusDefinitions: quality.getLiteraryReadingFocusDefinitions() };
let fixture;
async function sourceFixture() {
  if (fixture) return fixture;
  let calls = 0;
  const runRoot = await temp();
  const result = await review.startIndependentReview({ runRoot, request, modelCitationMode: 'paragraph_refs_v1',
    analyze: async args => {
      const response = copy(args.packet.responseContract.example); calls++;
      if (args.stage === 'independent_reading') {
        response.entries[0].overallImpression = '原阅读整体印象保持不动。';
        for (const focus of response.entries[0].focusAssessments) {
          if (focus.focusId === 'middle_late_pacing') focus.statement = '第四至十章整体节奏持续加快。';
          if (focus.focusId === 'scene_explanation') focus.statement = '全文都是动作描写而没有解释。';
          if (focus.focusId === 'choice_cost') focus.statement = '她声称已付款，因此事实上钱已付清。';
        }
        const cited = copy(response.entries[0].focusAssessments[0].evidence[0]);
        response.entries[0].claims = [{ id: 'claim-payment', claimType: 'hard_fact', statement: '她已经付清钱。', evidence: [cited] }];
      }
      return { outputText: JSON.stringify(response), receipt: { provider: 'offline-fixture', invocationId: `fixture-${calls}`,
        contextId: `fixture-${calls}`, inputHash: args.inputHash } };
    } });
  assert.equal(result.status, 'complete', JSON.stringify(result.error)); assert.equal(calls, 7);
  const prepared = await audit.prepareReviewEvidenceAudit({ sourceReviewTaskId: 'trusted-source-task', sourceRunDir: result.runDir, sourceRequestHash: result.requestHash });
  fixture = { ...result, prepared, sourceCalls: calls }; return fixture;
}

function uncertainResponse(prepared) {
  return { schemaVersion: 'review-evidence-audit-1-response', requestHash: prepared.requestHash,
    assessments: prepared.packet.targets.map(t => ({ targetId: t.targetId, targetSHA: t.targetSHA,
      originalCitationSupport: { status: 'uncertain', reason: '离线测试不代替真实语义判断。', supportedScope: null, limits: '需要独立真实复核。',
        citationChecks: t.originalCitations.map(c => ({ citationId: c.citationId, status: 'uncertain', basis: 'editorial_interpretation', reason: '保留不确定性。' })) },
      wholeTextCheck: { status: 'uncertain', reason: '仅测试协议，不作文学结论。', supportedScope: null, limits: '模型可能误读。', evidence: [], counterEvidence: [], mechanicalFactsUsed: [] } })) };
}
function validate(prepared, response) { return audit.validateReviewEvidenceAuditResponse({ prepared, response, rawResponse: JSON.stringify(response) }); }
const expectCode = (fn, code) => assert.throws(fn, error => error.code === code, code);
function anchor(prepared, blindId, chapterId, includes) {
  return prepared.packet.manuscripts.find(m => m.blindId === blindId).chapters.find(c => c.id === chapterId)
    .paragraphs.find(p => p.text.includes(includes) && p.citable).anchorId;
}
const ref = (anchorId, basis = 'narrated_action') => ({ anchorId, basis, explanation: '仅说明这处明确写出的动作，不外推其它事实。' });
async function hashes(dir, prefix = '') {
  const result = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) Object.assign(result, await hashes(join(dir, e.name), `${prefix}${e.name}/`));
    else result[`${prefix}${e.name}`] = sha(await readFile(join(dir, e.name)));
  }
  return result;
}

test('prepare strictly replays seven sealed stages, covers claims and all six dimensions, preserves original bytes and full text', async () => {
  const f = await sourceFixture(), before = await hashes(dirname(f.runDir));
  const p = await audit.prepareReviewEvidenceAudit({ sourceReviewTaskId: 'trusted-source-task', sourceRunDir: f.runDir, sourceRequestHash: f.requestHash });
  assert.deepEqual(await hashes(dirname(f.runDir)), before);
  assert.equal(p.packet.targets.length, 46); // 4 overall + 4 claims + 24 focus + 12 pair + 2 goal.
  assert.equal(p.binding.stages.length, 7); assert.equal(Object.keys(p.binding.sourceFileHashes).length, 90);
  assert.equal(Object.isFrozen(p.packet.targets[0].original), true);
  for (const manuscript of p.packet.manuscripts) for (const ch of manuscript.chapters) {
    assert.equal(ch.paragraphs.map(x => x.text).join(''), chapters.find(c => c.id === ch.id).body);
  }
  assert.match(p.instruction, /全文找得到依据也不能追认原引文充分/);
  assert.match(p.instruction, /同段确实相关可同时支持不同主张/);
  assert.match(p.instruction, /人物说/);
  assert.equal(p.packet.mechanicalFacts.identical_manuscripts, true);
  assert.deepEqual(p, f.prepared);
});

test('adverse semantic fixture: opener cannot substantiate later pacing; separate full-text evidence cannot rehabilitate original citations', async () => {
  const { prepared: p } = await sourceFixture(), response = uncertainResponse(p);
  const target = p.packet.targets.find(t => t.stageId === '01-reader-1-first' && t.original.focusId === 'middle_late_pacing');
  const item = response.assessments.find(a => a.targetId === target.targetId);
  item.originalCitationSupport = { status: 'unsupported', reason: '开头下车没有第四至十章节奏信息；该稿只有两章。', supportedScope: '仅开头下车动作。', limits: '章节范围也不成立。',
    citationChecks: target.originalCitations.map(c => ({ citationId: c.citationId, status: 'unsupported', basis: 'narrated_action', reason: '准确引文只证明到达，不支持跨章节奏。' })) };
  item.wholeTextCheck = { status: 'unsupported', reason: '全文只有两章，无法支持第四至十章的主张。', supportedScope: null, limits: '不据此否定读者的一切感受。', evidence: [],
    counterEvidence: [ref(anchor(p, target.allowedBlindIds[0], 'ch-2', '天亮'))], mechanicalFactsUsed: [] };
  const checked = validate(p, response).result;
  const found = checked.assessments.find(a => a.targetId === target.targetId);
  assert.equal(found.originalCitationSupport.status, 'unsupported'); assert.equal(found.wholeTextCheck.status, 'unsupported');
  assert.equal(checked.automaticAdoption, false); assert.equal(checked.literaryPass, 'NOT_COMPUTED');
  assert.equal(checked.originalReviewUnchanged, true); assert.equal(checked.voteResult, null);
  assert.equal(p.packet.targets.find(t => t.targetId === target.targetId).original.statement, '第四至十章整体节奏持续加快。');
});

test('local action permits partial scope; full-text support remains a different axis', async () => {
  const { prepared: p } = await sourceFixture(), response = uncertainResponse(p);
  const t = p.packet.targets.find(t => t.original.focusId === 'scene_explanation'), item = response.assessments.find(a => a.targetId === t.targetId);
  item.originalCitationSupport.status = 'partial'; item.originalCitationSupport.supportedScope = '仅开场是动作描写。';
  item.originalCitationSupport.reason = '局部动作不能证明全篇无解释。';
  item.wholeTextCheck = { status: 'supported', reason: '这是用于测试两栏独立存储的预置判断，不是模型实测结论。', supportedScope: '第二章存在动作。', limits: '仅该局部，不外推全篇。',
    evidence: [ref(anchor(p, t.allowedBlindIds[0], 'ch-2', '天亮'))], counterEvidence: [], mechanicalFactsUsed: [] };
  const a = validate(p, response).result.assessments.find(a => a.targetId === t.targetId);
  assert.equal(a.originalCitationSupport.status, 'partial'); assert.equal(a.wholeTextCheck.status, 'supported');
  assert.equal(a.wholeTextCheck.evidence[0].chapterId, 'ch-2');
});

test('same paragraph may support multiple different claims; no artificial chapter-count rule', async () => {
  const { prepared: p } = await sourceFixture(), response = uncertainResponse(p);
  const targets = p.packet.targets.filter(t => t.stageId === '01-reader-1-first').slice(1, 3);
  for (const t of targets) {
    const a = response.assessments.find(a => a.targetId === t.targetId);
    a.wholeTextCheck = { status: 'partial', reason: '该段同时含拒绝签字和放下工牌两个动作。', supportedScope: '仅这两个动作。', limits: '不能独自证明全文或最终动机。',
      evidence: [ref(anchor(p, t.allowedBlindIds[0], 'ch-2', '天亮'))], counterEvidence: [], mechanicalFactsUsed: [] };
  }
  const validated = validate(p, response);
  assert.equal(validated.proof.mappings.length, 2);
  assert.equal(validated.proof.mappings[0].anchorId, validated.proof.mappings[1].anchorId);
});

test('character statement is retained as a statement, not promoted to established payment; basis is mandatory', async () => {
  const { prepared: p } = await sourceFixture(), response = uncertainResponse(p);
  const t = p.packet.targets.find(t => t.kind === 'claim'), a = response.assessments.find(a => a.targetId === t.targetId);
  a.wholeTextCheck = { status: 'uncertain', reason: '人物说付清，但叙述者没有看到凭证；说法和已支付事实不同。', supportedScope: '存在付清的口头说法。', limits: '实际支付状态未证实。',
    evidence: [ref(anchor(p, t.allowedBlindIds[0], 'ch-1', '她说'), 'character_statement')],
    counterEvidence: [ref(anchor(p, t.allowedBlindIds[0], 'ch-1', '没有看到'), 'narrator_inference')], mechanicalFactsUsed: [] };
  const mapped = validate(p, response).result.assessments.find(a => a.targetId === t.targetId);
  assert.equal(mapped.wholeTextCheck.status, 'uncertain'); assert.equal(mapped.wholeTextCheck.evidence[0].basis, 'character_statement');
  delete a.wholeTextCheck.evidence[0].basis;
  expectCode(() => validate(p, response), 'AUDIT_CITATION_FIELDS');
});

test('full coverage of targets and original citations is mandatory; no omissions, duplicates or inserted preference', async () => {
  const { prepared: p } = await sourceFixture();
  let r = uncertainResponse(p); r.assessments.pop(); expectCode(() => validate(p, r), 'AUDIT_TARGET_COVERAGE');
  r = uncertainResponse(p); r.assessments[1] = copy(r.assessments[0]); expectCode(() => validate(p, r), 'AUDIT_TARGET_BINDING');
  r = uncertainResponse(p); r.assessments[1].targetSHA = '0'.repeat(64); expectCode(() => validate(p, r), 'AUDIT_TARGET_BINDING');
  r = uncertainResponse(p); r.assessments[1].originalCitationSupport.citationChecks = []; expectCode(() => validate(p, r), 'AUDIT_ORIGINAL_COVERAGE');
  r = uncertainResponse(p); r.preference = 'candidate'; expectCode(() => validate(p, r), 'AUDIT_RESPONSE_FIELDS');
  r = uncertainResponse(p); r.assessments[0].originalCitationSupport.status = 'supported'; r.assessments[0].originalCitationSupport.supportedScope = '全部';
  expectCode(() => validate(p, r), 'AUDIT_ORIGINAL_SUPPORT_WITHOUT_CITATION');
});

test('reject unknown/wrong manuscript IDs, free quote or fabricated mechanical support; exact quotes still not automatic truth', async () => {
  const { prepared: p } = await sourceFixture();
  const t = p.packet.targets[0];
  const cases = [
    [ref('R999999'), 'AUDIT_CITATION_BINDING'],
    [ref(anchor(p, t.allowedBlindIds[0] === 'A' ? 'B' : 'A', 'ch-1', '下午')), 'AUDIT_CITATION_BINDING'],
    [{ ...ref(anchor(p, t.allowedBlindIds[0], 'ch-1', '下午')), quote: '伪造引文' }, 'AUDIT_CITATION_FIELDS'],
  ];
  for (const [e, code] of cases) { const r = uncertainResponse(p); r.assessments[0].wholeTextCheck.evidence = [e]; expectCode(() => validate(p, r), code); }
  let r = uncertainResponse(p); r.assessments[0].wholeTextCheck.mechanicalFactsUsed = ['identical_manuscripts']; expectCode(() => validate(p, r), 'AUDIT_MECHANICAL_FACT');
  r = uncertainResponse(p); r.assessments[0].wholeTextCheck.status = 'supported'; r.assessments[0].wholeTextCheck.supportedScope = '全部'; expectCode(() => validate(p, r), 'AUDIT_WHOLE_SUPPORT_WITHOUT_EVIDENCE');
  r = uncertainResponse(p); const index = p.packet.targets.findIndex(t => t.kind === 'goal_outcome');
  r.assessments[index].wholeTextCheck = { status: 'supported', reason: '全文相同无新增。', supportedScope: '没有文本增量。', limits: '不代表文学高低。', evidence: [], counterEvidence: [], mechanicalFactsUsed: ['identical_manuscripts'] };
  assert.equal(validate(p, r).result.assessments[index].wholeTextCheck.evidence.length, 0);
});

test('raw and prepared bindings reject changed task, manuscript, original opinion, seal, input, missing evidence', async () => {
  const { prepared: p } = await sourceFixture(), r = uncertainResponse(p);
  expectCode(() => audit.validateReviewEvidenceAuditResponse({ prepared: p, response: r, rawResponse: JSON.stringify({ ...r, requestHash: 'wrong' }) }), 'AUDIT_RESPONSE_RAW_BINDING');
  for (const mutate of [
    p => { p.sourceSnapshot.sourceReviewTaskId = 'different-task'; },
    p => { p.packet.targets[0].original.statement = '被篡改的原意见'; },
    p => { p.sourceSnapshot.files['run/stages/01-reader-1-first/sealed.json'] = p.sourceSnapshot.files['run/stages/01-reader-1-first/sealed.json'].replace('afternoon-never', 'x') + ' '; },
    p => { p.sourceSnapshot.files['request.json'] = p.sourceSnapshot.files['request.json'].replace('下午三点', '下午四点'); },
    p => { const key = Object.keys(p.sourceSnapshot.files).find(k => k.endsWith('/raw-response.txt')); p.sourceSnapshot.files[key] += ' '; },
    p => { delete p.sourceSnapshot.files['run/stages/07-goal-audit/sealed.json']; },
  ]) {
    const changed = copy(p); mutate(changed);
    assert.throws(() => validate(changed, r));
  }
});

test('source import relocation changes only physical metadata paths; source binding and strict replay stay identical', async () => {
  const f = await sourceFixture(), root = await temp(), parent = join(root, 'relocated');
  await cp(dirname(f.runDir), parent, { recursive: true });
  const metaPath = join(parent, 'task.json'), meta = await json(metaPath);
  meta.runRoot = root; meta.runDir = join(parent, 'run'); await writeFile(metaPath, JSON.stringify(meta));
  const prepared = await audit.prepareReviewEvidenceAudit({ sourceReviewTaskId: 'trusted-source-task', sourceRunDir: meta.runDir, sourceRequestHash: f.requestHash });
  assert.deepEqual(prepared, f.prepared);
  meta.createdAt = 'tampered'; await writeFile(metaPath, JSON.stringify(meta));
  await assert.rejects(() => audit.prepareReviewEvidenceAudit({ sourceReviewTaskId: 'trusted-source-task', sourceRunDir: meta.runDir, sourceRequestHash: f.requestHash }), e => e.code === 'AUDIT_SOURCE_METADATA');
});

test('one injected audit invocation, all originals preserved; complete result replay and moved audit are strictly read-only', async () => {
  const f = await sourceFixture(), root = await temp(), before = await hashes(dirname(f.runDir)); let calls = 0;
  const analyze = async args => { calls++; assert.equal(args.stage, 'review_evidence_audit'); assert.equal(args.inputHash, f.prepared.inputHash);
    assert.equal(args.packet.sourceSnapshot, undefined);
    return { rawResponse: JSON.stringify(uncertainResponse(f.prepared)), receipt: { provider: 'offline', invocationId: 'audit-1', contextId: 'audit-1', inputHash: args.inputHash } }; };
  const done = await audit.runReviewEvidenceAudit({ prepared: f.prepared, runRoot: root, analyze }); assert.equal(done.status, 'complete');
  const auditBefore = await hashes(done.runDir);
  assert.deepEqual(await audit.readReviewEvidenceAudit(done), done);
  assert.equal((await audit.runReviewEvidenceAudit({ prepared: f.prepared, runRoot: root, analyze })).status, 'complete');
  assert.equal(calls, 1); assert.deepEqual(await hashes(dirname(f.runDir)), before); assert.deepEqual(await hashes(done.runDir), auditBefore);
  const moved = join(await temp(), 'moved'); await cp(done.runDir, moved, { recursive: true });
  assert.equal((await audit.readReviewEvidenceAudit({ runDir: moved, requestHash: done.requestHash })).status, 'complete');
  assert.deepEqual(await hashes(moved), auditBefore);
});

test('atomic claim: concurrent callers dispatch at most once; unknown outcome cannot be resent', async () => {
  const { prepared } = await sourceFixture(), runRoot = await temp(); let calls = 0, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const analyze = async args => { calls++; await gate; return { rawResponse: JSON.stringify(uncertainResponse(prepared)),
    receipt: { provider: 'offline', invocationId: 'concurrent', contextId: 'concurrent', inputHash: args.inputHash } }; };
  let failed;
  const first = audit.runReviewEvidenceAudit({ prepared, runRoot, analyze }).catch(error => { failed = error; });
  for (let i = 0; i < 200 && !calls && !failed; i++) await new Promise(resolve => setTimeout(resolve, 5));
  if (failed) throw failed;
  assert.equal(calls, 1);
  const second = await audit.runReviewEvidenceAudit({ prepared, runRoot, analyze });
  assert.equal(second.status, 'needs_attention'); assert.equal(second.error.code, 'AUDIT_PROVIDER_OUTCOME_UNKNOWN'); assert.equal(calls, 1);
  finish(); assert.equal((await first).status, 'complete'); assert.equal(calls, 1);
});

test('saved received envelope can finalize locally without model; invalid response and provider failure remain failed with raw intact', async () => {
  const { prepared } = await sourceFixture();
  const runRoot = await temp(); let calls = 0;
  const analyze = async args => { calls++; return { rawResponse: JSON.stringify(uncertainResponse(prepared)), receipt: { provider: 'offline', invocationId: 'local', contextId: 'local', inputHash: args.inputHash } }; };
  const done = await audit.runReviewEvidenceAudit({ prepared, runRoot, analyze });
  // Simulate interruption after received persisted, before derived artifacts sealed.
  for (const name of ['seal.json', 'result.json', 'proof.json', 'raw-response.txt']) await unlink(join(done.runDir, name));
  const before = await hashes(done.runDir), state = await audit.readReviewEvidenceAudit(done);
  assert.equal(state.localReplayAvailable, true); assert.deepEqual(await hashes(done.runDir), before);
  assert.equal((await audit.runReviewEvidenceAudit({ prepared, runRoot, analyze })).status, 'complete'); assert.equal(calls, 1);
  for (const scenario of ['invalid', 'provider']) {
    const root = await temp(); let n = 0;
    const callback = async args => { n++; if (scenario === 'provider') throw Object.assign(new Error('offline failure'), { code: 'FIXTURE' });
      return { rawResponse: '{not json', receipt: { provider: 'offline', invocationId: 'bad', contextId: 'bad', inputHash: args.inputHash } }; };
    const failed = await audit.runReviewEvidenceAudit({ prepared, runRoot: root, analyze: callback }); assert.equal(failed.status, 'needs_attention');
    const snapshot = await hashes(failed.runDir);
    assert.equal((await audit.runReviewEvidenceAudit({ prepared, runRoot: root, analyze: callback })).status, 'needs_attention');
    assert.equal(n, 1); assert.deepEqual(await hashes(failed.runDir), snapshot);
    if (scenario === 'invalid') assert.equal(await readFile(join(failed.runDir, 'raw-response.txt'), 'utf8'), '{not json');
  }
});

test('reject reused source context and stale receipt without losing raw; result/proof tampering fails strict replay', async () => {
  const { prepared } = await sourceFixture();
  for (const receiptPatch of [{ contextId: prepared.binding.sourceContextIds[0] }, { inputHash: 'stale' }]) {
    const root = await temp(), raw = JSON.stringify(uncertainResponse(prepared));
    const done = await audit.runReviewEvidenceAudit({ prepared, runRoot: root, analyze: async args => ({ rawResponse: raw,
      receipt: { provider: 'offline', invocationId: 'receipt-test', contextId: 'receipt-test', inputHash: args.inputHash, ...receiptPatch } }) });
    assert.equal(done.status, 'needs_attention'); assert.equal(done.error.code, 'AUDIT_RECEIPT_BINDING');
    assert.equal(await readFile(join(done.runDir, 'raw-response.txt'), 'utf8'), raw);
  }
  const done = await audit.runReviewEvidenceAudit({ prepared, runRoot: await temp(), analyze: async args => ({ rawResponse: JSON.stringify(uncertainResponse(prepared)),
    receipt: { provider: 'offline', invocationId: 'tamper', contextId: 'tamper', inputHash: args.inputHash } }) });
  const path = join(done.runDir, 'result.json'); const result = await json(path); result.automaticAdoption = true; await writeFile(path, JSON.stringify(result));
  const before = await hashes(done.runDir);
  await assert.rejects(() => audit.readReviewEvidenceAudit(done), e => e.code === 'AUDIT_SEAL_BYTE_HASH');
  assert.deepEqual(await hashes(done.runDir), before);
});

function withAliases(response) {
  const aliased = copy(response);
  for (const a of aliased.assessments) for (const c of a.originalCitationSupport.citationChecks) {
    c.explanation = c.reason; delete c.reason;
  }
  return aliased;
}

test('one exact alias only, with pointer/value/raw/version proof; all other response bytes retain their parsed values', async () => {
  const { prepared } = await sourceFixture(), original = uncertainResponse(prepared), aliased = withAliases(original), rawResponse = JSON.stringify(aliased, null, 3) + '\n';
  const normalized = normalizeReviewEvidenceAuditCitations({ prepared, rawResponse });
  assert.deepEqual(normalized.response, original);
  assert.equal(normalized.proof.rawResponseSha256, sha(rawResponse));
  assert.equal(normalized.proof.protocolVersion, prepared.versions.protocolVersion);
  assert.equal(normalized.proof.normalizationVersion, 'citation-check-reason-alias-1');
  assert.equal(normalized.proof.mappings.length, prepared.packet.targets.reduce((n, t) => n + t.originalCitations.length, 0));
  for (const m of normalized.proof.mappings) {
    assert.match(m.from, /\/citationChecks\/\d+\/explanation$/); assert.equal(m.to, m.from.replace(/explanation$/, 'reason'));
    assert.equal(m.originalValueSha256, sha(m.originalValue));
  }
  assert.deepEqual(verifyReviewEvidenceAuditCitationNormalization({ prepared, rawResponse, ...normalized }), normalized);
  const forged = copy(normalized); forged.response.assessments[0].wholeTextCheck.reason = '改变意见';
  expectCode(() => verifyReviewEvidenceAuditCitationNormalization({ prepared, rawResponse, ...forged }), 'AUDIT_FORMAT_RESPONSE_MISMATCH');
  const proof = copy(normalized.proof); proof.mappings[0].originalValueSha256 = '0'.repeat(64);
  expectCode(() => verifyReviewEvidenceAuditCitationNormalization({ prepared, rawResponse, response: normalized.response, proof }), 'AUDIT_FORMAT_PROOF_MISMATCH');
});

test('normalizer rejects dual keys, missing/extra/misspelled keys and nonstrings; unchanged strict validator rejects bad judgments/anchors', async () => {
  const { prepared } = await sourceFixture(), base = withAliases(uncertainResponse(prepared));
  for (const [mutate, code] of [
    [c => { c.reason = c.explanation; }, 'AUDIT_FORMAT_DUAL_REASON'],
    [c => { c.explanation = 17; }, 'AUDIT_FORMAT_REASON_TYPE'],
    [c => { c.explanaton = c.explanation; delete c.explanation; }, 'AUDIT_FORMAT_CITATION_FIELDS'],
    [c => { c.extra = 'x'; }, 'AUDIT_FORMAT_CITATION_FIELDS'],
    [c => { delete c.explanation; }, 'AUDIT_FORMAT_CITATION_FIELDS'],
  ]) {
    const response = copy(base); mutate(response.assessments[1].originalCitationSupport.citationChecks[0]);
    expectCode(() => normalizeReviewEvidenceAuditCitations({ prepared, rawResponse: JSON.stringify(response) }), code);
  }
  const response = copy(base); response.assessments[0].wholeTextCheck.evidence = [ref('R999999')];
  const normalized = normalizeReviewEvidenceAuditCitations({ prepared, rawResponse: JSON.stringify(response) });
  expectCode(() => validate(prepared, normalized.response), 'AUDIT_CITATION_BINDING');
  expectCode(() => validate(prepared, base), 'AUDIT_CITATION_CHECK'); // no implicit relaxation
});

test('explicit opt-in binds request/input, preserves provider raw, uses distinct normalized seal and replayed proof', async () => {
  const f = await sourceFixture();
  assert.deepEqual(audit.getReviewEvidenceAuditFormatNormalizationVersions(), ['citation-check-reason-alias-1']);
  const args = { sourceReviewTaskId: 'trusted-source-task', sourceRunDir: f.runDir, sourceRequestHash: f.requestHash };
  await assert.rejects(() => audit.prepareReviewEvidenceAudit({ ...args, formatNormalizationVersion: 'unknown' }), e => e.code === 'AUDIT_FORMAT_VERSION');
  const p = await audit.prepareReviewEvidenceAudit({ ...args, formatNormalizationVersion: 'citation-check-reason-alias-1' });
  assert.notEqual(p.requestHash, f.prepared.requestHash); assert.notEqual(p.inputHash, f.prepared.inputHash);
  assert.equal(p.packet.formatNormalizationVersion, 'citation-check-reason-alias-1');
  for (const aliased of [true, false]) {
    const runRoot = await temp(), canonical = uncertainResponse(p), wire = aliased ? withAliases(canonical) : canonical, rawResponse = JSON.stringify(wire); let calls = 0;
    const analyze = async input => { calls++; return { rawResponse, receipt: { provider: 'offline-fixture', invocationId: 'format', contextId: 'format', inputHash: input.inputHash } }; };
    const done = await audit.runReviewEvidenceAudit({ prepared: p, runRoot, analyze });
    assert.equal(done.status, 'complete'); assert.equal(done.report.representationStatus, aliased ? 'recovered_from_format' : 'verbatim');
    assert.equal(await readFile(join(done.runDir, 'raw-response.txt'), 'utf8'), rawResponse);
    assert.deepEqual(await json(join(done.runDir, 'canonical-response.json')), canonical);
    assert.equal((await json(join(done.runDir, 'seal.json'))).schemaVersion, 'review-evidence-audit-1-normalized-seal');
    const before = await hashes(done.runDir); await audit.readReviewEvidenceAudit(done);
    await audit.runReviewEvidenceAudit({ prepared: p, runRoot, analyze }); assert.equal(calls, 1); assert.deepEqual(await hashes(done.runDir), before);
    if (aliased) {
      const proofPath = join(done.runDir, 'format-normalization-proof.json'), proof = await json(proofPath);
      proof.mappings[0].to = '/assessments/0/wholeTextCheck/reason';
      const forged = JSON.stringify(proof); await writeFile(proofPath, forged);
      // Even a forged updated byte manifest cannot authorize a different mapping.
      const sealPath = join(done.runDir, 'seal.json'), seal = await json(sealPath); seal.files['format-normalization-proof.json'] = sha(forged);
      await writeFile(sealPath, JSON.stringify(seal));
      await assert.rejects(() => audit.readReviewEvidenceAudit(done), e => e.code === 'AUDIT_FORMAT_PROOF_MISMATCH');
    }
  }
});

test('historical failure recovery is zero-dispatch, separately sealed, idempotent and portable; official failed task/raw remain unchanged', async () => {
  const { prepared } = await sourceFixture(), rawResponse = JSON.stringify(withAliases(uncertainResponse(prepared))); let calls = 0;
  const failed = await audit.runReviewEvidenceAudit({ prepared, runRoot: await temp(), analyze: async input => {
    calls++; return { rawResponse, receipt: { provider: 'offline-fixture', invocationId: 'failed-alias', contextId: 'failed-alias', inputHash: input.inputHash } };
  } });
  assert.equal(failed.status, 'needs_attention'); assert.equal(failed.error.code, 'AUDIT_CITATION_CHECK');
  const before = await hashes(failed.runDir), runRoot = await temp();
  const recovered = await audit.recoverReviewEvidenceAuditFormatFailure({ sourceRunDir: failed.runDir, requestHash: failed.requestHash, runRoot });
  assert.equal(recovered.status, 'recovered_from_format'); assert.equal(recovered.originalStatus, 'needs_attention'); assert.equal(recovered.providerCalls, 0);
  assert.equal(recovered.report.automaticAdoption, false); assert.equal(recovered.report.literaryPass, 'NOT_COMPUTED');
  assert.deepEqual(await hashes(failed.runDir), before); assert.equal((await audit.readReviewEvidenceAudit(failed)).status, 'needs_attention');
  const recoveryBefore = await hashes(recovered.runDir);
  assert.deepEqual(await audit.recoverReviewEvidenceAuditFormatFailure({ sourceRunDir: failed.runDir, requestHash: failed.requestHash, runRoot }), recovered);
  assert.equal(calls, 1); assert.deepEqual(await hashes(recovered.runDir), recoveryBefore);
  const moved = join(await temp(), 'moved'); await cp(recovered.runDir, moved, { recursive: true });
  assert.equal((await audit.readReviewEvidenceAuditFormatRecovery({ runDir: moved, requestHash: recovered.requestHash })).status, 'recovered_from_format');
  assert.deepEqual(await hashes(moved), recoveryBefore);
  const proofPath = join(moved, 'format-normalization-proof.json'), proof = await json(proofPath); proof.mappings.pop();
  const forged = JSON.stringify(proof); await writeFile(proofPath, forged);
  const sealPath = join(moved, 'seal.json'), seal = await json(sealPath); seal.files['format-normalization-proof.json'] = sha(forged); await writeFile(sealPath, JSON.stringify(seal));
  await assert.rejects(() => audit.readReviewEvidenceAuditFormatRecovery({ runDir: moved, requestHash: recovered.requestHash }), e => e.code === 'AUDIT_FORMAT_PROOF_MISMATCH');
  const invalidRoot = await temp(); await cp(failed.runDir, join(invalidRoot, 'bad'), { recursive: true });
  const fp = join(invalidRoot, 'bad/failure.json'), failure = await json(fp); failure.code = 'DIFFERENT'; await writeFile(fp, JSON.stringify(failure));
  await assert.rejects(async () => audit.recoverReviewEvidenceAuditFormatFailure({ sourceRunDir: join(invalidRoot, 'bad'), requestHash: failed.requestHash, runRoot: await temp() }), e => e.code === 'AUDIT_RECOVERY_ORIGINAL_REJECTION');
});


const FACT_POLICY = 'fact-subclaims-and-two-axes-2';
let factFixture;
async function factSourceFixture() {
  if (factFixture) return factFixture;
  const factChapters = [
    { id: 'arrival', title: '交接', body: '小岚是我妹妹。\n\n我说：“这次别付钱。”\n\n师傅把两张零钱留在柜台上。\n\n我给小岚九十元。她抽出二十元放回我掌心。\n\n小岚说：“货款已经结清。”\n\n我没看见付款凭证。' },
    { id: 'earlier', title: '上午', body: '货架上午就搬走了。\n\n小岚接过钥匙，推开侧门。' },
    { id: 'later', title: '下午', body: '我又问了一遍货架的事，没有得到回答。' },
  ];
  const statements = ['小岚是叙述者的哥哥。', '小岚说这次别付钱。', '师傅没有付款。', '小岚偿还给我九十元。', '货架始终没有搬走。',
    '小岚接过钥匙，推开侧门。', '😀小岚接过钥匙。稍后，小岚接过钥匙。', '小岚说货款已经结清。', '货款已经结清。',
    '小岚是叙述者的哥哥，所以这次归还钥匙令人释然。'];
  const req = copy(request); req.caseId = 'generic-fact-subclaims-controls';
  req.baselineChapters = factChapters; req.candidate.chapters = factChapters;
  req.goals[0].sourceEvidence = [{ chapterId: 'earlier', quote: '货架上午就搬走了。', start: 0 }];
  req.goals[0].counterCase = [{ chapterId: 'arrival', quote: '小岚是我妹妹。', start: 0 }];
  let sourceCalls = 0;
  const result = await review.startIndependentReview({ runRoot: await temp(), request: req, modelCitationMode: 'paragraph_refs_v1', analyze: async args => {
    sourceCalls++; const response = copy(args.packet.responseContract.example);
    if (args.stage === 'independent_reading') {
      const entry = response.entries[0], cite = copy(entry.focusAssessments[0].evidence[0]);
      entry.overallImpression = '我觉得读起来沉静。';
      entry.claims = statements.map((statement, i) => ({ id: `generic-${i}`, claimType: 'hard_fact', statement, evidence: [cite] }));
    }
    return { outputText: JSON.stringify(response), receipt: { provider: 'offline-fixture', contextId: `fact-source-${sourceCalls}`, invocationId: `fact-source-${sourceCalls}`, inputHash: args.inputHash } };
  } });
  assert.equal(result.status, 'complete', JSON.stringify(result.error)); assert.equal(sourceCalls, 7);
  const args = { sourceReviewTaskId: 'fact-fixture-task', sourceRunDir: result.runDir, sourceRequestHash: result.requestHash };
  factFixture = { ...result, args, prepared: await audit.prepareReviewEvidenceAudit({ ...args, auditPolicyVersion: FACT_POLICY }) };
  return factFixture;
}
function factResponse(p) {
  const r = uncertainResponse(p); r.schemaVersion = 'review-evidence-audit-2-response';
  for (const [i, a] of r.assessments.entries()) {
    a.factChecks = []; a.factDependencies = { originalCitationSupport: [], wholeTextCheck: [] };
    a.factCoverage = p.packet.targets[i].claimSources.map(s => ({ JSONPointer: s.JSONPointer, disposition: 'unresolved', factIds: [], reason: '离线占位，不假装已完成语义抽取。' }));
  }
  return r;
}
function factFor({ statement, quote = statement, dimension = 'other_explicit_fact', status = 'uncertain', evidence = [], counterEvidence = [], id = 'F1', basis = 'undetermined' }) {
  return { factId: id, claim: { JSONPointer: '/statement', quote, start: null }, dimensions: [dimension], status, basis,
    reason: '预置核查用于测试绑定与自洽，不代表模型实测检出。', supportedScope: status === 'supported' ? '仅该明确动作或说法。' : null,
    limits: '不能据此决定文学质量或偏好。', evidence, counterEvidence };
}
function targetFor(p, statement) { return p.packet.targets.find(t => t.stageId === '01-reader-1-first' && t.original.statement === statement); }
function setFacts(response, target, facts) {
  const a = response.assessments.find(x => x.targetId === target.targetId); a.factChecks = facts;
  a.factCoverage = target.claimSources.map(s => ({ JSONPointer: s.JSONPointer, disposition: facts.some(f => f.claim.JSONPointer === s.JSONPointer) ? 'fact_checks' : 'pure_interpretation',
    factIds: facts.filter(f => f.claim.JSONPointer === s.JSONPointer).map(f => f.factId), reason: '测试预置原字段覆盖。' }));
  a.factDependencies = { originalCitationSupport: facts.map(f => f.factId), wholeTextCheck: facts.map(f => f.factId) };
  return a;
}

test('v2 explicit policy binds request/input/schema/sources while default v1 and seven-stage inputs stay unchanged', async () => {
  const f = await factSourceFixture(), before = await hashes(dirname(f.runDir));
  assert.deepEqual(audit.getReviewEvidenceAuditPolicyVersions(), ['original-citation-and-whole-text-1', FACT_POLICY, PREMISE_SUPPORT_POLICY]);
  const v1 = await audit.prepareReviewEvidenceAudit(f.args);
  assert.deepEqual(await audit.prepareReviewEvidenceAudit({ ...f.args, auditPolicyVersion: 'original-citation-and-whole-text-1' }), v1);
  const p = f.prepared; assert.notEqual(p.requestHash, v1.requestHash); assert.notEqual(p.inputHash, v1.inputHash);
  assert.equal(p.versions.policyVersion, FACT_POLICY); assert.equal(p.packet.auditPolicyVersion, FACT_POLICY);
  assert.equal(v1.auditPolicyVersion, undefined); assert.equal(v1.packet.targets[0].claimSources, undefined);
  assert.equal(p.packet.responseContract.properties.schemaVersion.const, 'review-evidence-audit-2-response');
  assert.equal(p.instruction.includes('小岚'), false); assert.equal(p.instruction.includes('九十'), false);
  for (const t of p.packet.targets) {
    assert.ok(t.claimSources.length); assert.deepEqual(t.original, v1.packet.targets.find(x => x.targetId === t.targetId).original);
    for (const s of t.claimSources) { assert.equal(s.sha256, sha(s.text)); assert.match(s.JSONPointer, /^\/(statement|uncertainty|rationale|explanation)$/); }
  }
  for (const value of [null, '', 'unknown', 'review-evidence-audit-2']) await assert.rejects(() => audit.prepareReviewEvidenceAudit({ ...f.args, auditPolicyVersion: value }), e => e.code === 'AUDIT_POLICY_VERSION');
  const forged = copy(p); delete forged.auditPolicyVersion; expectCode(() => validate(forged, factResponse(p)), 'AUDIT_PREPARED_BINDING');
  const injected = copy(p); injected.packet.targets[0].claimSources[0].text = '新造意见'; expectCode(() => validate(injected, factResponse(p)), 'AUDIT_PREPARED_BINDING');
  assert.deepEqual(await hashes(dirname(f.runDir)), before);
});

test('v2 pure interpretation can have no facts; unresolved extraction remains explicit and cannot coexist with whole supported', async () => {
  const { prepared: p } = await factSourceFixture(), r = factResponse(p), t = p.packet.targets[0], a = setFacts(r, t, []);
  a.factCoverage[0].reason = '该字段仅陈述读者自身感受，无外部事件事实。';
  const result = validate(p, copy(r)).result;
  assert.equal(result.assessments[0].factChecks.length, 0); assert.equal(result.factCheckCoverage.semanticCompleteness, 'NOT_VERIFIED');
  assert.equal(result.factCheckCoverage.accuracy, 'NOT_COMPUTED'); assert.equal(result.automaticAdoption, false);
  a.factCoverage[0].disposition = 'unresolved'; a.wholeTextCheck.status = 'supported'; a.wholeTextCheck.supportedScope = '局部';
  a.wholeTextCheck.evidence = [ref(anchor(p, t.allowedBlindIds[0], 'arrival', '小岚是'))];
  expectCode(() => validate(p, r), 'AUDIT_FACT_UNRESOLVED_SUPPORT');
  a.factCoverage[0].disposition = 'pure_interpretation'; a.factCoverage[0].reason = ''; expectCode(() => validate(p, r), 'AUDIT_FACT_COVERAGE');
});

test('v2 known-generic controls preserve relation/actor/intent/direction/event counterevidence without changing opinions', async () => {
  const { prepared: p } = await factSourceFixture(), r = factResponse(p);
  const controls = [
    ['小岚是叙述者的哥哥。', 'identity_relationship', 'arrival', '小岚是'],
    ['小岚说这次别付钱。', 'speaker_actor', 'arrival', '我说'],
    ['师傅没有付款。', 'intent_completion', 'arrival', '师傅把'],
    ['小岚偿还给我九十元。', 'transfer_direction', 'arrival', '我给'],
    ['货架始终没有搬走。', 'event_round', 'earlier', '货架上午'],
  ];
  for (const [statement, dimension, chapterId, includes] of controls) {
    const t = targetFor(p, statement), f = factFor({ statement, dimension, status: 'contradicted', basis: 'narrated_action',
      counterEvidence: [ref(anchor(p, t.allowedBlindIds[0], chapterId, includes))] });
    const a = setFacts(r, t, [f]); a.wholeTextCheck.status = 'partial'; a.wholeTextCheck.supportedScope = '事实前提有误，文学感受保留。';
    a.wholeTextCheck.evidence = f.counterEvidence;
  }
  const checked = validate(p, r);
  assert.equal(checked.proof.factClaimMappings.length, 5);
  for (const [statement] of controls) {
    const t = targetFor(p, statement), a = checked.result.assessments.find(x => x.targetId === t.targetId);
    assert.equal(a.factChecks[0].status, 'contradicted'); assert.equal(a.wholeTextCheck.status, 'partial');
    assert.equal(a.factChecks[0].claim.sourceTextSha256, sha(statement)); assert.equal(a.factChecks[0].counterEvidence[0].blindId, t.allowedBlindIds[0]);
    assert.equal(t.original.statement, statement);
  }
});

test('v2 contradicted dependencies cannot be overall supported; partial and uncertainty remain valid, no automatic negative vote', async () => {
  const { prepared: p } = await factSourceFixture(), r = factResponse(p), statement = '师傅没有付款。', t = targetFor(p, statement);
  const counter = ref(anchor(p, t.allowedBlindIds[0], 'arrival', '师傅把'));
  const a = setFacts(r, t, [factFor({ statement, status: 'contradicted', counterEvidence: [counter] })]);
  a.wholeTextCheck = { status: 'supported', reason: '测试矛盾。', supportedScope: '整体', limits: null, evidence: [counter], counterEvidence: [], mechanicalFactsUsed: [] };
  expectCode(() => validate(p, r), 'AUDIT_FACT_CONTRADICTION_DEPENDENCY');
  a.wholeTextCheck.status = 'partial'; a.wholeTextCheck.limits = '仅部分'; validate(p, copy(r));
  a.originalCitationSupport.status = 'supported'; a.originalCitationSupport.supportedScope = '整体';
  expectCode(() => validate(p, r), 'AUDIT_FACT_CONTRADICTION_DEPENDENCY');
  a.originalCitationSupport.status = 'uncertain'; a.factDependencies.wholeTextCheck = [];
  expectCode(() => validate(p, r), 'AUDIT_FACT_DEPENDENCY_COVERAGE');
  a.factDependencies.wholeTextCheck = ['invented']; expectCode(() => validate(p, r), 'AUDIT_FACT_DEPENDENCIES');
});

test('v2 claim spans require exact original field, preserve UTF16 and reject ambiguous occurrence, rewording, quotes/goal-definition pointers', async () => {
  const { prepared: p } = await factSourceFixture(), statement = '😀小岚接过钥匙。稍后，小岚接过钥匙。', t = targetFor(p, statement);
  const r = factResponse(p), f = factFor({ statement, quote: '小岚接过钥匙。' }), a = setFacts(r, t, [f]);
  expectCode(() => validate(p, r), 'AUDIT_FACT_CLAIM_NOT_UNIQUE');
  f.claim.start = 2;
  const checked = validate(p, r); const found = checked.result.assessments.find(x => x.targetId === t.targetId).factChecks[0];
  assert.equal(found.claim.start, 2); assert.equal(found.claim.end, 2 + f.claim.quote.length);
  for (const pointer of ['/evidence/0/quote', '/definition/statement', '/missing']) {
    const bad = copy(r), fact = bad.assessments.find(x => x.targetId === t.targetId).factChecks[0]; fact.claim.JSONPointer = pointer;
    expectCode(() => validate(p, bad), 'AUDIT_FACT_CLAIM_SOURCE');
  }
  f.claim.quote = '小岚拿过钥匙。'; expectCode(() => validate(p, r), 'AUDIT_FACT_CLAIM_NOT_FOUND');
  f.claim.quote = '小岚接过钥匙。'; f.claim.start = 1.5; expectCode(() => validate(p, r), 'AUDIT_FACT_CLAIM_POSITION');
  f.claim.start = 1; expectCode(() => validate(p, r), 'AUDIT_FACT_CLAIM_NOT_FOUND');
  f.claim.start = 2; const duplicate = copy(f); duplicate.factId = 'F2'; a.factChecks.push(duplicate); expectCode(() => validate(p, r), 'AUDIT_FACT_DUPLICATE_SPAN');
});

test('v2 all original claim fields need dispositions and every fact must be covered exactly once', async () => {
  const { prepared: p } = await factSourceFixture(), t = targetFor(p, '货款已经结清。'), base = factResponse(p);
  setFacts(base, t, [factFor({ statement: t.original.statement })]);
  for (const [mutate, code] of [
    [a => { a.factCoverage = []; }, 'AUDIT_FACT_COVERAGE'],
    [a => { a.factCoverage[0].factIds = []; }, 'AUDIT_FACT_COVERAGE_IDS'],
    [a => { a.factCoverage[0].factIds = ['F1', 'F1']; }, 'AUDIT_FACT_COVERAGE_IDS'],
    [a => { a.factCoverage[0].disposition = 'pure_interpretation'; }, 'AUDIT_FACT_COVERAGE_DISPOSITION'],
    [a => { a.factChecks.push(copy(a.factChecks[0])); }, 'AUDIT_FACT_ID'],
    [a => { a.factChecks[0].dimensions = []; }, 'AUDIT_FACT_DIMENSIONS'],
    [a => { a.factChecks[0].status = 'passed'; }, 'AUDIT_FACT_STATUS'],
    [a => { a.factChecks[0].explanation = a.factChecks[0].reason; delete a.factChecks[0].reason; }, 'AUDIT_FACT_FIELDS'],
  ]) { const bad = copy(base); mutate(bad.assessments.find(a => a.targetId === t.targetId)); expectCode(() => validate(p, bad), code); }
});

test('v2 fact citations require task manuscript binding and evidence for asserted support or contradiction', async () => {
  const { prepared: p } = await factSourceFixture(), t = targetFor(p, '货款已经结清。'), r = factResponse(p), f = factFor({ statement: t.original.statement }); setFacts(r, t, [f]);
  f.status = 'supported'; f.supportedScope = '局部'; expectCode(() => validate(p, r), 'AUDIT_FACT_SUPPORT_WITHOUT_EVIDENCE');
  f.status = 'contradicted'; expectCode(() => validate(p, r), 'AUDIT_FACT_CONTRADICTION_WITHOUT_EVIDENCE');
  f.status = 'uncertain';
  for (const c of [ref('R999999'), ref(anchor(p, t.allowedBlindIds[0] === 'A' ? 'B' : 'A', 'arrival', '小岚是'))]) {
    f.evidence = [c]; expectCode(() => validate(p, r), 'AUDIT_CITATION_BINDING');
  }
  f.evidence = [{ ...ref(anchor(p, t.allowedBlindIds[0], 'arrival', '小岚是')), quote: '伪造自由引文' }];
  expectCode(() => validate(p, r), 'AUDIT_CITATION_FIELDS');
  f.evidence = []; f.limits = null; expectCode(() => validate(p, r), 'AUDIT_FACT_LIMITS');
});

test('v2 character statement can be supported while actual payment remains uncertain; same paragraph legitimately supports multiple facts', async () => {
  const { prepared: p } = await factSourceFixture(), r = factResponse(p);
  for (const statement of ['小岚说货款已经结清。', '货款已经结清。']) {
    const t = targetFor(p, statement), isSpeech = statement.startsWith('小岚说');
    const f = factFor({ statement, status: isSpeech ? 'supported' : 'uncertain', basis: isSpeech ? 'character_statement' : 'undetermined',
      evidence: [ref(anchor(p, t.allowedBlindIds[0], 'arrival', '小岚说'), 'character_statement')] });
    setFacts(r, t, [f]);
  }
  const t = targetFor(p, '小岚接过钥匙，推开侧门。'), evidence = [ref(anchor(p, t.allowedBlindIds[0], 'earlier', '小岚接'))];
  setFacts(r, t, [factFor({ statement: t.original.statement, quote: '小岚接过钥匙', id: 'F1', status: 'supported', basis: 'narrated_action', evidence }),
    factFor({ statement: t.original.statement, quote: '推开侧门', id: 'F2', status: 'supported', basis: 'narrated_action', evidence })]);
  const checked = validate(p, r), facts = checked.result.assessments.find(a => a.targetId === t.targetId).factChecks;
  assert.equal(facts.length, 2); assert.equal(facts[0].evidence[0].anchorId, facts[1].evidence[0].anchorId);
  const payment = checked.result.assessments.find(a => a.targetId === targetFor(p, '货款已经结清。').targetId);
  assert.equal(payment.factChecks[0].status, 'uncertain'); assert.equal(payment.factChecks[0].evidence[0].basis, 'character_statement');
  assert.equal(checked.result.literaryPass, 'NOT_COMPUTED');
});

test('v2 one-call persistence plus alias proof strictly replays fact mappings after source metadata relocation and audit move', async () => {
  const f = await factSourceFixture(), sourceBefore = await hashes(dirname(f.runDir));
  const p = await audit.prepareReviewEvidenceAudit({ ...f.args, auditPolicyVersion: FACT_POLICY, formatNormalizationVersion: 'citation-check-reason-alias-1' });
  const canonical = factResponse(p), t = targetFor(p, '师傅没有付款。');
  setFacts(canonical, t, [factFor({ statement: t.original.statement, status: 'contradicted', counterEvidence: [ref(anchor(p, t.allowedBlindIds[0], 'arrival', '师傅把'))] })]);
  const rawResponse = JSON.stringify(withAliases(canonical)); let calls = 0;
  const runRoot = await temp(), done = await audit.runReviewEvidenceAudit({ prepared: p, runRoot, analyze: async args => {
    calls++; return { rawResponse, receipt: { provider: 'offline-v2', invocationId: 'once-v2', contextId: 'once-v2', inputHash: args.inputHash } };
  } });
  assert.equal(done.status, 'complete', JSON.stringify(done.error)); assert.equal(calls, 1);
  assert.equal(done.report.schemaVersion, 'review-evidence-audit-2-result'); assert.equal(done.report.representationStatus, 'recovered_from_format');
  assert.deepEqual(await json(join(done.runDir, 'canonical-response.json')), canonical); assert.equal(await readFile(join(done.runDir, 'raw-response.txt'), 'utf8'), rawResponse);
  assert.equal(done.proof.canonicalStrictValidationProof.factClaimMappings.length, 1);
  const before = await hashes(done.runDir); await audit.runReviewEvidenceAudit({ prepared: p, runRoot, analyze: () => { throw new Error('must not redispatch'); } });
  const relocatedRoot = await temp(), parent = join(relocatedRoot, 'source'); await cp(dirname(f.runDir), parent, { recursive: true });
  const metadataPath = join(parent, 'task.json'), metadata = await json(metadataPath); metadata.runDir = join(parent, 'run'); metadata.runRoot = relocatedRoot;
  await writeFile(metadataPath, JSON.stringify(metadata));
  assert.deepEqual(await audit.prepareReviewEvidenceAudit({ ...f.args, sourceRunDir: metadata.runDir, auditPolicyVersion: FACT_POLICY, formatNormalizationVersion: 'citation-check-reason-alias-1' }), p);
  const moved = join(await temp(), 'moved'); await cp(done.runDir, moved, { recursive: true });
  const replay = await audit.readReviewEvidenceAudit({ runDir: moved, requestHash: done.requestHash }); assert.deepEqual(replay.report, done.report);
  assert.deepEqual(await hashes(moved), before); assert.deepEqual(await hashes(dirname(f.runDir)), sourceBefore); assert.equal(calls, 1);
  const proofPath = join(moved, 'proof.json'), proof = await json(proofPath); proof.canonicalStrictValidationProof.factClaimMappings[0].start++;
  const forged = JSON.stringify(proof); await writeFile(proofPath, forged);
  const sealPath = join(moved, 'seal.json'), seal = await json(sealPath); seal.files['proof.json'] = sha(forged); await writeFile(sealPath, JSON.stringify(seal));
  await assert.rejects(() => audit.readReviewEvidenceAudit({ runDir: moved, requestHash: done.requestHash }), e => e.code === 'AUDIT_SEAL_REPLAY');
});

test('v2 incomplete fact result remains terminal failure, raw unchanged, with no second analysis', async () => {
  const { prepared: p } = await factSourceFixture(), r = factResponse(p); delete r.assessments[0].factCoverage;
  const rawResponse = JSON.stringify(r), runRoot = await temp(); let calls = 0;
  const analyze = async args => { calls++; return { rawResponse, receipt: { provider: 'offline-v2', invocationId: 'bad-facts', contextId: 'bad-facts', inputHash: args.inputHash } }; };
  const failed = await audit.runReviewEvidenceAudit({ prepared: p, runRoot, analyze });
  assert.equal(failed.status, 'needs_attention'); assert.equal(failed.error.code, 'AUDIT_ASSESSMENT_FIELDS');
  const before = await hashes(failed.runDir); await audit.runReviewEvidenceAudit({ prepared: p, runRoot, analyze });
  assert.equal(calls, 1); assert.equal(await readFile(join(failed.runDir, 'raw-response.txt'), 'utf8'), rawResponse);
  assert.deepEqual(await hashes(failed.runDir), before);
});

let premisePrepared;
async function premiseFixture() {
  if (!premisePrepared) premisePrepared = await audit.prepareReviewEvidenceAudit({ ...(await factSourceFixture()).args, auditPolicyVersion: PREMISE_SUPPORT_POLICY });
  return premisePrepared;
}
function premiseEntries(target, disposition = 'unresolved') {
  return target.claimSources.map(s => ({ JSONPointer: s.JSONPointer,
    dimensions: Object.fromEntries(PREMISE_DIMENSIONS.map(d => [d, {
      disposition, factIds: [], reason: disposition === 'not_applicable' ? '离线预置：此维度不适用。' : '离线未作语义判断，保留未知。',
    }])) }));
}
function premiseResponse(p) {
  const r = factResponse(p); r.schemaVersion = 'review-evidence-audit-3-response';
  r.assessments.forEach((a, i) => { a.premiseChecks = premiseEntries(p.packet.targets[i]); });
  return r;
}
function setPremiseFacts(response, target, facts) {
  const a = setFacts(response, target, facts); a.premiseChecks = premiseEntries(target, 'not_applicable');
  for (const entry of a.premiseChecks) for (const dimension of PREMISE_DIMENSIONS) {
    const ids = facts.filter(f => f.claim.JSONPointer === entry.JSONPointer && f.dimensions.includes(dimension)).map(f => f.factId);
    if (ids.length) entry.dimensions[dimension] = { disposition: 'identified', factIds: ids, reason: '该原话含待核实的此类前提。' };
  }
  return a;
}

test('v3 explicit policy binds five-premise contract; default v1 and explicit v2 have no added input or response fields', async () => {
  const f = await factSourceFixture(), p = await premiseFixture(), v2 = f.prepared, v1 = await audit.prepareReviewEvidenceAudit(f.args);
  assert.equal(p.versions.policyVersion, PREMISE_SUPPORT_POLICY);
  assert.equal(p.packet.responseContract.properties.schemaVersion.const, 'review-evidence-audit-3-response');
  assert.notEqual(p.requestHash, v2.requestHash); assert.notEqual(p.inputHash, v2.inputHash);
  assert.deepEqual(p.packet.targets, v2.packet.targets); // Same source fields/opinions, only method changed.
  assert.equal(v1.packet.responseContract.properties.assessments.items.properties.premiseChecks, undefined);
  assert.equal(v2.packet.responseContract.properties.assessments.items.properties.premiseChecks, undefined);
  assert.equal(v1.instruction.includes('【v3'), false); assert.equal(v2.instruction.includes('【v3'), false);
  assert.match(p.instruction, /整句是审美意见，不表示/); assert.match(p.instruction, /“我读后感到宁静。”/);
  for (const needle of ['小岚', '九十元', 'family-photo', 'workplace-receipt']) assert.equal(p.instruction.includes(needle), false);
  const properties = p.packet.responseContract.properties.assessments.items.properties;
  for (const key of ['factChecks', 'factCoverage', 'factDependencies']) assert.deepEqual(properties[key], v2.packet.responseContract.properties.assessments.items.properties[key]);
  assert.deepEqual(properties.premiseChecks.items.properties.dimensions.required, PREMISE_DIMENSIONS);
  for (const mutate of [q => { q.auditPolicyVersion = FACT_POLICY; }, q => { q.packet.responseContract.properties.assessments.items.required.pop(); },
    q => { q.instruction += 'Unrecorded extra instructions'; }]) {
    const bad = copy(p); mutate(bad); expectCode(() => validate(bad, premiseResponse(p)), 'AUDIT_PREPARED_BINDING');
  }
  const oldResponse = factResponse(v2); oldResponse.assessments[0].premiseChecks = [];
  expectCode(() => validate(v2, oldResponse), 'AUDIT_ASSESSMENT_FIELDS');
  const omitted = premiseResponse(p); delete omitted.assessments[0].premiseChecks;
  expectCode(() => validate(p, omitted), 'AUDIT_ASSESSMENT_FIELDS');
});

test('v3 every claimSource, including uncertainty, needs exactly five premise checks with no duplicate/foreign fields', async () => {
  const p = await premiseFixture(), target = p.packet.targets.find(t => t.claimSources.length > 1), base = premiseResponse(p);
  assert.ok(target.claimSources.some(s => s.JSONPointer === '/uncertainty'));
  for (const [mutate, code] of [
    [a => { a.premiseChecks.pop(); }, 'AUDIT_PREMISE_COVERAGE'],
    [a => { a.premiseChecks[1].JSONPointer = a.premiseChecks[0].JSONPointer; }, 'AUDIT_PREMISE_SOURCE'],
    [a => { a.premiseChecks[0].JSONPointer = '/evidence/0/quote'; }, 'AUDIT_PREMISE_SOURCE'],
    [a => { delete a.premiseChecks[0].dimensions.event_round; }, 'AUDIT_PREMISE_DIMENSIONS'],
    [a => { a.premiseChecks[0].dimensions.extra = {}; }, 'AUDIT_PREMISE_DIMENSIONS'],
    [a => { a.premiseChecks[0].dimensions.speaker_actor.explanation = 'extra'; }, 'AUDIT_PREMISE_CHECK_FIELDS'],
    [a => { a.premiseChecks[0].dimensions.speaker_actor.reason = ''; }, 'AUDIT_PREMISE_CHECK'],
    [a => { a.premiseChecks[0].dimensions.speaker_actor.disposition = 'subjective'; }, 'AUDIT_PREMISE_CHECK'],
  ]) { const bad = copy(base); mutate(bad.assessments.find(a => a.targetId === target.targetId)); expectCode(() => validate(p, bad), code); }
});

test('v3 pure interpretation is allowed for a feeling, but identified/undetermined premises cannot be structurally waived', async () => {
  const p = await premiseFixture(), t = p.packet.targets[0], r = premiseResponse(p), a = setPremiseFacts(r, t, []);
  assert.equal(t.original.statement, '我觉得读起来沉静。');
  let done = validate(p, copy(r)); assert.equal(done.result.assessments[0].factCoverage[0].disposition, 'pure_interpretation');
  a.premiseChecks[0].dimensions.speaker_actor.disposition = 'unresolved';
  expectCode(() => validate(p, r), 'AUDIT_PREMISE_UNRESOLVED_COVERAGE');
  a.factCoverage[0].disposition = 'unresolved'; validate(p, copy(r));
  a.wholeTextCheck.status = 'supported'; a.wholeTextCheck.supportedScope = '局部';
  a.wholeTextCheck.evidence = [ref(anchor(p, t.allowedBlindIds[0], 'arrival', '小岚是'))];
  expectCode(() => validate(p, r), 'AUDIT_FACT_UNRESOLVED_SUPPORT');
  a.wholeTextCheck.status = 'uncertain'; a.premiseChecks[0].dimensions.speaker_actor.disposition = 'identified';
  expectCode(() => validate(p, r), 'AUDIT_PREMISE_IDENTIFIED_EMPTY');
});

test('v3 mixed literary sentence retains exact factual premise and feeling; contradiction limits the dependent axis without rewriting opinion', async () => {
  const p = await premiseFixture(), statement = '小岚是叙述者的哥哥，所以这次归还钥匙令人释然。', t = targetFor(p, statement), r = premiseResponse(p);
  const f = factFor({ statement, quote: '小岚是叙述者的哥哥', dimension: 'identity_relationship', status: 'contradicted',
    counterEvidence: [ref(anchor(p, t.allowedBlindIds[0], 'arrival', '小岚是'))] });
  const a = setPremiseFacts(r, t, [f]);
  a.premiseChecks[0].dimensions.speaker_actor = { disposition: 'unresolved', factIds: [], reason: '归还动作与行动者尚未核实，不因释然感免查。' };
  a.factCoverage[0].disposition = 'unresolved';
  a.wholeTextCheck = { status: 'partial', reason: '保留读者感受；亲属前提反证明确，动作尚未知。', supportedScope: '只保留感受的主观范围。',
    limits: '不认定还钥匙实际发生，也不替换读者偏好。', evidence: f.counterEvidence, counterEvidence: f.counterEvidence, mechanicalFactsUsed: [] };
  const done = validate(p, copy(r)), found = done.result.assessments.find(x => x.targetId === t.targetId);
  assert.equal(found.factChecks[0].claim.quote, f.claim.quote); assert.equal(t.original.statement, statement);
  assert.equal(found.premiseChecks[0].dimensions.identity_relationship.disposition, 'identified');
  assert.equal(found.wholeTextCheck.status, 'partial'); assert.equal(done.result.voteResult, null);
  a.wholeTextCheck.status = 'supported'; expectCode(() => validate(p, r), 'AUDIT_FACT_CONTRADICTION_DEPENDENCY');
  a.wholeTextCheck.status = 'partial'; a.premiseChecks[0].dimensions.identity_relationship.factIds = [];
  expectCode(() => validate(p, r), 'AUDIT_PREMISE_FACT_BINDING');
  a.premiseChecks[0].dimensions.identity_relationship.factIds = ['F1']; a.premiseChecks[0].dimensions.identity_relationship.disposition = 'not_applicable';
  expectCode(() => validate(p, r), 'AUDIT_PREMISE_ABSENT_FACT');
});

test('v3 premise IDs bind the same source field and dimension, allow multi-dimension spans, and keep unknown truth distinct from absent premises', async () => {
  const p = await premiseFixture(), t = targetFor(p, '货款已经结清。'), r = premiseResponse(p);
  const f = factFor({ statement: t.original.statement, dimension: 'intent_completion', status: 'uncertain' });
  f.dimensions.push('transfer_direction'); const a = setPremiseFacts(r, t, [f]);
  const done = validate(p, copy(r)), found = done.result.assessments.find(x => x.targetId === t.targetId);
  assert.equal(found.factChecks[0].evidence.length, 0); assert.equal(found.factChecks[0].status, 'uncertain');
  assert.equal(found.factCoverage[0].disposition, 'fact_checks');
  assert.deepEqual(found.premiseChecks[0].dimensions.intent_completion.factIds, ['F1']);
  assert.deepEqual(found.premiseChecks[0].dimensions.transfer_direction.factIds, ['F1']);
  for (const ids of [['F1'], ['invented'], ['F1', 'F1']]) {
    const bad = copy(r); bad.assessments.find(x => x.targetId === t.targetId).premiseChecks[0].dimensions.identity_relationship.factIds = ids;
    expectCode(() => validate(p, bad), 'AUDIT_PREMISE_FACT_BINDING');
  }
  const multi = p.packet.targets.find(x => x.claimSources.some(s => s.JSONPointer === '/uncertainty'));
  const ff = factFor({ statement: multi.original.statement, dimension: 'speaker_actor' }); setPremiseFacts(r, multi, [ff]);
  const other = r.assessments.find(x => x.targetId === multi.targetId).premiseChecks.find(x => x.JSONPointer === '/uncertainty');
  other.dimensions.speaker_actor = { disposition: 'identified', factIds: ['F1'], reason: '故意错误地复用别的字段事实。' };
  expectCode(() => validate(p, r), 'AUDIT_PREMISE_FACT_BINDING');
});

test('v3 other explicit facts still prevent pure interpretation; same exact paragraph may support more than one fact', async () => {
  const p = await premiseFixture(), t = targetFor(p, '小岚接过钥匙，推开侧门。'), r = premiseResponse(p);
  const evidence = [ref(anchor(p, t.allowedBlindIds[0], 'earlier', '小岚接'))];
  const a = setPremiseFacts(r, t, [factFor({ statement: t.original.statement, quote: '小岚接过钥匙', dimension: 'speaker_actor', id: 'F1', status: 'supported', evidence }),
    factFor({ statement: t.original.statement, quote: '推开侧门', dimension: 'speaker_actor', id: 'F2', status: 'supported', evidence })]);
  const done = validate(p, copy(r)), facts = done.result.assessments.find(x => x.targetId === t.targetId).factChecks;
  assert.equal(facts[0].evidence[0].anchorId, facts[1].evidence[0].anchorId);
  a.factChecks.forEach(f => { f.dimensions = ['other_explicit_fact']; }); a.premiseChecks = premiseEntries(t, 'not_applicable');
  validate(p, copy(r)); a.factCoverage[0].disposition = 'pure_interpretation';
  expectCode(() => validate(p, r), 'AUDIT_FACT_COVERAGE_DISPOSITION');
});

test('v3 one-call normalized raw and premise proofs replay after relocation without touching the seven-stage source', async () => {
  const f = await factSourceFixture(), sourceBefore = await hashes(dirname(f.runDir));
  const p = await audit.prepareReviewEvidenceAudit({ ...f.args, auditPolicyVersion: PREMISE_SUPPORT_POLICY, formatNormalizationVersion: 'citation-check-reason-alias-1' });
  const canonical = premiseResponse(p), rawResponse = JSON.stringify(withAliases(canonical)), runRoot = await temp(); let calls = 0;
  const done = await audit.runReviewEvidenceAudit({ prepared: p, runRoot, analyze: async args => {
    calls++; return { rawResponse, receipt: { provider: 'offline-v3', invocationId: 'once-v3', contextId: 'once-v3', inputHash: args.inputHash } };
  } });
  assert.equal(done.status, 'complete', JSON.stringify(done.error)); assert.equal(calls, 1);
  assert.equal(done.report.schemaVersion, 'review-evidence-audit-3-result'); assert.equal(done.report.representationStatus, 'recovered_from_format');
  assert.equal(done.proof.canonicalStrictValidationProof.schemaVersion, 'review-evidence-audit-3-proof');
  assert.equal(done.report.factCheckCoverage.semanticCompleteness, 'NOT_VERIFIED'); assert.equal(done.report.factCheckCoverage.accuracy, 'NOT_COMPUTED');
  assert.equal(done.report.automaticAdoption, false); assert.equal(done.report.literaryPass, 'NOT_COMPUTED');
  assert.equal(await readFile(join(done.runDir, 'raw-response.txt'), 'utf8'), rawResponse);
  assert.deepEqual(await json(join(done.runDir, 'canonical-response.json')), canonical);
  const before = await hashes(done.runDir); await audit.runReviewEvidenceAudit({ prepared: p, runRoot, analyze: () => { throw new Error('must not redispatch'); } });
  const relocatedRoot = await temp(), parent = join(relocatedRoot, 'source'); await cp(dirname(f.runDir), parent, { recursive: true });
  const path = join(parent, 'task.json'), metadata = await json(path); metadata.runDir = join(parent, 'run'); metadata.runRoot = relocatedRoot; await writeFile(path, JSON.stringify(metadata));
  assert.deepEqual(await audit.prepareReviewEvidenceAudit({ ...f.args, sourceRunDir: metadata.runDir, auditPolicyVersion: PREMISE_SUPPORT_POLICY, formatNormalizationVersion: 'citation-check-reason-alias-1' }), p);
  const moved = join(await temp(), 'moved'); await cp(done.runDir, moved, { recursive: true });
  assert.deepEqual((await audit.readReviewEvidenceAudit({ runDir: moved, requestHash: done.requestHash })).report, done.report);
  assert.deepEqual(await hashes(moved), before); assert.deepEqual(await hashes(dirname(f.runDir)), sourceBefore); assert.equal(calls, 1);
  const report = await json(join(moved, 'result.json')); report.assessments[0].premiseChecks[0].dimensions.event_round.reason = 'tampered interpretation';
  const forged = JSON.stringify(report); await writeFile(join(moved, 'result.json'), forged);
  const sealPath = join(moved, 'seal.json'), seal = await json(sealPath); seal.files['result.json'] = sha(forged); await writeFile(sealPath, JSON.stringify(seal));
  await assert.rejects(() => audit.readReviewEvidenceAudit({ runDir: moved, requestHash: done.requestHash }), e => e.code === 'AUDIT_SEAL_REPLAY');
});

test('v3 structurally skipped premise checks fail terminally with original raw preserved and no analysis retry', async () => {
  const p = await premiseFixture(), r = premiseResponse(p); r.assessments[0].premiseChecks = [];
  const rawResponse = JSON.stringify(r), runRoot = await temp(); let calls = 0;
  const analyze = async args => { calls++; return { rawResponse, receipt: { provider: 'offline-v3', invocationId: 'bad-premises', contextId: 'bad-premises', inputHash: args.inputHash } }; };
  const failed = await audit.runReviewEvidenceAudit({ prepared: p, runRoot, analyze });
  assert.equal(failed.status, 'needs_attention'); assert.equal(failed.error.code, 'AUDIT_PREMISE_COVERAGE');
  const before = await hashes(failed.runDir); await audit.runReviewEvidenceAudit({ prepared: p, runRoot, analyze });
  assert.equal(calls, 1); assert.equal(await readFile(join(failed.runDir, 'raw-response.txt'), 'utf8'), rawResponse);
  assert.deepEqual(await hashes(failed.runDir), before);
});


test('audit rejects unrecognized source tuples and enhanced policy snapshots on replay', async () => {
  const { prepared } = await sourceFixture();
  for (const field of ['protocolVersion', 'rulesVersion', 'toolVersion']) {
    const changed = copy(prepared);
    changed.sourceSnapshot.task.versions[field] = '0'.repeat(64);
    expectCode(() => validate(changed, uncertainResponse(changed)), 'AUDIT_SOURCE_VERSION');
  }
  const changed = copy(prepared);
  changed.sourceSnapshot.task.evidencePolicy = 'unknown-enhanced-policy';
  expectCode(() => validate(changed, uncertainResponse(changed)), 'AUDIT_SOURCE_EVIDENCE_POLICY_UNSUPPORTED');
});
