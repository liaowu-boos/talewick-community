/** From the GUI directory: npm run build && node scripts/project-title-browser.mjs.
 * Uses the same Playwright/Chrome environment variables as history-project-switch-browser.mjs.
 */
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRuntime} from '../server/index.mjs';

const storageKey = 'talewick.boardui.gui.v1';
const date = '2026-01-01T00:00:00.000Z';
const projectId = 'synthetic-project-title';
const chapters = [
  {id: 'pier', title: '渡口', body: '纸旗落在石阶上。\n\n小船驶向东岸。🌕'},
  {id: 'bridge', title: '木桥', body: '木桥下游过一条鱼。'},
];
const oldVersion = {id: 'old-snapshot', label: '合成旧存稿', title: '更早的书名', date,
  chapters: [chapters[1], {...chapters[0], body: '旧稿停在西岸。'}]};
const project = {id: projectId, title: '河岸值班簿', phase: 'complete', status: 'ready',
  docMode: 'read', docOpen: true, selectedChapter: 0, chapters, versions: [oldVersion],
  messages: [{role: 'assistant', text: '合成挂载同步标记', turnId: 'synthetic-missing-turn', turnStatus: 'running'}],
  pendingEdits: [
    {id: 'pending', chapterId: 'pier', start: 0, before: '纸旗', after: '布旗', reason: '合成待审意见', status: 'pending'},
    {id: 'accepted', chapterId: 'bridge', start: 0, before: '旧桥', after: '木桥', reason: '合成已处理意见', status: 'accepted'},
  ]};
const newTitle = '河岸的新名字 🌕';

async function readProject(page) {
  return page.evaluate(({key, id}) => JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id),
    {key: storageKey, id: projectId});
}

function checkSnapshots(stored, before, beforeTitle, afterTitle) {
  assert.equal(stored.versions.length, before.versions.length + 2);
  assert.deepEqual(stored.versions.slice(0, -2), before.versions);
  assert.equal(new Set(stored.versions.map(version => version.id)).size, stored.versions.length);
  const snapshots = stored.versions.slice(-2);
  for (const [index, title] of [beforeTitle, afterTitle].entries()) {
    assert.ok(snapshots[index].id);
    assert.ok(Number.isFinite(Date.parse(snapshots[index].date)));
    assert.equal(snapshots[index].title, title);
    assert.deepEqual(snapshots[index].chapters, before.chapters);
  }
}

