import { createHash } from 'node:crypto';
import { buildFinalTextMaterialEvidence } from './final-text-material-evidence.mjs';
import { DEEP_REFERENCE_QUERY_VERSION, DEEP_REFERENCE_LIMITS } from '../../../data/runtime/deep-reference-layer.mjs';

export const DEEP_REFERENCE_INTEGRATION_VERSION = 'creation-deep-reference-integration-1';
export const CREATE_FINAL_TEXT_EVIDENCE_STAGE_VERSION = 'creation-final-text-material-evidence-stage-1';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const manuscriptSha256 = chapters => createHash('sha256').update(JSON.stringify(chapters.map(({ id, title, body }) => ({ id, title, body })))).digest('hex');
const ensure = (condition, message) => { if (!condition) throw new Error(`深层参考集成无效：${message}`); };
const text = (value, max = 2000) => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max;
const exactText = (value, max = 2000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
const clone = value => structuredClone(value);

export function resolveDeepReferenceCallback(queryDeepReferences, retrieveKnowledge) {
  ensure(queryDeepReferences === undefined || typeof queryDeepReferences === 'function', 'queryDeepReferences 必须是函数');
  ensure(retrieveKnowledge === undefined || typeof retrieveKnowledge === 'function', 'retrieveKnowledge 必须是函数');
  if (!queryDeepReferences || !retrieveKnowledge) return queryDeepReferences ?? retrieveKnowledge;
  return async (query, options = {}) => {
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => queryDeepReferences(clone(query), options)),
      Promise.resolve().then(() => retrieveKnowledge(clone(query), options)),
    ]);
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new DOMException('Task cancelled', 'AbortError');
    for (const item of settled) if (item.status === 'rejected'
      && (item.reason?.name === 'AbortError' || ['ABORT_ERR','CANCELLED','cancelled'].includes(item.reason?.code))) throw item.reason;
    const packet = (item, source) => item.status === 'fulfilled' ? item.value : {
      contractVersion: 'v04-contract-1', packetId: `${source}-unavailable-${fingerprint(query).slice(0,24)}`, query: clone(query),
      status: 'unavailable', materials: [], candidates: [], usedChars: 0,
      limits: [`${source === 'deep' ? '深层参考' : '既有资料库'}查询不可用；失败不表示没有相关材料。`],
      ...(source === 'deep' ? { deepReference: { contractVersion: DEEP_REFERENCE_INTEGRATION_VERSION,
        path: 'composed', problem: null, dataRequest: null, response: null,
        error: { code: 'DEEP_REFERENCE_UNAVAILABLE', message: '查询失败或合同不兼容。' } } } : {}),
    };
    return composeRetrievalPackets(query, packet(settled[0], 'deep'), packet(settled[1], 'legacy'));
  };
}

function unitKeys(material) {
  const keys = [];
  for (const reference of material?.references ?? []) {
    if (material.use === 'raw_reference') keys.push(JSON.stringify([reference.sourceSha256, reference.textVersion, 'raw-range', reference.lineStart, reference.lineEnd]));
    else for (const unitId of reference.unitIds ?? []) keys.push(JSON.stringify([reference.sourceId, reference.textVersion, reference.analysisVersion, unitId]));
  }
  return [...new Set(keys)];
}

function usablePacket(packet, query) {
  return object(packet) && packet.contractVersion === 'v04-contract-1' && object(packet.query)
    && JSON.stringify(canonical(packet.query)) === JSON.stringify(canonical(query))
    && ['matched','uncovered','unavailable'].includes(packet.status) && Array.isArray(packet.materials)
    && Array.isArray(packet.candidates) && Array.isArray(packet.limits);
}

function invalidPacket(source, query, deepReference) {
  return { contractVersion: 'v04-contract-1', packetId: `${source}-invalid-${fingerprint(query).slice(0,24)}`, query: clone(query),
    status: 'unavailable', materials: [], candidates: [], usedChars: 0,
    limits: [`${source === 'deep' ? '深层参考' : '既有资料库'}返回合同不兼容；该侧失败未被当作未命中。`],
    ...(source === 'deep' ? { deepReference: deepReference ?? { contractVersion: DEEP_REFERENCE_INTEGRATION_VERSION,
      path: 'composed', problem: null, dataRequest: null, response: null,
      error: { code: 'DEEP_REFERENCE_UNAVAILABLE', message: '查询失败或合同不兼容。' } } } : {}) };
}

