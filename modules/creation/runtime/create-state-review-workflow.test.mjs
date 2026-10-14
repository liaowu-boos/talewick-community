import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from './workflow.mjs';
import { syntheticAdjudicationResponse } from '../../validation/tests/fixtures/synthetic-adjudication.mjs';
import { manuscriptFingerprint } from '../../validation/runtime/checks.mjs';

const request = { kind: 'create', idea: '写一篇重读退信的两章短篇。' };
const requirements = { summary: '重读退信', targetHanMin: 1, targetHanMax: 1000,
  targetChapterCount: 2, assumptions: [], requiredElements: [], prohibitions: [] };
const plan = { title: '退信', premise: '她重读退信', ending: '保留未决', chapters: [1, 2].map(n => ({
  title: `场景${n}`, goal: '重读与等待', scenes: ['重读旧信'], continuity: '保留未决',
  targetHanMin: 40, targetHan: 100, targetHanMax: 150,
})) };
const first = '她已经读到回执，知道信已退回。她把手缩回袖口。';
const second = '他又来，她仍把手缩回袖口。她第一次知道信已退回。她没有答应。';
const generalReview = { summary: '仍保持未决', issues: [], strengths: ['动作反复'], limitations: [] };

function stateResponse(args, { invalidHash = false } = {}) {
  const input = JSON.parse(args.user);
  const hasReset = input.chapters[1].fragments.some(item => item.text.includes('第一次知道'));
  const evidence = (n, needle) => {
    const fragment = input.chapters[n].fragments.find(item => item.text.includes(needle));
    assert.ok(fragment);
    return { chapterId: input.chapters[n].id, fragmentStart: fragment.id, fragmentEnd: fragment.id,
      role: 'narration', actor: '她' };
  };
  return JSON.stringify({
    inputHash: invalidHash ? '0'.repeat(64) : input.inputHash,
    manuscriptSha256: input.manuscriptSha256,
    checkedChapterIds: input.chapters.map(chapter => chapter.id),
    checkedDimensions: ['knowledge', 'obligation', 'physical_state', 'time', 'promise'],
    coverage: { status: 'complete', omissions: [] },
    comparisons: hasReset ? [{ id: 'knowledge-1', dimension: 'knowledge', subject: '退信已知事实',
      identity: 'same', time: 'ordered_events',
      before: { state: '已经知道', certainty: 'stated', evidence: evidence(0, '知道信已退回') },
      after: { state: '第一次知道', certainty: 'stated', evidence: evidence(1, '第一次知道') },
      alternatives: [{ explanation: '合成语句指同一封信', status: 'ruled_out', evidence: [0, 1] }],
      counterEvidence: [], assessment: 'conflict_candidate', reason: '合成回归案例',
      issue: { evidenceIndex: 1, category: 'STORY_COMPREHENSION_BLOCKER', severity: 'must_fix',
        explanation: '合成已知事实重置', suggestion: '承接已知事实' },
    }] : [],
    hintChecks: input.transitionHints.hints.map(hint => ({ hintId: hint.id,
      status: hasReset && hint.matched === '第一次' ? 'compared' : 'explained',
      comparisonIds: hasReset && hint.matched === '第一次' ? ['knowledge-1'] : [],
      reason: '定位本身不是裁定，合成对照另作判断' })),
  });
}

function model({ invalidHash = false, decision = 'reject' } = {}) {
  const calls = [];
  return { calls, complete: async args => {
    calls.push(args);
    if (args.stage === 'requirements') return JSON.stringify(requirements);
    if (args.stage === 'planning') return JSON.stringify(plan);
    if (args.stage === 'draft:ch-1') return first;
    if (args.stage === 'draft:ch-2') return second;
    if (['review', 'revisionReview', 'agent:reviewManuscript'].includes(args.stage)) return JSON.stringify(generalReview);
    if (args.stage === 'continuity-review') return stateResponse(args, { invalidHash });
    if (args.stage === 'review-adjudication') return syntheticAdjudicationResponse(JSON.parse(args.user), decision);
    if (['revision:ch-2', 'agent:reviseChapter:ch-2'].includes(args.stage)) {
      const input = JSON.parse(args.user);
      return JSON.stringify({ replacements: input.revisionScope.ranges.map(range => ({ ...range,
        replacement: range.quote.replace('她第一次知道信已退回。', '她又想起那封退回的信。'),
      })) });
    }
    throw new Error(`Unexpected stage: ${args.stage}`);
  } };
}

