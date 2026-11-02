import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  prepareCompactReviewEvidenceAudit, decodeCompactReviewEvidenceAuditResponse,
  AUDIT_COMPACT_WIRE_VERSION,
} from './review-evidence-audit-compact.mjs';
import { validateFactAssessment } from './review-evidence-audit-facts.mjs';
import { validatePremiseAssessment, PREMISE_DIMENSIONS } from './review-evidence-audit-premises.mjs';
import { EVENT_GROUNDING_INSTRUCTION, prepareAuditEventGrounding, auditEventGroundingAssessmentContractFields,
  checkAuditEventGroundingAssessment } from './review-evidence-audit-event-grounding.mjs';

// Additive transport only. The frozen canonical v3 predicates remain mandatory.
export const BOUND_AUDIT_VERSION = 'review-evidence-audit-claim-bound-2';
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : object(value) ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(canonical(value));
const equal = (a, b) => canonical(a) === canonical(b);
const ensure = (ok, code, pointer = '') => {
  if (!ok) throw Object.assign(new Error(`${code}${pointer ? ` at ${pointer}` : ''}`), { code, JSONPointer: pointer });
};
const obj = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const APPENDIX = `【claim-bound-2：以下传输规则替代compact-1同名字段规则】
只返回responseSchema规定的JSON。assessments是以固定targetId为键的对象，每键只判断该target，不能复制另一target的意见。每个target.claimSources保持完整原字段及归属；claimSpans是宿主从本字段原字节切出的可选连续片段，S0是整个字段。factChecks.claim仅填spanId，不填quote/start/claimId/JSONPointer。宿主会从该span的固定目标和字段机械还原逐字原引文、UTF-16位置；绝不接受你重写、删句拼接或从其它target选句。
选择片段前读完整原字段及全文上下文，保留否定、条件、行动者和范围；短片段不足时选S0或更长片段。不同事实可用不同片段，同一片段多维事实合并dimensions，不重复同一span。核实同一原字段的事实，不能把对方稿或另一评语的命题搬进来。
所有claimId、原citationId、spanId严格限定当前target。premiseChecks的identified只能在factChecks中已列出同claimId同dimension的事实时使用；不能先声明identified再漏掉事实。尚未拆完的字段用unresolved并保留限制，不为通过而把事实写成纯感受。fact.status只有supported/contradicted/uncertain；文学感受不是可证实事件，不得将editorial_interpretation伪装成实际事实supported。
事件核查须区分计划/承诺、实际发生、回忆转述、推测和无法确定。先后关系需正文时间或衔接证据；章节出现顺序不自动等于事件发生顺序，未写不等于没发生，计划时间与实际时间不同不自动构成矛盾。核对事件是否同一轮，不以同一词语代替事件身份。
本次是完整预注册分批审查中的一批；全文双稿仍完整提供。不得输出批外target，也不能把未审批次标成完成。保留所有不利结果与不确定。严格结构合法不证明语义正确，不投票、不打分、不替原作者改稿。`;

export function buildClaimSpans(target) {
  const spans = [];
  for (const [i, source] of target.claimSources.entries()) {
    ensure(typeof source.text === 'string', 'BOUND_SOURCE_TEXT');
    const claimId = `${target.targetId}.C${i + 1}`, intervals = [[0, source.text.length]];
    const boundaries = [0];
    for (const match of source.text.matchAll(/[，,。！？!?；;\n]+/gu)) boundaries.push(match.index + match[0].length);
    if (boundaries.at(-1) !== source.text.length) boundaries.push(source.text.length);
    // Contiguous one/two/three clauses; the full field is always available.
    for (let a = 0; a < boundaries.length - 1; a++) for (let width = 1; width <= 3 && a + width < boundaries.length; width++) {
      intervals.push([boundaries[a], boundaries[a + width]]);
    }
    const seen = new Set(); let n = 0;
    for (const [start, end] of intervals) {
      const quote = source.text.slice(start, end), key = `${start}:${end}`;
      if (!quote.trim() || seen.has(key)) continue;
      seen.add(key); spans.push({ spanId: `${claimId}.S${n++}`, claimId, JSONPointer: source.JSONPointer,
        sourceTextSha256: source.sha256, start, end, quote, quoteSha256: sha(quote) });
    }
  }
  return spans;
}

