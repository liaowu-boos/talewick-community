import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { classifyTaskFailure, taskFailureRecoverable } from './task-failure.mjs';
import { createRuntime } from './index.mjs';

const unavailable = () => Object.assign(new Error('INPUT_DATALESS /private/reference/status.json'), {
  code: 'WHOLE_QUALITY_REFERENCE_UNAVAILABLE', causeCode: 'INPUT_DATALESS', recoverable: true,
});

test('only the explicit host reference-unavailable code gets the data retry classification', () => {
  const failure = classifyTaskFailure(unavailable(), 'whole-quality:applicability');
  assert.equal(failure.kind, 'reference_unavailable'); assert.equal(failure.phase, 'step');
  assert.equal(failure.retryScope, 'unfinished_step'); assert.equal(failure.recoverable, true);
  assert.match(failure.message, /资料尚未就绪/); assert.match(failure.message, /重试资料/);
  assert.doesNotMatch(JSON.stringify(failure), /private|status\.json|INPUT_DATALESS|模型.*不合格/);
  const stopped = classifyTaskFailure(Object.assign(unavailable(), { recoverable: false }));
  assert.equal(taskFailureRecoverable({ failure: stopped }), false); assert.doesNotMatch(stopped.message, /请点击/);
  for (const error of [{ code: 'INPUT_DATALESS' }, { code: 'DEEP_REFERENCE_UNAVAILABLE' },
    { message: 'WHOLE_QUALITY_REFERENCE_UNAVAILABLE' }]) assert.notEqual(classifyTaskFailure(error).kind, 'reference_unavailable');
  assert.equal(classifyTaskFailure({ code: 'WHOLE_QUALITY_FORMAT_FAILED' }).recoverable, false);
});

test('existing progress view shows data readiness/retry while completed and old review records keep their behavior', async () => {
  const bundled = await build({ stdin: { contents: `export {CreationProgress} from './src/features/CreationProgress.tsx';
export {readRuntimeTask,runtimeResumeLabel,runtimeStage} from './src/model/runtime.ts';
export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx' }, bundle: true, platform: 'node', format: 'esm', write: false,
    banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(fileURLToPath(import.meta.url))});` } });
  const ui = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const raw = { id: 'fixture', projectId: 'reference-fixture', requestId: 'reference-fixture-r1', kind: 'revise', status: 'failed',
    engine: 'ai-sdk', engineVersion: 'ai-sdk-7.0.93-talewick-2', baseRevision: 'base', createdAt: '2026-10-26', updatedAt: '2026-10-26',
    stage: 'whole-quality:retrieval', failure: classifyTaskFailure(unavailable()) };
  raw.error = raw.failure.message;
  const before = JSON.stringify(raw), task = ui.readRuntimeTask(raw, raw.projectId);
  assert.equal(task.failure.kind, 'reference_unavailable'); assert.equal(ui.runtimeResumeLabel(task), '重试资料');
  const render = task => ui.renderToStaticMarkup(ui.createElement(ui.CreationProgress, {
    project: { pendingEdits: [], chapters: [], runtime: { task } }, onTaskAction: () => {}, onResult: () => {},
  }));
  assert.match(render(task), /资料未就绪/); assert.match(render(task), /重试资料/);
  const closed = { ...task, failure: classifyTaskFailure(Object.assign(unavailable(), { recoverable: false })) };
  closed.error = closed.failure.message;
  assert.doesNotMatch(render(closed), /重试资料/);
  const completed = { ...task, status: 'completed', failure: undefined, error: undefined };
  assert.doesNotMatch(render(completed), /重试资料|资料未就绪/);
  const legacy = { ...task, failure: { kind: 'review_output', phase: 'review', retryScope: 'unfinished_review', message: '原审阅未完成。' } };
  assert.equal(ui.runtimeResumeLabel(legacy), '继续未完成审阅'); assert.equal(JSON.stringify(raw), before);
});

