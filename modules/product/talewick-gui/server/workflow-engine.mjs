import { runWorkflow } from '../../../creation/runtime/workflow.mjs';
import { createAIController } from './agent-ai-sdk.mjs';
import { engineBinding } from './engines.mjs';

export function createWorkflowRouter({ config, agentModel, retrieveKnowledge }) {
  return async args => {
    const { engine } = engineBinding(args.engine, args.engineVersion);
    const controller = engine === 'ai-sdk' ? createAIController({ config, agentModel, progress: args.progress }) : undefined;
    return runWorkflow({ ...args, controller, retrieveKnowledge });
  };
}
