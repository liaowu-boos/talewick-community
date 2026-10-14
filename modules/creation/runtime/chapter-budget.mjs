export const CHAPTER_BUDGET_VERSION = 'chapter-budget-1';
export const CHAPTER_BUDGET_GUIDANCE_VERSION = 'chapter-budget-guidance-4';
const text = value => typeof value === 'string' ? value.trim() : '';
const positiveHan = value => Number.isSafeInteger(value) && value > 0 && value <= 30_000;
const countHan = body => (body.match(/\p{Script=Han}/gu) ?? []).length;

/** Validate a new plan's narrative allocations without redistributing chapter lengths. */
export function normalizeChapterBudgets(chapters, requirements) {
  const normalized = chapters.map((chapter, index) => {
    if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) throw new Error(`故事规划第 ${index + 1} 章必须是有效对象。`);
    const { targetHanMin: min, targetHan: target, targetHanMax: max } = chapter;
    if (![min, target, max].every(positiveHan) || min > target || target > max) {
      throw new Error(`故事规划第 ${index + 1} 章需要正整数 targetHanMin ≤ targetHan ≤ targetHanMax，且均不超过 30000。`);
    }
    if (!Array.isArray(chapter.scenes) || !chapter.scenes.length || chapter.scenes.some(scene => !text(scene)) || !text(chapter.continuity)) {
      throw new Error(`故事规划第 ${index + 1} 章需要 scenes（具体场景与行动结果的非空字符串数组）及 continuity（前后衔接或结局收束）。`);
    }
    return { ...chapter, targetHanMin: min, targetHan: target, targetHanMax: max,
      scenes: chapter.scenes.map(text), continuity: text(chapter.continuity) };
  });
  const total = normalized.reduce((sum, chapter) => sum + chapter.targetHan, 0);
  if ((Number.isFinite(requirements.targetHanMin) && total < requirements.targetHanMin)
    || (Number.isFinite(requirements.targetHanMax) && total > requirements.targetHanMax)) {
    throw new Error(`故事规划各章 targetHan 合计 ${total}，不在本次全书 ${requirements.targetHanMin}–${requirements.targetHanMax} 汉字范围内；请按情节容量调整方案，不平均分摊或靠重复情节凑数。`);
  }
  return normalized;
}

