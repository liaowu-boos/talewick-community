import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CHAPTER_BUDGET_VERSION, normalizeChapterBudgets, chapterWritingBudget } from './chapter-budget.mjs';
import { runWorkflow } from './workflow.mjs';
import { runChecks } from '../../validation/runtime/checks.mjs';
import { createAIController } from '../../product/talewick-gui/server/agent-ai-sdk.mjs';
import { ENGINE_VERSIONS } from '../../product/talewick-gui/server/engines.mjs';

// Synthetic scenes exercise scope, persistence and allocation; they do not measure literary quality.
const clone = structuredClone;
const json = JSON.stringify;
const hash = value => createHash('sha256').update(json(value)).digest('hex');
const han = body => (body.match(/\p{Script=Han}/gu) ?? []).length;
const request = { projectId: 'chapter-budget-synthetic', kind: 'create', idea: '写两章修桥的完整故事，参考九百到一千一百汉字，场景完成后自然收束。', context: {}, materials: [], style: null };
const requirements = { status: 'ready', summary: '修桥并实际重新通行', genre: '当代', pointOfView: '第三人称', setting: '村庄', targetHanMin: 900, targetHanMax: 1100, targetChapterCount: 2,
  requiredElements: ['桥重新通行'], prohibitions: [], assumptions: [], usesChapter4Cut: false, completeEnding: true };
const plannedChapters = [
  { id: 'ch-1', title: '断桥', goal: '发现桥面破损并找到修理材料', continuity: '带回铁钉，为下一章修桥提供材料', scenes: ['发现断木，找到可用的铁钉'], targetHanMin: 200, targetHan: 300, targetHanMax: 400 },
  { id: 'ch-2', title: '通行', goal: '装好桥面并实际重新通行', continuity: '使用前章材料，过桥完成主线', scenes: ['合作换上桥板，承受一次失败', '修好桥面，村民实际过桥'], targetHanMin: 500, targetHan: 700, targetHanMax: 900 },
];
const plan = { title: '桥', premise: '桥面破损阻断通行', ending: '修好的桥恢复通行', constraints: [], chapters: plannedChapters };
const normalizedPlan = () => ({ ...clone(plan), lengthPolicyVersion: CHAPTER_BUDGET_VERSION });
const prose = { 'draft:ch-1': '她找到桥上的断木，带回一颗铁钉。', 'draft:ch-2': '两人装好桥板。第一块木板裂了，他们换上完整的木料。桥修好了，村民实际走过桥。' };
const review = { summary: '村民找到材料、修好桥面并恢复通行。', issues: [], strengths: ['行动已完成'], limitations: [] };
const record = artifacts => async (key, value) => { artifacts[key] = clone(value); };

function modelFixture({ plans = [plan], drafts = {}, overrides = {} } = {}) {
  const calls = [];
  let planIndex = 0;
  return { calls, async complete(args) {
    calls.push(clone({ stage: args.stage, system: args.system, user: args.user, maxTokens: args.maxTokens }));
    if (overrides[args.stage]) return overrides[args.stage](args);
    if (args.stage === 'requirements') return json(requirements);
    if (args.stage === 'planning') return json(plans[Math.min(planIndex++, plans.length - 1)]);
    if (args.stage.startsWith('draft:')) return drafts[args.stage] ?? prose[args.stage];
    if (['review', 'revisionReview'].includes(args.stage)) return json(review);
    throw new Error(`Unexpected synthetic stage: ${args.stage}`);
  } };
}

async function savedRequirements(controller) {
  const artifacts = {};
  const stopped = new Error('synthetic checkpoint boundary');
  await assert.rejects(runWorkflow({ request, model: modelFixture(), controller, checkpoint: async (key, value) => {
    assert.equal(key, 'requestSpec');
    artifacts[key] = clone(value);
    throw stopped;
  } }), error => error === stopped);
  return artifacts;
}

function legacyPlan() {
  return { title: plan.title, premise: plan.premise, ending: plan.ending, constraints: [], chapters: plannedChapters.map(({ id, title, goal, continuity, targetHan }) => ({ id, title, goal, continuity, targetHan })) };
}

