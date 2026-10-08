export const CHAPTER_BUDGET_VERSION = 'chapter-budget-1';
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
  const sumIfKnown = field => remaining.every(chapter => positiveHan(chapter[field]))
    ? remaining.reduce((sum, chapter) => sum + chapter[field], 0) : null;
  const current = plan.chapters[chapterIndex];
  const target = positiveHan(current.targetHan) ? current.targetHan : null;
  const min = positiveHan(current.targetHanMin) ? current.targetHanMin : null;
  const max = positiveHan(current.targetHanMax) ? current.targetHanMax : null;
  const remainingMin = wholeMin === null ? null : Math.max(0, wholeMin - writtenHan);
  const remainingMax = wholeMax === null ? null : Math.max(0, wholeMax - writtenHan);
  const plannedMin = sumIfKnown('targetHanMin');
  const plannedMax = sumIfKnown('targetHanMax');
  const plannedTarget = sumIfKnown('targetHan');
  return {
    policyVersion: CHAPTER_BUDGET_VERSION,
    planOrigin: plan.lengthPolicyVersion === CHAPTER_BUDGET_VERSION ? 'planned_ranges' : 'legacy_plan',
    countScope: '仅已写章节正文的 Unicode Script=Han；不含书名、章节标题、标点、空格或拉丁字母。',
    whole: { min: wholeMin, max: wholeMax },
    written: { hanCount: writtenHan, chapters: counts },
    currentChapter: { id: current.id, min, target, max },
    remaining: { includesCurrentChapter: true, chapterCount: remaining.length,
      min: remainingMin, max: remainingMax, plannedMin, plannedTarget, plannedMax },
    overrunHan: wholeMax === null ? 0 : Math.max(0, writtenHan - wholeMax),
    projectedTotalHan: plannedTarget === null ? null : writtenHan + plannedTarget,
    rangeConflict: (remainingMax !== null && plannedMin !== null && remainingMax < plannedMin)
      || (remainingMin !== null && plannedMax !== null && remainingMin > plannedMax),
    guidance: '篇幅范围用于安排展开尺度。根据已写量和后续情节容量控制本章节奏，不均摊剩余字数，不把短章差额变成后章补字任务。场景任务完成即可自然收束；仍须完成必要行动、因果交接与结局，不能因预算不足截断故事。旧规划缺失的范围保持未知，不虚构分配。',
  };
}