function schemaFor(compact, targets, hash, eventPrepared) {
  const entries = {};
  for (const target of targets) {
    const item = clone(compact.responseSchema.properties.assessments.items);
    delete item.properties.targetId; item.required = item.required.filter(x => x !== 'targetId');
    item.properties.factChecks.items.properties.claim = obj({ spanId: { type: 'string', enum: target.claimSpans.map(s => s.spanId) } });
    for (const name of ['factCoverage', 'premiseChecks']) {
      item.properties[name].items.properties.claimId = { type: 'string', enum: target.claimSources.map(s => s.claimId) };
    }
    const checks = item.properties.originalCitationSupport.properties.citationChecks;
    checks.minItems = target.originalCitations.length; checks.maxItems = target.originalCitations.length;
    if (target.originalCitations.length) checks.items.properties.citationId = { type: 'string', enum: target.originalCitations.map(c => c.citationId) };
    if (eventPrepared) {
      Object.assign(item.properties, auditEventGroundingAssessmentContractFields({ prepared: eventPrepared, target }));
      item.required.push('eventGrounding');
    }
    entries[target.targetId] = item;
  }
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...obj({
    schemaVersion: { type: 'string', const: `${BOUND_AUDIT_VERSION}-response` },
    batchHash: { type: 'string', const: hash }, assessments: obj(entries),
  }) };
}

