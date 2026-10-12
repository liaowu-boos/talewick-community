import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const TRANSPORT_INSTRUCTION = `
# Full15 API 内联传输适配

本次是无工具的单次 provider API 调用。当前上下文不存在 REVIEW_ENTRY、packet-manifest 或 packet-chunk 命令，不得尝试调用、模拟或声称执行这些命令。

执行层已在发送前用本地只读命令核验冻结 packet，并把该命令返回的完整 manifest 和所有按 index 排序的 chunks 原样内联到当前 user 消息。请直接读取 inline_packet.manifest 与 inline_packet.chunks：逐片核对 packet_sha256、index、连续字符区间及切片 sha256，再把各片 text 按序拼接为唯一 packet JSON。只有你在当前上下文实际收到、核对并读完全部内联分片时，才可按原规则声明 scope.full_text_read=true，并把实际读取的全部 index 写入 scope.read_chunks。

本节只替换固定指令中“通过 REVIEW_ENTRY 命令加载 packet”的传输方式；原指令的诊断定义、引用规则、全文边界、输入污染处理与唯一 JSON 输出格式全部保持不变。内联收到分片不等于自动通过检查，也不构成虚构的命令执行或 provider receipt。
`.trim();
const COMMAND_TRANSPORT = /只可通过 REVIEW_ENTRY 指定的 `packet-manifest`、`packet-chunk` 只读命令逐片加载(?:该 packet|它)/g;

export function adaptFull15PromptForInlineTransport(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('辅助检查固定指令缺失。');
  const adapted = prompt.replace(COMMAND_TRANSPORT,
    '只可读取当前 user 消息中已核验并按序内联的完整 manifest 与 chunks');
  if (adapted === prompt) throw Object.assign(new Error('辅助检查固定指令的传输约定未匹配，拒绝静默改写。'), { code: 'full15_transport_contract_mismatch' });
  return `${adapted.trim()}\n\n${TRANSPORT_INSTRUCTION}`;
}

/** Receipt-aware stateless provider bridge for the two isolated full-text stages. */
export function createFull15Analyze({ model }) {
  if (!model || typeof model.complete !== 'function') return null;
  return async ({ stage, contextKey, prompt, manifest, packetSha256, chunks, sourceSha256, rulesVersion, signal }) => {
    if (!['cold_read', 'check'].includes(stage) || typeof contextKey !== 'string' || !Array.isArray(chunks)
      || !manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || manifest.schema_version !== 'full15-packet-read-1' || manifest.stage !== stage
      || manifest.packet_sha256 !== packetSha256 || manifest.chunk_count !== chunks.length) throw new Error('辅助检查调用内容无效。');
    let previousEnd = 0;
    const deliveredChunkIndices = chunks.map((chunk, index) => {
      if (chunk?.index !== index || typeof chunk.text !== 'string' || chunk.start_char !== previousEnd
        || !Number.isSafeInteger(chunk.end_char) || chunk.end_char < chunk.start_char
        || typeof chunk.sha256 !== 'string' || sha256(chunk.text) !== chunk.sha256) throw new Error('辅助检查分片不连续。');
      previousEnd = chunk.end_char;
      return index;
    });
    if (sha256(chunks.map(chunk => chunk.text).join('')) !== packetSha256) throw new Error('辅助检查分片不能重建冻结包。');
    const system = adaptFull15PromptForInlineTransport(prompt);
    const user = JSON.stringify({
      transport: { schema_version: 'full15-inline-transport-1', mode: 'inline_verified_packet', command_tools_available: false,
        context_key: contextKey, source_sha256: sourceSha256, rules_version: rulesVersion },
      inline_packet: { manifest, chunks },
    });
    let receipt, attempt;
    let outputText;
    try {
      outputText = await model.complete({ stage: stage === 'cold_read' ? 'full15-cold-read' : 'full15-check', system,
        user, signal, maxTokens: 65536,
        // A stage receipt represents exactly one request. Failed output uses the
        // persisted Full15 retry path rather than a hidden provider recovery call.
        allowRecovery: false,
        onAttempt: value => { attempt = value; },
        onReceipt: value => { receipt = value; } });
    } catch (error) {
      // onAttempt runs only after a complete provider response was parsed. A
      // length finish is known truncation, not an unknown provider outcome.
      if (attempt?.finishReason === 'length') throw Object.assign(error, {
        code: 'provider_output_length_limit', providerResponseComplete: true, full15Stage: stage,
        finishReason: 'length', maxOutputTokens: attempt.maxOutputTokens,
        ...(receipt?.invocationId ? { receipt: { provider: receipt.provider, invocationId: receipt.invocationId, contextId: receipt.contextId,
          packetSha256, deliveredChunkIndices } } : {}),
      });
      throw error;
    }
    if (!receipt?.invocationId || !receipt?.contextId) throw Object.assign(new Error('模型响应没有实际调用 ID，不能登记为完整辅助检查。'), { code: 'provider_receipt_missing' });
    return { outputText, receipt: { provider: receipt.provider, invocationId: receipt.invocationId, contextId: receipt.contextId, packetSha256, deliveredChunkIndices } };
  };
}
