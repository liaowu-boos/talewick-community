// 引擎标识属于任务契约；旧任务默认固定流程，不跟随新任务配置切换。
export const ENGINE_VERSIONS = Object.freeze({ fixed: 'fixed-workflow-2', 'ai-sdk': 'ai-sdk-7.0.93-talewick-2' });
export const ENGINE_LABELS = Object.freeze({ fixed: '固定创作流程', 'ai-sdk': 'Agent 创作调度 · AI SDK' });

/** Resolve only supported execution engines; a stored version is never upgraded in place. */
export function engineBinding(engine = 'fixed', version) {
  if (!Object.hasOwn(ENGINE_VERSIONS, engine) || (version !== undefined && version !== ENGINE_VERSIONS[engine])) {
    throw Object.assign(new Error('该任务的执行引擎或版本暂不可用，请使用原版本恢复；原稿与任务记录已保留。'), { status: 409 });
  }
  return { engine, engineVersion: ENGINE_VERSIONS[engine] };
}
