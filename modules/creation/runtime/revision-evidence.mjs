import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildPlanFactCheckInput, validatePlanFactCheck, PLAN_FACT_CHECK_SYSTEM,
  buildIndependentSceneCheckInput, validateIndependentSceneCheck, INDEPENDENT_SCENE_CHECK_SYSTEM
} from '../../validation/runtime/revision-evidence-checks.mjs';
import { REVISION_EVIDENCE_VERSION, validateRevisionEvidencePolicy } from './revision-evidence-policy.mjs';

const clone = structuredClone;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const ensure = (condition, message) => {
  if (!condition) throw Object.assign(new Error(message), { code: 'WHOLE_QUALITY_REVISION_EVIDENCE' });
};
const taskBinding = requestSpec => `whole-quality:${requestSpec.inputFingerprint}`;
const checked = validator => (value, input) => {
  try { return validator(value, input); } catch (error) {
    // Only domain validation errors enter structuredStage's existing format repair.
    if (typeof error?.code === 'string' && error.code.startsWith('REVISION_')) {
      throw Object.assign(new Error(error.message), { code: 'WHOLE_QUALITY_REVISION_EVIDENCE_RESPONSE', causeCode: error.code });
    }
    throw error;
  }
};
const planValidator = checked(validatePlanFactCheck), sceneValidator = checked(validateIndependentSceneCheck);

export function revisionPlanFactInput(requestSpec, sourceChapters, plan, retrieval) {
  const referenceMaterials = [...retrieval.byIssue, ...(retrieval.byGoal ?? [])].flatMap(entry =>
    (entry.result?.packet?.materials ?? []).map(material => ({ id: `${entry.issueId}:${material.id}`, text: material.content })));
  return buildPlanFactCheckInput({ sourceTaskId: taskBinding(requestSpec), sourceChapters, plan, referenceMaterials });
}

export function revisionPlanCorrectionInput(baseInput, initialPlan, initialCheck) {
  return { ...clone(baseInput), revisionEvidenceCorrection: {
    schemaVersion: 'whole-quality-plan-fact-correction-input-1', initialPlan: clone(initialPlan), initialCheck: clone(initialCheck),
    boundary: '唯一一次方案修正。核对完整正文及反证，只纠正本次核查指出的事实前提及其受影响方案；不得改正文、冻结目标或适用审查，不得删掉真实问题来伪造通过。没有安全改法时具体说明保留或未决，仍接受一次独立事实复核。',
  } };
}

export function revisionSceneInput(requestSpec, sourceChapters, candidateChapters, candidateRevision) {
  const changes = (candidateRevision?.replacements ?? []).filter(item => item.sourceQuote !== item.replacement)
    .map(item => ({ groupId: item.appliedPlanItemIds[0], chapterId: item.chapterId,
      sourceStart: item.sourceStart, sourceQuote: item.sourceQuote, replacement: item.replacement }));
  // Do not pass plan, reread, prior labels, source judgments, or change explanations.
  return buildIndependentSceneCheckInput({ sourceTaskId: taskBinding(requestSpec), sourceChapters, candidateChapters, changes });
}

export async function runRevisionPlanEvidence({ requestSpec, sourceChapters, retrieval, basePlanInput, initialPlan,
  planSystem, validatePlan, structuredStage, saved, checkpoint, ...stageOptions }) {
  const common = { ...stageOptions, saved, checkpoint };
  const initialInput = revisionPlanFactInput(requestSpec, sourceChapters, initialPlan, retrieval);
  const first = await structuredStage({ ...common, prefix: 'whole-quality:plan-facts:initial', stage: 'whole-quality:plan-facts:initial',
    input: initialInput, system: PLAN_FACT_CHECK_SYSTEM, maxTokens: 18000, validate: planValidator });
  const history = { initialPlan: clone(initialPlan), initialCheck: first.value, correction: null };
  const receipts = [first.receipt]; let plan = initialPlan, planInput = basePlanInput, finalCheck = first.value;
  if (!first.value.clearForExecution) {
    planInput = revisionPlanCorrectionInput(basePlanInput, initialPlan, first.value);
    const correction = await structuredStage({ ...common, prefix: 'whole-quality:plan-correction', stage: 'whole-quality:plan-correction',
      input: planInput, system: `${planSystem}\n${planInput.revisionEvidenceCorrection.boundary}`,
      maxTokens: 14000, validate: validatePlan });
    plan = correction.value; receipts.push(correction.receipt);
    const recheck = await structuredStage({ ...common, prefix: 'whole-quality:plan-facts:recheck', stage: 'whole-quality:plan-facts:recheck',
      input: revisionPlanFactInput(requestSpec, sourceChapters, plan, retrieval), system: PLAN_FACT_CHECK_SYSTEM,
      maxTokens: 18000, validate: planValidator });
    receipts.push(recheck.receipt); finalCheck = recheck.value;
    history.correction = { plan: clone(plan), check: clone(finalCheck) };
  }
  if (!finalCheck.clearForExecution) {
    const key = 'whole-quality:plan-facts:blocked', failure = {
      schemaVersion: 'whole-quality-plan-facts-blocked-1', requestInputFingerprint: requestSpec.inputFingerprint,
      history, stageReceipts: receipts, status: finalCheck.status, revisionDispatched: false, automaticAdoption: false,
    };
    if (Object.hasOwn(saved, key)) ensure(isDeepStrictEqual(saved[key], failure), '未通过方案核查的保存记录不一致。');
    else { await checkpoint(key, clone(failure)); saved[key] = clone(failure); }
    throw Object.assign(new Error('方案事实核查在唯一修正及复核后仍未通过；已在正文修订前停止，保留全部方案和检查。'), {
      code: 'WHOLE_QUALITY_PLAN_FACTS_UNVERIFIED', artifactKey: key, recoverable: false, revisionDispatched: false,
    });
  }
  return { plan, planInput, history, receipts };
}

