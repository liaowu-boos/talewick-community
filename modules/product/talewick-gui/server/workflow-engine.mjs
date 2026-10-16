import { runWorkflow } from '../../../creation/runtime/workflow.mjs';
import { createAIController } from './agent-ai-sdk.mjs';
import { engineBinding } from './engines.mjs';

export const WHOLE_MANUSCRIPT_REVISION_MODE = 'whole-manuscript-v1';
export const WHOLE_MANUSCRIPT_QUALITY_MODE = 'whole-manuscript-v2';
const loadWholeRevisionRunner = async () => {
  const runtime = await import('../../../creation/runtime/whole-manuscript-revision.mjs');
  if (typeof runtime.runWholeManuscriptRevision !== 'function') throw new Error('整稿修订运行时未提供约定入口。');
  return runtime.runWholeManuscriptRevision;
};
const loadWholeQualityRunner = async () => {
  const runtime = await import('../../../creation/runtime/whole-manuscript-quality.mjs');
  if (typeof runtime.runWholeManuscriptQualityRevision !== 'function') throw new Error('整稿质量运行时未提供约定入口。');
  return runtime.runWholeManuscriptQualityRevision;
};

export function createWorkflowRouter({ config, agentModel, retrieveKnowledge, queryNarrativeObservations, wholeRevisionRunner, wholeQualityRunner }) {
  return async args => {
    if (args.request?.kind === 'revise' && args.request.revisionMode === WHOLE_MANUSCRIPT_QUALITY_MODE) {
      const run = wholeQualityRunner ?? await loadWholeQualityRunner();
      return run({ ...args, retrieveKnowledge, ...(typeof queryNarrativeObservations === 'function' ? { queryNarrativeObservations } : {}) });
    }
    if (args.request?.kind === 'revise' && args.request.revisionMode === WHOLE_MANUSCRIPT_REVISION_MODE) {
      const run = wholeRevisionRunner ?? await loadWholeRevisionRunner();
      return run(args);
    }
    const { engine } = engineBinding(args.engine, args.engineVersion);
    const controller = engine === 'ai-sdk' ? createAIController({ config, agentModel, progress: args.progress }) : undefined;
    return runWorkflow({ ...args, controller, retrieveKnowledge });
  };
}
