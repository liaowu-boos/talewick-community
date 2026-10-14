import { createHash } from 'node:crypto';
import {validateMaterialNarrativeObservations} from './narrative-observations.mjs';

export const FOLLOWUP_LIMITS = Object.freeze({ maxChargedChars: 30000, maxCandidates: 20, maxUnits: 6, maxChars: 12000, maxRangeChars: 2400, maxSourceChars: 4800, maxSourceMaterials: 3 });
const hash = value => createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const error = (code, message) => Object.assign(new Error(message), { code });
const ensure = (condition, code, message) => { if (!condition) throw error(code, message); };
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const frozenIdentity = item => JSON.stringify(canonical(item));
const sum = materials => materials.reduce((n, item) => n + item.content.length, 0);
const sourceKey = ref => JSON.stringify([ref.sourceSha256, ref.textVersion]);
const refKey = ref => JSON.stringify([ref.sourceSha256, ref.textVersion, ref.analysisVersion, ref.reviewRecordId ?? null, ref.lineStart, ref.lineEnd, [...ref.unitIds].sort()]);
const refsKey = item => JSON.stringify((item.references ?? []).map(refKey).sort());
const identity = item => JSON.stringify([item.kind, item.use ?? null, item.content, item.sha256, (item.references ?? []).map(ref => JSON.stringify([ref.sourceId, refKey(ref)])).sort()]);
const overlap = (a, b) => a.lineStart <= b.lineEnd && b.lineStart <= a.lineEnd;
const contains = (a, b) => a.lineStart <= b.lineStart && a.lineEnd >= b.lineEnd;
const sameRange = (a, b) => a.lineStart === b.lineStart && a.lineEnd === b.lineEnd;
const sameSource = (a, b) => sourceKey(a) === sourceKey(b);
const raw = item => item.kind === 'retrieved' && item.use === 'raw_reference';
const reviewed = item => item.use === 'reviewed_analysis';
const automatic = item => item.kind === 'retrieved';
const rawPrefix = '【原文参考；不作为已发布分析】\n';
const rawBody = item => item.content.startsWith(rawPrefix) ? item.content.slice(rawPrefix.length) : item.content;

