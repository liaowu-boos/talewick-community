import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { TaskService, validateRequest } from './tasks.mjs';
import { assertWorkflowResultReady } from './workflow-result-gate.mjs';
import { projectImportSnapshot } from './project-import.mjs';
import { runWholeManuscriptQualityRevision } from '../../../creation/runtime/whole-manuscript-quality.mjs';
import { fixture as goalFixture } from '../../../creation/runtime/goal-opportunity-fixtures.mjs';
import { productManuscriptRevision } from './full15-service.mjs';

const bundle = await build({ stdin: { contents: `export {makeGoalImprovementPolicy,readGoalImprovementPolicy} from './src/model/goal-improvement-policy.ts';
export {makeWritingGoalInput} from './src/model/writing-goal-input.ts'; export {readRuntimeBinding} from './src/model/runtime.ts';
export {projectFromImportSnapshot} from './src/model/project-import.ts';
export {GoalIncrementDetails} from './src/features/ManuscriptPanel.tsx'; export {createElement} from 'react'; export {renderToStaticMarkup} from 'react-dom/server';`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx' }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(fileURLToPath(import.meta.url))});` } });
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const policy = ui.makeGoalImprovementPolicy(true);
const request = () => ({ projectId: 'goal-policy-local', requestId: 'goal-policy-request', kind: 'revise', revisionMode: 'whole-manuscript-v2',
  projectTitle: '未签的单据', idea: '测试目标策略', instruction: '保留人物选择，评估情绪变化。', baseRevision: 'frozen-original',
  chapters: [{ id: 'ch-1', title: '开场', body: '她把未签的单据收回。' }],
  writingGoals: ui.makeWritingGoalInput('emotion', '让被忽视的劳动得到承认，但仍可拒绝补偿。'), goalImprovementPolicy: policy });
const testRoot = fileURLToPath(new URL('../../../../../product/test-runs/', import.meta.url));
const until = async predicate => { for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('local task timeout'); };

test('policy is opt-in, copied exactly and strict; omitted old request shape stays unchanged', () => {
  assert.equal(ui.makeGoalImprovementPolicy(false), undefined);
  assert.deepEqual(validateRequest(request()).goalImprovementPolicy, policy);
  assert.notEqual(validateRequest(request()).goalImprovementPolicy, policy);
  const old = request(); delete old.goalImprovementPolicy;
  assert.equal(Object.hasOwn(validateRequest(old), 'goalImprovementPolicy'), false);
  for (const value of [null, {}, { ...policy, mode: 'force_improvement' }, { ...policy, maxOpportunitiesPerGoal: 2 }, { ...policy, extra: true }]) {
    assert.throws(() => validateRequest({ ...request(), goalImprovementPolicy: value }), { code: 'GOAL_IMPROVEMENT_POLICY_INVALID' });
    assert.equal(ui.readGoalImprovementPolicy(value), undefined);
  }
  const noGoals = request(); delete noGoals.writingGoals;
  assert.throws(() => validateRequest(noGoals), { code: 'GOAL_IMPROVEMENT_POLICY_INVALID' });
  assert.throws(() => validateRequest({ ...noGoals, revisionMode: 'whole-manuscript-v1' }));
});

test('saved request/checkpoint policy persists; changed resume input is rejected without workflow dispatch', async t => {
  await mkdir(testRoot, { recursive: true }); const runsDir = await mkdtemp(path.join(testRoot, 'goal-binding-'));
  t.after(() => rm(runsDir, { recursive: true, force: true }));
  let calls = 0;
  const workflow = async ({ request: input, checkpoint }) => {
    calls++; await checkpoint('requestSpec', { revisionMode: input.revisionMode, writingGoals: input.writingGoals, goalImprovementPolicy: input.goalImprovementPolicy });
    throw Error('synthetic stopped checkpoint');
  };
  const service = await new TaskService({ runsDir, workflow, model: {} }).init();
  const created = await service.create(request()); await until(() => !service.busy && service.get(created.id).status === 'failed');
  const file = path.join(runsDir, created.id, 'request.json');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).goalImprovementPolicy, policy);
  const old = request(); delete old.goalImprovementPolicy;
  await assert.rejects(service.create(old), { status: 409 }); await service.close();
  let resumed = await new TaskService({ runsDir, workflow, model: {} }).init();
  assert.deepEqual(resumed.requests.get(created.id).goalImprovementPolicy, policy); await resumed.close();
  const changed = JSON.parse(await readFile(file, 'utf8')); delete changed.goalImprovementPolicy;
  await writeFile(file, JSON.stringify(changed));
  resumed = await new TaskService({ runsDir, workflow, model: {} }).init(); t.after(() => resumed.close());
  assert.throws(() => resumed.get(created.id), { status: 404 }); assert.equal(calls, 1);
});

test('result gate binds the policy without upgrading or changing legacy whole-quality results', async () => {
  let calls = 0; const host = () => { calls++; };
  const input = request(), spec = { revisionMode: input.revisionMode, writingGoals: structuredClone(input.writingGoals), goalImprovementPolicy: policy };
  await assertWorkflowResultReady({ unchanged: true }, spec, input, null, host); assert.equal(calls, 1);
  assert.throws(() => assertWorkflowResultReady({}, { ...spec, goalImprovementPolicy: undefined }, input, null, host), { code: 'WORKFLOW_RESULT_UNVERIFIED' });
  assert.equal(calls, 1);
  const old = { revisionMode: input.revisionMode };
  await assertWorkflowResultReady({}, old, old, null, host); assert.equal(calls, 2);
});

test('browser persistence preserves opt-in and collapsed preserve-original reasoning without claiming improvement', () => {
  const input = request(), binding = ui.readRuntimeBinding({ request: input, baseManuscript: { title: input.projectTitle, chapters: input.chapters } }, input.projectId);
  assert.deepEqual(binding.request.goalImprovementPolicy, policy);
  const old = request(); delete old.goalImprovementPolicy;
  const legacy = ui.readRuntimeBinding({ request: old, baseManuscript: { title: old.projectTitle, chapters: old.chapters } }, old.projectId);
  assert.equal(Object.hasOwn(legacy.request, 'goalImprovementPolicy'), false);
  const value = { currentAchievement: 'present', currentAchievementReason: '她已经作出选择。', currentAchievementEvidence: [], opportunity: null,
    opportunityAssessment: 'preserve', opportunityReason: '进一步补写可能削弱克制。' };
  const before = JSON.stringify(value), html = ui.renderToStaticMarkup(ui.createElement(ui.GoalIncrementDetails, { value }));
  assert.match(html, /已有体现/); assert.match(html, /保留原稿/); assert.match(html, /没有修订也是有效结果/);
  assert.doesNotMatch(html, /<details open/); assert.equal(JSON.stringify(value), before);
});

test('new policy survives actual creation helper, strict result gate and source/candidate import without fabricating a create task', async () => {
  for (const preserve of [false, true]) {
    const f = goalFixture({ preserve });
    Object.assign(f.request, { projectId: `goal-import-${preserve}`, requestId: 'goal-import-request', idea: '离线候选导入测试',
      baseRevision: productManuscriptRevision(f.request.projectTitle, f.request.chapters) });
    const input = validateRequest(f.request), result = await runWholeManuscriptQualityRevision({ ...f.options, request: input });
    await assertWorkflowResultReady(result, f.artifacts.requestSpec, input);
    const task = { id: '55555555-5555-4555-8555-555555555555', projectId: input.projectId, requestId: input.requestId,
      kind: 'revise', revisionMode: input.revisionMode, baseRevision: input.baseRevision, status: 'completed', result,
      createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:01:00Z' };
    const tasks = { tasks: new Map([[task.id, task]]), requests: new Map([[task.id, input]]), artifacts: new Map([[task.id, f.artifacts]]),
      list: projectId => projectId === input.projectId ? [task] : [] };
    const snapshot = projectImportSnapshot(tasks, input.projectId), imported = ui.projectFromImportSnapshot(snapshot, input.projectId);
    assert.deepEqual(imported.runtime.request.goalImprovementPolicy, policy);
    assert.deepEqual(imported.chapters, input.chapters); assert.equal(snapshot.baselineManuscript.provenance, 'whole_revision_source');
    assert.ok(snapshot.history.every(row => row.kind !== 'create'));
    const changed = structuredClone(snapshot); delete changed.revisionRequest.goalImprovementPolicy;
    assert.throws(() => ui.projectFromImportSnapshot(changed, input.projectId));
  }
});
