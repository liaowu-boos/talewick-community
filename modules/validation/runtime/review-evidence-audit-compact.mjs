import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  getReviewEvidenceAuditVersions, validateReviewEvidenceAuditPrepared,
  inspectReviewEvidenceAuditEntries, validateReviewEvidenceAuditResponse,
} from './review-evidence-audit.mjs';
import { PREMISE_SUPPORT_POLICY, PREMISE_DIMENSIONS } from './review-evidence-audit-premises.mjs';
import { canonicalJson, wholeQualitySha256 as hash } from './focused-whole-quality-evaluation.mjs';

// Pure, explicit wire adapter. No dispatch, retries, storage, or adoption authority.
export const AUDIT_COMPACT_WIRE_VERSION = 'review-evidence-audit-compact-1';
const V = AUDIT_COMPACT_WIRE_VERSION;
const sha = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ensure = (ok, code, path = '') => {
  if (!ok) throw Object.assign(new Error(`${code}${path ? ` at ${path}` : ''}`), { code, JSONPointer: path });
};
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
const exact = (value, keys, path) => ensure(object(value)
  && same(Object.keys(value).sort(), [...keys].sort()), 'COMPACT_FIELDS', path);
const obj = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

export function getCompactReviewEvidenceAuditVersions() {
  const path = fileURLToPath(import.meta.url), stat = lstatSync(path);
  ensure(stat.isFile() && !stat.isSymbolicLink(), 'COMPACT_SOURCE_FILE');
  if (process.platform === 'darwin') {
    const flags = Number(execFileSync('/usr/bin/stat', ['-f', '%f', path], { encoding: 'utf8' }).trim());
    ensure(Number.isInteger(flags) && !(flags & 0x40000000), 'COMPACT_DATALESS_SOURCE');
  }
  return freeze({ wireVersion: V, toolVersion: hash({ sourceSha256: sha(readFileSync(path)),
    canonicalValidator: getReviewEvidenceAuditVersions({ auditPolicyVersion: PREMISE_SUPPORT_POLICY }) }) });
}

// The original semantic instructions remain present. This explicit wire appendix
// changes only redundant serialization fields; it is itself request-hash bound.
const WIRE_INSTRUCTION = `【显式compact-1传输；下列字段规则替代上文同名序列化规则，语义标准不变】
本次只回答packet.targets列出的固定targetIds。其它target已由宿主冻结，不得重审或输出。全文双稿及其所有paragraphs仍完整保留，不能只读原引用。全部原引用citationId和claimSource仍须覆盖，不能漏项。
contentRef是S加SHA-256前16位的内容地址，textContents保存完整sha256并拒绝地址冲突；查text或catalogAnchorId，再读取完整catalog对应段落text。它只复用字符串，不合并事件/位置/身份；每条原citation仍以自己blindId/chapterId/start/anchorId为准。original里的单字段{contentRef}精确代替原字符串，未改原意见。
仅输出随本次请求提供的JSON Schema规定的紧凑JSON，不加Markdown。root使用schemaVersion和wireRequestHash；assessment只填targetId，不再输出targetSHA。claim、factCoverage及premiseChecks以该target.claimSources中的claimId绑定，替代JSONPointer。factChecks.claim的quote/start仍须是该原字段的精确连续片段与UTF-16位置，不能从正文或别的target取句。
事实维度唯一权威是factChecks[].dimensions，必须非空；五类之外的明确事实也须显式other_explicit_fact。不要另填任何factIds：宿主按同claimId和dimensions纯机械生成premiseChecks.factIds，按同claimId生成factCoverage.factIds，按全部本target事实生成wholeTextCheck依赖。factDependencies只填originalCitationSupport数组，保留你对原引用轴依赖哪些事实的判断。
每个claimId的premiseChecks仍必须逐一填写五维{disposition,reason}。identified必须存在同字段同维事实；not_applicable必须不存在；unresolved仍要求该字段factCoverage为unresolved。未知真假用fact.status uncertain，不等于维度不存在。每条fact.status严格仅supported/contradicted/uncertain；partial只能用于两个解释轴或citationChecks，绝不用于事实。
所有判断、理由、范围、反证和原引用成员均由你保留。宿主不改评价、不补事实、不把partial改uncertain。每个理由一句短而具体的话；不重复原文、故事摘要或方法说明，不为压缩而少答任何target/citation/claim。严格结构合法不代表语义已证实，不给文学通过、总分或偏好票。`;

