import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as adapter from '../../../validation/runtime/independent-review-task.mjs';
import * as readingFocus from '../../../validation/runtime/focused-whole-quality-evaluation.mjs';
import { IndependentReviewService, independentReviewRequestHash } from './independent-review-service.mjs';
import { productManuscriptRevision } from './full15-service.mjs';

const chapters = [{ id: 'c1', title: '雨', body: '窗外下着雨。她关上门，把旧车票压在桌角。' }];
const input = extra => ({ projectId: 'focus-project', requestId: 'focus-once', caseId: 'focus-case', mode: 'single', title: '雨', chapters,
  manuscriptRevision: productManuscriptRevision('雨', chapters), ...extra });
async function settled(service, id) {
  for (let i = 0; i < 500; i++) { const task = service.get(id); if (!['queued', 'running'].includes(task.status) && !service.busy) return task; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Focused task did not settle');
}
async function fixture(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'talewick-reading-focus-')), calls = [];
  const trustedRequest = { caseId: 'focus-case', mode: 'single', baselineChapters: chapters };
  const analyze = async args => {
    calls.push(args); const packet = args.packet.protocolPacket, focused = Boolean(packet.readingFocusVersion);
    const evidence = [{ blindId: 'M', chapterId: 'c1', quote: '她关上门', start: null }];
    const entry = { blindId: 'M', readScope: 'whole', overallImpression: '保留负面感受与不确定性。',
      claims: focused ? [] : [{ id: 'legacy-claim', claimType: 'hard_fact', statement: '人物关上了门。', evidence }],
      ...(focused ? { focusAssessments: packet.readingFocusDefinitions.map(focus => ({ focusId: focus.id, claimType: 'editorial_hypothesis', statement: `${focus.title}尚未显示明显改善。`, evidence,
        counterEvidence: [], uncertainty: '本段未找到可靠反例，不能外推到其他故事。' })) } : {}) };
    return { outputText: JSON.stringify({ schemaVersion: focused ? 'whole-quality-independent-reading-2' : 'whole-quality-independent-reading-1', packetSha256: packet.packetSha256, readerId: packet.readerId, entries: [entry] }),
      receipt: { provider: 'synthetic', contextId: randomUUID(), invocationId: randomUUID(), inputHash: args.inputHash } };
  };
  const options = { rootDir, adapter, readingFocus, analyze, prepareRequest: () => ({ request: trustedRequest }) };
  let service = await new IndependentReviewService(options).init();
  t.after(async () => { await service.close(); await rm(rootDir, { recursive: true, force: true }); });
  return { service, rootDir, calls, options, trustedRequest, setService(value) { service = value; } };
}

test('explicit six-focus task freezes canonical definitions and hashes, records v3, and reloads unchanged', async t => {
  const f = await fixture(t), before = structuredClone(f.trustedRequest), definitions = readingFocus.getLiteraryReadingFocusDefinitions();
  assert.deepEqual(f.service.readingFocusVersions(), ['literary-reading-six-1']);
  const task = await f.service.start(input({ readingFocusVersion: 'literary-reading-six-1' }));
  const done = await settled(f.service, task.id); assert.equal(done.status, 'complete', JSON.stringify(done.error));
  assert.equal(done.readingFocusVersion, 'literary-reading-six-1'); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.trustedRequest, before, 'trusted handoff object itself is not mutated');
  for (const call of f.calls) {
    assert.deepEqual(call.packet.protocolPacket.readingFocusDefinitions, definitions);
    assert.equal(call.packet.protocolPacket.readingFocusVersion, 'literary-reading-six-1');
    assert.ok(!Object.hasOwn(call.packet.protocolPacket, 'goals'));
    assert.ok(!Object.hasOwn(call.packet.protocolPacket, 'privateBinding'));
  }
  const requestFile = path.join(f.rootDir, task.id, 'request.json'), bytes = await readFile(requestFile), saved = JSON.parse(bytes);
  assert.deepEqual(saved.submission.readingFocusDefinitions, definitions); assert.deepEqual(saved.request.readingFocusDefinitions, definitions);
  assert.equal(f.service.tasks.get(task.id).requestHash, independentReviewRequestHash(saved.request));
  assert.equal(f.service.tasks.get(task.id).protocolVersion, 'whole-quality-evaluation-3');
  const duplicate = await f.service.start(input({ readingFocusVersion: 'literary-reading-six-1', readingFocusDefinitions: definitions })); assert.equal(duplicate.id, task.id);
  await assert.rejects(f.service.start(input()), { code: 'REQUEST_CONFLICT' });
  assert.equal(f.calls.length, 2);
  await f.service.close(); const reopened = await new IndependentReviewService(f.options).init(); f.setService(reopened);
  assert.equal(reopened.get(task.id).readingFocusVersion, 'literary-reading-six-1'); assert.deepEqual(await readFile(requestFile), bytes); assert.equal(f.calls.length, 2);
});

test('unknown, reordered, changed and unversioned definitions reject before preparation or analysis', async t => {
  const f = await fixture(t), definitions = readingFocus.getLiteraryReadingFocusDefinitions();
  const changed = structuredClone(definitions); changed[0].description = '更喜欢候选稿';
  for (const [extra, code] of [
    [{ readingFocusVersion: 'unknown' }, 'READING_FOCUS_VERSION'],
    [{ readingFocusDefinitions: definitions }, 'READING_FOCUS_VERSION'],
    [{ readingFocusVersion: 'literary-reading-six-1', readingFocusDefinitions: [...definitions].reverse() }, 'READING_FOCUS_DEFINITIONS'],
    [{ readingFocusVersion: 'literary-reading-six-1', readingFocusDefinitions: changed }, 'READING_FOCUS_DEFINITIONS'],
  ]) await assert.rejects(f.service.start(input(extra)), { code });
  assert.equal(f.service.list().length, 0); assert.equal(f.calls.length, 0);
  f.service.readingFocus = null;
  await assert.rejects(f.service.start(input({ readingFocusVersion: 'literary-reading-six-1' })), { code: 'READING_FOCUS_UNAVAILABLE' });
});

test('omitted focus preserves the exact legacy request and v2 report without adding definitions', async t => {
  const f = await fixture(t), task = await f.service.start(input()), done = await settled(f.service, task.id);
  assert.equal(done.status, 'complete', JSON.stringify(done.error)); assert.equal(done.readingFocusVersion, undefined);
  const saved = JSON.parse(await readFile(path.join(f.rootDir, task.id, 'request.json')));
  assert.deepEqual(saved.request, f.trustedRequest); assert.equal(saved.submission.readingFocusDefinitions, undefined);
  assert.equal(f.service.tasks.get(task.id).requestHash, independentReviewRequestHash(f.trustedRequest));
  assert.equal(f.service.tasks.get(task.id).protocolVersion, 'whole-quality-evaluation-2');
  assert.equal(done.report.schemaVersion, 'independent-review-single-result-1');
  assert.ok(f.calls.every(call => !Object.hasOwn(call.packet.protocolPacket, 'readingFocusVersion')));
});
