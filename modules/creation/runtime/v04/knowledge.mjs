import { validateReferenceIntent, referenceNeedView } from './reference-intent.mjs';
import { validateRelevanceReview } from '../../../data/runtime/relevance.mjs';
import { validateMaterialNarrativeObservations } from '../../../data/runtime/narrative-observations.mjs';
import { createHash } from 'node:crypto';

export const CONTRACT_VERSION = 'v04-contract-1';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const text = value => typeof value === 'string' && value.trim().length > 0;
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const assert = (condition, message) => { if (!condition) throw new Error(`检索合同无效：${message}`); };
const abort = signal => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('任务已取消', 'AbortError'); };

/** Shared strict optional hints contract. Never normalize or repair a returned query. */
export function validateRecall(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && same(Object.keys(value).sort(), ['focus', 'queries']), 'recall/retrievalHints 须为仅含 focus 与 queries 的对象');
  assert(['scene', 'ending', 'echo'].includes(value.focus), 'recall/retrievalHints focus 无效');
  assert(Array.isArray(value.queries) && value.queries.length <= 3
    && value.queries.every(q => typeof q === 'string' && q.length > 0 && q.length <= 120 && q === q.trim())
    && new Set(value.queries).size === value.queries.length, 'recall/retrievalHints queries 须为 0–3 条已 trim、非空、至多 120 字符且不重复的字符串');
  return structuredClone(value);
}

/** Optional primary reference question: reject malformed text rather than silently trim it. */
export function validateReferenceQuestion(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 240 && value === value.trim(),
    'referenceQuestion 须为已 trim、非空且至多 240 字符的字符串');
  return value;
}

/** Validate an optional saved summary only; never fetch a receipt or rerun screening. */
export function validateRelevanceSummary(result) {
  return validateRelevanceReview(result?.relevanceReview, {
    status: result?.status, candidateCount: result?.candidates?.length,
    maxCandidates: result?.query?.budget?.maxCandidates, materialCount: result?.materials?.length,
  });
}

/** Filter only the author projection, never receipts, snapshots or charged budgets.
 * decisionMaterials binds decisions to original bytes/ranges when followup replaces an id.
 * No decision means unassessed optional reference, not implied adoption.
 */
export function filterAuthorKnowledge(view, materialDecisions, decisionMaterials = [], { requireAdoptDecision = false } = {}) {
  const result = structuredClone(view);
  if ((!Array.isArray(materialDecisions) || !materialDecisions.length) && !requireAdoptDecision) return result;
  const decisions = (Array.isArray(materialDecisions) ? materialDecisions : [])
    .filter(d => d && text(d.materialId) && ['adopt', 'decline'].includes(d.decision));
  const adoptedIds = new Set(decisions.filter(d => d.decision === 'adopt').map(d => d.materialId));
  const declinedIds = new Set(decisions.filter(d => d.decision === 'decline').map(d => d.materialId));
  const unassessedIds = result.materials.filter(m => !adoptedIds.has(m.id) && !declinedIds.has(m.id)).map(m => m.id);
  const declined = [...view.materials, ...decisionMaterials].filter(m => declinedIds.has(m.id));
  const overlaps = (a, b) => a.use === b.use && a.references?.some(x => b.references?.some(y =>
    sha(x.sourceSha256) && x.sourceSha256 === y.sourceSha256 && x.textVersion === y.textVersion
    && (a.use === 'raw_reference'
      ? Number.isSafeInteger(x.lineStart) && Number.isSafeInteger(x.lineEnd) && Number.isSafeInteger(y.lineStart) && Number.isSafeInteger(y.lineEnd)
        && x.lineStart <= y.lineEnd && y.lineStart <= x.lineEnd
      : a.use === 'reviewed_analysis' && x.analysisVersion === y.analysisVersion && x.unitIds?.some(id => y.unitIds?.includes(id)))));
  const excluded = result.materials.filter(m => (requireAdoptDecision && !adoptedIds.has(m.id)) || declinedIds.has(m.id) || declined.some(d =>
    (sha(m.sha256) && m.sha256 === d.sha256) || overlaps(m, d)));
  const excludedIds = new Set(excluded.map(m => m.id));
  result.materials = result.materials.filter(m => !excludedIds.has(m.id));
  result.materialUse = {
    decisions: decisions.map(({materialId, decision, reason, limitations}) => structuredClone({materialId, decision, reason, limitations,
      status: 'author_declared_not_text_verified'})),
    excludedMaterialIds: [...excludedIds],
    ...(requireAdoptDecision ? { unassessedMaterialIds: unassessedIds } : {}),
    boundary: requireAdoptDecision
      ? '只向作者提供当前计划明确adopt的材料；明确decline及后续供应但尚未重规划的材料均不进入正文输入。采用声明及场景计划不是正文落实或文学提升证据。'
      : '按本次计划决定过滤明确拒绝的材料及已识别的同内容/重叠单元；新计划明确改为adopt可重新评估。未声明材料仍待判断。采用声明及场景计划不是正文落实或文学提升证据。',
  };
  return result;
}

