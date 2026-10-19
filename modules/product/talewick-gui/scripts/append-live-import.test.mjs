import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyAppendPlan, buildAppendPlan } from './append-live-import.mjs';

const projectId = 'independent-review-new-story';
const ids = {
  oldTask: '11111111-1111-4111-8111-111111111111', newTask: '22222222-2222-4222-8222-222222222222',
  oldFullA: '33333333-3333-4333-8333-333333333333', oldFullB: '44444444-4444-4444-8444-444444444444', newFull: '55555555-5555-4555-8555-555555555555',
  oldReviewA: '66666666-6666-4666-8666-666666666666', oldReviewB: '77777777-7777-4777-8777-777777777777', oldReviewC: '88888888-8888-4888-8888-888888888888', newReview: '99999999-9999-4999-8999-999999999999',
};

const writeJson = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); };
const readLocal = async file => { const info = await stat(file); assert.equal(info.isFile(), true); return readFile(file); };
const readJson = async file => JSON.parse((await readLocal(file)).toString('utf8'));

async function task(root, id, body = {}) {
  const folder = path.join(root, id), record = { id, projectId, requestId: `request-${id}`, kind: 'revise', revisionMode: 'whole-manuscript-v2', status: 'completed', ...body };
  await writeJson(path.join(folder, 'task.json'), record);
  await writeJson(path.join(folder, 'request.json'), { projectId, requestId: record.requestId, kind: 'revise', revisionMode: 'whole-manuscript-v2', chapters: [{ id: 'c1', title: '第一章', body: '原稿。' }] });
  await writeJson(path.join(folder, 'artifacts.json'), {});
  await writeJson(path.join(folder, 'result.json'), { title: '原稿', chapters: [{ id: 'c1', title: '第一章', body: body.candidate ?? '原稿。' }], wholeRevision: { schemaVersion: 'whole-manuscript-quality-1', status: body.candidate ? 'candidate_ready' : 'no_change' } });
}

async function full15(root, id, label) {
  const runDir = path.join(root, 'full15-product', 'runs', `full15-${label}`, 'run');
  await writeJson(path.join(runDir, 'sealed.json'), { label, exact: true });
  await writeJson(path.join(root, 'full15-product', `${id}.json`), { id, projectId, status: 'complete', runDir, report: { label } });
}

async function review(root, id, label) {
  const runDir = path.join(root, 'independent-reviews', 'runs', `review-${label}`, 'run');
  await writeJson(path.join(runDir, 'report.json'), { label, literaryPass: 'NOT_COMPUTED' });
  const folder = path.join(root, 'independent-reviews', id);
  await writeJson(path.join(folder, 'request.json'), { request: { caseId: label }, submission: { projectId, mode: 'compare' } });
  await writeJson(path.join(folder, 'task.json'), { id, projectId, requestId: `review-${label}`, mode: 'compare', status: 'complete', runDir, report: { label } });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'talewick-append-import-')), target = path.join(root, 'target'), source = path.join(root, 'source');
  await Promise.all([mkdir(target, { recursive: true }), mkdir(source, { recursive: true })]);
  t.after(() => rm(root, { recursive: true, force: true }));
  await task(target, ids.oldTask);
  await Promise.all([full15(target, ids.oldFullA, 'old-a'), full15(target, ids.oldFullB, 'old-b')]);
  await Promise.all([review(target, ids.oldReviewA, 'old-a'), review(target, ids.oldReviewB, 'old-b'), review(target, ids.oldReviewC, 'old-c')]);
  const oldTurns = [1, 2, 3].map(index => ({ id: `old-turn-${index}`, projectId, userText: `旧问题${index}`, assistantText: `旧回答${index}`, status: 'completed', task: { task: { id: ids.oldTask } } }));
  await writeJson(path.join(target, '.conversations', `${projectId}.json`), { version: 1, projectId, history: [{ role: 'user', text: '旧上下文' }], turns: oldTurns });
  await task(source, ids.newTask, { candidate: '同一原稿的新跨章候选。' });
  await full15(source, ids.newFull, 'new'); await review(source, ids.newReview, 'new');
  const seededOldTurns = oldTurns.map(turn => ({ status: turn.status, task: structuredClone(turn.task), assistantText: turn.assistantText, userText: turn.userText, projectId: turn.projectId, id: turn.id }));
  await writeJson(path.join(source, '.conversations', `${projectId}.json`), { version: 1, projectId, history: [], turns: [...seededOldTurns, { id: 'new-turn-1', projectId, userText: '核查同一原稿', assistantText: '已提交新整稿任务', status: 'completed', task: { task: { id: ids.newTask } } }] });
  return { root, target, source, oldTurns };
}

