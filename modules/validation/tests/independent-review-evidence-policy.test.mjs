import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDifferenceAudit, augmentReviewPrompt, inspectLiteralIdentityAssertions, GENERAL_EVIDENCE_RULES, hash } from '../runtime/independent-review-evidence-policy.mjs';
import { prepareCodexAnchorPacket, resolveCodexAnchorResponse, codexResponseSchema } from '../runtime/independent-review-short-anchors.mjs';

test('delivered hashes cover augmented prompts independently of the frozen protocol hash', () => {
  const diff = computeDifferenceAudit(chapters, candidate);
  const args = { stage: 'independent-review:goal-audit', system: '当前 packet 是唯一输入。',
    user: JSON.stringify({ inputHash: 'a'.repeat(64), packet: { stage: 'goal_audit' } }) };
  const { prompt, binding } = augmentReviewPrompt(args, diff);
  assert.equal(binding.protocolInputHash, 'a'.repeat(64));
  assert.equal(binding.protocolHashCoversAugmentation, false);
  assert.equal(binding.deliveredSystemSHA256, hash(prompt.system));
  assert.equal(binding.deliveredUserSHA256, hash(prompt.user));
  assert.equal(binding.deliveredInputSHA256, hash(prompt));
  assert.equal(binding.supplementSHA256, hash(JSON.parse(prompt.user).supplement));
  assert.notEqual(binding.deliveredInputSHA256, binding.protocolInputHash);
});

test('short-anchor boundaries preserve CRLF and surrogate pairs without dropping whitespace', () => {
  for (const body of ['x'.repeat(239) + '\r\n终', 'x'.repeat(239) + '😀终', ' '.repeat(241)]) {
    const { packet } = prepareCodexAnchorPacket({ caseId: 'boundaries', manuscripts: [
      { blindId: 'A', chapters: [{ id: 'c', title: '', body }] },
      { blindId: 'B', chapters: [{ id: 'c', title: '', body: '乙。' }] },
    ], readingFocusDefinitions: [] });
    const parts = packet.manuscripts[0].chapters[0].paragraphs;
    assert.equal(parts.map(p => p.text).join(''), body);
    assert(parts.every(p => p.text.length <= 240 && !/[\uD800-\uDBFF\r]$/.test(p.text)));
    if (!body.trim()) assert(parts.every(p => p.citable === false));
  }
});

test('modified prompt, cross-anchor quotation and malformed JSON fail without derived output', () => {
  const f = codexFixture();
  const prompt = JSON.parse(f.promptText), user = JSON.parse(prompt.user);
  user.packet.manuscripts[0].chapters[0].paragraphs[0].text += '变';
  prompt.user = JSON.stringify(user);
  const drift = resolveCodexAnchorResponse({ promptText: JSON.stringify(prompt), rawResponse: JSON.stringify(f.response) });
  assert.equal(drift.errors[0].code, 'INVALID_PROMPT_BINDING');
  const { packet } = prepareCodexAnchorPacket({ caseId: 'anonymous', manuscripts: [
    { blindId: 'A', chapters: [{ id: 'c', title: '', body: 'x'.repeat(239) + '甲乙' }] },
    { blindId: 'B', chapters: [{ id: 'c', title: '', body: '把纸递出去。' }] },
  ], readingFocusDefinitions: [] });
  f.promptText = JSON.stringify({ user: JSON.stringify({ packet }) });
  f.response.manuscriptAssessments[0].evidence[0].quote = '甲乙';
  for (const rawResponse of [JSON.stringify(f.response), '{']) {
    const result = resolveCodexAnchorResponse({ promptText: f.promptText, rawResponse });
    assert.notEqual(result.passed, true);
    assert.equal(result.derivedResponse, undefined);
    assert.equal(result.rawResponseChanged, false);
  }
});

test('a located quote does not establish the truth of the associated claim', () => {
  const f = codexFixture();
  f.response.keyFindings[0].claim = '合成的无依据断言：所有人都已离开。';
  const result = resolveCodexAnchorResponse({ promptText: f.promptText, rawResponse: JSON.stringify(f.response) });
  assert.equal(result.exactCitationIntegrity, true);
  assert.equal(result.semanticSupportVerified, false);
  assert.equal(result.qualityPass, 'NOT_COMPUTED');
});

const chapters = [{ id: 'c1', title: '门边', body: '甲把伞放在门边。屋里没有人说话，她等了一会儿。\n\n乙说：“请把门关上。”甲转过身，手仍停在门把上。' },
  { id: 'c2', title: '留下', body: '甲拿起纸张。窗外的雨停了，门口的人还没有离开。她终于走向门口，把纸递给乙。' }];