export function knowledgeForAuthor(knowledge, { materialDecisions, decisionMaterials = knowledge.materials,
  requireAdoptDecision = false } = {}) {
  return filterAuthorKnowledge({ materials: knowledge.materials.map(material => {
    validateMaterialNarrativeObservations(material);
    const { id, title, content, kind, sha256, use, evidence_status, references, selectionReason, limitations, narrativeObservations } = material;
    return {id, title, content, kind, sha256, use, evidence_status, references, selectionReason, limitations,
      ...(narrativeObservations !== undefined ? {narrativeObservations: structuredClone(narrativeObservations)} : {}),
      applicability: use === 'raw_reference' ? '仅原文及客观范围参考；不能把自行解释当已复核知识。'
        : use === 'reviewed_analysis' ? '携带逐来源复核记录；仍须判断对新作的适用性，不证明文学效果。'
        : '材料用途未核验；不能自动视为已复核分析。'};
  }), style: knowledge.style, limits: knowledge.limits,
    ...(knowledge.retrieval?.query?.recall !== undefined ? { recall: structuredClone(knowledge.retrieval.query.recall) } : {}),
  }, materialDecisions, decisionMaterials, { requireAdoptDecision });
}

export function retrievalQuery(request, requirements, remaining) {
  const intent = requirements.referenceIntent === undefined ? undefined
    : validateReferenceIntent(requirements.referenceIntent, { question: requirements.referenceQuestion, request });
  const legacyContext = JSON.stringify({ summary: requirements.summary, genre: requirements.genre,
    setting: requirements.setting, pointOfView: requirements.pointOfView,
    requiredElements: requirements.requiredElements, prohibitions: requirements.prohibitions });
  // Bound only the search view. The complete requirements and actual draft remain author inputs.
  const legacyQuery = [requirements.summary, request.kind === 'revise' ? request.instruction : request.idea,
    '人物经历如何改变认知、行动与表达；场景情绪积累及前后回应'].filter(text).join('\n').slice(0, 2000);
  let query = legacyQuery, context = legacyContext.slice(0, 6000);
  if (requirements.referenceQuestion !== undefined) {
    query = validateReferenceQuestion(requirements.referenceQuestion);
    const { referenceQuestion, referenceIntent, referenceStrategy, retrievalHints, userRequirementSources, ...targetRequirements } = requirements;
    context = JSON.stringify({
      referenceNeed: { question: query, evidenceBoundary: '来源须用自身可见文本回答本问题。事实问题须有直接事实证据；表达问题须有可定位的组织方式与必要上下文，不能推测来源答案。' },
      targetUse: { requirements: targetRequirements, ...(userRequirementSources !== undefined ? { userRequirementSourceIndex: { status: 'retained_in_requestSpec_not_sent_to_retrieval', entries: userRequirementSources.map(({path,text}) => ({path,length:text.length,sha256:hash(text)})) } } : {}), conditions: '本篇要求用于新作写作及参考迁移，除所选需要明确要求外，不要求来源出现本篇人物、对象或事件；同一主体、明确身份及因果条件不能因此豁免。事实参考仅用于主问题所需核验；表达参考仅借鉴有证据且能在这些限制下使用的组织方式。不能移植来源人物、关系、连续情节或把外部心理当成本篇事实。' },
    });
    if (intent) {
      const view = JSON.parse(context);
      view.referenceNeed = referenceNeedView(query, intent);
      context = JSON.stringify(view);
    }
    if (requirements.referenceStrategy?.storyProblem) {
      const view = JSON.parse(context);
      view.targetUse.storyProblem = structuredClone(requirements.referenceStrategy.storyProblem);
      context = JSON.stringify(view);
    }
    // 新问题不截断约束；超出服务边界时显式拒绝，原需求仍保留在任务输入中。
    assert(context.length <= 8000, 'referenceQuestion 上下文超过 8000 字符，不能截断新作使用限制');
  }
  const value = { contractVersion: CONTRACT_VERSION, evidenceType: intent?.purpose === 'performance' ? 'performance' : 'narrative', query,
    stage: request.kind === 'revise' ? 'revision' : 'planning', context,
    budget: { maxCandidates: 20, maxUnits: 6, maxChars: Math.min(12000, remaining) } };
  if (requirements.retrievalHints !== undefined) value.recall = validateRecall(requirements.retrievalHints);
  if (request.sourceIds !== undefined) {
    assert(strings(request.sourceIds) && request.sourceIds.every(text) && request.sourceIds.length <= 100, 'sourceIds 须为至多 100 个非空来源标识');
    value.sourceIds = [...new Set(request.sourceIds)];
  }
  return value;
}

