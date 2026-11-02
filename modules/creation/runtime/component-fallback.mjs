import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runComponentFallback, validateComponentFallbackCheckpoint } from '../../data/runtime/component-query-fallback.mjs';
import { buildComponentFallbackSupply } from './v04/deep-reference.mjs';
import { writingGoalSubjectId } from './writing-goals.mjs';

export const COMPONENT_FALLBACK_BUNDLE_VERSION = 'whole-quality-component-fallback-bundle-1';
const clone = structuredClone;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const ensure = (condition, message) => {
  if (!condition) throw Object.assign(new Error(message), { code: 'WHOLE_QUALITY_COMPONENT_FALLBACK' });
};
export const hasComponentFallback = requestSpec => !!requestSpec.writingGoals?.goals.some(goal => goal.componentFallback);

/** Only actual, fully reviewed supplies can establish the rejection trigger. */
export function componentFallbackAssessment(entry, applicability) {
  const packet = entry.result?.packet, metadata = packet?.deepReference, response = metadata?.response;
  const assessments = new Map(applicability.assessments.filter(item => item.issueId === entry.issueId).map(item => [item.materialId, item]));
  const supplied = (packet?.materials ?? []).map(material => {
    const result = response?.results.find(item => item.referenceId === material.id);
    const selected = metadata?.functionSelection?.selections.find(item => item.materialId === material.id);
    ensure(!result || selected && selected.selectedFunctionIds.length > 0, '实际deep供应缺少完整功能选择。');
    ensure(assessments.has(material.id), '原始适用审查未覆盖实际供应。');
    return { materialId: material.id, functionIds: result ? clone(selected.selectedFunctionIds) : [], side: result ? 'deep' : 'legacy',
      sourceIds: [...new Set(material.references.map(ref => ref.sourceId))], contentSha256: material.sha256,
      supplyId: `${entry.issueId}:${material.id}` };
  });
  const decisions = supplied.map(item => clone(assessments.get(item.materialId)));
  const outcome = !response ? 'unavailable'
    : !supplied.length ? response.status === 'uncovered' && response.results.length === 0 ? 'no_hits' : 'not_supplied'
    : decisions.every(item => item.fit === 'inapplicable') ? 'all_supplied_inapplicable'
    : decisions.some(item => item.fit === 'direct_fit' || item.fit === 'mechanism_only') ? 'applicable_exists' : 'not_assessed';
  return { queryId: response?.queryId ?? null, responseSha256: response ? hash(response) : null, outcome, supplied, decisions,
    provenance: { schemaVersion: 'creation-component-fallback-trigger-1', originalEntrySha256: hash(entry),
      applicabilitySha256: hash(applicability), evidenceBoundary: '最终实际供应及其逐项适用判断；未供给、未知或未采用不等于不适用。' } };
}

function optionsFor(goal, entry, assessment) {
  return { policy: goal.componentFallback, originalRequest: entry.result?.packet?.deepReference?.dataRequest,
    originalResponse: entry.result?.packet?.deepReference?.response ?? null, assessment };
}
async function boundSave(key, value, saved, checkpoint) {
  if (Object.hasOwn(saved, key)) ensure(isDeepStrictEqual(saved[key], value), `${key}与冻结输入不一致。`);
  else { await checkpoint(key, clone(value)); saved[key] = clone(value); }
}

export async function runWholeQualityComponentFallback({ requestSpec, originalRetrieval, originalApplicability,
  queryDeepReferences, rebuildEntry, validateRetrieval, saved, checkpoint, signal }) {
  const retrieval = clone(originalRetrieval), goals = [];
  for (const goal of requestSpec.writingGoals.goals.filter(item => item.componentFallback)) {
    const entry = originalRetrieval.byGoal.find(item => item.goalId === goal.id);
    ensure(entry, '后备目标缺少原查询。');
    const assessment = componentFallbackAssessment(entry, originalApplicability), options = optionsFor(goal, entry, assessment);
    const prefix = `whole-quality:component-fallback:${hash(goal.id).slice(0,16)}`;
    await boundSave(`${prefix}:input`, { requestInputFingerprint: requestSpec.inputFingerprint, goalId: goal.id,
      policy: goal.componentFallback, originalEntrySha256: hash(entry), assessment }, saved, checkpoint);
    const keys = Object.keys(saved).filter(key => key.startsWith(`${prefix}:state:`))
      .sort((a,b) => Number(a.slice(`${prefix}:state:`.length)) - Number(b.slice(`${prefix}:state:`.length)));
    let last = null;
    for (let index = 0; index < keys.length; index++) {
      const row = saved[keys[index]];
      ensure(keys[index] === `${prefix}:state:${index}` && Object.keys(row).length === 3
        && row.sequence === index && row.previousCheckpointSha256 === (last?.checkpointSha256 ?? null), '子机制后备历史链不完整。');
      const checked = validateComponentFallbackCheckpoint({ ...options, checkpoint: row.checkpoint });
      if (last) ensure(last.status === 'in_progress' && checked.queryCalls >= last.queryCalls
        && isDeepStrictEqual(checked.runs.slice(0,last.runs.length), last.runs), '子机制后备不得重抽、丢弃前缀或改写终态。');
      last = checked;
    }
    const downstream = Object.keys(saved).some(key => ['whole-quality:plan:', 'whole-quality:plan-facts:', 'whole-quality:feasibility:',
      'whole-quality:revision:', 'whole-quality:reread:'].some(prefix => key.startsWith(prefix)));
    ensure(!downstream || last && last.status !== 'in_progress', '计划输入已冻结，不能补查或替换子机制后备。');
    let sequence = keys.length;
    const fallback = await runComponentFallback({ ...options, query: queryDeepReferences, signal,
      ...(last ? { checkpoint: last } : {}), onCheckpoint: async next => {
        if (last && isDeepStrictEqual(last, next)) return;
        const row = { sequence, previousCheckpointSha256: last?.checkpointSha256 ?? null, checkpoint: clone(next) };
        await boundSave(`${prefix}:state:${sequence}`, row, saved, checkpoint); sequence++; last = clone(next);
      } });
    // The terminal DATA checkpoint is immutable, including query_error/no hits.
    ensure(last && isDeepStrictEqual(last, fallback), 'DATA后备终态缺少持久化记录。');
    let selection = null, effectiveEntry = entry;
    if (entry.result?.packet?.deepReference?.response) {
      const composition = buildComponentFallbackSupply({ originalPacket: entry.result.packet, fallback, policy: goal.componentFallback });
      selection = composition.selection;
      if (!isDeepStrictEqual(composition.packet, entry.result.packet)) effectiveEntry = await rebuildEntry(goal, entry, composition.packet);
    }
    retrieval.byGoal[retrieval.byGoal.findIndex(item => item.goalId === goal.id)] = clone(effectiveEntry);
    goals.push({ goalId: goal.id, originalEntrySha256: hash(entry), assessment, fallback, supplySelection: selection,
      effectiveEntrySha256: hash(effectiveEntry) });
  }
  retrieval.supplies = [...retrieval.byIssue, ...retrieval.byGoal].flatMap(item => (item.result?.evidenceBundle.materials ?? []).map(material => ({
    supplyId: `${item.issueId}:${material.materialId}`, issueId: item.issueId, materialId: material.materialId,
    evidenceIds: material.evidence.map(e => e.evidenceId), contentSha256: material.contentSha256, reviewBoundary: material.reviewBoundary,
    ...(item.goalId ? { goalId: item.goalId, origin: 'writing_goal' } : {}),
  })));
  const checked = validateRetrieval(retrieval);
  const base = { schemaVersion: COMPONENT_FALLBACK_BUNDLE_VERSION, originalRetrieval: clone(originalRetrieval),
    originalApplicability: clone(originalApplicability), goals, queryCalls: goals.reduce((sum,item) => sum + item.fallback.queryCalls, 0),
    effectiveRetrievalSha256: hash(checked) };
  await boundSave('whole-quality:component-fallback:bundle', base, saved, checkpoint);
  return { retrieval: checked, sidecar: base, changed: !isDeepStrictEqual(checked, originalRetrieval) };
}

