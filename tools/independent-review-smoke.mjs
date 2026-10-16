/** Real local runtime and model HTTP client against the synthetic Postman simulation. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../modules/product/talewick-gui/server/index.mjs';
import { productManuscriptRevision } from '../modules/product/talewick-gui/server/full15-service.mjs';
import { startIndependentReview } from '../modules/validation/runtime/independent-review-task.mjs';
import { createModel } from '../modules/product/talewick-gui/server/model.mjs';
import { createIndependentReviewAnalyze } from '../modules/product/talewick-gui/server/independent-review-analyze.mjs';
const baseURL = process.env.TALEWICK_SIMULATION_URL || 'http://127.0.0.1:14931/deepseek';
assert.equal(new URL(baseURL).hostname, '127.0.0.1', 'Only a local simulation is permitted');
const runsDir = await mkdtemp(path.join(tmpdir(), 'talewick-public-review-'));
const config = { runsDir, libraryDir: path.join(runsDir, 'library'), baseURL, apiKey: 'local-synthetic-test-key', model: 'synthetic-review', engine: 'fixed', agentProvider: 'openai-compatible', port: 0, timeoutMs: 10000, idleTimeoutMs: 10000 };
const model = createModel(config);
const runtime = await createRuntime({ config, model });
try {
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const api = async (route, body) => { const response = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const state = await api('/api/runtime'); assert.equal(state.body.independentReviews.available, true);
  const chapters = [{ id: 'synthetic-1', title: '协议测试', body: '这段合成正文只用于协议测试。它不是小说质量样本。' }];
  const title = '合成测试';
  const input = { projectId: 'public-smoke', requestId: 'single', caseId: 'postman-synthetic-public-single', title, chapters, mode: 'single', manuscriptRevision: productManuscriptRevision(title, chapters) };
  const submitted = await api('/api/independent-reviews', input); assert.equal(submitted.status, 202);
  const duplicate = await api('/api/independent-reviews', input); assert.equal(duplicate.body.task.id, submitted.body.task.id);
  const conflict = await api('/api/independent-reviews', { ...input, title: 'changed' }); assert.equal(conflict.status, 409);
  let task;
  for (let i = 0; i < 400; i++) { task = (await api(`/api/independent-reviews/${submitted.body.task.id}`)).body.task; if (!['queued', 'running'].includes(task.status)) break; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.equal(task.status, 'complete', JSON.stringify(task.error)); assert.equal(task.progress.completedStages, 2);
  assert.deepEqual(task.report.completionEvidence.manuscript.chapters, chapters);
  assert.equal(task.report.literaryPass, 'NOT_COMPUTED');
  const comparison = await startIndependentReview({ runRoot: path.join(runsDir, 'comparison'), request: { caseId: 'postman-synthetic-public-compare', mode: 'compare', baselineChapters: chapters, candidate: { mode: 'no_change', chapters }, goals: [] }, analyze: createIndependentReviewAnalyze({ model }) });
  assert.equal(comparison.status, 'complete', JSON.stringify(comparison.error)); assert.equal(comparison.progress.completedStages, 7);
  assert.equal(comparison.report.automaticAdoption, false); assert.equal(comparison.report.qualityGain, 'NO_QUALITY_GAIN_ASSERTED');
  const full15 = await api('/api/full15'); assert.equal(full15.body.available, true);
  console.log(JSON.stringify({ status: 'PASS', singleStages: 2, comparisonStages: 7, idempotency: true, conflict: 409, full15Available: true, externalModelCalls: 0, scope: 'Synthetic protocol and local HTTP transport only; no literary quality claim' }));
} finally { await runtime.close(); await rm(runsDir, { recursive: true, force: true }); }
