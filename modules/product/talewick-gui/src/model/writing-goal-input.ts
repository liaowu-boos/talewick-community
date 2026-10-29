import type { RuntimeRequest } from './types';

export type WritingGoalDimension = 'psychology' | 'emotion' | 'choice';
export type WritingGoalsInput = NonNullable<RuntimeRequest['writingGoals']>;
export const writingGoalLabels: Record<WritingGoalDimension, string> = {
  psychology: '心理转折', emotion: '情绪推进', choice: '人物选择与代价',
};
const terms: Record<WritingGoalDimension, string[]> = {
  psychology: ['心理', '认知', '经历', '触发', '变化', '行动', '选择', '后果'],
  emotion: ['情绪', '压抑', '期待', '失望', '变化', '行动', '爆发', '后果'],
  choice: ['选择', '决定', '责任', '风险', '行动', '代价', '后果', '承担'],
};
const concreteTerms = ['劳动', '照护', '照顾', '付出', '忽视', '承认', '尊重', '认可', '边界',
  '自保', '保全', '隐瞒', '信任', '工作', '职业', '同事', '委屈', '愤怒', '释然', '失落'];

// These fixed lexical anchors start a bounded query, not a suitability decision.
// The user's complete wording and boundaries remain available to applicability.
export function makeWritingGoalInput(dimension: WritingGoalDimension, text: string, boundary = ''): WritingGoalsInput {
  const statement = text.trim(), preserved = boundary.trim();
  if (!terms[dimension] || !statement || statement.length > 2000 || preserved.length > 1000) {
    throw new Error('请填写2000字以内的具体写作目标；保留边界不超过1000字。');
  }
  const base = terms[dimension];
  const specific = concreteTerms.filter(term => statement.includes(term) && !base.includes(term)).slice(0, 12);
  const id = `ui-writing-goal-${dimension}`;
  const preservationBoundaries = [...new Set([
    '保留原稿人物、视角、核心事实及已确认的结局边界。',
    '不得复制参考小说的原句、人物、情节或结局。',
    '写作目标不是已诊断缺陷；已满足、资料不适用或没有安全改法时保留原稿并说明。',
    ...(preserved ? [preserved] : []),
  ])];
  return {schemaVersion:'creation-writing-goals-1',goals:[{id,dimension,chapterIds:[],preservationBoundaries,
    problem:{problemId:id,statement,searchTerms:[...base,...specific],
      requiredTermGroups:[base.slice(0,4),base.slice(4),...(specific.length?[specific]:[])],
      context:{genre:'按现有稿件',perspective:'保持原稿视角',boundaries:preservationBoundaries}},
  }]};
}
