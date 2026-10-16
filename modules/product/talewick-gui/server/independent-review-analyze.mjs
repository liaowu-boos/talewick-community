import { createHash } from 'node:crypto';
import { INDEPENDENT_REVIEW_MODEL_POLICY } from './model-policy.mjs';

const stages = new Set(['independent_reading', 'blind_pair', 'goal_audit']);
const stageNames = { independent_reading: 'independent-review:independent-reading', blind_pair: 'independent-review:blind-pair', goal_audit: 'independent-review:goal-audit' };
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

/** Stateless bridge: every validation stage is one fresh model request with no conversation history. */
export function createIndependentReviewAnalyze({ model }) {
  if (!model || typeof model.complete !== 'function') return null;
  const usedContexts = new Set();
  return async ({ stage, packet, inputHash, instruction, signal }) => {
    if (!stages.has(stage) || !packet || typeof packet !== 'object' || Array.isArray(packet)
      || typeof inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(inputHash)
      || typeof instruction !== 'string' || !instruction.trim()) throw Object.assign(new Error('独立评阅模型调用输入无效。'), { code: 'review_analyze_input_invalid' });
    const delivered = JSON.stringify({ inputHash, packet });
    let receipt;
    try {
      const outputText = await model.complete({ stage: stageNames[stage], modelPolicy: INDEPENDENT_REVIEW_MODEL_POLICY,
        system: `${instruction.trim()}\n\n你只可使用本次 user 消息中的冻结 packet。不得引用历史对话、诊断、作者身份、修改计划或未在 packet 中出现的目标。只输出指令要求的闭合 JSON。`,
        user: delivered, signal, maxTokens: 24000, allowRecovery: false,
        onReceipt: value => { receipt = value; } });
      const contextId = receipt?.contextId, invocationId = receipt?.invocationId;
      if (typeof contextId !== 'string' || !contextId || typeof invocationId !== 'string' || !invocationId) throw Object.assign(new Error('独立评阅缺少可核对的模型调用收据。'), { code: 'review_receipt_missing' });
      if (usedContexts.has(contextId)) throw Object.assign(new Error('独立评阅模型上下文被重复使用。'), { code: 'review_context_reused' });
      usedContexts.add(contextId);
      return { outputText, receipt: { provider: receipt.provider, invocationId, contextId, inputHash } };
    } catch (error) {
      if (receipt?.contextId && receipt?.invocationId) error.receipt = { provider: receipt.provider, invocationId: receipt.invocationId, contextId: receipt.contextId, inputHash };
      throw error;
    }
  };
}

export function independentReviewDeliveredHash(packet) { return sha256(JSON.stringify(packet)); }
