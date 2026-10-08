import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  batchActionAllowed, batchCountsText, batchErrorMessage, batchRegistrationAllowed, batchStateLabel,
  canCancelSource, canRetryAnalysis, canRetryIndex, createBatchRequestGate, failureStage,
  libraryAPI, libraryBatchAPI, prepareBatchImport, sourceStatus,
} from '../src/model/library.ts';

const files = () => Array.from({ length: 10 }, (_, i) => new File([`第${i + 1}篇。门外有风。\r\n`], `小说${i + 1}.txt`));
const counts = changes => ({ registered: 10, queued: 10, running: 0, completed: 0, checked: 0, needs_review: 0, failed: 0, cancelled: 0, recoveryRequired: 0, ...changes });
const state = (changes = {}, actions = {}) => {
  const batch = { ...counts(changes), batchId: 'batch-one', items: [] };
  return { queue: { ...counts(changes), targetCount: 100, batchSize: 10, halted: false, closing: false, closed: false, requiresReopen: false, drainStatus: 'not_requested',
    batches: [batch], registrations: [{ batchId: batch.batchId, saved: 10, sources: [] }], ...changes }, actions };
};
const running = { status: 'running', startedAt: '2026-09-21T00:00:00Z' };
async function withFetch(replacement, work) {
  const original = globalThis.fetch; globalThis.fetch = replacement;
  try { return await work(); } finally { globalThis.fetch = original; }
}

test('batch selection requires exactly ten files before reading or submitting anything', async () => {
  let reads = 0;
  await withFetch(() => { assert.fail('No request is allowed during file preparation'); }, async () => {
    for (const size of [0, 9, 11, 20]) await assert.rejects(prepareBatchImport(Array.from({ length: size }, () => ({ arrayBuffer() { reads++; } })), 'unknown'), /恰好选择 10/);
    assert.equal(reads, 0);
  });
});

test('an invalid last file rejects the entire selection before any bytes are read', async () => {
  for (const bad of [{ name: 'wrong.pdf', size: 1 }, { name: 'empty.txt', size: 0 }, { name: 'big.md', size: 128001 }]) {
    const input = files(); let reads = 0;
    for (const file of input) file.arrayBuffer = async () => { reads++; return new ArrayBuffer(1); };
    input[9] = bad;
    await assert.rejects(prepareBatchImport(input, 'full'));
    assert.equal(reads, 0);
  }
});

test('transport preserves original local bytes and fixed identities, without decoding or starting work', async () => {
  const input = files(); input[0] = new File([new Uint8Array([255, 254, 0x42, 0x4e])], '原文.md');
  const payload = await prepareBatchImport(input, 'first_four');
  assert.equal(payload.sources.length, 10);
  assert.equal(new Set(payload.sources.map(source => source.requestId)).size, 10);
  assert.deepEqual(Buffer.from(payload.sources[0].contentBase64, 'base64'), Buffer.from(await input[0].arrayBuffer()));
  assert.equal(payload.sources[0].fileName, '原文.md');
  assert.equal(payload.sources[0].completeness, 'first_four');
  assert.equal(payload.sources[0].sourceNote, '');
  assert.deepEqual(Object.keys(payload), ['batchId', 'sources']);
});

test('identical bytes cannot count as two of the ten files', async () => {
  const input = files(); input[9] = new File([await input[0].arrayBuffer()], '另一文件名.txt');
  await assert.rejects(prepareBatchImport(input, 'unknown'), /相同原文/);
});

test('explicit continuation resends the exact registration identity and never calls run', async () => {
  const payload = await prepareBatchImport(files(), 'unknown'); const requests = [];
  await withFetch(async (url, init) => { requests.push({ url, init }); return Response.json(state(), { status: 201 }); }, async () => {
    await libraryBatchAPI.register(payload); await libraryBatchAPI.register(payload);
  });
  assert.deepEqual(requests.map(request => request.url), ['/api/library/batches', '/api/library/batches']);
  assert.equal(requests[0].init.body, requests[1].init.body);
  assert.deepEqual(JSON.parse(requests[0].init.body), payload);
});