test('dry-run reports the exact old snapshot and append-only merged counts', async t => {
  const f = await fixture(t), plan = await buildAppendPlan({ sourceRoot: f.source, targetRoot: f.target, projectId });
  const report = plan.toJSON();
  assert.match(report.expectedTargetSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.targetCountsBefore, { tasks: 1, turns: 3, independentReviews: 3, full15: 2 });
  assert.deepEqual(report.sourceCounts, { tasks: 1, turns: 4, independentReviews: 1, full15: 1 });
  assert.deepEqual(report.mergedCounts, { tasks: 2, turns: 4, independentReviews: 4, full15: 3 });
  assert.equal(report.backupRequired, true);
});

test('apply requires the dry-run old hash, creates a backup, and preserves old records while appending new ones', async t => {
  const f = await fixture(t), plan = await buildAppendPlan({ sourceRoot: f.source, targetRoot: f.target, projectId });
  await assert.rejects(applyAppendPlan(plan, { expectedTargetSha256: '0'.repeat(64) }), error => error.code === 'TARGET_CHANGED');
  const applied = await applyAppendPlan(plan, { expectedTargetSha256: plan.targetSnapshot.sha256 });
  const conversation = await readJson(path.join(f.target, '.conversations', `${projectId}.json`));
  assert.deepEqual(conversation.turns.map(item => item.id), ['old-turn-1', 'old-turn-2', 'old-turn-3', 'new-turn-1']);
  assert.deepEqual(conversation.turns.slice(0, 3), f.oldTurns, 'the target keeps all three old turns byte-for-structure unchanged');
  assert.deepEqual(conversation.history, [{ role: 'user', text: '旧上下文' }]);
  assert.equal((await readJson(path.join(f.target, ids.oldTask, 'result.json'))).chapters[0].body, '原稿。');
  assert.equal((await readJson(path.join(f.target, ids.newTask, 'result.json'))).chapters[0].body, '同一原稿的新跨章候选。');
  assert.equal((await readJson(path.join(f.target, 'full15-product', `${ids.newFull}.json`))).runDir.startsWith(plan.targetRoot), true);
  assert.equal((await readJson(path.join(f.target, 'independent-reviews', ids.newReview, 'task.json'))).runDir.startsWith(plan.targetRoot), true);
  const baseline = await readJson(path.join(f.target, applied.backup, 'BASELINE.json'));
  assert.equal(baseline.targetSha256, plan.targetSnapshot.sha256);
  assert.deepEqual(baseline.counts, { tasks: 1, turns: 3, independentReviews: 3, full15: 2 });
  assert.equal((await readJson(path.join(f.target, applied.backup, ids.oldTask, 'task.json'))).id, ids.oldTask);
});

test('record collisions and divergent conversation history fail before any write', async t => {
  const f = await fixture(t);
  await task(f.source, ids.oldTask);
  await assert.rejects(buildAppendPlan({ sourceRoot: f.source, targetRoot: f.target, projectId }), error => error.code === 'RECORD_ID_COLLISION');
  await rm(path.join(f.source, ids.oldTask), { recursive: true, force: true });
  const repeatedCreateId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await task(f.source, repeatedCreateId, { kind: 'create', revisionMode: undefined });
  await assert.rejects(buildAppendPlan({ sourceRoot: f.source, targetRoot: f.target, projectId }), error => error.code === 'SOURCE_CREATE_FORBIDDEN');
  await rm(path.join(f.source, repeatedCreateId), { recursive: true, force: true });
  const conversationFile = path.join(f.source, '.conversations', `${projectId}.json`), conversation = await readJson(conversationFile);
  conversation.history = [{ role: 'user', text: '不相干历史' }]; await writeJson(conversationFile, conversation);
  await assert.rejects(buildAppendPlan({ sourceRoot: f.source, targetRoot: f.target, projectId }), error => error.code === 'CONVERSATION_HISTORY_DIVERGED');
});

test('a seeded old turn with the same id but different content is rejected before any write', async t => {
  const f = await fixture(t), conversationFile = path.join(f.source, '.conversations', `${projectId}.json`);
  const conversation = await readJson(conversationFile);
  conversation.turns[1].assistantText = '被篡改的旧回答';
  await writeJson(conversationFile, conversation);
  await assert.rejects(buildAppendPlan({ sourceRoot: f.source, targetRoot: f.target, projectId }), error => error.code === 'CONVERSATION_TURN_COLLISION');
  const target = await readJson(path.join(f.target, '.conversations', `${projectId}.json`));
  assert.deepEqual(target.turns, f.oldTurns);
});
