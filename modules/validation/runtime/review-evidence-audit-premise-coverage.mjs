import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Additive, opt-in coverage gate. Does not deserialize, repair or replace a v3 assessment.
export const EVENT_PREMISE_COVERAGE_VERSION = 'complete-claim-premise-coverage-1';
const KINDS = ['temporal', 'causal', 'transfer', 'completion'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : object(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const sha = v => createHash('sha256').update(v).digest('hex');
const digest = v => sha(canonical(v));
const equal = (a, b) => canonical(a) === canonical(b);
const clone = v => structuredClone(v);
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const assert = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const exactKeys = (v, keys) => object(v) && equal(Object.keys(v).sort(), [...keys].sort());
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const obj = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const textSchema = { type: 'string', minLength: 1 };
const nullableText = { anyOf: [textSchema, { type: 'null' }] };
const idsSchema = { type: 'array', items: textSchema };

// These surface cues only prevent silent exemptions. They never decide whether a
// story event happened or a proposition is true. Ambiguous/metaphorical uses can
// conservatively remain unresolved. Implicit premises still require a reader.
const CUE_RULES = [
  ['temporal', 'zh-order', /之前|之后|以前|以后|随后|然后|接着|先后|依次|再次|先|后|才|尚未|已经|曾经|最终|最后/gu],
  ['temporal', 'en-order', /\b(?:before|after|then|earlier|later|again|already|previously|finally|not yet)\b/giu],
  ['causal', 'zh-cause', /因为|因此|所以|因而|从而|导致|促使|使得|缘于|源于|归因|前因|作为原因|由此|触发/gu],
  ['causal', 'en-cause', /\b(?:because|therefore|thus|caused?|causes|causing|resulted? in|led to|triggered?)\b/giu],
  ['transfer', 'zh-transfer', /付|收款|收钱|交还|交出|交付|归还|退还|退款|偿还|垫款|垫付|借出|借入|借给|卖|售|买|购|转账|承担.*?费/gu],
  ['transfer', 'en-transfer', /\b(?:paid|pay|payment|received?|returned?|refunded?|sold|sell|bought|buy|lent|borrowed|transferred?)\b/giu],
  ['completion', 'zh-state', /准备|打算|计划|承诺|拟|将要|即将|拒绝|尚未|未曾|已经|已完成|完成|付|交还|交出|归还|退还|卖掉|放弃|承担.*?费/gu],
  ['completion', 'en-state', /\b(?:planned?|plans|intended?|intends|promised?|refused?|already|completed?|will|paid|sold|returned?)\b/giu],
];

export const EVENT_PREMISE_COVERAGE_INSTRUCTION = `【完整原主张覆盖：complete-claim-premise-coverage-1】
按宿主 coverage packet 的全部固定 unit 阅读原 claimSource，连同 sentenceStart/sentenceEnd 整句、相邻句及全文上下文。unit 是原字段的无损分句，不是你已挑选的 fact；必须逐 unit 检查 temporal（先后/同轮）、causal（原因与结果）、transfer（钱物方向）、completion（计划/说法/实际完成）。四路各填写同字段已有 factId 数组，或 not_applicable / unresolved；不要新增另一份事实状态或文学结论。
not_applicable 仅表示完整分句没有此类前提，不表示已选的 fact 没有此类。宿主 reviewCues 是保守的必须考虑提示，不判真假；有提示不能静默 not_applicable，不能适用或未查完用 unresolved 并写一个短 note。没有提示仍须阅读隐含前提；不把提示当小说答案。原句含“得知某事后才付款”时，只查得知与付款各自存在不等于核查了“后才”；须保留关系、否定和条件。时间/因果路由的 fact 片段须覆盖完整分句，不能缩成一个动作躲过关系。
temporal 路由复用该 fact 的 eventGrounding 非 none 检查，两个事件、状态与关系依据仍遵守原 event gate。不能章序=时序、未写=没发生、计划=执行。causal 路由每 fact 只填一个 causalLinks：原因 anchor、结果 anchor、关系依据 anchors 与 basis；全部来自该 fact 自己的支持/反证，不以先后或并列自动证明因果。narrated_causal_link 是正文明确因果叙述；character_explanation 仅证明人物如此解释；interpretive_inference 是读者推断；uncertain 保留未定。status、reason、范围与限制仍只以原 fact 为权威，不另外复制或改写。
transfer/completion 路由分别绑定具有 transfer_direction/intent_completion 维度的原 fact。相同 span 的多类核查复用同一 fact，不重复创建；多个 unit 可以引用同一 fact。订单、报价、计划不是付款发生的证据；要在全文核对实际动作与上下文，不能只核原引文。准确 anchor 不自动证明解释正确。
所有 units 必填；unknown/未完成保留 unresolved，不补造事实、不变更原偏好或原文学轴，不输出总质量通过。note 一句短话，仅说明覆盖限制；causalLinks 不重复 reason/status。该块之外的序列化只服从本次单一 responseSchema，不继承其它版本字段说明。`;

function segmentSource(source, claimId) {
  const text = source.text, units = [], sentenceEnds = [];
  for (const m of text.matchAll(/[。！？!?；;\n]+/gu)) sentenceEnds.push(m.index + m[0].length);
  if (sentenceEnds.at(-1) !== text.length) sentenceEnds.push(text.length);
  const boundaries = [0];
  for (const m of text.matchAll(/[，,。！？!?；;\n]+/gu)) boundaries.push(m.index + m[0].length);
  if (boundaries.at(-1) !== text.length) boundaries.push(text.length);
  const cues = CUE_RULES.flatMap(([kind, ruleId, pattern]) => [...text.matchAll(new RegExp(pattern))]
    .map(m => ({ kind, ruleId, start: m.index, end: m.index + m[0].length })));
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i], end = boundaries[i + 1];
    if (start === end) continue;
    const sentenceStart = [...sentenceEnds].reverse().find(n => n <= start) ?? 0;
    const sentenceEnd = sentenceEnds.find(n => n >= end);
    units.push({ unitId: `${claimId}.U${units.length + 1}`, claimId, JSONPointer: source.JSONPointer,
      start, end, sentenceStart, sentenceEnd, textSHA256: sha(text.slice(start, end)),
      reviewCues: cues.filter(c => c.start >= start && c.start < end) });
  }
  assert(units.map(u => text.slice(u.start, u.end)).join('') === text, 'PREMISE_COVERAGE_SEGMENT_LOSS');
  return units;
}