test('localhost same-task resume retries the host data boundary after restart and retains saved reading/cross steps', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'talewick-reference-failure-')), runsDir = path.join(root, 'runs');
  let runtime, base, dataReady = false, retrievals = 0, readingWrites = 0, crossWrites = 0, deniedModelCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail('No external fetch allowed'); };
  const close = async () => {
    if (!runtime) return;
    await runtime.close(); if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve)); runtime = null;
  };
  t.after(async () => { await close(); globalThis.fetch = originalFetch; });
  // Synthetic CREATION boundary only: it emits the agreed code before any model.
  // The actual policy eligibility and source-readiness validator remain CREATION/DATA-owned.
  const workflow = async ({ artifacts, checkpoint, progress, model }) => {
    if (!artifacts['fixture:reading']) { readingWrites++; await checkpoint('fixture:reading', { sealed: 'same-reading' }); }
    if (!artifacts['fixture:cross']) { crossWrites++; await checkpoint('fixture:cross', { sealed: 'same-cross-check' }); }
    await progress('whole-quality:retrieval'); retrievals++;
    if (!dataReady) {
      await checkpoint('fixture:reference-failure', { code: 'WHOLE_QUALITY_REFERENCE_UNAVAILABLE', causeCode: 'INPUT_DATALESS' });
      throw unavailable();
    }
    await model.complete({ stage: 'whole-quality:applicability' });
  };
  const start = async () => {
    runtime = await createRuntime({ config: { runsDir, libraryDir: path.join(root, 'library'), port: 0, engine: 'fixed',
      apiKey: 'offline-denied', model: 'offline', baseURL: 'http://127.0.0.1:1' }, workflow,
      model: { complete: async () => { deniedModelCalls++; throw Error('OFFLINE_DOWNSTREAM_STOP'); } }, library: null,
      publicationFeedback: { close: async () => {} }, full15Adapter: null, independentReviewAdapter: null,
      independentReviewReadingFocus: null, independentReviewHandoff: null, reviewEvidenceAuditAdapter: null });
    await new Promise((resolve, reject) => { runtime.server.once('error', reject); runtime.server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${runtime.server.address().port}`;
  };
  const api = async (route, body) => { const res = await originalFetch(base + route, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined); return { status: res.status, body: await res.json() }; };
  const settled = async id => { for (let n = 0; n < 500; n++) {
    if (!runtime.tasks.busy && runtime.tasks.get(id).status === 'failed') return;
    await new Promise(resolve => setTimeout(resolve, 5));
  } assert.fail('Task did not settle'); };
  await start();
  const created = await api('/api/tasks', { projectId: 'reference-fixture', requestId: 'reference-fixture-r1',
    kind: 'revise', revisionMode: 'whole-manuscript-v2', idea: '离线资料恢复样例', instruction: '核对原稿',
    chapters: [{ id: 'ch-1', title: '原稿', body: '她把单据放回抽屉。' }], baseRevision: 'fixture-base' });
  assert.equal(created.status, 202); const id = created.body.task.id; await settled(id);
  const failed = (await api(`/api/tasks/${id}`)).body.task;
  assert.equal(failed.failure.kind, 'reference_unavailable'); assert.equal(failed.failure.recoverable, true);
  assert.equal(deniedModelCalls, 0); assert.equal(retrievals, 1);
  const taskPath = path.join(runsDir, id, 'task.json'), requestPath = path.join(runsDir, id, 'request.json');
  const before = await readFile(taskPath), requestBefore = await readFile(requestPath);
  const saved = JSON.parse(await readFile(path.join(runsDir, id, 'artifacts.json')));
  await close(); await start();
  assert.equal((await api(`/api/tasks/${id}`)).body.task.failure.kind, 'reference_unavailable');
  assert.deepEqual(await readFile(taskPath), before); assert.equal(retrievals, 1, 'restart/GET must not retry');
  dataReady = true;
  const resumed = await api(`/api/tasks/${id}/resume`, {}); assert.equal(resumed.status, 200); assert.equal(resumed.body.task.id, id);
  await settled(id);
  assert.equal(retrievals, 2); assert.equal(readingWrites, 1); assert.equal(crossWrites, 1); assert.equal(deniedModelCalls, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(runsDir, id, 'artifacts.json'))), saved);
  assert.deepEqual(await readFile(requestPath), requestBefore); assert.equal(runtime.tasks.get(id).status, 'failed');
  if (process.env.PRODUCT_REFERENCE_FAILURE_PROOF) await writeFile(process.env.PRODUCT_REFERENCE_FAILURE_PROOF, JSON.stringify({
    status: 'passed', scope: 'Real localhost product API with synthetic agreed host error; no real cloud-file replay', root, taskId: id,
    firstFailure: failed.failure, causeCode: saved['fixture:reference-failure'].causeCode, resumeHTTP: resumed.status,
    sameTask: true, requestUnchanged: true, artifactsUnchanged: true, restartRedispatches: 0,
    readingWrites, crossWrites, retrievals, deniedModelCalls, providerCalls: 0,
  }, null, 2) + '\n', { flag: 'wx' });
});