/** Read-only guidance derived from actual saved prose; never creates a padding/revision task. */
export function chapterWritingBudget({ requirements, plan, chapterIndex, previousChapters }) {
  const wholeMin = Number.isFinite(requirements.targetHanMin) ? requirements.targetHanMin : null;
  const wholeMax = Number.isFinite(requirements.targetHanMax) ? requirements.targetHanMax : null;
  const counts = previousChapters.map(chapter => ({ id: chapter.id, hanCount: countHan(chapter.body) }));
  const writtenHan = counts.reduce((sum, chapter) => sum + chapter.hanCount, 0);
  const remaining = plan.chapters.slice(chapterIndex);
  const future = plan.chapters.slice(chapterIndex + 1);
  const sumIfKnown = field => remaining.every(chapter => positiveHan(chapter[field]))
    ? remaining.reduce((sum, chapter) => sum + chapter[field], 0) : null;
  const futureSumIfKnown = field => future.every(chapter => positiveHan(chapter[field]))
    ? future.reduce((sum, chapter) => sum + chapter[field], 0) : null;
  const current = plan.chapters[chapterIndex];
  const target = positiveHan(current.targetHan) ? current.targetHan : null;
  const min = positiveHan(current.targetHanMin) ? current.targetHanMin : null;
  const max = positiveHan(current.targetHanMax) ? current.targetHanMax : null;
  const remainingMin = wholeMin === null ? null : Math.max(0, wholeMin - writtenHan);
  const remainingMax = wholeMax === null ? null : Math.max(0, wholeMax - writtenHan);
  const plannedMin = sumIfKnown('targetHanMin');
  const plannedMax = sumIfKnown('targetHanMax');
  const plannedTarget = sumIfKnown('targetHan');
  const futurePlannedMin = futureSumIfKnown('targetHanMin');
  const futurePlannedTarget = futureSumIfKnown('targetHan');
  const targetAllowance = wholeMax === null || futurePlannedTarget === null ? null
    : Math.max(0, wholeMax - writtenHan - futurePlannedTarget);
  const maxAllowance = wholeMax === null || futurePlannedMin === null ? null
    : Math.max(0, wholeMax - writtenHan - futurePlannedMin);
  const planRangeKnown = min !== null && target !== null && max !== null;
  const insufficientCurrentMinimum = planRangeKnown && maxAllowance !== null && maxAllowance < min;
  const noSafeHeadroom = insufficientCurrentMinimum && maxAllowance === 0;
  const executableRange = planRangeKnown && !insufficientCurrentMinimum;
  const boundedMax = executableRange ? (maxAllowance === null ? max : Math.min(max, maxAllowance)) : null;
  const preferredTarget = executableRange ? (targetAllowance === null ? target : Math.min(target, targetAllowance)) : null;
  const operationalTarget = executableRange ? Math.min(boundedMax, Math.max(min, preferredTarget)) : null;
  const operationalMin = executableRange ? Math.min(min, operationalTarget) : null;
  const operationalMax = executableRange ? boundedMax : null;
  const constrained = (target !== null && operationalTarget !== target) || (max !== null && operationalMax !== max);
  const operationalStatus = !planRangeKnown ? 'plan_range_unavailable'
    : noSafeHeadroom ? 'no_safe_headroom'
      : insufficientCurrentMinimum ? 'insufficient_current_minimum_capacity'
        : constrained ? 'constrained_by_actual_prose' : 'planned_range_available';
  return {
    policyVersion: CHAPTER_BUDGET_GUIDANCE_VERSION,
    planPolicyVersion: CHAPTER_BUDGET_VERSION,
    planOrigin: plan.lengthPolicyVersion === CHAPTER_BUDGET_VERSION ? 'planned_ranges' : 'legacy_plan',
    countScope: '仅已写章节正文的 Unicode Script=Han；不含书名、章节标题、标点、空格或拉丁字母。',
    whole: { min: wholeMin, max: wholeMax },
    written: { hanCount: writtenHan, chapters: counts },
    currentChapter: { id: current.id, min, target, max },
    operationalChapter: {
      id: current.id, min: operationalMin, target: operationalTarget, max: operationalMax,
      status: operationalStatus, executable: executableRange,
      targetAllowance, maxAllowance, availableHan: maxAllowance,
      shortfallToPlannedMin: maxAllowance === null || min === null ? null : Math.max(0, min - maxAllowance),
      futureReserve: { chapterCount: future.length, plannedMin: futurePlannedMin, plannedTarget: futurePlannedTarget },
      nonTruncationRule: '控制展开尺度，不裁切模型返回正文；必要行动、因果交接和结局仍须完整。',
      fallbackAction: executableRange ? null : planRangeKnown
        ? '没有满足计划最低容量的可执行范围；按批准计划完整写完必要行动，终检依据实际完成正文判定篇幅是否满足。'
        : '计划没有完整章节范围；不虚构预算，按批准计划完成必要行动，终检依据实际完成正文判定篇幅是否满足。',
    },
    remaining: { includesCurrentChapter: true, chapterCount: remaining.length,
      min: remainingMin, max: remainingMax, plannedMin, plannedTarget, plannedMax },
    overrunHan: wholeMax === null ? 0 : Math.max(0, writtenHan - wholeMax),
    projectedTotalHan: plannedTarget === null ? null : writtenHan + plannedTarget,
    rangeConflict: (remainingMax !== null && plannedMin !== null && remainingMax < plannedMin)
      || (remainingMin !== null && plannedMax !== null && remainingMin > plannedMax),
    guidance: 'operationalChapter 由真实已写汉字、全书上限和后续计划容量派生。max 先为后续章保留计划最低容量；target 尝试再保留后续目标。只有剩余容量不少于本章计划最低容量时，min/target/max 才是可执行范围。若 status=insufficient_current_minimum_capacity 或 no_safe_headroom，范围字段为 null，availableHan 保留真实余额，shortfallToPlannedMin 明示缺口；小于当前章计划最低容量的余额不能作为可执行章目标。此时仍按批准计划完成必要行动、因果交接与结局，不返回空章、摘要或截断正文；终检依据实际完成正文判定篇幅是否满足。程序不会静默裁切模型返回文本，也不会改写批准计划；旧规划缺失的范围保持未知，不虚构分配。',
  };
}
