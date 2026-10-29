import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorkflowResultReady } from './workflow-result-gate.mjs';
import { projectReviewAdjudication } from './service-public.mjs';
import { manuscriptFingerprint } from '../../../validation/runtime/checks.mjs';
import { prepareContinuityChainReview, inspectContinuityChainReview, createContinuityChainPrimaryFailureEnvelope,
  createContinuityChainFormatRepairInput, createContinuityChainFailureEnvelope, createContinuityChainRepairInput,
  inspectContinuityChainRepairResponse, createContinuityChainRelationRepairFailureEnvelope } from '../../../validation/runtime/continuity-chain-review.mjs';
import { createAdjudicationInput, adjudicateReview, ADJUDICATION_CONTINUITY_VERSION } from '../../../validation/runtime/review-adjudication.mjs';
import { continuityChainWarnings } from '../../../creation/runtime/continuity-chain.mjs';

const chapters = [
  { id: 'ch-1', title: '旧约', body: '合同上没有写招牌拆除的责任。' },
  { id: 'ch-2', title: '验房', body: '合同已经写明招牌必须拆除。' },
];
const oldWarning = '事件链检查未完成；已保留原始与唯一纠正响应的绑定失败状态，这不是检查通过，也未授权自动修订。';
const newWarning = '事件链检查未完成；已保留原始响应的协议失败状态和未经验证的观察，未重抽或纠正，也未授权自动修订。';
const relationWarning = '事件链检查未完成；已保留原始与唯一关系纠正响应的绑定失败状态和未经验证的观察，未新增纠正，也未授权自动修订。';
const spec = { reviewPolicyVersion: ADJUDICATION_CONTINUITY_VERSION };

async function resultWithFailure(primary = true) {
  const originalReview = { summary: '合成协议测试。', manuscriptSha256: manuscriptFingerprint(chapters), issues: [], readingObservations: [] };
  const input = prepareContinuityChainReview({ chapters, report: originalReview }, { version: 'continuity-chain-review-3' });
  const wire = { inputHash: input.inputHash, manuscriptSha256: input.manuscriptSha256, reportSha256: input.reportSha256,
    checkedChapterIds: chapters.map(c => c.id), coverage: { status: 'complete', omissions: [] },
    evidence: chapters.map(c => ({ chapterId: c.id, fragmentStart: 1, fragmentEnd: 1, role: 'narration', actor: '许照', relevance: '合成约定位置' })),
    anchors: [1, 2].map(n => ({ id: `a${n}`, eventRef: '同一合同的约定', facet: 'handover_status', state: n === 1 ? '未写责任' : '写明责任', certainty: 'stated', timeFrame: 'current', evidence: n })),
    transitions: [{ id: 't1', fromAnchorId: 'a1', toAnchorId: 'a2', relation: 'same_event', certainty: 'stated', reason: '合成同一约定', evidence: [1, 2] }],
    cases: [{ id: 'contract', kind: 'handover', subject: '同一合同的招牌拆除责任', impact: 'major', assessment: 'contradiction',
      reason: '仅合成协议门槛测试。', anchorIds: ['a1', 'a2'], transitionIds: ['t1'], focusAnchorId: 'a2',
      repairScope: { assessment: 'cross_chapter', reason: '两个章节' }, identity: { assessment: 'same', reason: '合成同一合同', evidence: [1, 2] },
      alternatives: [{ explanation: '是否另一份合同', assessment: 'ruled_out', evidence: [1, 2] }],
      gap: { status: 'none', description: '合成对照' }, searchedChapterIds: chapters.map(c => c.id) }],
    retention: { majorUnknownCaseIds: [], contradictionCaseIds: ['contract'], nonLocalContradictionCaseIds: ['contract'] } };
  const raw = JSON.stringify(wire);
  assert.throws(() => inspectContinuityChainReview(raw, input), { code: 'CASE_FACETS' });
  let failure;
  if (primary === 'relation' || primary === 'primary-evidence') {
    wire.anchors[1].facet = 'holder';
    wire.anchors[1].evidence = 1;
    const repairRawResponse = JSON.stringify(wire);
    assert.throws(() => inspectContinuityChainReview(repairRawResponse, input), { code: 'CASE_NEEDS_DISTINCT_EVIDENCE' });
    if (primary === 'relation') {
      wire.cases[0].transitionIds = ['missing'];
      const primaryRawResponse = JSON.stringify(wire);
      assert.throws(() => inspectContinuityChainReview(primaryRawResponse, input), { code: 'CASE_TRANSITIONS' });
      const repairInput = createContinuityChainRepairInput({ input, invalidResponse: primaryRawResponse });
      assert.throws(() => inspectContinuityChainRepairResponse(repairRawResponse, repairInput), { code: 'CASE_NEEDS_DISTINCT_EVIDENCE' });
      failure = createContinuityChainRelationRepairFailureEnvelope({ input, primaryRawResponse, repairInput, repairRawResponse,
        failureCode: 'CASE_NEEDS_DISTINCT_EVIDENCE' });
    } else failure = createContinuityChainPrimaryFailureEnvelope({ input, primaryRawResponse: repairRawResponse,
      failureCode: 'CASE_NEEDS_DISTINCT_EVIDENCE' });
  } else if (primary) failure = createContinuityChainPrimaryFailureEnvelope({ input, primaryRawResponse: raw, failureCode: 'CASE_FACETS' });
  else {
    const primaryRawResponse = raw.slice(0, -1) + ',"","":""}';
    const repairInput = createContinuityChainFormatRepairInput({ input, invalidResponse: primaryRawResponse });
    failure = createContinuityChainFailureEnvelope({ input, primaryRawResponse, repairInput, repairRawResponse: raw, failureCode: 'CASE_FACETS' });
  }
  const review = { ...originalReview, continuityChainFailure: failure }, requirements = {};
  const reviewAdjudication = await adjudicateReview({ input: createAdjudicationInput({ chapters, review, requirements, protocolVersion: ADJUDICATION_CONTINUITY_VERSION }),
    model: { complete: async () => assert.fail('No provider/model call for these protocol fixtures') } });
  return { title: '合成门禁测试', chapters: structuredClone(chapters), requirements, review, reviewAdjudication,
    qualityCheckStatus: 'incomplete', warnings: continuityChainWarnings(review) };
}

