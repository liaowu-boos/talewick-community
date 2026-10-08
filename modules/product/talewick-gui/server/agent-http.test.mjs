import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, closeFixture, configFor, makeAgentModels, originalBodies, revisedBody, requestFor, secretMarker, startAgentFixture, taskAt, until } from '../scripts/agent-runtime-smoke.mjs';

// These are real HTTP + workflow + ToolLoopAgent tests. The SDK LanguageModelV4
// and ordinary text model are explicit mocks, with no external provider call.
async function fixture(t, options = {}, engine = 'ai-sdk') {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-agent-http-'));
  const models = makeAgentModels(options);
  const runtime = await startAgentFixture(configFor(runsDir, engine), models);
  t.after(async () => { await closeFixture(runtime); await rm(runsDir, { recursive: true, force: true }); });
  return { runtime, models, runsDir };
}
async function submit(runtime, extra = {}) {
  const response = await api(runtime, '/api/tasks', requestFor(extra));
  assert.equal(response.status, 202, JSON.stringify(response.body));
  return response.body.task;
}
const actionNames = task => task.result.agentTrace.map(entry => entry.action);

for (const decision of ['reject', 'uncertain']) test(`SDK cannot revise an original must_fix adjudicated ${decision}`, async t => {
  const { runtime, models, runsDir } = await fixture(t, { reviewDecision: 'revise', adjudicationDecision: decision });
  const submitted = await submit(runtime);
  const completed = await taskAt(runtime, submitted.id);
  assert.deepEqual(completed.result.chapters.map(c => c.body), originalBodies);
  assert.equal(models.stageCalls.some(call => call.stage.startsWith('agent:reviseChapter:')), false);
  assert.equal(completed.result.review.issues[0].severity, 'must_fix');
  assert.equal(completed.result.reviewAdjudication.decisions[0].decision, decision);
  assert.equal(completed.result.reviewAdjudication.decisions[0].revisionEligible, false);
  const artifacts = JSON.parse(await readFile(path.join(runsDir, submitted.id, 'artifacts.json'), 'utf8'));
  assert.ok(artifacts['agent:review:state:journal'].rejections.some(item => item.action === 'revise_chapter'));
  assert.equal(completed.result.checks.full15.status, 'NOT_EVALUATED');
});

test('real ToolLoopAgent chooses different no-change and revision paths over the same manuscript', async t => {
  const retained = await fixture(t, { reviewDecision: 'finish' });
  const revised = await fixture(t, { reviewDecision: 'revise' });
  const first = await taskAt(retained.runtime, (await submit(retained.runtime)).id);
  const second = await taskAt(revised.runtime, (await submit(revised.runtime)).id);
  assert.equal(first.engine, 'ai-sdk'); assert.equal(second.engine, 'ai-sdk');
  assert.ok(first.engineVersion); assert.equal(second.engineVersion, first.engineVersion);
  assert.deepEqual(first.result.chapters.map(chapter => chapter.body), originalBodies);
  assert.deepEqual(second.result.chapters.map(chapter => chapter.body), [originalBodies[0], revisedBody]);
  assert.ok(actionNames(first).includes('approve_plan'));
  assert.ok(actionNames(first).includes('read_chapter'));
  assert.ok(actionNames(first).includes('finish_review'));
  assert.equal(actionNames(first).includes('revise_chapter'), false);
  assert.ok(actionNames(second).includes('revise_chapter'));
  assert.ok(actionNames(second).indexOf('review_manuscript') > actionNames(second).indexOf('revise_chapter'));
  assert.equal(second.result.review.manuscriptSha256, second.result.checks.manuscriptSha256);
  assert.ok(retained.models.agentModel.doGenerateCalls.length >= 4);
  assert.ok(revised.models.agentModel.doGenerateCalls.length > retained.models.agentModel.doGenerateCalls.length);
  for (const call of revised.models.stageCalls.filter(call => call.stage === 'agent:reviewManuscript')) {
    assert.equal(Object.hasOwn(call.input, 'plan'), false);
    assert.equal(Object.hasOwn(call.input, 'knowledge'), false);
    assert.equal(Object.hasOwn(call.input, 'agentTrace'), false);
  }
  assert.equal(second.result.checks.full15.status, 'NOT_EVALUATED');
});

