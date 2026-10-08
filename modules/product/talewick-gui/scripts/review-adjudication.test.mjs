import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectReviewAdjudication } from '../server/service-public.mjs';
import { adjudicationFixture } from './review-adjudication-fixtures.mjs';
const root = fileURLToPath(new URL('../src/model/', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'talewick-adjudication-state-'));
after(() => rm(temporary, { recursive: true, force: true }));
for (const name of ['seed', 'runtime', 'revision-anchor', 'store', 'conversation', 'project-link', 'review-adjudication']) {
  const source = stripTypeScriptTypes(await readFile(path.join(root, name + '.ts'), 'utf8'), { mode: 'transform' }).replace(/(from\s+['"])(\.\/[^'"]+)(['"])/g, '$1$2.mjs$3');
  await writeFile(path.join(temporary, name + '.mjs'), source);
}
const load = name => import(pathToFileURL(path.join(temporary, name + '.mjs')));
const { readRuntimeTask, manuscriptRevision, makeRuntimeRequest, runtimeStage, runtimeResumeMessage } = await load('runtime');
const { adjudicationView, quoteMatchesResult, verifyAdjudicationDisplay } = await load('review-adjudication');
const { parseState, beginRuntimeTask, applyRuntimeTask, restoreVersion, snapshotProject } = await load('store');
const { createProject, createInitialState } = await load('seed');
const taskWith = result => ({ id: 'task', projectId: 'project', requestId: 'request', baseRevision: 'base', engine: 'fixed', engineVersion: 'fixed-workflow-2', kind: 'create', status: 'completed', createdAt: '2026-09-21T00:00:00Z', updatedAt: '2026-09-21T00:01:00Z', result });

test('real normalized contract binds both hashes and retains original review and all disputes through storage', () => {
  const result = adjudicationFixture(), before = structuredClone(result);
  assert.equal(result.reviewAdjudicationBinding.status, 'bound');
  const task = readRuntimeTask(taskWith(result));
  assert.deepEqual(task.result.reviewAdjudication, result.reviewAdjudication);
  assert.deepEqual(task.result.review.issues, result.review.issues);
  const project = createProject('test', 'auto'), state = createInitialState();
  task.projectId = project.id; project.runtimeHistory = [task]; state.projects = [project];
  const saved = parseState(JSON.parse(JSON.stringify(state))).projects[0].runtimeHistory[0];
  assert.deepEqual(saved.result.reviewAdjudication, result.reviewAdjudication);
  assert.deepEqual(readRuntimeTask(JSON.parse(JSON.stringify(saved))), saved);
  const view = adjudicationView(saved.result, result.chapters);
  assert.equal(view.status, 'bound'); assert.equal(view.currentVersion, 'same');
  assert.deepEqual(view.counts, { confirm: 1, reject: 1, uncertain: 1 }); assert.equal(view.pendingCount, 0);
  assert.deepEqual(result, before, 'projection and display never mutate the original');
});

test('missing, malformed, unsupported, incomplete and no-required-decision states stay distinct', () => {
  const result = adjudicationFixture();
  delete result.reviewAdjudication; delete result.reviewAdjudicationBinding;
  assert.equal(adjudicationView(result).status, 'missing'); assert.equal(adjudicationView(result).pendingCount, 3);
  result.reviewAdjudication = null; assert.equal(adjudicationView(result).status, 'invalid');
  result.reviewAdjudication = { schemaVersion: 'future' }; assert.equal(adjudicationView(result).status, 'unsupported');
  const incomplete = adjudicationFixture(); incomplete.reviewAdjudication.decisions.pop();
  assert.equal(projectReviewAdjudication(incomplete).status, 'invalid');
  const none = adjudicationFixture({ noIssues: true });
  assert.equal(adjudicationView(none).notRequired, true); assert.equal(adjudicationView(none).pendingCount, 0);
  assert.equal(none.reviewAdjudication.origin, 'program_no_must_fix');
});

test('changed chapter, reordered chapter, changed review, damaged sourceReview and copied issue identity are not bound', () => {
  for (const mutate of [r => { r.chapters[0].body += '用户新写的句子。'; }, r => r.chapters.reverse(), r => { r.review.summary += '新版审稿'; }]) {
    const result = adjudicationFixture(); mutate(result); assert.equal(projectReviewAdjudication(result).status, 'stale');
  }
  const source = adjudicationFixture(); source.reviewAdjudication.sourceReview.summary += '篡改'; assert.equal(projectReviewAdjudication(source).status, 'invalid');
  const duplicate = adjudicationFixture(); duplicate.reviewAdjudication.decisions[1] = duplicate.reviewAdjudication.decisions[0]; assert.equal(projectReviewAdjudication(duplicate).status, 'invalid');
});

test('quotes require the actual chapter and UTF-16 position, not the upstream approval flag', () => {
  const result = adjudicationFixture(), quote = structuredClone(result.reviewAdjudication.decisions[0].supportingEvidence[0]);
  assert.equal(quoteMatchesResult(quote, result), true);
  quote.start += 1; assert.equal(quoteMatchesResult(quote, result), false);
  result.reviewAdjudication.decisions[0].supportingEvidence[0] = quote;
  assert.equal(projectReviewAdjudication(result).status, 'invalid');
});