function resolvedScope(result, query) {
  const explicit = query.sourceIds !== undefined;
  if (explicit) assert(strings(query.sourceIds) && query.sourceIds.every(text) && query.sourceIds.length <= 100, '指定来源无效');
  if (!explicit) {
    assert(result.sourceResolutions === undefined, '无指定来源时须省略来源映射');
    return null;
  }
  const requested = new Set(query.sourceIds ?? []);
  // Historical responses predate alias resolution. Keep their exact direct scope, but never
  // infer an alias relationship or promote their references to another source identity.
  if (result.sourceResolutions === undefined) return new Map([...requested].map(id => [id, null]));
  assert(Array.isArray(result.sourceResolutions) && result.sourceResolutions.length === requested.size, '来源映射须完整覆盖去重后的指定来源');
  const seen = new Set(), byCanonical = new Map(), byRequest = new Map();
  const keys = ['requestedSourceId', 'canonicalSourceId', 'textVersion', 'sourceSha256'];
  for (const resolution of result.sourceResolutions) {
    assert(resolution && !Array.isArray(resolution) && same(Object.keys(resolution).sort(), [...keys].sort()), '来源映射字段无效');
    const { requestedSourceId, canonicalSourceId, textVersion, sourceSha256 } = resolution;
    assert(text(requestedSourceId) && requested.has(requestedSourceId) && !seen.has(requestedSourceId), '来源映射请求身份额外、重复或无效');
    seen.add(requestedSourceId);
    byRequest.set(requestedSourceId, canonicalSourceId);
    if (canonicalSourceId === null && textVersion === null && sourceSha256 === null) continue;
    assert(text(canonicalSourceId) && text(textVersion) && sha(sourceSha256), '来源映射须完整绑定版本和哈希；未知来源须三个字段均为 null');
    const binding = { textVersion, sourceSha256 };
    assert(!byCanonical.has(canonicalSourceId) || same(byCanonical.get(canonicalSourceId), binding), '同一规范来源的映射版本或哈希冲突');
    byCanonical.set(canonicalSourceId, binding);
  }
  for (const id of byCanonical.keys()) {
    assert(!byRequest.has(id) || byRequest.get(id) === id, '规范来源不能继续映射到其他来源或未知');
  }
  // This verifies the response's internal binding only. Registry authenticity belongs to the
  // data service and integration checks; an internally consistent response is not proof of it.
  return explicit ? byCanonical : null;
}