test('explicit create state review merges a candidate but independent rejection forbids an edit', async () => {
  const artifacts = {}, checkpoint = async (key, value) => { artifacts[key] = value; };
  const worker = model();
  const result = await runWorkflow({ request, createStateReviewMode: 'create-state-review-v1',
    model: worker, artifacts, checkpoint });
  assert.deepEqual(worker.calls.map(call => call.stage),
    ['requirements', 'planning', 'draft:ch-1', 'draft:ch-2', 'review', 'continuity-review', 'review-adjudication']);
  assert.equal(artifacts.requestSpec.runtimeVersion, 'fixed-workflow-create-state-review-1');
  assert.equal(artifacts.requestSpec.createStateReviewMode, 'create-state-review-v1');
  assert.equal(artifacts['review:general'].issues.length, 0);
  assert.equal(artifacts['review:state'].issues.length, 1);
  assert.equal(result.review.issues.length, 1);
  assert.equal(result.revisionApplied, false);
  assert.deepEqual(result.chapters.map(chapter => chapter.body), [first, second]);
  const count = worker.calls.length;
  await runWorkflow({ request, createStateReviewMode: 'create-state-review-v1', model: worker,
    artifacts, checkpoint });
  assert.equal(worker.calls.length, count);
  await assert.rejects(runWorkflow({ request, model: worker, artifacts, checkpoint }), /执行版本/);
  assert.equal(worker.calls.length, count);
});

test('create-state-review-v1 production entry passes the actual-length operational floor to later drafting', async () => {
  const constrainedRequirements = { ...requirements, targetHanMin: 900, targetHanMax: 1200, targetChapterCount: 3 };
  const constrainedPlan = { ...plan, chapters: [
    { ...plan.chapters[0], targetHanMin: 100, targetHan: 200, targetHanMax: 300 },
    { ...plan.chapters[1], targetHanMin: 200, targetHan: 300, targetHanMax: 400 },
    { ...plan.chapters[1], title: '场景3', targetHanMin: 500, targetHan: 700, targetHanMax: 900 },
  ] };
  const han = value => (value.match(/\p{Script=Han}/gu) ?? []).length;
  const longFirst = `${first}${'甲'.repeat(500 - han(first))}`;
  const worker = model();
  const fallback = worker.complete;
  worker.complete = async args => {
    if (args.stage === 'requirements') { worker.calls.push(args); return JSON.stringify(constrainedRequirements); }
    if (args.stage === 'planning') { worker.calls.push(args); return JSON.stringify(constrainedPlan); }
    if (args.stage === 'draft:ch-1') { worker.calls.push(args); return longFirst; }
    if (args.stage === 'draft:ch-2') {
      worker.calls.push(args);
      const input = JSON.parse(args.user);
      assert.deepEqual(input.writingBudget.currentChapter,
        { id: 'ch-2', min: 200, target: 300, max: 400 });
      assert.deepEqual(input.writingBudget.operationalChapter, {
        id: 'ch-2', min: 200, target: 200, max: 200, status: 'constrained_by_actual_prose', executable: true,
        targetAllowance: 0, maxAllowance: 200, availableHan: 200, shortfallToPlannedMin: 0,
        futureReserve: { chapterCount: 1, plannedMin: 500, plannedTarget: 700 },
        nonTruncationRule: '控制展开尺度，不裁切模型返回正文；必要行动、因果交接和结局仍须完整。', fallbackAction: null,
      });
      return second;
    }
    if (args.stage === 'draft:ch-3') { worker.calls.push(args); return '她收起退信，保留未决。'; }
    return fallback(args);
  };
  const result = await runWorkflow({ request, createStateReviewMode: 'create-state-review-v1', model: worker });
  assert.equal(result.runtimeVersion, 'fixed-workflow-create-state-review-1');
  assert.equal(result.chapters[0].body, longFirst);
  assert.equal(result.chapters.length, 3);
});

function controller({ revise = false } = {}) {
  return { runtimeVersion: 'synthetic-controller-1',
    plan: async context => ({ plan: context.plan, trace: [] }),
    review: async context => {
      if (!revise) return { chapters: context.chapters, review: context.review,
        reviewAdjudication: context.reviewAdjudication, trace: [] };
      const revised = await context.reviseChapter({ chapters: context.chapters, chapterId: 'ch-2',
        issues: context.review.issues, review: context.review,
        reviewAdjudication: context.reviewAdjudication });
      const chapters = context.chapters.map(chapter => chapter.id === revised.id ? revised : chapter);
      const review = await context.reviewManuscript(chapters, context.review.issues);
      const reviewAdjudication = await context.adjudicateReview(chapters, review);
      return { chapters, review, reviewAdjudication, trace: [] };
    },
  };
}