export function composeRetrievalPackets(query, deepPacket, legacyPacket) {
  const deep = usablePacket(deepPacket, query) ? clone(deepPacket) : invalidPacket('deep', query, deepPacket?.deepReference);
  const legacy = usablePacket(legacyPacket, query) ? clone(legacyPacket) : invalidPacket('legacy', query);
  const budget = query.budget, selected = [], selectedIds = new Map(), selectedUnits = new Set(), limits = [];
  let usedChars = 0;
  const canAdd = material => {
    const units = unitKeys(material).filter(key => !selectedUnits.has(key));
    return selected.length < budget.maxUnits && selectedUnits.size + units.length <= budget.maxUnits
      && usedChars + material.content.length <= budget.maxChars;
  };
  const add = (material, source) => {
    const prior = selectedIds.get(material.id);
    if (prior) {
      if (prior.sha256 !== material.sha256) limits.push(`材料身份 ${material.id} 在深层参考与既有资料供应中哈希冲突；保留先进入的完整材料，未合并冲突字节。`);
      return false;
    }
    if (!canAdd(material)) return false;
    selected.push(clone(material)); selectedIds.set(material.id, { sha256: material.sha256, source });
    unitKeys(material).forEach(key => selectedUnits.add(key)); usedChars += material.content.length; return true;
  };
  const deepMaterials = deep.status === 'matched' ? deep.materials : [], legacyMaterials = legacy.status === 'matched' ? legacy.materials : [];
  const paired = { deep: new Set(), legacy: new Set() };
  if (deepMaterials.length && legacyMaterials.length) {
    outer: for (let legacyIndex = 0; legacyIndex < legacyMaterials.length; legacyIndex += 1) {
      for (let deepIndex = 0; deepIndex < deepMaterials.length; deepIndex += 1) {
        const before = { selected: selected.length, chars: usedChars, units: new Set(selectedUnits), ids: new Map(selectedIds) };
        if (add(legacyMaterials[legacyIndex], 'legacy') && add(deepMaterials[deepIndex], 'deep')) {
          paired.legacy.add(legacyIndex); paired.deep.add(deepIndex); break outer;
        }
        selected.splice(before.selected); usedChars = before.chars; selectedUnits.clear(); before.units.forEach(key => selectedUnits.add(key));
        selectedIds.clear(); before.ids.forEach((value, key) => selectedIds.set(key, value));
      }
    }
  }
  if (!selected.length && deepMaterials.length) { add(deepMaterials[0], 'deep'); paired.deep.add(0); }
  if (!selected.length && legacyMaterials.length) { add(legacyMaterials[0], 'legacy'); paired.legacy.add(0); }
  const maxLength = Math.max(deepMaterials.length, legacyMaterials.length);
  for (let index = 0; index < maxLength; index += 1) {
    if (index < legacyMaterials.length && !paired.legacy.has(index)) add(legacyMaterials[index], 'legacy');
    if (index < deepMaterials.length && !paired.deep.has(index)) add(deepMaterials[index], 'deep');
  }
  if (deepMaterials.length && !selected.some(material => deepMaterials.some(item => item.id === material.id && item.sha256 === material.sha256)))
    limits.push('深层参考虽命中，但完整材料无法与既有资料供应同时装入六单元/12000字符预算；本轮未截断其跨场证据。');
  if (legacyMaterials.length && !selected.some(material => legacyMaterials.some(item => item.id === material.id && item.sha256 === material.sha256)))
    limits.push('既有资料库虽命中，但完整材料无法与深层参考供应同时装入六单元/12000字符预算；命中状态仍保留。');
  const candidates = [], candidateIds = new Set();
  for (const candidate of [...legacy.candidates, ...deep.candidates]) if (!candidateIds.has(candidate.id) && candidates.length < budget.maxCandidates) {
    candidates.push(clone(candidate)); candidateIds.add(candidate.id);
  }
  const status = selected.length ? 'matched' : deep.status === 'unavailable' || legacy.status === 'unavailable' ? 'unavailable' : 'uncovered';
  const composition = { policyVersion: 'creation-deep-plus-legacy-composition-1', deepStatus: deep.status, legacyStatus: legacy.status,
    deepPacketId: deep.packetId, legacyPacketId: legacy.packetId,
    selectedDeepMaterialIds: selected.filter(material => deepMaterials.some(item => item.id === material.id && item.sha256 === material.sha256)).map(item => item.id),
    selectedLegacyMaterialIds: selected.filter(material => legacyMaterials.some(item => item.id === material.id && item.sha256 === material.sha256)).map(item => item.id),
    boundary: '两侧完整材料按共同六单元/12000字符预算组合；不截断单份证据，不把任一侧失败改写为未命中。' };
  const deepReference = deep.deepReference ? { ...clone(deep.deepReference), composition } : { contractVersion: DEEP_REFERENCE_INTEGRATION_VERSION,
    path: 'composed', problem: null, dataRequest: null, response: null,
    error: { code: 'DEEP_REFERENCE_UNAVAILABLE', message: '深层参考没有可保留的查询元数据。' }, composition };
  return { contractVersion: 'v04-contract-1', packetId: `composed-${fingerprint({ query, composition, materials: selected.map(item => [item.id,item.sha256]) }).slice(0,32)}`,
    query: clone(query), status, materials: selected, candidates, usedChars,
    limits: [...new Set([...legacy.limits, ...deep.limits, ...limits, '既有资料与深层参考在同一生产查询中组合；完整 DATA 查询元数据保留在 deepReference。'])],
    deepReference };
}

function problemText(query) {
  const values = [query?.query];
  try {
    const context = JSON.parse(query?.context ?? '{}');
    const visit = value => {
      if (typeof value === 'string') values.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (object(value)) Object.values(value).forEach(visit);
    };
    visit(context);
  } catch { /* The production v04 validator owns malformed context rejection. */ }
  for (const value of query?.recall?.queries ?? []) values.push(value);
  return values.filter(value => typeof value === 'string' && value.trim()).join('\n').slice(0, 12000);
}

