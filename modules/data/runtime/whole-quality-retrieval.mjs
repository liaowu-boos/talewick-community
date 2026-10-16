import {createHash} from 'node:crypto';
import {NARRATIVE_OBSERVATION_QUERY_VERSION,validateMaterialNarrativeObservations} from './narrative-observations.mjs';
import {validateRelevanceReview} from './relevance.mjs';
import {normalizeRecall} from './retrieval.mjs';

export const WHOLE_QUALITY_RETRIEVAL_VERSION = 'whole-quality-retrieval-1';
export const WHOLE_QUALITY_EVIDENCE_VERSION = 'whole-quality-evidence-bundle-1';
export const WHOLE_QUALITY_MATERIAL_USE_VERSION = 'whole-quality-material-use-1';
export const WHOLE_QUALITY_OBSERVATION_RECALL_VERSION = 'whole-quality-observation-recall-1';
export const WHOLE_QUALITY_APPLICABILITY_VERSION = 'whole-quality-applicability-1';
export const WHOLE_QUALITY_FINAL_TEXT_EVIDENCE_VERSION = 'whole-quality-final-text-evidence-1';
export const WHOLE_QUALITY_C06_REFERENCES_VERSION = 'whole-quality-c06-references-1';
export const WHOLE_QUALITY_RETRIEVAL_LIMITS = Object.freeze({maxCandidates:20,maxUnits:6,maxChars:12000});

const CONTRACT_VERSION = 'v04-contract-1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value, max = Infinity) => typeof value === 'string' && value.trim().length > 0 && value === value.trim() && value.length <= max && !value.includes('\0');
// Retrieved prose is byte-bound content rather than an identifier. Exact source
// windows may end on a newline or an indented blank line, and trimming them
// would invalidate both the content digest and the source projection.
const boundedContent = (value, max = Infinity) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
const strings = (value, {min = 0, max = Infinity, itemMax = Infinity} = {}) => Array.isArray(value) && value.length >= min && value.length <= max
  && value.every(item => nonempty(item, itemMax));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uniqueStrings = (value, {min = 0, max = Infinity, itemMax = Infinity} = {}) => Array.isArray(value) && value.length >= min && value.length <= max
  && strings(value, {min,max,itemMax}) && new Set(value).size === value.length;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  : Array.isArray(value) ? value.map(canonical) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const fail = message => { throw new TypeError(`Whole-quality retrieval: ${message}`); };
const check = (condition, message) => { if (!condition) fail(message); };
const copy = value => structuredClone(value);
const abort = signal => {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Task cancelled', 'AbortError');
};

function inspectIssue(issue) {
  check(object(issue), 'issue must be an object');
  const {issueId, question, storyProblem, expectedEffect, failureCriterion, counterConsideration} = issue;
  check(nonempty(issueId, 160), 'issueId must be nonempty and at most 160 characters');
  check(nonempty(question, 4000), 'question must be nonempty and at most 4000 characters');
  check(nonempty(storyProblem, 2000), 'storyProblem must be nonempty and at most 2000 characters');
  check(nonempty(expectedEffect, 2000), 'expectedEffect must be nonempty and at most 2000 characters');
  check(nonempty(failureCriterion, 2000), 'failureCriterion must be nonempty and at most 2000 characters');
  check(nonempty(counterConsideration, 2000), 'counterConsideration must be nonempty and at most 2000 characters');
  const sceneQueries = issue.sceneQueries ?? [];
  check(uniqueStrings(sceneQueries, {max:3,itemMax:4000}), 'sceneQueries must contain at most three unique trimmed strings of at most 4000 characters');
  if (issue.sourceIds !== undefined) check(uniqueStrings(issue.sourceIds, {max:100,itemMax:160}), 'sourceIds must contain at most 100 unique nonempty identifiers');
  return {issueId, question, storyProblem, expectedEffect, failureCriterion, counterConsideration,
    sceneQueries:[...sceneQueries],...(issue.sourceIds === undefined ? {} : {sourceIds:[...issue.sourceIds]})};
}

function inspectBudget(value = WHOLE_QUALITY_RETRIEVAL_LIMITS) {
  check(object(value), 'budget must be an object');
  const budget = {};
  for (const key of ['maxCandidates','maxUnits','maxChars']) {
    const number = value[key] ?? WHOLE_QUALITY_RETRIEVAL_LIMITS[key];
    check(Number.isSafeInteger(number) && number >= 0 && number <= WHOLE_QUALITY_RETRIEVAL_LIMITS[key], `${key} exceeds the production retrieval limit`);
    budget[key] = number;
  }
  return budget;
}

