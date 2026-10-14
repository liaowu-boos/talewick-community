import { runWorkflow } from '../../../creation/runtime/workflow.mjs';
import { createAIController } from './agent-ai-sdk.mjs';
import { engineBinding } from './engines.mjs';

export const WHOLE_MANUSCRIPT_REVISION_MODE = 'whole-manuscript-v1';
const loadWholeRevisionRunner = async () => {
  const runtime = await import('../../../creation/runtime/whole-manuscript-revision.mjs');
  if (typeof runtime.runWholeManuscriptRevision !== 'function') throw new Error('整稿修订运行时未提供约定入口。');
  return runtime.runWholeManuscriptRevision;
};

export function createWorkflowRouter({ config, agentModel, retrieveKnowledge, wholeRevisionRunner }) {
  return async args => {
    if (args.request?.kind === 'revise' && args.request.revisionMode === WHOLE_MANUSCRIPT_REVISION_MODE) {
      const run = wholeRevisionRunner ?? await loadWholeRevisionRunner();
      return run(args);
    }
    const { engine } = engineBinding(args.engine, args.engineVersion);
    const controller = engine === 'ai-sdk' ? createAIController({ config, agentModel, progress: args.progress }) : undefined;
    return runWorkflow({ ...args, controller, retrieveKnowledge });
  };
}