async function exercise(page) {
  const entry = page.getByRole('button', {name: '修改书名', exact: true});
  const dialog = page.getByRole('dialog');
  const preview = page.getByRole('region', {name: '修改作品书名', exact: true});
  const input = preview.getByRole('textbox', {name: '新书名', exact: true});
  const confirm = preview.getByRole('button', {name: '确认修改书名', exact: true});
  const cancel = preview.getByRole('button', {name: '取消改名', exact: true});
  const checkWorkbench = async title => {
    await dialog.waitFor({state: 'hidden'});
    await page.getByRole('button', {name: title, exact: true}).waitFor();
    await page.getByRole('heading', {name: chapters[0].title, level: 3, exact: true}).waitFor();
    assert.equal(await page.getByTestId('manuscript-prose').filter({visible: true}).textContent(), chapters[0].body);
  };
  await checkWorkbench(project.title);
  await page.waitForFunction(({key, id}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.messages[0]?.turnStatus === 'interrupted',
    {key: storageKey, id: projectId});
  const initial = await readProject(page);
  assert.equal(initial.title, project.title);
  assert.deepEqual(initial.chapters, chapters);
  assert.deepEqual(initial.versions, [oldVersion]);
  assert.deepEqual(initial.pendingEdits, project.pendingEdits);
  assert.equal(await entry.isEnabled(), true, 'idle saved manuscript allows renaming');

  await entry.click();
  assert.equal(await input.inputValue(), project.title);
  await input.fill('应当取消的合成书名');
  await cancel.click();
  await preview.waitFor({state: 'hidden'});
  await page.clock.runFor(500);
  assert.deepEqual(await readProject(page), initial, 'cancel preserves every project field');
  await checkWorkbench(project.title);

  await entry.click();
  for (const invalid of ['', '   ', project.title, '  ' + project.title + '  ']) {
    await input.fill(invalid);
    assert.equal(await confirm.isDisabled(), true, 'blank or unchanged trimmed title is disabled');
    await input.press('Enter');
    await preview.waitFor();
    await page.clock.runFor(500);
    assert.deepEqual(await readProject(page), initial, 'invalid submissions create no snapshot');
  }
  await input.fill('  ' + newTitle + '  ');
  assert.equal(await confirm.isEnabled(), true);
  if (process.env.TALEWICK_SCREENSHOT) await page.screenshot({path: process.env.TALEWICK_SCREENSHOT});
  await confirm.click();
  await checkWorkbench(newTitle);
  await page.waitForFunction(({key, id, title}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.title === title,
    {key: storageKey, id: projectId, title: newTitle});
  const renamed = await readProject(page);
  checkSnapshots(renamed, initial, project.title, newTitle);
  assert.equal(renamed.versions.at(-2).label, '改名前的稿件');
  assert.deepEqual(renamed, {...initial, title: newTitle, versions: renamed.versions, updatedAt: renamed.updatedAt},
    'rename preserves all chapter text, suggestions and other project fields');

  await page.reload();
  await checkWorkbench(newTitle);
  assert.deepEqual(await readProject(page), renamed, 'title and snapshot identities survive reload');
  await page.getByRole('button', {name: '版本记录', exact: true}).click();
  await dialog.locator('[aria-label="选择历史版本"] button[aria-pressed]')
    .filter({has: page.getByText('改名前的稿件', {exact: true})}).click();
  await dialog.getByRole('heading', {name: project.title, exact: true}).waitFor();
  await dialog.getByRole('button', {name: '恢复此版本', exact: true}).click();
  const restorePreview = dialog.getByRole('region', {name: '整稿恢复预览', exact: true});
  await restorePreview.getByRole('button', {name: '确认恢复整稿', exact: true}).click();
  await checkWorkbench(project.title);
  await page.waitForFunction(({key, id, count}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.versions.length === count,
    {key: storageKey, id: projectId, count: renamed.versions.length + 2});
  const restored = await readProject(page);
  assert.equal(restored.title, project.title);
  assert.deepEqual(restored.chapters, chapters);
  checkSnapshots(restored, renamed, newTitle, project.title);
  assert.deepEqual(restored.pendingEdits, [], 'whole-version restore retains its existing clear-suggestions behavior');
  await page.reload();
  await checkWorkbench(project.title);
  assert.deepEqual(await readProject(page), restored);

  // Create the draft through the real editor, so hydration cannot erase this condition.
  await page.getByRole('tab', {name: '编辑', exact: true}).click();
  const editor = page.getByRole('textbox', {name: '章节正文', exact: true});
  await editor.waitFor();
  await page.clock.runFor(500);
  const beforeDraft = await readProject(page);
  assert.equal(beforeDraft.docMode, 'edit');
  assert.equal(await entry.isEnabled(), true, 'saved editor state permits renaming');
  const draft = '仅在编辑器中的合成草稿。🌒';
  await editor.fill(draft);
  assert.equal(await editor.inputValue(), draft);
  assert.notEqual(draft, beforeDraft.chapters[0].body);
  assert.equal(await entry.isDisabled(), true, 'unsaved draft disables renaming');
  await page.clock.runFor(500);
  assert.deepEqual(await readProject(page), beforeDraft, 'draft is still uncommitted');
  assert.equal(await preview.count(), 0);
  await editor.fill(beforeDraft.chapters[0].body);
  assert.equal(await entry.isEnabled(), true, 'removing the draft re-enables renaming');
}

async function exerciseRunning(browser, origin, external, errors, mutations) {
  const task = {id: 'synthetic-running-task', projectId, requestId: 'synthetic-running-request',
    baseRevision: 'synthetic-running-revision', kind: 'revise', status: 'running',
    stage: 'planning', engine: 'fixed', engineVersion: 'fixed-workflow-2', createdAt: date, updatedAt: date};
  const polledTask = {...task, updatedAt: '2026-01-01T00:00:01.000Z'};
  const runningProject = {...project, status: 'writing', runtime: {
    request: {projectId, requestId: task.requestId, baseRevision: task.baseRevision, kind: task.kind,
      idea: '合成运行状态', chapters, context: {}, materials: [], style: null},
    baseManuscript: {title: project.title, chapters}, task,
  }};
  const context = await browser.newContext({viewport: {width: 1512, height: 982}, reducedMotion: 'reduce'});
  let polls = 0;
  try {
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
      if (request.method() !== 'GET') { mutations.push(request.url()); return route.abort(); }
      if (url.pathname === '/api/tasks/' + task.id) {
        polls++;
        return route.fulfill({json: {task: polledTask}});
      }
      return route.continue();
    });
    await context.addInitScript(({origin, key, project}) => {
      if (window.top !== window || location.origin !== origin || localStorage.getItem(key)) return;
      localStorage.setItem(key, JSON.stringify({schemaVersion: 1, activeProjectId: project.id, projects: [project],
        page: 'create', settings: {autoSave: false, reduceMotion: true}}));
    }, {origin, key: storageKey, project: runningProject});
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.goto(origin);
    const entry = page.getByRole('button', {name: '修改书名', exact: true});
    await entry.waitFor();
    // The changed timestamp proves the task was hydrated, polled and accepted by the app.
    await page.waitForFunction(({key, id, updatedAt}) =>
      JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.runtime?.task?.updatedAt === updatedAt,
      {key: storageKey, id: projectId, updatedAt: polledTask.updatedAt});
    const stored = await readProject(page);
    assert.ok(polls > 0, 'the app polled the synthetic running task');
    assert.equal(stored.runtime.task.id, task.id);
    assert.equal(stored.runtime.task.status, 'running');
    assert.equal(stored.runtime.request.requestId, task.requestId);
    assert.equal(stored.runtime.connectionError, undefined);
    assert.equal(stored.status, 'writing');
    assert.deepEqual(stored.chapters, chapters);
    assert.deepEqual(stored.pendingEdits, project.pendingEdits);
    assert.equal(await entry.isDisabled(), true, 'a successfully hydrated running task disables renaming');
    await page.clock.runFor(2000);
    assert.equal((await readProject(page)).runtime.task.status, 'running');
    assert.equal(await entry.isDisabled(), true);
    assert.equal(await page.getByRole('region', {name: '修改作品书名', exact: true}).count(), 0);
    assert.equal((await readProject(page)).title, project.title);
    assert.deepEqual((await readProject(page)).versions, [oldVersion]);
  } finally {
    await context.close();
  }
}

const runsDir = await mkdtemp(path.join(tmpdir(), 'talewick-project-title-'));
let runtime, browser;
try {
  const socket = createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const {port} = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  runtime = await createRuntime({config: {port, runsDir, apiKey: '', model: 'offline', baseURL: 'https://example.invalid/v1', timeoutMs: 1000}});
  await new Promise((resolve, reject) => runtime.server.once('error', reject).listen(port, '127.0.0.1', resolve));
  const playwright = process.env.TALEWICK_PLAYWRIGHT_MODULE
    ? await import(pathToFileURL(path.resolve(process.env.TALEWICK_PLAYWRIGHT_MODULE))) : await import('playwright');
  browser = await playwright.chromium.launch({headless: true, executablePath: process.env.TALEWICK_BROWSER_EXECUTABLE || undefined});
  const context = await browser.newContext({viewport: {width: 1512, height: 982}, reducedMotion: 'reduce'});
  const external = [], errors = [], mutations = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) {
      if (route.request().method() === 'GET') return route.continue();
      mutations.push(route.request().url());
      return route.abort();
    }
    external.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(({origin, storageKey, project}) => {
    if (window.top !== window || location.origin !== origin || localStorage.getItem(storageKey)) return;
    localStorage.setItem(storageKey, JSON.stringify({schemaVersion: 1, activeProjectId: project.id, projects: [project],
      page: 'create', settings: {autoSave: false, reduceMotion: true}}));
  }, {origin, storageKey, project});
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.goto(origin);
  await exercise(page);
  await exerciseRunning(browser, origin, external, errors, mutations);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(mutations, [], 'renaming requires no model or mutation API calls');
  console.log('PASS project title: cancel, invalid names, trimming, exact snapshots, reload, rollback, unsaved draft and active task');
} finally {
  await browser?.close();
  if (runtime) {
    await runtime.close();
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
  }
  await rm(runsDir, {recursive: true, force: true});
}