function problemSearchTerms(query) {
  const source = problemText(query), terms = [];
  const add = value => {
    const term = value.trim();
    if (term.length >= 2 && term.length <= 80 && !terms.includes(term)) terms.push(term);
  };
  for (const term of ['被需要','尊重','姐妹','母亲','误解','选择','后果','代价','犹豫','迟疑','心理变化','心理转折','触发','行动','技术说明','流程','冲突','留白','反复','歧义','回执','代签','责任','信任']) {
    if (source.includes(term)) add(term);
  }
  if (typeof Intl?.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    for (const item of segmenter.segment(source)) if (item.isWordLike) add(item.segment);
  }
  if (terms.length < 2) ['人物选择','心理变化'].forEach(add);
  return terms.slice(0, DEEP_REFERENCE_LIMITS.maxSearchTerms);
}

export function buildDeepReferenceProblem(query, { path = 'create' } = {}) {
  ensure(object(query) && query.contractVersion === 'v04-contract-1' && text(query.query, 2000), '生产查询缺少冻结问题');
  let parsed = {};
  try { parsed = JSON.parse(query.context ?? '{}'); } catch { /* validator reports the malformed production query */ }
  const target = parsed?.targetUse?.requirements ?? parsed;
  const boundaries = [
    ...(Array.isArray(target?.prohibitions) ? target.prohibitions : []),
    parsed?.targetUse?.conditions,
    parsed?.referenceNeed?.evidenceBoundary,
  ].filter(value => typeof value === 'string' && value.trim()).map(value => value.slice(0, 1000)).slice(0, 12);
  return { problemId: `creation-${path}-${fingerprint({ path, query }).slice(0, 24)}`, statement: query.query,
    searchTerms: problemSearchTerms(query), requiredTermGroups: [],
    context: { path, genre: target?.genre ?? '', perspective: target?.pointOfView ?? '', boundaries } };
}

function validateMatchingPolicy(policy, request, response) {
  const keys = ['version','positiveFields','excludedFields','ignoredSearchTerms','effectiveSearchTerms',
    'effectiveRequiredTermGroups','candidatePoolCount','positiveCandidateCount','noResultReason','boundary'];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ignored = new Set(['来源','自身','可见','逐字','检索','查询','命中','适用性','材料']);
  ensure(object(policy) && Object.keys(policy).length === keys.length && keys.every(key => Object.hasOwn(policy, key))
    && policy.version === 'analysis99-positive-function-fields-1'
    && same(policy.positiveFields, ['observablePattern','borrowableFunction'])
    && same(policy.excludedFields, ['alternatives','limitation','uncertainty','counterEvidenceOrGap','identifiers','context','reviewCaveats'])
    && same(policy.ignoredSearchTerms, request.problem.searchTerms.filter(term => ignored.has(term)))
    && same(policy.effectiveSearchTerms, request.problem.searchTerms.filter(term => !ignored.has(term)))
    && same(policy.effectiveRequiredTermGroups, request.problem.requiredTermGroups.map(group => group.filter(term => !ignored.has(term))))
    && Number.isSafeInteger(policy.candidatePoolCount) && policy.candidatePoolCount >= 0
    && Number.isSafeInteger(policy.positiveCandidateCount) && policy.positiveCandidateCount >= response.resultCount
    && policy.positiveCandidateCount <= policy.candidatePoolCount
    && (response.status === 'covered' ? policy.noResultReason === null
      : ['insufficient_positive_terms_or_required_group','no_eligible_positive_function_bundle'].includes(policy.noResultReason))
    && text(policy.boundary, 2000), 'DATA matchingPolicy 版本、字段或冻结检索词绑定无效');
}