/** Build one existing v04 query per quality issue. Scene recall asks the current
 * retrieval runtime for its bounded adjacent-context opportunity; it does not
 * certify that a returned window answers the question.
 */
export function buildWholeQualityQuery(issue, {budget} = {}) {
  const checked = inspectIssue(issue), bounded = inspectBudget(budget);
  const shortQueries = checked.sceneQueries.filter(query => query.length <= 120);
  const fullQueries = checked.sceneQueries.filter(query => query.length > 120);
  const context = JSON.stringify({
    referenceNeed:{question:checked.question,evidenceBoundary:'来源须用自身可见文本回答；每个连续行窗仍须单独判断适用性，不能用命中替代证据。'},
    targetUse:{storyProblem:checked.storyProblem,expectedEffect:checked.expectedEffect,failureCriterion:checked.failureCriterion,
      counterConsideration:checked.counterConsideration,conditions:'只借鉴有逐字依据的组织方式；不得移植来源人物、关系或连续情节，也不得把原文参考包装为已复核分析。'},
  });
  check(context.length <= 8000, 'serialized issue context exceeds 8000 characters');
  return {contractVersion:CONTRACT_VERSION,evidenceType:'narrative',query:checked.question,stage:'revision',context,
    budget:bounded,recall:{focus:'scene',queries:shortQueries,...(fullQueries.length?{fullQueries}: {})},...(checked.sourceIds === undefined ? {} : {sourceIds:checked.sourceIds})};
}

function observationQuoteSeed(result, quote) {
  const source = result?.source, current = result?.currentReviewState;
  check(object(source) && nonempty(source.sourceId,160) && sha(source.sourceSha256) && nonempty(source.textVersion,240), 'observation source binding is invalid');
  check(object(current) && nonempty(current.analysisVersion,240), 'observation analysis version is missing');
  if (result.recordType === 'checked_analysis_unit') check(nonempty(current.reviewRecordId,240), 'checked observation review binding is missing');
  check(object(quote) && boundedContent(quote.quote,2000) && Number.isSafeInteger(quote.lineStart) && Number.isSafeInteger(quote.lineEnd)
    && quote.lineStart >= 1 && quote.lineEnd >= quote.lineStart && Number.isSafeInteger(quote.lineWindowUtf16Start)
    && Number.isSafeInteger(quote.lineWindowUtf16End) && quote.lineWindowUtf16Start >= 0 && quote.lineWindowUtf16End >= quote.lineWindowUtf16Start
    && sha(quote.lineWindowBodySha256), 'observation quote binding is invalid');
  const quoteUtf16Start = quote.matchedCueUtf16Start ?? quote.matchedQuoteUtf16Start;
  const quoteUtf16End = quote.matchedCueUtf16End ?? quote.matchedQuoteUtf16End;
  check(Number.isSafeInteger(quoteUtf16Start) && Number.isSafeInteger(quoteUtf16End)
    && quoteUtf16Start >= quote.lineWindowUtf16Start && quoteUtf16End <= quote.lineWindowUtf16End
    && quoteUtf16End - quoteUtf16Start === quote.quote.length, 'observation quote UTF-16 binding is invalid');
  const stable = {observationId:result.id,recordType:result.recordType,sourceId:source.sourceId,sourceSha256:source.sourceSha256,
    textVersion:source.textVersion,analysisVersion:current.analysisVersion,lineStart:quote.lineStart,lineEnd:quote.lineEnd,
    lineWindowBodySha256:quote.lineWindowBodySha256,quote:quote.quote,quoteUtf16Start,quoteUtf16End};
  return {seedId:`observation-${hash(JSON.stringify(stable)).slice(0,24)}`,observationId:result.id,recordType:result.recordType,
    sourceId:source.sourceId,sourceSha256:source.sourceSha256,textVersion:source.textVersion,analysisVersion:current.analysisVersion,
    lineStart:quote.lineStart,lineEnd:quote.lineEnd,lineWindowUtf16Start:quote.lineWindowUtf16Start,lineWindowUtf16End:quote.lineWindowUtf16End,
    lineWindowBodySha256:quote.lineWindowBodySha256,quote:quote.quote,quoteUtf16Start,quoteUtf16End,quoteSha256:hash(quote.quote),
    ...(result.recordType==='checked_analysis_unit'?{reviewRecordId:current.reviewRecordId}: {})};
}