function schemaFor(prepared, targets, wireRequestHash) {
  const item = clone(prepared.packet.responseContract.properties.assessments.items);
  delete item.properties.targetSHA;
  item.required = item.required.filter(k => k !== 'targetSHA');
  item.properties.targetId = { type: 'string', enum: targets.map(t => t.targetId) };
  const claims = targets.flatMap(t => t.claimSources.map(c => c.claimId));
  const replacePointer = schema => {
    delete schema.properties.JSONPointer;
    schema.properties.claimId = { type: 'string', enum: claims };
    schema.required = schema.required.map(k => k === 'JSONPointer' ? 'claimId' : k);
  };
  replacePointer(item.properties.factChecks.items.properties.claim);
  const coverage = item.properties.factCoverage.items;
  replacePointer(coverage); delete coverage.properties.factIds;
  coverage.required = coverage.required.filter(k => k !== 'factIds');
  const premises = item.properties.premiseChecks.items;
  replacePointer(premises);
  for (const dimension of PREMISE_DIMENSIONS) {
    const check = premises.properties.dimensions.properties[dimension];
    delete check.properties.factIds; check.required = check.required.filter(k => k !== 'factIds');
  }
  delete item.properties.factDependencies.properties.wholeTextCheck;
  item.properties.factDependencies.required = ['originalCitationSupport'];
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...obj({
    schemaVersion: { type: 'string', const: `${V}-response` },
    wireRequestHash: { type: 'string', const: wireRequestHash },
    assessments: { type: 'array', minItems: targets.length, maxItems: targets.length, items: item },
  }) };
  // The CLI structured-output subset does not promise uniqueItems. All such
  // uniqueness checks still run in the unchanged canonical host validator.
  let enumValues = 0, stringCharacters = 0;
  const external = value => {
    if (typeof value === 'string') { stringCharacters += value.length; return; }
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value)) {
      delete value.uniqueItems;
      if (value.enum) {
        enumValues += value.enum.length;
        if (!value.type && value.enum.every(v => typeof v === 'string')) value.type = 'string';
      }
      stringCharacters += Object.keys(value).reduce((n, k) => n + k.length, 0);
    }
    Object.values(value).forEach(external);
  };
  external(schema);
  const depth = s => (s.type === 'object' || s.type === 'array' ? 1 : 0)
    + Math.max(0, ...Object.values(s.properties ?? {}).map(depth), ...(s.items ? [depth(s.items)] : []));
  ensure(enumValues <= 1000 && stringCharacters <= 120000 && depth(schema) <= 10, 'COMPACT_SCHEMA_LIMIT');
  return schema;
}

function compactTargets(prepared, selectedIds) {
  const anchors = new Map();
  for (const m of prepared.packet.manuscripts) for (const ch of m.chapters) for (const p of ch.paragraphs) {
    if (!anchors.has(p.text)) anchors.set(p.text, p.anchorId);
  }
  const textContents = {};
  const ref = text => {
    const digest = sha(text), id = `S${digest.slice(0, 16)}`;
    const value = { sha256: digest, ...(anchors.has(text) ? { catalogAnchorId: anchors.get(text) } : { text }) };
    ensure(!Object.hasOwn(textContents, id) || same(textContents[id], value), 'COMPACT_CONTENT_COLLISION');
    textContents[id] = value; return id;
  };
  const targets = prepared.packet.targets.filter(t => selectedIds.includes(t.targetId)).map(target => {
    const strings = new Map([...target.claimSources.map(s => s.text), ...target.originalCitations.map(c => c.quote)]
      .map(text => [text, ref(text)]));
    const replace = value => {
      if (typeof value === 'string') return strings.has(value) ? { contentRef: strings.get(value) } : value;
      if (Array.isArray(value)) return value.map(replace);
      if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
      return value;
    };
    return { ...clone(target), original: replace(target.original),
      claimSources: target.claimSources.map((s, i) => ({ claimId: `${target.targetId}.C${i + 1}`,
        JSONPointer: s.JSONPointer, contentRef: strings.get(s.text) })),
      originalCitations: target.originalCitations.map(({ quote, ...c }) => ({ ...c, contentRef: strings.get(quote) })) };
  });
  return { targets, textContents };
}

