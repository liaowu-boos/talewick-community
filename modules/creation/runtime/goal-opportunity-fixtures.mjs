// Offline schema fixtures only: no provider, no literary approval, no production callback.
import { GOAL_OPPORTUNITY_POLICY_VERSION, SCENE_DEPENDENCY_KINDS } from './goal-opportunity.mjs';

export const policy = () => ({ schemaVersion: GOAL_OPPORTUNITY_POLICY_VERSION, mode: 'assess_incremental', maxOpportunitiesPerGoal: 1 });
const clone = value => structuredClone(value);
const ev = (chapterId, quote, purpose = '离线精确位置夹具') => ({ chapterId, quote, purpose });
const extraEv = (chapterId, quote, purpose = '离线精确位置夹具') => ({ chapterId, quote, start: null, purpose });

export function fixture({ family = false, preserve = false, wholeSceneRemoval = false, enabled = true, writingGoals = true } = {}) {
  let chapters, sceneQuote, targetQuote, replacement, protectedQuote, knownCandidate;
  if (family) {
    // Original synthetic scene; no manuscript or captured model response is loaded.
    chapters = [{ id: 'ch-1', title: '离线场景', body: '仓库门打开了。\n\n十点多，快递员推车走进库房。\n\n“包裹呢？”\n\n“不寄。”\n\n“确定后再联系。”他收好运单。\n\n管理员锁上柜子，转身离开。' }];
    knownCandidate = { ...chapters[0], body: chapters[0].body.replace('十点多，快递员推车走进库房。', '十点多，快递员从门外经过，没有进来。') };
    const body = chapters[0].body, start = body.indexOf('十点多，快递员推车走进库房。'), last = '“确定后再联系。”他收好运单。';
    sceneQuote = body.slice(start, body.indexOf(last, start) + last.length);
    targetQuote = wholeSceneRemoval ? sceneQuote : sceneQuote.split('\n\n')[0];
    replacement = wholeSceneRemoval ? '' : '十点多，快递员从门外经过，没有进来。';
    protectedQuote = '管理员锁上柜子，转身离开。';
  } else {
    chapters = [{ id: 'ch-1', title: '离线流程夹具', body: '下班铃响了。\n\n她把清单放回桌上。\n\n她关了门，没有再解释。' }];
    sceneQuote = targetQuote = '她把清单放回桌上。';
    replacement = '她把清单放回桌上，把自己的名字写进未完成的一栏。';
    protectedQuote = '她关了门，没有再解释。';
  }
  const chapterId = chapters[0].id, events = [], artifacts = {}, inputs = {};
  const request = { kind: 'revise', revisionMode: 'whole-manuscript-v2', projectTitle: '离线流程夹具', instruction: '评估既有行动中的一个有限增量，保留原有边界；允许不改。', baseRevision: 'fixture-base-1', chapters,
    ...(writingGoals ? { writingGoals: { schemaVersion: 'creation-writing-goals-1', goals: [{ id: 'bounded-choice', dimension: 'choice',
      problem: { problemId: 'bounded-choice', statement: '评估已有选择与行动的有限增量，不预设缺陷，不制造新事故或强迫和解。', searchTerms: ['选择','代价'], requiredTermGroups: [], context: {} },
      chapterIds: [chapterId], preservationBoundaries: ['保护原有克制与关系边界，不复制来源情节。'] }] } } : {}),
    ...(enabled ? { goalImprovementPolicy: policy() } : {}) };
  const sourceCitation = quote => extraEv(chapterId, quote);
  const candidateBody = chapters[0].body.replace(targetQuote, replacement);
  const originalBasis = { kind: 'original', supplyIds: [], evidenceIds: [], reason: '本夹具无资料供应，仅基于既有动作作局部安排；不主张文学改善。' };
  const dependencyPlan = () => SCENE_DEPENDENCY_KINDS.map(kind => {
    if (wholeSceneRemoval) return { kind, handling: 'remove_with_scene', sourceEvidence: [sourceCitation(sceneQuote)], targetIds: ['target-1'], reason: '删除完整旧场景而非仅移除入场设定，保留两侧原文。' };
    if (!family) return { kind, handling: ['action','object'].includes(kind) ? 'revise' : 'not_applicable',
      sourceEvidence: ['action','object'].includes(kind) ? [sourceCitation(sceneQuote)] : [], targetIds: ['action','object'].includes(kind) ? ['target-1'] : [], reason: ['action','object'].includes(kind) ? '在同一清单动作中补入选择，原句整体获授权。' : '本局部没有对白、入离场或交易依赖。' };
    const quotation = kind === 'speaker' ? '“包裹呢？”' : kind === 'action' ? '“确定后再联系。”他收好运单。'
      : kind === 'object' ? '“不寄。”' : targetQuote;
    return { kind, handling: ['presence','transaction'].includes(kind) ? 'revise' : 'preserve', sourceEvidence: [sourceCitation(quotation)],
      targetIds: ['presence','transaction'].includes(kind) ? ['target-1'] : [], reason: '重放历史局部删除的依赖选择；是否成立留给完整复读，不预授采纳。' };
  });
  const model = { complete: async args => {
    events.push(args.stage);
    if (args.stage.endsWith(':format-repair')) throw Object.assign(new Error(JSON.parse(args.user).repairInput.error), { code: JSON.parse(args.user).repairInput.errorCode });
    const input = JSON.parse(args.user); inputs[args.stage] = clone(input);
    const bindings = clone(input.responseBindings);
    if (args.stage === 'whole-quality:reading') return JSON.stringify({ ...bindings, coverage: { status: 'complete', omissions: [] }, synopsis: '离线流程测试；记录原文行动，不产生文学评语。',
      sceneChanges: [{ id: 'scene-1', chapterId, sequence: 1, entryEvidence: ev(chapterId, sceneQuote.split('\n\n')[0]), exitEvidence: ev(chapterId, sceneQuote.split('\n\n').at(-1)),
        beforeState: '沿用原有处境', trigger: '原文事件', action: '原文动作', afterState: '保留原文后果', cost: '已有选择代价', narrativeFunction: '局部行动承接', preservedStrengths: [] }],
      issues: [], strengths: [ev(chapterId, protectedQuote)], unresolved: [] });
    if (args.stage === 'whole-quality:plan') {
      const plannedPreserve = preserve || !writingGoals;
      const item = { id: 'plan-1', issueIds: [], goalIds: ['bounded-choice'], decision: 'revise', scope: 'linked_scenes', affectedChapterIds: [chapterId], sceneIds: ['scene-1'],
        targets: [{ id: 'target-1', sceneId: 'scene-1', ...ev(chapterId, targetQuote) }],
        actionRequirements: [{ id: 'requirement-1', description: wholeSceneRemoval ? '完整移除旧场景并连读相邻场景' : '在授权局部调整行动并核对保留依赖', targetIds: ['target-1'], expectedVisibleChange: '局部操作实际可见', failureCriterion: '依赖断裂或只有计划陈述' }],
        action: '在授权范围作一次局部尝试。', rationale: '比较可能增量与既有实现。', expectedEffect: '减少行动解释与实际选择的距离。', failureCriteria: '切断场景依赖。', risks: ['可能损伤原有含混。'],
        preserve: [ev(chapterId, protectedQuote)], adoptedSupplyIds: [], independentAdoption: '该组独立，其他组不采纳也不影响本组。', ...(enabled ? { sceneDependencies: dependencyPlan() } : {}) };
      return JSON.stringify({ ...bindings, decision: plannedPreserve ? 'preserve_original' : 'revise', summary: plannedPreserve ? '已有局部实现且安全增量不足，保留。' : '只作一个有界机会尝试。', items: plannedPreserve ? [] : [item],
        materialDecisions: [], unresolved: [], ...(writingGoals ? { goalDispositions: [{ goalId: 'bounded-choice', decision: plannedPreserve ? 'preserve' : 'attempt', planItemIds: plannedPreserve ? [] : ['plan-1'],
          reason: plannedPreserve ? '增加解释会覆盖现有动作和停顿，当前没有更安全的局部增量。' : '局部可由同组完整处理并保留边界。',
          ...(enabled ? { incrementalAssessment: { currentAchievement: 'partial', currentAchievementEvidence: [sourceCitation(sceneQuote.split('\n\n')[0])], currentAchievementReason: '已有动作承载选择；增量须与这部分分列。',
            opportunity: plannedPreserve ? null : { sceneIds: ['scene-1'], sourceEvidence: [sourceCitation(targetQuote)], expectedIncrement: '尝试改变行动承接，不把已有实现重新记为新增。', counterEvidence: [sourceCitation(protectedQuote)], risks: ['场景接续可能损坏。'], preservationBoundaries: ['保持原有克制与关系边界。'] },
            opportunityAssessment: plannedPreserve ? 'preserve' : 'attempt', opportunityReason: plannedPreserve ? '现有动作之后的沉默已有作用；需要新增设定才能进一步强化，因此保留。' : '已有上下文支持一个局部尝试，复读仍可否定。', materialBasis: originalBasis } } : {}) }] } : {}) });
    }
    if (args.stage === 'whole-quality:feasibility') return JSON.stringify({ ...bindings, checks: [{ planItemId: 'plan-1', assessment: 'feasible', reason: '原文替换范围确实获授权，语义效果留待复读。',
      requirementChecks: [{ requirementId: 'requirement-1', assessment: 'supported', reason: '可以整体替换指定范围。', targetIds: ['target-1'] }], sourceEvidence: [ev(chapterId, targetQuote)], blockingReasons: [], limitations: ['可行不证明闭合或改善。'] }] });
    if (args.stage === 'whole-quality:revision') return JSON.stringify({ ...bindings, replacements: [{ targetId: 'target-1', chapterId, sourceQuote: targetQuote, replacement, appliedPlanItemIds: ['plan-1'], notes: ['离线固定替换，不生成额外版本。'] }], skippedPlanItems: [] });
    if (args.stage === 'whole-quality:reread') {
      const changed = input.execution.length > 0;
      const seamQuote = wholeSceneRemoval ? input.affectedSceneContexts[0].candidate.quote : replacement;
      const dependencyChecks = !enabled || !changed ? undefined : SCENE_DEPENDENCY_KINDS.map((kind, index) => {
        const planned = input.plan.items[0]?.sceneDependencies[index];
        const applicable = planned?.handling !== 'not_applicable';
        return { kind, assessment: !applicable ? 'not_applicable' : wholeSceneRemoval ? 'removed_with_scene' : family && ['speaker','presence','action'].includes(kind) ? 'broken' : 'intact',
          sourceEvidence: applicable ? [sourceCitation(wholeSceneRemoval ? sceneQuote : planned.sourceEvidence[0].quote)] : [],
          candidateEvidence: applicable ? [extraEv(chapterId, wholeSceneRemoval ? seamQuote : family && ['speaker','action','object'].includes(kind) ? planned.sourceEvidence[0].quote : replacement)] : [],
          reason: !applicable ? '源场景无该依赖。' : wholeSceneRemoval ? '源场景完整移除，候选接缝两侧原文仍连贯。' : family && ['speaker','presence','action'].includes(kind) ? '源文快递员入场被删，候选仍保留问包裹与收好运单的动作，缺少当场参与者。' : '源与候选定位均保留该局部依赖。' };
      });
      return JSON.stringify({ ...bindings, coverage: { status: 'complete', omissions: [] }, summary: '离线复读结构夹具；不作为文学质量结论。',
        changeChecks: !changed ? [] : [{ planItemId: 'plan-1', executionStatus: 'applied', goalAssessment: 'implemented', coherenceAssessment: 'consistent', reason: '仅表示操作出现；场景依赖另行否定坏组。',
          requirementChecks: [{ requirementId: 'requirement-1', assessment: 'supported', reason: '候选确有变更或删除接缝。', evidence: [ev(chapterId, seamQuote)] }], risks: family && !wholeSceneRemoval ? ['场景依赖损坏。'] : [],
          recommendation: family && !wholeSceneRemoval ? 'not_recommended' : 'eligible_for_user_choice', ...(enabled ? { sceneDependencyChecks: dependencyChecks } : {}) }],
        introducedIssues: [], unresolvedItems: family && !wholeSceneRemoval && changed ? ['未解决：快递员未入场与保留对话/关门动作缺少衔接。'] : [], preservedStrengths: [ev(chapterId, protectedQuote)] });
    }
    throw new Error(`Unexpected offline stage ${args.stage}`);
  } };
  const options = { request, model, checkpoint: async (key,value) => { artifacts[key] = clone(value); },
    ...(writingGoals ? { queryDeepReferences: async () => { throw new Error('OFFLINE_NO_DATA_SUPPLIED'); } } : {}) };
  return { request, model, options, events, artifacts, inputs, chapters, candidateBody, knownCandidate, sceneQuote, targetQuote, replacement, protectedQuote };
}