const candidate = structuredClone(chapters); candidate[1].body += '乙没有伸手。';
test('augmentation preserves original packet byte serialization and input object; stage7 proof is separate', () => {
  const diff = computeDifferenceAudit(chapters, candidate);
  for (const stage of ['independent_reading', 'blind_pair', 'goal_audit']) {
    const original = { inputHash: 'a'.repeat(64), packet: { stage, protocolPacket: { packetSha256: 'frozen-sha', manuscripts: [] } } };
    const args = { system: '当前 packet 是唯一输入。', user: JSON.stringify(original), stage: `independent-review:${stage.replaceAll('_', '-')}` };
    const old = JSON.stringify(args), result = augmentReviewPrompt(args, diff), decoded = JSON.parse(result.prompt.user);
    assert.equal(JSON.stringify(args), old); assert.equal(JSON.stringify(decoded.packet), JSON.stringify(original.packet));
    assert.equal(decoded.inputHash, original.inputHash); assert.equal(Object.hasOwn(decoded, 'supplement'), stage === 'goal_audit');
    if (stage !== 'goal_audit') assert.equal(result.prompt.user, args.user);
  }
});
test('literal diff catches late tiny edits, title-only changes and whitespace; replacement reconstructs Unicode original exactly', () => {
  const d = computeDifferenceAudit(chapters, candidate); assert.deepEqual(d.changedChapterIds, ['c2']); assert.equal(d.allTextIdentical, false);
  for (const [before, after] of [['甲😀乙', '甲😁乙'], ['甲\r\n乙', '甲\n乙'], ['a b', 'a  b'], ['', '增'], ['删', '']]) {
    const old = [{ id: 'c', title: '题', body: before }], next = [{ id: 'c', title: '题', body: after }];
    const span = computeDifferenceAudit(old, next).chapters[0].replacement;
    assert.equal(before.slice(0, span.start) + span.afterText + before.slice(span.beforeEnd), after);
  }
  const title = structuredClone(chapters); title[1].title += '！';
  assert.equal(computeDifferenceAudit(chapters, title).allTextIdentical, false);
  assert.equal(computeDifferenceAudit(chapters, structuredClone(chapters)).allTextIdentical, true);
});
test('integrity flag detects false global sameness without altering original model judgment, does not conflate no preference or explicit negation', () => {
  const d = computeDifferenceAudit(chapters, candidate), raw = JSON.stringify({ rationale: '两个版本全文逐字相同。', preference: 'no_clear_preference' });
  assert.equal(inspectLiteralIdentityAssertions(raw, d).status, 'needs_manual_review');
  assert.equal(inspectLiteralIdentityAssertions(JSON.stringify({ rationale: '不能说两稿完全相同。' }), d).status, 'no_conflict_detected_by_narrow_rule');
  assert.equal(inspectLiteralIdentityAssertions(JSON.stringify({ rationale: '两稿情节相近，没有明显偏好。' }), d).status, 'no_conflict_detected_by_narrow_rule');
  assert.equal(inspectLiteralIdentityAssertions(raw, d).modelJudgmentChanged, false);
  assert(GENERAL_EVIDENCE_RULES.includes('对话能证明某人说过某句话'));
});
function codexFixture() {
  const { packet } = prepareCodexAnchorPacket({ caseId: 'anonymous', manuscripts: [
    { blindId: 'A', chapters: [{ id: 'c', title: '题', body: '甲😀把伞放在门边。重复。重复。' + '长'.repeat(300) }] },
    { blindId: 'B', chapters: [{ id: 'c', title: '题', body: '乙把纸递出去。门口的人没有伸手。' }] },
  ], readingFocusDefinitions: [] });
  const a = packet.manuscripts[0].chapters[0].paragraphs[0].anchorId, b = packet.manuscripts[1].chapters[0].paragraphs[0].anchorId;
  const response = { caseId: 'anonymous', manuscriptAssessments: [
    { blindId: 'A', assessment: '合成评价', evidence: [{ anchorId: a, quote: '把伞放在门边。' }], counterEvidence: [] },
    { blindId: 'B', assessment: '合成评价', evidence: [{ anchorId: b, quote: '把纸递出去。' }], counterEvidence: [] },
  ], preference: 'tradeoff', rationale: '合成回归', keyFindings: [{ claimType: 'hard_fact', claim: '甲把伞放在门边', evidence: [{ anchorId: a, quote: '把伞放在门边。' }], counterEvidence: [], uncertainty: '' }] };
  const promptText = JSON.stringify({ user: JSON.stringify({ packet, responseContract: codexResponseSchema() }) });
  return { packet, response, promptText, a, b };
}
test('Codex short anchors preserve whole body and derive UTF16 position without changing raw JSON; exact quote is not semantic pass', () => {
  const f = codexFixture(), raw = JSON.stringify(f.response), r = resolveCodexAnchorResponse({ promptText: f.promptText, rawResponse: raw });
  assert.equal(r.passed, true, JSON.stringify(r.errors)); assert.equal(r.mappings[0].start, 3);
  assert.equal(r.rawResponseChanged, false); assert.equal(r.semanticSupportVerified, false); assert.equal(r.qualityPass, 'NOT_COMPUTED');
  assert.equal(f.packet.manuscripts[0].chapters[0].paragraphs.map(p => p.text).join(''), '甲😀把伞放在门边。重复。重复。' + '长'.repeat(300));
});
test('Codex rejects old guessed start, chapter-wide quote, ambiguous short quote, wrong text/anchor/arm, and a hard_fact without citations', () => {
  const cases = [
    f => { f.response.manuscriptAssessments[0].evidence[0].start = 999; },
    f => { f.response.manuscriptAssessments[0].evidence[0].quote = '长'.repeat(161); },
    f => { f.response.manuscriptAssessments[0].evidence[0].quote = '重复。'; },
    f => { f.response.manuscriptAssessments[0].evidence[0].quote = '正文不存在的动作'; },
    f => { f.response.manuscriptAssessments[0].evidence[0].anchorId = 'C99999'; },
    f => { f.response.manuscriptAssessments[0].evidence[0] = { anchorId: f.b, quote: '把纸递出去。' }; },
    f => { f.response.keyFindings[0].evidence = []; },
  ];
  for (const edit of cases) { const f = codexFixture(); edit(f); const r = resolveCodexAnchorResponse({ promptText: f.promptText, rawResponse: JSON.stringify(f.response) }); assert.notEqual(r.passed, true); assert(r.errors.length); }
});
