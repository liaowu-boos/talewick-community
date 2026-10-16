import { agentProviderFor, followupContinuityReasoningEffort, full15ReasoningEffort, independentReviewReasoningEffort, isBusinessStage, isFull15Stage, isIndependentReviewStage, isLibraryStage, isWholeQualityStage, isWholeRevisionStage, recoveryTextLimit, RECOVERY_BUDGET_VERSION, outputTokenLimit, usesDeepSeekThinking, wholeQualityReasoningEffort, wholeRevisionReasoningEffort } from './model-policy.mjs';
import { readModelResponse } from './model-response.mjs';
import { validateRelevanceModel, validateRelevanceProvider } from './config.mjs';
import { createCodexRelevanceAssessor } from './codex-relevance.mjs';

/** Safe per-process indicators, never a provider POST receipt or a semantic approval. */
export function projectCodexAttempt(record = {}, { requestedModel, effort, status } = {}) {
  if (!record || typeof record !== 'object') record = {};
  const usage = (Array.isArray(record.usage) ? record.usage : []).slice(0, 8).map(value => Object.fromEntries(
    ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']
      .filter(key => Number.isSafeInteger(value?.[key]) && value[key] >= 0).map(key => [key, value[key]])));
  return { provider: 'codex-cli', transport: 'codex-cli-jsonl-v1', requestedModel, effort, status, usage,
    exitCode: Number.isInteger(record.exitCode) && record.exitCode >= 0 && record.exitCode <= 255 ? record.exitCode : null,
    ...(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGINT'].includes(record.exitSignal) ? { exitSignal: record.exitSignal } : {}),
    timedOut: record.timedOut === true, aborted: record.aborted === true };
}

const JSON_STAGES = new Set(['library-relevance', 'library-analysis', 'library-analysis-revision', 'library-review', 'requirements', 'requirements:repair', 'planning', 'planning:material-decisions', 'agent:replan', 'review', 'agent:reviewManuscript', 'revisionReview', 'review-adjudication', 'review-adjudication:repair', 'review-adjudication:continuity-v4', 'review-adjudication:repair:continuity-v4', 'requestedRevision', 'continuity-review', 'continuity-chain-review', 'full15-cold-read', 'full15-check', 'whole-revision:diagnosis', 'whole-revision:diagnosis:format-repair', 'whole-revision:diagnosis:repair', 'whole-revision:plan', 'whole-revision:plan:format-repair', 'whole-revision:plan:repair', 'whole-revision:revision', 'whole-revision:revision:format-repair', 'whole-revision:revision:repair', 'whole-revision:reread', 'whole-revision:reread:format-repair', 'whole-revision:reread:repair', 'independent-review:independent-reading', 'independent-review:blind-pair', 'independent-review:goal-audit']);
const stageLabel = stage => /^draft:ch-\d+$/.test(stage ?? '') ? `第 ${stage.slice(9)} 章写作` : ({ 'library-relevance': '材料相关性复核', 'library-analysis': '小说拆解', 'library-analysis-revision': '拆解修订', 'library-review': '拆解复核', requirements: '需求整理', 'requirements:repair': '需求纠正', planning: '故事规划', 'planning:material-decisions': '补查材料决策', 'agent:replan': '故事重规划', review: '审稿', 'agent:reviewManuscript': '全文复核', revisionReview: '修后复核', 'review-adjudication': '审稿证据裁定', 'review-adjudication:repair': '裁定响应纠正', 'review-adjudication:continuity-v4': '连续性证据裁定', 'review-adjudication:repair:continuity-v4': '连续性裁定响应纠正', requestedRevision: '指定修改', 'continuity-review': '连续性核查', 'continuity-chain-review': '时间与状态连续性核查', 'full15-cold-read': '全文冷读', 'full15-check': '全文问题检查', 'whole-revision:diagnosis': '整稿独立初读', 'whole-revision:diagnosis:format-repair': '整稿初读格式纠正', 'whole-revision:diagnosis:repair': '整稿初读格式纠正', 'whole-revision:plan': '整稿修改方案', 'whole-revision:plan:format-repair': '整稿方案格式纠正', 'whole-revision:plan:repair': '整稿方案格式纠正', 'whole-revision:revision': '整稿关联场景修改', 'whole-revision:revision:format-repair': '整稿候选格式纠正', 'whole-revision:revision:repair': '整稿候选格式纠正', 'whole-revision:reread': '整稿候选独立复读', 'whole-revision:reread:format-repair': '整稿复读格式纠正', 'whole-revision:reread:repair': '整稿复读格式纠正', 'whole-quality:reading': '整稿质量独立阅读', 'whole-quality:reading:format-repair': '独立阅读格式纠正', 'whole-quality:applicability': '检索材料功能适用审查', 'whole-quality:applicability:format-repair': '功能适用审查格式纠正', 'whole-quality:plan': '整稿质量修改方案', 'whole-quality:plan:format-repair': '质量方案格式纠正', 'whole-quality:feasibility': '修订可行性核对', 'whole-quality:feasibility:format-repair': '可行性格式纠正', 'whole-quality:revision': '整稿质量修订', 'whole-quality:revision:format-repair': '质量修订格式纠正', 'whole-quality:reread': '整稿质量最终复读', 'whole-quality:reread:format-repair': '最终复读格式纠正', 'whole-quality:material-evidence': '最终正文用材定位', 'whole-quality:material-evidence:format-repair': '最终正文用材定位格式纠正' }[stage] ?? (/^(revision|agent:reviseChapter):/.test(stage ?? '') ? '章节修订' : '当前步骤'));

/** A plain, stateless Chat Completions call. No agent loop or model-selected tools. */
export function createModel(config, fetchImpl = fetch, { codexAssessorFactory = createCodexRelevanceAssessor } = {}) {
  const relevanceModel = validateRelevanceModel(config);
  const relevanceProvider = validateRelevanceProvider(config);
  return {
    async complete({ stage, system, user, signal, directory, maxTokens = 6000, allowRecovery = true, modelPolicy, onAttempt = async () => {}, onReceipt = async () => {} }) {
      if (stage === 'library-relevance' && relevanceProvider === 'codex-cli') {
        signal?.throwIfAborted();
        const startedAt = Date.now(); let receipt, content, rejected = false;
        try {
          const assess = codexAssessorFactory({ model: relevanceModel, effort: config.relevanceEffort,
            executable: config.relevanceCliExecutable, acceptDisabledHostNotice: config.relevanceAcceptDisabledHostNotice ?? false,
            timeoutMs: config.timeoutMs, onRecord: record => { receipt = record; } });
          content = await assess({ stage, system, user }, { signal, directory });
          signal?.throwIfAborted();
          if (typeof content !== 'string' || !content.trim()) throw new Error('Invalid CLI content');
        } catch { rejected = true; }
        await onAttempt({ stage, attempt: 1, mode: 'primary', elapsedMs: Date.now() - startedAt,
          ...(typeof content === 'string' ? { contentCharacters: content.length } : {}),
          ...projectCodexAttempt(receipt, { requestedModel: relevanceModel, effort: config.relevanceEffort,
            status: rejected ? 'rejected' : 'completed' }) });
        signal?.throwIfAborted();
        if (rejected) {
          signal?.throwIfAborted();
          throw Object.assign(new Error('Codex CLI 材料筛选未完成；未回退到其他模型。'), { code: 'CODEX_RELEVANCE_UNAVAILABLE' });
        }
        return content;
      }
      if (!config.apiKey) throw new Error('模型尚未配置，请填写本机模型配置后重试。');
      signal?.throwIfAborted();
      const requestedModel = stage === 'library-relevance' && relevanceModel ? relevanceModel : config.model;
      const requestConfig = requestedModel === config.model ? config : { ...config, model: requestedModel };
      const nativeDeepSeek = agentProviderFor(config) === 'deepseek';
      const nativeV4 = usesDeepSeekThinking(requestConfig);
      const full15Effort = full15ReasoningEffort(requestConfig, stage);
      const followupEffort = followupContinuityReasoningEffort(requestConfig, stage, modelPolicy);
      const wholeRevisionEffort = wholeRevisionReasoningEffort(requestConfig, stage, modelPolicy);
      const wholeQualityEffort = wholeQualityReasoningEffort(requestConfig, stage, modelPolicy);
      const independentReviewEffort = independentReviewReasoningEffort(requestConfig, stage, modelPolicy);
      // These stages already require JSON in their business prompts; prose stays plain text.
      const requestBody = { model: requestedModel, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: outputTokenLimit(requestConfig, maxTokens, stage, modelPolicy), stream: Boolean(nativeV4),
        ...(((nativeDeepSeek || stage === 'library-relevance' || isWholeRevisionStage(stage)) && JSON_STAGES.has(stage)) || isWholeQualityStage(stage) || isIndependentReviewStage(stage) ? { response_format: { type: 'json_object' } } : {}),
        ...(nativeV4 && isLibraryStage(stage) ? { thinking: { type: stage === 'library-relevance' ? 'enabled' : 'disabled' } } : {}),
        ...(full15Effort ? { thinking: { type: 'enabled' }, reasoning_effort: full15Effort } : {}),
        ...(followupEffort ? { thinking: { type: 'enabled' }, reasoning_effort: followupEffort } : {}),
        ...(wholeRevisionEffort ? { thinking: { type: 'enabled' }, reasoning_effort: wholeRevisionEffort } : {}),
        ...(wholeQualityEffort ? { thinking: { type: 'enabled' }, reasoning_effort: wholeQualityEffort } : {}) };
      if (independentReviewEffort) Object.assign(requestBody, { thinking: { type: 'enabled' }, reasoning_effort: independentReviewEffort });
      const total = new AbortController();
      const idle = new AbortController();
      const combined = AbortSignal.any([...(signal ? [signal] : []), total.signal, idle.signal]);
      const totalTimer = setTimeout(() => total.abort(), config.timeoutMs);
      let idleTimer;
      const progress = () => {
        clearTimeout(idleTimer);
        // Only native V4 streams can distinguish generated content from transport keep-alives.
        if (nativeV4 && !combined.aborted) idleTimer = setTimeout(() => idle.abort(), config.idleTimeoutMs ?? config.timeoutMs);
      };
      progress();
      const checkAbort = () => {
        signal?.throwIfAborted();
        if (total.signal.aborted) throw new Error('模型响应超时：已达到本步骤等待上限，已保存此前完成的步骤，可以重试。');
        if (idle.signal.aborted) throw new Error('模型响应超时：长时间未收到生成进展，已保存此前完成的步骤，可以重试。');
      };
      const requestChoice = async (withoutThinking = false) => {
        checkAbort();
        const startedAt = Date.now();
        const body = withoutThinking ? { ...requestBody, thinking: { type: 'disabled' }, max_tokens: recoveryTextLimit(stage, maxTokens) } : requestBody;
        let response;
        try {
          response = await fetchImpl(`${config.baseURL}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
            body: JSON.stringify(body),
            signal: combined,
            redirect: 'error',
          });
        } catch {
          checkAbort();
          throw new Error('无法连接模型服务，请检查模型地址和网络后重试。');
        }
        checkAbort();
        if (!response.ok) {
          // 不回传供应商原始错误正文，避免密钥、输入材料或内部诊断泄漏到界面。
          const help = response.status === 401 || response.status === 403 ? '请检查 API Key 和模型权限。' : response.status === 402 ? '账户余额不足，请充值后恢复任务；此前产物已保留。' : response.status === 429 ? '请求额度或频率受限，请稍后重试。' : '请检查模型名称、服务配置或稍后重试。';
          throw new Error(`模型服务返回 HTTP ${response.status}。${help}`);
        }
        if (nativeV4) {
          try {
            const choice = await readModelResponse(response, { signal: combined, onProgress: progress });
            checkAbort();
            // 只记数值与枚举，便于定位阶段限制；不记录输入、正文或推理文本。
            await onAttempt({ stage: isBusinessStage(stage) || isLibraryStage(stage) || isFull15Stage(stage) ? stage : 'other', attempt: withoutThinking ? 2 : 1, requestedModel,
              mode: withoutThinking ? 'recovery' : 'primary', maxOutputTokens: body.max_tokens,
              ...(withoutThinking ? { recoveryBudgetVersion: RECOVERY_BUDGET_VERSION } : {}),
              finishReason: choice.finish_reason, contentCharacters: choice.message.content.length,
              hasReasoning: choice.hasReasoning, elapsedMs: Date.now() - startedAt });
            checkAbort();
            return choice;
          }
          catch (error) { checkAbort(); throw error; }
        }
        let payload;
        try { payload = await response.json(); } catch { checkAbort(); throw new Error('模型返回了无法识别的响应，可以重试当前步骤。'); }
        checkAbort();
        const rawChoice = payload.choices?.[0];
        const headerRequestId = response.headers?.get?.('x-request-id') || response.headers?.get?.('request-id');
        const providerRequestId = typeof payload.id === 'string' && payload.id.trim() ? payload.id : typeof headerRequestId === 'string' && headerRequestId.trim() ? headerRequestId : undefined;
        const choice = rawChoice && providerRequestId ? { ...rawChoice, providerRequestId } : rawChoice;
        if (stage === 'library-relevance' || isWholeRevisionStage(stage) || isWholeQualityStage(stage) || isIndependentReviewStage(stage)) {
          await onAttempt({ stage, attempt: 1, mode: 'primary', requestedModel, maxOutputTokens: body.max_tokens,
            finishReason: choice?.finish_reason, contentCharacters: typeof choice?.message?.content === 'string' ? choice.message.content.length : 0,
            hasReasoning: typeof choice?.message?.reasoning_content === 'string' && Boolean(choice.message.reasoning_content.trim()), elapsedMs: Date.now() - startedAt });
          checkAbort();
        }
        return choice;
      };
      try {
        let choice = await requestChoice();
        const firstContent = choice?.message?.content;
        const emptyStopped = choice?.finish_reason === 'stop' && (firstContent == null || (typeof firstContent === 'string' && !firstContent.trim()));
        const truncatedBusiness = isBusinessStage(stage) && choice?.finish_reason === 'length';
        const truncatedRelevance = stage === 'library-relevance' && choice?.finish_reason === 'length' && choice?.hasReasoning;
        if (allowRecovery && !isFull15Stage(stage) && !isWholeRevisionStage(stage) && !isWholeQualityStage(stage) && !isIndependentReviewStage(stage) && nativeV4 && stage !== 'publication-feedback-review' && choice?.hasReasoning && ((!isLibraryStage(stage) && (emptyStopped || truncatedBusiness)) || truncatedRelevance)) {
          // 创作阶段或推理挤占相关性 JSON 时最多恢复一次：完整原输入重新生成，关闭额外推理。
          // 不拼接截断文本、不重置截止时间、不增加第三次调用；仍须通过原业务校验。
          choice = await requestChoice(true);
        }
        // A Full15 provider ID describes the one completed wire response even
        // when its semantic output is rejected below. Other stages retain the
        // existing success-only receipt behavior.
        const isolatedReceiptRecorded = (isFull15Stage(stage) || isWholeQualityStage(stage) || isIndependentReviewStage(stage)) && Boolean(choice?.providerRequestId);
        if (isolatedReceiptRecorded) await onReceipt({ provider: agentProviderFor(config), invocationId: choice.providerRequestId, contextId: choice.providerRequestId });
        if (choice?.finish_reason === 'length') throw new Error(`模型输出达到长度上限（${stageLabel(stage)}），本步骤未完成；此前内容已保留，需要处理该步骤的生成范围后重试。`);
        if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new Error('模型未正常完成本次输出，请查看服务设置后重试。');
        const content = choice?.message?.content;
        if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回正文，本步骤未完成。');
        if (!isolatedReceiptRecorded) await onReceipt({ provider: agentProviderFor(config), invocationId: choice.providerRequestId, contextId: choice.providerRequestId });
        return content;
      } finally {
        clearTimeout(totalTimer);
        clearTimeout(idleTimer);
      }
    },
  };
}