function validateDataResponse(response, request) {
  const normalizedProblem = { ...clone(request.problem),
    searchTerms: [...new Set(request.problem.searchTerms.map(term => String(term).trim()).filter(Boolean))],
    requiredTermGroups: (request.problem.requiredTermGroups ?? []).map(group => [...new Set(group)]) };
  const expectedRequest = { problem: normalizedProblem, dimensions: clone(request.dimensions), sourceIds: request.sourceIds ?? null,
    limit: request.limit, maxFunctionsPerResult: request.maxFunctionsPerResult,
    maxEvidenceRefsPerResult: request.maxEvidenceRefsPerResult };
  const queryBindingSha = createHash('sha256').update(`${JSON.stringify({ installId: response?.installId, request: response?.request }, null, 2)}\n`).digest('hex');
  const responseKeys = ['schemaVersion','queryId','installId','request','status','resultCount','limits','boundary',
    'retrievalIsUse','requiresExplicitAdoption','results'];
  ensure(object(response) && responseKeys.every(key => Object.hasOwn(response, key))
    && Object.keys(response).every(key => responseKeys.includes(key) || key === 'matchingPolicy'), 'DATA 响应含未知字段或缺少必需字段');
  ensure(object(response) && response.schemaVersion === DEEP_REFERENCE_QUERY_VERSION && text(response.queryId, 240)
    && text(response.installId, 240) && object(response.request)
    && JSON.stringify(canonical(response.request)) === JSON.stringify(canonical(expectedRequest))
    && response.queryId === `deepref-query-${queryBindingSha}`
    && ['covered','uncovered'].includes(response.status) && Array.isArray(response.results)
    && response.resultCount === response.results.length && response.retrievalIsUse === false
    && (response.status === 'covered') === (response.results.length > 0)
    && response.requiresExplicitAdoption === true, 'DATA 深层参考响应版本、完整规范化请求、查询哈希绑定或状态无效');
  if (Object.hasOwn(response, 'matchingPolicy')) validateMatchingPolicy(response.matchingPolicy, expectedRequest, response);
  for (const result of response.results) {
    ensure(object(result) && text(result.referenceId, 240) && object(result.source) && text(result.source.sourceId, 160)
      && /^[a-f0-9]{64}$/.test(result.source.sourceSha256) && /^[a-f0-9]{64}$/.test(result.source.sourceTextSha256)
      && text(result.source.textVersion, 240)
      && object(result.analysis) && /^[a-f0-9]{64}$/.test(result.analysis.candidateSha256)
      && /^[a-f0-9]{64}$/.test(result.analysis.packetSha256)
      && result.analysis.candidateStatus === 'candidate_unreviewed' && result.analysis.approved === false
      && object(result.semanticReview) && /^[a-f0-9]{64}$/.test(result.semanticReview.reportSha256)
      && Array.isArray(result.borrowableWritingFunctions) && result.borrowableWritingFunctions.length > 0
      && Array.isArray(result.exactReferences) && result.exactReferences.length > 0
      && result.retrievalIsUse === false && result.requiresExplicitAdoption === true,
    `DATA 深层参考结果 ${result?.referenceId ?? '(unknown)'} 缺少冻结身份、复核或精确证据`);
    ensure(result.referenceId === `deepref:${result.source.sourceId}:${result.analysis.candidateSha256.slice(0,16)}:${result.semanticReview.reportSha256.slice(0,16)}`,
      `DATA 深层参考结果 ${result.referenceId} 的来源、候选或复核身份绑定不一致`);
    const evidenceIds = new Set();
    for (const reference of result.exactReferences) {
      ensure(object(reference) && text(reference.evidenceId, 240) && !evidenceIds.has(reference.evidenceId)
        && text(reference.unitId, 240) && object(reference.locator)
        && reference.sourceId === result.source.sourceId
        && reference.sourceSha256 === result.source.sourceSha256
        && reference.sourceTextSha256 === result.source.sourceTextSha256
        && reference.textVersion === result.source.textVersion
        && exactText(reference.quote, 12000)
        && /^[a-f0-9]{64}$/.test(reference.quoteSha256)
        && createHash('sha256').update(reference.quote).digest('hex') === reference.quoteSha256,
      `DATA 精确证据 ${reference?.evidenceId ?? '(unknown)'} 与来源身份、版本或逐字哈希不一致`);
      evidenceIds.add(reference.evidenceId);
    }
    for (const writingFunction of result.borrowableWritingFunctions) ensure(object(writingFunction)
      && Array.isArray(writingFunction.evidenceIds) && writingFunction.evidenceIds.length > 0
      && writingFunction.evidenceIds.every(evidenceId => evidenceIds.has(evidenceId)),
    `DATA 写作功能 ${writingFunction?.functionId ?? '(unknown)'} 引用了结果外或不完整的证据`);
  }
  return clone(response);
}

function materialFromDataResult(result) {
  const references = result.exactReferences.map(reference => {
    const locator = reference.locator;
    ensure(object(locator) && Number.isSafeInteger(locator.lineStart) && Number.isSafeInteger(locator.lineEnd)
      && locator.lineStart >= 1 && locator.lineEnd >= locator.lineStart && exactText(reference.quote, 12000)
      && reference.quote.split('\n').length === locator.lineEnd - locator.lineStart + 1,
    `DATA 精确证据 ${reference.evidenceId ?? '(unknown)'} 行号与引文不一致`);
    return { sourceId: result.source.sourceId, sourceSha256: result.source.sourceSha256, textVersion: reference.textVersion,
      analysisVersion: result.analysis.analysisVersion ?? result.analysis.candidateSha256,
      reviewRecordId: result.semanticReview.reportSha256, unitIds: [reference.unitId],
      lineStart: locator.lineStart, lineEnd: locator.lineEnd };
  });
  const projection = { referenceId: result.referenceId, candidateStatus: result.analysis.candidateStatus,
    semanticReview: { verdict: result.semanticReview.verdict, caveats: result.semanticReview.caveats,
      blockingDefects: result.semanticReview.blockingDefects }, match: result.match,
    borrowableWritingFunctions: result.borrowableWritingFunctions,
    boundary: '仅可借鉴有逐字来源证据的写作功能；不是已采用、已验证效果或可复制来源文字。' };
  const blocks = result.exactReferences.map((reference, index) => `原文（${references[index].lineStart}–${references[index].lineEnd}）：\n${reference.quote}`);
  const content = `${JSON.stringify(projection, null, 2)}\n\n${blocks.join('\n\n')}`;
  const limitations = [...new Set([
    ...(result.limits?.statements ?? []), result.limits?.visibility,
    ...(result.semanticReview.caveats ?? []),
    'candidate_unreviewed；approved=false；checked=false；召回不等于采用。',
  ].filter(value => typeof value === 'string' && value.trim()))].slice(0, 16);
  return { id: result.referenceId, title: result.source.title ?? result.source.sourceId, kind: 'retrieved', use: 'reviewed_analysis',
    content, sha256: createHash('sha256').update(content).digest('hex'), references,
    selectionReason: `问题词面命中：${(result.match?.matchedTerms ?? []).join('、') || 'DATA 有界命中'}；仍须由创作阶段独立判断适用性。`,
    limitations: limitations.length ? limitations : ['DATA 只提供证据约束假说；不可把召回当作采用或效果证明。'] };
}

