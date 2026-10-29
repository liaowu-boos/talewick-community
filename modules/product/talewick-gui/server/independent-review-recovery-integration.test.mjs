import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createIndependentRecoveryFixture } from './independent-review-recovery-fixture.mjs';
import { independentReviewRequestHash as hash } from './independent-review-service.mjs';

async function settled(f) {
  for (let i = 0; i < 1000; i++) { const task = f.service.get(f.task.id); if (!['queued', 'running'].includes(task.status) && !f.service.busy) return task; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('not settled');
}
async function fixture(t, family) {
  const root = await mkdtemp(path.join(tmpdir(), 'talewick-real-recovery-adapter-'));
  const f = await createIndependentRecoveryFixture(root, { family });
  t.after(async () => { await f.service.close(); await rm(root, { recursive: true, force: true }); });
  await settled(f); return f;
}
async function snapshot(root) {
  const values = {};
  async function walk(folder) { for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name); if (entry.isDirectory()) await walk(file); else values[path.relative(root, file)] = (await readFile(file)).toString('base64');
  } }
  await walk(root); return values;
}

test('actual validation helper through product recovers only stage four, then executes stages five–seven once', async t => {
  const f = await fixture(t, false), failed = f.service.get(f.task.id), internal = f.service.tasks.get(f.task.id);
  assert.equal(failed.error.code, 'QUOTE_POSITION_NOT_UNIQUE'); assert.equal(failed.progress.completedStages, 3);
  const before = await snapshot(path.dirname(internal.runDir));
  await f.service.recover(f.task.id, { requestId: 'local-four', stageId: failed.error.stage, mode: 'whitespace_only' });
  const stillAmbiguous = await settled(f); assert.equal(stillAmbiguous.error.code, 'QUOTE_POSITION_NOT_UNIQUE');
  assert.equal(f.repairCalls.length, 0); assert.equal(f.calls.length, 4);
  const input = { requestId: 'recover-four', stageId: failed.error.stage, mode: 'position_repair' };
  const accepted = await f.service.recover(f.task.id, input); assert.equal(accepted.id, f.task.id);
  const done = await settled(f); assert.equal(done.status, 'complete', JSON.stringify(done.error));
  assert.equal(f.repairCalls.length, 1); assert.deepEqual(f.calls, ['independent_reading', 'independent_reading', 'independent_reading', 'independent_reading', 'blind_pair', 'blind_pair', 'goal_audit']);
  const after = await snapshot(path.dirname(internal.runDir));
  for (const [file, bytes] of Object.entries(before)) if (!file.endsWith('events.ndjson')) assert.equal(after[file], bytes, `preserved ${file}`);
  await f.service.recover(done.id, input); assert.equal(f.calls.length, 7); assert.equal(f.repairCalls.length, 1);
  assert.equal(done.report.automaticAdoption, false); assert.equal(done.report.literaryPass, 'NOT_COMPUTED');
});

test('actual six-seal partial report stays readable while semantic goal failure stays needs_attention with no reroll', async t => {
  const f = await fixture(t, true), failed = f.service.get(f.task.id), internal = f.service.tasks.get(f.task.id);
  assert.equal(failed.error.code, 'QUOTE_NOT_FOUND'); assert.equal(failed.progress.completedStages, 6);
  const beforeRead = await snapshot(f.service.rootDir), partialBefore = await f.service.read(f.task.id);
  assert.equal(partialBefore.partialReport.completeBlindReview, true); assert.equal(partialBefore.report, null);
  assert.deepEqual(await snapshot(f.service.rootDir), beforeRead, 'GET is read-only across product and validation records');
  await f.service.recover(f.task.id, { requestId: 'recover-seven', stageId: failed.error.stage, mode: 'whitespace_only' });
  const done = await settled(f); assert.equal(done.status, 'needs_attention'); assert.equal(done.error.code, 'IMPLEMENTED_WITHOUT_CHANGE_EVIDENCE');
  const visible = await f.service.read(f.task.id), { reportSha256, ...body } = visible.partialReport;
  assert.equal(reportSha256, hash(body)); assert.equal(visible.report, null); assert.equal(body.taskStatus, 'needs_attention');
  assert.equal(body.isolatedReadings.length, 4); assert.equal(body.blindPairReviews.length, 2); assert.equal(body.goalAuditStatus, 'needs_attention');
  assert.deepEqual(body.blindPairReviews.map(item => item.record.preference), ['mixed', 'no_clear_preference']);
  assert.equal(f.calls.length, 7); assert.equal(f.repairCalls.length, 0);
  assert.equal((await f.service.readList())[0].partialReport.reportSha256, reportSha256);
  await assert.rejects(f.service.retry(f.task.id), { code: 'REVIEW_RERUN_FORBIDDEN' });
  const sealFile = path.join(internal.runDir, 'stages/01-reader-1-first/sealed.json'), seal = JSON.parse(await readFile(sealFile));
  await writeFile(path.join(path.dirname(sealFile), 'attempts', seal.attemptId, 'raw-response.txt'), '{}');
  const refused = await f.service.read(f.task.id); assert.equal(refused.partialReport, undefined);
  assert.equal(refused.partialReportUnavailable.code, 'PERSISTED_STAGE_SEAL_INVALID'); assert.equal(f.calls.length, 7);
});