/** Convert the read-only observation service result into exact source-window
 * recall seeds. The seeds add candidate opportunities only; they are not supply
 * and carry no applicability decision.
 */
export function buildWholeQualityObservationRecall(issue, observationResult, {maxSeeds=8} = {}) {
  const checked = inspectIssue(issue);
  check(Number.isSafeInteger(maxSeeds) && maxSeeds >= 0 && maxSeeds <= 20, 'maxSeeds must be between zero and twenty');
  check(object(observationResult) && observationResult.contractVersion === NARRATIVE_OBSERVATION_QUERY_VERSION
    && sha(observationResult.queryHash) && ['covered','partial','uncovered'].includes(observationResult.status)
    && object(observationResult.request) && observationResult.request.query === checked.question && Array.isArray(observationResult.results),
  'observation result is not bound to the exact issue question');
  const available = [];
  for (const result of observationResult.results) {
    check(object(result) && nonempty(result.id,240) && ['legacy_card_observation','checked_analysis_unit'].includes(result.recordType)
      && Array.isArray(result.quotes), 'observation result item is invalid');
    for (const quote of result.quotes) available.push({...observationQuoteSeed(result,quote),observationQueryHash:observationResult.queryHash});
  }
  const bySource = new Map();
  for (const seed of available) if (!bySource.has(seed.sourceId)) bySource.set(seed.sourceId,seed);
  const selected = [...bySource.values()];
  for (const seed of available) if (!selected.includes(seed)) selected.push(seed);
  const seeds = selected.slice(0,maxSeeds);
  return {schemaVersion:WHOLE_QUALITY_OBSERVATION_RECALL_VERSION,issueId:checked.issueId,observationQueryHash:observationResult.queryHash,
    observationStatus:observationResult.status,availableSeedCount:available.length,seeds,sourceIds:[...new Set(seeds.map(seed=>seed.sourceId))],
    boundary:'叙事观察只提供绑定当前原文版本的候选入口；不自动供应、不继承旧分析的文学判断，仍须经过当前问题的功能适用筛选。'};
}

export function addWholeQualityObservationRecall(query, recall) {
  check(object(query) && query.contractVersion === CONTRACT_VERSION && object(query.recall) && query.recall.focus === 'scene', 'whole-quality query is invalid');
  check(object(recall) && recall.schemaVersion === WHOLE_QUALITY_OBSERVATION_RECALL_VERSION && Array.isArray(recall.seeds), 'observation recall artifact is invalid');
  const next = copy(query);
  next.recall.observationSeeds = copy(recall.seeds);
  next.recall = normalizeRecall(next.recall);
  return next;
}

/** Query reviewed observations first, then make exactly one normal retrieval
 * call whose candidate ranking may include their exact source windows.
 */
export async function retrieveWholeQualityEvidenceWithObservationRecall({issue,retrieveKnowledge,queryNarrativeObservations,signal,budget,maxObservationSeeds} = {}) {
  const checked = inspectIssue(issue);
  check(typeof retrieveKnowledge === 'function' && typeof queryNarrativeObservations === 'function', 'retrieval and observation callbacks are required');
  abort(signal);
  const observationResult = await queryNarrativeObservations({contractVersion:NARRATIVE_OBSERVATION_QUERY_VERSION,query:checked.question,maxResults:20},{signal});
  abort(signal);
  const observationRecall = buildWholeQualityObservationRecall(checked,observationResult,{maxSeeds:maxObservationSeeds??8});
  const query = addWholeQualityObservationRecall(buildWholeQualityQuery(checked,{budget}),observationRecall);
  const response = await retrieveKnowledge(copy(query),{signal});
  abort(signal);
  const packet = validateWholeQualityRetrievalPacket(response,query);
  return {schemaVersion:WHOLE_QUALITY_RETRIEVAL_VERSION,issueId:checked.issueId,query,packet,
    evidenceBundle:buildEvidenceBundle(checked.issueId,query,packet),observationRecall};
}

