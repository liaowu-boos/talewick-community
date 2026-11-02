const reviewCodes = new Set(['STATE_REVIEW_REJECTED']);
const resultCodes = new Set(['WORKFLOW_RESULT_UNVERIFIED']);
const exhaustedWholeQualityCodes = new Set(['WHOLE_QUALITY_FORMAT_FAILED']);
const networkCodes = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND']);

export const EXHAUSTED_WHOLE_QUALITY_MESSAGE = '整稿质量诊断的主响应和唯一格式纠正都未通过校验。原稿、诊断输入和已保存现场仍保留；这个旧任务不能继续，请从当前原稿重新发起整稿修订。';

export const failureKinds = Object.freeze(['review_output', 'delivery_check', 'network', 'configuration', 'reference_unavailable', 'writing', 'unknown', 'interrupted', 'cancelled']);
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
  if (error?.code === 'WHOLE_QUALITY_PLAN_FACTS_UNVERIFIED') return {
    kind: 'review_output', phase: 'review', retryScope: 'unfinished_review', recoverable: false,
    message: '方案事实核对仍有问题或未核实项，本次修订已停止。原稿、原方案和一次修正后的核对记录均保留；不会再次抽取判断。',
  };
  if (error?.code === 'WHOLE_QUALITY_REFERENCE_UNAVAILABLE') return {
    kind: 'reference_unavailable', phase: 'step', retryScope: 'unfinished_step', recoverable: error.recoverable !== false,
    message: error.recoverable === false
      ? '参考资料尚未就绪，后续创作已暂停。当前保存点不能直接重试；原稿和已有记录仍保留。'
      : '参考资料尚未就绪，后续创作已暂停。资料恢复可用后，请点击“重试资料”；已完成的阅读与检查会保留。',
  };
  if (exhaustedWholeQualityCodes.has(error?.code)) return {
    kind: 'review_output', phase: 'review', retryScope: 'unfinished_review', recoverable: false,
    message: EXHAUSTED_WHOLE_QUALITY_MESSAGE,
  };
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

/** Select only the one historical stage for which saved-response proof is supported. */
export function isStoredWholeQualityReadingFailureCandidate(task) {
  if (!task || task.status !== 'failed' || task.revisionMode !== 'whole-manuscript-v2'
    || task.stage !== 'whole-quality:reading:repair-response') return false;
  return true;
}

export function applyStoredFailurePolicy(task, inspection) {
  if (!isStoredWholeQualityReadingFailureCandidate(task) || inspection?.schemaVersion !== 'whole-quality-reading-failure-inspection-1'
    || inspection.stage !== 'whole-quality:reading') return task;
  // Only the server-owned inspector performs the full bound response validation.
  // An incomplete checkpoint also reports exhausted:false; that is not permission.
  if (task.failure?.recoverable === false && validReadingNormalization(inspection)) {
    if (task.failureHistory !== undefined && !Array.isArray(task.failureHistory)) return task;
    task.failureHistory = [...(task.failureHistory ?? []), {
      status: task.status, stage: task.stage, updatedAt: task.updatedAt,
      error: task.error, failure: structuredClone(task.failure),
      representationNormalization: structuredClone(inspection.representationNormalization),
    }];
    task.failure = { ...task.failure, recoverable: true,
      message: '已保存的诊断响应经格式归一后通过完整校验，可以继续后续未完成步骤。原错误和原始响应仍保留。' };
    task.error = task.failure.message;
    return task;
  }
  if (inspection.exhausted !== true) return task;
  task.failure = { kind: 'review_output', phase: 'review', retryScope: 'unfinished_review', recoverable: false, message: EXHAUSTED_WHOLE_QUALITY_MESSAGE };
  task.error = EXHAUSTED_WHOLE_QUALITY_MESSAGE;
  return task;
}

function validReadingNormalization(inspection) {
  const prefix = 'whole-quality:reading';
  const source = { primary_valid: 'primary', repair_valid: 'repair' }[inspection.reason];
  const proof = inspection.representationNormalization;
  const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  return inspection.exhausted === false && source !== undefined && proof
    && proof.schemaVersion === 'whole-quality-reading-limits-echo-normalization-1'
    && proof.stage === prefix && proof.sourceResponseKey === `${prefix}:${source}-response`
    && Array.isArray(proof.removedFields) && proof.removedFields.length === 1 && proof.removedFields[0] === 'limits'
    && ['inputHash', 'sourceResponseSha256', 'limitsSha256', 'projectedResponseSha256', 'validatedResultSha256'].every(key => sha(proof[key]))
    && (source !== 'repair' || (sha(inspection.primaryResponseSha256) && proof.sourceResponseSha256 === inspection.repairResponseSha256))
    && (inspection.primaryResponseSha256 === undefined || source !== 'primary' || proof.sourceResponseSha256 === inspection.primaryResponseSha256);
}

export function taskFailureRecoverable(task) {
  return task?.failure?.recoverable !== false;
}

export function interruptedFailure(message = '运行已中断。已完成步骤已保存；可以继续未完成步骤。') {
  return { kind: 'interrupted', phase: 'step', retryScope: 'unfinished_step', message };
}

export function cancelledFailure() {
  return { kind: 'cancelled', phase: 'step', retryScope: 'unfinished_step', message: '任务已取消。已完成步骤仍保留；需要时可继续未完成步骤。' };
}