test('an attempted finish after revision cannot bypass re-reading the actual final manuscript', async t => {
  const { runtime, models } = await fixture(t, { reviewDecision: 'revise', prematureFinish: true });
  const completed = await taskAt(runtime, (await submit(runtime)).id);
  const actions = models.decisions.filter(item => item.phase === 'review').map(item => item.action);
  const revision = actions.indexOf('revise_chapter');
  const earlyFinish = actions.indexOf('finish_review');
  const reread = actions.indexOf('review_manuscript');
  assert.ok(revision >= 0 && earlyFinish > revision && reread > earlyFinish, 'Mock must actually attempt the invalid early finish');
  assert.ok(actions.lastIndexOf('finish_review') > reread, 'Agent must finish again only after the re-read');
  assert.equal(models.stageCalls.filter(call => call.stage === 'agent:reviewManuscript').length, 1);
  assert.equal(completed.result.review.manuscriptSha256, completed.result.checks.manuscriptSha256);
  assert.equal(completed.result.chapters[1].body, revisedBody);
});

test('HTTP cancellation and resume preserve completed Agent tools and the original task identity', async t => {
  const { runtime, models, runsDir } = await fixture(t, { replan: true, pauseBefore: 'approve_plan' });
  const submitted = await submit(runtime);
  await until(() => models.controls.paused, 'Agent did not reach the post-replan model call');
  assert.equal(models.stageCalls.filter(call => call.stage === 'agent:replan').length, 1);
  assert.equal((await api(runtime, `/api/tasks/${submitted.id}/cancel`, {})).status, 200);
  await taskAt(runtime, submitted.id, ['cancelled']);
  await until(() => !runtime.tasks.busy, 'Cancelled SDK call is still active');
  assert.equal((await api(runtime, `/api/tasks/${submitted.id}`)).body.task.result, undefined);
  const cancelled = JSON.parse(await readFile(path.join(runsDir, submitted.id, 'task.json'), 'utf8'));
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.engine, 'ai-sdk');
  models.controls.pauseBefore = undefined; models.controls.gate.resolve();
  const resumed = await api(runtime, `/api/tasks/${submitted.id}/resume`, {});
  assert.equal(resumed.status, 200); assert.equal(resumed.body.task.id, submitted.id);
  const completed = await taskAt(runtime, submitted.id);
  assert.equal(completed.requestId, submitted.requestId);
  assert.equal(completed.engineVersion, submitted.engineVersion);
  assert.equal(models.stageCalls.filter(call => call.stage === 'planning').length, 1);
  assert.equal(models.stageCalls.filter(call => call.stage === 'agent:replan').length, 1);
  assert.equal(completed.result.agentTrace.filter(entry => entry.action === 'revise_plan').length, 1);
  assert.ok(models.decisions.some(item => item.resumed && item.completedActions.includes('revise_plan')), 'SDK resume prompt must include completed tool actions');
});

test('changing the default engine does not switch an existing Agent task during restart recovery', async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-agent-engine-binding-'));
  let first, reopened;
  try {
    const initialModels = makeAgentModels({ replan: true, pauseBefore: 'approve_plan' });
    first = await startAgentFixture(configFor(runsDir, 'ai-sdk'), initialModels);
    const submitted = await submit(first);
    await until(() => initialModels.controls.paused, 'Agent task did not pause after replan');
    await api(first, `/api/tasks/${submitted.id}/cancel`, {}); await until(() => !first.tasks.busy, 'Cancellation did not settle');
    await closeFixture(first); first = undefined;
    const resumedModels = makeAgentModels({ replan: true });
    reopened = await startAgentFixture(configFor(runsDir, 'fixed'), resumedModels);
    const info = await api(reopened, '/api/runtime');
    assert.equal(info.body.engine, 'fixed'); assert.ok(info.body.engineLabel);
    const restored = (await api(reopened, `/api/tasks/${submitted.id}`)).body.task;
    assert.equal(restored.engine, 'ai-sdk'); assert.equal(restored.engineVersion, submitted.engineVersion);
    assert.equal((await api(reopened, `/api/tasks/${submitted.id}/resume`, {})).status, 200);
    const completed = await taskAt(reopened, submitted.id);
    assert.equal(completed.engine, 'ai-sdk'); assert.equal(completed.engineVersion, submitted.engineVersion);
    assert.ok(resumedModels.agentModel.doGenerateCalls.length > 0);
    assert.equal(resumedModels.stageCalls.filter(call => call.stage === 'agent:replan').length, 0, 'Restart must reuse the persisted revised plan');
    assert.equal(completed.result.agentTrace.filter(entry => entry.action === 'revise_plan').length, 1);
  } finally { await closeFixture(first); await closeFixture(reopened); await rm(runsDir, { recursive: true, force: true }); }
});