function resolvedScope(result, query) {
  if (query.sourceIds === undefined) {
    check(result.sourceResolutions === undefined, 'unscoped response must omit sourceResolutions');
    return null;
  }
  const requested = new Set(query.sourceIds), scope = new Map();
  if (result.sourceResolutions === undefined) return new Map([...requested].map(id => [id, null]));
  check(Array.isArray(result.sourceResolutions) && result.sourceResolutions.length === requested.size, 'sourceResolutions must cover every requested source exactly once');
  const seen = new Set();
  for (const item of result.sourceResolutions) {
    check(object(item) && nonempty(item.requestedSourceId, 160) && requested.has(item.requestedSourceId) && !seen.has(item.requestedSourceId), 'source resolution request identity is invalid');
    seen.add(item.requestedSourceId);
    if (item.canonicalSourceId === null && item.textVersion === null && item.sourceSha256 === null) continue;
    check(nonempty(item.canonicalSourceId, 160) && nonempty(item.textVersion, 240) && sha(item.sourceSha256), 'resolved source must bind canonical identity, text version and SHA');
    const binding = {textVersion:item.textVersion,sourceSha256:item.sourceSha256};
    check(!scope.has(item.canonicalSourceId) || same(scope.get(item.canonicalSourceId), binding), 'canonical source resolution conflicts');
    scope.set(item.canonicalSourceId, binding);
  }
  return scope;
}

function inspectReference(reference, material, scope) {
  check(object(reference) && nonempty(reference.sourceId, 160) && sha(reference.sourceSha256)
    && nonempty(reference.textVersion, 240) && nonempty(reference.analysisVersion, 240)
    && Number.isSafeInteger(reference.lineStart) && Number.isSafeInteger(reference.lineEnd)
    && reference.lineStart >= 1 && reference.lineEnd >= reference.lineStart
    && uniqueStrings(reference.unitIds, {itemMax:160}), 'material reference is invalid');
  if (scope !== null) {
    check(scope.has(reference.sourceId), 'material reference is outside requested source scope');
    const bound = scope.get(reference.sourceId);
    if (bound !== null) check(same(bound, {textVersion:reference.textVersion,sourceSha256:reference.sourceSha256}), 'material reference conflicts with source resolution');
  }
  if (material.use === 'reviewed_analysis') check(reference.unitIds.length > 0 && nonempty(reference.reviewRecordId, 240), 'reviewed analysis requires units and reviewRecordId');
  else check(reference.reviewRecordId === undefined, 'raw reference cannot carry reviewRecordId');
  return copy(reference);
}

function unitKey(material, reference, unitId) {
  return material.use === 'raw_reference'
    ? JSON.stringify([reference.sourceSha256,reference.textVersion,'raw-range',reference.lineStart,reference.lineEnd])
    : JSON.stringify([reference.sourceId,reference.textVersion,reference.analysisVersion,unitId]);
}

/** Strictly validate the existing production callback response without changing
 * candidate ranking, relevance decisions, material bytes or provenance.
 */
export function validateWholeQualityRetrievalPacket(result, query) {
  check(object(result) && result.contractVersion === CONTRACT_VERSION && nonempty(result.packetId, 240), 'response version or packetId is invalid');
  check(same(result.query, query), 'response is not bound to the exact query');
  check(['matched','uncovered','unavailable'].includes(result.status), 'response status is invalid');
  check(Array.isArray(result.materials) && Array.isArray(result.candidates) && strings(result.limits, {itemMax:4000}), 'response arrays are invalid');
  check(result.materials.length <= query.budget.maxUnits && result.candidates.length <= query.budget.maxCandidates, 'response exceeds item or candidate budget');
  check(result.status === 'matched' ? result.materials.length > 0 : result.materials.length === 0, 'response status conflicts with material count');
  validateRelevanceReview(result.relevanceReview, {status:result.status,candidateCount:result.candidates.length,maxCandidates:query.budget.maxCandidates,materialCount:result.materials.length});
  const scope = resolvedScope(result, query), materialIds = new Set(), units = new Set(), ranges = new Set();
  for (const material of result.materials) {
    check(object(material) && nonempty(material.id, 240) && !materialIds.has(material.id) && nonempty(material.title, 1000)
      && material.kind === 'retrieved' && ['raw_reference','reviewed_analysis'].includes(material.use)
      && boundedContent(material.content, 12000) && sha(material.sha256) && hash(material.content) === material.sha256
      && nonempty(material.selectionReason, 4000) && strings(material.limitations, {itemMax:4000})
      && Array.isArray(material.references) && material.references.length > 0, 'material shape, content or identity is invalid');
    materialIds.add(material.id);
    validateMaterialNarrativeObservations(material);
    for (const reference of material.references) {
      inspectReference(reference, material, scope);
      const range = JSON.stringify([reference.sourceSha256,reference.textVersion,reference.lineStart,reference.lineEnd]);
      check(!ranges.has(range) || material.use !== 'raw_reference', 'raw continuous range is duplicated');
      if (material.use === 'raw_reference') ranges.add(range);
      if (material.use === 'raw_reference') units.add(unitKey(material, reference));
      else for (const unitId of reference.unitIds) units.add(unitKey(material, reference, unitId));
    }
  }
  const candidateIds = new Set();
  for (const candidate of result.candidates) {
    check(object(candidate) && nonempty(candidate.id, 240) && !candidateIds.has(candidate.id)
      && nonempty(candidate.sourceId, 160) && nonempty(candidate.reason, 4000), 'candidate identity or reason is invalid');
    candidateIds.add(candidate.id);
  }
  const usedChars = result.materials.reduce((sum, material) => sum + material.content.length, 0);
  check(Number.isSafeInteger(result.usedChars) && result.usedChars === usedChars && usedChars <= query.budget.maxChars, 'usedChars or character budget is invalid');
  check(units.size <= query.budget.maxUnits, 'response exceeds unit budget');
  return copy(result);
}

