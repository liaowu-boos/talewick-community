const reviewCodes = new Set(['STATE_REVIEW_REJECTED']);
const resultCodes = new Set(['WORKFLOW_RESULT_UNVERIFIED']);
const networkCodes = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND']);

export const failureKinds = Object.freeze(['review_output', 'delivery_check', 'network', 'configuration', 'writing', 'unknown', 'interrupted', 'cancelled']);
export const retryScopes = Object.freeze(['unfinished_review', 'unfinished_check', 'unfinished_writing', 'unfinished_step']);

export function taskPhase(stage = '') {
  if (stage === 'continuity-review' || stage === 'review' || stage === 'revisionReview' || stage === 'agent:reviewManuscript'
    || stage.startsWith('review-adjudication') || stage.startsWith('reviewAdjudication') || stage.startsWith('agent:review')) return 'review';
  if (/^(draft|revision):/.test(stage) || stage.startsWith('agent:reviseChapter:') || ['write', 'writing', 'manuscript', 'revise', 'revision'].includes(stage)) return 'writing';
  if (['checks', 'validation', 'result', 'delivery'].includes(stage)) return 'check';
  return 'step';
}

const scopeFor = phase => ({ review: 'unfinished_review', check: 'unfinished_check', writing: 'unfinished_writing' }[phase] || 'unfinished_step');
const phaseName = phase => ({ review: '审阅', check: '交付检查', writing: '写作' }[phase] || '当前');
const publicDetail = error => typeof error?.message === 'string' && error.message.trim() && error.message.length <= 800 ? error.message.trim() : '';

/** Build a bounded public failure record. It never includes provider response bodies. */
export function classifyTaskFailure(error, stage = '') {
  const phase = taskPhase(stage);
  const retryScope = scopeFor(phase);
  if (reviewCodes.has(error?.code)) return {
    kind: 'review_output', phase, retryScope: 'unfinished_review',
    message: '审阅结果的格式或版本绑定未通过校验。正文和已完成步骤已保存；继续任务时只会运行未完成的审阅。',
  };
  if (resultCodes.has(error?.code)) return {
    kind: 'delivery_check', phase: 'check', retryScope: 'unfinished_check',
    message: '交付结果未通过完成条件校验。正文和已完成步骤已保存；继续任务时只会运行未完成的交付检查。',
  };
  const status = Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.statusCode) ? error.statusCode : undefined;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (networkCodes.has(error?.code) || /无法连接模型服务|模型请求超时|模型响应超时|暂时无法连接/.test(message) || status === 408) return {
    kind: 'network', phase, retryScope,
    message: `模型连接或响应超时，${phaseName(phase)}步骤未完成。已完成步骤已保存；继续任务时只会运行未完成步骤。`,
  };
  if ([401, 402, 403].includes(status) || /尚未配置|认证|权限不足|API Key|余额不足|模型适配不可用/.test(message)) return {
    kind: 'configuration', phase, retryScope,
    message: `模型配置、权限或账户状态阻止了${phaseName(phase)}步骤。已完成步骤已保存；处理提示的问题后可继续未完成步骤。`,
  };
  if (phase === 'review') return {
    kind: 'review_output', phase, retryScope,
    message: `${publicDetail(error) ? `${publicDetail(error)} ` : '审阅步骤未完成。'}正文和已完成步骤已保存；继续任务时只会运行未完成的审阅。`,
  };
  if (phase === 'check') return {
    kind: 'delivery_check', phase, retryScope,
    message: `${publicDetail(error) ? `${publicDetail(error)} ` : '交付检查未完成。'}正文和已完成步骤已保存；继续任务时只会运行未完成的交付检查。`,
  };
  if (phase === 'writing') return {
    kind: 'writing', phase, retryScope,
    message: `${publicDetail(error) ? `${publicDetail(error)} ` : '写作步骤未完成。'}已完成的正文和步骤已保存；继续任务时只会运行未完成的写作步骤。`,
  };
  return {
    kind: 'unknown', phase, retryScope,
    message: '当前步骤未完成。已完成步骤已保存；继续任务时只会运行未完成步骤。',
  };
}

export function interruptedFailure(message = '运行已中断。已完成步骤已保存；可以继续未完成步骤。') {
  return { kind: 'interrupted', phase: 'step', retryScope: 'unfinished_step', message };
}

export function cancelledFailure() {
  return { kind: 'cancelled', phase: 'step', retryScope: 'unfinished_step', message: '任务已取消。已完成步骤仍保留；需要时可继续未完成步骤。' };
}