function validateMaterial(item, code) {
  ensure(item && text(item.id) && text(item.kind) && text(item.content) && sha(item.sha256) && hash(item.content) === item.sha256, code, '材料身份、正文或SHA无效。');
  if (automatic(item)) ensure(['raw_reference', 'reviewed_analysis'].includes(item.use) && Array.isArray(item.references) && item.references.length > 0, code, '自动材料缺用途或引用。');
  ensure(item.references === undefined || Array.isArray(item.references), code, '引用须为数组。');
  const seen = new Set(), units = new Set();
  for (const ref of item.references ?? []) {
    ensure(ref && text(ref.sourceId) && sha(ref.sourceSha256) && text(ref.textVersion) && text(ref.analysisVersion)
      && Number.isSafeInteger(ref.lineStart) && ref.lineStart >= 1 && Number.isSafeInteger(ref.lineEnd) && ref.lineEnd >= ref.lineStart
      && Array.isArray(ref.unitIds) && ref.unitIds.every(text) && new Set(ref.unitIds).size === ref.unitIds.length
      && (ref.reviewRecordId === undefined || text(ref.reviewRecordId)), code, '引用身份、单元或行号无效。');
    ensure(!reviewed(item) || (text(ref.reviewRecordId) && ref.unitIds.length > 0), code, '已复核材料缺少复核身份或单元。');
    ensure(!seen.has(refKey(ref)), code, '同一材料存在重复引用。'); seen.add(refKey(ref));
    if (reviewed(item)) for (const unit of ref.unitIds) {
      const key = JSON.stringify([sourceKey(ref), ref.analysisVersion, unit]);
      ensure(!units.has(key), code, '同一材料重复列出已复核单元。'); units.add(key);
    }
  }
  try { validateMaterialNarrativeObservations(item); }
  catch { throw error(code, '材料附加的叙事观察绑定无效。'); }
}
function validateResult(result) {
  const code = 'INVALID_RESULT';
  ensure(result && result.contractVersion === 'v04-contract-1' && text(result.packetId) && result.query
    && ['matched', 'uncovered', 'unavailable'].includes(result.status) && Array.isArray(result.materials) && Array.isArray(result.candidates), code, '补查响应形状无效；须先严格验证实际查询。');
  const budget = {};
  for (const key of ['maxCandidates', 'maxUnits', 'maxChars']) {
    const value = result.query.budget?.[key] ?? FOLLOWUP_LIMITS[key];
    ensure(Number.isSafeInteger(value) && value >= 0, code, '单次预算无效。'); budget[key] = Math.min(value, FOLLOWUP_LIMITS[key]);
  }
  ensure(result.candidates.length <= budget.maxCandidates && result.materials.length <= budget.maxUnits, code, '超出单次候选或材料预算。');
  ensure(result.status === 'matched' ? result.materials.length > 0 : result.materials.length === 0, code, '检索状态与材料矛盾。');
  ensure(result.query.evidenceType !== 'performance' || result.materials.length === 0, code, '表现查询不能供应叙事材料。');
  const ids = new Set(), units = new Set(), ranges = new Set(), sources = new Map();
  for (const item of result.materials) {
    validateMaterial(item, code); ensure(automatic(item) && !ids.has(item.id), code, '新包存在非自动材料或重复ID。'); ids.add(item.id);
    if (raw(item) && item.references.length === 1) ensure(rawBody(item).length <= FOLLOWUP_LIMITS.maxRangeChars, code, '完整原文单窗超过2400字符；不能裁切。');
    // Source caps apply to this result, including full overlapping bodies and aliases, not to the ledger.
    for (const key of new Set(item.references.map(sourceKey))) {
      const usage = sources.get(key) ?? { count: 0, chars: 0 };
      usage.count++; usage.chars += item.content.length; sources.set(key, usage);
      ensure(usage.count <= FOLLOWUP_LIMITS.maxSourceMaterials && usage.chars <= FOLLOWUP_LIMITS.maxSourceChars, code, '单次同源材料数量或字符预算超限。');
    }
    for (const ref of item.references) {
      if (raw(item)) {
        const key = JSON.stringify([sourceKey(ref), 'raw', ref.lineStart, ref.lineEnd]);
        ensure(!ranges.has(key), code, '新包存在重复原文范围。'); ranges.add(key); units.add(key);
      } else for (const unit of ref.unitIds) units.add(JSON.stringify([sourceKey(ref), ref.analysisVersion, 'reviewed', unit]));
    }
  }
  ensure(units.size <= budget.maxUnits && result.usedChars === sum(result.materials) && result.usedChars <= budget.maxChars, code, '单次引用单元或字符计量超限。');
}
function bindingConflict(item, ledger) {
  const own = item.references ?? [];
  for (const prior of [...ledger, item]) for (const a of own) for (const b of prior.references ?? []) {
    if (a.sourceId !== b.sourceId && a.sourceSha256 !== b.sourceSha256) continue;
    const code = a.sourceSha256 !== b.sourceSha256 ? 'SOURCE_HASH_CONFLICT'
      : a.textVersion !== b.textVersion ? 'TEXT_VERSION_CONFLICT'
      : a.analysisVersion !== b.analysisVersion ? 'ANALYSIS_VERSION_CONFLICT'
      : a.reviewRecordId !== undefined && b.reviewRecordId !== undefined && a.reviewRecordId !== b.reviewRecordId ? 'REVIEW_VERSION_CONFLICT' : null;
    if (code) return { code, reason: '同源历史身份与新材料不一致。', conflicts: [prior.id] };
  }
  return null;
}
// This parses only a whole, single raw window for consistency checks; returned materials are never rewritten.
function rawLines(item) {
  if (!raw(item) || item.references.length !== 1) return null;
  const lines = rawBody(item).split('\n'), ref = item.references[0];
  return lines.length === ref.lineEnd - ref.lineStart + 1 ? lines : null;
}
function sameOverlapText(item, prior, a, b) {
  const left = rawLines(item), right = rawLines(prior);
  if (!left || !right) return null;
  for (let line = Math.max(a.lineStart, b.lineStart); line <= Math.min(a.lineEnd, b.lineEnd); line++) {
    if (left[line - a.lineStart] !== right[line - b.lineStart]) return false;
  }
  return true;
}
// Informational missing ranges are separate from material references and never alter their body or evidence.
function coverageGaps(item, active) {
  const gaps = [];
  for (const ref of item.references ?? []) {
    const spans = active.flatMap(m => (m.references ?? []).filter(r => sameSource(ref, r) && r.analysisVersion === ref.analysisVersion && overlap(ref, r)))
      .sort((a, b) => a.lineStart - b.lineStart);
    let next = ref.lineStart;
    const add = (start, end) => gaps.push({ sourceId: ref.sourceId, sourceSha256: ref.sourceSha256, textVersion: ref.textVersion, analysisVersion: ref.analysisVersion, lineStart: start, lineEnd: end });
    for (const span of spans) { if (span.lineStart > next) add(next, Math.min(ref.lineEnd, span.lineStart - 1)); next = Math.max(next, span.lineEnd + 1); if (next > ref.lineEnd) break; }
    if (next <= ref.lineEnd) add(next, ref.lineEnd);
  }
  return gaps;
}
function materialDecision(item, ledger, active) {
  const existing = ledger.find(m => m.id === item.id);
  if (existing) return { code: identity(item) === identity(existing) ? 'DUPLICATE_ID' : 'ID_CONFLICT', reason: '材料ID已存在，不能替换其正文或身份。', conflicts: [existing.id] };
  const binding = bindingConflict(item, ledger); if (binding) return binding;
  const supersedes = new Set();
  for (const prior of ledger) {
    if (reviewed(item) && reviewed(prior)) {
      const repeated = item.references.some(a => (prior.references ?? []).some(b => sameSource(a, b) && a.unitIds.some(id => b.unitIds.includes(id))));
      if (repeated) return { code: refsKey(item) === refsKey(prior) && item.content !== prior.content ? 'VERSION_CONTENT_CONFLICT' : 'DUPLICATE_REVIEWED_UNIT', reason: '同版本已复核单元重复或内容冲突；整份材料拒绝。', conflicts: [prior.id] };
    }
    if (!raw(item)) continue;
    for (const a of item.references) for (const b of prior.references ?? []) {
      if (!sameSource(a, b) || !overlap(a, b)) continue;
      if (!automatic(prior) && active.some(m => m.id === prior.id)) return { code: 'PROTECTED_MATERIAL', reason: '自动窗口不能覆盖手选或内置材料。', conflicts: [prior.id] };
      if (!raw(prior)) continue;
      if (item.references.length !== 1 || prior.references.length !== 1) return { code: 'MIXED_REFERENCE_OVERLAP', reason: '混合引用存在部分重复或重叠，不能删引用或裁正文后接收。', conflicts: [prior.id] };
      const consistent = sameOverlapText(item, prior, a, b);
      if (consistent === false) return { code: 'VERSION_CONTENT_CONFLICT', reason: '同版本重叠行的原文内容不一致。', conflicts: [prior.id] };
      if (sameRange(a, b)) {
        if (consistent === null && item.content !== prior.content) return { code: 'VERSION_CONTENT_CONFLICT', reason: '同版同范围内容不同，不能核实一致性。', conflicts: [prior.id] };
        return { code: 'DUPLICATE_RAW_RANGE', reason: '同源同版原文范围已保留，不重复接收。', conflicts: [prior.id] };
      }
      if (consistent !== true) return { code: 'RAW_CONTENT_UNVERIFIABLE', reason: '整窗行数无法与定位对应，不能核实重叠原文。', conflicts: [prior.id] };
      // Consistent partial windows coexist unchanged; only fully contained active windows can be replaced.
      if (contains(a, b) && active.some(m => m.id === prior.id)) supersedes.add(prior.id);
    }
  }
  if (raw(item) && item.references.length === 1 && coverageGaps(item, ledger.filter(raw)).length === 0) {
    return { code: 'DUPLICATE_RAW_RANGE', reason: '同源同版原文范围已由历史完整窗口覆盖，不重复接收。',
      conflicts: ledger.filter(prior => raw(prior) && prior.references.some(b => sameSource(item.references[0], b) && overlap(item.references[0], b))).map(prior => prior.id) };
  }
  return { supersedes: [...supersedes] };
}