function evidenceId(material, reference) {
  return `evidence-${hash(JSON.stringify({materialId:material.id,materialSha256:material.sha256,use:material.use,sourceId:reference.sourceId,
    sourceSha256:reference.sourceSha256,textVersion:reference.textVersion,analysisVersion:reference.analysisVersion,
    lineStart:reference.lineStart,lineEnd:reference.lineEnd,unitIds:reference.unitIds,reviewRecordId:reference.reviewRecordId??null})).slice(0,24)}`;
}

function buildEvidenceBundle(issueId, query, packet) {
  return {schemaVersion:WHOLE_QUALITY_EVIDENCE_VERSION,issueId,querySha256:hash(JSON.stringify(query)),retrievalPacketId:packet.packetId,
    retrievalStatus:packet.status,materials:packet.materials.map(material=>({materialId:material.id,title:material.title,use:material.use,
      contentSha256:material.sha256,reviewBoundary:material.use==='reviewed_analysis'?'source_bound_reviewed_analysis':'unreviewed_raw_reference',
      selectionReason:material.selectionReason,limitations:copy(material.limitations),evidence:material.references.map(reference=>({
        evidenceId:evidenceId(material,reference),continuity:'single_contiguous_line_range',sourceId:reference.sourceId,
        sourceSha256:reference.sourceSha256,textVersion:reference.textVersion,analysisVersion:reference.analysisVersion,
        lineStart:reference.lineStart,lineEnd:reference.lineEnd,unitIds:copy(reference.unitIds),
        ...(reference.reviewRecordId===undefined?{}:{reviewRecordId:reference.reviewRecordId})}))})),
    limits:[...packet.limits,'每个 evidence 只证明单一连续行号范围及其来源绑定；多个 evidence 不自动构成连续场景、因果链或质量提升。']};
}

export function assertWholeQualityEvidenceBundle(bundle, packet, issueId) {
  check(nonempty(issueId,160), 'issueId is required to validate evidence bundle');
  const expected = buildEvidenceBundle(issueId, packet.query, packet);
  check(same(bundle, expected), 'evidence bundle does not match the retrieval packet');
  return copy(bundle);
}

/** Call the injected production-compatible callback exactly once for one issue. */
export async function retrieveWholeQualityEvidence({issue,retrieveKnowledge,signal,budget} = {}) {
  const checked = inspectIssue(issue);
  check(typeof retrieveKnowledge === 'function', 'retrieveKnowledge callback is required');
  const query = buildWholeQualityQuery(checked,{budget});
  abort(signal);
  const response = await retrieveKnowledge(copy(query),{signal});
  abort(signal);
  const packet = validateWholeQualityRetrievalPacket(response,query);
  const evidenceBundle = buildEvidenceBundle(checked.issueId,query,packet);
  return {schemaVersion:WHOLE_QUALITY_RETRIEVAL_VERSION,issueId:checked.issueId,query,packet,evidenceBundle};
}

