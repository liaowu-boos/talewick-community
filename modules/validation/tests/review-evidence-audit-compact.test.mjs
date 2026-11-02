import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as compact from '../runtime/review-evidence-audit-compact.mjs';
import * as audit from '../runtime/review-evidence-audit.mjs';
import * as review from '../runtime/independent-review-task.mjs';
import * as quality from '../runtime/focused-whole-quality-evaluation.mjs';
import { PREMISE_SUPPORT_POLICY, PREMISE_DIMENSIONS } from '../runtime/review-evidence-audit-premises.mjs';

globalThis.fetch = () => { throw new Error('NO_NETWORK_IN_COMPACT_TESTS'); };
const copy = v => structuredClone(v);
const sha = v => createHash('sha256').update(v).digest('hex');
const roots = [];
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
const chapters = [
  { id: 'start', title: '启程', body: '😀领航员把罗盘还给学员。\r\n\r\n学员说：“已付款。”\n\n账簿没有付款记录。\n\n' + '中文与emoji😀。'.repeat(150) },
  { id: 'end', title: '归港', body: '雨停后，学员推开门。\n\n领航员把未盖章的收据收进口袋。' },
];
const statements = ['领航员把罗盘还给学员，使我感到释然。', '学员已经付款，领航员替他保管收据。'];
let fixturePromise;
async function fixture() {
  fixturePromise ??= (async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'audit-compact-'))); roots.push(root);
    const request = { caseId: 'synthetic-compact-transport', mode: 'compare', baselineChapters: chapters,
      candidate: { mode: 'no_change', chapters }, readingFocusVersion: quality.READING_FOCUS_VERSION,
      readingFocusDefinitions: quality.getLiteraryReadingFocusDefinitions(),
      goals: [{ id: 'g', statement: '新增归还后的可见后果。', claimType: 'editorial_hypothesis',
        sourceEvidence: [{ chapterId: 'start', quote: '😀领航员把罗盘还给学员。', start: 0 }],
        counterCase: [{ chapterId: 'end', quote: '雨停后，学员推开门。', start: 0 }], expectedEffect: '新后果。',
        failureCriterion: '全文无变化。', requiredOutcomes: [{ id: 'o', dimension: 'action', description: '可见后果。' }] }] };
    let calls = 0;
    const final = await review.startIndependentReview({ runRoot: root, request, modelCitationMode: 'paragraph_refs_v1', analyze: async args => {
      calls++; const r = copy(args.packet.responseContract.example);
      if (args.stage === 'independent_reading') {
        const e = r.entries[0], evidence = copy(e.focusAssessments[0].evidence);
        e.claims = statements.map((statement, i) => ({ id: `claim-${i}`, claimType: 'editorial_hypothesis', statement, evidence: copy(evidence) }));
      }
      return { outputText: JSON.stringify(r), receipt: { provider: 'offline-synthetic', contextId: `compact-${calls}`,
        invocationId: `compact-${calls}`, inputHash: args.inputHash } };
    } });
    assert.equal(calls, 7); assert.equal(final.status, 'complete', JSON.stringify(final.error));
    const args = { sourceReviewTaskId: 'synthetic-sealed-review', sourceRunDir: final.runDir, sourceRequestHash: final.requestHash };
    const prepared = await audit.prepareReviewEvidenceAudit({ ...args, auditPolicyVersion: PREMISE_SUPPORT_POLICY });
    const c = compact.prepareCompactReviewEvidenceAudit({ prepared });
    return { root, args, final, prepared, c };
  })(); return fixturePromise;
}