/** Merge an already strictly validated retrieval result; retained is the complete append-only accepted ledger. */
export function mergeFollowupMaterials({ active, retained = [], result } = {}) {
  ensure(Array.isArray(active) && Array.isArray(retained), 'INVALID_HISTORY', 'active和retained须为材料数组。');
  validateResult(result);
  let nextActive = structuredClone(active);
  const ledger = [], activeIds = new Set(), retainedIds = new Set();
  for (const item of retained) { validateMaterial(item, 'INVALID_HISTORY'); ensure(!retainedIds.has(item.id), 'INVALID_HISTORY', 'retained账本存在重复ID，不能静默改写历史。'); retainedIds.add(item.id); }
  for (const item of active) { validateMaterial(item, 'INVALID_HISTORY'); ensure(!activeIds.has(item.id), 'INVALID_HISTORY', 'active存在重复ID。'); activeIds.add(item.id); }
  for (const item of [...retained, ...active]) {
    validateMaterial(item, 'INVALID_HISTORY'); const prior = ledger.find(m => m.id === item.id);
    if (prior) { ensure(frozenIdentity(prior) === frozenIdentity(item), 'INVALID_HISTORY', '历史相同ID的冻结材料不一致。'); continue; }
    ensure(!bindingConflict(item, ledger), 'INVALID_HISTORY', '历史包含相互冲突的源版本绑定。');
    for (const previous of ledger) {
      if (raw(item) && raw(previous) && item.references.length === 1 && previous.references.length === 1) {
        const a = item.references[0], b = previous.references[0];
        if (sameSource(a, b) && overlap(a, b)) ensure(sameOverlapText(item, previous, a, b) !== false && (!sameRange(a, b) || sameOverlapText(item, previous, a, b) === true || item.content === previous.content), 'INVALID_HISTORY', '历史同版原文包含矛盾内容。');
      }
      if (reviewed(item) && reviewed(previous) && refsKey(item) === refsKey(previous)) ensure(item.content === previous.content, 'INVALID_HISTORY', '历史同版同引用分析正文冲突。');
    }
    ledger.push(structuredClone(item));
  }
  let chargedChars = sum(ledger);
  ensure(chargedChars <= FOLLOWUP_LIMITS.maxChargedChars, 'INVALID_HISTORY', '既有累计材料已超过30000字符。');
  const accepted = [], dropped = [], superseded = [];
  for (const item of result.materials) {
    const decision = materialDecision(item, ledger, nextActive);
    if (decision.code || chargedChars + item.content.length > FOLLOWUP_LIMITS.maxChargedChars) {
      dropped.push({ id: item.id, code: decision.code ?? 'CUMULATIVE_BUDGET', reason: decision.reason ?? '整份新材料超过累计30000字符预算；替换不退还历史费用。', conflicts: decision.conflicts ?? [], coverageGaps: coverageGaps(item, nextActive) });
      continue;
    }
    const replaced = decision.supersedes;
    nextActive = nextActive.filter(m => !replaced.includes(m.id)); nextActive.push(structuredClone(item));
    ledger.push(structuredClone(item)); chargedChars += item.content.length;
    accepted.push({ id: item.id, sha256: item.sha256, chargedChars: item.content.length, supersedes: [...replaced] });
    superseded.push(...replaced.map(id => ({ id, byId: item.id })));
  }
  return { active: nextActive, retained: ledger, chargedChars, usedChars: sum(nextActive), accepted, dropped, superseded, packetId: result.packetId, resultStatus: result.status };
}