test('legacy task records stay readable but cannot resume under the new review policy', async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-legacy-engine-'));
  let first, reopened;
  try {
    first = await startAgentFixture(configFor(runsDir, 'fixed'), makeAgentModels({ failFixedReviewOnce: true }));
    const submitted = await submit(first);
    await taskAt(first, submitted.id, ['failed']); await closeFixture(first); first = undefined;
    const taskFile = path.join(runsDir, submitted.id, 'task.json');
    const legacy = JSON.parse(await readFile(taskFile, 'utf8'));
    delete legacy.engine; delete legacy.engineVersion;
    await writeFile(taskFile, JSON.stringify(legacy, null, 2) + '\n');
    const models = makeAgentModels();
    reopened = await startAgentFixture(configFor(runsDir, 'ai-sdk'), models);
    const loaded = (await api(reopened, `/api/tasks/${submitted.id}`)).body.task;
    assert.equal(loaded.engine, 'fixed'); assert.equal(loaded.engineVersion, 'fixed-workflow-1');
    assert.equal((await api(reopened, `/api/tasks/${submitted.id}/resume`, {})).status, 409);
    assert.equal(models.agentModel.doGenerateCalls.length, 0);
    assert.equal(models.stageCalls.length, 0);
    assert.equal(await readFile(taskFile, 'utf8'), JSON.stringify(legacy, null, 2) + '\n');
  } finally { await closeFixture(first); await closeFixture(reopened); await rm(runsDir, { recursive: true, force: true }); }
});

test('Agent trace and public task records contain action evidence but no provider credential', async t => {
  const { runtime, models, runsDir } = await fixture(t, { reviewDecision: 'revise' });
  const completed = await taskAt(runtime, (await submit(runtime)).id);
  const info = await api(runtime, '/api/runtime');
  assert.equal(info.body.engine, 'ai-sdk'); assert.match(info.body.engineLabel, /Agent/i);
  assert.ok(completed.result.agentTrace.length >= 5);
  for (const item of completed.result.agentTrace) { assert.ok(['plan', 'review'].includes(item.phase)); assert.equal(typeof item.action, 'string'); assert.equal(typeof item.reason, 'string'); }
  const publicAndModel = JSON.stringify({ info: info.body, task: completed, providerPrompts: models.agentModel.doGenerateCalls });
  assert.equal(publicAndModel.includes(secretMarker), false);
  for (const name of ['task.json', 'request.json', 'artifacts.json', 'result.json']) {
    assert.equal((await readFile(path.join(runsDir, completed.id, name), 'utf8')).includes(secretMarker), false, `${name} contains a provider credential`);
  }
});

test('an anchored revision cannot expand to another identical quote or an Agent-selected chapter', async t => {
  const { runtime, models } = await fixture(t, { reviewDecision: 'revise' });
  const body = '门口有铜钱。屋内还有铜钱。';
  const start = body.lastIndexOf('铜钱');
  const submitted = await submit(runtime, { kind: 'revise', requestId: 'agent-anchored-revise',
    chapters: [{ id: 'ch-1', title: '门口', body }, { id: 'ch-2', title: '钟声', body: originalBodies[1] }],
    instruction: '只把选中的第二处铜钱改成银币。', quote: '铜钱', quoteSource: { chapterId: 'ch-1', start } });
  const stopped = await taskAt(runtime, submitted.id, ['completed', 'failed']);
  const attempted = models.decisions.find(decision => decision.action === 'revise_chapter');
  assert.ok(attempted, 'Mock must actually attempt an out-of-scope chapter edit');
  assert.equal(attempted.available.includes('revise_chapter'), false, 'Chapter rewrite must not be advertised for an anchored request');
  assert.equal(models.stageCalls.filter(call => call.stage.startsWith('agent:reviseChapter:')).length, 0);
  const requested = models.stageCalls.find(call => call.stage === 'requestedRevision');
  assert.deepEqual(requested.input.selection, { chapterId: 'ch-1', start, end: start + 2, text: '铜钱' });
  if (stopped.status === 'completed') {
    assert.deepEqual(stopped.result.chapters.map(chapter => chapter.body), ['门口有铜钱。屋内还有银币。', originalBodies[1]]);
    assert.equal(actionNames(stopped).includes('revise_chapter'), false);
  } else {
    assert.equal(stopped.result, undefined, 'Rejected scope expansion cannot produce a publishable result');
    assert.ok(stopped.error);
  }
});

// Test-local decisions keep all shared smoke fixtures unchanged. The real SDK
// executes these tool calls and feeds its actual rejection result to the next call.
function installRejectionDecisions(models, choose) {
  const original = models.agentModel.doGenerate.bind(models.agentModel);
  let reviewSteps = 0;
  models.agentModel.doGenerate = async options => {
    const user = options.prompt.find(message => message.role === 'user');
    const context = JSON.parse(user.content.filter(part => part.type === 'text').map(part => part.text).join(''));
    if (context.phase !== 'review') return original(options);
    const actions = await choose(++reviewSteps, options, context);
    return { content: actions.map((action, index) => ({ type: 'tool-call', toolCallId: `rejection-test-${reviewSteps}-${index}`, toolName: action.name, input: JSON.stringify(action.input) })),
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [] };
  };
}
const testDecision = (name, extra = {}) => ({ name, input: { reason: '固定回归决策；不代表文学判断。', ...extra } });