function canonicalResponse(p) {
  return { schemaVersion: 'review-evidence-audit-3-response', requestHash: p.requestHash,
    assessments: p.packet.targets.map(t => ({ targetId: t.targetId, targetSHA: t.targetSHA,
      originalCitationSupport: { status: 'uncertain', reason: '预置测试，不宣称语义正确。', supportedScope: null, limits: '保留意见。',
        citationChecks: t.originalCitations.map(c => ({ citationId: c.citationId, status: 'uncertain', basis: 'editorial_interpretation', reason: '仅检验传输。' })) },
      wholeTextCheck: { status: 'uncertain', reason: '预置未知。', supportedScope: null, limits: '没有自动质量通过。', evidence: [], counterEvidence: [], mechanicalFactsUsed: [] },
      factChecks: [], factDependencies: { originalCitationSupport: [], wholeTextCheck: [] },
      factCoverage: t.claimSources.map(s => ({ JSONPointer: s.JSONPointer, disposition: 'unresolved', factIds: [], reason: '未作语义核实。' })),
      premiseChecks: t.claimSources.map(s => ({ JSONPointer: s.JSONPointer, dimensions: Object.fromEntries(PREMISE_DIMENSIONS.map(d => [d,
        { disposition: 'unresolved', reason: '保留未知。', factIds: [] }])) })) })) };
}
const ref = anchorId => ({ anchorId, basis: 'narrated_action', explanation: '仅此动作；不证明全篇结论。' });
function withFacts(p) {
  const r = canonicalResponse(p);
  const t = p.packet.targets.find(t => t.original.statement === statements[0]), a = r.assessments.find(a => a.targetId === t.targetId);
  const anchor = p.packet.manuscripts.find(m => m.blindId === t.allowedBlindIds[0]).chapters[0].paragraphs.find(p => p.citable).anchorId;
  a.factChecks = [{ factId: 'F1', claim: { JSONPointer: '/statement', quote: '领航员把罗盘还给学员', start: null },
    dimensions: ['speaker_actor', 'transfer_direction', 'intent_completion'], status: 'supported', basis: 'narrated_action',
    reason: '预置支持动作，不证明感受。', supportedScope: '归还动作。', limits: '释然属于解释。', evidence: [ref(anchor)], counterEvidence: [] }];
  a.factCoverage = [{ JSONPointer: '/statement', disposition: 'fact_checks', factIds: ['F1'], reason: '同一片段含多个维度。' }];
  a.premiseChecks = [{ JSONPointer: '/statement', dimensions: Object.fromEntries(PREMISE_DIMENSIONS.map(d => [d, {
    disposition: a.factChecks[0].dimensions.includes(d) ? 'identified' : 'not_applicable', reason: `此项：${d}。`,
    factIds: a.factChecks[0].dimensions.includes(d) ? ['F1'] : [] }])) }];
  a.factDependencies = { originalCitationSupport: ['F1'], wholeTextCheck: ['F1'] };
  a.wholeTextCheck = { status: 'partial', reason: '动作有依据；感受不据此证实。', supportedScope: '动作局部。', limits: '未证明文学效果。',
    evidence: [ref(anchor)], counterEvidence: [], mechanicalFactsUsed: [] };
  return { r, t, a, anchor };
}
// Test fixture encoder only: never exported or used on the real rejected raw.
function wire(c, canonical) {
  return { schemaVersion: `${compact.AUDIT_COMPACT_WIRE_VERSION}-response`, wireRequestHash: c.wireRequestHash,
    assessments: c.packet.targets.map(t => {
      const a = copy(canonical.assessments.find(a => a.targetId === t.targetId)); delete a.targetSHA;
      const claimId = pointer => t.claimSources.find(s => s.JSONPointer === pointer).claimId;
      for (const f of a.factChecks) { f.claim.claimId = claimId(f.claim.JSONPointer); delete f.claim.JSONPointer; }
      for (const entry of [...a.factCoverage, ...a.premiseChecks]) { entry.claimId = claimId(entry.JSONPointer); delete entry.JSONPointer; delete entry.factIds; }
      for (const entry of a.premiseChecks) for (const d of PREMISE_DIMENSIONS) delete entry.dimensions[d].factIds;
      delete a.factDependencies.wholeTextCheck; return a;
    }) };
}
const decode = (c, r) => compact.decodeCompactReviewEvidenceAuditResponse({ compactPrepared: c, rawResponse: JSON.stringify(r) });
const rejects = (fn, code) => assert.throws(fn, e => e.code === code, code);