export function validateRevisionPlanHistory(history, { requestSpec, sourceChapters, retrieval, basePlanInput, validatePlan }) {
  ensure(history && Object.keys(history).length === 3 && Object.hasOwn(history, 'initialPlan')
    && Object.hasOwn(history, 'initialCheck') && Object.hasOwn(history, 'correction'), '方案核查历史字段无效。');
  const initialPlan = validatePlan(history.initialPlan, basePlanInput);
  const initialInput = revisionPlanFactInput(requestSpec, sourceChapters, initialPlan, retrieval);
  const initialCheck = planValidator(history.initialCheck, initialInput);
  const stages = [['whole-quality:plan-facts:initial', hash(initialInput)]];
  let plan = initialPlan, planInput = basePlanInput, finalCheck = initialCheck;
  if (initialCheck.clearForExecution) ensure(history.correction === null, '已通过的初始方案不能含重新抽取的方案。');
  else {
    ensure(history.correction && Object.keys(history.correction).length === 2
      && Object.hasOwn(history.correction, 'plan') && Object.hasOwn(history.correction, 'check'), '未通过初查须保留唯一修正与复核。');
    planInput = revisionPlanCorrectionInput(basePlanInput, initialPlan, initialCheck);
    plan = validatePlan(history.correction.plan, planInput);
    const nextInput = revisionPlanFactInput(requestSpec, sourceChapters, plan, retrieval);
    finalCheck = planValidator(history.correction.check, nextInput);
    stages.push(['whole-quality:plan-correction', hash(planInput)], ['whole-quality:plan-facts:recheck', hash(nextInput)]);
  }
  ensure(finalCheck.clearForExecution === true, '未通过事实复核的方案不能出现在完成结果中。');
  return { history: clone(history), plan, planInput, finalCheck, stages };
}

export async function runIndependentSceneEvidence({ requestSpec, sourceChapters, candidateChapters, candidateRevision,
  structuredStage, saved, checkpoint, ...stageOptions }) {
  const input = revisionSceneInput(requestSpec, sourceChapters, candidateChapters, candidateRevision);
  if ((candidateRevision?.replacements ?? []).some(item => item.sourceQuote !== item.replacement)) {
    return structuredStage({ ...stageOptions, saved, checkpoint, prefix: 'whole-quality:scene-check', stage: 'whole-quality:scene-check',
      input, system: INDEPENDENT_SCENE_CHECK_SYSTEM, maxTokens: 14000, validate: sceneValidator });
  }
  const value = sceneValidator({ ...input.responseBindings, inputHash: hash(input),
    checkedChapterIds: sourceChapters.map(chapter => chapter.id), groups: [] }, input);
  for (const [suffix, record] of [['host-input', { inputHash: hash(input), input }], ['host-result', value]]) {
    const key = `whole-quality:scene-check:${suffix}`;
    if (Object.hasOwn(saved, key)) ensure(isDeepStrictEqual(saved[key], record), '无变动独立场景记录与原稿不一致。');
    else { await checkpoint(key, clone(record)); saved[key] = clone(record); }
  }
  return { value };
}

export function buildRevisionEvidenceBundle({ requestSpec, sourceChapters, candidateChapters, candidateRevision,
  retrieval, basePlanInput, validatePlan, plan, planHistory, sceneDependencies }) {
  const policy = validateRevisionEvidencePolicy(requestSpec.revisionEvidencePolicy);
  ensure(policy, '完成结果中的独立核查必须绑定显式策略。');
  const checkedHistory = validateRevisionPlanHistory(planHistory, { requestSpec, sourceChapters, retrieval, basePlanInput, validatePlan });
  ensure(isDeepStrictEqual(checkedHistory.plan, plan), '最终方案与事实核查历史不一致。');
  const scene = sceneValidator(sceneDependencies, revisionSceneInput(requestSpec, sourceChapters, candidateChapters, candidateRevision));
  return { schemaVersion: REVISION_EVIDENCE_VERSION, policy,
    planFacts: checkedHistory.finalCheck, planHistory: checkedHistory.history, sceneDependencies: scene,
    blockedPlanItemIds: clone(scene.blockedGroupIds) };
}

export function revisionEvidenceStages(bundle, args) {
  const facts = validateRevisionPlanHistory(bundle.planHistory, args);
  const sceneInput = revisionSceneInput(args.requestSpec, args.sourceChapters, args.candidateChapters, args.candidateRevision);
  return { facts: facts.stages, scene: bundle.sceneDependencies.status === 'no_changes' ? []
    : [['whole-quality:scene-check', hash(sceneInput)]] };
}
