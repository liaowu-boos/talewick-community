import {createHash} from 'node:crypto';
import {readFile, readdir, stat} from 'node:fs/promises';
import {join, relative, resolve, sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {queryTerms} from './retrieval.mjs';

export const NARRATIVE_OBSERVATION_QUERY_VERSION = 'narrative-observation-query-1';
export const MATERIAL_NARRATIVE_OBSERVATION_VERSION = 'material-narrative-observations-1';
export const MATERIAL_NARRATIVE_OBSERVATION_LIMITS = Object.freeze({maxItems: 4, maxChars: 2400, maxPerMaterial: 2});

export const NARRATIVE_OBSERVATION_FIELDS = Object.freeze([
  'intro_contract',
  'chapter_1_change',
  'chapter_2_change',
  'chapter_3_change',
  'chapter_4_paywall',
  'first_paid_payoff',
  'midpoint_engine',
  'ending_mechanism',
  'prose_traits',
  'event',
  'psychology',
  'emotion',
  'expression',
  'readerEffectHypothesis',
]);

const legacyFields = new Set(NARRATIVE_OBSERVATION_FIELDS.slice(0, 9));
const analysisFields = new Set(NARRATIVE_OBSERVATION_FIELDS.slice(9));
const fieldSet = new Set(NARRATIVE_OBSERVATION_FIELDS);
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');

async function readReadyFile(path, encoding = undefined) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Not a regular file: ${path}`);
  return readFile(path, encoding);
}
const hashText = value => hashBytes(Buffer.from(value, 'utf8'));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const splitLines = text => text.split('\n');
const stableJson = value => JSON.stringify(value, Object.keys(value).sort());
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  : value;
const projectionHash = value => hashText(JSON.stringify(canonical(value)));

function fail(message) {
  throw new TypeError(message);
}

function normalizeQuery(input) {
  if (!plainObject(input) || input.contractVersion !== NARRATIVE_OBSERVATION_QUERY_VERSION) fail('Invalid narrative observation query contract');
  if (!nonempty(input.query) || input.query !== input.query.trim() || input.query.length > 4000) fail('Invalid narrative observation query text');
  const allowed = new Set(['contractVersion', 'query', 'fields', 'sourceIds', 'maxResults']);
  if (Object.keys(input).some(key => !allowed.has(key))) fail('Unknown narrative observation query field');
  const fields = input.fields === undefined ? [...NARRATIVE_OBSERVATION_FIELDS] : input.fields;
  if (!Array.isArray(fields) || !fields.length || fields.length > NARRATIVE_OBSERVATION_FIELDS.length || fields.some(field => !fieldSet.has(field)) || new Set(fields).size !== fields.length) fail('Invalid narrative observation fields');
  const sourceIds = input.sourceIds;
  if (sourceIds !== undefined && (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 1000 || sourceIds.some(id => !nonempty(id)) || new Set(sourceIds).size !== sourceIds.length)) fail('Invalid narrative observation sourceIds');
  const maxResults = input.maxResults ?? 20;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 50) fail('Invalid narrative observation maxResults');
  return {contractVersion: input.contractVersion, query: input.query, fields: [...fields], ...(sourceIds ? {sourceIds: [...sourceIds]} : {}), maxResults};
}

async function filesBelow(path) {
  const out = [];
  for (const entry of await readdir(path, {withFileTypes: true})) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) out.push(...await filesBelow(child));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(child);
  }
  return out.sort();
}

function safeArchivedPath(root, archivedPath) {
  if (!nonempty(archivedPath)) return null;
  const full = resolve(root, archivedPath);
  const rel = relative(resolve(root), full);
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) ? full : null;
}

function reviewState(row) {
  const review = row?.analysis?.validation?.semanticReview;
  const bindingValid = row?.analysis?.reviewStatus === 'checked'
    && review?.approved === true
    && nonempty(review.recordId)
    && review.sourceId === row.sourceId
    && review.textVersion === row.textVersion
    && review.analysisVersion === row.analysis.version
    && row.analysis.textVersion === row.textVersion;
  return {
    analysisVersion: row?.analysis?.version ?? null,
    reviewStatus: row?.analysis?.reviewStatus ?? null,
    semanticApproved: review?.approved === true,
    reviewRecordId: review?.recordId ?? null,
    sourceBound: review?.sourceId === row?.sourceId,
    textBound: review?.textVersion === row?.textVersion && row?.analysis?.textVersion === row?.textVersion,
    analysisBound: review?.analysisVersion === row?.analysis?.version,
    bindingValid,
  };
}

function lineOffsets(text) {
  const lines = splitLines(text);
  const starts = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  return {lines, starts};
}

function legacyEvidence(evidence, text, expectedTextVersion, lineIndex) {
  const locator = evidence?.locator;
  const verification = evidence?.verification;
  if (!plainObject(locator) || !plainObject(verification) || !nonempty(evidence?.evidenceId) || !nonempty(evidence?.cue)) return {valid: false, reason: 'invalid_evidence_shape'};
  if (verification.status !== 'verified' || verification.textVersion !== expectedTextVersion) return {valid: false, reason: 'evidence_not_verified_for_current_text'};
  const {lines, starts} = lineIndex;
  const lineStart = locator.line_start;
  const lineEnd = locator.line_end;
  if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart || lineEnd > lines.length) return {valid: false, reason: 'invalid_line_window'};
  const lineWindowStart = starts[lineStart - 1];
  const lineWindowEnd = starts[lineEnd - 1] + lines[lineEnd - 1].length;
  const charStart = locator.char_start;
  const charEnd = locator.char_end;
  if (!Number.isSafeInteger(charStart) || !Number.isSafeInteger(charEnd) || charStart < 0 || charEnd < charStart || charEnd > text.length) return {valid: false, reason: 'invalid_utf16_window'};
  const intersectionStart = Math.max(lineWindowStart, charStart);
  const intersectionEnd = Math.min(lineWindowEnd, charEnd);
  const lineBody = text.slice(lineWindowStart, lineWindowEnd);
  const charBody = text.slice(charStart, charEnd);
  const intersectionBody = text.slice(intersectionStart, intersectionEnd);
  if (verification.lineWindowUtf16Start !== lineWindowStart || verification.lineWindowUtf16End !== lineWindowEnd || verification.lineWindowBodySha256 !== hashText(lineBody)) return {valid: false, reason: 'line_window_changed'};
  if (verification.charWindowUtf16Start !== charStart || verification.charWindowUtf16End !== charEnd || verification.charWindowBodySha256 !== hashText(charBody)) return {valid: false, reason: 'utf16_window_changed'};
  if (verification.intersectionUtf16Start !== intersectionStart || verification.intersectionUtf16End !== intersectionEnd || verification.intersectionBodySha256 !== hashText(intersectionBody)) return {valid: false, reason: 'intersection_changed'};
  const cueStart = verification.matchedCueUtf16Start;
  const cueEnd = verification.matchedCueUtf16End;
  if (!Number.isSafeInteger(cueStart) || !Number.isSafeInteger(cueEnd) || cueStart < intersectionStart || cueEnd > intersectionEnd || cueEnd - cueStart !== evidence.cue.length || text.slice(cueStart, cueEnd) !== evidence.cue) return {valid: false, reason: 'cue_occurrence_changed'};
  return {valid: true, quote: {
    evidenceId: evidence.evidenceId,
    quote: evidence.cue,
    supportType: evidence.supportType ?? null,
    lineStart,
    lineEnd,
    lineWindowUtf16Start: lineWindowStart,
    lineWindowUtf16End: lineWindowEnd,
    charStart,
    charEnd,
    lineWindowBodySha256: verification.lineWindowBodySha256,
    charWindowBodySha256: verification.charWindowBodySha256,
    intersectionUtf16Start: intersectionStart,
    intersectionUtf16End: intersectionEnd,
    intersectionBodySha256: verification.intersectionBodySha256,
    matchedCueUtf16Start: cueStart,
    matchedCueUtf16End: cueEnd,
  }};
}

function analysisEvidence(evidence, text, lineIndex) {
  if (!plainObject(evidence) || !nonempty(evidence.quote) || !Number.isSafeInteger(evidence.lineStart) || !Number.isSafeInteger(evidence.lineEnd)) return {valid: false, reason: 'invalid_analysis_evidence_shape'};
  const {lines, starts} = lineIndex;
  if (evidence.lineStart < 1 || evidence.lineEnd < evidence.lineStart || evidence.lineEnd > lines.length) return {valid: false, reason: 'invalid_analysis_line_window'};
  const windowStart = starts[evidence.lineStart - 1];
  const windowEnd = starts[evidence.lineEnd - 1] + lines[evidence.lineEnd - 1].length;
  const window = text.slice(windowStart, windowEnd);
  const local = window.indexOf(evidence.quote);
  if (local < 0) return {valid: false, reason: 'analysis_quote_not_in_current_window'};
  const quoteStart = windowStart + local;
  return {valid: true, quote: {
    quote: evidence.quote,
    lineStart: evidence.lineStart,
    lineEnd: evidence.lineEnd,
    lineWindowUtf16Start: windowStart,
    lineWindowUtf16End: windowEnd,
    lineWindowBodySha256: hashText(window),
    matchedQuoteUtf16Start: quoteStart,
    matchedQuoteUtf16End: quoteStart + evidence.quote.length,
  }};
}

function scoreCandidate(text, terms) {
  const lower = text.toLowerCase();
  const hits = [];
  let score = 0;
  for (const {term, weight} of terms) if (lower.includes(term)) {
    hits.push(term);
    score += weight;
  }
  return {score, hits};
}

function decodeSourceBytes(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 255 && bytes[1] === 254) encoding = 'utf-16le';
  if (bytes[0] === 254 && bytes[1] === 255) encoding = 'utf-16be';
  try {
    const rawText = new TextDecoder(encoding, {fatal: true}).decode(bytes);
    if (!rawText.trim() || rawText.includes('\0')) return {valid: false, reason: 'source_decode_failed'};
    return {valid: true, encoding, rawText, normalizedText: rawText.replace(/\r\n|\r/g, '\n')};
  } catch { return {valid: false, reason: 'source_decode_failed'}; }
}

async function loadSource(libraryRoot, row) {
  const path = join(libraryRoot, 'objects', `${row.sourceSha256}.bin`);
  let bytes;
  try { bytes = await readReadyFile(path); } catch { return {valid: false, reason: 'source_object_missing'}; }
  if (hashBytes(bytes) !== row.sourceSha256) return {valid: false, reason: 'source_object_sha_mismatch'};
  const decoded = decodeSourceBytes(bytes);
  if (!decoded.valid) return decoded;
  if (row.encoding !== decoded.encoding) return {valid: false, reason: 'source_encoding_identity_mismatch'};
  let text, textPath;
  if (row.textVersion === `text-v2-lf-${row.sourceSha256}`) {
    text = decoded.normalizedText;
    textPath = join(libraryRoot, 'objects', `${row.sourceSha256}.lf-v2.txt`);
  } else if (row.textVersion === `text-${row.sourceSha256}`) {
    text = decoded.rawText;
    textPath = join(libraryRoot, 'objects', `${row.sourceSha256}.txt`);
  } else return {valid: false, reason: 'source_text_version_binding_invalid'};
  let derivedText;
  try { derivedText = await readReadyFile(textPath, 'utf8'); } catch { return {valid: false, reason: 'derived_source_text_missing'}; }
  if (derivedText !== text) return {valid: false, reason: 'derived_source_text_mismatch'};
  const textSha = hashText(text);
  if (row.indexIntegrity?.sourceTextSha256 !== undefined && row.indexIntegrity.sourceTextSha256 !== textSha) return {valid: false, reason: 'catalog_index_source_identity_mismatch'};
  return {valid: true, text, textSha, lineIndex: lineOffsets(text), objectPath: path, textPath, encoding: decoded.encoding};
}

async function validateArchive(sidecarRoot, sidecar) {
  const cardPath = safeArchivedPath(sidecarRoot, sidecar?.cardBinding?.archivedCardPath);
  const auditPath = safeArchivedPath(sidecarRoot, sidecar?.cardBinding?.archivedAuditPath);
  if (!cardPath || !auditPath) return {valid: false, reason: 'unsafe_or_missing_archive_path'};
  let cardBytes, auditBytes;
  try { [cardBytes, auditBytes] = await Promise.all([readReadyFile(cardPath), readReadyFile(auditPath)]); }
  catch { return {valid: false, reason: 'archived_card_or_audit_missing'}; }
  if (hashBytes(cardBytes) !== sidecar.cardBinding.cardSha256 || hashBytes(auditBytes) !== sidecar.cardBinding.auditSha256) return {valid: false, reason: 'archived_card_or_audit_sha_mismatch'};
  let card, audit;
  try { card = JSON.parse(cardBytes); audit = JSON.parse(auditBytes); }
  catch { return {valid: false, reason: 'archived_card_or_audit_invalid_json'}; }
  const accepted = sidecar.cardBinding.acceptedStatus === 'accepted'
    && sidecar.cardBinding.auditMatchesCurrentRevision === true
    && audit?.story_id === sidecar.cardBinding.storyId
    && card?.story_id === sidecar.cardBinding.storyId
    && card?.source_sha256 === sidecar.cardBinding.cardSourceSha256
    && audit?.card?.sha256 === sidecar.cardBinding.cardSha256
    && audit?.source?.sha256 === sidecar.cardBinding.cardSourceSha256
    && audit?.aggregate?.status === 'ACCEPTED'
    && audit?.aggregate?.decision === 'accepted';
  if (!accepted) return {valid: false, reason: 'legacy_card_acceptance_binding_invalid'};
  return {valid: true, card, audit};
}

function validateCardProjection(sidecar, card) {
  const originalEvidence = Array.isArray(card?.evidence) ? card.evidence : [];
  const projectedEvidence = Array.isArray(sidecar?.cardEvidence) ? sidecar.cardEvidence : [];
  if (projectedEvidence.length !== originalEvidence.length) return {valid: false, reason: 'card_evidence_projection_count_mismatch'};
  const evidenceIds = new Set();
  for (let index = 0; index < originalEvidence.length; index++) {
    const original = originalEvidence[index];
    const projected = projectedEvidence[index];
    if (!nonempty(original?.evidence_id) || !nonempty(projected?.evidenceId) || evidenceIds.has(projected.evidenceId)) return {valid: false, reason: 'card_evidence_projection_id_invalid'};
    evidenceIds.add(projected.evidenceId);
    if (projected.evidenceId !== original.evidence_id
      || !isDeepStrictEqual(projected.supports, Array.isArray(original.supports) ? original.supports : [])
      || !isDeepStrictEqual(projected.locator, original.locator ?? {})
      || projected.cue !== (original.cue ?? '')
      || projected.supportType !== (original.support_type ?? null)
      || projected.inference !== (original.inference ?? null)) return {valid: false, reason: 'card_evidence_projection_mismatch'};
  }
  const observations = Array.isArray(sidecar?.observations) ? sidecar.observations : [];
  const expectedFields = [...legacyFields].filter(field => Object.hasOwn(card, field));
  if (observations.length !== expectedFields.length || new Set(observations.map(item => item.field)).size !== observations.length) return {valid: false, reason: 'card_observation_projection_count_mismatch'};
  for (const field of expectedFields) {
    const observation = observations.find(item => item.field === field);
    const expectedIds = originalEvidence.filter(item => Array.isArray(item.supports) && item.supports.includes(field)).map(item => item.evidence_id);
    if (!observation
      || !isDeepStrictEqual(observation.value, card[field])
      || observation.classification !== 'observable_narrative_choice'
      || observation.authorIntentClaimed !== false
      || !isDeepStrictEqual(observation.originalFieldConfidence ?? null, card.field_confidence?.[field] ?? null)
      || !isDeepStrictEqual(observation.boundaryOrigin ?? null, card.boundary_origin?.[field] ?? null)
      || !isDeepStrictEqual(observation.evidenceIds, expectedIds)) return {valid: false, reason: 'card_observation_projection_mismatch'};
  }
  return {valid: true};
}

function legacyIdentity(sidecar, archive) {
  return {
    storyId: sidecar.cardBinding.storyId,
    cardSchemaVersion: sidecar.cardBinding.cardSchemaVersion,
    cardSha256: sidecar.cardBinding.cardSha256,
    auditSha256: sidecar.cardBinding.auditSha256,
    archivedCardPath: sidecar.cardBinding.archivedCardPath,
    archivedAuditPath: sidecar.cardBinding.archivedAuditPath,
    acceptedAtArchive: archive.audit.aggregate.status === 'ACCEPTED' && archive.audit.aggregate.decision === 'accepted',
    automatedChecksStatus: archive.audit.automated_checks?.status ?? null,
    independentReviewVerdicts: Object.fromEntries(Object.entries(archive.audit.independent_reviews ?? {}).map(([key, value]) => [key, value.verdict ?? null])),
    production: {
      batch: archive.card.production?.batch ?? null,
      revision: archive.card.production?.revision ?? null,
      status: archive.card.production?.status ?? null,
      worker: archive.card.production?.worker ?? null,
    },
  };
}

function sourceIdentity(row) {
  return {sourceId: row.sourceId, title: row.title, sourceSha256: row.sourceSha256,
    normalizedTextSha256: row.indexIntegrity?.sourceTextSha256 ?? null, textVersion: row.textVersion};
}

function projectionBudget(value = {}) {
  if (!plainObject(value)) fail('Invalid narrative observation projection budget');
  const allowed = new Set(['maxItems', 'maxChars', 'maxPerMaterial']);
  if (Object.keys(value).some(key => !allowed.has(key))) fail('Unknown narrative observation projection budget field');
  const budget = {};
  for (const key of allowed) {
    const number = value[key] ?? MATERIAL_NARRATIVE_OBSERVATION_LIMITS[key];
    if (!Number.isSafeInteger(number) || number < 0) fail('Invalid narrative observation projection budget');
    budget[key] = Math.min(number, MATERIAL_NARRATIVE_OBSERVATION_LIMITS[key]);
  }
  return budget;
}

function materialReferences(material) {
  if (!plainObject(material) || !nonempty(material.id) || !Array.isArray(material.references)) fail('Invalid material for narrative observation projection');
  const refs = material.references.filter(ref => plainObject(ref) && nonempty(ref.sourceId) && sha(ref.sourceSha256) && nonempty(ref.textVersion)
    && Number.isSafeInteger(ref.lineStart) && Number.isSafeInteger(ref.lineEnd) && ref.lineStart >= 1 && ref.lineEnd >= ref.lineStart);
  if (refs.length !== material.references.length) fail('Invalid material reference for narrative observation projection');
  return refs;
}

const sameObservationSource = (source, ref) => source.sourceId === ref.sourceId && source.sourceSha256 === ref.sourceSha256 && source.textVersion === ref.textVersion;
const quoteInside = (quote, refs) => refs.some(ref => quote.lineStart >= ref.lineStart && quote.lineEnd <= ref.lineEnd);
const projectionPayload = value => ({contractVersion: value.contractVersion, queryHash: value.queryHash, items: value.items, limits: value.limits});
const compactEvidenceValid = quote => nonempty(quote?.quote)
  && Number.isSafeInteger(quote.lineStart) && Number.isSafeInteger(quote.lineEnd) && quote.lineStart >= 1 && quote.lineEnd >= quote.lineStart
  && Array.isArray(quote.lineWindow) && quote.lineWindow.length === 3 && Number.isSafeInteger(quote.lineWindow[0])
  && Number.isSafeInteger(quote.lineWindow[1]) && quote.lineWindow[1] >= quote.lineWindow[0] && sha(quote.lineWindow[2])
  && Array.isArray(quote.charWindow) && quote.charWindow.length === 3 && Number.isSafeInteger(quote.charWindow[0])
  && Number.isSafeInteger(quote.charWindow[1]) && quote.charWindow[1] >= quote.charWindow[0] && sha(quote.charWindow[2])
  && Array.isArray(quote.intersection) && quote.intersection.length === 3 && Number.isSafeInteger(quote.intersection[0])
  && Number.isSafeInteger(quote.intersection[1]) && quote.intersection[1] >= quote.intersection[0] && sha(quote.intersection[2])
  && Array.isArray(quote.matched) && quote.matched.length === 2 && Number.isSafeInteger(quote.matched[0])
  && Number.isSafeInteger(quote.matched[1]) && quote.matched[1] - quote.matched[0] === quote.quote.length
  && quote.intersection[0] >= quote.lineWindow[0] && quote.intersection[1] <= quote.lineWindow[1]
  && quote.intersection[0] >= quote.charWindow[0] && quote.intersection[1] <= quote.charWindow[1]
  && quote.matched[0] >= quote.intersection[0] && quote.matched[1] <= quote.intersection[1];
const expandedEvidenceValid = quote => nonempty(quote?.quote) && Number.isSafeInteger(quote.lineStart)
  && Number.isSafeInteger(quote.lineEnd) && quote.lineStart >= 1 && quote.lineEnd >= quote.lineStart;
const compactEvidenceKeys = Object.freeze(['lineWindow', 'charWindow', 'intersection', 'matched']);

/** Validate the additive observation metadata without changing the material body identity. */
export function validateMaterialNarrativeObservations(material) {
  const projection = material?.narrativeObservations;
  if (projection === undefined) return material;
  const refs = materialReferences(material);
  if (!plainObject(projection) || projection.contractVersion !== MATERIAL_NARRATIVE_OBSERVATION_VERSION || !sha(projection.queryHash)
    || !Array.isArray(projection.items) || !projection.items.length || projection.items.length > MATERIAL_NARRATIVE_OBSERVATION_LIMITS.maxPerMaterial
    || !Number.isSafeInteger(projection.usedChars) || projection.usedChars < 0 || !Array.isArray(projection.limits) || projection.limits.some(limit => typeof limit !== 'string')
    || !sha(projection.projectionSha256) || projectionHash(projectionPayload(projection)) !== projection.projectionSha256) fail('Invalid material narrative observations');
  let usedChars = 0;
  const ids = new Set();
  for (const item of projection.items) {
    if (!plainObject(item) || !nonempty(item.id) || ids.has(item.id) || !nonempty(item.field) || !plainObject(item.source)
      || !nonempty(item.source.sourceId) || !sha(item.source.sourceSha256) || !nonempty(item.source.textVersion) || !sha(item.source.normalizedTextSha256)
      || item.analysisStatus?.kind !== 'archived_ai_narrative_observation' || item.analysisStatus?.grantsCurrentCheckedAnalysisStatus !== false
      || !plainObject(item.authority) || item.authority.grantsNewCheckedAnalysisStatus !== false
      || !Array.isArray(item.evidence) || !item.evidence.length || !plainObject(item.materialBinding) || item.materialBinding.materialId !== material.id
      || !Array.isArray(item.limitations)
      || !Number.isSafeInteger(item.chargedChars) || item.chargedChars < 1) fail('Invalid material narrative observation item');
    ids.add(item.id);
    let boundRefs;
    const indexedBinding = Object.hasOwn(item.materialBinding, 'referenceIndexes');
    if (indexedBinding) {
      if (!Array.isArray(item.materialBinding.referenceIndexes) || !item.materialBinding.referenceIndexes.length
        || !item.materialBinding.referenceIndexes.every(index => Number.isSafeInteger(index) && index >= 0 && index < refs.length)
        || new Set(item.materialBinding.referenceIndexes).size !== item.materialBinding.referenceIndexes.length) fail('Invalid material narrative observation item');
      boundRefs = item.materialBinding.referenceIndexes.map(index => refs[index]);
    } else if (Array.isArray(item.materialBinding.references) && item.materialBinding.references.length) {
      // Accept the original expanded representation for already serialized callers.
      boundRefs = item.materialBinding.references;
      for (const bound of boundRefs) if (!sameObservationSource(item.source, bound) || !refs.some(ref => ref.sourceId === bound.sourceId
        && ref.sourceSha256 === bound.sourceSha256 && ref.textVersion === bound.textVersion && ref.lineStart === bound.lineStart
        && ref.lineEnd === bound.lineEnd)) fail('Narrative observation material binding changed');
    } else fail('Invalid material narrative observation item');
    if (!boundRefs.every(ref => sameObservationSource(item.source, ref))) fail('Narrative observation material binding changed');
    const compactRepresentation = indexedBinding || item.evidence.some(quote => compactEvidenceKeys.some(key => Object.hasOwn(quote, key)));
    if (!item.evidence.every(quote => (compactRepresentation ? compactEvidenceValid(quote) : expandedEvidenceValid(quote))
      && quoteInside(quote, boundRefs))) fail('Narrative observation evidence escaped selected material windows');
    const withoutCharge = {...item}; delete withoutCharge.chargedChars;
    if (JSON.stringify(withoutCharge).length !== item.chargedChars) fail('Narrative observation character accounting changed');
    usedChars += item.chargedChars;
  }
  if (usedChars !== projection.usedChars || usedChars > MATERIAL_NARRATIVE_OBSERVATION_LIMITS.maxChars) fail('Narrative observation character budget changed');
  return material;
}

function projectionItem(observation, material, refs) {
  const referenceIndexes = material.references.map((ref, index) => refs.some(bound => ref.sourceId === bound.sourceId
    && ref.sourceSha256 === bound.sourceSha256 && ref.textVersion === bound.textVersion && ref.lineStart === bound.lineStart
    && ref.lineEnd === bound.lineEnd) ? index : -1).filter(index => index >= 0);
  const evidence = observation.quotes.map(quote => ({
    evidenceId: quote.evidenceId,
    quote: quote.quote,
    supportType: quote.supportType,
    lineStart: quote.lineStart,
    lineEnd: quote.lineEnd,
    lineWindow: [quote.lineWindowUtf16Start, quote.lineWindowUtf16End, quote.lineWindowBodySha256],
    charWindow: [quote.charStart, quote.charEnd, quote.charWindowBodySha256],
    intersection: [quote.intersectionUtf16Start, quote.intersectionUtf16End, quote.intersectionBodySha256],
    matched: [quote.matchedCueUtf16Start, quote.matchedCueUtf16End],
  }));
  const item = {
    id: observation.id,
    field: observation.field,
    value: structuredClone(observation.value),
    analysisStatus: {
      kind: 'archived_ai_narrative_observation',
      archiveAccepted: observation.legacyAnalysisIdentity.acceptedAtArchive === true,
      currentAnalysisBindingValid: observation.currentReviewState.bindingValid === true,
      grantsCurrentCheckedAnalysisStatus: false,
    },
    confidence: {
      originalFieldConfidence: observation.authority.originalFieldConfidence ?? null,
      boundaryOrigin: observation.authority.boundaryOrigin ?? null,
    },
    source: {
      sourceId: observation.source.sourceId,
      sourceSha256: observation.source.sourceSha256,
      normalizedTextSha256: observation.source.normalizedTextSha256,
      textVersion: observation.source.textVersion,
    },
    archive: {
      storyId: observation.legacyAnalysisIdentity.storyId,
      cardSha256: observation.legacyAnalysisIdentity.cardSha256,
      auditSha256: observation.legacyAnalysisIdentity.auditSha256,
    },
    authority: {
      classification: observation.authority.classification,
      authorIntentClaimed: false,
      grantsNewCheckedAnalysisStatus: false,
    },
    evidence,
    materialBinding: {materialId: material.id, referenceIndexes, allEvidenceInsideSelectedWindows: true},
    limitations: ['archived_ai_observation', 'not_current_checked_analysis', 'evidence_only_original_text', 'explicit_adoption_required'],
  };
  return {...item, chargedChars: JSON.stringify(item).length};
}

const commonLimits = Object.freeze([
  '词法命中只用于候选排序，不证明叙事观察正确、重要或适合当前创作。',
  '结果必须显式调用；本合同不是创作材料包，也不自动进入创作供给。',
  '旧故事卡是历史 AI 分析档案；其通过旧审计不等于当前 DATA checked 分析。',
  '作者真实意图、真人读者反应与平台效果均不由本查询证明。',
]);

/**
 * Open a read-only, explicit narrative-observation query service.
 * It never writes the library or sidecar package and never returns retrieval
 * `materials`, so callers cannot accidentally treat observations as normal supply.
 */
export async function createNarrativeObservationService({libraryRoot, sidecarRoot}) {
  if (!nonempty(libraryRoot) || !nonempty(sidecarRoot)) fail('libraryRoot and sidecarRoot are required');
  const library = resolve(libraryRoot);
  const sidecarPackage = resolve(sidecarRoot);
  const catalogPath = join(library, 'catalog.json');
  const catalogBytes = await readReadyFile(catalogPath);
  const catalog = JSON.parse(catalogBytes);
  if (!Array.isArray(catalog.sources)) fail('Invalid library catalog');
  const rows = new Map();
  for (const row of catalog.sources) {
    if (!nonempty(row?.sourceId) || rows.has(row.sourceId)) fail('Invalid or duplicate catalog sourceId');
    rows.set(row.sourceId, row);
  }
  const sidecarsPath = join(sidecarPackage, 'sidecars');
  const sidecarFiles = await filesBelow(sidecarsPath);
  const sidecars = [];
  for (const path of sidecarFiles) {
    try {
      const bytes = await readReadyFile(path);
      const sha256 = hashBytes(bytes);
      try { sidecars.push({path, sha256, value: JSON.parse(bytes)}); }
      catch { sidecars.push({path, sha256, value: null, loadIssue: 'invalid_sidecar_json'}); }
    }
    catch { sidecars.push({path, value: null, loadIssue: 'invalid_sidecar_json'}); }
  }
  const boundSourceIds = sidecars.map(item => item.value?.sourceBinding?.sourceId).filter(nonempty);
  if (new Set(boundSourceIds).size !== boundSourceIds.length) fail('Duplicate sidecar source binding');
  const scope = Object.freeze({kind: 'strict_bound_sidecar_sources', sourceCount: new Set(boundSourceIds).size, catalogSourceCount: rows.size});
  const snapshotFiles = new Map([[catalogPath, hashBytes(catalogBytes)]]);
  for (const item of sidecars) {
    snapshotFiles.set(item.path, item.sha256 ?? null);
    const cardPath = safeArchivedPath(sidecarPackage, item.value?.cardBinding?.archivedCardPath);
    const auditPath = safeArchivedPath(sidecarPackage, item.value?.cardBinding?.archivedAuditPath);
    if (cardPath) snapshotFiles.set(cardPath, await readReadyFile(cardPath).then(hashBytes).catch(() => null));
    if (auditPath) snapshotFiles.set(auditPath, await readReadyFile(auditPath).then(hashBytes).catch(() => null));
    const row = rows.get(item.value?.sourceBinding?.sourceId);
    if (row) {
      const objectPath = join(library, 'objects', `${row.sourceSha256}.bin`);
      const textPath = join(library, 'objects', `${row.sourceSha256}${row.textVersion.startsWith('text-v2-lf-') ? '.lf-v2' : ''}.txt`);
      snapshotFiles.set(objectPath, await readReadyFile(objectPath).then(hashBytes).catch(() => null));
      snapshotFiles.set(textPath, await readReadyFile(textPath).then(hashBytes).catch(() => null));
    }
  }
  const sidecarSetSha256 = hashText(sidecars.map(item => `${relative(sidecarPackage, item.path)}\t${item.sha256 ?? 'missing'}`).join('\n'));
  const snapshot = Object.freeze({catalogSha256: hashBytes(catalogBytes), sidecarSetSha256, fileCount: snapshotFiles.size});
  const assertCurrentSnapshot = async () => {
    const currentSidecarFiles = await filesBelow(sidecarsPath);
    const changedFiles = [];
    if (!isDeepStrictEqual(currentSidecarFiles, sidecarFiles)) changedFiles.push('sidecars/');
    for (const [path, expected] of snapshotFiles) {
      const actual = await readReadyFile(path).then(hashBytes).catch(() => null);
      if (actual !== expected) changedFiles.push(relative(path.startsWith(`${library}${sep}`) ? library : sidecarPackage, path));
    }
    if (changedFiles.length) {
      const error = new Error('Narrative observation snapshot changed; reopen the service before querying again');
      error.code = 'NARRATIVE_OBSERVATION_SNAPSHOT_STALE';
      error.snapshot = snapshot;
      error.changedFiles = [...new Set(changedFiles)];
      throw error;
    }
  };
  const sourceCache = new Map();
  const archiveCache = new Map();
  const source = async row => {
    if (!sourceCache.has(row.sourceId)) sourceCache.set(row.sourceId, loadSource(library, row));
    return sourceCache.get(row.sourceId);
  };
  const archive = async item => {
    if (!archiveCache.has(item.path)) archiveCache.set(item.path, validateArchive(sidecarPackage, item.value));
    return archiveCache.get(item.path);
  };

  const api = {
    contractVersion: NARRATIVE_OBSERVATION_QUERY_VERSION,
    scope,
    snapshot,
    async query(input) {
      await assertCurrentSnapshot();
      const request = normalizeQuery(input);
      const terms = queryTerms(request.query);
      const requested = new Set(request.fields);
      const sourceScope = request.sourceIds ? new Set(request.sourceIds) : null;
      const candidates = [];
      const withheld = [];
      let scannedLegacyObservations = 0;
      let scannedAnalysisUnits = 0;

      for (const item of sidecars) {
        const sidecar = item.value;
        const sourceId = sidecar?.sourceBinding?.sourceId;
        if (sourceScope && (!sourceId || !sourceScope.has(sourceId))) continue;
        if (item.loadIssue || sidecar?.schemaVersion !== 'narrative-observation-sidecar-v2') {
          withheld.push({sourceId: sourceId ?? null, recordType: 'legacy_card_observation', reason: item.loadIssue ?? 'unsupported_sidecar_schema'});
          continue;
        }
        const row = rows.get(sourceId);
        if (!row) {
          withheld.push({sourceId, recordType: 'legacy_card_observation', reason: 'source_not_in_current_catalog'});
          continue;
        }
        const sourceState = await source(row);
        const sourceBindingValid = sourceState.valid
          && sidecar.sourceBinding.sourceSha256 === row.sourceSha256
          && sidecar.sourceBinding.normalizedTextSha256 === sourceState.textSha
          && sidecar.sourceBinding.textVersion === row.textVersion
          && sidecar.cardBinding.cardSourceSha256 === row.sourceSha256;
        const archiveState = await archive(item);
        const projectionState = archiveState.valid ? validateCardProjection(sidecar, archiveState.card) : {valid: false, reason: archiveState.reason};
        const evidenceById = new Map((sidecar.cardEvidence ?? []).map(evidence => [evidence.evidenceId, evidence]));

        for (const observation of sidecar.observations ?? []) {
          if (!requested.has(observation.field) || !legacyFields.has(observation.field)) continue;
          scannedLegacyObservations++;
          const search = scoreCandidate([row.title, observation.field, JSON.stringify(observation.value), ...(observation.evidenceIds ?? []).map(id => evidenceById.get(id)?.cue ?? '')].join('\n'), terms);
          if (!search.score) continue;
          let reason = null;
          if (!sourceBindingValid) reason = sourceState.reason ?? 'sidecar_source_binding_invalid';
          else if (!archiveState.valid) reason = archiveState.reason;
          else if (!projectionState.valid) reason = projectionState.reason;
          else if (sidecar.supplyPolicy?.automaticSupply !== false || sidecar.supplyPolicy?.retrievalIntegrated !== false || sidecar.supplyPolicy?.grantsCheckedAnalysisStatus !== false || sidecar.supplyPolicy?.unverifiedEvidenceSupplyAllowed !== false) reason = 'sidecar_supply_policy_invalid';
          else if (observation.classification !== 'observable_narrative_choice' || observation.authorIntentClaimed !== false) reason = 'observation_authority_boundary_invalid';
          else if (observation.evidenceVerificationStatus !== 'verified' || !Array.isArray(observation.evidenceIds) || !observation.evidenceIds.length || new Set(observation.evidenceIds).size !== observation.evidenceIds.length) reason = 'observation_evidence_binding_invalid';
          const quotes = [];
          if (!reason) for (const evidenceId of observation.evidenceIds) {
            const evidence = evidenceById.get(evidenceId);
            if (!evidence) { reason = 'observation_evidence_missing'; break; }
            if (!Array.isArray(evidence.supports) || !evidence.supports.includes(observation.field)) { reason = 'evidence_does_not_support_observation_field'; break; }
            const checked = legacyEvidence(evidence, sourceState.text, row.textVersion, sourceState.lineIndex);
            if (!checked.valid) { reason = checked.reason; break; }
            quotes.push(checked.quote);
          }
          if (reason) {
            withheld.push({sourceId, recordType: 'legacy_card_observation', field: observation.field, reason, hits: search.hits});
            continue;
          }
          const catalogAnalysisProjection = observation.boundaryOrigin === 'catalog_analysis_unit'
            && observation.originalFieldConfidence === 'reviewed_catalog_analysis';
          candidates.push({
            recordType: 'legacy_card_observation',
            id: `legacy:${sourceId}:${sidecar.cardBinding.storyId}:${observation.field}`,
            field: observation.field,
            value: observation.value,
            score: search.score,
            hits: search.hits,
            source: sourceIdentity(row),
            quotes,
            legacyAnalysisIdentity: legacyIdentity(sidecar, archiveState),
            currentReviewState: reviewState(row),
            authority: {
              classification: 'observable_narrative_choice',
              authorIntentClaimed: false,
              boundaryOrigin: observation.boundaryOrigin ?? null,
              originalFieldConfidence: observation.originalFieldConfidence ?? null,
              grantsNewCheckedAnalysisStatus: false,
              automaticCreativeSupply: false,
              retrievalIntegrated: false,
            },
            limitations: catalogAnalysisProjection ? [
              '该观察是当前 catalog 已复核 analysis 单元的只读兼容投影；逐字证据已在包生成时重新核对。',
              '投影不改变 analysis 复核状态，不预判文学质量；读者作用仍是假说。',
            ] : [
              '该观察来自旧故事卡的 AI 分析，不是当前 DATA 分析单元。',
              '旧卡接受状态只说明归档审计结果；当前复核状态另列且不由本结果改变。',
            ],
          });
        }

        const selectedAnalysisFields = request.fields.filter(field => analysisFields.has(field));
        if (!selectedAnalysisFields.length) continue;
        for (const unit of row.analysis?.units ?? []) {
          scannedAnalysisUnits++;
          const values = Object.fromEntries(selectedAnalysisFields.map(field => [field, unit[field]]).filter(([, value]) => nonempty(value)));
          const search = scoreCandidate([row.title, unit.title, ...Object.values(values), ...(unit.evidence ?? []).map(evidence => evidence.quote ?? '')].join('\n'), terms);
          if (!search.score) continue;
          let reason = null;
          const current = reviewState(row);
          if (!sourceState.valid) reason = sourceState.reason;
          else if (!sourceBindingValid) reason = 'sidecar_source_binding_invalid';
          else if (!archiveState.valid) reason = archiveState.reason;
          else if (!projectionState.valid) reason = projectionState.reason;
          else if (!current.bindingValid) reason = 'current_analysis_not_checked_and_bound';
          else if (!Object.keys(values).length) reason = 'requested_analysis_fields_missing';
          else if (!Array.isArray(unit.evidence) || !unit.evidence.length) reason = 'analysis_evidence_missing';
          const quotes = [];
          if (!reason) for (const evidence of unit.evidence) {
            const checked = analysisEvidence(evidence, sourceState.text, sourceState.lineIndex);
            if (!checked.valid) { reason = checked.reason; break; }
            quotes.push(checked.quote);
          }
          if (reason) {
            withheld.push({sourceId, recordType: 'checked_analysis_unit', unitId: unit.id, reason, hits: search.hits});
            continue;
          }
          candidates.push({
            recordType: 'checked_analysis_unit',
            id: `analysis:${sourceId}:${unit.id}`,
            unitId: unit.id,
            title: unit.title,
            values,
            score: search.score,
            hits: search.hits,
            source: sourceIdentity(row),
            quotes,
            currentReviewState: current,
            authority: {
              classification: 'current_checked_analysis_unit',
              authorIntentClaimed: false,
              inheritsExistingCheckedAnalysisState: true,
              grantsNewCheckedAnalysisStatus: false,
              automaticCreativeSupply: false,
            },
            limitations: ['readerEffectHypothesis 是已复核假说，不是真人读者或平台效果。'],
          });
        }
      }

      candidates.sort((a, b) => b.score - a.score || a.source.sourceId.localeCompare(b.source.sourceId) || a.id.localeCompare(b.id));
      const results = candidates.slice(0, request.maxResults).map(({score, ...candidate}) => candidate);
      const relevantWithheld = withheld.filter(item => item.hits?.length || item.reason === 'source_not_in_current_catalog' || item.reason === 'unsupported_sidecar_schema' || item.reason === 'invalid_sidecar_json');
      return {
        contractVersion: NARRATIVE_OBSERVATION_QUERY_VERSION,
        queryHash: hashText(stableJson(request)),
        status: results.length ? (relevantWithheld.length ? 'partial' : 'covered') : 'uncovered',
        explicitOnly: true,
        creativeSupply: false,
        scope,
        snapshot,
        request,
        results,
        withheld: relevantWithheld.slice(0, 100).map(({hits, ...item}) => item),
        counts: {
          resultCount: results.length,
          matchedCandidateCount: candidates.length,
          withheldCount: relevantWithheld.length,
          scannedSidecars: sidecars.length,
          scannedLegacyObservations,
          scannedAnalysisUnits,
        },
        limitations: [...commonLimits],
      };
    },
    /**
     * Attach only legacy observations whose complete evidence is contained by
     * an already selected material. This never selects a material itself.
     */
    async projectMaterials({query, materials, budget: requestedBudget} = {}) {
      if (!nonempty(query) || query !== query.trim() || query.length > 4000 || !Array.isArray(materials)) fail('Invalid narrative observation material projection');
      const budget = projectionBudget(requestedBudget);
      const cloned = structuredClone(materials);
      const references = cloned.map(material => ({material, refs: materialReferences(material)}));
      if (new Set(cloned.map(material => material.id)).size !== cloned.length) fail('Duplicate material ID in narrative observation projection');
      const sourceIds = [...new Set(references.flatMap(item => item.refs.map(ref => ref.sourceId)))];
      const boundSourceIdSet = new Set(boundSourceIds);
      const coveredSelectedSourceIds = sourceIds.filter(id => boundSourceIdSet.has(id));
      const uncoveredSelectedSourceIds = sourceIds.filter(id => !boundSourceIdSet.has(id));
      const summaryBase = {contractVersion: MATERIAL_NARRATIVE_OBSERVATION_VERSION, budget, selectedMaterialCount: cloned.length,
        selectedSourceCount: sourceIds.length, sourceCoverage: {coveredSourceCount: coveredSelectedSourceIds.length,
          uncoveredSourceCount: uncoveredSelectedSourceIds.length, uncoveredSourceIds: uncoveredSelectedSourceIds},
        attachedItemCount: 0, usedChars: 0, candidateCount: 0, withheldCount: 0};
      if (!sourceIds.length || !budget.maxItems || !budget.maxChars || !budget.maxPerMaterial) return {
        materials: cloned,
        summary: {...summaryBase, status: 'uncovered', reason: !sourceIds.length ? 'no_selected_source_windows' : 'observation_budget_zero',
          limits: ['无可附加观察时保留原材料；未改变材料身份、正文或引用。']},
      };
      const observationResult = await api.query({contractVersion: NARRATIVE_OBSERVATION_QUERY_VERSION, query,
        fields: [...legacyFields], sourceIds, maxResults: 50});
      const attached = new Map(cloned.map(material => [material.id, []]));
      let usedChars = 0;
      const skipped = {outsideSelectedWindows: 0, perMaterialBudget: 0, totalItemBudget: 0, totalCharBudget: 0};
      for (const observation of observationResult.results) {
        const eligible = references.filter(({refs}) => refs.length
          && refs.every(ref => ref.sourceId !== observation.source.sourceId || sameObservationSource(observation.source, ref))
          && (() => { const matching = refs.filter(ref => sameObservationSource(observation.source, ref)); return matching.length && observation.quotes.every(quote => quoteInside(quote, matching)); })());
        if (!eligible.length) { skipped.outsideSelectedWindows++; continue; }
        const target = eligible.find(({material}) => attached.get(material.id).length < budget.maxPerMaterial);
        if (!target) { skipped.perMaterialBudget++; continue; }
        if ([...attached.values()].reduce((sum, items) => sum + items.length, 0) >= budget.maxItems) { skipped.totalItemBudget++; continue; }
        const matching = target.refs.filter(ref => sameObservationSource(observation.source, ref));
        const item = projectionItem(observation, target.material, matching);
        if (usedChars + item.chargedChars > budget.maxChars) { skipped.totalCharBudget++; continue; }
        attached.get(target.material.id).push(item); usedChars += item.chargedChars;
      }
      for (const material of cloned) {
        const items = attached.get(material.id);
        if (!items.length) continue;
        const limits = [
          '附加项是历史 AI 叙事观察，不是当前 checked analysis，也不是原文引文。',
          '只附在本次已选材料及其实际引用窗口内；供应、采用和正文作用须分别核验。',
          'item.limitations 使用固定边界码压缩重复文本；本 limits 是其人类可读解释。',
        ];
        const projection = {contractVersion: MATERIAL_NARRATIVE_OBSERVATION_VERSION, queryHash: observationResult.queryHash,
          usedChars: items.reduce((sum, item) => sum + item.chargedChars, 0), items, limits};
        projection.projectionSha256 = projectionHash(projectionPayload(projection));
        material.narrativeObservations = projection;
        validateMaterialNarrativeObservations(material);
      }
      const attachedItemCount = [...attached.values()].reduce((sum, items) => sum + items.length, 0);
      return {
        materials: cloned,
        summary: {...summaryBase, status: attachedItemCount ? (observationResult.status === 'partial' ? 'partial' : 'attached') : 'uncovered',
          queryHash: observationResult.queryHash, attachedItemCount, usedChars,
          candidateCount: observationResult.results.length, withheldCount: observationResult.counts.withheldCount, skipped,
          reason: attachedItemCount ? 'bounded_observations_attached'
            : coveredSelectedSourceIds.length ? 'no_observation_fully_bound_to_selected_windows' : 'selected_sources_outside_observation_scope',
          limits: [
            '观察只按当前问题相关性排序，并受独立条数、逐材料及字符预算限制；未批量注入全部旧观察。',
            '观察服务不可替代原材料适用性筛选，附加数量不代表文学质量提升。',
          ]},
      };
    },
  };
  return Object.freeze(api);
}