test('planning preserves unequal scene allocations instead of averaging or scaling them', () => {
  const chapters = [
    { ...plannedChapters[0], id: 'short-opening', targetHanMin: 100, targetHan: 200, targetHanMax: 300 },
    { ...plannedChapters[1], id: 'main-scene', targetHanMin: 1300, targetHan: 1500, targetHanMax: 1700 },
    { ...plannedChapters[1], id: 'brief-ending', targetHanMin: 200, targetHan: 300, targetHanMax: 400 },
  ];
  const before = clone(chapters);
  const result = normalizeChapterBudgets(chapters, { targetHanMin: 1900, targetHanMax: 2100 });
  assert.deepEqual(result, before);
  assert.deepEqual(chapters, before);
  assert.deepEqual(result.map(chapter => chapter.targetHan), [200, 1500, 300]);
  assert.notEqual(result[0], chapters[0]);
});

test('new planning rejects missing or contradictory scope rather than silently inventing chapter budgets', async t => {
  const cases = [
    ['missing minimum', { targetHanMin: undefined }], ['numeric string', { targetHanMin: '200' }],
    ['fractional target', { targetHan: 300.5 }], ['zero minimum', { targetHanMin: 0 }],
    ['infinite maximum', { targetHanMax: Infinity }], ['maximum beyond supported scope', { targetHanMax: 30001 }],
    ['target below minimum', { targetHan: 100 }], ['target above maximum', { targetHan: 500 }],
    ['missing scenes', { scenes: undefined }], ['empty scenes', { scenes: [] }],
    ['empty scene item', { scenes: ['场景完成', ' '] }], ['non-string scene', { scenes: [1] }],
    ['missing handoff', { continuity: '' }],
  ];
  for (const [name, changed] of cases) await t.test(name, () => {
    const chapters = clone(plannedChapters);
    Object.assign(chapters[0], changed);
    assert.throws(() => normalizeChapterBudgets(chapters, requirements), /故事规划第 1 章/);
  });
  for (const bounds of [{ targetHanMin: 1200, targetHanMax: 1400 }, { targetHanMin: 600, targetHanMax: 800 }]) {
    assert.throws(() => normalizeChapterBudgets(plannedChapters, bounds), /合计 1000/);
    assert.deepEqual(plannedChapters.map(chapter => chapter.targetHan), [300, 700]);
  }
});

test('dynamic budget counts only actual prose Han and retains the next chapter allocation', () => {
  const previousChapters = [{ id: 'ch-1', title: '这段标题不能计入', body: '甲A😀 \n乙𠮷。' }];
  const state = { requirements, plan: normalizedPlan(), chapterIndex: 1, previousChapters };
  const before = clone(state);
  const budget = chapterWritingBudget(state);
  assert.equal(budget.planOrigin, 'planned_ranges');
  assert.equal(budget.written.hanCount, 3);
  assert.equal(budget.written.hanCount, runChecks({ chapters: previousChapters }).bodyHanCount);
  assert.deepEqual(budget.written.chapters, [{ id: 'ch-1', hanCount: 3 }]);
  assert.deepEqual(budget.currentChapter, { id: 'ch-2', min: 500, target: 700, max: 900 });
  assert.deepEqual(budget.operationalChapter, {
    id: 'ch-2', min: 500, target: 700, max: 900, status: 'planned_range_available', executable: true,
    targetAllowance: 1097, maxAllowance: 1097, availableHan: 1097, shortfallToPlannedMin: 0,
    futureReserve: { chapterCount: 0, plannedMin: 0, plannedTarget: 0 },
    nonTruncationRule: '控制展开尺度，不裁切模型返回正文；必要行动、因果交接和结局仍须完整。',
    fallbackAction: null,
  });
  assert.deepEqual(budget.remaining, { includesCurrentChapter: true, chapterCount: 1, min: 897, max: 1097, plannedMin: 500, plannedTarget: 700, plannedMax: 900 });
  assert.equal(budget.projectedTotalHan, 703);
  assert.equal(budget.overrunHan, 0);
  assert.deepEqual(state, before);
});

