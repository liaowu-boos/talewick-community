import { runWorkflow } from '../../../creation/runtime/workflow.mjs';
import { engineBinding } from './engines.mjs';
import { WHOLE_QUALITY_MODEL_POLICY } from './model-policy.mjs';

export const WHOLE_MANUSCRIPT_REVISION_MODE = 'whole-manuscript-v1';
export const WHOLE_MANUSCRIPT_QUALITY_MODE = 'whole-manuscript-v2';
const loadWholeRevisionRunner = async () => {
  const runtime = await import('../../../creation/runtime/whole-manuscript-revision.mjs');
  if (typeof runtime.runWholeManuscriptRevision !== 'function') throw new Error('整稿修订运行时未提供约定入口。');
  return runtime.runWholeManuscriptRevision;
};
const loadWholeQualityRunner = async () => {
  const runtime = await import('../../../creation/runtime/whole-manuscript-quality.mjs');
  if (typeof runtime.runCrossChapterAwareWholeManuscriptQualityRevision !== 'function') throw new Error('整稿质量运行时未提供跨章兼容入口。');
  return runtime.runCrossChapterAwareWholeManuscriptQualityRevision;
};
const loadAIController = async () => {
  const runtime = await import('./agent-ai-sdk.mjs');
  if (typeof runtime.createAIController !== 'function') throw new Error('AI SDK 控制器未提供约定入口。');
  return runtime.createAIController;
};

export function createWorkflowRouter({ config, agentModel, retrieveKnowledge, queryDeepReferences, queryNarrativeObservations, wholeRevisionRunner, wholeQualityRunner }) {
  return async args => {
    if (args.request?.kind === 'revise' && args.request.revisionMode === WHOLE_MANUSCRIPT_QUALITY_MODE) {
      const run = wholeQualityRunner ?? await loadWholeQualityRunner();
      return run({ ...args, modelPolicy: WHOLE_QUALITY_MODEL_POLICY, retrieveKnowledge,
        ...(typeof queryDeepReferences === 'function' ? { queryDeepReferences } : {}),
        ...(typeof queryNarrativeObservations === 'function' ? { queryNarrativeObservations } : {}) });
    }
    if (args.request?.kind === 'revise' && args.request.revisionMode === WHOLE_MANUSCRIPT_REVISION_MODE) {
      const run = wholeRevisionRunner ?? await loadWholeRevisionRunner();
      return run(args);
    }
    const { engine } = engineBinding(args.engine, args.engineVersion);
    const createAIController = engine === 'ai-sdk' ? await loadAIController() : undefined;
    const controller = createAIController?.({ config, agentModel, progress: args.progress });
    return runWorkflow({ ...args, controller, retrieveKnowledge,
      ...(typeof queryDeepReferences === 'function' ? { queryDeepReferences } : {}) });
  };
}
