import { createHash } from 'node:crypto';
import { manuscriptFingerprint } from '../../validation/runtime/checks.mjs';
import { buildRevisionAdjacencyEvidence } from './revision-adjacency-evidence.mjs';

export const INDEPENDENT_REVIEW_HANDOFF_VERSION = 'independent-review-handoff-2';
export const INDEPENDENT_REVIEW_PROVENANCE_VERSION = 'independent-review-handoff-provenance-2';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const ensure = (condition, code, message) => {
  if (!condition) throw Object.assign(new Error(message), { code });
};
const clone = value => structuredClone(value);

function validateChapters(chapters, label) {
  ensure(Array.isArray(chapters) && chapters.length > 0, 'HANDOFF_CHAPTERS', `${label}章节无效。`);
  const ids = new Set();
  const checked = chapters.map(chapter => {
    ensure(object(chapter) && Object.keys(chapter).length === 3
      && typeof chapter.id === 'string' && chapter.id && typeof chapter.title === 'string' && chapter.title
      && typeof chapter.body === 'string' && chapter.body && !ids.has(chapter.id),
    'HANDOFF_CHAPTERS', `${label}章节字段无效或重复。`);
    ids.add(chapter.id); return clone(chapter);
  });
  return checked;
}

function validateCrossChapterBinding(binding) {
  ensure(object(binding) && binding.enabled === true
    && binding.contractVersion === 'cross-chapter-review-result-1'
    && binding.integrationVersion === 'whole-quality-cross-chapter-integration-1'
    && typeof binding.modelPolicy === 'string' && binding.modelPolicy.trim(),
  'HANDOFF_CROSS_CHAPTER_BINDING', '跨章核对请求绑定无效。');
  return clone(binding);
}

function requestFingerprint(request, sourceChapters, runtimeCrossChapterReview) {
  ensure(object(request) && request.kind === 'revise' && request.revisionMode === 'whole-manuscript-v2',
    'HANDOFF_REQUEST_MODE', '只接受whole-manuscript-v2修订请求。');
  ensure(typeof request.baseRevision === 'string', 'HANDOFF_BASE_REVISION', '起点版本无效。');
  const objective = typeof request.instruction === 'string' && request.instruction.trim()
    ? request.instruction : typeof request.idea === 'string' ? request.idea : '';
  ensure(objective.trim(), 'HANDOFF_OBJECTIVE', '修订目标为空。');
  ensure(request.sourceIds === undefined || Array.isArray(request.sourceIds)
    && request.sourceIds.every(id => typeof id === 'string' && id.trim()),
  'HANDOFF_SOURCE_IDS', '指定来源无效。');
  const persistedCrossChapterReview = request.crossChapterReview === undefined
    ? undefined : validateCrossChapterBinding(request.crossChapterReview);
  const normalizedCrossChapterReview = runtimeCrossChapterReview === undefined
    ? undefined : validateCrossChapterBinding(runtimeCrossChapterReview);
  ensure(persistedCrossChapterReview === undefined || normalizedCrossChapterReview === undefined
    || sha256(persistedCrossChapterReview) === sha256(normalizedCrossChapterReview),
  'HANDOFF_CROSS_CHAPTER_BINDING', '持久化请求与运行时跨章核对绑定不一致。');
  const crossChapterReview = persistedCrossChapterReview ?? normalizedCrossChapterReview;
  const core = { kind: 'revise', revisionMode: 'whole-manuscript-v2', sourceBaseRevision: request.baseRevision,
    objective, chapters: sourceChapters,
    ...(request.sourceIds !== undefined ? { sourceIds: [...new Set(request.sourceIds)] } : {}),
    ...(crossChapterReview !== undefined ? { crossChapterReview } : {}) };
  return { objective, inputFingerprint: sha256(core),
    bindingMode: persistedCrossChapterReview !== undefined ? 'persisted_exact'
      : normalizedCrossChapterReview !== undefined ? 'runtime_normalized_cross_binding' : 'legacy_exact' };
}