test('budget exposes shortage and overrun without creating negative limits or reallocating the ending', () => {
  const state = { requirements, plan: normalizedPlan(), chapterIndex: 1, previousChapters: [{ id: 'ch-1', title: '超长前文', body: '甲'.repeat(1200) }] };
  const budget = chapterWritingBudget(state);
  assert.equal(budget.remaining.min, 0);
  assert.equal(budget.remaining.max, 0);
  assert.equal(budget.overrunHan, 100);
  assert.equal(budget.rangeConflict, true);
  assert.equal(budget.projectedTotalHan, 1900);
  assert.deepEqual(budget.currentChapter, { id: 'ch-2', min: 500, target: 700, max: 900 });
  assert.deepEqual(budget.operationalChapter, {
    id: 'ch-2', min: null, target: null, max: null, status: 'no_safe_headroom', executable: false,
    targetAllowance: 0, maxAllowance: 0, availableHan: 0, shortfallToPlannedMin: 500,
    futureReserve: { chapterCount: 0, plannedMin: 0, plannedTarget: 0 },
    nonTruncationRule: '控制展开尺度，不裁切模型返回正文；必要行动、因果交接和结局仍须完整。',
    fallbackAction: '没有满足计划最低容量的可执行范围；按批准计划完整写完必要行动，终检依据实际完成正文判定篇幅是否满足。',
  });
  const underCapacity = chapterWritingBudget({ ...state, previousChapters: [], plan: { ...normalizedPlan(), chapters: [plannedChapters[1]] }, chapterIndex: 0, requirements: { targetHanMin: 1000, targetHanMax: 1200 } });
  assert.equal(underCapacity.rangeConflict, true);
  assert.equal(underCapacity.currentChapter.target, 700);
});

test('actual cumulative overage contracts the next target while preserving the approved plan and future capacity', () => {
  const threeChapterPlan = { ...normalizedPlan(), chapters: [
    { ...plannedChapters[0], id: 'ch-1' },
    { ...plannedChapters[0], id: 'ch-2' },
    { ...plannedChapters[1], id: 'ch-3' },
  ] };
  const state = {
    requirements: { targetHanMin: 900, targetHanMax: 1200 }, threeChapterPlan,
    plan: threeChapterPlan, chapterIndex: 1,
    previousChapters: [{ id: 'ch-1', body: '甲'.repeat(500) }],
  };
  const before = clone(state);
  const budget = chapterWritingBudget(state);
  assert.deepEqual(budget.currentChapter, { id: 'ch-2', min: 200, target: 300, max: 400 });
  assert.deepEqual(budget.operationalChapter, {
    id: 'ch-2', min: 200, target: 200, max: 200, status: 'constrained_by_actual_prose', executable: true,
    targetAllowance: 0, maxAllowance: 200, availableHan: 200, shortfallToPlannedMin: 0,
    futureReserve: { chapterCount: 1, plannedMin: 500, plannedTarget: 700 },
    nonTruncationRule: '控制展开尺度，不裁切模型返回正文；必要行动、因果交接和结局仍须完整。',
    fallbackAction: null,
  });
  assert.deepEqual(state, before, 'dynamic guidance must not rewrite the approved plan or prior prose');

  const recoverable = chapterWritingBudget({ ...state, requirements: { targetHanMin: 900, targetHanMax: 1500 } });
  assert.deepEqual(recoverable.operationalChapter, {
    id: 'ch-2', min: 200, target: 300, max: 400, status: 'planned_range_available', executable: true,
    targetAllowance: 300, maxAllowance: 500, availableHan: 500, shortfallToPlannedMin: 0,
    futureReserve: { chapterCount: 1, plannedMin: 500, plannedTarget: 700 },
    nonTruncationRule: '控制展开尺度，不裁切模型返回正文；必要行动、因果交接和结局仍须完整。',
    fallbackAction: null,
  });
});