test('complete two-manuscript catalog and all original text/identities roundtrip losslessly, including empty lines and UTF16', async () => {
  const { prepared: p, c } = await fixture();
  assert.deepEqual(c.packet.manuscripts, p.packet.manuscripts);
  for (const m of c.packet.manuscripts) for (const ch of m.chapters) assert.equal(ch.paragraphs.map(p => p.text).join(''), chapters.find(c => c.id === ch.id).body);
  const anchors = new Map(c.packet.manuscripts.flatMap(m => m.chapters.flatMap(ch => ch.paragraphs)).map(p => [p.anchorId, p.text]));
  const text = id => { const e = c.packet.textContents[id]; const s = e.text ?? anchors.get(e.catalogAnchorId); assert.equal(sha(s), e.sha256); assert.equal(id, `S${e.sha256.slice(0, 16)}`); return s; };
  const restore = v => Array.isArray(v) ? v.map(restore) : v && typeof v === 'object'
    ? Object.keys(v).length === 1 && v.contentRef ? text(v.contentRef) : Object.fromEntries(Object.entries(v).map(([k, v]) => [k, restore(v)])) : v;
  for (const t of c.packet.targets) {
    const old = p.packet.targets.find(x => x.targetId === t.targetId);
    assert.equal(t.targetSHA, old.targetSHA); assert.deepEqual(restore(t.original), old.original);
    assert.deepEqual(t.originalCitations.map(({ contentRef, ...e }) => ({ ...e, quote: text(contentRef) })), old.originalCitations);
    assert.deepEqual(t.claimSources.map(({ JSONPointer, contentRef }) => ({ JSONPointer, text: text(contentRef), sha256: c.packet.textContents[contentRef].sha256 })), old.claimSources);
  }
  assert.equal(c.packet.allTargets.length, p.packet.targets.length);
  assert.equal(Object.isFrozen(c.canonicalPrepared.sourceSnapshot), true);
  assert.ok(Object.values(c.packet.textContents).some(v => v.catalogAnchorId));
});

test('roundtrip preserves every semantic value; multidimensional membership is derived exactly once and original validator passes', async () => {
  const { prepared: p, c } = await fixture(), { r } = withFacts(p), response = wire(c, r), rawResponse = JSON.stringify(response);
  const d = compact.decodeCompactReviewEvidenceAuditResponse({ compactPrepared: c, rawResponse });
  assert.deepEqual(d.canonicalResponse, r);
  assert.deepEqual(d.result, audit.validateReviewEvidenceAuditResponse({ prepared: p, response: r, rawResponse: JSON.stringify(r) }).result);
  assert.equal(d.proof.rawResponseSha256, sha(rawResponse));
  assert.notEqual(d.proof.rawResponseSha256, d.proof.canonicalSerializationSha256);
  assert.equal(d.result.literaryPass, 'NOT_COMPUTED'); assert.equal(d.result.automaticAdoption, false);
  assert.deepEqual(compact.verifyCompactReviewEvidenceAuditDecoded({ compactPrepared: c, rawResponse, decoded: d }), d);
});

test('fact status remains supported/contradicted/uncertain; axes may retain partial, unsupported, uncertain with exact reasons', async () => {
  const { prepared: p, c } = await fixture();
  for (const status of ['supported', 'contradicted', 'uncertain']) {
    const { r, a, anchor } = withFacts(p); a.factChecks[0].status = status;
    if (status === 'contradicted') a.factChecks[0].counterEvidence = [ref(anchor)];
    const d = decode(c, wire(c, r)); assert.deepEqual(d.canonicalResponse, r);
  }
  const { r } = withFacts(p), bad = wire(c, r); bad.assessments.find(a => a.factChecks.length).factChecks[0].status = 'partial';
  rejects(() => decode(c, bad), 'COMPACT_SCHEMA_ENUM');
});

test('other_explicit_fact requires explicit membership; no dimension-free facts or semantic guessing', async () => {
  const { prepared: p, c } = await fixture(), { r, a } = withFacts(p);
  a.factChecks[0].dimensions = ['other_explicit_fact'];
  for (const x of Object.values(a.premiseChecks[0].dimensions)) { x.disposition = 'not_applicable'; x.factIds = []; }
  assert.deepEqual(decode(c, wire(c, r)).canonicalResponse, r);
  a.factChecks[0].dimensions = []; rejects(() => decode(c, wire(c, r)), 'COMPACT_SCHEMA_LENGTH');
});