export function prepareCompactReviewEvidenceAudit({ prepared, targetIds, priorRawResponse } = {}) {
  const canonicalPrepared = validateReviewEvidenceAuditPrepared({ prepared });
  ensure(canonicalPrepared.auditPolicyVersion === PREMISE_SUPPORT_POLICY, 'COMPACT_REQUIRES_V3');
  const allIds = canonicalPrepared.packet.targets.map(t => t.targetId);
  const subset = targetIds !== undefined || priorRawResponse !== undefined;
  let selectedIds = allIds, inspection = null, protectedAssessments = [];
  if (subset) {
    ensure(Array.isArray(targetIds) && targetIds.length > 0 && new Set(targetIds).size === targetIds.length
      && targetIds.every(id => allIds.includes(id)) && typeof priorRawResponse === 'string', 'COMPACT_SUBSET_INPUT');
    inspection = inspectReviewEvidenceAuditEntries({ prepared: canonicalPrepared, rawResponse: priorRawResponse });
    const invalidIds = inspection.entries.filter(e => !e.valid).map(e => e.targetId);
    ensure(same([...targetIds].sort(), [...invalidIds].sort()), 'COMPACT_SUBSET_MUST_EQUAL_INVALID');
    selectedIds = allIds.filter(id => targetIds.includes(id));
    protectedAssessments = inspection.entries.filter(e => e.valid)
      .map(({ targetId, targetSHA, assessmentSha256 }) => ({ targetId, targetSHA, assessmentSha256 }));
  }
  const { targets, textContents } = compactTargets(canonicalPrepared, selectedIds);
  const versions = getCompactReviewEvidenceAuditVersions();
  const selection = { mode: subset ? 'invalid_entries_only' : 'all_targets', targetIds: selectedIds,
    priorRawResponseSha256: subset ? sha(priorRawResponse) : null, protectedAssessments };
  const instruction = `${canonicalPrepared.instruction}\n\n${WIRE_INSTRUCTION}`;
  const packetBody = { schemaVersion: `${V}-packet`, stage: 'review_evidence_audit',
    policyVersion: PREMISE_SUPPORT_POLICY, disclosure: canonicalPrepared.packet.disclosure,
    canonicalRequestHash: canonicalPrepared.requestHash, canonicalInputHash: canonicalPrepared.inputHash,
    canonicalVersions: canonicalPrepared.versions, sourceReviewTaskId: canonicalPrepared.binding.sourceReviewTaskId,
    sourceRequestHash: canonicalPrepared.binding.sourceRequestHash,
    sourceSnapshotSha256: canonicalPrepared.binding.sourceSnapshotSha256,
    sourceReportSha256: canonicalPrepared.binding.sourceReportSha256,
    mechanicalFacts: clone(canonicalPrepared.packet.mechanicalFacts),
    manuscripts: clone(canonicalPrepared.packet.manuscripts),
    allTargets: canonicalPrepared.packet.targets.map(t => ({ targetId: t.targetId, targetSHA: t.targetSHA,
      stageId: t.stageId, readerId: t.readerId, JSONPointer: t.JSONPointer, kind: t.kind,
      allowedBlindIds: clone(t.allowedBlindIds), originalRecordSha256: t.originalRecordSha256 })),
    selection, textContents, targets };
  const wireRequestHash = hash({ versions, packetBody, instruction,
    responseSchemaTemplate: schemaFor(canonicalPrepared, targets, 'WIRE_REQUEST_HASH') });
  const packet = { ...packetBody, wireRequestHash };
  const responseSchema = schemaFor(canonicalPrepared, targets, wireRequestHash);
  const inputHash = hash({ packet, instruction, responseSchema });
  return freeze({ schemaVersion: `${V}-prepared`, versions, canonicalPrepared,
    priorRawResponse: subset ? priorRawResponse : null, selection, packet, instruction,
    responseSchema, wireRequestHash, inputHash });
}

