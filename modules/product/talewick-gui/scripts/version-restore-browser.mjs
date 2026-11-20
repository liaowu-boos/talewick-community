/** From the GUI directory: npm run build && node scripts/version-restore-browser.mjs.
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
const pier = {id: 'pier', title: '新渡口', body: '纸旗落在石阶上。\n小船驶向东岸。'};
const bridge = {id: 'bridge', title: '木桥', body: '木桥下游过一条鱼。'};
const hill = {id: 'hill', title: '山坡', body: '坡上立着一只纸风车。'};
const bay = {id: 'bay', title: '浅湾', body: '湾中浮着半片叶子。'};
const source = {id: 'synthetic-source', label: '渡口初稿', title: '岸边手记', date: '2026-01-01T00:00:00.000Z',
  chapters: [bridge, {...pier, title: '旧渡口', body: '灯影映在水面上。\n\n小船停在西岸。🌕'}, bay]};
const alternate = {id: 'synthetic-alternate', label: '山间校稿', title: '山间来信', date: '2026-01-02T00:00:00.000Z',
  chapters: [{id: 'desk', title: '窗边', body: '风筝升空'}]};
const project = {id: 'synthetic-version-restore', title: '河岸值班簿', phase: 'done', status: 'ready',
  messages: [{role: 'assistant', text: '合成挂载同步标记', turnId: 'synthetic-missing-turn', turnStatus: 'running'}],
  docMode: 'read', docOpen: true, selectedChapter: 0, chapters: [pier, bridge, hill],
  editorBaseline: [pier, bridge, hill], versions: [source, alternate],
  pendingEdits: [
    {id: 'pier-edit', chapterId: pier.id, start: 0, before: '纸旗', after: '布旗', reason: '合成章内建议', status: 'pending'},
    {id: 'hill-edit', chapterId: hill.id, start: 0, before: '坡上', after: '山坡上', reason: '合成新增章建议', status: 'pending'},
    {id: 'bridge-edit', chapterId: bridge.id, start: 0, before: '旧桥', after: '木桥', reason: '合成历史建议', status: 'accepted'},
  ]};

async function readProject(page) {
  return page.evaluate(({key, id}) => JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id),
    {key: storageKey, id: project.id});
}

function checkSnapshot(snapshot, manuscript) {
  assert.ok(snapshot.id, 'snapshot has an ID');
  assert.ok(Number.isFinite(Date.parse(snapshot.date)), 'snapshot has a valid date');
  assert.equal(snapshot.title, manuscript.title, 'snapshot book title');
  assert.deepEqual(snapshot.chapters, manuscript.chapters, 'snapshot chapter IDs, order, names and complete text');
}

function checkRestored(stored, before, selected) {
  assert.equal(stored.title, selected.title);
  assert.deepEqual(stored.chapters, selected.chapters);
  assert.deepEqual(stored.pendingEdits, [], 'whole-version restore clears all edits');
  assert.equal(stored.editorBaseline, null);
  assert.equal(stored.docMode, 'read');
  assert.equal(stored.selectedChapter, 0);
  assert.equal(stored.versions.length, before.versions.length + 2, 'exactly two new snapshots');
  assert.deepEqual(stored.versions.slice(0, -2), before.versions, 'all source snapshots retain identity and payload');
  assert.equal(new Set(stored.versions.map(version => version.id)).size, stored.versions.length);
  checkSnapshot(stored.versions.at(-2), before);
  checkSnapshot(stored.versions.at(-1), selected);
}

async function exercise(page) {
  const dialog = page.getByRole('dialog');
  const preview = dialog.getByRole('region', {name: '整稿恢复预览', exact: true});
  const rows = dialog.locator('[aria-label="选择历史版本"] button[aria-pressed]');
  const confirm = preview.getByRole('button', {name: '确认恢复整稿', exact: true});
  const restore = dialog.getByRole('button', {name: '恢复此版本', exact: true});
  const openVersion = async version => {
    await page.getByRole('button', {name: '版本记录', exact: true}).click();
    await rows.filter({has: page.getByText(version.label, {exact: true})}).click();
    await dialog.getByRole('heading', {name: version.title, exact: true}).waitFor();
    await dialog.getByText(version.chapters[0].body, {exact: true}).waitFor();
  };
  const checkWorkbench = async manuscript => {
    await dialog.waitFor({state: 'hidden'});
    await page.getByRole('heading', {name: manuscript.chapters[0].title, level: 3, exact: true}).waitFor();
    assert.equal(await page.getByTestId('manuscript-prose').filter({visible: true}).textContent(), manuscript.chapters[0].body);
  };
  const confirmRestore = async (before, selected) => {
    await confirm.click();
    await checkWorkbench(selected);
    await page.waitForFunction(({key, id, count}) =>
      JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.versions.length === count,
      {key: storageKey, id: project.id, count: before.versions.length + 2});
    const committed = await readProject(page);
    checkRestored(committed, before, selected);
    return committed;
  };

  await checkWorkbench(project);
  // Wait for the mount-time reconciliation write before measuring cancellation.
  await page.waitForFunction(({key, id, turnId}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)
      ?.messages.find(message => message.turnId === turnId)?.turnStatus === 'interrupted',
    {key: storageKey, id: project.id, turnId: project.messages[0].turnId});
  const initial = await readProject(page);
  assert.equal(initial.title, project.title);
  assert.deepEqual(initial.chapters, project.chapters);
  assert.deepEqual(initial.pendingEdits, project.pendingEdits);
  assert.deepEqual(initial.versions, project.versions);

  await openVersion(source);
  await restore.click();
  await preview.waitFor();
  await preview.getByText('已有修改建议及处理记录共 3 条将清除。恢复后进入阅读模式。', {exact: true}).waitFor();
  assert.ok((await preview.locator('del').allTextContents()).includes(project.title));
  assert.ok((await preview.locator('ins').allTextContents()).includes(source.title));
  for (const title of [bridge.title, source.chapters[1].title, bay.title, hill.title]) {
    await preview.getByRole('heading', {name: title, level: 4, exact: true}).waitFor();
  }
  const previewBodies = await preview.getByRole('region', {name: /正文$/}).locator('p').allTextContents();
  assert.ok(previewBodies.includes(pier.body), 'preview shows the current complete chapter text');
  assert.ok(previewBodies.includes(source.chapters[1].body), 'preview shows the source complete chapter text');
  await page.clock.runFor(500);
  assert.deepEqual(await readProject(page), initial, 'opening a preview preserves the entire project');
  await preview.getByRole('button', {name: '取消恢复', exact: true}).click();
  await preview.waitFor({state: 'hidden'});
  await restore.waitFor();
  await page.clock.runFor(500);
  assert.deepEqual(await readProject(page), initial, 'cancel preserves manuscript, suggestions and version history');

  await restore.click();
  const committed = await confirmRestore(initial, source);
  await page.reload();
  await checkWorkbench(source);
  const reloaded = await readProject(page);
  checkRestored(reloaded, initial, source);
  assert.deepEqual(reloaded.versions, committed.versions, 'snapshot IDs, dates and contents survive reload');

  const backup = committed.versions.at(-2);
  await openVersion(backup);
  await restore.click();
  const reverted = await confirmRestore(reloaded, backup);
  assert.equal(reverted.title, initial.title);
  assert.deepEqual(reverted.chapters, initial.chapters, 'restore backup returns the original order, names and bodies');
  await page.reload();
  await checkWorkbench(project);
  const rollbackReloaded = await readProject(page);
  checkRestored(rollbackReloaded, reloaded, backup);
  assert.deepEqual(rollbackReloaded.versions, reverted.versions);

  // Comparing a different saved target must still restore the selected source.
  await openVersion(source);
  await dialog.getByRole('button', {name: '对比版本', exact: true}).click();
  const target = dialog.getByRole('combobox', {name: '对比目标', exact: true});
  await target.selectOption(`saved:${alternate.id}`);
  const comparison = dialog.getByRole('region', {name: /版本比较/});
  assert.ok((await comparison.locator('ins').allTextContents()).includes(alternate.chapters[0].body),
    'the selected comparison target is actually displayed');
  await dialog.getByRole('button', {name: `恢复来源版本「${source.label}」`, exact: true}).click();
  await preview.waitFor();
  assert.deepEqual(await readProject(page), rollbackReloaded);
  const restoredSource = await confirmRestore(rollbackReloaded, source);
  assert.notEqual(restoredSource.title, alternate.title);
  assert.deepEqual(restoredSource.chapters, source.chapters, 'comparison target never substitutes for restore source');
  await page.reload();
  await checkWorkbench(source);
  checkRestored(await readProject(page), rollbackReloaded, source);
}

const runsDir = await mkdtemp(path.join(tmpdir(), 'talewick-version-restore-'));
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
  const external = [], errors = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
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
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('PASS whole-version restore preview, cancellation, exact source manuscript, backup snapshots, cleared edits, reload, rollback and comparison-source identity');
} finally {
  await browser?.close();
  if (runtime) {
    await runtime.close();
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
  }
  await rm(runsDir, {recursive: true, force: true});
}
