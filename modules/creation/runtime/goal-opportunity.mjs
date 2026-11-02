import { createHash } from 'node:crypto';

export const GOAL_OPPORTUNITY_POLICY_VERSION = 'whole-quality-goal-opportunity-policy-1';
export const GOAL_OPPORTUNITY_PLAN_VERSION = 'whole-quality-goal-opportunity-plan-1';
export const SCENE_DEPENDENCY_REREAD_VERSION = 'whole-quality-scene-dependency-reread-1';
export const SCENE_DEPENDENCY_KINDS = Object.freeze(['speaker', 'presence', 'action', 'object', 'transaction']);
export const COMPARABLE_FUNCTION_PACKING = 'analysis99-comparable-supply-1';
const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const ensure = (condition, message, code = 'WHOLE_QUALITY_GOAL_OPPORTUNITY') => {
  if (!condition) throw Object.assign(new Error(message), { code });
};
function exact(value, keys) {
  ensure(object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), '增量/场景评估字段不完整或含未知字段。');
}
function text(value, max = 4000) { ensure(typeof value === 'string' && value.trim() && value.length <= max, '增量/场景说明为空或超限。'); }
function strings(values, max = 10, min = 0) {
  ensure(Array.isArray(values) && values.length >= min && values.length <= max && new Set(values).size === values.length, '增量/场景列表无效。');
  values.forEach(value => text(value, 2000));
}
export function validateGoalImprovementPolicy(value, writingGoals) {
  if (value === undefined) return undefined;
  exact(value, ['schemaVersion', 'mode', 'maxOpportunitiesPerGoal']);
  ensure(value.schemaVersion === GOAL_OPPORTUNITY_POLICY_VERSION && value.mode === 'assess_incremental'
    && value.maxOpportunitiesPerGoal === 1 && writingGoals?.goals?.length > 0, '增量策略必须为已知版本、单机会并绑定显式writingGoals。');
  return copy(value);
}

// Null offsets are resolved only by a unique, literal occurrence in the bound chapter.
export function resolveOpportunityEvidence(value, chapters) {
  exact(value, ['chapterId', 'quote', 'start', 'purpose']); text(value.quote, 2000); text(value.purpose, 2000);
  const chapter = chapters.find(item => item.id === value.chapterId);
  ensure(chapter, '增量/场景证据章节未知。');
  let start = value.start;
  if (start === null) {
    start = chapter.body.indexOf(value.quote);
    ensure(start >= 0 && chapter.body.indexOf(value.quote, start + 1) < 0, '增量/场景引文缺失或不唯一；不作模糊定位。');
  }
  ensure(Number.isSafeInteger(start) && start >= 0 && chapter.body.slice(start, start + value.quote.length) === value.quote, '增量/场景证据不是指定原文精确位置。');
  return { ...copy(value), start };
}
function evidenceList(values, chapters, min = 0, max = 3) {
  ensure(Array.isArray(values) && values.length >= min && values.length <= max, '增量/场景证据数量无效。');
  const result = values.map(value => resolveOpportunityEvidence(value, chapters));
  ensure(new Set(result.map(value => `${value.chapterId}:${value.start}:${value.quote.length}`)).size === result.length, '增量/场景证据位置重复。');
  return result;
}
const overlaps = (left, right) => left.chapterId === right.chapterId && left.start < right.start + right.quote.length && right.start < left.start + left.quote.length;
function covers(range, targets) {
  let end = range.start;
  for (const target of targets.filter(target => target.chapterId === range.chapterId).slice().sort((a,b) => a.start - b.start)) {
    if (target.start > end) break;
    end = Math.max(end, target.start + target.quote.length);
    if (end >= range.end) return true;
  }
  return false;
}
function sceneRange(scene) {
  const range = { sceneId: scene.id, chapterId: scene.chapterId, start: scene.entryEvidence.start,
    end: scene.exitEvidence.start + scene.exitEvidence.quote.length };
  ensure(Number.isSafeInteger(range.start) && range.start >= 0 && range.end > range.start, '场景起止没有精确来源绑定。');
  return range;
}

const str = { type: 'string', minLength: 1, maxLength: 4000 };
const ids = { type: 'array', uniqueItems: true, maxItems: 10, items: { type: 'string' } };
const evidence = { type: 'object', additionalProperties: false, required: ['chapterId','quote','start','purpose'],
  properties: { chapterId: { type: 'string' }, quote: { ...str, maxLength: 2000 }, start: { type: ['null','integer'], minimum: 0 }, purpose: str },
  guidance: 'Use start:null for a unique exact quote; host resolves it. No fuzzy, edited quote, or model-counted offset is required.' };
