import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskService, projectPartialDraft } from './tasks.mjs';
import { ADJUDICATION_VERSION, createAdjudicationInput, adjudicateReview } from '../../../validation/runtime/review-adjudication.mjs';
import { manuscriptFingerprint } from '../../../validation/runtime/checks.mjs';
const request = { projectId: 'offline', requestId: 'only-one', kind: 'create', idea: '保留有意义的反复', baseRevision: '' };
const chapters = [{ id: 'ch-1', title: '门口', body: '她又握住门把。这一次她没有推门。' }];
async function execute(t, workflow) {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'product-result-gate-'));
  let calls = 0;
  const service = await new TaskService({ runsDir, workflow, model: { complete() { calls++; throw Error('Forbidden'); } } }).init();
  t.after(async () => { await service.close(); await rm(runsDir, { recursive: true, force: true }); assert.equal(calls, 0); });
  const task = await service.create(request);
  const settle = async () => {
    for (let i=0; i<200; i++) { if (!['queued','running'].includes(service.get(task.id).status) && !service.busy) return service.get(task.id); await new Promise(r=>setTimeout(r,5)); }
    throw Error('Task did not settle');
  };
  return { service, runsDir, task: await settle(), settle };
}
test('new workflow missing adjudication fails, preserves exact output and checkpoint, resume does not fabricate review', async t => {
  const output = { title: '测试', chapters, review: { manuscriptSha256: manuscriptFingerprint(chapters), issues: [], summary: '仅观察' } };
  let invocations = 0;
  const run = await execute(t, async ({checkpoint, artifacts}) => {
    invocations++;
    if (!artifacts.requestSpec) await checkpoint('requestSpec', { reviewPolicyVersion: ADJUDICATION_VERSION });
    await checkpoint('result', output); return structuredClone(output);
  });
  assert.equal(run.task.status, 'failed'); assert.equal(run.task.result, undefined);
  assert.deepEqual(JSON.parse(await readFile(path.join(run.runsDir, run.task.id, 'unverified-result.json'))), output);
  assert.deepEqual(JSON.parse(await readFile(path.join(run.runsDir, run.task.id, 'artifacts.json'))).result, output);
  await run.service.resume(run.task.id); assert.equal((await run.settle()).status,'failed'); assert.equal(invocations,2);
});
test('valid bound no-must-fix result completes without requiring a change', async t => {
  const review = { manuscriptSha256: manuscriptFingerprint(chapters), issues: [], summary: '反复有其作用' };
  const reviewAdjudication = await adjudicateReview({ input: createAdjudicationInput({chapters,review}) });
  const run = await execute(t, async ({checkpoint}) => {
    await checkpoint('requestSpec', { reviewPolicyVersion: ADJUDICATION_VERSION });
    return { chapters, review, reviewAdjudication, revisionApplied: false };
  });
  assert.equal(run.task.status,'completed'); assert.equal(run.task.result.revisionApplied,false);
  assert.equal(run.task.stage,'创作完成');
  assert.equal(run.task.result.reviewAdjudicationBinding.status,'bound');
});
test('explicit incomplete quality check keeps the manuscript usable and reports the partial completion stage', async t => {
  const continuityChainFailure = {
    status: 'failed',
    code: 'CONTINUITY_FORMAT_CASE_FIELDS',
    message: '事件链检查返回了不符合契约的字段。'
  };
  const review = { manuscriptSha256: manuscriptFingerprint(chapters), issues: [], summary: '一般问题已独立审阅', continuityChainFailure };
  const reviewAdjudication = await adjudicateReview({ input: createAdjudicationInput({chapters,review}) });
  const warning = '稿件已生成；事件链检查未完成，本次没有据此宣称全部检查通过。';
  const result = { title: '测试', chapters, review, reviewAdjudication, qualityCheckStatus: 'incomplete', warnings: [warning] };
  const run = await execute(t, async ({checkpoint}) => {
    await checkpoint('requestSpec', { reviewPolicyVersion: ADJUDICATION_VERSION });
    return structuredClone(result);
  });
  assert.equal(run.task.status,'completed');
  assert.equal(run.task.stage,'稿件已生成，部分检查未完成');
  assert.equal(run.task.result.qualityCheckStatus,'incomplete');
  assert.deepEqual(run.task.result.review.continuityChainFailure,continuityChainFailure);
  assert.deepEqual(run.task.result.warnings,[warning]);
  const savedResult = JSON.parse(await readFile(path.join(run.runsDir, run.task.id, 'result.json')));
  assert.equal(savedResult.qualityCheckStatus,'incomplete');
  assert.deepEqual(savedResult.review.continuityChainFailure,continuityChainFailure);
  assert.deepEqual(savedResult.warnings,[warning]);
  assert.ok((await readFile(path.join(run.runsDir, run.task.id, 'manuscript.txt'),'utf8')).includes(chapters[0].body));
});
test('legacy unversioned workflow retains existing completion behavior', async t => {
  const run = await execute(t, async()=>({ chapters }));
  assert.equal(run.task.status,'completed'); assert.equal(run.task.stage,'创作完成'); assert.equal(run.task.result.reviewAdjudicationBinding.status,'missing');
});
test('workflow and network failures remain failed and are not converted into partial completion', async t => {
  const run = await execute(t, async()=>{ const error = new Error('网络失败'); error.code = 'ECONNRESET'; throw error; });
  assert.equal(run.task.status,'failed');
  assert.equal(run.task.result,undefined);
  assert.equal(run.task.failure.kind,'network');
  assert.match(run.task.error,/未完成/);
  await assert.rejects(readFile(path.join(run.runsDir, run.task.id, 'result.json')),{ code:'ENOENT' });
});

test('failed result projection preserves returned revised text rather than an older initial draft', () => {
  const task = { status: 'failed', kind: 'create', engine: 'fixed' };
  const artifacts = { plan: {chapters}, 'draft:ch-1': chapters[0], result: { chapters: [{ ...chapters[0], body: '她终于松开门把，却没有离开。' }] } };
  const before = structuredClone(artifacts);
  const view = projectPartialDraft(task, artifacts);
  assert.equal(view.status, 'unreviewed_partial'); assert.equal(view.chapters[0].body, artifacts.result.chapters[0].body);
  assert.deepEqual(artifacts, before);
  assert.equal(projectPartialDraft({...task,status:'completed'},artifacts),undefined);
});
test('malformed saved final candidate cannot silently fall back to initial draft', () => {
  const task = { status: 'failed', kind: 'create', engine: 'fixed' };
  for (const result of [null, {chapters: []}, {chapters:[{...chapters[0],id:'other'}]}, {chapters:[{...chapters[0],body:''}]}]) {
    assert.equal(projectPartialDraft(task,{ plan:{chapters}, 'draft:ch-1':chapters[0], result }),undefined);
  }
});
