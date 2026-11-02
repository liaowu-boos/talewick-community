// Synthetic local input, unrelated to real stories or saved provider judgments.
import { productManuscriptRevision } from '../full15-service.mjs';

export function followupRequest({ enabled = true, requestId = 'followup-request' } = {}) {
  const projectTitle = '离线请求绑定夹具';
  const chapters = [{ id: 'ch-1', title: '清单', body: '下班铃响了。\n\n她把清单放回桌上。\n\n她关了门，没有再解释。' }];
  return { projectId: 'followup-fixture', projectTitle, requestId, kind: 'revise', revisionMode: 'whole-manuscript-v2',
    idea: '离线请求绑定测试', context: { character: '', world: '', plot: '', theme: '' }, materials: [], style: null,
    instruction: '保留原有边界，仅尝试有依据的有限修改。', quote: '', chapters,
    baseRevision: productManuscriptRevision(projectTitle, chapters),
    writingGoals: { schemaVersion: 'creation-writing-goals-1', goals: [{ id: 'bounded-choice', dimension: 'choice',
      problem: { problemId: 'bounded-choice', statement: '评估行动中有限的选择增量，允许保留原稿。', searchTerms: ['选择', '代价'], requiredTermGroups: [], context: {} },
      chapterIds: ['ch-1'], preservationBoundaries: ['不添加新人物或事故。'],
      ...(enabled ? { componentFallback: { schemaVersion: 'whole-quality-component-fallback-policy-1', enabled: true,
        components: [{ id: 'responsibility', facet: 'action_mechanism', statement: '通过明确行动承担责任。',
          searchTerms: ['责任', '承担'], requiredTermGroups: [['责任', '承担']] }] } } : {}),
    }] },
    ...(enabled ? { revisionEvidencePolicy: { schemaVersion: 'whole-quality-revision-evidence-policy-1', mode: 'required' } } : {}),
  };
}