test('create controller mode merges state review after its formal full reread and keeps old journals separate', async () => {
  const artifacts = {}, worker = model({ decision: 'confirm' }), agent = controller({ revise: true });
  const checkpoint = async (key, value) => { artifacts[key] = value; };
  const result = await runWorkflow({ request, createStateReviewMode: 'create-state-review-v1',
    controller: agent, model: worker, artifacts, checkpoint });
  assert.equal(result.runtimeVersion, 'synthetic-controller-1:create-state-review-1');
  assert.equal(result.revisionApplied, true);
  assert.equal(result.chapters[1].body,
    second.replace('她第一次知道信已退回。', '她又想起那封退回的信。'));
  assert.deepEqual(worker.calls.filter(call => ['review', 'continuity-review', 'agent:reviewManuscript'].includes(call.stage)).map(call => call.stage),
    ['review', 'continuity-review', 'agent:reviewManuscript', 'continuity-review']);
  const key = Object.keys(artifacts).find(name => /^agentReviewReading:[a-f0-9]{64}$/.test(name));
  assert.ok(key);
  assert.equal(artifacts[`${key}:general`].issues.length, 0);
  assert.equal(artifacts[`${key}:state`].issues.length, 0);
  assert.equal(artifacts[key].manuscriptSha256, result.review.manuscriptSha256);
  const count = worker.calls.length;
  await runWorkflow({ request, createStateReviewMode: 'create-state-review-v1',
    controller: agent, model: worker, artifacts, checkpoint });
  assert.equal(worker.calls.length, count);
  await assert.rejects(runWorkflow({ request, controller: agent, model: worker,
    artifacts, checkpoint }), /执行版本/);
  assert.equal(worker.calls.length, count);
  const legacyWorker = model({ decision: 'reject' });
  const legacyArtifacts = {}, legacyController = controller();
  const legacy = await runWorkflow({ request, controller: legacyController, model: legacyWorker,
    artifacts: legacyArtifacts, checkpoint: async (name, value) => { legacyArtifacts[name] = value; } });
  assert.equal(legacy.runtimeVersion, 'synthetic-controller-1');
  assert.equal(legacyWorker.calls.some(call => call.stage === 'continuity-review'), false);
  const legacyCount = legacyWorker.calls.length;
  await assert.rejects(runWorkflow({ request, createStateReviewMode: 'create-state-review-v1',
    controller: legacyController, model: legacyWorker, artifacts: legacyArtifacts }), /执行版本/);
  assert.equal(legacyWorker.calls.length, legacyCount);
});

test('controller cannot pass a fabricated post-edit review to adjudication without formal reread', async () => {
  const worker = model({ decision: 'confirm' });
  const agent = controller({ revise: true });
  agent.review = async context => {
    const revised = await context.reviseChapter({ chapters: context.chapters, chapterId: 'ch-2',
      issues: context.review.issues, review: context.review,
      reviewAdjudication: context.reviewAdjudication });
    const chapters = context.chapters.map(chapter => chapter.id === revised.id ? revised : chapter);
    const fabricated = { ...context.review, issues: [], manuscriptSha256: manuscriptFingerprint(chapters) };
    await context.adjudicateReview(chapters, fabricated);
    throw new Error('fabricated review must not be adjudicated');
  };
  await assert.rejects(runWorkflow({ request, createStateReviewMode: 'create-state-review-v1',
    controller: agent, model: worker }), /实际原审稿/);
  assert.equal(worker.calls.some(call => call.stage === 'agent:reviewManuscript'), false);
  assert.equal(worker.calls.filter(call => call.stage === 'continuity-review').length, 1);
});

test('confirmed create state issue receives one bounded edit and a fresh dual reread', async () => {
  const artifacts = {}, worker = model({ decision: 'confirm' });
  const result = await runWorkflow({ request, createStateReviewMode: 'create-state-review-v1',
    model: worker, artifacts, checkpoint: async (key, value) => { artifacts[key] = value; } });
  assert.equal(result.revisionApplied, true);
  assert.equal(result.chapters[1].body,
    second.replace('她第一次知道信已退回。', '她又想起那封退回的信。'));
  assert.equal(worker.calls.filter(call => call.stage === 'continuity-review').length, 2);
  assert.equal(worker.calls.filter(call => call.stage === 'revision:ch-2').length, 1);
  assert.equal(artifacts['revisionReview:state'].issues.length, 0);
  assert.ok(Object.values(artifacts).some(value => value?.status === 'reread_recorded'));
});

