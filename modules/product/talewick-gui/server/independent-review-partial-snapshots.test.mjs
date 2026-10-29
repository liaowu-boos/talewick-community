import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createIndependentRecoveryFixture } from './independent-review-recovery-fixture.mjs';
import { createIndependentFocusFixture } from './independent-review-focus-fixture.mjs';
import { buildIndependentReviewPartialSnapshots, independentReviewRequestHash as hash } from './independent-review-service.mjs';
import { independentReviewView, independentReviewSnapshotForEvidence } from '../src/model/independent-review-view.ts';

async function settled(service, id) {
  for (let i = 0; i < 500; i++) { const task = service.get(id); if (!['queued', 'running'].includes(task.status) && !service.busy) return task; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Synthetic partial did not settle');
}
async function files(root, values = {}) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await files(file, values); else values[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return values;
}
function opinions(partial) {
  return [...partial.isolatedReadings.flatMap(item => item.record.entries.flatMap(entry => [entry.overallImpression,
    ...entry.claims.map(claim => claim.statement), ...(entry.focusAssessments ?? []).map(item => item.statement)])),
  ...partial.blindPairReviews.flatMap(item => item.record.comparisons.map(item => item.statement))].sort();
}
async function fixture(t, focused = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'talewick-partial-snapshots-'));
  const f = focused ? await createIndependentFocusFixture(root) : await createIndependentRecoveryFixture(root, { family: true });
  const task = focused ? await f.service.start(f.input({ sourceTaskId: 'synthetic-goal-failure' })) : f.task;
  t.after(async () => { await f.service.close(); await rm(root, { recursive: true, force: true }); });
  await settled(f.service, task.id);
  return { ...f, root, task };
}

for (const focused of [false, true]) test(`${focused ? 'v3' : 'legacy'} real helper partial maps all four isolated opinions and every citation to exact frozen A/B text`, async t => {
  const f = await fixture(t, focused), before = await files(f.root), canonical = await f.service.adapter.buildIndependentReviewPartialReport({
    runDir: f.service.tasks.get(f.task.id).runDir, requestHash: f.service.tasks.get(f.task.id).requestHash });
  const returned = await f.service.read(f.task.id); assert.ok(returned.partialSnapshotProjection, JSON.stringify(returned.partialSnapshotUnavailable));
  assert.deepEqual(returned.partialReport, canonical); assert.equal(returned.status, 'needs_attention'); assert.equal(returned.report, null);
  const context = { taskId: returned.id, partialSnapshotProjection: returned.partialSnapshotProjection };
  const view = independentReviewView(returned.partialReport, 'compare', context), frozen = f.service.tasks.get(returned.id).frozen.request;
  assert.equal(view.snapshots.length, 2); assert.equal(view.sections.filter(item => item.stage === 'independent_reading').length, 2);
  assert.deepEqual(view.findings.slice().sort(), opinions(canonical)); assert.ok(view.evidence.length > 0);
  assert.equal(canonical.isolatedReadings.length, 4); assert.ok(canonical.isolatedReadings.every(item => item.record.entries[0].blindId === 'M'));
  for (const citation of view.evidence) {
    const snapshot = independentReviewSnapshotForEvidence(view.snapshots, citation); assert.ok(snapshot, JSON.stringify(citation));
    const role = canonical.privateBinding.bindings[citation.blindId]; assert.equal(snapshot.role, role === 'baseline' ? 'source' : 'candidate');
    assert.deepEqual(snapshot.chapters, role === 'baseline' ? frozen.baselineChapters : frozen.candidate.chapters);
    const chapter = snapshot.chapters.find(item => item.id === citation.chapterId);
    assert.equal(chapter.body.slice(citation.start, citation.start + citation.quote.length), citation.quote);
  }
  assert.deepEqual((await f.service.readList())[0].partialReport, canonical);
  assert.deepEqual(await files(f.root), before, 'GET/list never change source, report, raw, task or seals');
  assert.ok(view.limitations.every(line => !/^(Six blind|Reader judgments|No goal compliance)/.test(line)));
});

test('snapshot projection rejects role, manuscript, reader-role, quote-position and cross-task/report drift', async t => {
  const f = await fixture(t), returned = await f.service.read(f.task.id), task = f.service.tasks.get(f.task.id);
  const partial = returned.partialReport, before = JSON.stringify(partial);
  const resign = value => { const { reportSha256, ...body } = value; value.reportSha256 = hash(body); return value; };
  for (const alter of [
    value => { value.privateBinding.baselineManuscriptSha256 = 'a'.repeat(64); },
    value => { value.readerBindings[0].order[0].manuscriptSha256 = 'b'.repeat(64); },
    value => { value.privateBinding.bindings.A = value.privateBinding.bindings.B; },
    value => { value.independentReadings[0].record.entries[0].claims[0].evidence[0].start += 1; },
  ]) { const changed = structuredClone(partial); alter(changed); assert.throws(() => buildIndependentReviewPartialSnapshots({ task, partialReport: resign(changed) }), { code: 'PARTIAL_SNAPSHOT_BINDING_INVALID' }); }
  for (const change of [{ reviewTaskId: 'other-task' }, { partialReportSha256: 'f'.repeat(64) }, { requestHash: 'f'.repeat(64) }]) {
    const view = independentReviewView(partial, 'compare', { taskId: returned.id, partialSnapshotProjection: { ...returned.partialSnapshotProjection, ...change } });
    assert.deepEqual(view.snapshots, []); assert.deepEqual(view.findings.slice().sort(), opinions(partial));
  }
  const view = independentReviewView(partial, 'compare', { taskId: returned.id, partialSnapshotProjection: returned.partialSnapshotProjection });
  assert.equal(independentReviewSnapshotForEvidence(view.snapshots, { ...view.evidence[0], blindId: 'M' }), undefined);
  assert.equal(independentReviewSnapshotForEvidence(view.snapshots, { ...view.evidence[0], start: view.evidence[0].start + 1 }), undefined);
  assert.equal(JSON.stringify(partial), before);
});

test('snapshot opening preserves leading/trailing whitespace, paragraph breaks and UTF-16 emoji offsets', () => {
  const body = '  😀\r\n\r\n引文\n\n第二段。  \n', quote = '引文\n\n第二段。', start = body.indexOf(quote);
  const snapshot = { id: 'source:A', blindId: 'A', role: 'source', label: '冻结原稿', chapters: [{ id: 'c1', title: ' 原题 ', body }] };
  const location = { blindId: 'A', chapterId: 'c1', quote, start, label: '原意见' };
  assert.equal(independentReviewSnapshotForEvidence([snapshot], location), snapshot);
  assert.equal(snapshot.chapters[0].body, body); assert.equal(snapshot.chapters[0].title, ' 原题 ');
  assert.equal(independentReviewSnapshotForEvidence([snapshot], { ...location, start: start - 1 }), undefined);
  assert.equal(independentReviewSnapshotForEvidence([snapshot], { ...location, quote: quote.replaceAll('\n', '') }), undefined);
});