function applyReplacements(sourceChapters, replacements) {
  const byChapter = new Map();
  for (const item of replacements) {
    ensure(object(item) && typeof item.targetId === 'string' && typeof item.chapterId === 'string'
      && typeof item.sourceQuote === 'string' && typeof item.replacement === 'string'
      && Number.isSafeInteger(item.sourceStart) && item.sourceStart >= 0
      && Array.isArray(item.appliedPlanItemIds) && item.appliedPlanItemIds.length === 1,
    'HANDOFF_REPLACEMENT', '候选替换字段无效。');
    const list = byChapter.get(item.chapterId) ?? []; list.push(item); byChapter.set(item.chapterId, list);
  }
  return sourceChapters.map(chapter => {
    let body = chapter.body;
    const entries = (byChapter.get(chapter.id) ?? []).slice().sort((a, b) => b.sourceStart - a.sourceStart);
    for (const item of entries) {
      ensure(body.slice(item.sourceStart, item.sourceStart + item.sourceQuote.length) === item.sourceQuote,
        'HANDOFF_REPLACEMENT_SOURCE', '候选替换与原稿指定位置不一致。');
      body = body.slice(0, item.sourceStart) + item.replacement + body.slice(item.sourceStart + item.sourceQuote.length);
    }
    return { ...chapter, body };
  });
}