test('identified/not_applicable/unresolved remain strict; omitted or duplicated sources are rejected', async () => {
  const { prepared: p, c } = await fixture(), base = wire(c, withFacts(p).r), index = base.assessments.findIndex(a => a.factChecks.length);
  for (const [change, code] of [
    [a => { a.premiseChecks[0].dimensions.transfer_direction.disposition = 'not_applicable'; }, 'AUDIT_PREMISE_ABSENT_FACT'],
    [a => { a.premiseChecks[0].dimensions.event_round.disposition = 'identified'; }, 'AUDIT_PREMISE_IDENTIFIED_EMPTY'],
    [a => { a.premiseChecks[0].dimensions.event_round.disposition = 'unresolved'; }, 'AUDIT_PREMISE_UNRESOLVED_COVERAGE'],
    [a => { a.premiseChecks = []; }, 'AUDIT_PREMISE_COVERAGE'],
    [a => { a.factCoverage = []; }, 'AUDIT_FACT_COVERAGE'],
    [a => { a.premiseChecks.push(copy(a.premiseChecks[0])); }, 'AUDIT_PREMISE_COVERAGE'],
  ]) { const bad = copy(base); change(bad.assessments[index]); rejects(() => decode(c, bad), code); }
});

test('extra redundant association fields and unknown wire fields reject rather than being ignored', async () => {
  const { prepared: p, c } = await fixture(), base = wire(c, withFacts(p).r), index = base.assessments.findIndex(a => a.factChecks.length);
  for (const change of [
    a => { a.targetSHA = 'ignored'; }, a => { a.factCoverage[0].factIds = []; },
    a => { a.premiseChecks[0].dimensions.speaker_actor.factIds = ['F1']; },
    a => { a.factDependencies.wholeTextCheck = ['F1']; }, a => { a.factChecks[0].claim.JSONPointer = '/statement'; },
    a => { a.extra = true; }, a => { a.originalCitationSupport.citationChecks[0].quote = 'unrequested'; },
  ]) { const bad = copy(base); change(bad.assessments[index]); rejects(() => decode(c, bad), 'COMPACT_FIELDS'); }
});

test('unknown/cross-target claims, wrong-version/anchor references and free quote fields fail', async () => {
  const { prepared: p, c } = await fixture(), { r, t } = withFacts(p), base = wire(c, r), index = base.assessments.findIndex(a => a.factChecks.length);
  const otherClaim = c.packet.targets.find(x => x.targetId !== t.targetId).claimSources[0].claimId;
  const otherAnchor = p.packet.manuscripts.find(m => !t.allowedBlindIds.includes(m.blindId)).chapters[0].paragraphs.find(p => p.citable).anchorId;
  for (const [change, code] of [
    [a => { a.factChecks[0].claim.claimId = otherClaim; }, 'COMPACT_CLAIM_TARGET'],
    [a => { a.premiseChecks[0].claimId = otherClaim; }, 'COMPACT_CLAIM_TARGET'],
    [a => { a.factCoverage[0].claimId = 'UNKNOWN'; }, 'COMPACT_SCHEMA_ENUM'],
    [a => { a.factChecks[0].evidence[0].anchorId = 'UNKNOWN'; }, 'AUDIT_CITATION_BINDING'],
    [a => { a.factChecks[0].evidence[0].anchorId = otherAnchor; }, 'AUDIT_CITATION_BINDING'],
    [a => { a.factChecks[0].evidence[0].quote = '自由引文'; }, 'COMPACT_FIELDS'],
    [a => { a.factChecks[0].claim.quote = '不存在的事实片段'; }, 'AUDIT_FACT_CLAIM_NOT_FOUND'],
    [a => { a.factDependencies.originalCitationSupport = ['foreign-fact']; }, 'AUDIT_FACT_DEPENDENCIES'],
  ]) { const bad = copy(base); change(bad.assessments[index]); rejects(() => decode(c, bad), code); }
});

test('target identity/coverage/request binding reject dropped, duplicated, foreign or canonical-old responses', async () => {
  const { prepared: p, c } = await fixture(), r = canonicalResponse(p), base = wire(c, r);
  for (const [change, code] of [
    [x => x.assessments.pop(), 'COMPACT_SCHEMA_LENGTH'],
    [x => { x.assessments[1] = copy(x.assessments[0]); }, 'COMPACT_TARGET_COVERAGE'],
    [x => { x.assessments[0].targetId = 'foreign'; }, 'COMPACT_SCHEMA_ENUM'],
    [x => { x.wireRequestHash = 'other-request'; }, 'COMPACT_SCHEMA_CONST'],
    [x => { x.schemaVersion = 'review-evidence-audit-3-response'; }, 'COMPACT_SCHEMA_CONST'],
  ]) { const bad = copy(base); change(bad); rejects(() => decode(c, bad), code); }
  rejects(() => decode(c, r), 'COMPACT_FIELDS');
});