test('validated primary failure passes the result gate only as incomplete, without changing manuscript or failure', async () => {
  const result = await resultWithFailure();
  assert.equal(result.review.continuityChainFailure.schemaVersion, 'continuity-chain-primary-failure-1');
  assert.equal(result.review.continuityChainFailure.repairAttempted, false);
  assert.equal(result.review.continuityChainFailure.semanticAcceptance, false);
  assert.equal(result.review.continuityChainFailure.automaticRevisionEligible, false);
  assert.equal(projectReviewAdjudication(result).status, 'bound');
  assert.ok(result.warnings.includes(newWarning)); assert.ok(!result.warnings.includes(oldWarning));
  const before = structuredClone(result);
  assert.doesNotThrow(() => assertWorkflowResultReady(result, spec));
  assert.deepEqual(result, before); assert.equal(result.qualityCheckStatus, 'incomplete');
  for (const status of [undefined, 'passed', 'complete']) {
    assert.throws(() => assertWorkflowResultReady({ ...result, qualityCheckStatus: status }, spec), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  }
});

test('new primary warning cannot replace legacy warning and missing/wrong warnings remain rejected', async () => {
  for (const primary of [true, false]) {
    const result = await resultWithFailure(primary), required = primary ? newWarning : oldWarning;
    assert.ok(result.warnings.includes(required)); assert.doesNotThrow(() => assertWorkflowResultReady(result, spec));
    for (const warnings of [[], [primary ? oldWarning : newWarning]]) {
      assert.throws(() => assertWorkflowResultReady({ ...result, warnings }, spec), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
    }
  }
});

test('primary failure warning does not bypass adjudication binding or authorize a forged failure', async () => {
  const result = await resultWithFailure();
  for (const mutate of [
    value => { delete value.reviewAdjudication; },
    value => { value.chapters[0].body += '改动'; },
    value => { value.review.continuityChainFailure.automaticRevisionEligible = true; },
    value => { value.review.continuityChainFailure.schemaVersion = 'unknown-failure'; },
  ]) {
    const changed = structuredClone(result); mutate(changed);
    assert.throws(() => assertWorkflowResultReady(changed, spec), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  }
});

test('exhausted relation repair preserves both response histories and only passes the gate as incomplete with its exact warning', async () => {
  const result = await resultWithFailure('relation'), failure = result.review.continuityChainFailure;
  assert.equal(failure.schemaVersion, 'continuity-chain-relation-repair-failure-1');
  assert.equal(failure.primaryFailureCode, 'CASE_TRANSITIONS');
  assert.equal(failure.failureCode, 'CASE_NEEDS_DISTINCT_EVIDENCE');
  assert.equal(failure.repairAttempted, true);
  assert.equal(failure.semanticAcceptance, false); assert.equal(failure.automaticRevisionEligible, false);
  assert.deepEqual(new Set(failure.historicalObservations.map(o => o.sourceResponseSha256)),
    new Set([failure.primaryResponseSha256, failure.repairResponseSha256]));
  assert.ok(failure.historicalObservations.every(o => o.semanticValidity === 'unverified' && !o.revisionEligible && !o.explicitlyClosed));
  assert.equal(projectReviewAdjudication(result).status, 'bound');
  assert.deepEqual(result.warnings, [relationWarning]);
  const before = structuredClone(result);
  assert.doesNotThrow(() => assertWorkflowResultReady(result, spec)); assert.deepEqual(result, before);
  for (const status of [undefined, 'passed', 'facts-pass', 'complete']) {
    assert.throws(() => assertWorkflowResultReady({ ...result, qualityCheckStatus: status }, spec), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  }
  for (const warnings of [[], [oldWarning], [newWarning]]) {
    assert.throws(() => assertWorkflowResultReady({ ...result, warnings }, spec), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  }
  for (const primary of [true, false]) {
    const otherFailure = await resultWithFailure(primary);
    assert.throws(() => assertWorkflowResultReady({ ...otherFailure, warnings: [relationWarning] }, spec),
      { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  }
});

test('relation warning cannot bypass binding, erase history, accept a forged envelope or authorize revision', async () => {
  const result = await resultWithFailure('relation');
  for (const mutate of [
    value => { delete value.reviewAdjudication; },
    value => { value.chapters[0].body += '改动'; },
    value => { value.review.continuityChainFailure.primaryResponseSha256 = '0'.repeat(64); },
    value => { value.review.continuityChainFailure.historicalObservations.shift(); },
    value => { value.review.continuityChainFailure.automaticRevisionEligible = true; },
    value => { value.review.continuityChainFailure.semanticAcceptance = true; },
    value => { value.review.continuityChainFailure.schemaVersion = 'unknown-failure'; },
  ]) {
    const changed = structuredClone(result); mutate(changed);
    assert.throws(() => assertWorkflowResultReady(changed, spec), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  }
});

test('primary distinct-evidence failure keeps primary warning and incomplete status without inventing a repair', async () => {
  const result = await resultWithFailure('primary-evidence'), failure = result.review.continuityChainFailure;
  assert.equal(failure.schemaVersion, 'continuity-chain-primary-failure-1');
  assert.equal(failure.failureCode, 'CASE_NEEDS_DISTINCT_EVIDENCE');
  assert.equal(failure.repairAttempted, false); assert.equal(failure.semanticAcceptance, false);
  assert.equal(failure.automaticRevisionEligible, false); assert.equal(projectReviewAdjudication(result).status, 'bound');
  assert.deepEqual(result.warnings, [newWarning]);
  assert.doesNotThrow(() => assertWorkflowResultReady(result, spec));
  for (const qualityCheckStatus of ['passed', 'facts-pass', 'complete']) {
    assert.throws(() => assertWorkflowResultReady({ ...result, qualityCheckStatus }, spec), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  }
  assert.throws(() => assertWorkflowResultReady({ ...result, warnings: [relationWarning] }, spec), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
});
