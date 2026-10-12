const MB = 1024 * 1024;
const FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource']);
class ModelResponseError extends Error {}
const invalid = () => new ModelResponseError('模型返回了无法识别的响应，可以重试当前步骤。');
const incomplete = () => new ModelResponseError('模型响应在完整结束前中断，本步骤未完成，可以重试。');
const oversized = () => new ModelResponseError('模型响应超过读取上限，本步骤未完成。');

function readChunk(reader, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    reader.read().then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** Read one native provider result. Reasoning text is transient and never retained. */
export async function readModelResponse(response, { signal, onProgress = () => {}, limits = {} } = {}) {
  const maxResponseBytes = limits.responseBytes ?? 32 * MB;
  const maxEventBytes = limits.eventBytes ?? MB;
  const maxContentBytes = limits.contentBytes ?? MB;
  const contentType = response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase();
  const streaming = contentType === 'text/event-stream';
  if (!streaming && contentType !== 'application/json') throw invalid();
  if (!response.body?.getReader) throw invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let responseBytes = 0, contentBytes = 0, eventBytes = 0;
  let buffer = '', data = [], content = '', finishReason, providerRequestId, hasReasoning = false, done = false;

  const append = delta => {
    if (delta.content != null && typeof delta.content !== 'string') throw invalid();
    if (delta.reasoning_content != null && typeof delta.reasoning_content !== 'string') throw invalid();
    const reasoningProgress = typeof delta.reasoning_content === 'string' && Boolean(delta.reasoning_content.trim());
    const contentProgress = typeof delta.content === 'string' && Boolean(delta.content.trim());
    if (finishReason && (reasoningProgress || (delta.content?.length ?? 0) > 0)) throw invalid();
    if (reasoningProgress) hasReasoning = true;
    if (delta.content) {
      contentBytes += Buffer.byteLength(delta.content);
      if (contentBytes > maxContentBytes) throw oversized();
      content += delta.content;
    }
    if (reasoningProgress || contentProgress) onProgress();
  };
  const event = () => {
    if (!data.length) { eventBytes = 0; return; }
    const raw = data.join('\n'); data = []; eventBytes = 0;
    if (raw === '[DONE]') {
      if (!finishReason) throw incomplete();
      done = true; return;
    }
    let payload;
    try { payload = JSON.parse(raw); } catch { throw invalid(); }
    if (!payload || payload.error || !Array.isArray(payload.choices)) throw invalid();
    if (payload.id !== undefined) {
      if (typeof payload.id !== 'string' || !payload.id.trim() || (providerRequestId && providerRequestId !== payload.id)) throw invalid();
      providerRequestId = payload.id;
    }
    if (!payload.choices.length) {
      if (!payload.usage) throw invalid();
      return;
    }
    if (payload.choices.length !== 1) throw invalid();
    const choice = payload.choices[0];
    if (!choice || (choice.index != null && choice.index !== 0) || !choice.delta || typeof choice.delta !== 'object' || Array.isArray(choice.delta)) throw invalid();
    append(choice.delta);
    if (choice.finish_reason != null) {
      if (finishReason || !FINISH_REASONS.has(choice.finish_reason)) throw invalid();
      finishReason = choice.finish_reason;
    }
  };
  const line = value => {
    eventBytes += Buffer.byteLength(value) + 1;
    if (eventBytes > maxEventBytes) throw oversized();
    if (!value) { event(); return; }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    if ((colon === -1 ? value : value.slice(0, colon)) !== 'data') return;
    let valuePart = colon === -1 ? '' : value.slice(colon + 1);
    if (valuePart.startsWith(' ')) valuePart = valuePart.slice(1);
    data.push(valuePart);
  };
  const drain = eof => {
    while (!done) {
      const newline = buffer.search(/[\r\n]/);
      if (newline === -1) break;
      if (!eof && buffer[newline] === '\r' && newline === buffer.length - 1) break;
      const skip = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1;
      const value = buffer.slice(0, newline); buffer = buffer.slice(newline + skip);
      line(value);
    }
    if (Buffer.byteLength(buffer) + eventBytes > maxEventBytes) throw oversized();
  };

  try {
    while (!done) {
      const chunk = await readChunk(reader, signal);
      signal?.throwIfAborted();
      if (chunk.done) {
        try { buffer += decoder.decode(); } catch { throw invalid(); }
        if (streaming) {
          drain(true);
          if (!done) throw incomplete();
        }
        break;
      }
      responseBytes += chunk.value.byteLength;
      if (responseBytes > maxResponseBytes) throw oversized();
      try { buffer += decoder.decode(chunk.value, { stream: true }); } catch { throw invalid(); }
      if (streaming) drain(false);
    }
    signal?.throwIfAborted();
    if (!streaming) {
      let payload;
      try { payload = JSON.parse(buffer); } catch { throw invalid(); }
      if (!payload || payload.error) throw invalid();
      if (payload.id !== undefined && (typeof payload.id !== 'string' || !payload.id.trim())) throw invalid();
      providerRequestId = payload.id;
      const choice = payload.choices?.[0];
      if (!choice?.message || !FINISH_REASONS.has(choice.finish_reason)) throw incomplete();
      append(choice.message);
      finishReason = choice.finish_reason;
    }
    return { finish_reason: finishReason, message: { content }, hasReasoning, ...(providerRequestId ? { providerRequestId } : {}) };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ModelResponseError) throw error;
    throw incomplete();
  } finally {
    // Cancel an unfinished read without awaiting a potentially broken provider source.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