test('legacy unknown ranges remain unknown rather than becoming equal shares or inferred promises', () => {
  const legacy = legacyPlan();
  legacy.chapters[1].targetHan = null;
  const before = clone(legacy);
  const budget = chapterWritingBudget({ requirements, plan: legacy, chapterIndex: 1, previousChapters: [{ id: 'ch-1', body: '甲乙' }] });
  assert.equal(budget.planOrigin, 'legacy_plan');
  assert.deepEqual(budget.currentChapter, { id: 'ch-2', min: null, target: null, max: null });
  assert.equal(budget.remaining.plannedMin, null);
  assert.equal(budget.remaining.plannedTarget, null);
  assert.equal(budget.remaining.plannedMax, null);
  assert.equal(budget.projectedTotalHan, null);
  assert.deepEqual(legacy, before);
  const unspecified = chapterWritingBudget({ requirements: {}, plan: legacy, chapterIndex: 1, previousChapters: [] });
  assert.deepEqual(unspecified.whole, { min: null, max: null });
  assert.equal(unspecified.remaining.min, null);
  assert.equal(unspecified.remaining.max, null);
});

test('a complete short chapter continues to the ending without a padding or revision call', async () => {
  const artifacts = {};
  const model = modelFixture();
  const result = await runWorkflow({ request, model, checkpoint: record(artifacts) });
  assert.deepEqual(model.calls.map(call => call.stage), ['requirements', 'planning', 'draft:ch-1', 'draft:ch-2', 'review']);
  assert.equal(artifacts.plan.lengthPolicyVersion, CHAPTER_BUDGET_VERSION);
  assert.deepEqual(artifacts.plan.chapters.map(({ targetHanMin, targetHan, targetHanMax, scenes }) => ({ targetHanMin, targetHan, targetHanMax, scenes })), plannedChapters.map(({ targetHanMin, targetHan, targetHanMax, scenes }) => ({ targetHanMin, targetHan, targetHanMax, scenes })));
  assert.equal(result.chapters[0].body, prose['draft:ch-1']);
  assert.equal(result.chapters[1].body, prose['draft:ch-2']);
  assert.equal(result.revisionApplied, false);
  assert.ok(result.checks.issues.some(issue => issue.code === 'BELOW_REQUESTED_LENGTH'));
  const nextInput = JSON.parse(model.calls.find(call => call.stage === 'draft:ch-2').user);
  assert.equal(nextInput.writingBudget.written.hanCount, han(prose['draft:ch-1']));
  assert.equal(nextInput.writingBudget.remaining.min, 900 - han(prose['draft:ch-1']));
  assert.equal(nextInput.writingBudget.currentChapter.target, 700, 'the short opening must not increase the ending target');
  assert.deepEqual(nextInput.previousChapters, [result.chapters[0]]);
  const reviewInput = JSON.parse(model.calls.find(call => call.stage === 'review').user);
  assert.deepEqual(Object.keys(reviewInput).sort(), ['chapters', 'requirements'], 'independent review must not receive the author plan or its budget rationale');
});

test('new plan formatting is corrected at most once before prose and never silently normalized into equal lengths', async () => {
  const missing = clone(plan);
  delete missing.chapters[0].targetHanMin;
  const recovered = modelFixture({ plans: [missing, plan] });
  const artifacts = {};
  await runWorkflow({ request, model: recovered, checkpoint: record(artifacts) });
  assert.deepEqual(recovered.calls.map(call => call.stage), ['requirements', 'planning', 'planning', 'draft:ch-1', 'draft:ch-2', 'review']);
  assert.deepEqual(artifacts.plan.chapters.map(chapter => chapter.targetHan), [300, 700]);
  const rejectedArtifacts = {};
  const rejected = modelFixture({ plans: [missing] });
  await assert.rejects(runWorkflow({ request, model: rejected, checkpoint: record(rejectedArtifacts) }), /规划|targetHanMin/);
  assert.equal(rejected.calls.filter(call => call.stage === 'planning').length, 2);
  assert.equal(rejected.calls.some(call => call.stage.startsWith('draft:')), false);
  assert.equal(rejectedArtifacts.plan, undefined);
});

