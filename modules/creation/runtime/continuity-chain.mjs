import {isDeepStrictEqual} from 'node:util';
import {adjudicationFingerprint} from '../../validation/runtime/review-adjudication.mjs';
import {
  CONTINUITY_CHAIN_STAGE, CONTINUITY_CHAIN_LIMITS,
  prepareContinuityChainReview, inspectContinuityChainReview, validateContinuityChainReview,
  createContinuityChainAdjudicationInput, validateContinuityChainAdjudicationInput,
  createContinuityChainRepairInput, inspectContinuityChainRepairResponse, validateContinuityChainRepairResult,
  createContinuityChainFormatRepairInput, inspectContinuityChainFormatRepairResponse, validateContinuityChainFormatRepairResult,
  createContinuityChainFailureEnvelope, validateContinuityChainFailureEnvelope,
} from '../../validation/runtime/continuity-chain-review.mjs';

const reject = message => {
  throw Object.assign(new Error(message), {code:'CONTINUITY_CHAIN_CHECKPOINT_MISMATCH'});
};

// create-state-review-v2 keeps the validator's frozen default invocation. V3 must
// opt into its protocol explicitly, so old saved work never changes meaning.
export async function reviewWorkflowContinuityChain({key, chapters, review, requirements, model, signal, step, version}) {
  if (version !== undefined && version !== 'continuity-chain-review-3') {
    reject('未知事件链检查协议版本。');
  }
  const args = {chapters, report:review};
  const input = version === 'continuity-chain-review-3'
    ? prepareContinuityChainReview(args, {version:'continuity-chain-review-3'})
    : prepareContinuityChainReview(args);
  const prefix = `${key}:chain:${input.inputHash}`;
  const savedInput = await step(`${prefix}:input`, () => input);
  if (!isDeepStrictEqual(savedInput, input)) reject('事件链检查输入与当前完整正文或审稿不一致。');
  let freshAttempt = false;
  const start = {inputHash:input.inputHash, requestSha256:input.requestSha256};
  const savedStart = await step(`${prefix}:started`, () => { freshAttempt=true; return start; });
  if (!isDeepStrictEqual(savedStart, start)) reject('事件链调用前保存点与当前输入不一致。');
  const response = await step(`${prefix}:response`, async () => {
    if (!freshAttempt) throw Object.assign(new Error('事件链检查调用曾开始但未完整保存响应；不会在恢复时重新判定。'), {code:'CONTINUITY_CHAIN_INTERRUPTED'});
    signal?.throwIfAborted();
    const rawResponse = await model.complete({stage:CONTINUITY_CHAIN_STAGE, system:input.system,
      user:input.user, maxTokens:CONTINUITY_CHAIN_LIMITS.maxTokens, signal});
    return {inputHash:input.inputHash, requestSha256:input.requestSha256, rawResponse,
      responseSha256:adjudicationFingerprint(rawResponse)};
  });
  const expectedResponse = {inputHash:input.inputHash, requestSha256:input.requestSha256,
    rawResponse:response?.rawResponse, responseSha256:adjudicationFingerprint(response?.rawResponse ?? null)};
  if (!isDeepStrictEqual(response, expectedResponse) || typeof response.rawResponse !== 'string') {
    reject('事件链检查保存响应与输入或原始响应指纹不一致。');
  }
  let rebuilt, formatRecovered = false;
  try { rebuilt = inspectContinuityChainReview(response.rawResponse, input); }
  catch (error) {
    const relationRepair=['CASE_TRANSITIONS','EXPLANATION_WITHOUT_EVIDENCE'].includes(error.code);
    if (!relationRepair&&error.code!=='RESPONSE_JSON') throw error;
    formatRecovered = !relationRepair;
    const repairInput = relationRepair
      ? createContinuityChainRepairInput({input, invalidResponse:response.rawResponse})
      : createContinuityChainFormatRepairInput({input, invalidResponse:response.rawResponse});
    const repairPrefix = `${prefix}:repair:${repairInput.requestSha256}`;
    if (!isDeepStrictEqual(await step(`${repairPrefix}:input`, () => repairInput), repairInput)) {
      reject('事件链纠正输入与原始响应不一致。');
    }
    let freshRepair = false;
    const repairStart = {inputHash:input.inputHash,requestSha256:repairInput.requestSha256,invalidResponseSha256:repairInput.invalidResponseSha256};
    if (!isDeepStrictEqual(await step(`${repairPrefix}:started`, () => {freshRepair=true;return repairStart;}),repairStart)) {
      reject('事件链纠正调用前保存点不一致。');
    }
    const repairRaw = await step(`${repairPrefix}:response`, async () => {
      if (!freshRepair) throw Object.assign(new Error('事件链唯一一次纠正曾开始但未完整保存响应；不会重复纠正。'),{code:'CONTINUITY_CHAIN_INTERRUPTED'});
      signal?.throwIfAborted();
      const rawResponse = await model.complete({stage:repairInput.stage,system:repairInput.system,
        user:repairInput.user,maxTokens:repairInput.maxTokens,signal});
      return {requestSha256:repairInput.requestSha256,rawResponse,responseSha256:adjudicationFingerprint(rawResponse)};
    });
    if (!isDeepStrictEqual(repairRaw,{requestSha256:repairInput.requestSha256,rawResponse:repairRaw?.rawResponse,
      responseSha256:adjudicationFingerprint(repairRaw?.rawResponse ?? null)})) reject('事件链纠正响应保存点不一致。');
    let parsed;
    try {
      parsed = relationRepair
        ? inspectContinuityChainRepairResponse(repairRaw.rawResponse,repairInput)
        : inspectContinuityChainFormatRepairResponse(repairRaw.rawResponse,repairInput);
    } catch (repairError) {
      if (version !== 'continuity-chain-review-3' || relationRepair) throw repairError;
      const failureArgs = {input,primaryRawResponse:response.rawResponse,repairInput,
        repairRawResponse:repairRaw.rawResponse,failureCode:repairError?.code};
      const failure = createContinuityChainFailureEnvelope(failureArgs);
      const savedFailure = await step(`${prefix}:failure`, () => failure);
      const checkedFailure = validateContinuityChainFailureEnvelope(savedFailure,failureArgs);
      if (!isDeepStrictEqual(checkedFailure,failure)) reject('事件链未完成状态未对应已保存的原始与纠正响应。');
      if (Object.hasOwn(review,'continuityChain')) reject('事件链成功结果与未完成状态不能同时存在。');
      const failureReview = {...review,continuityChainFailure:checkedFailure};
      const mergedFailure = await step(key, () => failureReview);
      if (!isDeepStrictEqual(mergedFailure,failureReview)) reject('事件链未完成审稿保存点被替换，不能伪装检查完成。');
      return mergedFailure;
    }
    const repaired = relationRepair
      ? validateContinuityChainRepairResult(await step(`${repairPrefix}:result`,()=>parsed),repairInput)
      : validateContinuityChainFormatRepairResult(await step(`${repairPrefix}:result`,()=>parsed),repairInput);
    if (!isDeepStrictEqual(repaired,parsed)) reject('事件链纠正结果未对应实际保存的原始响应。');
    rebuilt = repaired.result;
  }
  const continuity = validateContinuityChainReview(await step(`${prefix}:result`, () => rebuilt), input);
  if (!isDeepStrictEqual(continuity,rebuilt)) reject('事件链结果未对应本次保存的原始响应。');
  const mergeArgs = {chapters, input, continuity, review, requirements, ...(formatRecovered ? {formatRecovered:true} : {})};
  const merge = validateContinuityChainAdjudicationInput(
    await step(`${prefix}:merge`, () => createContinuityChainAdjudicationInput(mergeArgs)), mergeArgs);
  const merged = await step(key, () => merge.mergedReview);
  if (!isDeepStrictEqual(merged, merge.mergedReview)) reject('事件链合并审稿保存点被替换，不能用摘要覆盖未决问题。');
  return merged;
}