function inspectUseDecision(value, materials) {
  check(object(value) && nonempty(value.materialId,240) && materials.has(value.materialId), 'material-use decision references an unknown material');
  check(['used','not_used'].includes(value.decision) && nonempty(value.reason,2000), 'material-use decision or reason is invalid');
  check(uniqueStrings(value.evidenceIds ?? [], {itemMax:240}), 'material-use evidenceIds are invalid');
  check(uniqueStrings(value.changeGroupIds ?? [], {itemMax:160}), 'material-use changeGroupIds are invalid');
  const material = materials.get(value.materialId), known = new Map(material.evidence.map(item=>[item.evidenceId,item]));
  check((value.evidenceIds??[]).every(id=>known.has(id)), 'material-use decision references unknown evidence');
  if (value.decision === 'used') {
    check(value.evidenceIds.length > 0 && value.changeGroupIds.length > 0 && nonempty(value.appliedAs,2000), 'used material requires evidenceIds, changeGroupIds and appliedAs');
  } else check((value.changeGroupIds??[]).length === 0 && value.appliedAs === undefined, 'not_used material cannot claim application or change groups');
  return {...copy(value),evidenceIds:[...(value.evidenceIds??[])],changeGroupIds:[...(value.changeGroupIds??[])],
    sourceBindings:[...new Map((value.evidenceIds??[]).map(id=>known.get(id)).map(item=>[JSON.stringify([item.sourceId,item.sourceSha256,item.textVersion]),
      {sourceId:item.sourceId,sourceSha256:item.sourceSha256,textVersion:item.textVersion}])).values()],verificationStatus:'author_declared_not_text_verified'};
}

/** Keep supply and declared use separate. Every supplied material needs an
 * explicit decision. A used declaration binds exact evidence and change groups,
 * but does not claim the resulting prose achieved its intended effect.
 */
export function buildWholeQualityMaterialUseLedger(retrieval, decisions) {
  check(object(retrieval) && retrieval.schemaVersion === WHOLE_QUALITY_RETRIEVAL_VERSION && object(retrieval.evidenceBundle), 'retrieval result is invalid');
  assertWholeQualityEvidenceBundle(retrieval.evidenceBundle,retrieval.packet,retrieval.issueId);
  check(Array.isArray(decisions), 'material-use decisions must be an array');
  const materials = new Map(retrieval.evidenceBundle.materials.map(item=>[item.materialId,item]));
  check(decisions.length === materials.size, 'every supplied material requires exactly one used or not_used decision');
  const seen = new Set(), checked = decisions.map(decision=>{
    check(!seen.has(decision?.materialId), 'material-use decision is duplicated');seen.add(decision.materialId);
    return inspectUseDecision(decision,materials);
  });
  return {schemaVersion:WHOLE_QUALITY_MATERIAL_USE_VERSION,issueId:retrieval.issueId,retrievalPacketId:retrieval.packet.packetId,
    querySha256:retrieval.evidenceBundle.querySha256,suppliedMaterialIds:[...materials.keys()],decisions:checked,
    usedMaterialIds:checked.filter(item=>item.decision==='used').map(item=>item.materialId),
    notUsedMaterialIds:checked.filter(item=>item.decision==='not_used').map(item=>item.materialId),
    boundary:'材料供给与采用声明已分开；used 仅表示作者把所列证据绑定到修改组，尚未证明正文可辨作用、目标落实或文学质量提升。'};
}

/** Add a functional-fit decision after generic relevance review. This artifact
 * does not rewrite the retrieval packet: only direct_fit is eligible for a
 * planning supply; mechanism_only remains advisory evidence.
 */
