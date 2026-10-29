export const WRITING_GOALS_VERSION = 'creation-writing-goals-1';
export const WRITING_GOAL_DATA_OPTIONS = Object.freeze({
  dimensions: Object.freeze(['emotionalProgression', 'psychologicalChangeDrivers', 'observableCraftDecisionHypotheses']),
  maxFunctionsPerResult: 3, maxEvidenceRefsPerResult: 10,
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireThat = (condition, message) => {
  if (!condition) throw Object.assign(new Error(message), { code: 'WRITING_GOALS_REQUEST' });
};
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim();
function exact(value, keys) {
  requireThat(object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), '写作目标字段不完整或含未知字段。');
}
function strings(value, max, itemMax, min = 0) {
  requireThat(Array.isArray(value) && value.length >= min && value.length <= max
    && value.every(item => text(item, itemMax)) && new Set(value).size === value.length, '写作目标列表无效或重复。');
}

/** Explicit user intent, not a diagnosis or a claim that a source is suitable. */
export function validateWritingGoals(value, chapters) {
  if (value === undefined) return undefined;
  exact(value, ['schemaVersion', 'goals']);
  requireThat(value.schemaVersion === WRITING_GOALS_VERSION && Array.isArray(value.goals)
    && value.goals.length > 0 && value.goals.length <= 3, '写作目标须使用已知版本并包含1–3项。');
  const ids = new Set();
  for (const goal of value.goals) {
    exact(goal, ['id', 'dimension', 'problem', 'chapterIds', 'preservationBoundaries']);
    requireThat(text(goal.id, 120) && !ids.has(goal.id), '写作目标ID无效或重复。'); ids.add(goal.id);
    requireThat(['psychology', 'emotion', 'choice'].includes(goal.dimension), '写作目标维度无效。');
    const problem = goal.problem;
    exact(problem, ['problemId', 'statement', 'searchTerms', 'requiredTermGroups', 'context']);
    requireThat(problem.problemId === goal.id && text(problem.statement, 2000), '写作目标与DATA问题身份或原文不一致。');
    strings(problem.searchTerms, 20, 80, 2);
    requireThat(Array.isArray(problem.requiredTermGroups) && problem.requiredTermGroups.length <= 8, '必需词组超限。');
    for (const group of problem.requiredTermGroups) {
      strings(group, 20, 80, 1);
      requireThat(group.every(term => problem.searchTerms.includes(term)), '必需词组须来自冻结检索词。');
    }
    requireThat(object(problem.context) && JSON.stringify(problem.context).length <= 6000, 'DATA问题上下文无效或超限。');
    strings(goal.chapterIds, 30, 200);
    requireThat(!chapters || goal.chapterIds.every(id => chapters.some(chapter => chapter.id === id)), '写作目标引用未知章节。');
    strings(goal.preservationBoundaries, 8, 1000, 1);
  }
  requireThat(JSON.stringify(value).length <= 16000, '写作目标总量超限。');
  return structuredClone(value);
}

export const writingGoalSubjectId = goal => `writing-goal:${goal.id}`;
export function writingGoalSubjects(requestSpec) {
  return (requestSpec.writingGoals?.goals ?? []).map(goal => ({ id: writingGoalSubjectId(goal), writingGoal: goal }));
}
export function writingGoalQuerySubject(goal, sourceIds) {
  return { issueId: writingGoalSubjectId(goal), question: goal.problem.statement,
    storyProblem: '用户明确的写作目标；不是已诊断缺陷，不要求制造问题或修改原稿。',
    expectedEffect: goal.problem.statement,
    failureCriterion: '不得违背冻结brief和保留边界；不适用、无安全改法或原稿已足够时明确保留，不强制采用。',
    counterConsideration: goal.preservationBoundaries.join('；'), sceneQueries: goal.problem.searchTerms.slice(0, 3),
    ...(sourceIds === undefined ? {} : { sourceIds: structuredClone(sourceIds) }) };
}

/** byIssue remains diagnoses only; byGoal uses an explicitly labelled DATA transport subject. */
export const wholeQualityRetrievalEntries = retrieval => [...retrieval.byIssue, ...(retrieval.byGoal ?? [])];