// Keep previous-version disputes as historical, unclosed observations. An omitted
// case in a reread does not resolve it, and an old observation cannot authorize an edit.
const historicalObservation = value => {
  const fields = ['schemaVersion','sourceProtocolVersion','sourceInputHash','sourceManuscriptSha256',
    'sourceRequestSha256','sourceResponseSha256','failureCode','case','status','semanticValidity',
    'revisionEligible','explicitlyClosed'];
  const caseFields = ['id','kind','subject','impact','reportedAssessment','reportedReason'];
  const exact = (item, names) => item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).length === names.length && names.every(name => Object.hasOwn(item,name));
  const hash = item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  if (!exact(value,fields) || !exact(value.case,caseFields)
    || value.schemaVersion !== 'continuity-chain-unverified-observation-1'
    || !['continuity-chain-review-2','continuity-chain-review-3'].includes(value.sourceProtocolVersion)
    || ![value.sourceInputHash,value.sourceManuscriptSha256,value.sourceRequestSha256,value.sourceResponseSha256].every(hash)
    || typeof value.failureCode !== 'string' || !value.failureCode
    || !['timeline','object_custody','site_availability','handover'].includes(value.case.kind)
    || !['major','ordinary'].includes(value.case.impact)
    || !['contradiction','explained','unknown'].includes(value.case.reportedAssessment)
    || !['id','subject','reportedReason'].every(name => typeof value.case[name] === 'string' && value.case[name].trim())
    || value.status !== 'protocol_failed_unverified_historical_observation'
    || value.semanticValidity !== 'unverified' || value.revisionEligible !== false || value.explicitlyClosed !== false) {
    reject('事件链历史观察不是带来源绑定的验证 helper 产物。');
  }
  return structuredClone(value);
};

