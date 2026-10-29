import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createIndependentFocusFixture } from './independent-review-focus-fixture.mjs';
import { createIndependentReviewRouter, IndependentReviewService, independentReviewRequestHash } from './independent-review-service.mjs';
import { independentReviewView } from '../src/model/independent-review-view.ts';

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'talewick-focus-integration-'));
  const f = await createIndependentFocusFixture(rootDir);
  t.after(async () => { await f.service.close(); await rm(rootDir, { recursive: true, force: true }); });
  return { ...f, rootDir };
}
async function settled(service, id) {
  for (let i = 0; i < 500; i++) { const value = service.get(id); if (!['queued', 'running'].includes(value.status) && !service.busy) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Synthetic task did not settle');
}
async function fileHashes(root, result = {}) {
  for (const item of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) await fileHashes(file, result);
    else result[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return result;
}
function routerFor(service) {
  const router = createIndependentReviewRouter({ service, json: (res, status, value) => Object.assign(res, { status, value }), bodyJSON: async req => req.payload });
  return async (method, route, payload) => { const res = {}; await router({ method, payload }, res, new URL(route, 'http://127.0.0.1')); return res; };
}

test('API compare opts in to v3, retains unchanged text and all six anonymous reads without claiming improvement', async t => {
  const f = await fixture(t), invoke = routerFor(f.service);
  assert.deepEqual((await invoke('GET', '/api/independent-reviews')).value.readingFocusVersions, ['literary-reading-six-1']);
  const submitted = await invoke('POST', '/api/independent-reviews', f.input({ candidate: { forged: true }, goals: [{ forged: true }] }));
  assert.equal(submitted.status, 202); const done = await settled(f.service, submitted.value.task.id);
  assert.equal(done.status, 'complete', JSON.stringify(done.error)); assert.equal(done.progress.completedStages, 7);
  assert.equal(done.report.schemaVersion, 'whole-quality-evaluation-result-3'); assert.equal(done.report.automaticAdoption, false);
  assert.equal(done.report.literaryPass, 'NOT_COMPUTED'); assert.equal(f.calls.length, 7);
  const frozen = f.service.tasks.get(done.id).frozen;
  assert.deepEqual(frozen.request.candidate.chapters, frozen.request.baselineChapters);
  assert.equal(frozen.request.candidate.mode, 'no_change');
  assert.equal(f.preparations[0].candidate, undefined); assert.equal(f.preparations[0].goals, undefined);
  for (const call of f.calls.slice(0, 6)) {
    assert.equal(call.packet.protocolPacket.readingFocusVersion, 'literary-reading-six-1');
    assert.equal(call.packet.protocolPacket.goals, undefined); assert.equal(call.packet.protocolPacket.privateBinding, undefined);
    assert.ok(!JSON.stringify(call.packet).includes('synthetic-no-change'));
  }
  const view = independentReviewView(done.report, 'compare');
  assert.equal(view.sections.flatMap(section => section.findings).filter(item => item.uncertainty).length, 36, '24 isolated + 12 paired observations');
  assert.ok(view.evidence.some(cite => cite.evidenceKind === 'counter'));
  assert.ok(view.readerLines.some(line => /无明确偏好|各有得失/.test(line)));
  const same = await invoke('POST', '/api/independent-reviews', f.input()); assert.equal(same.value.task.id, done.id); assert.equal(f.calls.length, 7);
});

test('v3 semantic goal failure exposes checksummed six-stage partial through GET/list without mutating seals or rerolling', async t => {
  const f = await fixture(t), invoke = routerFor(f.service);
  const task = await f.service.start(f.input({ sourceTaskId: 'synthetic-goal-failure' }));
  const done = await settled(f.service, task.id); assert.equal(done.status, 'needs_attention');
  assert.equal(done.error.code, 'IMPLEMENTED_WITHOUT_CHANGE_EVIDENCE'); assert.equal(done.report, null);
  const before = await fileHashes(f.rootDir), read = (await invoke('GET', `/api/independent-reviews/${task.id}`)).value.task;
  const partial = read.partialReport; assert.ok(partial, JSON.stringify(read.partialReportUnavailable));
  const { reportSha256, ...body } = partial; assert.equal(independentReviewRequestHash(body), reportSha256);
  assert.equal(partial.completeBlindReview, true); assert.equal(partial.completedBlindStages, 6);
  assert.equal(partial.goalAuditStatus, 'needs_attention'); assert.equal(partial.automaticAdoption, false);
  const view = independentReviewView(partial, 'compare'); assert.equal(view.sections.flatMap(section => section.findings).filter(item => item.uncertainty).length, 36);
  const listed = (await invoke('GET', '/api/independent-reviews')).value.tasks;
  assert.deepEqual(listed[0].partialReport, partial);
  await assert.rejects(invoke('POST', `/api/independent-reviews/${task.id}/retry`, {}), { code: 'REVIEW_RERUN_FORBIDDEN' });
  assert.deepEqual(await fileHashes(f.rootDir), before); assert.equal(f.calls.length, 7);
  await f.service.close(); const reopened = await new IndependentReviewService(f.options).init();
  try { assert.deepEqual((await reopened.read(task.id)).partialReport, partial); assert.deepEqual(await fileHashes(f.rootDir), before); }
  finally { await reopened.close(); }
});

test('persisted focus submission cannot be altered independently of the frozen request hash', async t => {
  const f = await fixture(t), task = await f.service.start(f.input({ mode: 'single' }));
  await settled(f.service, task.id); await f.service.close();
  const file = path.join(f.rootDir, task.id, 'request.json'), saved = JSON.parse(await readFile(file));
  saved.submission.readingFocusDefinitions[0].description = 'tampered'; await writeFile(file, JSON.stringify(saved));
  const tampered = await readFile(file), reopened = await new IndependentReviewService(f.options).init();
  try { assert.deepEqual(reopened.list(), []); assert.deepEqual(await readFile(file), tampered); assert.equal(f.calls.length, 2); }
  finally { await reopened.close(); }
});