test('invalid issue index is rejected then corrected in the same SDK loop before one revision and reread', async t => {
  const { runtime, models, runsDir } = await fixture(t);
  let id, initialState, rejectedFeedbackSeen = false;
  const journal = async () => JSON.parse(await readFile(path.join(runsDir, id, 'artifacts.json'), 'utf8'))['agent:review:state:journal'];
  installRejectionDecisions(models, async (step, options, context) => {
    if (step === 1) { initialState = structuredClone(context.state); return [testDecision('read_chapter', { chapterId: 'ch-2' })]; }
    if (step === 2) return [testDecision('revise_chapter', { chapterId: 'ch-2', issueIndexes: [999] })];
    if (step === 3) {
      const feedback = options.prompt.filter(message => message.role === 'tool').flatMap(message => message.content)
        .find(part => part.type === 'tool-result' && part.toolCallId === 'rejection-test-2-0');
      assert.ok(feedback, 'SDK must feed back the rejected tool result');
      assert.equal(feedback.output.value.status, 'rejected');
      rejectedFeedbackSeen = true;
      const saved = await journal();
      assert.deepEqual(saved.state, initialState, 'Rejected selection must not mutate any business state');
      assert.equal(saved.pending, null);
      assert.equal(saved.toolCalls, 2); assert.equal(saved.modelSteps, 3);
      assert.equal(saved.rejections.length, 1); assert.deepEqual(saved.rejections[0].issueIndexes, [999]);
      assert.deepEqual(saved.trace.map(item => item.action), ['read_chapter']);
      assert.equal(models.stageCalls.filter(call => call.stage.startsWith('agent:reviseChapter:')).length, 0);
      return [testDecision('revise_chapter', { chapterId: 'ch-2', issueIndexes: [0] })];
    }
    if (step === 4) return [testDecision('review_manuscript')];
    assert.equal(step, 5, 'Correction must finish without an extra decision or resume');
    return [testDecision('finish_review')];
  });
  id = (await submit(runtime)).id;
  const completed = await taskAt(runtime, id);
  assert.ok(rejectedFeedbackSeen);
  assert.equal(completed.result.chapters[1].body, revisedBody);
  assert.equal(models.stageCalls.filter(call => call.stage === 'agent:reviseChapter:ch-2').length, 1);
  const rereads = models.stageCalls.filter(call => call.stage === 'agent:reviewManuscript');
  assert.equal(rereads.length, 1); assert.equal(rereads[0].input.chapters[1].body, revisedBody);
  const saved = await journal();
  assert.equal(saved.toolCalls, 5); assert.equal(saved.modelSteps, 5); assert.equal(saved.rejections.length, 1);
  assert.deepEqual(saved.trace.map(item => item.action), ['read_chapter', 'revise_chapter', 'review_manuscript', 'finish_review']);
  assert.equal(actionNames(completed).filter(action => action === 'revise_chapter').length, 1);
  assert.equal(completed.result.review.manuscriptSha256, completed.result.checks.manuscriptSha256);
});

test('persistent invalid tool selections consume the tool budget without revising or completing', async t => {
  const { runtime, models, runsDir } = await fixture(t);
  installRejectionDecisions(models, async () => Array.from({ length: 3 }, () => testDecision('revise_chapter', { chapterId: 'ch-2', issueIndexes: [999] })));
  const submitted = await submit(runtime);
  const failed = await taskAt(runtime, submitted.id, ['failed']);
  assert.equal(failed.result, undefined); assert.match(failed.error, /工具调用次数/);
  const artifacts = JSON.parse(await readFile(path.join(runsDir, submitted.id, 'artifacts.json'), 'utf8'));
  const saved = artifacts['agent:review:state:journal'];
  assert.equal(saved.toolCalls, 48); assert.equal(saved.modelSteps, 17); assert.equal(saved.rejections.length, 48);
  assert.deepEqual(saved.rejections.map(item => item.sequence), Array.from({ length: 48 }, (_, i) => i + 1));
  assert.deepEqual(saved.trace, []); assert.equal(saved.pending, null); assert.equal(saved.state.done, false);
  assert.deepEqual(saved.state.chapters.map(chapter => chapter.body), originalBodies);
  assert.equal(models.stageCalls.filter(call => call.stage.startsWith('agent:reviseChapter:') || call.stage === 'agent:reviewManuscript').length, 0);
});