test('subset requires exactly all invalid entries, preserves valid values and never sends their judgments', async () => {
  const { prepared: p } = await fixture(), r = canonicalResponse(p), old = copy(r);
  old.assessments[1].premiseChecks[0].dimensions.speaker_actor.disposition = 'identified';
  const priorRawResponse = JSON.stringify(old, null, 2), targetIds = [old.assessments[1].targetId];
  const inspected = audit.inspectReviewEvidenceAuditEntries({ prepared: p, rawResponse: priorRawResponse });
  assert.equal(inspected.entries.filter(e => !e.valid).length, 1); assert.equal(inspected.status, 'inspection_only');
  const c = compact.prepareCompactReviewEvidenceAudit({ prepared: p, targetIds, priorRawResponse });
  assert.equal(c.packet.targets.length, 1); assert.equal(c.selection.protectedAssessments.length, r.assessments.length - 1);
  assert.deepEqual(c.packet.manuscripts, p.packet.manuscripts);
  assert.equal(c.packet.targets.some(t => t.targetId === old.assessments[0].targetId), false);
  const done = decode(c, wire(c, r)); assert.deepEqual(done.canonicalResponse, r);
  for (const entry of c.selection.protectedAssessments) {
    const before = old.assessments.find(a => a.targetId === entry.targetId), after = done.canonicalResponse.assessments.find(a => a.targetId === entry.targetId);
    assert.deepEqual(after, before); assert.equal(quality.wholeQualitySha256(after), entry.assessmentSha256);
  }
  assert.equal(done.proof.priorRawResponseSha256, sha(priorRawResponse));
  for (const ids of [[old.assessments[0].targetId], [old.assessments[0].targetId, ...targetIds]]) {
    rejects(() => compact.prepareCompactReviewEvidenceAudit({ prepared: p, targetIds: ids, priorRawResponse }), 'COMPACT_SUBSET_MUST_EQUAL_INVALID');
  }
  rejects(() => compact.prepareCompactReviewEvidenceAudit({ prepared: p, targetIds }), 'COMPACT_SUBSET_INPUT');
  const globalBad = copy(old); globalBad.assessments[1].targetId = globalBad.assessments[0].targetId;
  rejects(() => compact.prepareCompactReviewEvidenceAudit({ prepared: p, targetIds, priorRawResponse: JSON.stringify(globalBad) }), 'AUDIT_TARGET_BINDING');
});

test('one invalid fix cannot silently drop other invalid entries or replace an old valid target', async () => {
  const { prepared: p } = await fixture(), r = canonicalResponse(p), old = copy(r);
  for (const a of old.assessments.slice(0, 2)) a.premiseChecks[0].dimensions.event_round.disposition = 'identified';
  const targetIds = old.assessments.slice(0, 2).map(a => a.targetId), priorRawResponse = JSON.stringify(old);
  rejects(() => compact.prepareCompactReviewEvidenceAudit({ prepared: p, targetIds: targetIds.slice(0, 1), priorRawResponse }), 'COMPACT_SUBSET_MUST_EQUAL_INVALID');
  const c = compact.prepareCompactReviewEvidenceAudit({ prepared: p, targetIds, priorRawResponse });
  const bad = wire(c, r); bad.assessments[0].targetId = old.assessments[2].targetId;
  rejects(() => decode(c, bad), 'COMPACT_SCHEMA_ENUM');
});

test('hash-bound preparation and decoded proof replay reject source, pool, selection, reason and proof tampering', async () => {
  const { prepared: p, c } = await fixture(), rawResponse = JSON.stringify(wire(c, canonicalResponse(p)));
  for (const mutate of [
    v => { v.packet.manuscripts[0].chapters[0].paragraphs[0].text += '改'; },
    v => { v.packet.textContents[Object.keys(v.packet.textContents)[0]] = { text: '改' }; },
    v => { v.packet.targets[0].claimSources[0].contentRef = 'missing'; },
    v => { v.instruction += 'UNRECORDED'; }, v => { v.selection.targetIds.pop(); },
    v => { v.responseSchema.properties.assessments.minItems = 0; },
  ]) { const bad = copy(c); mutate(bad); rejects(() => compact.decodeCompactReviewEvidenceAuditResponse({ compactPrepared: bad, rawResponse }), 'COMPACT_PREPARED_BINDING'); }
  const done = compact.decodeCompactReviewEvidenceAuditResponse({ compactPrepared: c, rawResponse });
  for (const mutate of [
    d => { d.result.assessments[0].wholeTextCheck.reason = '改评价'; },
    d => { d.proof.rawResponseSha256 = 'forged'; },
    d => { d.proof.derivations.pop(); }, d => { d.canonicalResponse.assessments[0].factCoverage[0].reason = '改'; },
  ]) { const bad = copy(done); mutate(bad); rejects(() => compact.verifyCompactReviewEvidenceAuditDecoded({ compactPrepared: c, rawResponse, decoded: bad }), 'COMPACT_DECODED_REPLAY'); }
});

