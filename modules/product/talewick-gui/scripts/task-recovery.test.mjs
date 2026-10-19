import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../src/model/runtime.ts', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'talewick-task-recovery-'));
after(() => rm(temporary, { recursive: true, force: true }));
const transformed = stripTypeScriptTypes(await readFile(source, 'utf8'), { mode: 'transform' });
const runtimeFile = path.join(temporary, 'runtime.mjs');
await writeFile(runtimeFile, transformed);
const { readRuntimeTask, runtimeResumeMessage } = await import(pathToFileURL(runtimeFile));

const task = {
  id: '6169da65-3de3-439f-99ed-bf5a430f7c66', projectId: 'independent-review-new-story', requestId: 'whole-quality-r1',
  baseRevision: 'base', engine: 'ai-sdk', engineVersion: 'ai-sdk-7.0.93-talewick-2', kind: 'revise', revisionMode: 'whole-manuscript-v2',
  status: 'failed', stage: 'whole-quality:reading:repair-response', createdAt: '2026-10-16T03:50:00.000Z', updatedAt: '2026-10-16T03:58:34.300Z',
  failure: { kind: 'review_output', phase: 'review', retryScope: 'unfinished_review', recoverable: false, message: '原稿和诊断已保存；请从当前原稿重新发起整稿修订。' },
};

test('browser keeps the non-recoverable failure and suppresses resume with its exact guidance', () => {
  const loaded = readRuntimeTask(task);
  assert.equal(loaded.failure.recoverable, false);
  assert.equal(runtimeResumeMessage(loaded), task.failure.message);
});

test('historical failures without recoverability metadata remain compatible', () => {
  const loaded = readRuntimeTask({ ...task, id: '77777777-7777-4777-8777-777777777777', failure: { kind: 'unknown', phase: 'step', retryScope: 'unfinished_step', message: '旧记录' } });
  assert.equal(loaded.failure.recoverable, undefined);
  assert.equal(runtimeResumeMessage(loaded), '');
});

test('browser import preserves old and cross-chapter whole-quality reports verbatim', () => {
  const chapters = [{ id: 'c1', title: '第一章', body: '她把钥匙放回桌上。' }];
  const completed = { ...task, status: 'completed', stage: '创作完成', failure: undefined };
  const legacyQuality = { independentReading: { schemaVersion: 'whole-quality-reading-1' }, unresolved: [] };
  const legacy = readRuntimeTask({ ...completed, result: { title: '钥匙', chapters, warnings: [], wholeRevision: { schemaVersion: 'whole-manuscript-quality-1', status: 'no_change', quality: legacyQuality } } });
  assert.deepEqual(legacy.result.wholeRevision.quality, legacyQuality);
  const crossChapterReview = { schemaVersion: 'whole-quality-cross-chapter-bundle-1', sourceManuscriptSha256: 'a'.repeat(64), review: {
    schemaVersion: 'cross-chapter-review-result-1', findings: [{ groupId: 'g1', status: 'ambiguous', summary: '需澄清是否为同一轮事件', evidence: [] }] }, confirmedConflicts: [] };
  const crossChapterResolution = { schemaVersion: 'whole-quality-cross-chapter-outcome-1', confirmedCount: 0, resolvedInCandidateCount: 0, unresolvedCount: 0, items: [] };
  const current = readRuntimeTask({ ...completed, id: '88888888-8888-4888-8888-888888888888', result: { title: '钥匙', chapters, warnings: [], wholeRevision: {
    schemaVersion: 'whole-manuscript-quality-1', status: 'no_change', quality: { ...legacyQuality, crossChapterReview, crossChapterResolution } } } });
  assert.deepEqual(current.result.wholeRevision.quality.crossChapterReview, crossChapterReview);
  assert.deepEqual(current.result.wholeRevision.quality.crossChapterResolution, crossChapterResolution);
});