test('202 run, recover and cancel are asynchronous commands with empty bodies', async () => {
  const requests = [];
  await withFetch(async (url, init) => { requests.push({ url, init }); return Response.json(state({}, { run: running }), { status: 202 }); }, async () => {
    assert.equal((await libraryBatchAPI.action('run')).actions.run.status, 'running');
    await libraryBatchAPI.action('recover'); await libraryBatchAPI.action('cancel:batch-one');
  });
  assert.deepEqual(requests.map(request => request.url), ['/api/library/batches/run', '/api/library/batches/recover', '/api/library/batches/batch-one/cancel']);
  assert.ok(requests.every(request => request.init.method === 'POST' && request.init.body === '{}'));
});

test('progress uses an abortable read, never a recovery or start request', async () => {
  const controller = new AbortController();
  await withFetch(async (url, init) => { assert.equal(url, '/api/library/batches'); assert.equal(init.signal, controller.signal); assert.equal(init.method, undefined); return Response.json(state()); }, () => libraryBatchAPI.progress(controller.signal));
});

test('only the public structured error is displayed; raw provider and network bodies stay hidden', async () => {
  for (const error of ['SECRET_RAW_MODEL_BODY', { code: 'DATA_WAIT_FAILED', message: '后台尚未确认任务停止。', raw: 'SECRET_RAW_MODEL_BODY' }]) {
    await withFetch(async () => Response.json({ error }, { status: 503 }), async () => {
      await assert.rejects(libraryBatchAPI.action('recover'), reason => {
        const text = batchErrorMessage(reason); assert.doesNotMatch(text, /SECRET/);
        if (typeof error === 'object') assert.equal(text, error.message);
        return true;
      });
    });
  }
  assert.doesNotMatch(batchErrorMessage(new Error('SECRET_RAW_MODEL_BODY')), /SECRET/);
  await withFetch(async () => new Response('SECRET_RAW_MODEL_BODY', { status: 200 }), () => assert.rejects(libraryBatchAPI.progress(), /状态尚未读取完整/));
});

test('deferred text and legal actions do not accidentally start a registered source through retry', () => {
  const source = { status: 'deferred', indexStatus: 'pending' };
  assert.equal(sourceStatus(source), '已登记，等待开始'); assert.equal(failureStage(source), '已登记，等待开始');
  assert.equal(canCancelSource(source), true); assert.equal(canRetryAnalysis(source), false);
  assert.equal(canRetryIndex({ ...source, analysis: {}, indexStatus: 'failed' }), false);
  assert.equal(canRetryAnalysis({ status: 'cancelled', deferred: true }), false);
  assert.equal(canRetryAnalysis({ status: 'cancelled' }, true), false); // Public summary may omit deferred.
  assert.equal(canCancelSource({ status: 'cancelled' }), false);
  assert.equal(canRetryAnalysis({ status: 'failed' }), true); // Ordinary uploads retain explicit retry.
});

test('run and recover are disabled while stale, submitting, already active or awaiting recovery', () => {
  const idle = state(); assert.equal(batchActionAllowed(idle, 'run'), true);
  for (const pending of [['run'], ['register'], ['recover'], ['cancel:batch-one']]) assert.equal(batchActionAllowed(idle, 'run', pending), false);
  assert.equal(batchActionAllowed(idle, 'run', [], true), false);
  assert.equal(batchActionAllowed(state({}, { run: running }), 'run'), false);
  assert.equal(batchActionAllowed(state({}, { run: running }), 'recover'), false);
  assert.equal(batchActionAllowed(state({ recoveryRequired: 1 }), 'run'), false);
  assert.equal(batchActionAllowed(state({ halted: true }), 'run'), false);
  assert.equal(batchActionAllowed(state({ halted: true }), 'recover'), true);
});