export function prepareAuditEventPremiseCoverage({ requestHash, targets, manuscripts } = {}) {
  assert(typeof requestHash === 'string' && /^[a-f0-9]{64}$/.test(requestHash), 'PREMISE_COVERAGE_REQUEST_HASH');
  assert(Array.isArray(targets) && targets.length > 0 && Array.isArray(manuscripts) && manuscripts.length > 0, 'PREMISE_COVERAGE_INPUT');
  const anchors = [], blindIds = new Set(), anchorIds = new Set(), targetIds = new Set();
  for (const m of manuscripts) {
    assert(nonempty(m.blindId) && !blindIds.has(m.blindId) && Array.isArray(m.chapters), 'PREMISE_COVERAGE_MANUSCRIPT');
    blindIds.add(m.blindId);
    for (const ch of m.chapters) {
      assert(nonempty(ch.id) && Array.isArray(ch.paragraphs), 'PREMISE_COVERAGE_CHAPTER');
      for (const p of ch.paragraphs) {
        assert(nonempty(p.anchorId) && !anchorIds.has(p.anchorId) && typeof p.text === 'string'
          && typeof p.citable === 'boolean', 'PREMISE_COVERAGE_CATALOG');
        anchorIds.add(p.anchorId);
        anchors.push({ anchorId: p.anchorId, blindId: m.blindId, chapterId: ch.id,
          citable: p.citable, textSHA256: sha(p.text) });
      }
    }
  }
  const catalog = targets.map(t => {
    assert(nonempty(t.targetId) && !targetIds.has(t.targetId) && nonempty(t.targetSHA), 'PREMISE_COVERAGE_TARGET');
    targetIds.add(t.targetId);
    assert(Array.isArray(t.allowedBlindIds) && t.allowedBlindIds.length > 0
      && t.allowedBlindIds.every(id => blindIds.has(id)), 'PREMISE_COVERAGE_ALLOWED_MANUSCRIPTS');
    assert(Array.isArray(t.claimSources) && t.claimSources.length > 0, 'PREMISE_COVERAGE_CLAIMS');
    const pointers = new Set();
    const claims = t.claimSources.map((s, i) => {
      assert(nonempty(s.JSONPointer) && !pointers.has(s.JSONPointer) && nonempty(s.text)
        && sha(s.text) === s.sha256, 'PREMISE_COVERAGE_CLAIM_BINDING');
      pointers.add(s.JSONPointer);
      const claimId = `${t.targetId}.C${i + 1}`;
      return { claimId, JSONPointer: s.JSONPointer, sourceTextSHA256: s.sha256, lengthUTF16: s.text.length,
        units: segmentSource(s, claimId) };
    });
    return { targetId: t.targetId, targetSHA: t.targetSHA, targetRecordHash: digest(t),
      allowedBlindIds: clone(t.allowedBlindIds), claims };
  });
  const versions = { policyVersion: EVENT_PREMISE_COVERAGE_VERSION, toolVersion: sha(readFileSync(new URL(import.meta.url))) };
  const base = { schemaVersion: `${EVENT_PREMISE_COVERAGE_VERSION}-packet`, versions, requestHash,
    manuscriptCatalogHash: digest(manuscripts), targets: catalog };
  const bindingHash = digest({ packet: base, instruction: EVENT_PREMISE_COVERAGE_INSTRUCTION });
  return freeze({ schemaVersion: `${EVENT_PREMISE_COVERAGE_VERSION}-prepared`, versions, bindingHash,
    input: clone({ requestHash, targets, manuscripts }), anchors, packet: { ...base, bindingHash } });
}