test('a provider failure in planning does not consume an extra format-repair request', async () => {
  const unavailable = new Error('synthetic provider unavailable');
  const model = modelFixture({ overrides: { planning: () => { throw unavailable; } } });
  await assert.rejects(runWorkflow({ request, model }), error => error === unavailable);
  assert.deepEqual(model.calls.map(call => call.stage), ['requirements', 'planning']);
});

test('resume reuses completed chapters and derives the same dynamic budget from saved prose', async () => {
  const artifacts = {};
  let attempts = 0;
  const model = modelFixture({ overrides: { 'draft:ch-2': () => {
    if (++attempts === 1) throw new Error('synthetic draft interrupted');
    return prose['draft:ch-2'];
  } } });
  const checkpoint = record(artifacts);
  await assert.rejects(runWorkflow({ request, model, artifacts, checkpoint }), /synthetic draft interrupted/);
  const original = clone({ requestSpec: artifacts.requestSpec, plan: artifacts.plan, first: artifacts['draft:ch-1'] });
  const result = await runWorkflow({ request, model, artifacts, checkpoint });
  assert.deepEqual({ requestSpec: artifacts.requestSpec, plan: artifacts.plan, first: artifacts['draft:ch-1'] }, original);
  assert.equal(model.calls.filter(call => call.stage === 'planning').length, 1);
  assert.equal(model.calls.filter(call => call.stage === 'draft:ch-1').length, 1);
  const secondInputs = model.calls.filter(call => call.stage === 'draft:ch-2').map(call => JSON.parse(call.user));
  assert.equal(secondInputs.length, 2);
  assert.deepEqual(secondInputs[0], secondInputs[1]);
  assert.equal(result.chapters[0].body, original.first.body);
});

test('old fixed checkpoints continue without adding range fields or repeating their completed first chapter', async () => {
  const artifacts = await savedRequirements();
  artifacts.plan = legacyPlan();
  artifacts['draft:ch-1'] = { id: 'ch-1', title: '断桥', body: prose['draft:ch-1'] };
  const originalPlan = json(artifacts.plan);
  const originalSpec = json(artifacts.requestSpec);
  const originalFirst = json(artifacts['draft:ch-1']);
  const model = modelFixture();
  await runWorkflow({ request, model, artifacts, checkpoint: record(artifacts) });
  assert.deepEqual(model.calls.map(call => call.stage), ['draft:ch-2', 'review']);
  assert.equal(json(artifacts.plan), originalPlan);
  assert.equal(json(artifacts.requestSpec), originalSpec);
  assert.equal(json(artifacts['draft:ch-1']), originalFirst);
  const budget = JSON.parse(model.calls[0].user).writingBudget;
  assert.equal(budget.planOrigin, 'legacy_plan');
  assert.equal(budget.currentChapter.min, null);
  assert.equal(budget.currentChapter.max, null);
  assert.equal(budget.currentChapter.target, 700);
});

test('an already approved legacy Agent plan is not re-approved, re-planned or rewritten during resume', async () => {
  const controller = { runtimeVersion: ENGINE_VERSIONS['ai-sdk'], plan: async () => { throw new Error('completed plan must not run the controller'); } };
  const artifacts = await savedRequirements(controller);
  artifacts.plan = legacyPlan();
  artifacts.agentPlan = { plan: clone(artifacts.plan), trace: [{ phase: 'plan', action: 'approve_plan', reason: '合成旧任务已批准' }] };
  artifacts['draft:ch-1'] = { id: 'ch-1', title: '断桥', body: prose['draft:ch-1'] };
  const snapshots = json({ plan: artifacts.plan, agentPlan: artifacts.agentPlan, spec: artifacts.requestSpec });
  const model = modelFixture();
  const result = await runWorkflow({ request, model, artifacts, checkpoint: record(artifacts), controller });
  assert.deepEqual(model.calls.map(call => call.stage), ['draft:ch-2', 'review']);
  assert.equal(json({ plan: artifacts.plan, agentPlan: artifacts.agentPlan, spec: artifacts.requestSpec }), snapshots);
  assert.equal(result.runtimeVersion, ENGINE_VERSIONS['ai-sdk']);
});

