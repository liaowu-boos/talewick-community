import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundled = await build({ stdin: { contents: `export * from './src/model/independent-review.ts';
export {manuscriptRevision} from './src/model/runtime.ts';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false });
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const project = { id: 'focus-ui', title: '车票', chapters: [{ id: 'c1', title: '车票', body: '她把旧车票放回桌上。' }] };
function withCandidate(status = 'candidate_ready') {
  const value = structuredClone(project);
  value.runtime = { request: { baseRevision: ui.manuscriptRevision(value) }, baseManuscript: { title: value.title, chapters: value.chapters },
    task: { id: 'saved-whole-task', status: 'completed', revisionMode: 'whole-manuscript-v2', result: { wholeRevision: { schemaVersion: 'whole-manuscript-quality-1', status } } } };
  return value;
}

test('new UI single/compare posts explicit six-focus mode and only the exact saved source identity', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ task: { id: 'synthetic-review' } }) };
  });
  for (const [value, mode] of [[project, 'single'], [withCandidate(), 'compare'], [withCandidate('no_change'), 'compare']]) {
    const before = structuredClone(value); await ui.startIndependentReview(value, mode);
    const request = calls.at(-1); assert.equal(request.url, '/api/independent-reviews');
    assert.equal(request.body.readingFocusVersion, 'literary-reading-six-1');
    assert.equal(request.body.readingFocusDefinitions, undefined, 'server owns canonical definitions');
    assert.equal(request.body.candidate, undefined); assert.equal(request.body.goals, undefined);
    assert.equal(request.body.sourceTaskId, mode === 'compare' ? 'saved-whole-task' : undefined);
    assert.deepEqual(value, before);
  }
  const edited = withCandidate(); edited.chapters = [{ ...edited.chapters[0], body: '已编辑的另一版稿件。' }];
  await assert.rejects(ui.startIndependentReview(edited, 'compare'), /精确绑定/);
  const failed = withCandidate(); failed.runtime.task.status = 'failed';
  await assert.rejects(ui.startIndependentReview(failed, 'compare'), /精确绑定/);
  assert.equal(calls.length, 3);
});

test('old capability responses stay unavailable for new focus actions and do not relabel stored tasks', async t => {
  const task = { id: 'old', status: 'needs_attention', report: null, error: { code: 'IMPLEMENTED_WITHOUT_CHANGE_EVIDENCE', stage: '07-goal-audit' } };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ available: true, tasks: [task] }) }));
  const value = await ui.listIndependentReviews(project.id);
  assert.deepEqual(value.readingFocusVersions, []); assert.deepEqual(value.tasks, [task]);
  assert.deepEqual(ui.independentReviewRecoveryModes(task), []);
});