test('published strict JSON Schema omits redundant membership fields and keeps the fact-status enum unchanged', async () => {
  const { c } = await fixture(), schema = compact.getCompactReviewEvidenceAuditResponseSchema({ compactPrepared: c });
  const a = schema.properties.assessments.items.properties;
  assert.equal(schema.additionalProperties, false); assert.equal(a.targetSHA, undefined);
  assert.deepEqual(a.factChecks.items.properties.status.enum, ['supported', 'contradicted', 'uncertain']);
  assert.equal(a.factCoverage.items.properties.factIds, undefined);
  for (const d of PREMISE_DIMENSIONS) assert.equal(a.premiseChecks.items.properties.dimensions.properties[d].properties.factIds, undefined);
  assert.deepEqual(a.factDependencies.required, ['originalCitationSupport']);
  assert.equal(JSON.stringify(schema).includes('uniqueItems'), false);
  let enumCount = 0, stringCharacters = 0;
  const count = v => {
    if (typeof v === 'string') { stringCharacters += v.length; return; }
    if (!v || typeof v !== 'object') return;
    if (!Array.isArray(v)) {
      enumCount += v.enum?.length ?? 0;
      stringCharacters += Object.keys(v).reduce((n, k) => n + k.length, 0);
    }
    Object.values(v).forEach(count);
  }; count(schema);
  const depth = s => (s.type === 'object' || s.type === 'array' ? 1 : 0)
    + Math.max(0, ...Object.values(s.properties ?? {}).map(depth), ...(s.items ? [depth(s.items)] : []));
  assert.ok(enumCount <= 1000); assert.ok(stringCharacters <= 120000); assert.ok(depth(schema) <= 10);
  assert.match(c.instruction, /只有|仅输出/); assert.match(c.instruction, /事实维度唯一权威/);
});

test('host still rejects repeated dimensions/dependencies/citations when external schema has no uniqueItems', async () => {
  const { prepared: p, c } = await fixture(), base = wire(c, withFacts(p).r), index = base.assessments.findIndex(a => a.factChecks.length);
  for (const [change, code] of [
    [a => { a.factChecks[0].dimensions.push(a.factChecks[0].dimensions[0]); }, 'AUDIT_FACT_DIMENSIONS'],
    [a => { a.factDependencies.originalCitationSupport.push('F1'); }, 'AUDIT_FACT_DEPENDENCIES'],
    [a => { a.factChecks[0].evidence.push(copy(a.factChecks[0].evidence[0])); }, 'AUDIT_CITATION_BINDING'],
    [a => { a.wholeTextCheck.evidence.push(copy(a.wholeTextCheck.evidence[0])); }, 'AUDIT_CITATION_BINDING'],
    [a => { a.originalCitationSupport.citationChecks.push(copy(a.originalCitationSupport.citationChecks[0])); }, 'AUDIT_ORIGINAL_COVERAGE'],
  ]) { const bad = copy(base); change(bad.assessments[index]); rejects(() => decode(c, bad), code); }
});

test('v1/v2 default inputs remain unchanged and cannot opt into compact v3 without canonical preparation', async () => {
  const { args } = await fixture();
  for (const auditPolicyVersion of [undefined, 'fact-subclaims-and-two-axes-2']) {
    const p = await audit.prepareReviewEvidenceAudit({ ...args, auditPolicyVersion }), before = JSON.stringify(p);
    rejects(() => compact.prepareCompactReviewEvidenceAudit({ prepared: p }), 'COMPACT_REQUIRES_V3');
    assert.equal(JSON.stringify(p), before); assert.equal(p.instruction.includes('显式compact-1'), false);
  }
});