function validatePrepared(value) {
  ensure(object(value), 'COMPACT_PREPARED_BINDING');
  const expected = prepareCompactReviewEvidenceAudit({ prepared: value.canonicalPrepared,
    ...(value.priorRawResponse !== null ? { targetIds: value.selection?.targetIds, priorRawResponse: value.priorRawResponse } : {}) });
  ensure(same(value, expected), 'COMPACT_PREPARED_BINDING'); return expected;
}

export function getCompactReviewEvidenceAuditResponseSchema({ compactPrepared } = {}) {
  return validatePrepared(compactPrepared).responseSchema;
}

// Validate exactly the subset of JSON Schema generated above. Semantic/binding
// predicates remain the canonical validator's responsibility, never a coercion.
function schemaCheck(value, schema, path = '') {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const isType = t => t === 'null' ? value === null : t === 'array' ? Array.isArray(value)
      : t === 'object' ? object(value) : t === 'integer' ? Number.isSafeInteger(value) : typeof value === t;
    ensure(types.some(isType), 'COMPACT_SCHEMA_TYPE', path);
  }
  if (Object.hasOwn(schema, 'const')) ensure(same(value, schema.const), 'COMPACT_SCHEMA_CONST', path);
  if (schema.enum) ensure(schema.enum.some(v => same(v, value)), 'COMPACT_SCHEMA_ENUM', path);
  if (typeof value === 'string' && schema.minLength !== undefined) ensure(value.length >= schema.minLength, 'COMPACT_SCHEMA_LENGTH', path);
  if (typeof value === 'number' && schema.minimum !== undefined) ensure(value >= schema.minimum, 'COMPACT_SCHEMA_MINIMUM', path);
  if (object(value) && schema.properties) {
    exact(value, schema.required, path);
    for (const [k, s] of Object.entries(schema.properties)) schemaCheck(value[k], s, `${path}/${k}`);
  }
  if (Array.isArray(value)) {
    ensure((schema.minItems === undefined || value.length >= schema.minItems)
      && (schema.maxItems === undefined || value.length <= schema.maxItems), 'COMPACT_SCHEMA_LENGTH', path);
    if (schema.uniqueItems) ensure(new Set(value.map(canonicalJson)).size === value.length, 'COMPACT_SCHEMA_DUPLICATE', path);
    if (schema.items) value.forEach((v, i) => schemaCheck(v, schema.items, `${path}/${i}`));
  }
}

