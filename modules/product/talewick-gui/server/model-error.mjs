/** Convert SDK failures to safe, actionable user-facing text without exposing provider bodies. */
export function agentModelFailure(error) {
  const retryMarker = Symbol.for('vercel.ai.error.AI_RetryError');
  const apiCallMarker = Symbol.for('vercel.ai.error.AI_APICallError');
  let sdkError = error;
  // AI SDK 7 RetryError exposes its final attempt as lastError. Unwrap only that
  // documented SDK shape and at most once; never walk arbitrary causes or bodies.
  if (sdkError?.name === 'AI_RetryError' && sdkError[retryMarker] === true) sdkError = sdkError.lastError;
  const isApiCallError = sdkError?.name === 'AI_APICallError' && sdkError[apiCallMarker] === true;
  const status = isApiCallError && Number.isInteger(sdkError.statusCode) ? sdkError.statusCode : undefined;
  if (status === 401 || status === 403) return '模型服务认证或权限不足，请检查 API Key 和模型权限后恢复任务；此前产物已保留。';
  if (status === 402) return '模型账户余额不足，请充值后恢复任务；此前产物已保留。';
  if (status === 429) return '模型请求额度或频率受限，请稍后重试；此前产物已保留。';
  if (sdkError?.name === 'TimeoutError' || sdkError?.name === 'AbortError'
    || (sdkError instanceof Error && ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(sdkError.code))
    || (isApiCallError && status === 408)) {
    return '模型请求超时，已保存完成步骤；请检查连接后恢复任务。';
  }
  return 'Agent 模型或工具调用未完成，已保存完成步骤。请检查本机服务配置、模型工具调用支持或网络后恢复任务。';
}