export function buildWholeQualityApplicabilityReview(retrieval, assessments, {noSuitableReason} = {}) {
  check(object(retrieval) && retrieval.schemaVersion === WHOLE_QUALITY_RETRIEVAL_VERSION && object(retrieval.evidenceBundle), 'retrieval result is invalid');
  assertWholeQualityEvidenceBundle(retrieval.evidenceBundle,retrieval.packet,retrieval.issueId);
  check(Array.isArray(assessments), 'applicability assessments must be an array');
  const materials = new Map(retrieval.evidenceBundle.materials.map(material=>[material.materialId,material]));
  check(assessments.length === materials.size, 'applicability review must cover every supplied material');
  const seen = new Set(), fits = new Set(['direct_fit','mechanism_only','inapplicable','insufficient_context']);
  const checked = assessments.map(assessment=>{
    check(object(assessment) && Object.keys(assessment).every(key=>['materialId','fit','reason','evidenceIds','transferBoundary'].includes(key))
      && nonempty(assessment.materialId,240) && materials.has(assessment.materialId) && !seen.has(assessment.materialId)
      && fits.has(assessment.fit) && nonempty(assessment.reason,2000), 'applicability assessment is invalid');
    seen.add(assessment.materialId);
    const material = materials.get(assessment.materialId), evidence = new Set(material.evidence.map(item=>item.evidenceId));
    check(uniqueStrings(assessment.evidenceIds??[],{itemMax:240}) && (assessment.evidenceIds??[]).every(id=>evidence.has(id)), 'applicability evidence is invalid');
    if (assessment.fit === 'direct_fit') check((assessment.evidenceIds??[]).length > 0 && nonempty(assessment.transferBoundary,2000), 'direct fit requires evidence and transfer boundary');
    if (assessment.fit === 'mechanism_only') check(nonempty(assessment.transferBoundary,2000), 'mechanism-only fit requires transfer boundary');
    return {...copy(assessment),evidenceIds:[...(assessment.evidenceIds??[])]};
  });
  const directMaterialIds = checked.filter(item=>item.fit==='direct_fit').map(item=>item.materialId);
  const mechanismOnlyMaterialIds = checked.filter(item=>item.fit==='mechanism_only').map(item=>item.materialId);
  const noSuitableMaterial = directMaterialIds.length === 0;
  check(noSuitableMaterial ? nonempty(noSuitableReason,2000) : noSuitableReason === undefined, 'noSuitableReason must be explicit only when no direct material exists');
  return {schemaVersion:WHOLE_QUALITY_APPLICABILITY_VERSION,issueId:retrieval.issueId,retrievalPacketId:retrieval.packet.packetId,
    querySha256:retrieval.evidenceBundle.querySha256,assessments:checked,directMaterialIds,mechanismOnlyMaterialIds,
    rejectedMaterialIds:checked.filter(item=>['inapplicable','insufficient_context'].includes(item.fit)).map(item=>item.materialId),
    noSuitableMaterial,...(noSuitableMaterial?{noSuitableReason}:{}),
    boundary:'direct_fit 只表示当前问题、叙事功能与迁移边界有逐字依据；mechanism_only 不得冒充直接适配，任何分类均不证明采用后的文学效果。'};
}

function inspectFinalChapters(chapters) {
  check(Array.isArray(chapters) && chapters.length > 0 && chapters.length <= 100, 'final chapters are invalid');
  const seen = new Set();
  return chapters.map(chapter=>{
    check(object(chapter) && nonempty(chapter.id,160) && !seen.has(chapter.id) && typeof chapter.body === 'string' && chapter.body.trim().length > 0
      && !chapter.body.includes('\0'), 'final chapter is invalid');
    seen.add(chapter.id);
    return {id:chapter.id,...(typeof chapter.title==='string'?{title:chapter.title}:{}),body:chapter.body,bodySha256:hash(chapter.body)};
  });
}

/** Verify exact UTF-16 locations in the final manuscript. Presence proves only
 * that the declared textual trace exists, never that it caused or improved a
 * literary effect.
 */
export function buildWholeQualityFinalTextUseEvidence({materialUseLedger,chapters,records} = {}) {
  check(object(materialUseLedger) && materialUseLedger.schemaVersion === WHOLE_QUALITY_MATERIAL_USE_VERSION
    && Array.isArray(materialUseLedger.decisions) && Array.isArray(materialUseLedger.usedMaterialIds), 'material use ledger is invalid');
  const finalChapters = inspectFinalChapters(chapters), byChapter = new Map(finalChapters.map(chapter=>[chapter.id,chapter]));
  check(Array.isArray(records), 'final text evidence records must be an array');
  const used = new Map(materialUseLedger.decisions.filter(decision=>decision.decision==='used').map(decision=>[decision.materialId,decision]));
  check(records.length === used.size, 'final text evidence must cover every used material');
  const seen = new Set(), checkedRecords = records.map(record=>{
    check(object(record) && Object.keys(record).every(key=>['materialId','status','findings','reason'].includes(key))
      && nonempty(record.materialId,240) && used.has(record.materialId) && !seen.has(record.materialId)
      && ['located','not_located'].includes(record.status) && Array.isArray(record.findings), 'final text evidence record is invalid');
    seen.add(record.materialId); const decision = used.get(record.materialId);
    if (record.status === 'not_located') {
      check(record.findings.length===0 && nonempty(record.reason,2000), 'not-located record requires an explicit reason and no findings');
      return {materialId:record.materialId,status:record.status,findings:[],reason:record.reason,verificationStatus:'no_exact_text_evidence'};
    }
    check(record.findings.length>0 && record.reason===undefined, 'located record requires findings and no fallback reason');
    const findings = record.findings.map(finding=>{
      check(object(finding) && Object.keys(finding).every(key=>['chapterId','start','quote','changeGroupId','sourceEvidenceIds','textRole','explanation'].includes(key))
        && nonempty(finding.chapterId,160) && byChapter.has(finding.chapterId) && Number.isSafeInteger(finding.start)
        && boundedContent(finding.quote,2000) && nonempty(finding.changeGroupId,160) && decision.changeGroupIds.includes(finding.changeGroupId)
        && uniqueStrings(finding.sourceEvidenceIds??[],{min:1,itemMax:240}) && finding.sourceEvidenceIds.every(id=>decision.evidenceIds.includes(id))
        && nonempty(finding.explanation,2000) && ['visible_application','context_only'].includes(finding.textRole), 'final text finding is invalid');
      const chapter = byChapter.get(finding.chapterId), end = finding.start + finding.quote.length;
      check(finding.start>=0 && end<=chapter.body.length && chapter.body.slice(finding.start,end)===finding.quote, 'final text quote does not match exact UTF-16 location');
      return {...copy(finding),end,chapterBodySha256:chapter.bodySha256,quoteSha256:hash(finding.quote),verificationStatus:'exact_text_location_verified'};
    });
    return {materialId:record.materialId,status:record.status,findings,verificationStatus:'exact_text_location_verified'};
  });
  const manuscriptSha256 = hash(JSON.stringify(finalChapters.map(({bodySha256,...chapter})=>chapter)));
  return {schemaVersion:WHOLE_QUALITY_FINAL_TEXT_EVIDENCE_VERSION,issueId:materialUseLedger.issueId,
    retrievalPacketId:materialUseLedger.retrievalPacketId,manuscriptSha256,records:checkedRecords,
    locatedMaterialIds:checkedRecords.filter(record=>record.status==='located').map(record=>record.materialId),
    notLocatedMaterialIds:checkedRecords.filter(record=>record.status==='not_located').map(record=>record.materialId),
    allUsedMaterialsLocated:checkedRecords.every(record=>record.status==='located'),automaticEffectClaim:false,literaryEffect:'NOT_COMPUTED',
    boundary:'本记录只核验最终正文中存在逐字位置及其作者声明关联；不证明材料造成该文本，也不证明目标落实、读者效果或文学质量提升。'};
}