function citationList(items, sourceChapters, code) {
  const seen = new Set();
  return items.map(item => {
    ensure(object(item) && typeof item.chapterId === 'string' && typeof item.quote === 'string' && item.quote
      && Number.isSafeInteger(item.start) && item.start >= 0, code, '目标证据字段无效。');
    const chapter = sourceChapters.find(entry => entry.id === item.chapterId);
    ensure(chapter?.body.slice(item.start, item.start + item.quote.length) === item.quote, code, '目标证据不是原稿指定位置逐字引文。');
    return { chapterId: item.chapterId, quote: item.quote, start: item.start };
  }).filter(item => {
    const key = `${item.chapterId}:${item.start}:${item.quote.length}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  });
}

function goalsForGroups(whole, selectedGroupIds, sourceChapters) {
  const reading = whole.quality?.independentReading;
  ensure(Array.isArray(reading?.issues), 'HANDOFF_READING', '缺少修订前冻结的独立阅读问题。');
  const confirmed = whole.quality?.crossChapterReview?.confirmedConflicts ?? [];
  const crossIssues = confirmed.map(conflict => ({ id: conflict.id, claimType: 'textual_conflict',
    evidence: conflict.evidence.slice(0,1), counterEvidence: conflict.evidence.slice(1) }));
  const issueById = new Map([...reading.issues, ...crossIssues].map(issue => [issue.id, issue]));
  const itemById = new Map(whole.plan.items.map(item => [item.id, item]));
  return selectedGroupIds.map(groupId => {
    const item = itemById.get(groupId);
    ensure(item?.decision === 'revise' && Array.isArray(item.issueIds) && item.issueIds.length > 0,
      'HANDOFF_GOAL_ITEM', '采纳组没有修订前方案目标。');
    const issues = item.issueIds.map(id => issueById.get(id));
    ensure(issues.every(Boolean), 'HANDOFF_GOAL_ISSUE', '方案引用的修订前问题缺失。');
    const sourceEvidence = citationList(issues.flatMap(issue => issue.evidence ?? []), sourceChapters, 'HANDOFF_GOAL_SOURCE');
    const counterCase = citationList(issues.flatMap(issue => issue.counterEvidence ?? []), sourceChapters, 'HANDOFF_GOAL_COUNTER');
    ensure(sourceEvidence.length > 0 && counterCase.length > 0, 'HANDOFF_GOAL_BALANCE', '目标缺少修订前证据或反例，不能事后补写。');
    ensure(Array.isArray(item.actionRequirements) && item.actionRequirements.length > 0,
      'HANDOFF_GOAL_OUTCOME', '目标缺少修订前可见结果要求。');
    ensure(typeof item.action === 'string' && item.action.trim() && typeof item.expectedEffect === 'string' && item.expectedEffect.trim()
      && typeof item.failureCriteria === 'string' && item.failureCriteria.trim(),
    'HANDOFF_GOAL_VALUE', '修订前目标、预期作用或失败条件为空。');
    return {
      id: item.id,
      statement: item.action,
      claimType: issues.every(issue => issue.claimType === 'textual_conflict') ? 'hard_fact' : 'editorial_hypothesis',
      sourceEvidence,
      counterCase,
      expectedEffect: item.expectedEffect,
      failureCriterion: item.failureCriteria,
      requiredOutcomes: item.actionRequirements.map(requirement => {
        ensure(object(requirement) && typeof requirement.id === 'string' && requirement.id
          && typeof requirement.description === 'string' && requirement.description.trim()
          && typeof requirement.expectedVisibleChange === 'string' && requirement.expectedVisibleChange.trim()
          && typeof requirement.failureCriterion === 'string' && requirement.failureCriterion.trim(),
        'HANDOFF_GOAL_OUTCOME', '修订前可见结果要求字段无效。');
        return { id: requirement.id,
          dimension: ['action', 'cognition', 'relationship', 'other'].includes(requirement.dimension) ? requirement.dimension : 'other',
          description: `${requirement.description}；可见结果：${requirement.expectedVisibleChange}；失败条件：${requirement.failureCriterion}` };
      }),
    };
  });
}

/** Build a validation request without exposing provenance to blind readers. */
export function buildIndependentReviewRequest({ caseId, request, result, selection } = {}) {
  ensure(typeof caseId === 'string' && caseId.trim(), 'HANDOFF_CASE_ID', 'caseId无效。');
  ensure(object(result) && object(result.wholeRevision), 'HANDOFF_RESULT', '缺少全文质量修订结果。');
  const whole = result.wholeRevision;
  ensure(whole.schemaVersion === 'whole-manuscript-quality-1' && object(whole.requestSpec)
    && Array.isArray(whole.plan?.items) && object(whole.adoption), 'HANDOFF_RESULT', '全文质量结果版本或字段无效。');
  const sourceChapters = validateChapters(whole.sourceChapters, '原稿');
  const candidateChapters = validateChapters(result.chapters, '完整候选稿');
  const resultCrossChapterReview = whole.requestSpec.crossChapterReview === undefined
    ? undefined : validateCrossChapterBinding(whole.requestSpec.crossChapterReview);
  const persistedRequestHasCrossBinding = object(request) && request.crossChapterReview !== undefined;
  const requestBinding = requestFingerprint(request, sourceChapters,
    persistedRequestHasCrossBinding ? undefined : resultCrossChapterReview);
  ensure(whole.requestSpec.inputFingerprint === requestBinding.inputFingerprint
    && whole.requestSpec.objective === requestBinding.objective
    && whole.requestSpec.sourceBaseRevision === request.baseRevision
    && result.baseRevision === request.baseRevision
    && whole.requestSpec.sourceManuscriptSha256 === manuscriptFingerprint(sourceChapters),
  'HANDOFF_REQUEST_BINDING', '请求、原稿和结果绑定不一致。');
  const crossEnabled = resultCrossChapterReview !== undefined;
  ensure(!crossEnabled || request.crossChapterReview === undefined
    || sha256(request.crossChapterReview) === sha256(resultCrossChapterReview),
  'HANDOFF_CROSS_CHAPTER_BINDING', '请求与结果的跨章核对绑定不一致。');
  ensure(crossEnabled || request.crossChapterReview === undefined,
    'HANDOFF_CROSS_CHAPTER_BINDING', '旧结果不能接受新增的客户端跨章核对绑定。');
  const crossReview = whole.quality?.crossChapterReview, crossResolution = whole.quality?.crossChapterResolution;
  let confirmedConflictIds = [], unresolvedConfirmedConflictIds = [];
  if (crossEnabled) {
    ensure(object(crossReview) && crossReview.schemaVersion === 'whole-quality-cross-chapter-bundle-1'
      && crossReview.sourceManuscriptSha256 === manuscriptFingerprint(sourceChapters) && Array.isArray(crossReview.confirmedConflicts),
    'HANDOFF_CROSS_CHAPTER_REVIEW', '新路径缺少与原稿绑定的跨章事实核对证据。');
    confirmedConflictIds = crossReview.confirmedConflicts.map(item => item.id);
    ensure(new Set(confirmedConflictIds).size === confirmedConflictIds.length
      && crossReview.confirmedConflicts.every(item => Array.isArray(item.evidence) && item.evidence.length >= 2),
    'HANDOFF_CROSS_CHAPTER_REVIEW', 'confirmed_conflict 身份或双向证据无效。');
    ensure(object(crossResolution) && crossResolution.schemaVersion === 'whole-quality-cross-chapter-outcome-1'
      && Array.isArray(crossResolution.items) && crossResolution.items.length === confirmedConflictIds.length,
    'HANDOFF_CROSS_CHAPTER_OUTCOME', 'confirmed_conflict 缺少逐项修复结果。');
    const outcomeById = new Map(crossResolution.items.map(item => [item.conflictId,item]));
    ensure(confirmedConflictIds.every(id => outcomeById.has(id)) && crossResolution.items.every(item => ['resolved_in_candidate','unresolved'].includes(item.repairStatus)),
    'HANDOFF_CROSS_CHAPTER_OUTCOME', 'confirmed_conflict 修复状态不能重建。');
    unresolvedConfirmedConflictIds = crossResolution.items.filter(item => item.repairStatus === 'unresolved').map(item => item.conflictId);
    const accounted = new Set([...(whole.plan.items ?? []).filter(item => item.decision === 'revise').flatMap(item => item.issueIds ?? []),
      ...(whole.plan.unresolved ?? []).map(item => item.issueId)]);
    ensure(confirmedConflictIds.every(id => accounted.has(id))
      && !(whole.plan.items ?? []).some(item => item.decision === 'preserve' && item.issueIds?.some(id => confirmedConflictIds.includes(id))),
    'HANDOFF_CROSS_CHAPTER_GOAL', 'confirmed_conflict 未进入冻结修订目标或明确未决。');
  }
  ensure(Array.isArray(whole.candidateRevision?.replacements) || whole.candidateRevision === null,
    'HANDOFF_CANDIDATE', '候选替换记录无效。');
  const replacements = whole.candidateRevision?.replacements ?? [];
  const rebuiltFullCandidate = applyReplacements(sourceChapters, replacements);
  ensure(JSON.stringify(rebuiltFullCandidate) === JSON.stringify(candidateChapters)
    && whole.diff?.candidateManuscriptSha256 === manuscriptFingerprint(candidateChapters),
  'HANDOFF_CANDIDATE_BINDING', '完整候选稿不能由已授权替换重建。');

  const replacementGroupIds = new Set(replacements.map(item => item.appliedPlanItemIds[0]));
  const plannedGroupIds = whole.plan.items.filter(item => item.decision === 'revise').map(item => item.id);
  const appliedGroupIds = whole.plan.items.filter(item => replacementGroupIds.has(item.id)).map(item => item.id);
  const atomicGroups = Array.isArray(whole.adoption.atomicGroups) ? whole.adoption.atomicGroups : [];
  const groupById = new Map(atomicGroups.map(group => [group.planItemId, group]));
  ensure(plannedGroupIds.every(id => groupById.has(id)), 'HANDOFF_ADOPTION_GROUP', '原定修订目标缺少原子采纳组。');
  const explicitSelection = selection !== undefined;
  ensure(!explicitSelection || Array.isArray(selection), 'HANDOFF_SELECTION', 'selection须为明确的修改组ID数组。');
  const selectedGroupIds = explicitSelection ? [...selection] : plannedGroupIds;
  ensure(new Set(selectedGroupIds).size === selectedGroupIds.length
    && selectedGroupIds.every(id => explicitSelection ? appliedGroupIds.includes(id) : plannedGroupIds.includes(id)),
  'HANDOFF_SELECTION', 'selection含重复、未知或未执行修改组。');
  if (explicitSelection) ensure(selectedGroupIds.every(id => groupById.get(id)?.recommendation === 'eligible_for_user_choice'),
    'HANDOFF_SELECTION_NOT_ELIGIBLE', '实际采纳只能包含复读后可供用户选择的修改组。');

  const selected = new Set(selectedGroupIds);
  const selectedReplacements = replacements.filter(item => selected.has(item.appliedPlanItemIds[0]));
  const reviewChapters = explicitSelection ? applyReplacements(sourceChapters, selectedReplacements) : candidateChapters;
  const candidateMode = manuscriptFingerprint(reviewChapters) === manuscriptFingerprint(sourceChapters) ? 'no_change' : 'revised';
  const goals = goalsForGroups(whole, selectedGroupIds, sourceChapters);
  ensure(candidateMode === 'no_change' || goals.length > 0, 'HANDOFF_GOALS_REQUIRED', '修改稿缺少修订前冻结目标。');
  const adjacencyEvidence = buildRevisionAdjacencyEvidence({ sourceChapters, candidateChapters: reviewChapters,
    replacements: selectedReplacements });
  const allGroupIds = atomicGroups.map(group => group.planItemId);
  const requestPayload = { caseId, mode: 'compare', baselineChapters: sourceChapters,
    candidate: { mode: candidateMode, chapters: reviewChapters }, goals };
  const provenanceBody = {
    schemaVersion: INDEPENDENT_REVIEW_PROVENANCE_VERSION,
    handoffVersion: INDEPENDENT_REVIEW_HANDOFF_VERSION,
    artifactRole: candidateMode === 'no_change' && !explicitSelection ? 'source_preserved'
      : explicitSelection ? 'selected_adopted' : 'full_candidate',
    sourceBaseRevision: whole.requestSpec.sourceBaseRevision,
    requestInputFingerprint: whole.requestSpec.inputFingerprint,
    requestBindingMode: requestBinding.bindingMode,
    wholeRevisionResultSha256: sha256(result),
    sourceManuscriptSha256: manuscriptFingerprint(sourceChapters),
    fullCandidateManuscriptSha256: manuscriptFingerprint(candidateChapters),
    reviewCandidateManuscriptSha256: manuscriptFingerprint(reviewChapters),
    wholeRevisionStatus: whole.status,
    adoptionStatus: whole.adoption.status,
    plannedRevisionGroupIds: plannedGroupIds,
    executedGroupIds: appliedGroupIds,
    goalGroupIds: selectedGroupIds,
    unexecutedGoalGroupIds: selectedGroupIds.filter(id => !replacementGroupIds.has(id)),
    goalCoverage: explicitSelection ? 'selected_groups_only' : 'full_plan',
    selectedGroupIds,
    declinedGroupIds: allGroupIds.filter(id => !selected.has(id)),
    rereadScope: explicitSelection ? 'selected-groups-unchecked' : 'full-candidate',
    adjacencyEvidence,
    ...(crossEnabled ? { confirmedConflictIds, unresolvedConfirmedConflictIds,
      crossChapterResolutionSha256: sha256(crossResolution) } : {}),
    boundary: 'provenance只供产品控制器做版本绑定，不得进入盲读模型输入；完整候选审计全部修订前目标，未执行目标仍须进入独立核查；部分采纳只覆盖所选目标，declinedGroupIds不声称已落实；CREATION内部复读不是独立盲评结论。',
  };
  return { request: requestPayload, provenance: { ...provenanceBody, provenanceSha256: sha256(provenanceBody) } };
}