function goalFunctionSupply(response, query) {
  const materials = [], selections = []; let usedChars = 0, usedUnits = 0;
  for (const result of response.results) {
    let selected = [], material, unitCount = 0;
    for (const fn of result.borrowableWritingFunctions) {
      const proposed = [...selected, fn], evidenceIds = new Set(proposed.flatMap(item => item.evidenceIds));
      const projected = { ...result, borrowableWritingFunctions: proposed,
        exactReferences: result.exactReferences.filter(item => evidenceIds.has(item.evidenceId)) };
      const candidate = materialFromDataResult(projected);
      const units = new Set(candidate.references.flatMap(ref => ref.unitIds.map(id => `${ref.sourceId}:${ref.analysisVersion}:${id}`))).size;
      if (materials.length >= query.budget.maxUnits || usedUnits + units > query.budget.maxUnits
        || usedChars + candidate.content.length > query.budget.maxChars || candidate.content.length > 12000) continue;
      selected = proposed; material = candidate; unitCount = units;
    }
    if (material) { materials.push(material); usedChars += material.content.length; usedUnits += unitCount; }
    selections.push({ materialId: result.referenceId, selectedFunctionIds: selected.map(fn => fn.functionId),
      budgetExcludedFunctionIds: result.borrowableWritingFunctions.filter(fn => !selected.includes(fn)).map(fn => fn.functionId),
      materialSha256: material?.sha256 ?? null, completeEvidence: true });
  }
  return { materials, usedChars, functionSelection: { schemaVersion: 'creation-whole-goal-complete-functions-1',
    budget: clone(query.budget), selections, boundary: 'DATA order, complete functions and all their exact references only; budget selection does not establish applicability or use.' } };
}

export function createDeepReferenceRetrievalAdapter(queryDeepReferences, { path = 'create', problem: explicitProblem,
  dimensions = ['emotionalProgression','psychologicalChangeDrivers'], maxFunctionsPerResult = 2, maxEvidenceRefsPerResult = 6 } = {}) {
  ensure(typeof queryDeepReferences === 'function', '缺少 DATA queryDeepReferences 回调');
  return async (query, { signal } = {}) => {
    signal?.throwIfAborted?.();
    const problem = explicitProblem === undefined ? buildDeepReferenceProblem(query, { path }) : clone(explicitProblem);
    const dataRequest = { problem, dimensions: clone(dimensions),
      ...(query.sourceIds === undefined ? {} : { sourceIds: clone(query.sourceIds) }),
      limit: Math.min(query.budget.maxUnits, DEEP_REFERENCE_LIMITS.maxResults), maxFunctionsPerResult,
      maxEvidenceRefsPerResult: Math.min(maxEvidenceRefsPerResult, DEEP_REFERENCE_LIMITS.maxEvidenceRefsPerResult) };
    let response;
    try { response = validateDataResponse(await queryDeepReferences(clone(dataRequest), { signal }), dataRequest); }
    catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || ['ABORT_ERR','CANCELLED','cancelled'].includes(error?.code)) throw error;
      return { contractVersion: 'v04-contract-1', packetId: `deepref-unavailable-${fingerprint({ path, problem }).slice(0,24)}`,
        query: clone(query), status: 'unavailable', materials: [], candidates: [], usedChars: 0,
        limits: ['深层参考查询失败或返回合同不兼容；失败不表示资料库没有相关材料。'],
        deepReference: { contractVersion: DEEP_REFERENCE_INTEGRATION_VERSION, path, problem, dataRequest: clone(dataRequest),
          response: null, error: { code: 'DEEP_REFERENCE_UNAVAILABLE', message: '查询失败或合同不兼容。' } } };
    }
    signal?.throwIfAborted?.();
    const allMaterials = response.results.map(materialFromDataResult), projected = path === 'whole_manuscript_writing_goal' ? goalFunctionSupply(response, query) : null;
    const materials = projected?.materials ?? [];
    let usedChars = 0, usedUnits = 0;
    for (const material of projected ? [] : allMaterials) {
      const units = new Set(material.references.flatMap(reference => reference.unitIds.map(unitId => `${reference.sourceId}:${reference.analysisVersion}:${unitId}`))).size;
      if (materials.length >= query.budget.maxUnits || usedUnits + units > query.budget.maxUnits
        || usedChars + material.content.length > query.budget.maxChars || material.content.length > 12000) continue;
      materials.push(material); usedChars += material.content.length; usedUnits += units;
    }
    if (projected) usedChars = projected.usedChars;
    const candidates = response.results.slice(0, query.budget.maxCandidates).map(result => ({ id: result.referenceId,
      sourceId: result.source.sourceId, reason: `DATA ${result.match?.matchedTermCount ?? 0} 个词面问题项命中；candidate_unreviewed，须显式决定。` }));
    return { contractVersion: 'v04-contract-1', packetId: response.queryId, query: clone(query),
      status: materials.length ? 'matched' : 'uncovered', materials, candidates, usedChars,
      limits: [response.boundary, ...(materials.length < allMaterials.length ? ['部分命中因创作查询的材料单元或字符预算未进入供应；完整 DATA 响应仍保留。'] : []),
        ...(projected ? ['目标查询按完整功能及其全部精确证据装入预算；预算排除不表示不适用，所有原始命中仍在DATA响应中。'] : [])],
      deepReference: { contractVersion: DEEP_REFERENCE_INTEGRATION_VERSION, path, problem, dataRequest: clone(dataRequest), response,
        ...(projected ? { functionSelection: projected.functionSelection } : {}) } };
  };
}