/** Build the finite reference packet that PRODUCT may pass to C06. It is
 * deliberately limited to declared-used materials plus optional explicit
 * packet candidates and never claims a whole-library comparison.
 */
export function buildWholeQualityC06ReferenceList({retrieval,materialUseLedger,includeMaterialIds=[],maxChars=12000} = {}) {
  check(object(retrieval) && retrieval.schemaVersion===WHOLE_QUALITY_RETRIEVAL_VERSION && object(retrieval.evidenceBundle), 'retrieval result is invalid');
  assertWholeQualityEvidenceBundle(retrieval.evidenceBundle,retrieval.packet,retrieval.issueId);
  check(object(materialUseLedger) && materialUseLedger.schemaVersion===WHOLE_QUALITY_MATERIAL_USE_VERSION
    && materialUseLedger.retrievalPacketId===retrieval.packet.packetId, 'material use ledger is not bound to retrieval');
  check(uniqueStrings(includeMaterialIds,{itemMax:240}) && Number.isSafeInteger(maxChars) && maxChars>=0 && maxChars<=12000, 'C06 reference selection is invalid');
  const packetMaterials = new Map(retrieval.packet.materials.map(material=>[material.id,material]));
  const ids = [...new Set([...materialUseLedger.usedMaterialIds,...includeMaterialIds])];
  check(ids.every(id=>packetMaterials.has(id)), 'C06 reference selection contains unknown material');
  const references = ids.map(materialId=>{
    const material = packetMaterials.get(materialId), used = materialUseLedger.usedMaterialIds.includes(materialId);
    return {materialId,title:material.title,useStatus:used?'declared_used':'explicit_bounded_candidate',scope:'fragment',content:material.content,
      contentSha256:material.sha256,references:copy(material.references),limitations:copy(material.limitations)};
  });
  const usedChars = references.reduce((sum,item)=>sum+item.content.length,0);
  check(usedChars<=maxChars, 'C06 reference list exceeds the explicit character budget');
  return {schemaVersion:WHOLE_QUALITY_C06_REFERENCES_VERSION,issueId:retrieval.issueId,retrievalPacketId:retrieval.packet.packetId,
    coverage:includeMaterialIds.length?'finite_explicit_material_set':'declared_used_materials_only',completeLibraryComparison:false,
    referenceCount:references.length,usedChars,maxChars,references,
    boundary:'C06 仅比较本清单中的固定片段与版本；没有读取或比较完整136份资料库，也不把相似性检查解释为文学质量判断。'};
}