function checked(prepared, target) {
  assert(object(prepared?.input), 'PREMISE_COVERAGE_PREPARED');
  const p = prepareAuditEventPremiseCoverage(prepared.input);
  assert(equal(p, prepared), 'PREMISE_COVERAGE_PREPARED_CHANGED');
  const t = p.packet.targets.find(t => t.targetId === target?.targetId);
  assert(t && digest(target) === t.targetRecordHash, 'PREMISE_COVERAGE_TARGET_CHANGED');
  return { p, t };
}

export function auditEventPremiseCoverageAssessmentContractFields({ prepared, target } = {}) {
  const { p, t } = checked(prepared, target), units = {};
  for (const u of t.claims.flatMap(c => c.units)) {
    units[u.unitId] = obj(Object.fromEntries([...KINDS.map(kind => [kind, { anyOf: [
      { type: 'string', enum: u.reviewCues.some(c => c.kind === kind) ? ['unresolved'] : ['not_applicable', 'unresolved'] },
      { ...idsSchema, minItems: 1 },
    ] }]), ['note', nullableText]]));
  }
  // Do not repeat the full manuscript anchor enum three times per target. The
  // decoder enforces actual catalog/target/fact ownership for every reference.
  const anchor = textSchema;
  return { premiseCoverage: obj({ bindingHash: { type: 'string', const: p.bindingHash }, units: obj(units),
    causalLinks: { type: 'array', items: obj({ factId: textSchema, causeAnchorId: anchor, effectAnchorId: anchor,
      relationAnchorIds: { type: 'array', items: anchor },
      basis: { type: 'string', enum: ['narrated_causal_link', 'character_explanation', 'interpretive_inference', 'uncertain'] },
    }) },
  }) };
}