/** Recheck saved goal receipts without querying DATA or trusting a detached problem attachment. */
export function assertGoalDeepReferencePacket(packet, problem, options) {
  const metadata = packet.deepReference;
  const expected = { problem: clone(problem), dimensions: clone(options.dimensions),
    ...(packet.query.sourceIds === undefined ? {} : { sourceIds: clone(packet.query.sourceIds) }),
    limit: Math.min(packet.query.budget.maxUnits, DEEP_REFERENCE_LIMITS.maxResults),
    maxFunctionsPerResult: options.maxFunctionsPerResult,
    maxEvidenceRefsPerResult: Math.min(options.maxEvidenceRefsPerResult, DEEP_REFERENCE_LIMITS.maxEvidenceRefsPerResult) };
  ensure(object(metadata) && metadata.contractVersion === DEEP_REFERENCE_INTEGRATION_VERSION
    && metadata.path === 'whole_manuscript_writing_goal' && fingerprint(metadata.problem) === fingerprint(problem)
    && fingerprint(metadata.dataRequest) === fingerprint(expected), '写作目标保存的DATA请求不匹配冻结目标');
  if (metadata.response === null) {
    ensure(metadata.error?.code === 'DEEP_REFERENCE_UNAVAILABLE', '缺失目标查询响应须保留不可用状态');
    return packet;
  }
  const response = validateDataResponse(metadata.response, expected);
  const projected = goalFunctionSupply(response, packet.query);
  ensure(fingerprint(metadata.functionSelection) === fingerprint(projected.functionSelection), '写作目标功能预算选择不能从原始响应重建');
  for (const result of response.results) {
    const supplied = packet.materials.find(material => material.id === result.referenceId), expectedMaterial = projected.materials.find(material => material.id === result.referenceId);
    if (supplied) ensure(expectedMaterial && fingerprint(supplied) === fingerprint(expectedMaterial), '写作目标供应不能由保存的DATA原始响应重建');
  }
  return packet;
}

function sourceBindings(material) {
  const bindings = [];
  for (const reference of material?.references ?? []) {
    const binding = { sourceId: reference.sourceId, sourceSha256: reference.sourceSha256, textVersion: reference.textVersion };
    if (!bindings.some(item => JSON.stringify(item) === JSON.stringify(binding))) bindings.push(binding);
  }
  if (bindings.length === 0 && text(material?.id, 240) && /^[a-f0-9]{64}$/.test(material?.sha256)) {
    bindings.push({ sourceId: `material:${material.id}`, sourceSha256: material.sha256,
      textVersion: material.kind === 'user_selected' ? 'user-selected-v1' : 'builtin-material-v1' });
  }
  ensure(bindings.length > 0, `材料 ${material?.id ?? '(unknown)'} 缺少来源绑定`);
  return bindings;
}

export function createFinalTextEvidenceInput({ chapters, materialDecisions, materials } = {}) {
  ensure(Array.isArray(chapters) && chapters.length > 0 && Array.isArray(materialDecisions) && Array.isArray(materials), '最终正文证据输入缺少正文、决定或材料');
  const byId = new Map(materials.map(material => [material.id, material]));
  const adopted = materialDecisions.filter(decision => decision?.decision === 'adopt').map(decision => {
    const material = byId.get(decision.materialId);
    ensure(material && material.sha256 === decision.sourceMaterialSha256, `采用材料 ${decision.materialId} 与供应包不一致`);
    return { materialId: decision.materialId, sourceMaterialSha256: decision.sourceMaterialSha256,
      mechanism: decision.mechanism, creativeUse: clone(decision.creativeUse), target: clone(decision.target),
      sourceBindings: sourceBindings(material) };
  });
  const input = { schemaVersion: CREATE_FINAL_TEXT_EVIDENCE_STAGE_VERSION, candidateManuscriptSha256: manuscriptSha256(chapters),
    chapters: clone(chapters), adopted, responseContract: {
      type: 'object', additionalProperties: false, required: ['claims'],
      claims: 'one ordered claim per adopted material',
      claim: { required: ['materialId','status','manuscriptEvidence','limitations'], optional: ['reason'],
        status: ['located','not_proven'],
        manuscriptEvidence: ['chapterId','start:null','quote','purpose'],
        rules: ['located requires one or more exact quotes and omits reason', 'return start:null; host resolves it only when quote occurs exactly once in that chapter',
          'not_proven requires no spans and a concrete reason'] },
    }, boundary: '规划采用不等于正文落实。模型不要计算 UTF-16；located 使用 start:null，程序只对指定章节中唯一逐字引文计算真实 UTF-16 位置。引文缺失、改写或重复且未唯一定位时保留 not_proven；不得模糊匹配、追加修复调用、用方案文字冒充正文或宣称文学效果。' };
  return { ...input, inputHash: fingerprint(input) };
}