test('cancel remains available during a run, but never duplicates an in-flight cancellation', () => {
  const current = state({ queued: 8, running: 2 }, { run: running });
  assert.equal(batchActionAllowed(current, 'cancel:batch-one'), true);
  assert.equal(batchActionAllowed(current, 'cancel:missing'), false);
  assert.equal(batchActionAllowed(current, 'cancel:batch-one', ['cancel:batch-one']), false);
  current.actions['cancel:batch-one'] = running;
  assert.equal(batchActionAllowed(current, 'cancel:batch-one'), false);
  assert.equal(batchActionAllowed(state({ drainStatus: 'failed' }), 'cancel:batch-one'), false);
});

test('finished operations do not imply checked completion or permit retrying failures through run', () => {
  const ended = state({ queued: 0, failed: 3, needs_review: 7 }, { run: { ...running, status: 'completed' } });
  assert.equal(batchActionAllowed(ended, 'run'), false);
  assert.equal(batchActionAllowed(ended, 'recover'), true);
  assert.match(batchCountsText(ended.queue), /完成 0 · 待修订 7 · 失败 3/);
  assert.doesNotMatch(batchStateLabel(ended.queue), /已完成/);
});

test('registration capacity includes partially saved batches and cannot append during an active run', () => {
  assert.equal(batchRegistrationAllowed(state()), true);
  assert.equal(batchRegistrationAllowed(state({}, { run: running })), false);
  assert.equal(batchRegistrationAllowed(state(), ['register']), false);
  assert.equal(batchRegistrationAllowed(state(), [], true), false);
  assert.equal(batchRegistrationAllowed(state({ registrations: Array.from({ length: 10 }, (_, i) => ({ batchId: `b${i}`, saved: 1, sources: [] })) })), false);
});

test('the tenth partially registered batch can continue its original identity, but closed services cannot', () => {
  const current = state({ registrations: Array.from({ length: 10 }, (_, i) => ({ batchId: `b${i}`, saved: 3, sources: [] })) });
  assert.equal(batchRegistrationAllowed(current, [], false, 'b9'), true);
  assert.equal(batchRegistrationAllowed(current, [], false, 'new-batch'), false);
  current.queue.closed = true;
  assert.equal(batchRegistrationAllowed(current, [], false, 'b9'), false);
});

test('waiting for cancellation overrides the visible cancelled count until the command settles', () => {
  const cancelled = counts({ queued: 0, cancelled: 10 });
  assert.equal(batchStateLabel(cancelled, false, true), '正在取消，等待后台结束');
  assert.equal(batchStateLabel(cancelled), '已取消');
  assert.equal(batchStateLabel(counts({ queued: 0, needs_review: 10 })), '有待修订结果');
});

test('synchronous request gate rejects double clicks and invalidates late poll/action snapshots', () => {
  const gate = createBatchRequestGate(); const poll = gate.revision();
  const start = gate.begin('run'); assert.notEqual(start, null); assert.equal(gate.begin('run'), null);
  assert.equal(gate.accepts(poll), false); assert.equal(gate.accepts(start), true);
  const cancel = gate.begin('cancel:batch-one'); assert.notEqual(cancel, null);
  assert.equal(gate.accepts(start), false); assert.equal(gate.accepts(cancel), true);
  gate.finish('run'); assert.equal(gate.accepts(cancel), false);
  gate.finish('cancel:batch-one'); assert.equal(gate.pending.size, 0);
  assert.equal(gate.accepts(gate.revision()), true);
});

test('ordinary upload retains its separate single-source endpoint and transport', async () => {
  await withFetch(async (url, init) => {
    assert.equal(url, '/api/library/sources');
    assert.equal(JSON.parse(init.body).requestId, 'ordinary-upload');
    return Response.json({ source: { status: 'queued' } });
  }, () => libraryAPI.upload(files()[0], 'unknown', 'ordinary-upload'));
});