test('create state review failure resumes its saved general review without repeating it', async () => {
  const artifacts = {}, checkpoint = async (key, value) => { artifacts[key] = value; };
  const invalid = model({ invalidHash: true });
  await assert.rejects(runWorkflow({ request, createStateReviewMode: 'create-state-review-v1',
    model: invalid, artifacts, checkpoint }), error => error.code === 'STATE_REVIEW_REJECTED');
  assert.equal(artifacts['review:general'].issues.length, 0);
  assert.equal(artifacts.review, undefined);
  const retry = model();
  await runWorkflow({ request, createStateReviewMode: 'create-state-review-v1',
    model: retry, artifacts, checkpoint });
  assert.deepEqual(retry.calls.map(call => call.stage), ['continuity-review', 'review-adjudication']);
});

test('capped state response is archived before one format correction, then resumed from the saved state', async () => {
 const artifacts = {}, worker = model({ decision: 'reject' });
 const original = worker.complete;
 let stateCalls = 0;
 worker.complete = async args => {
  if (args.stage !== 'continuity-review') return original(args);
  worker.calls.push(args); stateCalls++;
  const value = JSON.parse(stateResponse(args, {}));
  value.comparisons = Array.from({ length: 8 }, (_, i) => ({ ...value.comparisons[0], id: `case-${i}`,
    issue: null }));
  value.hintChecks = value.hintChecks.map(h => ({ ...h,
    comparisonIds: h.comparisonIds.length ? ['case-0'] : [] }));
  if (stateCalls === 2) {
    assert.equal(JSON.parse(args.user).fieldError, '状态专审达到记录上限');
    value.coverage = { status: 'bounded', omissions: ['八条记录以外未逐项记录'] };
  }
  return JSON.stringify(value);
 };
 const checkpoint = async (key, value) => { artifacts[key] = value; };
 const result = await runWorkflow({ request, createStateReviewMode: 'create-state-review-v1',
   model: worker, artifacts, checkpoint });
 const rejectedKey = Object.keys(artifacts).find(key => key.startsWith('review:state:rejected:'));
 assert.ok(rejectedKey);
 assert.equal(artifacts[rejectedKey].attempt, 1);
 assert.equal(artifacts[rejectedKey].manuscriptSha256, artifacts['review:state'].manuscriptSha256);
 assert.equal(artifacts['review:state'].rejectedResponses[0].rawResponse, artifacts[rejectedKey].rawResponse);
 assert.equal(result.revisionApplied, false);
 assert.equal(stateCalls, 2);
 await runWorkflow({ request, createStateReviewMode: 'create-state-review-v1',
   model: worker, artifacts, checkpoint });
 assert.equal(stateCalls, 2);
});

test('same task never spends a second automatic format retry after two capped failures', async () => {
 const artifacts = {}, checkpoint = async (key, value) => { artifacts[key] = value; };
 const worker = model({ decision: 'reject' }), original = worker.complete;
 let stateCalls = 0;
 worker.complete = async args => {
  if (args.stage !== 'continuity-review') return original(args);
  worker.calls.push(args); stateCalls++;
  const value = JSON.parse(stateResponse(args, {}));
  value.comparisons = Array.from({ length: 8 }, (_, i) => ({ ...value.comparisons[0], id: `case-${i}`, issue: null }));
  value.hintChecks = value.hintChecks.map(h => ({ ...h,
    comparisonIds: h.comparisonIds.length ? ['case-0'] : [] }));
  return JSON.stringify(value);
 };
 const options = { request, createStateReviewMode: 'create-state-review-v1', model: worker, artifacts, checkpoint };
 await assert.rejects(runWorkflow(options), error => error.code === 'STATE_REVIEW_REJECTED');
 assert.equal(stateCalls, 2);
 assert.equal(Object.keys(artifacts).filter(key => key.startsWith('review:state:rejected:')).length, 2);
 await assert.rejects(runWorkflow(options), error => error.code === 'STATE_REVIEW_REJECTED');
 assert.equal(stateCalls, 3);
 assert.equal(Object.keys(artifacts).filter(key => key.startsWith('review:state:rejected:')).length, 3);
 assert.equal(worker.calls.filter(call => call.stage === 'review').length, 1);
});

test('default create workflow keeps its prior call count; state review mode rejects incompatible use', async () => {
  const worker = model();
  await runWorkflow({ request, model: worker });
  assert.equal(worker.calls.some(call => call.stage === 'continuity-review'), false);
  await assert.rejects(runWorkflow({ request, model: worker,
    createStateReviewMode: 'unknown' }), /未知新建创作状态专审版本/);
  await assert.rejects(runWorkflow({ request: { kind: 'revise' }, model: worker,
    createStateReviewMode: 'create-state-review-v1' }), /仅支持 create 流程/);
});