export function buildCreateFinalTextEvidence(response, input, materialDecisions) {
  ensure(object(response) && Object.keys(response).every(key => key === 'claims') && Array.isArray(response.claims), '最终正文证据响应格式无效');
  ensure(response.claims.length === input.adopted.length, '最终正文证据须逐份覆盖采用材料');
  const claims = response.claims.map((claim, index) => {
    const adopted = input.adopted[index];
    ensure(object(claim) && Object.keys(claim).every(key => ['materialId','status','manuscriptEvidence','limitations','reason'].includes(key))
      && claim.materialId === adopted.materialId && ['located','not_proven'].includes(claim.status)
      && Array.isArray(claim.manuscriptEvidence) && Array.isArray(claim.limitations) && claim.limitations.length > 0
      && claim.limitations.every(value => text(value, 500)), '最终正文证据声明身份、状态或限制无效');
    if (claim.status === 'located') ensure(claim.manuscriptEvidence.length > 0 && claim.reason === undefined, 'located 必须有逐字证据且不能带 fallback reason');
    else ensure(claim.manuscriptEvidence.length === 0 && text(claim.reason), 'not_proven 必须有具体原因且不能带引文');
    let unresolvedReason;
    const manuscriptEvidence = claim.manuscriptEvidence.map((entry, evidenceIndex) => {
      ensure(object(entry) && Object.keys(entry).every(key => ['chapterId','start','quote','purpose'].includes(key))
        && text(entry.chapterId, 240) && (entry.start === null || Number.isSafeInteger(entry.start) && entry.start >= 0)
        && text(entry.quote, 12000) && text(entry.purpose, 1000), `最终正文证据 ${evidenceIndex + 1} 字段无效`);
      const chapter = input.chapters.find(item => item.id === entry.chapterId);
      ensure(chapter, `最终正文证据 ${evidenceIndex + 1} 章节不存在`);
      if (entry.start !== null) {
        if (chapter.body.slice(entry.start, entry.start + entry.quote.length) !== entry.quote)
          unresolvedReason ??= `材料 ${adopted.materialId} 的模型位置与候选正文逐字内容不符；未进行模糊定位。`;
        return clone(entry);
      }
      const starts = [];
      for (let start = chapter.body.indexOf(entry.quote); start !== -1; start = chapter.body.indexOf(entry.quote, start + 1)) starts.push(start);
      if (starts.length !== 1) {
        unresolvedReason ??= starts.length === 0
          ? `材料 ${adopted.materialId} 的引文未在指定章节逐字出现；未进行模糊定位。`
          : `材料 ${adopted.materialId} 的引文在指定章节出现 ${starts.length} 次，无法唯一定位。`;
        return clone(entry);
      }
      return { ...clone(entry), start: starts[0] };
    });
    if (claim.status === 'located' && unresolvedReason) return { materialId: adopted.materialId,
      sourceMaterialSha256: adopted.sourceMaterialSha256, sourceBindings: clone(adopted.sourceBindings), status: 'not_proven',
      manuscriptEvidence: [], reason: unresolvedReason,
      limitations: [...clone(claim.limitations), '主机未增加模型调用，也未用近似文字或出现次序猜测位置。'] };
    return { materialId: adopted.materialId, sourceMaterialSha256: adopted.sourceMaterialSha256,
      sourceBindings: clone(adopted.sourceBindings), status: claim.status, manuscriptEvidence,
      ...(claim.reason === undefined ? {} : { reason: claim.reason }), limitations: clone(claim.limitations) };
  });
  return buildFinalTextMaterialEvidence({ chapters: input.chapters, materialDecisions, claims });
}

export function emptyCreateFinalTextEvidence({ chapters, materialDecisions } = {}) {
  return buildFinalTextMaterialEvidence({ chapters, materialDecisions, claims: [] });
}

export function buildCreateDeepReferenceBundle({ retrieval, materials, materialDecisions, finalTextEvidence, chapters } = {}) {
  ensure(object(retrieval) && Array.isArray(materials) && Array.isArray(materialDecisions) && object(finalTextEvidence), '新建路径深层参考包输入无效');
  const decisions = new Map(materialDecisions.map(item => [item.materialId, item]));
  const evidence = new Map(finalTextEvidence.items.map(item => [item.materialId, item]));
  const deepIds = new Set((retrieval.deepReference?.response?.results ?? []).map(item => item.referenceId));
  const candidates = materials.filter(material => material.kind === 'retrieved' && deepIds.has(material.id)).map(material => {
    const decision = decisions.get(material.id);
    ensure(decision, `材料 ${material.id} 缺少显式采用决定`);
    const final = evidence.get(material.id);
    const status = decision.decision === 'decline' ? 'unused' : final?.verificationStatus === 'literal_text_located_not_literary_effect_verified' ? 'used_exact_text_located' : 'not_proven';
    return { materialId: material.id, sourceMaterialSha256: material.sha256, use: material.use, selectionReason: material.selectionReason,
      references: clone(material.references), limitations: clone(material.limitations), decision: decision.decision,
      resolution: status === 'unused' ? 'reject' : status === 'not_proven' ? 'unverifiable' : 'adopt', status,
      functionalChoice: decision.creativeUse.functionalChoice, intendedChapter: decision.creativeUse.intendedChapter,
      psychologicalChange: decision.creativeUse.psychologicalChange, characterChoice: decision.creativeUse.characterChoice,
      consequence: decision.creativeUse.consequence, caveat: decision.creativeUse.caveat, reason: decision.reason,
      manuscriptEvidence: clone(final?.manuscriptEvidence ?? []),
      ...(final?.reason === undefined ? {} : { notProvenReason: final.reason }) };
  });
  const body = { schemaVersion: DEEP_REFERENCE_INTEGRATION_VERSION, path: 'create',
    callbackStatus: retrieval.deepReference?.composition?.deepStatus ?? retrieval.status,
    query: clone(retrieval.query ?? null), packetId: retrieval.packetId ?? null,
    dataQuery: clone(retrieval.deepReference ?? null), sourceManuscriptSha256: null,
    candidateManuscriptSha256: manuscriptSha256(chapters), candidates,
    unusedMaterialIds: candidates.filter(item => item.status === 'unused').map(item => item.materialId),
    notProvenMaterialIds: candidates.filter(item => item.status === 'not_proven').map(item => item.materialId),
    exactTextLocatedMaterialIds: candidates.filter(item => item.status === 'used_exact_text_located').map(item => item.materialId),
    limitations: ['检索命中、规划采用和正文逐字存在是三种不同证据。', '逐字落点不证明材料造成该文字、目标落实或文学质量改善。'] };
  return { ...body, bundleSha256: fingerprint(body) };
}