// Render the actual components and BoardUI controls, without DOM effects, a server, or a network.
const project = fileURLToPath(new URL('..', import.meta.url));
const localRequire = createRequire(new URL('../package.json', import.meta.url));
const compilerRequire = process.env.TALEWICK_UI_DEPENDENCIES ? createRequire(`${process.env.TALEWICK_UI_DEPENDENCIES}/package.json`) : localRequire;
const { build } = compilerRequire('esbuild');
const { createElement } = compilerRequire('react');
const { renderToStaticMarkup } = compilerRequire('react-dom/server');
async function loadComponent(entry) {
  const result = await build({ absWorkingDir: project, entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'empty' }, logLevel: 'silent' });
  const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(compilerRequire, module, module.exports);
  return module.exports;
}
const { LibraryBatchProgress } = await loadComponent('src/features/LibraryBatchProgress.tsx');
const { SourceLibrary } = await loadComponent('src/features/SourceLibrary.tsx');
const renderBatch = (current, props = {}) => renderToStaticMarkup(createElement(LibraryBatchProgress, { state: current, expanded: false, onExpand() {}, pending: [], stale: false, onAction() {}, ...props }));

test('empty queue renders no persistent empty batch card', () => {
  assert.equal(renderBatch(state({ batches: [], registrations: [] })), '');
});

test('registration renders a start button outside collapsed progress and no invented completion', () => {
  const html = renderBatch(state());
  assert.match(html, /aria-expanded="false"/); assert.match(html, /hidden=""/);
  assert.match(html, /已登记，等待开始/); assert.match(html, /开始已登记作品/);
  assert.match(html, /已完成并复核 0 \/ 100 篇/); assert.match(html, /登记只保存原文/);
  assert.ok(html.indexOf('开始已登记作品') < html.indexOf('hidden=""'));
});

test('actual progressbar uses checked count; review and failure counts do not fill it', () => {
  const html = renderBatch(state({ queued: 0, completed: 3, checked: 3, needs_review: 5, failed: 2 }), { expanded: true });
  assert.match(html, /aria-valuenow="3"/); assert.match(html, /aria-valuemax="10"/);
  assert.match(html, /完成 3 · 待修订 5 · 失败 2/); assert.match(html, /即使原文可检索，也不计为完成/);
  assert.doesNotMatch(html, /全部可用|成效提升|ROI|开始已登记作品/);
});

test('cancelled rows still display the actual outstanding cancellation and a disabled button', () => {
  const html = renderBatch(state({ queued: 0, cancelled: 10 }, { 'cancel:batch-one': running }), { expanded: true });
  assert.match(html, /正在取消，等待后台结束/); assert.match(html, /取消已请求，正在等待后台调用结束/);
  assert.match(html, /<button[^>]*disabled=""[^>]*><span[^>]*>等待取消结束/);
  const collapsed = renderBatch(state({ queued: 0, cancelled: 10 }, { 'cancel:batch-one': running }));
  assert.match(collapsed.slice(0, collapsed.indexOf('hidden=""')), /正在取消，等待后台结束/);
});

test('recovery and cancellation show safe public messages without provider fields', () => {
  const html = renderBatch(state({ drainStatus: 'failed' }, { recover: { ...running, status: 'failed', error: { code: 'DATA_WAIT_FAILED', message: '后台尚未确认任务停止。', body: 'SECRET_MODEL_BODY' } } }));
  assert.match(html, /恢复核对未完成：后台尚未确认任务停止。/); assert.doesNotMatch(html, /SECRET_MODEL_BODY/);
  assert.match(html, /后台尚未确认所有调用结束/);
});

test('partial registration displays saved count without claiming queued or complete', () => {
  const html = renderBatch(state({ ...counts({ registered: 0, queued: 0 }), batches: [], registrations: [{ batchId: 'partial', saved: 3, sources: [] }] }), { expanded: true });
  assert.match(html, /原文已保存 3 \/ 10 篇，尚未开始/); assert.doesNotMatch(html, /开始已登记作品/);
});

test('source library keeps a separate batch entry and closes the detail reader on initial render', async () => {
  await withFetch(() => { assert.fail('Rendering must not call a real API'); }, () => {
    const html = renderToStaticMarkup(createElement(SourceLibrary, { uploadOpen: false, onClose() {}, legacyItem: null }));
    assert.match(html, /批量拆解（每批10篇）/); assert.match(html, /普通上传照常使用/);
    assert.match(html, /source-library-layout/); assert.doesNotMatch(html, /aria-label="拆解详情"/);
  });
});
