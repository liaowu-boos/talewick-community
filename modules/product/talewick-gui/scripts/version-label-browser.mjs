/** From the GUI directory: npm run build && node scripts/version-label-browser.mjs.
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
const source = {id: 'synthetic-source', label: '自动保存', title: '河岸手记',
  date: '2026-01-02T00:00:00.000Z', chapters: [{id: 'desk', title: '窗边', body: '纸船靠岸'}]};
const alternate = {id: 'synthetic-alternate', label: source.label, title: '山间来信',
  date: '2026-01-01T00:00:00.000Z', chapters: [{id: 'desk', title: '窗边', body: '风筝升空'}]};
const newLabel = '渡口定稿 🌕';
const project = {id: 'synthetic-version-label', title: '银杏值班簿', phase: 'done', status: 'ready',
  updatedAt: '2026-01-03T00:00:00.000Z', docMode: 'read', docOpen: true, selectedChapter: 0,
  messages: [{role: 'assistant', text: '合成对话同步标记', turnId: 'synthetic-missing-turn', turnStatus: 'running'}],
  chapters: [{id: 'desk', title: '窗边', body: '铜铃轻响'}, {id: 'garden', title: '庭院', body: '树影落在窗沿。'}],
  versions: [alternate, source],
  pendingEdits: [{id: 'synthetic-edit', chapterId: 'desk', start: 0,
    before: '铜铃', after: '银铃', reason: '合成建议', status: 'pending'}]};

async function readProject(page) {
  return page.evaluate(({key, id}) => JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id),
    {key: storageKey, id: project.id});
}

function checkRename(stored, baseline) {
  const expected = structuredClone(baseline);
  expected.versions.find(version => version.id === source.id).label = newLabel;
  assert.notEqual(stored.updatedAt, baseline.updatedAt, 'rename updates project timestamp');
  assert.ok(Number.isFinite(Date.parse(stored.updatedAt)));
  expected.updatedAt = stored.updatedAt;
  assert.deepEqual(stored, expected, 'only selected version label and project updatedAt change');
}

async function exercise(page) {
  const dialog = page.getByRole('dialog');
  const rows = dialog.locator('[aria-label="选择历史版本"] button[aria-pressed]');
  const search = dialog.getByLabel('查找存稿', {exact: true});
  const name = dialog.getByRole('textbox', {name: '存稿名称', exact: true});
  const rename = dialog.getByRole('button', {name: '命名存稿', exact: true});
  const save = dialog.getByRole('button', {name: '保存名称', exact: true});
  const cancel = dialog.getByRole('button', {name: '取消命名', exact: true});
  const openHistory = () => page.getByRole('button', {name: '版本记录', exact: true}).click();
  const checkPreview = async version => {
    await dialog.getByRole('heading', {name: version.title, exact: true}).waitFor();
    await dialog.getByText(version.chapters[0].body, {exact: true}).waitFor();
  };
  const checkRows = async labels => {
    await page.waitForFunction(count =>
      document.querySelectorAll('[role="dialog"] [aria-label="选择历史版本"] button[aria-pressed]').length === count,
      labels.length);
    assert.equal(await rows.count(), labels.length);
    for (const [index, label] of labels.entries()) {
      assert.equal(await rows.nth(index).getByText(label, {exact: true}).count(), 1);
    }
  };

  await page.getByTestId('manuscript-prose').filter({visible: true}).waitFor();
  // Wait for mount-time conversation reconciliation to be persisted.
  await page.waitForFunction(({key, id, turnId}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)
      ?.messages.find(message => message.turnId === turnId)?.turnStatus === 'interrupted',
    {key: storageKey, id: project.id, turnId: project.messages[0].turnId});
  const baseline = await readProject(page);
  assert.deepEqual(baseline.versions, project.versions);
  await openHistory();
  await checkRows([source.label, alternate.label]);
  // The history list is newest-first. Check each full-text preview before naming.
  await rows.nth(1).click();
  await checkPreview(alternate);
  await rows.nth(0).click();
  await checkPreview(source);

  await rename.click();
  assert.equal(await name.inputValue(), source.label);
  await name.fill('应当取消的合成名称');
  await cancel.click();
  await name.waitFor({state: 'hidden'});
  await page.clock.runFor(500);
  assert.deepEqual(await readProject(page), baseline, 'cancel leaves project and snapshots untouched');
  await checkPreview(source);

  await rename.click();
  for (const blank of ['', '   ']) {
    await name.fill(blank);
    // Both disabled-save and inline-validation implementations must preserve state.
    if (await save.isEnabled()) await save.click();
    await name.waitFor();
    await page.clock.runFor(500);
    assert.deepEqual(await readProject(page), baseline, 'blank name must not change persisted state');
  }
  await cancel.click();
  await name.waitFor({state: 'hidden'});
  await rename.click();
  await search.fill(source.label);
  await name.fill(newLabel);
  await save.click();
  await name.waitFor({state: 'hidden'});
  await page.waitForFunction(({key, id, versionId, label}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)
      ?.versions.find(version => version.id === versionId)?.label === label,
    {key: storageKey, id: project.id, versionId: source.id, label: newLabel});
  const renamed = await readProject(page);
  checkRename(renamed, baseline);
  await checkRows([alternate.label]);
  await checkPreview(source);
  await dialog.getByRole('button', {name: '显示所选存稿', exact: true}).click();
  await checkRows([newLabel, alternate.label]);
  await checkPreview(source);

  await page.reload();
  await openHistory();
  await checkRows([newLabel, alternate.label]);
  await rows.nth(0).click();
  await checkPreview(source);
  checkRename(await readProject(page), baseline);
  assert.deepEqual((await readProject(page)).versions, renamed.versions, 'IDs, dates and bodies survive reload');

  await search.fill('渡口定稿');
  await checkRows([newLabel]);
  await checkPreview(source);
  await search.fill(alternate.title);
  await checkRows([alternate.label]);
  await checkPreview(source);
  await search.fill('合成不存在的存稿XYZ');
  await checkRows([]);
  await checkPreview(source);
  await dialog.getByRole('button', {name: '清除查找', exact: true}).click();
  assert.equal(await search.inputValue(), '');
  await checkRows([newLabel, alternate.label]);
  await checkPreview(source);

  await dialog.getByRole('button', {name: '对比版本', exact: true}).click();
  const target = dialog.getByRole('combobox', {name: '对比目标', exact: true});
  const option = target.getByRole('option', {name: new RegExp(alternate.label)});
  await target.selectOption({label: await option.evaluate(element => element.label)});
  const comparison = dialog.getByRole('region', {name: /版本比较/});
  assert.ok((await comparison.locator('del').allTextContents()).includes(source.chapters[0].body));
  assert.ok((await comparison.locator('ins').allTextContents()).includes(alternate.chapters[0].body));
  await dialog.getByRole('button', {name: '查看全文', exact: true}).click();
  await checkPreview(source);
  await page.keyboard.press('Escape');
  await dialog.waitFor({state: 'hidden'});
  assert.equal(await page.getByTestId('manuscript-prose').filter({visible: true}).textContent(), project.chapters[0].body);
  await page.clock.runFor(500);
  assert.deepEqual(await readProject(page), renamed, 'search and comparison preserve stored project');
}

const runsDir = await mkdtemp(path.join(tmpdir(), 'talewick-version-label-'));
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
  console.log('PASS version naming cancellation, blank rejection, snapshot identity, reload, name/title search, retained preview and saved-version comparison');
} finally {
  await browser?.close();
  if (runtime) {
    await runtime.close();
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
  }
  await rm(runsDir, {recursive: true, force: true});
}