export function inheritContinuityDisputes(review, previousReview, suppliedHistory = []) {
  const history = structuredClone(previousReview?.continuityDisputeHistory ?? []);
  for (const item of previousReview?.continuityChain?.retainedDisputes ?? []) {
    const entry = {sourceManuscriptSha256:previousReview.manuscriptSha256,
      sourceInputHash:previousReview.continuityChain.inputHash, ...structuredClone(item),
      followupStatus:'historical_observation_not_explicitly_closed', revisionEligible:false};
    if (!history.some(old=>old.sourceInputHash===entry.sourceInputHash && old.caseId===entry.caseId)) history.push(entry);
  }
  const previousFailure = previousReview?.continuityChainFailure;
  const sameManuscriptFailure = previousFailure?.manuscriptSha256 === review.manuscriptSha256
    ? structuredClone(previousFailure) : undefined;
  const failureHistory = [...(previousReview?.continuityChainFailureHistory ?? []),
    ...(previousFailure && !sameManuscriptFailure ? [structuredClone(previousFailure)] : [])]
    .filter((item,index,all) => all.findIndex(old => old.inputHash === item.inputHash) === index);
  const failureObservations = previousFailure && !sameManuscriptFailure
    ? previousFailure.historicalObservations ?? [] : [];
  const protocolHistory = [...(previousReview?.continuityProtocolHistory ?? []), ...failureObservations, ...suppliedHistory]
    .map(historicalObservation).filter((item,index,all) => all.findIndex(old =>
      old.sourceInputHash === item.sourceInputHash && old.case.id === item.case.id) === index);
  return history.length || protocolHistory.length || sameManuscriptFailure || failureHistory.length ? {...review,
    ...(history.length ? {continuityDisputeHistory:history} : {}),
    ...(protocolHistory.length ? {continuityProtocolHistory:protocolHistory} : {}),
    ...(sameManuscriptFailure ? {continuityChainFailure:sameManuscriptFailure} : {}),
    ...(failureHistory.length ? {continuityChainFailureHistory:failureHistory} : {})} : review;
}

export function continuityChainWarnings(review) {
  const disputes = review.continuityChain?.retainedDisputes ?? [];
  return [
    ...(review.continuityFormatRecovery
      ? ['事件链响应仅完成格式恢复，尚需独立核读；未据此新增自动修订，不能视为全文检查通过。'] : []),
    ...(review.continuityDisputeHistory?.length
      ? ['此前重大事件链疑点尚未逐项核对解除；已保留历史版本与依据，当前复读未再次提及不代表已解决。'] : []),
    ...(review.continuityProtocolHistory?.length
      ? ['此前协议失败响应中保留了未经验证的历史观察；未据此自动修订，后续复读未提及也不表示关闭。'] : []),
    ...(review.continuityChainFailure
      ? ['事件链检查未完成；已保留原始与唯一纠正响应的绑定失败状态，这不是检查通过，也未授权自动修订。'] : []),
    ...(review.continuityChainFailureHistory?.length
      ? ['先前正文的事件链检查未完成状态仍作为历史保留；当前结果不能据此宣称全部质量检查完成。'] : []),
    ...(disputes.some(item => item.status === 'retained_unknown_not_revision_eligible')
      ? ['全文事件链仍有重大证据缺口；已保留原文位置和原因，不把未知当成错误或验收通过。'] : []),
    ...(disputes.some(item => item.status === 'retained_contradiction_requires_cross_chapter_revision')
      ? ['全文事件链仍有需要跨章处理的矛盾；尚未解决，不能以局部修订完成替代全文验收。'] : []),
  ];
}