export function finalizeComponentFallback(base, applicability) {
  return { ...clone(base), effectiveApplicabilitySha256: hash(applicability) };
}

/** Pure result revalidation; no callback and no new query on a completed record. */
export function validateComponentFallbackBundle(value, { requestSpec, retrieval, applicability, validateOriginalRetrieval, validateOriginalApplicability }) {
  ensure(value && value.schemaVersion === COMPONENT_FALLBACK_BUNDLE_VERSION && Object.keys(value).length === 7,
    '子机制后备结果字段或版本无效。');
  const originalRetrieval = validateOriginalRetrieval(value.originalRetrieval);
  ensure(originalRetrieval.byGoal.every(entry => entry.result?.packet?.deepReference?.componentFallback === undefined),
    '原查询历史不能已被另一轮子机制供应替换。');
  const originalApplicability = validateOriginalApplicability(value.originalApplicability, originalRetrieval);
  const configured = requestSpec.writingGoals.goals.filter(goal => goal.componentFallback);
  ensure(Array.isArray(value.goals) && value.goals.length === configured.length, '后备记录须逐目标完整覆盖。');
  for (let index = 0; index < configured.length; index++) {
    const goal = configured[index], row = value.goals[index], originalEntry = originalRetrieval.byGoal.find(item => item.goalId === goal.id);
    const entry = retrieval.byGoal.find(item => item.goalId === goal.id), assessment = componentFallbackAssessment(originalEntry, originalApplicability);
    ensure(row && Object.keys(row).length === 6 && row.goalId === goal.id && row.originalEntrySha256 === hash(originalEntry)
      && isDeepStrictEqual(row.assessment, assessment), '后备触发条件与原实际供应、适用判断不一致。');
    const fallback = validateComponentFallbackCheckpoint({ ...optionsFor(goal, originalEntry, assessment), checkpoint: row.fallback });
    ensure(fallback.status !== 'in_progress', '完成结果不能含未结束后备查询。');
    if (originalEntry.result?.packet?.deepReference?.response) {
      const rebuilt = buildComponentFallbackSupply({ originalPacket: originalEntry.result.packet, fallback, policy: goal.componentFallback });
      ensure(isDeepStrictEqual(rebuilt.selection, row.supplySelection) && isDeepStrictEqual(rebuilt.packet, entry.result?.packet), '后备最终供应或预算台账被改变。');
    } else ensure(row.supplySelection === null && isDeepStrictEqual(entry, originalEntry), '不可用原查询不能产生后备有效供应。');
    ensure(row.effectiveEntrySha256 === hash(entry), '后备有效检索项哈希不一致。');
  }
  const configuredIds = new Set(configured.map(goal => writingGoalSubjectId(goal)));
  ensure(isDeepStrictEqual(retrieval.byIssue, originalRetrieval.byIssue)
    && isDeepStrictEqual(retrieval.byGoal.filter(item => !configuredIds.has(item.issueId)), originalRetrieval.byGoal.filter(item => !configuredIds.has(item.issueId)))
    && value.effectiveRetrievalSha256 === hash(retrieval) && value.effectiveApplicabilitySha256 === hash(applicability)
    && value.queryCalls === value.goals.reduce((sum,item) => sum + item.fallback.queryCalls, 0), '后备不得改变无关查询、审查绑定或查询计数。');
  return clone(value);
}
