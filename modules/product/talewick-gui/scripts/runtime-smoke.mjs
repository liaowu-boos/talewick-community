#!/usr/bin/env node
/**
 * Browser integration for the real HTTP runtime and default four-module workflow.
 * Only the model is replaced by an explicit fixed stub. No external model call,
 * real novel-quality claim, or Full15 acceptance is made by these checks.
 * Uses fresh browser contexts and newly created temporary task directories.
 *
 * Environment: TALEWICK_SMOKE_DIST, TALEWICK_SMOKE_REPORT_DIR,
 * TALEWICK_PLAYWRIGHT_MODULE (optional if installed), TALEWICK_BROWSER_EXECUTABLE.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntime } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.resolve(process.env.TALEWICK_SMOKE_DIST || path.join(root, 'dist'));
const reportDir = path.resolve(process.env.TALEWICK_SMOKE_REPORT_DIR || path.join(root, 'runtime-evidence', 'browser'));
const key = 'talewick.boardui.gui.v1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), scope: 'Real browser → HTTP runtime → default workflow → fixed model stub. No external model or Full15 execution.', distDir, cases: [], captures: [], pageErrors: [], externalRequests: [], taskIds: [], temporaryTaskDirectories: [] };
const gates = [];
const openRuntimes = [];
const contexts = [];
let browser;

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const value = { promise, resolve }; gates.push(value); return value;
}

async function waitGate(value, signal) {
  signal?.throwIfAborted();
  let abort;
  try {
    await Promise.race([value.promise, new Promise((_, reject) => {
      abort = () => reject(signal.reason || new Error('Fixed model call cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally { if (abort) signal?.removeEventListener('abort', abort); }
  signal?.throwIfAborted();
}

const originalBodies = [
  '小禾听不见钟声。她走进钟楼，发现齿轮已经松脱，决定亲手修好它。',
  '她重新装好齿轮。钟响了，小禾把最后一枚铜钱留给教她修钟的师傅。',
];

function fixedModel() {
  const calls = [];
  const model = {
    calls, planningGate: gate(), revisionGate: null,
    async complete(args) {
      calls.push({ stage: args.stage, at: new Date().toISOString() });
      args.signal?.throwIfAborted();
      const input = JSON.parse(args.user);
      if (args.stage === 'requirements') return JSON.stringify({ summary: '浏览器接通测试：山村旧钟。', genre: '测试短故事', pointOfView: '第三人称', setting: '山村', targetHanMin: 1, targetHanMax: 1000, targetChapterCount: 2, requiredElements: [], prohibitions: [], assumptions: [], completeEnding: true });
      if (args.stage === 'planning') {
        await waitGate(model.planningGate, args.signal);
        return JSON.stringify({ title: '旧钟', premise: '旧钟停摆', ending: '修好了钟', constraints: [], chapters: [
          { title: '停钟', goal: '发现齿轮松脱，决定修钟', targetHan: 100 },
          { title: '钟声', goal: '修好钟并付出最后的铜钱', targetHan: 100 },
        ] });
      }
      if (args.stage === 'draft:ch-1') return originalBodies[0];
      if (args.stage === 'draft:ch-2') return originalBodies[1];
      if (args.stage === 'requestedRevision') {
        if (model.revisionGate) await waitGate(model.revisionGate, args.signal);
        args.signal?.throwIfAborted();
        if (input.selection) {
          calls[calls.length - 1].selection = structuredClone(input.selection);
          return JSON.stringify({ replacement: `${input.selection.text}【位置修订】` });
        }
        const chapter = input.chapters[1];
        const body = String(input.instruction).includes('星纹') ? chapter.body.replace('银币', '刻着星纹的银币') : chapter.body.replace('铜钱', '银币');
        return JSON.stringify({ chapters: [{ id: chapter.id, body }] });
      }
      if (['review', 'revisionReview'].includes(args.stage)) return JSON.stringify({ summary: '固定测试模型已收到本次正文；此结果只验证系统接通。', issues: [{ chapterId: input.chapters[0].id, category: 'LOCAL_CAUSALITY_BLOCKER', severity: 'optional', quote: input.chapters[0].body.slice(0, 10), explanation: '测试审稿意见：可补充修钟的动作依据。', suggestion: '测试修改建议：增加一处具体动作。' }], strengths: [], limitations: ['未调用外部模型，未验证真实小说质量。'] });
      throw new Error(`Unexpected fixed model stage: ${args.stage}`);
    },
  };
  return model;
}

async function chromium() {
  if (process.env.TALEWICK_PLAYWRIGHT_MODULE) return (await import(pathToFileURL(path.resolve(process.env.TALEWICK_PLAYWRIGHT_MODULE)).href)).chromium;
  try { return (await import('playwright')).chromium; }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    try { return (await import('playwright-core')).chromium; }
    catch { throw new Error('Set TALEWICK_PLAYWRIGHT_MODULE to an existing Playwright module. This script never installs dependencies.'); }
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function start(configured) {
  const model = fixedModel();
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-browser-tasks-'));
  report.temporaryTaskDirectories.push(runsDir);
  const port = await freePort();
  const runtime = await createRuntime({ config: { baseURL: 'https://example.invalid/v1', apiKey: configured ? 'explicit-browser-stub-placeholder' : '', model: 'fixed-browser-smoke-stub', port, timeoutMs: 1000, runsDir }, model, distDir });
  openRuntimes.push(runtime);
  await new Promise((resolve, reject) => { runtime.server.once('error', reject); runtime.server.listen(port, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${port}`;
  (report.fixtureModelCalls ??= []).push({ origin, configured, calls: model.calls });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, reducedMotion: 'reduce', acceptDownloads: true });
  contexts.push(context);
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || /^(blob:|data:)/.test(url)) return route.continue();
    report.externalRequests.push(url); return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: '创作想法', exact: true }).waitFor();
  return { runtime, model, page, context, origin };
}

async function stateOf(page) { return page.evaluate(storageKey => JSON.parse(localStorage.getItem(storageKey)), key); }
function active(state) { return state.projects.find(project => project.id === state.activeProjectId); }
async function waitState(page, predicate, label) {
  const deadline = Date.now() + 60000;
  let state;
  while (Date.now() < deadline) { state = await stateOf(page); if (state && predicate(state)) return state; await pause(100); }
  throw new Error(`${label}. Last active runtime: ${JSON.stringify(active(state)?.runtime?.task ?? active(state)?.runtime?.connectionError ?? null)}`);
}
async function waitUntil(predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(50); }
  throw new Error(label);
}
async function progressOf(page) {
  const visible = page.locator('[aria-label="创作进度"]:visible');
  await visible.first().waitFor();
  assert.equal(await visible.count(), 1, 'Only one progress panel may be visible at the current viewport');
  return visible;
}
async function replaceState(page, state) {
  await page.evaluate(({ storageKey, value }) => localStorage.setItem(storageKey, JSON.stringify(value)), { storageKey: key, value: state });
  await page.reload({ waitUntil: 'domcontentloaded' });
  return waitState(page, value => value.activeProjectId === state.activeProjectId, 'Stored project did not reopen');
}
async function send(page, text) {
  await page.getByRole('textbox', { name: '创作想法', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送创作想法', exact: true }).click();
}
async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const file = path.join(reportDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  report.captures.push(file);
}
async function check(name, action) {
  const start = Date.now();
  try { await action(); report.cases.push({ name, status: 'PASS', durationMs: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) { report.cases.push({ name, status: 'FAIL', durationMs: Date.now() - start, error: error.stack || String(error) }); throw error; }
}

try {
  await mkdir(reportDir, { recursive: true });
  report.distIndexSha256 = createHash('sha256').update(await readFile(path.join(distDir, 'index.html'))).digest('hex');
  browser = await (await chromium()).launch({ executablePath: process.env.TALEWICK_BROWSER_EXECUTABLE || undefined, headless: true });
  await check('missing configuration creates no manuscript or backend task', async () => {
    const { runtime, model, page } = await start(false);
    await page.getByRole('button', { name: /创作模式/ }).click();
    for (const name of ['轻度参与 · 暂未接通', '专业审稿 · 暂未接通']) {
      const option = page.getByRole('option', { name, exact: true });
      await option.waitFor();
      assert.equal(await option.getAttribute('aria-disabled'), 'true', `${name} must not start a demo workflow`);
    }
    await page.keyboard.press('Escape');
    const before = (await waitState(page, state => Boolean(state.projects), 'Initial state missing')).projects;
    await send(page, '写一个关于山村旧钟的故事。');
    const state = await waitState(page, value => Boolean(active(value)?.runtime?.connectionError), 'Missing configuration message missing');
    assert.equal(active(state).chapters.length, 0);
    assert.equal(active(state).runtime.task, undefined);
    assert.equal(runtime.tasks.list().length, 0);
    assert.equal(model.calls.length, 0);
    assert.match(active(state).runtime.connectionError, /模型.*配置/);
    assert.deepEqual(state.projects.filter(project => before.some(item => item.id === project.id)).map(project => project.chapters), before.map(project => project.chapters));
    assert.equal(JSON.stringify(state).includes('explicit-browser-stub-placeholder'), false);
    await capture(page, 'missing-configuration');
  });

  const fixture = await start(true);
  const { page, model, runtime } = fixture;
  let projectId;
  let createTaskId;
  await check('create survives a running-page refresh and applies the same task result', async () => {
    await send(page, '写一个关于山村旧钟的两章短故事，主角小禾修好钟楼。');
    let state = await waitState(page, value => Boolean(active(value)?.runtime?.task?.id), 'Task acknowledgement missing');
    projectId = active(state).id; createTaskId = active(state).runtime.task.id;
    const requestId = active(state).runtime.request.requestId;
    assert.equal(active(state).chapters.length, 0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    state = await waitState(page, value => active(value)?.runtime?.task?.id === createTaskId, 'Refresh did not retain task identity');
    assert.equal(active(state).runtime.request.requestId, requestId);
    assert.equal(active(state).status, 'writing');
    state = await waitState(page, value => active(value)?.runtime?.task?.stage === 'planning', 'Planning progress missing after refresh');
    assert.match(await (await progressOf(page)).innerText(), /规划/);
    assert.equal(await page.getByRole('button', { name: '取消任务', exact: true }).count(), 1);
    model.planningGate.resolve();
    state = await waitState(page, value => active(value)?.runtime?.resultDisposition === 'applied', 'Completed manuscript not applied');
    assert.deepEqual(active(state).chapters.map(chapter => chapter.body), originalBodies);
    assert.equal(active(state).title, '旧钟');
    assert.equal(active(state).versions.length, 1);
    assert.equal(runtime.tasks.list(projectId).length, 1);
    assert.equal(model.calls.filter(call => call.stage === 'requirements').length, 1);
    assert.equal(active(state).runtime.task.result.checks.full15.status, 'NOT_EVALUATED');
    await page.getByText('本机稿件', { exact: true }).waitFor();
    await progressOf(page);
    report.taskIds.push({ purpose: 'create', id: createTaskId });
  });

  await check('revision stays separate until accepted and retains the prior version', async () => {
    const before = active(await stateOf(page));
    model.revisionGate = gate();
    await send(page, '把第二章的铜钱改成银币，其他内容保留。');
    let state = await waitState(page, value => active(value)?.runtime?.task?.kind === 'revise', 'Revision acknowledgement missing');
    const taskId = active(state).runtime.task.id;
    assert.deepEqual(active(state).chapters, before.chapters);
    model.revisionGate.resolve();
    state = await waitState(page, value => active(value)?.runtime?.resultDisposition === 'proposals', 'Revision proposal missing');
    assert.deepEqual(active(state).chapters, before.chapters);
    assert.equal(active(state).pendingEdits.filter(edit => edit.status === 'pending').length, 1);
    assert.equal(active(state).runtime.task.result.title, active(state).title, 'A body revision must preserve the submitted book title');
    assert.equal(active(state).runtime.message.includes('标题建议'), false);
    await page.getByRole('button', { name: '全部采纳', exact: true }).click();
    state = await waitState(page, value => active(value)?.chapters[1].body.includes('银币'), 'Accept did not update manuscript');
    assert.equal(active(state).chapters[0].body, before.chapters[0].body);
    assert.ok(active(state).versions.some(version => version.chapters[1]?.body.includes('铜钱')));
    assert.equal(active(state).pendingEdits.filter(edit => edit.status === 'pending').length, 0);
    assert.equal(active(state).runtime.task.id, taskId);
    report.taskIds.push({ purpose: 'revise', id: taskId });
  });

  let manuallyEditedBody;
  await check('editing while revision runs holds the returned result without overwriting', async () => {
    model.revisionGate = gate();
    const previousTask = active(await stateOf(page)).runtime.task.id;
    await send(page, '把第二章的银币改成刻着星纹的银币。');
    let state = await waitState(page, value => active(value)?.runtime?.task?.id && active(value).runtime.task.id !== previousTask, 'Second revision acknowledgement missing');
    const taskId = active(state).runtime.task.id;
    await page.getByRole('tab', { name: '编辑', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '章节正文', exact: true });
    manuallyEditedBody = (await editor.inputValue()) + '\n\n这是用户在任务运行时亲自补写的句子。';
    await editor.fill(manuallyEditedBody);
    await waitState(page, value => active(value).chapters.some(chapter => chapter.body === manuallyEditedBody), 'Manual edit not saved');
    model.revisionGate.resolve();
    state = await waitState(page, value => active(value)?.runtime?.resultDisposition === 'held', 'Changed manuscript was not held');
    assert.ok(active(state).chapters.some(chapter => chapter.body === manuallyEditedBody));
    assert.equal(active(state).chapters.some(chapter => chapter.body.includes('星纹')), false);
    assert.ok(active(state).runtime.task.result.chapters.some(chapter => chapter.body.includes('星纹')));
    assert.equal(active(state).pendingEdits.filter(edit => edit.status === 'pending').length, 0);
    assert.match(await (await progressOf(page)).innerText(), /本次结果已保留/);
    await page.getByRole('button', { name: '查看本次结果与检查报告', exact: true }).click();
    await page.getByRole('dialog').getByText(/Full15 本次未运行/).waitFor();
    await page.getByRole('dialog').getByText(/刻着星纹的银币/).waitFor();
    await page.getByRole('dialog').getByText('测试审稿意见：可补充修钟的动作依据。', { exact: true }).waitFor();
    await page.getByRole('dialog').getByText('修改建议：测试修改建议：增加一处具体动作。', { exact: true }).waitFor();
    await page.getByRole('dialog').getByText('引文已匹配本次审阅稿。', { exact: true }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: '关闭窗口', exact: true }).click();
    await page.getByRole('tab', { name: '阅读', exact: true }).click();
    await capture(page, 'final-manuscript');
    report.taskIds.push({ purpose: 'held-revision', id: taskId });
  });

  await check('TXT export contains accepted and manual edits, excluding held suggestions', async () => {
    const state = await stateOf(page); const project = active(state);
    await page.getByRole('button', { name: '导出稿件', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '纯文本 TXT', exact: true }).click();
    const download = await downloadPromise;
    const exported = await readFile(await download.path(), 'utf8');
    const expected = `${project.title}\n\n` + project.chapters.map(chapter => `${chapter.title}\n\n${chapter.body}`).join('\n\n---\n\n');
    assert.equal(exported, expected);
    assert.match(exported, /银币/);
    assert.ok(exported.includes(manuallyEditedBody));
    assert.equal(exported.includes('星纹'), false);
    report.export = { filename: download.suggestedFilename(), sha256: createHash('sha256').update(exported).digest('hex'), exactCurrentManuscript: true };
  });

  await check('cancel and resume keep the original task and completed checkpoints', async () => {
    const fixture = await start(true);
    const { page, model, runtime } = fixture;
    await send(page, '写一个等待我确认后继续的旧钟测试故事。');
    let state = await waitState(page, value => active(value)?.runtime?.task?.stage === 'planning', 'Planning progress missing');
    const task = active(state).runtime.task;
    const requestId = active(state).runtime.request.requestId;
    await (await progressOf(page)).getByRole('button', { name: '取消任务', exact: true }).click();
    state = await waitState(page, value => active(value)?.runtime?.task?.status === 'cancelled', 'Cancellation not reflected in UI');
    await waitUntil(() => !runtime.tasks.busy, 'Cancelled model call did not finish');
    assert.equal(active(state).chapters.length, 0);
    assert.equal(runtime.tasks.get(task.id).result, undefined);
    assert.match(await (await progressOf(page)).innerText(), /取消/);
    model.planningGate = gate();
    await (await progressOf(page)).getByRole('button', { name: '重试任务', exact: true }).click();
    state = await waitState(page, value => active(value)?.runtime?.task?.status === 'running', 'Resume did not restart the same task');
    assert.equal(active(state).runtime.task.id, task.id);
    assert.equal(active(state).runtime.request.requestId, requestId);
    model.planningGate.resolve();
    state = await waitState(page, value => active(value)?.runtime?.resultDisposition === 'applied', 'Resumed result not applied');
    assert.deepEqual(active(state).chapters.map(chapter => chapter.body), originalBodies);
    assert.equal(runtime.tasks.list(task.projectId).length, 1);
    assert.equal(model.calls.filter(call => call.stage === 'requirements').length, 1);
    assert.equal(model.calls.filter(call => call.stage === 'planning').length, 2);
    const completed = structuredClone(active(state));
    await page.reload({ waitUntil: 'domcontentloaded' });
    state = await waitState(page, value => active(value)?.runtime?.task?.status === 'completed', 'Completed legacy runtime binding lost on reload');
    assert.deepEqual(active(state).chapters, completed.chapters);
    assert.deepEqual(active(state).versions, completed.versions);
    assert.equal(active(state).runtime.handledTaskId, task.id);
    await page.setViewportSize({ width: 390, height: 844 });
    await progressOf(page);
    await capture(page, 'narrow-manuscript');
    await page.getByRole('region', { name: '文稿工作区', exact: true }).getByRole('button', { name: '返回对话', exact: true }).click();
    await progressOf(page);
    report.taskIds.push({ purpose: 'cancel-resume', id: task.id });
  });

  await check('an old professional-mode project retains its manuscript without starting a demo task', async () => {
    const { page, runtime, model } = await start(true);
    const state = await waitState(page, value => value.projects?.length, 'Seed projects missing');
    const project = state.projects.find(item => item.chapters.length);
    assert.ok(project, 'An existing manuscript fixture is required');
    project.mode = 'pro'; project.phase = 'opening'; project.status = 'writing'; project.paused = false;
    delete project.runtime; delete project.runtimeHistory;
    project.docOpen = true; state.activeProjectId = project.id; state.page = 'create';
    const original = structuredClone({ chapters: project.chapters, versions: project.versions, pendingEdits: project.pendingEdits });
    const loaded = active(await replaceState(page, state));
    assert.deepEqual({ chapters: loaded.chapters, versions: loaded.versions, pendingEdits: loaded.pendingEdits }, original);
    assert.notEqual(loaded.status, 'writing');
    assert.match(await (await progressOf(page)).innerText(), /文稿已就绪|修改待审阅/);
    assert.match(await page.locator('.chat-header').innerText(), /专业审稿.*暂未接通/);
    assert.equal(await page.getByRole('button', { name: /确认开篇.*完整稿|继续生成|开始成稿/ }).count(), 0);
    assert.equal(runtime.tasks.list().length, 0);
    assert.equal(model.calls.length, 0);
  });

  await check('quoting the second duplicate sentence reaches HTTP and changes only that occurrence', async () => {
    const { page, runtime, model } = await start(true);
    const state = await waitState(page, value => value.projects?.length, 'Seed projects missing');
    const project = state.projects.find(item => item.chapters.length);
    assert.ok(project, 'An existing manuscript fixture is required');
    const sentence = '她把铜钱放在桌上。';
    let body = `${sentence}\n\n她又想起了师傅。\n\n${sentence}`;
    project.mode = 'auto'; project.phase = 'done'; project.status = 'ready'; project.paused = false;
    project.chapters = [{ id: 'anchor-first', title: '前文', body: '这段前文保持原样。' }, { id: 'anchor-repeat', title: '同句定位', body }];
    project.pendingEdits = []; project.versions = []; project.selectedChapter = 1; project.docOpen = true; project.docMode = 'edit';
    project.editorBaseline = null; delete project.runtime; delete project.runtimeHistory;
    state.activeProjectId = project.id; state.page = 'create'; state.quote = ''; delete state.quoteSource;
    await replaceState(page, state);
    body += '\n\n这句自动保存的补充也应保留。';
    await page.getByRole('textbox', { name: '章节正文', exact: true }).fill(body);
    await waitState(page, value => active(value)?.chapters[1].body === body, 'Auto-saved edit missing');
    await page.getByRole('tab', { name: '阅读', exact: true }).click();
    await page.getByRole('tab', { name: '编辑', exact: true }).click();
    const selectionStart = body.lastIndexOf(sentence);
    const source = { chapterId: 'anchor-repeat', start: selectionStart };
    const editor = page.getByRole('textbox', { name: '章节正文', exact: true });
    await editor.evaluate((element, end) => { element.focus(); element.setSelectionRange(end, end); }, selectionStart + sentence.length);
    for (const _ of sentence) await editor.press('Shift+ArrowLeft');
    await page.getByRole('button', { name: '交给助手', exact: true }).click();
    let current = await waitState(page, value => value.quote === sentence, 'Selected quotation missing');
    assert.deepEqual(current.quoteSource, source);
    await send(page, '只修改我选中的第二处，其他正文保留。');
    current = await waitState(page, value => active(value)?.runtime?.resultDisposition === 'proposals', 'Anchored revision proposal missing');
    const revised = active(current);
    assert.deepEqual(revised.runtime.request.quoteSource, source);
    const request = JSON.parse(await readFile(path.join(runtime.tasks.runsDir, revised.runtime.task.id, 'request.json'), 'utf8'));
    assert.deepEqual(request.quoteSource, source);
    const selection = model.calls.find(call => call.stage === 'requestedRevision')?.selection;
    assert.deepEqual(selection, { ...source, end: selectionStart + sentence.length, text: sentence });
    assert.equal(revised.chapters[1].body, body, 'Original body must remain until acceptance');
    await page.getByRole('button', { name: '全部采纳', exact: true }).click();
    const expected = body.slice(0, selectionStart) + sentence + '【位置修订】' + body.slice(selectionStart + sentence.length);
    current = await waitState(page, value => active(value)?.chapters[1].body === expected, 'Second occurrence was not updated at the submitted anchor');
    assert.equal(active(current).chapters[0].body, '这段前文保持原样。');
    assert.ok(active(current).chapters[1].body.startsWith(sentence + '\n\n'));
    assert.equal(active(current).versions.some(version => version.chapters[1]?.body === body), true);
    await page.getByRole('tab', { name: '编辑', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '章节正文', exact: true }).inputValue(), expected, 'Saved draft must follow accepted runtime text');
    await page.getByRole('tab', { name: '阅读', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0, 'Auto-saved text must not leave a phantom unsaved draft');
    await capture(page, 'anchored-revision');
    report.taskIds.push({ purpose: 'anchored-duplicate-revision', id: revised.runtime.task.id });
  });
  assert.equal(report.pageErrors.length, 0, `Browser errors: ${report.pageErrors.join('; ')}`);
  assert.equal(report.externalRequests.length, 0, 'Unexpected non-local browser network request');
  report.modelCalls = model.calls;
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = error.stack || String(error); process.exitCode = 1;
  console.error(report.error);
} finally {
  for (const value of gates) value.resolve();
  for (const context of contexts) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  for (const runtime of openRuntimes) {
    await runtime.tasks.close().catch(() => {});
    if (runtime.server.listening) await new Promise(resolve => { runtime.server.close(resolve); runtime.server.closeAllConnections(); });
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(reportDir, { recursive: true });
  const filename = path.join(reportDir, `runtime-smoke-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(filename, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, report: filename, captures: report.captures, cases: report.cases.map(({ name, status }) => ({ name, status })) }, null, 2));
}