export function decodeCompactReviewEvidenceAuditResponse({ compactPrepared, rawResponse } = {}) {
  const p = validatePrepared(compactPrepared);
  ensure(typeof rawResponse === 'string', 'COMPACT_RAW');
  let response;
  try { response = JSON.parse(rawResponse); } catch { ensure(false, 'COMPACT_JSON'); }
  schemaCheck(response, p.responseSchema);
  const seen = new Set(), derivations = [], decoded = new Map();
  for (const [i, a] of response.assessments.entries()) {
    const target = p.packet.targets.find(t => t.targetId === a.targetId);
    ensure(target && !seen.has(a.targetId), 'COMPACT_TARGET_COVERAGE', `/assessments/${i}`); seen.add(a.targetId);
    const claims = new Map(target.claimSources.map(c => [c.claimId, c]));
    const pointer = (id, path) => {
      ensure(claims.has(id), 'COMPACT_CLAIM_TARGET', path); return claims.get(id).JSONPointer;
    };
    const facts = a.factChecks.map((f, j) => {
      const { claimId, ...claim } = f.claim;
      const JSONPointer = pointer(claimId, `/assessments/${i}/factChecks/${j}/claim`);
      derivations.push({ wireJSONPointer: `/assessments/${i}/factChecks/${j}/claim/claimId`,
        targetId: a.targetId, claimId, sourceJSONPointer: JSONPointer });
      return { ...clone(f), claim: { JSONPointer, ...claim } };
    });
    const factIdsFor = (claimId, dimension) => {
      const source = pointer(claimId, `/assessments/${i}`);
      return facts.filter(f => f.claim.JSONPointer === source && (dimension === undefined || f.dimensions.includes(dimension))).map(f => f.factId);
    };
    const coverage = a.factCoverage.map(({ claimId, ...c }) => ({ JSONPointer: pointer(claimId, `/assessments/${i}/factCoverage`),
      ...clone(c), factIds: factIdsFor(claimId) }));
    const premises = a.premiseChecks.map(({ claimId, dimensions }) => ({ JSONPointer: pointer(claimId, `/assessments/${i}/premiseChecks`),
      dimensions: Object.fromEntries(PREMISE_DIMENSIONS.map(d => [d, { ...clone(dimensions[d]), factIds: factIdsFor(claimId, d) }])) }));
    const canonical = { targetId: a.targetId, targetSHA: target.targetSHA,
      factChecks: facts, factCoverage: coverage, premiseChecks: premises,
      factDependencies: { originalCitationSupport: clone(a.factDependencies.originalCitationSupport), wholeTextCheck: facts.map(f => f.factId) },
      originalCitationSupport: clone(a.originalCitationSupport), wholeTextCheck: clone(a.wholeTextCheck) };
    decoded.set(a.targetId, canonical);
    derivations.push({ targetId: a.targetId, targetSHA: target.targetSHA,
      factCoverageIds: coverage.map(c => ({ JSONPointer: c.JSONPointer, factIds: c.factIds })),
      premiseFactIds: premises.map(c => ({ JSONPointer: c.JSONPointer,
        dimensions: Object.fromEntries(PREMISE_DIMENSIONS.map(d => [d, c.dimensions[d].factIds])) })),
      wholeTextFactIds: canonical.factDependencies.wholeTextCheck });
  }
  ensure(seen.size === p.selection.targetIds.length, 'COMPACT_TARGET_COVERAGE');
  if (p.priorRawResponse !== null) {
    const prior = JSON.parse(p.priorRawResponse);
    for (const entry of p.selection.protectedAssessments) {
      const a = prior.assessments.find(a => a.targetId === entry.targetId);
      ensure(a && hash(a) === entry.assessmentSha256 && !decoded.has(entry.targetId), 'COMPACT_PROTECTED_ASSESSMENT');
      decoded.set(entry.targetId, clone(a));
    }
  }
  const canonicalResponse = { schemaVersion: 'review-evidence-audit-3-response', requestHash: p.canonicalPrepared.requestHash,
    assessments: p.canonicalPrepared.packet.targets.map(t => decoded.get(t.targetId)) };
  ensure(canonicalResponse.assessments.every(Boolean) && decoded.size === canonicalResponse.assessments.length, 'COMPACT_FINAL_COVERAGE');
  const canonicalSerialization = JSON.stringify(canonicalResponse);
  const strict = validateReviewEvidenceAuditResponse({ prepared: p.canonicalPrepared,
    response: canonicalResponse, rawResponse: canonicalSerialization });
  const proof = { schemaVersion: `${V}-proof`, versions: p.versions, wireRequestHash: p.wireRequestHash, inputHash: p.inputHash,
    rawResponseSha256: sha(rawResponse), parsedWireResponseSha256: hash(response),
    canonicalResponseSha256: hash(canonicalResponse), canonicalSerializationSha256: sha(canonicalSerialization),
    canonicalResultSha256: hash(strict.result), canonicalStrictValidationProof: strict.proof,
    representation: 'host_decoded_compact_wire_not_provider_canonical_raw',
    priorRawResponseSha256: p.selection.priorRawResponseSha256, protectedAssessments: clone(p.selection.protectedAssessments),
    derivations, automaticAdoption: false, semanticAccuracy: 'NOT_VERIFIED' };
  return freeze({ canonicalResponse, canonicalSerialization, result: strict.result, proof });
}

export function verifyCompactReviewEvidenceAuditDecoded({ compactPrepared, rawResponse, decoded } = {}) {
  const expected = decodeCompactReviewEvidenceAuditResponse({ compactPrepared, rawResponse });
  ensure(same(expected, decoded), 'COMPACT_DECODED_REPLAY'); return expected;
}
