import {createHash} from 'node:crypto';
import {DEEP_REFERENCE_EVIDENCE_NOTES} from './deep-reference-evidence-notes.mjs';

export const DEEP_REFERENCE_COMPARISON_VERSION = 'analysis99-function-comparison-1';
export const DEEP_REFERENCE_COMPARABLE_SUPPLY_VERSION = 'analysis99-comparable-supply-1';
const FIELDS = ['actor', 'emotionalDirection', 'acknowledgmentObject', 'costBearer'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sha = value => createHash('sha256').update(value).digest('hex');
const hash = value => sha(JSON.stringify(canonical(value)));
const text = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const SHA = /^[a-f0-9]{64}$/u;
const requireThat = (condition, code, message) => {
  if (!condition) throw Object.assign(new Error(message), {code});
};
const key = (sourceId, functionId) => JSON.stringify([sourceId, functionId]);
const unique = values => [...new Set(values)];
const strings = (value, max = 16) => Array.isArray(value) && value.length <= max
  && value.every(item => text(item));
const BOUNDARY = '比较说明是有引文约束的解释，不是语义适用性认证；unknown、预算未供应和不适用必须分列，召回/供应不等于采用或文学改善。';

export function deepReferenceFunctionFingerprint(fn) {
  requireThat(object(fn) && text(fn.functionId), 'DEEP_COMPARE_FUNCTION', 'Function identity is required');
  const {matchedProblemTerms, ...stable} = fn;
  return hash(stable);
}

function validateResponse(response) {
  requireThat(object(response) && response.schemaVersion === 'analysis99-problem-query-2'
    && text(response.queryId) && Array.isArray(response.results) && response.results.length <= 8
    && response.resultCount === response.results.length
    && response.status === (response.results.length ? 'covered' : 'uncovered'),
  'DEEP_COMPARE_RESPONSE', 'A complete DATA query response is required; unavailable is not no hits');
  const materials = new Set(), sources = new Set();
  for (const result of response.results) {
    requireThat(text(result.referenceId) && !materials.has(result.referenceId)
      && object(result.source) && text(result.source.sourceId) && !sources.has(result.source.sourceId)
      && SHA.test(result.source.sourceTextSha256) && SHA.test(result.source.sourceSha256)
      && text(result.source.textVersion) && object(result.analysis)
      && SHA.test(result.analysis.candidateSha256) && SHA.test(result.analysis.packetSha256)
      && result.analysis.candidateStatus === 'candidate_unreviewed'
      && ['approved', 'checked', 'active'].every(field => result.analysis[field] === false)
      && object(result.semanticReview) && SHA.test(result.semanticReview.reportSha256)
      && result.semanticReview.approvalGranted === false
      && Array.isArray(result.exactReferences) && result.exactReferences.length <= 24
      && Array.isArray(result.borrowableWritingFunctions)
      && result.borrowableWritingFunctions.length > 0 && result.borrowableWritingFunctions.length <= 6,
    'DEEP_COMPARE_BINDING', 'Invalid or promoted source/function binding');
    materials.add(result.referenceId); sources.add(result.source.sourceId);
    const references = new Map();
    for (const ref of result.exactReferences) {
      requireThat(text(ref.evidenceId) && !references.has(ref.evidenceId) && text(ref.unitId)
        && text(ref.quote, 12000) && sha(ref.quote) === ref.quoteSha256
        && ref.sourceId === result.source.sourceId
        && ref.sourceTextSha256 === result.source.sourceTextSha256
        && ref.sourceSha256 === result.source.sourceSha256 && ref.textVersion === result.source.textVersion
        && object(ref.locator) && Number.isSafeInteger(ref.locator.charStart) && ref.locator.charStart >= 0
        && ref.locator.charEnd - ref.locator.charStart === ref.quote.length
        && Number.isSafeInteger(ref.locator.lineStart) && ref.locator.lineStart >= 1
        && ref.locator.lineEnd - ref.locator.lineStart + 1 === ref.quote.split('\n').length,
      'DEEP_COMPARE_EVIDENCE', 'Reference quote, hash, source or locator is invalid');
      references.set(ref.evidenceId, ref);
    }
    const functions = new Set();
    for (const fn of result.borrowableWritingFunctions) {
      requireThat(text(fn.functionId) && !functions.has(fn.functionId)
        && fn.status === 'evidence_bound_hypothesis' && text(fn.observablePattern)
        && text(fn.borrowableFunction) && text(fn.limitation) && strings(fn.alternatives)
        && Array.isArray(fn.evidenceIds) && fn.evidenceIds.length > 0
        && unique(fn.evidenceIds).length === fn.evidenceIds.length
        && fn.evidenceIds.every(id => references.has(id)),
      'DEEP_COMPARE_FUNCTION', 'Each complete function must retain all its evidence and limitations');
      functions.add(fn.functionId);
    }
    requireThat(object(result.limits) && strings(result.limits.statements)
      && strings(result.semanticReview.caveats) && Array.isArray(result.semanticReview.blockingDefects)
      && result.semanticReview.blockingDefects.length === 0,
    'DEEP_COMPARE_LIMITS', 'Missing limitations or a rejected source');
  }
}

function boundField(field, fn, references) {
  if (field === undefined) return {status: 'unknown', value: null, anchors: [], reason: '没有绑定说明；不能从词面补足。'};
  requireThat(object(field) && text(field.value, 1000) && Array.isArray(field.anchors)
    && field.anchors.length > 0 && field.anchors.length <= 8
    && Object.keys(field).every(name => ['value', 'anchors'].includes(name)),
  'DEEP_COMPARE_NOTE_FIELD', 'A filled comparison field needs literal evidence anchors');
  const anchors = field.anchors.map(anchor => {
    const ref = references.get(anchor.evidenceId);
    requireThat(ref && fn.evidenceIds.includes(anchor.evidenceId) && text(anchor.quote, 2000)
      && Object.keys(anchor).every(name => ['evidenceId', 'quote', 'offsetUtf16'].includes(name)),
      'DEEP_COMPARE_NOTE_EVIDENCE', 'A note must cite this function, not another actor/function/source packet');
    const start = anchor.offsetUtf16 ?? ref.quote.indexOf(anchor.quote);
    requireThat(Number.isSafeInteger(start) && start >= 0
      && ref.quote.slice(start, start + anchor.quote.length) === anchor.quote
      && (anchor.offsetUtf16 !== undefined || ref.quote.indexOf(anchor.quote, start + 1) === -1),
    'DEEP_COMPARE_NOTE_QUOTE', 'Anchor must be exact and unambiguous, or supply offsetUtf16');
    return {evidenceId: ref.evidenceId, quote: anchor.quote, quoteSha256: sha(anchor.quote),
      evidenceQuoteSha256: ref.quoteSha256, offsetUtf16: start,
      sourceCharStart: ref.locator.charStart + start,
      sourceCharEnd: ref.locator.charStart + start + anchor.quote.length,
      sourceLineStart: ref.locator.lineStart + ref.quote.slice(0, start).split('\n').length - 1,
      sourceLineEnd: ref.locator.lineStart + ref.quote.slice(0, start + anchor.quote.length).split('\n').length - 1};
  });
  return {status: 'evidence_bound_note', value: field.value, anchors,
    boundary: '只核对字面和绑定；解释、行动者归属及目标适配仍须独立判断。'};
}

export function buildDeepReferenceComparison({response, evidenceNotes = DEEP_REFERENCE_EVIDENCE_NOTES} = {}) {
  validateResponse(response);
  requireThat(Array.isArray(evidenceNotes) && evidenceNotes.length <= 1024,
    'DEEP_COMPARE_NOTES', 'Evidence notes must be a bounded array');
  const notes = new Map(), used = new Set();
  for (const note of evidenceNotes) {
    const id = key(note?.sourceId, note?.functionId);
    requireThat(object(note) && text(note.sourceId) && text(note.functionId) && !notes.has(id)
      && object(note.binding) && object(note.fields) && Object.keys(note.fields).every(field => FIELDS.includes(field))
      && Object.keys(note).every(field => ['sourceId','functionId','binding','provenance','fields','limitations'].includes(field))
      && Object.keys(note.binding).every(field => ['sourceTextSha256','candidateSha256','packetSha256','reportSha256','functionSha256'].includes(field))
      && object(note.provenance) && note.provenance.kind === 'local_evidence_note'
      && Object.keys(note.provenance).every(field => ['kind','origin'].includes(field))
      && text(note.provenance.origin, 2000) && strings(note.limitations),
    'DEEP_COMPARE_NOTES', 'Invalid, duplicate or untraceable evidence note');
    notes.set(id, note);
  }
  const cards = [];
  for (const result of response.results) {
    const references = new Map(result.exactReferences.map(ref => [ref.evidenceId, ref]));
    for (const fn of result.borrowableWritingFunctions) {
      const id = key(result.source.sourceId, fn.functionId), note = notes.get(id);
      const binding = {sourceTextSha256: result.source.sourceTextSha256,
        candidateSha256: result.analysis.candidateSha256, packetSha256: result.analysis.packetSha256,
        reportSha256: result.semanticReview.reportSha256, functionSha256: deepReferenceFunctionFingerprint(fn)};
      if (note) {
        requireThat(Object.keys(binding).every(field => SHA.test(note.binding[field]) && note.binding[field] === binding[field]),
          'DEEP_COMPARE_STALE_NOTE', 'Evidence note refers to stale candidate/function/source/review bytes');
        used.add(id);
      }
      const fields = Object.fromEntries(FIELDS.map(field => [field, boundField(note?.fields[field], fn, references)]));
      cards.push({materialId: result.referenceId, source: clone(result.source), analysis: clone(result.analysis),
        functionId: fn.functionId, binding, sourceHypothesis: clone(fn),
        fields, unknownFields: FIELDS.filter(field => fields[field].status === 'unknown'),
        evidenceIds: [...fn.evidenceIds], exactReferences: fn.evidenceIds.map(id => clone(references.get(id))),
        noteProvenance: note ? clone(note.provenance) : null,
        noteSha256: note ? hash(note) : null, noteLimitations: clone(note?.limitations ?? []),
        sourceLimits: clone(result.limits), reviewCaveats: clone(result.semanticReview.caveats),
        applicability: 'not_assessed', boundary: BOUNDARY});
    }
  }
  return {schemaVersion: DEEP_REFERENCE_COMPARISON_VERSION, queryId: response.queryId,
    responseSha256: hash(response), cards, evidenceNotes: clone(evidenceNotes),
    unusedNoteKeys: [...notes.keys()].filter(id => !used.has(id)),
    boundary: `${BOUNDARY} 说明仅核验响应内引文；来源全文完整性仍由原DATA resolver/query核验。`};
}

function renderMaterial(result, functions, cards) {
  const ids = new Set(functions.flatMap(fn => fn.evidenceIds));
  const exactReferences = result.exactReferences.filter(ref => ids.has(ref.evidenceId));
  const selectedCards = functions.map(fn => cards.get(key(result.source.sourceId, fn.functionId)));
  // IDs, note anchors and limitations are part of the supplied content and its cost.
  const projection = {referenceId: result.referenceId, candidateStatus: 'candidate_unreviewed',
    semanticReview: {verdict: result.semanticReview.verdict, reportSha256: result.semanticReview.reportSha256,
      blockingDefects: []}, borrowableWritingFunctions: functions,
    comparison: selectedCards.map(card => ({functionId: card.functionId,
      fields: Object.fromEntries(FIELDS.map(name => { const field = card.fields[name];
        return [name, {status: field.status, value: field.value,
          anchors: field.anchors.map(anchor => ({evidenceId: anchor.evidenceId,
            quote: anchor.quote, offsetUtf16: anchor.offsetUtf16}))}]; })),
      unknownFields: card.unknownFields, noteProvenance: card.noteProvenance, noteSha256: card.noteSha256,
      noteLimitations: card.noteLimitations, applicability: 'not_assessed'})),
    sourceLimits: {visibility: clone(result.limits.visibility),
      statements: unique([...result.limits.statements, ...result.semanticReview.caveats])}, boundary: BOUNDARY};
  const content = JSON.stringify(projection) + '\n\n' + exactReferences.map(ref =>
    `证据 ${ref.evidenceId}（${ref.locator.lineStart}–${ref.locator.lineEnd}）：\n${ref.quote}`).join('\n\n');
  const references = exactReferences.map(ref => ({sourceId: result.source.sourceId,
    sourceSha256: result.source.sourceSha256, textVersion: ref.textVersion,
    analysisVersion: result.analysis.analysisVersion ?? result.analysis.candidateSha256,
    reviewRecordId: result.semanticReview.reportSha256, unitIds: [ref.unitId],
    lineStart: ref.locator.lineStart, lineEnd: ref.locator.lineEnd}));
  return {id: result.referenceId, title: result.source.title ?? result.source.sourceId,
    kind: 'retrieved', use: 'reviewed_analysis', content, sha256: sha(content), references,
    selectionReason: '同一预算内优先比较多个来源的完整功能；未进行适用性判断。',
    limitations: unique([...result.limits.statements, ...result.semanticReview.caveats,
      'candidate_unreviewed；approved=false；checked=false；active=false。', BOUNDARY])};
}

function unitCount(materials) {
  return new Set(materials.flatMap(material => material.references.flatMap(ref => ref.unitIds.map(id =>
    key(ref.sourceId, `${ref.analysisVersion}:${id}`))))).size;
}

export function selectComparableDeepReferenceFunctions({response, comparison, budget} = {}) {
  requireThat(object(budget) && ['maxCandidates','maxUnits','maxChars'].every(field =>
    Number.isSafeInteger(budget[field]) && budget[field] >= 0)
    && budget.maxCandidates <= 20 && budget.maxUnits <= 6 && budget.maxChars <= 12000,
  'DEEP_COMPARE_BUDGET', 'Budget must be explicit, nonnegative and within existing 20/6/12000 limits');
  requireThat(object(comparison) && comparison.schemaVersion === DEEP_REFERENCE_COMPARISON_VERSION,
    'DEEP_COMPARE_COMPARISON', 'Comparison bundle is required');
  const rebuilt = buildDeepReferenceComparison({response, evidenceNotes: comparison.evidenceNotes});
  requireThat(hash(rebuilt) === hash(comparison), 'DEEP_COMPARE_STALE_COMPARISON', 'Comparison changed or is bound to another response');
  const cards = new Map(comparison.cards.map(card => [key(card.source.sourceId, card.functionId), card]));
  const candidates = response.results.slice(0, budget.maxCandidates);
  const material = (index, ids) => renderMaterial(candidates[index],
    candidates[index].borrowableWritingFunctions.filter(fn => ids.includes(fn.functionId)), cards);

  // Bounded DP: at most 8 sources, 6 units, 6 functions/source. Each source first
  // contributes one complete function. No actor/genre/fit score enters selection.
  let states = new Map([['0:0', {units: 0, count: 0, chars: 0, picks: []}]]);
  for (let index = 0; index < candidates.length; index++) {
    const options = candidates[index].borrowableWritingFunctions.map(fn => {
      const value = material(index, [fn.functionId]);
      return {index, functionId: fn.functionId, units: unitCount([value]), chars: value.content.length};
    });
    const next = new Map(states);
    for (const state of states.values()) for (const option of options) {
      const value = {units: state.units + option.units, count: state.count + 1,
        chars: state.chars + option.chars, picks: [...state.picks, [index, option.functionId]]};
      if (value.units > budget.maxUnits || value.chars > budget.maxChars || option.chars > 12000) continue;
      const id = `${value.units}:${value.count}`, existing = next.get(id);
      if (!existing || value.chars < existing.chars) next.set(id, value);
    }
    states = next;
  }
  const best = [...states.values()].sort((a, b) => b.count - a.count || a.units - b.units || a.chars - b.chars)[0];
  const selected = new Map(best.picks.map(([index, id]) => [index, [id]]));
  const materialsNow = picks => [...picks].sort(([a], [b]) => a - b).map(([index, ids]) => material(index, ids));
  const fits = picks => {
    const materials = materialsNow(picks);
    return materials.length <= budget.maxUnits && unitCount(materials) <= budget.maxUnits
      && materials.every(item => item.content.length <= 12000)
      && materials.reduce((sum, item) => sum + item.content.length, 0) <= budget.maxChars;
  };
  // With source breadth fixed, add at most one function per source per pass.
  let added = true;
  while (added) {
    added = false;
    for (let index = 0; index < candidates.length; index++) {
      if (!selected.has(index)) continue;
      for (const fn of candidates[index].borrowableWritingFunctions) {
        if (selected.get(index).includes(fn.functionId)) continue;
        const proposed = new Map(selected); proposed.set(index, [...selected.get(index), fn.functionId]);
        if (fits(proposed)) { selected.set(index, proposed.get(index)); added = true; break; }
      }
    }
  }
  const materials = materialsNow(selected), byId = new Map(materials.map(value => [value.id, value]));
  const selections = response.results.map((result, index) => {
    const ids = selected.get(index) ?? [], supplied = byId.get(result.referenceId);
    return {materialId: result.referenceId,
      selectedFunctionIds: result.borrowableWritingFunctions.filter(fn => ids.includes(fn.functionId)).map(fn => fn.functionId),
      budgetExcludedFunctionIds: result.borrowableWritingFunctions.filter(fn => !ids.includes(fn.functionId)).map(fn => fn.functionId),
      materialSha256: supplied?.sha256 ?? null, completeEvidence: true,
      nonSupplyReason: supplied ? null : index >= budget.maxCandidates ? 'candidate_budget' : 'complete_function_budget',
      applicability: 'not_assessed'};
  });
  return {schemaVersion: DEEP_REFERENCE_COMPARABLE_SUPPLY_VERSION, queryId: response.queryId,
    responseSha256: hash(response), comparisonSha256: hash(comparison), budget: clone(budget),
    materials, usedChars: materials.reduce((sum, value) => sum + value.content.length, 0),
    usedUnits: unitCount(materials), functionSelection: {schemaVersion: DEEP_REFERENCE_COMPARABLE_SUPPLY_VERSION,
      policy: 'maximum_source_breadth_then_complete_function_round_robin', selections}, boundary: BOUNDARY};
}