const evidenceArray = { type: 'array', maxItems: 3, items: evidence };
const opportunitySchema = { type: ['object','null'], additionalProperties: false,
  required: ['sceneIds','sourceEvidence','expectedIncrement','counterEvidence','risks','preservationBoundaries'],
  properties: { sceneIds: { ...ids, minItems: 1 }, sourceEvidence: { ...evidenceArray, minItems: 1 }, expectedIncrement: str,
    counterEvidence: evidenceArray, risks: { ...ids, minItems: 1 }, preservationBoundaries: { ...ids, minItems: 1 } } };
const incrementalSchema = { type: 'object', additionalProperties: false,
  required: ['currentAchievement','currentAchievementEvidence','currentAchievementReason','opportunity','opportunityAssessment','opportunityReason','materialBasis'],
  properties: { currentAchievement: { enum: ['present','partial','not_established'] }, currentAchievementEvidence: evidenceArray,
    currentAchievementReason: str, opportunity: opportunitySchema, opportunityAssessment: { enum: ['attempt','preserve'] }, opportunityReason: str,
    materialBasis: { type: 'object', additionalProperties: false, required: ['kind','supplyIds','evidenceIds','reason'],
      properties: { kind: { enum: ['original','supplied'] }, supplyIds: ids, evidenceIds: { ...ids, maxItems: 60 }, reason: str } } } };
const dependencySchema = { type: 'object', additionalProperties: false, required: ['kind','handling','sourceEvidence','targetIds','reason'],
  properties: { kind: { enum: SCENE_DEPENDENCY_KINDS }, handling: { enum: ['preserve','revise','remove_with_scene','not_applicable'] },
    sourceEvidence: evidenceArray, targetIds: ids, reason: str } };
const dependencyCheckSchema = { type: 'object', additionalProperties: false, required: ['kind','assessment','sourceEvidence','candidateEvidence','reason'],
  properties: { kind: { enum: SCENE_DEPENDENCY_KINDS }, assessment: { enum: ['intact','broken','uncertain','removed_with_scene','not_applicable','not_attempted'] },
    sourceEvidence: evidenceArray, candidateEvidence: evidenceArray, reason: str } };

export function extendOpportunityPlanContract(base) {
  const contract = copy(base); contract.schemaVersion = 'whole-quality-goal-opportunity-plan-response-contract-1';
  const disposition = contract.properties.goalDispositions.items;
  disposition.required.push('incrementalAssessment'); disposition.properties.incrementalAssessment = incrementalSchema;
  contract.item.push('sceneDependencies'); contract.itemSchema.required.push('sceneDependencies');
  contract.itemSchema.properties.sceneDependencies = { type: 'array', maxItems: 5, items: dependencySchema,
    guidance: 'revise: exactly the five kinds in order, with literal source evidence and authorized targetIds; preserve item: [].' };
  contract.globalConstraints.push('Assess one or zero safe incremental opportunities per frozen goal; preserve requires a concrete reason beyond a generic claim that the goal already exists.',
    'Attempt requires an opportunity, exact source evidence and one atomic owning plan item. Original proposals and rejecting every supply are valid.',
    'Supplied basis requires direct_fit complete evidence and the same goal. Unknown, mechanism_only and theme overlap do not qualify.',
    'Assess speaker/presence/action/object/transaction over the entire affected scene and its boundaries. Dependencies that must change need authorized targets in the same atomic group. Whole-scene removal is legal only when its full span is authorized.');
  return contract;
}
export function opportunityExample(goalId, chapter) {
  return { currentAchievement: 'not_established', currentAchievementEvidence: [], currentAchievementReason: '结构占位；须依据源文解释已有实现或尚未证明之处。',
    opportunity: null, opportunityAssessment: 'preserve', opportunityReason: '结构占位；须说明本目标为何没有值得安全尝试的局部增量，不能只复述原稿已有主题。',
    materialBasis: { kind: 'original', supplyIds: [], evidenceIds: [], reason: '结构占位；不虚构资料依据。' } };
}
export function extendOpportunityRereadContract(base) {
  const contract = copy(base); contract.schemaVersion = 'whole-quality-scene-dependency-reread-response-contract-1';
  contract.changeCheck.push('sceneDependencyChecks'); contract.changeCheckSchema.required.push('sceneDependencyChecks');
  contract.changeCheckSchema.properties.sceneDependencyChecks = { type: 'array', minItems: 5, maxItems: 5, items: dependencyCheckSchema };
  contract.globalConstraints.push('For every applied group assess all five scene dependencies against exact source AND candidate quotations. Broken or uncertain dependencies cannot be eligible_for_user_choice.',
    'Removing a complete scene is valid; verify its departure and the candidate seam, rather than requiring deleted dialogue to remain.',
    'An implemented explicit incremental goal needs requirement evidence at a real changed candidate span; quoting only unchanged pre-existing achievement cannot establish increment.');
  return contract;
}
export function sceneDependencyExample(executionStatus) {
  return SCENE_DEPENDENCY_KINDS.map(kind => ({ kind, assessment: executionStatus === 'applied' ? 'uncertain' : 'not_attempted',
    sourceEvidence: [], candidateEvidence: [], reason: '结构占位；须对照完整源场景与候选边界核对，不能从替换存在推出依赖完整。' }));
}