export function validateRetrieval(result, query) {
  if (query?.recall !== undefined) validateRecall(query.recall);
  if (result?.query?.recall !== undefined) validateRecall(result.query.recall);
  assert(query?.evidenceType === undefined || ['narrative', 'performance'].includes(query.evidenceType), 'evidenceType 须为 narrative 或 performance，历史可省略');
  assert(result?.query?.evidenceType === undefined || ['narrative', 'performance'].includes(result.query.evidenceType), '响应 evidenceType 无效');
  assert(result?.contractVersion === CONTRACT_VERSION && text(result.packetId), '版本或材料包身份缺失');
  assert(same(result.query, query), '响应未绑定实际查询');
  assert(['matched', 'uncovered', 'unavailable'].includes(result.status), '状态未知');
  assert(Array.isArray(result.materials) && Array.isArray(result.candidates) && strings(result.limits), '缺少材料、候选或限制');
  validateRelevanceSummary(result);
  assert(result.materials.length <= query.budget.maxUnits && result.candidates.length <= query.budget.maxCandidates, '超出候选或材料预算');
  assert(result.status === 'matched' ? result.materials.length > 0 : result.materials.length === 0, '状态与材料数量矛盾');
  assert(query.evidenceType !== 'performance' || (result.materials.length === 0 && result.candidates.length === 0 && result.limits.length > 0), 'performance 查询不能接收叙事材料或候选；当前没有表现材料合同，须说明缺口');
  const scope = resolvedScope(result, query);
  const ids = new Set(), units = new Set(), rawRanges = new Set();
  for (const item of result.materials) {
    assert(text(item.id) && !ids.has(item.id) && text(item.title) && item.kind === 'retrieved', '材料身份无效或重复');
    ids.add(item.id);
    assert(['raw_reference', 'reviewed_analysis'].includes(item.use), '新材料缺少有效用途');
    assert(text(item.content) && sha(item.sha256) && hash(item.content) === item.sha256, '材料正文与哈希不匹配');
    assert(text(item.selectionReason) && strings(item.limitations), '缺少选择理由或范围限制');
    assert(Array.isArray(item.references) && item.references.length > 0, '来源链缺失');
    for (const ref of item.references) {
      assert(text(ref.sourceId) && text(ref.textVersion) && text(ref.analysisVersion) && sha(ref.sourceSha256)
        && strings(ref.unitIds) && (item.use === 'raw_reference' || ref.unitIds.length > 0) && ref.unitIds.every(text)
        && Number.isSafeInteger(ref.lineStart) && ref.lineStart >= 1 && Number.isSafeInteger(ref.lineEnd) && ref.lineEnd >= ref.lineStart, '来源版本或行号无效');
      assert(scope === null || scope.has(ref.sourceId), '材料超出指定来源映射');
      if (scope !== null && scope.get(ref.sourceId) !== null) assert(same(scope.get(ref.sourceId), { textVersion: ref.textVersion, sourceSha256: ref.sourceSha256 }), '材料版本或哈希与来源映射不匹配');
      assert(item.use !== 'reviewed_analysis' || text(ref.reviewRecordId), '已复核分析缺少逐来源复核记录');
      if (item.use === 'raw_reference') {
        const range = JSON.stringify([ref.sourceSha256, ref.textVersion, 'raw-range', ref.lineStart, ref.lineEnd]);
        assert(!rawRanges.has(range), '原文区间重复，不能重复计入材料');
        rawRanges.add(range);
        units.add(range);
      } else {
        for (const unitId of ref.unitIds) units.add(JSON.stringify([ref.sourceId, ref.textVersion, ref.analysisVersion, unitId]));
      }
    }
  }
  for (const candidate of result.candidates) {
    assert(text(candidate.id) && text(candidate.sourceId) && text(candidate.reason), '候选身份或理由缺失');
    assert(scope === null || scope.has(candidate.sourceId), '候选超出指定来源映射');
  }
  const used = result.materials.reduce((sum, item) => sum + item.content.length, 0);
  assert(units.size <= query.budget.maxUnits, '超出分析单元预算');
  assert(result.usedChars === used && used <= query.budget.maxChars, '字符预算或计量不符');
  return structuredClone(result);
}