test('a late adjudication cannot replace local edits, reapply a completed task, or consume pending suggestions', () => {
  const result = adjudicationFixture(), state = createInitialState(), project = createProject('test', 'auto');
  const request = makeRuntimeRequest(project, state, 'request', '', ''); beginRuntimeTask(project, request);
  const task = { ...taskWith(result), projectId: project.id, baseRevision: request.baseRevision };
  assert.equal(applyRuntimeTask(project, task), true); assert.equal(project.runtime.resultDisposition, 'applied');
  project.chapters[0].body += '用户修改必须保留。'; snapshotProject(project, '用户改稿');
  project.pendingEdits = [{ id: 'edit', chapterId: 'ch-1', before: project.chapters[0].body, after: '建议文本', reason: '测试', status: 'pending' }];
  const protectedState = structuredClone({ chapters: project.chapters, versions: project.versions, pendingEdits: project.pendingEdits });
  const late = { ...structuredClone(task), updatedAt: '2026-09-21T00:02:00Z' };
  assert.equal(applyRuntimeTask(project, late), true);
  assert.deepEqual({ chapters: project.chapters, versions: project.versions, pendingEdits: project.pendingEdits }, protectedState);
  assert.equal(adjudicationView(late.result, project.chapters).currentVersion, 'changed');
  assert.equal(applyRuntimeTask(project, task), false, 'older task update stays rejected');
});

test('editing during a task holds the result; restoring a version preserves the newer draft', () => {
  const state = createInitialState(), project = createProject('test', 'auto'), result = adjudicationFixture();
  project.chapters = structuredClone(result.chapters); snapshotProject(project, '起始稿');
  const originalVersion = project.versions[0].id;
  const request = makeRuntimeRequest(project, state, 'revise', '测试修订', ''); beginRuntimeTask(project, request);
  project.chapters[0].body += '运行中改稿。'; const userDraft = structuredClone(project.chapters);
  const task = { ...taskWith(result), kind: 'revise', projectId: project.id, requestId: request.requestId, baseRevision: request.baseRevision };
  applyRuntimeTask(project, task); assert.equal(project.runtime.resultDisposition, 'held'); assert.deepEqual(project.chapters, userDraft);
  restoreVersion(project, originalVersion); assert.ok(project.versions.some(version => JSON.stringify(version.chapters) === JSON.stringify(userDraft)));
  assert.deepEqual(project.runtime.task.result.reviewAdjudication, result.reviewAdjudication);
  assert.notEqual(manuscriptRevision(project), '');
});

test('new adjudication checkpoints have readable progress and historical engines stay readable without resume', () => {
  for (const stage of ['review-adjudication', 'reviewAdjudication:input-hash', 'reviewAdjudication']) assert.equal(runtimeStage({ ...taskWith(), status: 'running', stage }), '核对审稿证据与争议');
  for (const [engine, engineVersion] of [['fixed', 'fixed-workflow-1'], ['ai-sdk', 'ai-sdk-7.0.93-talewick-1']]) {
    const task = readRuntimeTask({ ...taskWith(adjudicationFixture()), status: 'interrupted', engine, engineVersion });
    assert.equal(task.engineVersion, engineVersion); assert.match(runtimeResumeMessage(task), /当前版本不能恢复/);
  }
  assert.equal(runtimeResumeMessage({ ...taskWith(), status: 'interrupted' }), '');
});


test('browser fingerprints reject copied binding metadata after record, review or manuscript changes', async () => {
  const result = readRuntimeTask(taskWith(adjudicationFixture())).result;
  assert.equal(await verifyAdjudicationDisplay(result), 'bound');
  assert.deepEqual(result.reviewOriginal, adjudicationFixture().review);
  for (const [mutate, status] of [
    [r => { r.reviewAdjudication.decisions[0].reason += '被改动'; }, 'invalid'],
    [r => { r.reviewAdjudication.decisions[0].revisionEligible = false; }, 'invalid'],
    [r => { r.reviewOriginal.summary += '被改动'; }, 'stale'],
    [r => { r.chapters[0].body += '被改动'; }, 'stale'],
    [r => { delete r.reviewAdjudicationBinding.adjudicationSha256; }, 'unverified'],
  ]) {
    const changed = structuredClone(result); mutate(changed); assert.equal(await verifyAdjudicationDisplay(changed), status);
  }
});

test('public binding uses full validation and refuses forged revisionEligible or unsupported old schema', () => {
  const result = adjudicationFixture(); result.reviewAdjudication.decisions[1].revisionEligible = true;
  assert.equal(projectReviewAdjudication(result).status, 'invalid');
  const old = adjudicationFixture(); old.reviewAdjudication.schemaVersion = 'review-adjudication-1';
  assert.equal(projectReviewAdjudication(old).status, 'unsupported');
});