test('a legacy pending Agent approval retains its exact plan hash and completes without a new Agent model call', async () => {
  const runtime = createAIController({ config: {} });
  // A persisted approval finishes before createAgentModel; missing credentials ensure an unexpected call fails locally.
  const controller = { runtimeVersion: runtime.runtimeVersion, plan: runtime.plan };
  const artifacts = await savedRequirements(controller);
  artifacts.plan = legacyPlan();
  const state = { plan: clone(artifacts.plan), replans: 0, done: false };
  const journal = { version: ENGINE_VERSIONS['ai-sdk'], binding: hash({ version: ENGINE_VERSIONS['ai-sdk'], phase: 'plan', input: request, requirements: artifacts.requestSpec.requirements, initial: artifacts.plan }),
    modelSteps: 1, toolCalls: 1, trace: [], state,
    pending: { name: 'approve_plan', input: { reason: '合成旧方案已检查' }, sourceHash: hash(state), toolCallId: 'synthetic-legacy-approval', key: 'synthetic-legacy-approval' } };
  artifacts['agent:plan:state:journal'] = journal;
  const originalPlan = json(artifacts.plan);
  const model = modelFixture();
  const result = await runWorkflow({ request, model, artifacts, checkpoint: record(artifacts), controller });
  assert.deepEqual(model.calls.map(call => call.stage), ['draft:ch-1', 'draft:ch-2', 'review']);
  assert.equal(json(artifacts.plan), originalPlan);
  assert.equal(json(artifacts.agentPlan.plan), originalPlan);
  assert.equal(artifacts['agent:plan:state:journal'].binding, journal.binding);
  assert.equal(artifacts['agent:plan:state:journal'].state.done, true);
  assert.equal(artifacts['agent:plan:state:journal'].pending, null);
  assert.equal(result.agentTrace.filter(entry => entry.action === 'approve_plan').length, 1);
});

test('over-budget existing prose does not suppress or mechanically shrink the final chapter', async () => {
  const first = '甲'.repeat(1200);
  const model = modelFixture({ drafts: { 'draft:ch-1': first } });
  const result = await runWorkflow({ request, model });
  assert.deepEqual(model.calls.map(call => call.stage), ['requirements', 'planning', 'draft:ch-1', 'draft:ch-2', 'review']);
  const endingInput = JSON.parse(model.calls.find(call => call.stage === 'draft:ch-2').user);
  assert.equal(endingInput.writingBudget.remaining.max, 0);
  assert.equal(endingInput.writingBudget.overrunHan, 100);
  assert.deepEqual(endingInput.writingBudget.operationalChapter, {
    id: 'ch-2', min: null, target: null, max: null, status: 'no_safe_headroom', executable: false,
    targetAllowance: 0, maxAllowance: 0, availableHan: 0, shortfallToPlannedMin: 500,
    futureReserve: { chapterCount: 0, plannedMin: 0, plannedTarget: 0 },
    nonTruncationRule: '控制展开尺度，不裁切模型返回正文；必要行动、因果交接和结局仍须完整。',
    fallbackAction: '没有满足计划最低容量的可执行范围；按批准计划完整写完必要行动，终检依据实际完成正文判定篇幅是否满足。',
  });
  assert.equal(endingInput.currentChapter.targetHan, 700);
  assert.equal(endingInput.currentChapter.goal, plannedChapters[1].goal);
  assert.equal(endingInput.plan.ending, plan.ending);
  assert.equal(result.chapters[0].body, first);
  assert.equal(result.chapters[1].body, prose['draft:ch-2']);
  assert.ok(result.checks.issues.some(issue => issue.code === 'ABOVE_REQUESTED_LENGTH'));
  assert.equal(result.checks.requestConformance.status, 'NOT_MET');
  assert.deepEqual(result.requestConformance, result.checks.requestConformance);
  assert.deepEqual(result.checks.requestConformance.length, {
    status: 'ABOVE_MAXIMUM', actualHan: han(first) + han(prose['draft:ch-2']), min: 900, max: 1100,
    belowMinimumBy: 0, aboveMaximumBy: han(first) + han(prose['draft:ch-2']) - 1100,
  });
});
