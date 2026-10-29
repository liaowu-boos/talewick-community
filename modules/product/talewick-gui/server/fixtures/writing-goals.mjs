// Invented inputs for local validation; no historical manuscript or provider response.
export function writingGoalRequest(suffix = 'one') {
  return { projectId: 'synthetic-project', requestId: 'synthetic-request', kind: 'revise',
    revisionMode: 'whole-manuscript-v2', projectTitle: '合成测试', idea: '用行动表现人物选择。',
    instruction: '保留现有冲突，检查行动是否支持选择。', baseRevision: 'synthetic-base',
    chapters: Array.from({length: 10}, (_, i) => ({id: `ch-${i+1}`, title: `合成章${i+1}`, body: `测试人物在第${i+1}次巡查时记录门锁状态。`})),
    writingGoals: {schemaVersion: 'creation-writing-goals-1', goals: [{id: `goal-${suffix}`, dimension: 'choice', chapterIds: ['ch-2'],
      problem: {problemId: `goal-${suffix}`, statement: `合成目标${suffix}：用具体行动表现选择。`, searchTerms: ['选择', '行动'], requiredTermGroups: [['选择']], context: {boundaries: ['保留人物分歧。']}},
      preservationBoundaries: ['保留人物分歧，不复制参考来源的原句。']}]}
  };
}