export function buildWholeQualityDeepReferenceBundle({ retrieval, applicability, plan, materialUse, finalTextMaterialEvidence, sourceChapters, candidateChapters } = {}) {
  ensure(object(retrieval) && object(applicability) && object(plan) && object(materialUse) && object(finalTextMaterialEvidence), '整稿路径深层参考包输入无效');
  const fitBySupply = new Map(applicability.assessments.map(item => [item.supplyId, item]));
  const planDecisionBySupply = new Map(plan.materialDecisions.map(item => [item.supplyId, item]));
  const finalByIssue = new Map(finalTextMaterialEvidence.byIssue.map(item => [item.issueId, item]));
  const queryEntries = [...retrieval.byIssue, ...(retrieval.byGoal ?? [])];
  const deepIdsByIssue = new Map(queryEntries.map(item => [item.issueId,
    new Set((item.result?.packet?.deepReference?.response?.results ?? []).map(result => result.referenceId))]));
  const candidates = retrieval.supplies.filter(supply => deepIdsByIssue.get(supply.issueId)?.has(supply.materialId)).map(supply => {
    const fit = fitBySupply.get(supply.supplyId), decision = planDecisionBySupply.get(supply.supplyId);
    ensure(fit && decision, `供应 ${supply.supplyId} 缺少适用性或用材决定`);
    const record = finalByIssue.get(supply.issueId)?.records?.find(item => item.materialId === supply.materialId);
    const status = decision.decision === 'not_used' ? 'unused' : record?.status === 'located' ? 'used_exact_text_located' : 'not_proven';
    const planItems = decision.planItemIds.map(id => plan.items.find(item => item.id === id)).filter(Boolean);
    return { supplyId: supply.supplyId, issueId: supply.issueId, materialId: supply.materialId,
      ...(supply.goalId ? {goalId:supply.goalId,origin:'writing_goal'} : {}),
      contentSha256: supply.contentSha256, evidenceIds: clone(supply.evidenceIds), reviewBoundary: supply.reviewBoundary,
      fit: fit.fit, decision: decision.decision, resolution: status === 'unused' ? 'reject' : status === 'not_proven' ? 'unverifiable' : 'adopt',
      status, functionalChoice: decision.appliedAs ?? `不采用：${decision.reason}`,
      intendedChapters: [...new Set(planItems.flatMap(item => item.affectedChapterIds))],
      psychologicalChange: planItems.map(item => item.expectedEffect).join('；') || '未采用；不主张心理变化',
      characterChoice: planItems.flatMap(item => item.actionRequirements.map(requirement => requirement.description)).join('；') || '未采用；不主张人物选择',
      consequence: planItems.flatMap(item => item.actionRequirements.map(requirement => requirement.expectedVisibleChange)).join('；') || '未采用；不主张正文后果',
      caveat: decision.applicabilityBoundary, limitations: clone(decision.limitations), reason: decision.reason,
      manuscriptEvidence: clone(record?.findings ?? []), ...(record?.reason === undefined ? {} : { notProvenReason: record.reason }) };
  });
  const deepStatuses = queryEntries.map(item => item.result?.packet?.deepReference?.composition?.deepStatus ?? item.status);
  const body = { schemaVersion: DEEP_REFERENCE_INTEGRATION_VERSION, path: 'whole_manuscript_quality',
    callbackStatus: deepStatuses.some(status => status === 'unavailable') ? 'unavailable'
      : deepStatuses.some(status => status === 'not_connected') ? 'not_connected'
      : deepStatuses.some(status => status === 'matched') ? 'matched' : 'uncovered',
    sourceManuscriptSha256: manuscriptSha256(sourceChapters), candidateManuscriptSha256: manuscriptSha256(candidateChapters),
    dataQueries: queryEntries.map(item => ({ issueId: item.issueId,
      ...(item.goalId ? {goalId:item.goalId,origin:'writing_goal'} : {}),
      callbackStatus: item.result?.packet?.deepReference?.composition?.deepStatus ?? item.status,
      query: clone(item.result?.packet?.deepReference ?? null) })), candidates,
    unusedMaterialIds: candidates.filter(item => item.status === 'unused').map(item => item.materialId),
    notProvenMaterialIds: candidates.filter(item => item.status === 'not_proven').map(item => item.materialId),
    exactTextLocatedMaterialIds: candidates.filter(item => item.status === 'used_exact_text_located').map(item => item.materialId),
    limitations: ['每个结果只覆盖对应冻结问题的有界查询，不代表比较完整资料库。', 'direct_fit、used 与精确正文落点均不单独证明文学改善。'] };
  return { ...body, bundleSha256: fingerprint(body) };
}