export function prepareBoundReviewEvidenceAudit({ prepared, maxTargetsPerBatch = 8, scopeTargetIds, enableEventGrounding = false } = {}) {
  ensure(Number.isInteger(maxTargetsPerBatch) && maxTargetsPerBatch >= 1 && maxTargetsPerBatch <= 12, 'BOUND_BATCH_LIMIT');
  const compact = prepareCompactReviewEvidenceAudit({ prepared });
  ensure(typeof enableEventGrounding === 'boolean', 'BOUND_EVENT_POLICY');
  const eventPrepared = enableEventGrounding ? prepareAuditEventGrounding({ manuscripts: compact.packet.manuscripts }) : null;
  const allIds = compact.packet.targets.map(t => t.targetId);
  if (scopeTargetIds !== undefined) ensure(Array.isArray(scopeTargetIds) && scopeTargetIds.length > 0
    && new Set(scopeTargetIds).size === scopeTargetIds.length && scopeTargetIds.every(id => allIds.includes(id)), 'BOUND_SCOPE');
  const targets = compact.packet.targets.filter(t => scopeTargetIds === undefined || scopeTargetIds.includes(t.targetId))
    .map(t => ({ ...clone(t), claimSpans: buildClaimSpans(prepared.packet.targets.find(x => x.targetId === t.targetId)) }));
  const partitions = [];
  for (const target of targets) {
    const last = partitions.at(-1);
    if (!last || last.length >= maxTargetsPerBatch || last[0].stageId !== target.stageId) partitions.push([target]);
    else last.push(target);
  }
  const versions = { version: BOUND_AUDIT_VERSION, sourceSHA256: sha(readFileSync(new URL(import.meta.url))), predecessor: compact.versions,
    eventGrounding: eventPrepared?.versions ?? null };
  const registration = { versions, canonicalRequestHash: prepared.requestHash, compactRequestHash: compact.wireRequestHash,
    maxTargetsPerBatch, enableEventGrounding, scope: scopeTargetIds === undefined ? 'complete_audit' : 'bounded_regression_only',
    scopeTargetIds: scopeTargetIds === undefined ? null : allIds.filter(id => scopeTargetIds.includes(id)),
    partitions: partitions.map((list, i) => ({ batchId: `batch-${String(i + 1).padStart(2, '0')}`, targets: list.map(t => ({ targetId: t.targetId, targetSHA: t.targetSHA })) })) };
  const registrationHash = digest(registration), instruction = `${compact.instruction}\n\n${APPENDIX}${eventPrepared ? `\n\n${EVENT_GROUNDING_INSTRUCTION}` : ''}`;
  const batches = partitions.map((list, i) => {
    const selection = registration.partitions[i];
    const needed = new Set();
    const visit = value => {
      if (object(value) && typeof value.contentRef === 'string') needed.add(value.contentRef);
      if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(list);
    const packet = { ...clone(compact.packet), schemaVersion: `${BOUND_AUDIT_VERSION}-packet`, registrationHash,
      selection, targets: list, textContents: Object.fromEntries([...needed].map(id => [id, clone(compact.packet.textContents[id])])),
      completeStudyTargetIds: allIds, auditScope: registration.scope,
      ...(eventPrepared ? { eventGrounding: clone(eventPrepared.packet) } : {}) };
    delete packet.wireRequestHash;
    const batchHash = digest({ versions, packet, instruction, schemaTemplate: schemaFor(compact, list, 'BATCH_HASH', eventPrepared) });
    const responseSchema = schemaFor(compact, list, batchHash, eventPrepared);
    return { batchId: selection.batchId, batchHash, packet, instruction, responseSchema };
  });
  return freeze({ schemaVersion: `${BOUND_AUDIT_VERSION}-prepared`, registration, registrationHash, compact, eventPrepared, batches });
}

function checkedPrepared(p) {
  ensure(object(p), 'BOUND_PREPARED');
  const rebuilt = prepareBoundReviewEvidenceAudit({ prepared: p.compact?.canonicalPrepared, maxTargetsPerBatch: p.registration?.maxTargetsPerBatch,
    enableEventGrounding: p.registration?.enableEventGrounding,
    ...(p.registration?.scopeTargetIds === null ? {} : { scopeTargetIds: p.registration?.scopeTargetIds }) });
  ensure(equal(p, rebuilt), 'BOUND_PREPARED_CHANGED'); return rebuilt;
}

function schemaCheck(value, schema, pointer = '') {
  if (schema.anyOf) {
    ensure(schema.anyOf.some(item => { try { schemaCheck(value, item, pointer); return true; } catch { return false; } }), 'BOUND_SCHEMA_ANY_OF', pointer);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    ensure(types.some(t => t === 'null' ? value === null : t === 'array' ? Array.isArray(value)
      : t === 'object' ? object(value) : t === 'integer' ? Number.isSafeInteger(value) : typeof value === t), 'BOUND_SCHEMA_TYPE', pointer);
  }
  if (Object.hasOwn(schema, 'const')) ensure(equal(value, schema.const), 'BOUND_SCHEMA_CONST', pointer);
  if (schema.enum) ensure(schema.enum.some(v => equal(value, v)), 'BOUND_SCHEMA_ENUM', pointer);
  if (typeof value === 'string' && schema.minLength !== undefined) ensure(value.length >= schema.minLength, 'BOUND_SCHEMA_LENGTH', pointer);
  if (typeof value === 'number' && schema.minimum !== undefined) ensure(value >= schema.minimum, 'BOUND_SCHEMA_MINIMUM', pointer);
  if (object(value) && schema.properties) {
    ensure(equal(Object.keys(value).sort(), schema.required.slice().sort()), 'BOUND_SCHEMA_FIELDS', pointer);
    for (const [key, item] of Object.entries(schema.properties)) schemaCheck(value[key], item, `${pointer}/${key}`);
  }
  if (Array.isArray(value)) {
    ensure((schema.minItems === undefined || value.length >= schema.minItems) && (schema.maxItems === undefined || value.length <= schema.maxItems), 'BOUND_SCHEMA_LENGTH', pointer);
    if (schema.uniqueItems) ensure(new Set(value.map(canonical)).size === value.length, 'BOUND_SCHEMA_DUPLICATE', pointer);
    if (schema.items) value.forEach((item, i) => schemaCheck(item, schema.items, `${pointer}/${i}`));
  }
}

export function decodeBoundAuditBatch({ boundPrepared, batchId, rawResponse } = {}) {
  const prepared = checkedPrepared(boundPrepared), batch = prepared.batches.find(b => b.batchId === batchId);
  ensure(batch && typeof rawResponse === 'string', 'BOUND_BATCH');
  let response; try { response = JSON.parse(rawResponse); } catch { ensure(false, 'BOUND_JSON'); }
  schemaCheck(response, batch.responseSchema);
  const derivations = [], eventGroundings = {}, assessments = batch.packet.targets.map(target => {
    const assessment = clone(response.assessments[target.targetId]), spans = new Map(target.claimSpans.map(s => [s.spanId, s]));
    if (prepared.eventPrepared) { eventGroundings[target.targetId] = assessment.eventGrounding; delete assessment.eventGrounding; }
    for (const fact of assessment.factChecks) {
      const span = spans.get(fact.claim.spanId); ensure(span, 'BOUND_SPAN_OWNERSHIP');
      derivations.push({ targetId: target.targetId, factId: fact.factId, ...span });
      fact.claim = { claimId: span.claimId, quote: span.quote, start: span.start };
    }
    return { targetId: target.targetId, ...assessment };
  });
  const canonicalAssessments = assessments.map((assessment, index) => {
    const target = prepared.compact.canonicalPrepared.packet.targets.find(t => t.targetId === assessment.targetId);
    const wireTarget = batch.packet.targets.find(t => t.targetId === assessment.targetId);
    const pointers = new Map(wireTarget.claimSources.map(s => [s.claimId, s.JSONPointer]));
    const facts = assessment.factChecks.map(f => ({ ...clone(f), claim: { JSONPointer: pointers.get(f.claim.claimId), quote: f.claim.quote, start: f.claim.start } }));
    const factIdsFor = (id, dimension) => facts.filter(f => f.claim.JSONPointer === pointers.get(id)
      && (dimension === undefined || f.dimensions.includes(dimension))).map(f => f.factId);
    const c = { targetId: target.targetId, targetSHA: target.targetSHA,
      originalCitationSupport: clone(assessment.originalCitationSupport), wholeTextCheck: clone(assessment.wholeTextCheck), factChecks: facts,
      factDependencies: { originalCitationSupport: clone(assessment.factDependencies.originalCitationSupport), wholeTextCheck: facts.map(f => f.factId) },
      factCoverage: assessment.factCoverage.map(({ claimId, ...v }) => ({ ...clone(v), JSONPointer: pointers.get(claimId), factIds: factIdsFor(claimId) })),
      premiseChecks: assessment.premiseChecks.map(({ claimId, dimensions }) => ({ JSONPointer: pointers.get(claimId), dimensions: Object.fromEntries(PREMISE_DIMENSIONS.map(d => [d,
        { ...clone(dimensions[d]), factIds: factIdsFor(claimId, d) }])) })) };
    const anchors = new Map(prepared.compact.packet.manuscripts.flatMap(m => m.chapters.flatMap(ch => ch.paragraphs.map(p => [p.anchorId, { ...p, blindId: m.blindId }]))));
    const resolveRefs = (refs, pointer) => {
      ensure(Array.isArray(refs), 'BOUND_EVIDENCE_REFS', pointer); const ids = new Set();
      for (const r of refs) { const anchor = anchors.get(r.anchorId);
        ensure(anchor?.citable && target.allowedBlindIds.includes(anchor.blindId) && !ids.has(r.anchorId), 'BOUND_EVIDENCE_OWNERSHIP', pointer); ids.add(r.anchorId); }
      return refs;
    };
    const originalIds = c.originalCitationSupport.citationChecks.map(r => r.citationId);
    ensure(new Set(originalIds).size === originalIds.length && equal([...originalIds].sort(), target.originalCitations.map(r => r.citationId).sort()), 'BOUND_ORIGINAL_CITATIONS');
    resolveRefs(c.wholeTextCheck.evidence, '/wholeTextCheck/evidence'); resolveRefs(c.wholeTextCheck.counterEvidence, '/wholeTextCheck/counterEvidence');
    validateFactAssessment({ target, assessment: c, resolveRefs, assessmentIndex: index });
    validatePremiseAssessment({ target, assessment: c, assessmentIndex: index });
    return c;
  });
  const eventGates = prepared.eventPrepared ? canonicalAssessments.map((assessment, assessmentIndex) => checkAuditEventGroundingAssessment({
    prepared: prepared.eventPrepared, target: prepared.compact.canonicalPrepared.packet.targets.find(t => t.targetId === assessment.targetId),
    assessment, eventGrounding: eventGroundings[assessment.targetId], assessmentIndex })) : [];
  return freeze({ schemaVersion: `${BOUND_AUDIT_VERSION}-batch-decoded`, registrationHash: prepared.registrationHash,
    batchId, batchHash: batch.batchHash, rawResponseSha256: sha(rawResponse), assessments, canonicalAssessments, derivations, eventGroundings, eventGates,
    claimSpanBindingPassed: true, factAndPremiseChecksPassed: true, canonicalAuditComplete: false, semanticAccuracyProven: false, automaticAdoption: false });
}

export function assembleBoundReviewEvidenceAudit({ boundPrepared, responses } = {}) {
  const p = checkedPrepared(boundPrepared);
  ensure(p.registration.scope === 'complete_audit', 'BOUND_REGRESSION_NOT_COMPLETE_AUDIT');
  ensure(Array.isArray(responses) && responses.length === p.batches.length, 'BOUND_ALL_BATCHES_REQUIRED');
  const ids = responses.map(r => r.batchId);
  ensure(new Set(ids).size === ids.length && p.batches.every(b => ids.includes(b.batchId)), 'BOUND_BATCH_COVERAGE');
  const batches = p.batches.map(b => decodeBoundAuditBatch({ boundPrepared: p, batchId: b.batchId,
    rawResponse: responses.find(r => r.batchId === b.batchId).rawResponse }));
  const transported = { schemaVersion: `${AUDIT_COMPACT_WIRE_VERSION}-response`, wireRequestHash: p.compact.wireRequestHash,
    assessments: batches.flatMap(b => b.assessments) };
  // This is explicitly a derived serialization, not a provider raw response.
  const decoded = decodeCompactReviewEvidenceAuditResponse({ compactPrepared: p.compact, rawResponse: JSON.stringify(transported) });
  const eventGates = batches.flatMap(b => b.eventGates), eventGroundingPassed = p.eventPrepared ? eventGates.every(g => !g.needsReview) : null;
  return freeze({ schemaVersion: `${BOUND_AUDIT_VERSION}-assembled`, registrationHash: p.registrationHash,
    providerResponses: batches.map(b => ({ batchId: b.batchId, batchHash: b.batchHash, rawResponseSha256: b.rawResponseSha256 })),
    claimDerivations: batches.flatMap(b => b.derivations), derivedCompactSerialization: transported,
    canonical: decoded, canonicalAuditComplete: true, eventGates, eventGroundingPassed,
    completeEvidenceReview: p.eventPrepared ? eventGroundingPassed : true, semanticAccuracyProven: false, automaticAdoption: false });
}