export function validateOpportunityPlan(value, input) {
  if (!input.requestSpec.goalImprovementPolicy) return value;
  const checked = copy(value), scenes = new Map(input.reading.sceneChanges.map(scene => [scene.id, scene]));
  for (const item of checked.items) {
    if (item.decision !== 'revise') { ensure(Array.isArray(item.sceneDependencies) && item.sceneDependencies.length === 0, '保留组不能伪造修改依赖。'); continue; }
    ensure(Array.isArray(item.sceneDependencies) && item.sceneDependencies.length === 5, '修改组缺少五类场景依赖评估。');
    const contexts = affectedSceneContexts(input.chapters, input.reading, { items: [item] });
    item.sceneDependencies = item.sceneDependencies.map((dependency, index) => {
      exact(dependency, ['kind','handling','sourceEvidence','targetIds','reason']);
      ensure(dependency.kind === SCENE_DEPENDENCY_KINDS[index] && ['preserve','revise','remove_with_scene','not_applicable'].includes(dependency.handling), '场景依赖类别、顺序或处置无效。');
      text(dependency.reason); strings(dependency.targetIds);
      ensure(dependency.targetIds.every(id => item.targets.some(target => target.id === id)), '场景依赖不能引用另一组或未授权target。');
      const sourceEvidence = evidenceList(dependency.sourceEvidence, input.chapters, dependency.handling === 'not_applicable' ? 0 : 1);
      ensure(sourceEvidence.every(e => contexts.some(context => context.chapterId === e.chapterId && e.start >= context.source.start
        && e.start + e.quote.length <= context.source.end)), '场景依赖证据超出受影响场景及相邻边界。');
      if (dependency.handling === 'not_applicable') ensure(sourceEvidence.length === 0 && dependency.targetIds.length === 0, '无相关依赖不能同时声明引用或target。');
      if (['revise','remove_with_scene'].includes(dependency.handling)) {
        const targets = item.targets.filter(target => dependency.targetIds.includes(target.id));
        ensure(targets.length > 0 && sourceEvidence.every(e => covers({ ...e, end: e.start + e.quote.length }, targets)), '要改变的依赖必须由本组授权target完整覆盖。');
        if (dependency.handling === 'remove_with_scene') ensure(item.sceneIds.every(id => covers(sceneRange(scenes.get(id)), targets)), '整场删除不能只覆盖设定而留下对话、动作或交易依赖。');
      }
      return { ...dependency, sourceEvidence };
    });
  }
  checked.goalDispositions = checked.goalDispositions.map(disposition => {
    const goal = input.writingGoals.goals.find(goal => goal.id === disposition.goalId), assessment = disposition.incrementalAssessment;
    exact(assessment, ['currentAchievement','currentAchievementEvidence','currentAchievementReason','opportunity','opportunityAssessment','opportunityReason','materialBasis']);
    ensure(['present','partial','not_established'].includes(assessment.currentAchievement), '已有实现状态无效。');
    text(assessment.currentAchievementReason); text(assessment.opportunityReason);
    ensure(assessment.opportunityAssessment === disposition.decision, '增量机会处置与实际目标处置不一致。');
    const achievement = evidenceList(assessment.currentAchievementEvidence, input.chapters, assessment.currentAchievement === 'not_established' ? 0 : 1);
    const inGoal = e => !goal.chapterIds.length || goal.chapterIds.includes(e.chapterId);
    ensure(achievement.every(inGoal), '已有实现证据超出冻结目标范围。');
    let opportunity = null;
    if (assessment.opportunity !== null) {
      const item = assessment.opportunity;
      exact(item, ['sceneIds','sourceEvidence','expectedIncrement','counterEvidence','risks','preservationBoundaries']);
      strings(item.sceneIds, 10, 1); text(item.expectedIncrement); strings(item.risks, 5, 1); strings(item.preservationBoundaries, 8, 1);
      ensure(item.sceneIds.every(id => scenes.has(id) && (!goal.chapterIds.length || goal.chapterIds.includes(scenes.get(id).chapterId))), '机会引用未知或超出目标范围的场景。');
      const sourceEvidence = evidenceList(item.sourceEvidence, input.chapters, 1), counterEvidence = evidenceList(item.counterEvidence, input.chapters);
      ensure([...sourceEvidence, ...counterEvidence].every(inGoal), '机会/反证超出冻结目标范围。');
      ensure(sourceEvidence.every(e => item.sceneIds.some(id => { const range = sceneRange(scenes.get(id)); return range.chapterId === e.chapterId && e.start >= range.start && e.start + e.quote.length <= range.end; })), '机会原文落点不在声明场景内。');
      if (disposition.decision === 'attempt') {
        const owners = checked.items.filter(item => disposition.planItemIds.includes(item.id));
        ensure(owners.length === 1 && item.sceneIds.every(id => owners[0].sceneIds.includes(id))
          && sourceEvidence.every(e => owners[0].targets.some(target => overlaps(e, target))), '机会的联动落点未完整进入同一原子修改组。');
      }
      opportunity = { ...item, sourceEvidence, counterEvidence };
    } else ensure(disposition.decision === 'preserve', '尝试增量须有一个具体机会；无安全机会可以保留。');
    const basis = assessment.materialBasis; exact(basis, ['kind','supplyIds','evidenceIds','reason']); text(basis.reason); strings(basis.supplyIds, 6); strings(basis.evidenceIds, 60);
    ensure(['original','supplied'].includes(basis.kind), '增量方案依据类型无效。');
    const used = checked.materialDecisions.filter(decision => decision.goalId === goal.id && decision.decision === 'used');
    if (basis.kind === 'original') ensure(!basis.supplyIds.length && !basis.evidenceIds.length && !used.length, '原创依据不得附会资料或隐藏实际用材。');
    else {
      const supplies = basis.supplyIds.map(id => input.retrieval.supplies.find(supply => supply.supplyId === id));
      ensure(supplies.length > 0 && supplies.every(supply => supply?.goalId === goal.id && input.applicability.directSupplyIds.includes(supply.supplyId)), '资料依据须为同目标已供应且direct_fit的材料。');
      const completeIds = [...new Set(supplies.flatMap(supply => supply.evidenceIds))];
      ensure(completeIds.length === basis.evidenceIds.length && completeIds.every(id => basis.evidenceIds.includes(id)), '增量依据须保留供应材料的完整精确证据，不能只取转折一侧。');
      if (disposition.decision === 'attempt') ensure(used.length === supplies.length && used.every(decision => {
        const supply = supplies.find(supply => supply.supplyId === decision.supplyId);
        return supply && decision.evidenceIds.length === supply.evidenceIds.length && supply.evidenceIds.every(id => decision.evidenceIds.includes(id));
      }), '资料依据与实际used账本或完整功能证据不一致。');
    }
    return { ...disposition, incrementalAssessment: { ...assessment, currentAchievementEvidence: achievement, opportunity } };
  });
  return checked;
}