/** Real-result compatibility adapter; never manufactures source material or successful retrieval. */
export async function prepareWorkflowKnowledge({ request, requirements, prepareKnowledge, retrieveKnowledge, signal, stopOnFailure = false }) {
  abort(signal);
  const base = await prepareKnowledge(request);
  abort(signal);
  const remaining = 30000 - base.materials.reduce((sum, item) => sum + item.content.length, 0);
  const finish = (packet, retrieval) => ({ ...packet, retrieval,
    limits: [...packet.limits.map(limit => retrieval.query && limit.startsWith('未启动全库检索')
      ? '基础材料准备不执行拆解或方法对照；自动查询的实际状态和范围见 retrieval。' : limit), ...retrieval.limits] });
  if (typeof retrieveKnowledge !== 'function') return finish(base, { contractVersion: CONTRACT_VERSION,
    status: 'not_connected', limits: ['自动检索未接入；沿用本次手选资料和内置观察。'] });
  if (remaining <= 0) return finish(base, { contractVersion: CONTRACT_VERSION,
    status: 'skipped_budget', limits: ['手选与内置材料已占满 30000 字符，未发起自动检索。'] });
  const query = retrievalQuery(request, requirements, remaining);
  let result;
  try {
    const response = await retrieveKnowledge(structuredClone(query), { signal });
    abort(signal);
    result = validateRetrieval(response, query);
    assert(!result.materials.some(item => base.materials.some(selected => selected.id === item.id)), '自动材料与已有材料身份冲突');
  } catch (error) {
    abort(signal);
    if (error?.name === 'AbortError' || ['ABORT_ERR', 'CANCELLED', 'cancelled'].includes(error?.code)) throw error;
    // Provider messages may contain internals. Persist a bounded public failure, not stack/credentials.
    return finish(base, { contractVersion: CONTRACT_VERSION, status: 'unavailable', query,
      error: { code: 'RETRIEVAL_UNAVAILABLE', message: '自动材料查询失败或返回合同不兼容。', retryable: true },
      limits: [stopOnFailure ? '材料筛选失败，暂停后续创作；失败不表示没有匹配材料。' : '自动材料查询不可用；本次继续通用创作，不把失败记为未命中。'] });
  }
  const prepared = await prepareKnowledge(request, { retrievalResult: structuredClone(result) });
  abort(signal);
  // The baseline data module may ignore its optional second argument. Merge the actual validated
  // response locally until its merger lands; reject partial/inconsistent mergers rather than trim.
  const retrieved = prepared.materials.filter(item => item.kind === 'retrieved');
  let packet = prepared;
  let mergeAdapter = 'data';
  if (result.materials.length && retrieved.length === 0) {
    const materials = [...base.materials, ...result.materials.map(item => ({ ...item,
      evidence_status: '检索参考；适用性及正文落实尚未验证' }))];
    packet = { ...base, schemaVersion: 2, materials, coverage: 'partial',
      packetId: `knowledge-${hash(JSON.stringify({ materials, style: base.style })).slice(0, 16)}` };
    mergeAdapter = 'creation-v04-compat';
  }
  assert(packet.materials.reduce((sum, item) => sum + item.content.length, 0) <= 30000, '合并超过共同上限');
  assert(packet.materials.length === base.materials.length + result.materials.length, '合并包含额外或缺失材料');
  assert(same(packet.style, base.style), '合并改变用户风格要求');
  for (const item of [...base.materials, ...result.materials]) {
    assert(packet.materials.some(merged => merged.id === item.id && merged.kind === item.kind
      && merged.content === item.content && merged.sha256 === item.sha256
      && (item.kind !== 'retrieved' || (merged.use === item.use && same(merged.references, item.references)
        && same(merged.limitations, item.limitations) && merged.selectionReason === item.selectionReason))), '合并丢失或改变材料版本');
  }
  return finish(packet, { ...result, mergeAdapter,
    limits: [...result.limits, stopOnFailure && result.status === 'unavailable' ? '材料筛选失败，暂停后续创作；失败不表示没有匹配材料。' : '命中仅表示材料送入作者上下文；不代表作者采用、全文已覆盖或文学效果成立。'] });
}