export function checkAuditEventPremiseCoverageAssessment({ prepared, target, assessment, eventGrounding, coverage } = {}) {
  const { p, t } = checked(prepared, target), issues = [], mappings = [];
  const root = '/premiseCoverage';
  const issue = (code, JSONPointer, detail = null) => issues.push({ code: `PREMISE_COVERAGE_${code}`, JSONPointer, detail, severity: 'error' });
  const finish = () => freeze({ schemaVersion: `${EVENT_PREMISE_COVERAGE_VERSION}-gate`,
    status: issues.length ? 'needs_review' : 'structurally_consistent', needsReview: issues.length > 0, issues,
    proof: { versions: p.versions, bindingHash: p.bindingHash, requestHash: p.input.requestHash,
      targetId: t.targetId, targetSHA: t.targetSHA, assessmentSHA256: digest(assessment ?? null),
      eventGroundingSHA256: digest(eventGrounding ?? null), coverageSHA256: digest(coverage ?? null), mappings,
      originalAssessmentUnchanged: true, externalCanonicalAndEventGatesRequired: true },
    automaticAdoption: false, semanticAccuracy: 'NOT_VERIFIED' });
  if (!exactKeys(coverage, ['bindingHash', 'units', 'causalLinks'])) { issue('FIELDS', root); return finish(); }
  if (coverage.bindingHash !== p.bindingHash) issue('BINDING', `${root}/bindingHash`);
  if (!object(assessment) || assessment.targetId !== t.targetId || assessment.targetSHA !== t.targetSHA) {
    issue('ASSESSMENT_BINDING', root); return finish();
  }
  const units = t.claims.flatMap(c => c.units), unitIds = units.map(u => u.unitId);
  if (!exactKeys(coverage.units, unitIds)) issue('UNIT_COVERAGE', `${root}/units`, {
    missing: unitIds.filter(id => !Object.hasOwn(coverage.units ?? {}, id)),
    extra: object(coverage.units) ? Object.keys(coverage.units).filter(id => !unitIds.includes(id)) : [],
  });
  if (!Array.isArray(assessment.factChecks)) { issue('FACTS_REQUIRED', root); return finish(); }
  const facts = new Map(), sourceByPointer = new Map(target.claimSources.map(s => [s.JSONPointer, s]));
  const anchors = new Map(p.anchors.map(a => [a.anchorId, a]));
  for (const f of assessment.factChecks) {
    if (!object(f) || !nonempty(f.factId) || facts.has(f.factId)) { issue('FACT_ID', '/factChecks'); continue; }
    const source = sourceByPointer.get(f.claim?.JSONPointer), start = f.claim?.start, quote = f.claim?.quote;
    if (!source || !Number.isSafeInteger(start) || start < 0 || !nonempty(quote) || source.text.slice(start, start + quote.length) !== quote) {
      issue('FACT_SOURCE_SPAN', `/factChecks/${f.factId}/claim`); continue;
    }
    if (!['supported', 'contradicted', 'uncertain'].includes(f.status) || !Array.isArray(f.dimensions)) {
      issue('FACT_CONTRACT', `/factChecks/${f.factId}`); continue;
    }
    facts.set(f.factId, { fact: f, start, end: start + quote.length });
  }
  const temporalFacts = new Map();
  if (eventGrounding !== undefined && !Array.isArray(eventGrounding?.facts)) issue('EVENT_FACTS', '/eventGrounding/facts');
  for (const e of Array.isArray(eventGrounding?.facts) ? eventGrounding.facts : []) {
    if (!object(e) || !nonempty(e.factId)) { issue('EVENT_FACT_ID', '/eventGrounding/facts'); continue; }
    if (temporalFacts.has(e.factId)) issue('EVENT_FACT_DUPLICATE', '/eventGrounding/facts');
    temporalFacts.set(e.factId, e);
  }
  const causalFactIds = new Set();
  const referenceAllowed = (id, f, pointer) => {
    const a = anchors.get(id), refs = [...(f.evidence ?? []), ...(f.counterEvidence ?? [])];
    if (!a?.citable || !t.allowedBlindIds.includes(a.blindId) || !refs.some(r => r.anchorId === id)) {
      issue('FACT_EVIDENCE_BINDING', pointer, id); return null;
    }
    return a;
  };
  for (const u of units) {
    const row = coverage.units?.[u.unitId], pointer = `${root}/units/${u.unitId}`;
    if (!exactKeys(row, [...KINDS, 'note'])) { issue('UNIT_FIELDS', pointer); continue; }
    if (row.note !== null && !nonempty(row.note)) issue('NOTE', `${pointer}/note`);
    const source = sourceByPointer.get(u.JSONPointer), unitText = source.text.slice(u.start, u.end);
    const core = unitText.replace(/[\s，,。！？!?；;]+$/gu, '');
    const coreStart = u.start + (core.length - core.trimStart().length), coreEnd = u.start + core.length;
    for (const kind of KINDS) {
      const route = row[kind], at = `${pointer}/${kind}`, cues = u.reviewCues.filter(c => c.kind === kind);
      if (route === 'unresolved') {
        issue('UNRESOLVED', at); if (!nonempty(row.note)) issue('UNRESOLVED_NOTE', `${pointer}/note`); continue;
      }
      if (route === 'not_applicable') {
        if (cues.length) issue('EXPLICIT_PREMISE_UNCHECKED', at, cues);
        continue;
      }
      if (!Array.isArray(route) || !route.length || route.some(id => !nonempty(id)) || new Set(route).size !== route.length) {
        issue('ROUTE', at); continue;
      }
      const linked = [];
      for (const id of route) {
        const linkedFact = facts.get(id);
        if (!linkedFact || linkedFact.fact.claim.JSONPointer !== u.JSONPointer
          || linkedFact.start >= u.end || linkedFact.end <= u.start) { issue('FACT_OWNERSHIP', at, id); continue; }
        linked.push(linkedFact);
        const f = linkedFact.fact, dimension = { temporal: 'event_round', transfer: 'transfer_direction', completion: 'intent_completion' }[kind];
        if (dimension && !f.dimensions.includes(dimension)) issue('DIMENSION_REQUIRED', at, { factId: id, dimension });
        if (kind === 'causal' && !f.dimensions.some(d => ['event_round', 'other_explicit_fact'].includes(d))) issue('DIMENSION_REQUIRED', at, { factId: id, dimension: 'event_round|other_explicit_fact' });
        if (kind === 'temporal') {
          const e = temporalFacts.get(id);
          if (!e || e.temporalKind === 'none' || !object(e.temporal)) { issue('TEMPORAL_CHECK_REQUIRED', at, id); }
          else {
            const left = referenceAllowed(e.temporal.left?.anchorId, f, `${at}/left`);
            const right = referenceAllowed(e.temporal.right?.anchorId, f, `${at}/right`);
            if (left && right && left.blindId !== right.blindId) issue('EVENT_MANUSCRIPT', at);
          }
        }
        if (kind === 'causal') causalFactIds.add(id);
        mappings.push({ unitId: u.unitId, kind, factId: id, JSONPointer: u.JSONPointer, start: linkedFact.start, end: linkedFact.end });
      }
      if (['temporal', 'causal'].includes(kind) && !linked.some(f => f.start <= coreStart && f.end >= coreEnd)) {
        issue('RELATION_SCOPE_TRIMMED', at, { start: coreStart, end: coreEnd });
      }
      for (const cue of cues) if (!linked.some(f => f.start <= cue.start && f.end >= cue.end)) issue('CUE_OMITTED', at, cue);
    }
  }
  if (!Array.isArray(coverage.causalLinks)) { issue('CAUSAL_LINKS', `${root}/causalLinks`); return finish(); }
  const causalSeen = new Set();
  for (const [i, link] of coverage.causalLinks.entries()) {
    const at = `${root}/causalLinks/${i}`;
    if (!exactKeys(link, ['factId', 'causeAnchorId', 'effectAnchorId', 'relationAnchorIds', 'basis'])) { issue('CAUSAL_FIELDS', at); continue; }
    const f = facts.get(link.factId)?.fact;
    if (!f || !causalFactIds.has(link.factId) || causalSeen.has(link.factId)) { issue('CAUSAL_FACT_BINDING', at); continue; }
    causalSeen.add(link.factId);
    const cause = referenceAllowed(link.causeAnchorId, f, `${at}/causeAnchorId`);
    const effect = referenceAllowed(link.effectAnchorId, f, `${at}/effectAnchorId`);
    if (cause && effect && cause.blindId !== effect.blindId) issue('EVENT_MANUSCRIPT', at);
    if (!Array.isArray(link.relationAnchorIds) || new Set(link.relationAnchorIds).size !== link.relationAnchorIds.length) issue('CAUSAL_RELATION_REFS', at);
    else {
      for (const id of link.relationAnchorIds) {
        const a = referenceAllowed(id, f, `${at}/relationAnchorIds`);
        if (a && cause && a.blindId !== cause.blindId) issue('EVENT_MANUSCRIPT', at);
      }
      if (f.status !== 'uncertain' && !link.relationAnchorIds.length) issue('CAUSAL_RELATION_REQUIRED', at);
    }
    if (!['narrated_causal_link', 'character_explanation', 'interpretive_inference', 'uncertain'].includes(link.basis)) issue('CAUSAL_BASIS', at);
    if (f.status !== 'uncertain' && (['interpretive_inference', 'uncertain'].includes(link.basis)
      || (link.basis === 'character_explanation' && f.basis !== 'character_statement'))) issue('CAUSAL_INFERENCE_NOT_FACT', at);
  }
  for (const id of causalFactIds) if (!causalSeen.has(id)) issue('CAUSAL_CHECK_REQUIRED', `${root}/causalLinks`, id);
  return finish();
}