function paragraphs(body) {
  const result = []; let start = 0;
  for (const match of body.matchAll(/(?:\r\n|\r(?!\n)|(?<!\r)\n)(?:[\t ]*(?:\r\n|\r(?!\n)|(?<!\r)\n))+/g)) {
    const end = match.index + match[0].length; result.push({ start, end }); start = end;
  }
  if (start < body.length) result.push({ start, end: body.length }); return result;
}
function mappedPosition(position, side, replacements) {
  let delta = 0;
  for (const replacement of replacements) {
    const start = replacement.sourceStart, end = start + replacement.sourceQuote.length;
    if (position < start || position === start && side === 'left') break;
    if (position < end) return start + delta + (side === 'right' ? replacement.replacement.length : 0);
    delta += replacement.replacement.length - replacement.sourceQuote.length;
  }
  return position + delta;
}
export function affectedSceneContexts(chapters, reading, plan, candidateChapters, candidateRevision) {
  return plan.items.filter(item => item.decision === 'revise').flatMap(item => item.sceneIds.map(id => {
    const scene = reading.sceneChanges.find(scene => scene.id === id), range = sceneRange(scene), chapter = chapters.find(chapter => chapter.id === range.chapterId);
    const spans = paragraphs(chapter.body), first = spans.findIndex(span => range.start < span.end), last = spans.findIndex(span => range.end <= span.end);
    const start = spans[Math.max(0, first - 1)].start, end = spans[Math.min(spans.length - 1, last + 1)].end;
    const source = { start, end, quote: chapter.body.slice(start, end), chapterBodySha256: hash(chapter.body), sceneStart: range.start, sceneEnd: range.end };
    if (!candidateChapters) return { planItemId: item.id, sceneId: id, chapterId: range.chapterId, source };
    const candidate = candidateChapters.find(chapter => chapter.id === range.chapterId), replacements = (candidateRevision?.replacements ?? []).filter(r => r.chapterId === range.chapterId).sort((a,b) => a.sourceStart - b.sourceStart);
    const candidateStart = mappedPosition(start, 'left', replacements), candidateEnd = mappedPosition(end, 'right', replacements);
    return { planItemId: item.id, sceneId: id, chapterId: range.chapterId, source,
      candidate: { start: candidateStart, end: candidateEnd, quote: candidate.body.slice(candidateStart, candidateEnd), chapterBodySha256: hash(candidate.body),
        sceneStart: mappedPosition(range.start, 'left', replacements), sceneEnd: mappedPosition(range.end, 'right', replacements) } };
  }));
}
function quoteTouchesActualChange(evidence, planItemId, replacements) {
  let delta = 0;
  for (const replacement of replacements.filter(r => r.chapterId === evidence.chapterId).slice().sort((a,b) => a.sourceStart - b.sourceStart)) {
    if (replacement.appliedPlanItemIds.includes(planItemId) && replacement.sourceQuote !== replacement.replacement) {
      const before = replacement.sourceQuote, after = replacement.replacement; let prefix = 0, suffix = 0;
      while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
      while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length-1-suffix] === after[after.length-1-suffix]) suffix++;
      const start = replacement.sourceStart + delta + prefix, end = replacement.sourceStart + delta + after.length - suffix;
      if (start === end ? evidence.start < start && evidence.start + evidence.quote.length > end
        : evidence.start < end && evidence.start + evidence.quote.length > start) return true;
    }
    delta += replacement.replacement.length - replacement.sourceQuote.length;
  }
  return false;
}
export function validateSceneDependencyReread(value, input) {
  if (!input.requestSpec.goalImprovementPolicy) return value;
  const checked = copy(value), contexts = input.affectedSceneContexts;
  checked.changeChecks = checked.changeChecks.map(item => {
    const planItem = input.plan.items.find(planItem => planItem.id === item.planItemId);
    ensure(Array.isArray(item.sceneDependencyChecks) && item.sceneDependencyChecks.length === 5, '复读缺少五类完整场景依赖检查。');
    const sceneDependencyChecks = item.sceneDependencyChecks.map((check, index) => {
      exact(check, ['kind','assessment','sourceEvidence','candidateEvidence','reason']); text(check.reason);
      ensure(check.kind === SCENE_DEPENDENCY_KINDS[index] && ['intact','broken','uncertain','removed_with_scene','not_applicable','not_attempted'].includes(check.assessment), '场景复读类别、顺序或判断无效。');
      const established = ['intact','broken','removed_with_scene'].includes(check.assessment);
      const sourceEvidence = evidenceList(check.sourceEvidence, input.sourceChapters, established ? 1 : 0), candidateEvidence = evidenceList(check.candidateEvidence, input.candidateChapters, established ? 1 : 0);
      const boundContexts = contexts.filter(context => context.planItemId === item.planItemId);
      for (const [side, entries] of [['source',sourceEvidence],['candidate',candidateEvidence]]) ensure(entries.every(e => boundContexts.some(context => context.chapterId === e.chapterId && e.start >= context[side].start && e.start + e.quote.length <= context[side].end)), '场景复读证据须位于本组受影响场景及相邻边界。');
      const planned = planItem.sceneDependencies[index];
      if (item.executionStatus !== 'applied') ensure(check.assessment === 'not_attempted' && !sourceEvidence.length && !candidateEvidence.length, '未执行场景检查不能宣称完整或损坏。');
      else {
        ensure(check.assessment !== 'not_attempted', '已执行组不能跳过场景依赖复核。');
        if (check.assessment === 'not_applicable') ensure(planned.handling === 'not_applicable' && !sourceEvidence.length && !candidateEvidence.length, '已有依赖不能在复读中无依据改称不适用。');
        if (check.assessment === 'removed_with_scene') ensure(planned.handling === 'remove_with_scene' && boundContexts.every(context => context.candidate.sceneStart === context.candidate.sceneEnd), '整场删除判断须对应实际完整删除，不能掩盖残留依赖。');
      }
      if (['broken','uncertain'].includes(check.assessment)) ensure(item.recommendation !== 'eligible_for_user_choice', '损坏或未证实闭合的场景依赖不能进入推荐采纳。', 'WHOLE_QUALITY_SCENE_DEPENDENCY');
      return { ...check, sourceEvidence, candidateEvidence };
    });
    if (item.goalAssessment === 'implemented' && planItem.goalIds.length) ensure(item.requirementChecks.some(check => check.assessment === 'supported'
      && check.evidence.some(e => quoteTouchesActualChange(e, item.planItemId, input.candidateReplacements))), '目标增量不能只引用未改变的基线已有实现。');
    return { ...item, sceneDependencyChecks };
  });
  return checked;
}

export const GOAL_OPPORTUNITY_GUIDANCE = '本次启用增量机会评估：明确已有实现的源文证据，再评估最多一个安全局部增量、反证、风险与保护范围。preserve须具体说明为何无安全增量或收益不足，不能仅说原稿已有主题。可完全原创或拒绝全部资料；不强制改稿。';
export const SCENE_DEPENDENCY_GUIDANCE = '检查整个受影响场景与两侧保留边界的说话人、出入场、动作、物件和交易依赖。删掉入场或交易设定后仍留下问答、代词、开关门等动作，可能切断上下文；这是假说，须以源/候选逐字证据判断，不能凭关键词拦截。需要联动修改的所有落点必须获授权且在同一原子组；范围不足就保留/跳过。删除完整场景可以合法，只要两侧承接成立。保护有效重复、含混、克制与留白。';
export const FUNCTION_COMPARISON_GUIDANCE = '按每份供应的完整来源证据与目标稿逐项比较四轴：行动者actor、转变方向emotionalDirection、承认对象acknowledgmentObject、代价承担者costBearer。把来源事实/假说、目标稿对应依据、反证和不匹配写进现有reason与transferBoundary；无直接适用时写noSuitableReasons。unknown不等于已知、更不默认direct_fit；仅当精确来源和目标上下文能独立支持这四项相关迁移时才可direct_fit，否则保留insufficient_context/mechanism_only/inapplicable。不把题材、同名情绪词或人物承认他人价值误作自己承担责任。所有材料可拒绝。';
// Only the corrected composition request version uses these strings; historical inputs retain their exact guidance.
export const COMPARABLE_FUNCTION_TRANSFER_GUIDANCE = '按每份供应的完整来源证据与目标稿比较行动者actor、转变方向emotionalDirection、承认对象acknowledgmentObject、代价承担者costBearer，把真实对应、差异、反证与迁移限制写入现有reason和transferBoundary。边界禁项只能来自冻结输入，在现有reason/transferBoundary引用对应字段路径及原句，不得从来源情节推造目标禁项。不移植来源人物、关系、情节或原句，不等于禁止借用其有证据支持的功能。可以只借一个功能支持目标的一个明确子目标，不要求来源题材、四轴身份或整条情节与目标全部相同；说明哪些差异可安全抽离，哪些会使该功能失去证据支持。unknown不能默认fit；所借功能必需的环节证据不足时仍为insufficient_context/mechanism_only/inapplicable，不能拿主题相似或别人的代价冒充本人的承担。direct_fit只证明这个有限功能对相应子目标适用，不证明整个目标或文学效果已实现。全部拒绝与noSuitableReasons仍合法。';
export const ORIGINAL_INCREMENT_GUIDANCE = '保护范围与禁止事项须逐项依据输入真实边界，不得臆造。无direct_fit只取消该来源作为直接用材依据，不取消原创增量评估；单功能可服务一个子目标，不要求每份来源解决整个目标。不要把所有增量等同于新增承认台词、心理解释或说教；须依据现有动作、选择及其后果评估是否存在安全局部机会，也允许判断没有。比较已有实现、可能增量与反证；无安全机会或收益不足可具体说明后preserve，不强迫引用、改稿或制造机会。';
