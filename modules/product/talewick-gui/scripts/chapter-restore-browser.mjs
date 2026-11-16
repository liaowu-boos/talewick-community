/** From the GUI directory: npm run build && node scripts/chapter-restore-browser.mjs.
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
const current = {id: 'pier', title: '新渡口', body: '纸旗落在石阶上。\n小船驶向东岸。'};
const saved = {...current, title: '旧渡口', body: '灯影映在水面上。\n\n小船停在西岸。🌕'};
const other = {id: 'clock', title: '钟亭', body: '钟亭响了两声。'};
const moved = {id: 'bridge', title: '木桥', body: '木桥下游过一条鱼。'};
const added = {id: 'hill', title: '山坡', body: '坡上立着一只纸风车。'};
const removed = {id: 'bay', title: '浅湾', body: '湾中浮着半片叶子。'};
const source = {id: 'source', label: '渡口初稿', title: '岸边手记', date: '2026-01-01T00:00:00.000Z',
  chapters: [moved, saved, {...other, body: '钟亭响了三声。'}, removed]};
const alternate = {...source, id: 'alternate', label: '渡口校稿', chapters: [moved, {...saved, body: '渡口无人。'}, other, removed]};
const project = {id: 'synthetic-chapter-restore', title: '河岸值班簿', phase: 'done', status: 'ready',
  messages: [{role: 'assistant', text: '合成值班记录', turnId: 'synthetic-missing-turn', turnStatus: 'running'}],
  docMode: 'read', docOpen: true, selectedChapter: 0, chapters: [current, other, moved, added], versions: [source, alternate],
  pendingEdits: [
    {id: 'pier-edit', chapterId: current.id, start: 0, before: '纸旗', after: '布旗', reason: '合成章内建议', status: 'pending'},
    {id: 'clock-edit', chapterId: other.id, start: 0, before: '钟亭', after: '木亭', reason: '合成跨章建议', status: 'pending'},
    {id: 'bridge-edit', chapterId: moved.id, start: 0, before: '旧桥', after: '木桥', reason: '合成历史建议', status: 'accepted'},
  ]};
const restoredChapters = [saved, other, moved, added];

async function readProject(page) {
  return page.evaluate(({key, id}) => JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id),
    {key: storageKey, id: project.id});
}

function checkManuscript(stored, expectedChapters) {
  assert.equal(stored.title, project.title, 'manuscript title');
  assert.deepEqual(stored.chapters, expectedChapters, 'chapter order, IDs, titles and full text');
  assert.deepEqual(stored.pendingEdits, project.pendingEdits, 'all suggestions and their status');
}

function checkSnapshots(versions) {
  assert.equal(versions.length, project.versions.length + 2);
  assert.equal(new Set(versions.map(version => version.id)).size, versions.length, 'unique snapshot IDs');
  const oldIds = new Set(project.versions.map(version => version.id));
  assert.deepEqual(versions.filter(version => oldIds.has(version.id)), project.versions, 'saved versions');
  const fresh = versions.filter(version => !oldIds.has(version.id));
  for (const chapters of [project.chapters, restoredChapters]) {
    const snapshot = fresh.find(version => version.chapters.find(chapter => chapter.id === current.id)?.body === chapters[0].body);
    assert.ok(snapshot?.id, 'snapshot of the complete manuscript on each side of the restore');
    assert.equal(snapshot.title, project.title);
    assert.deepEqual(snapshot.chapters, chapters);
  }
}

async function exercise(page) {
  const dialog = page.getByRole('dialog');
  const preview = dialog.getByRole('region', {name: '单章恢复预览', exact: true});
  const compare = dialog.getByRole('region', {name: /版本比较/});
  const chapterRow = title => compare.locator('section').filter({has: page.getByRole('heading', {name: title, level: 4, exact: true})});
  const restore = {name: '恢复本章', exact: true};
  const prose = page.getByTestId('manuscript-prose').filter({visible: true});
  const verifyWorkbench = async chapter => {
    await dialog.waitFor({state: 'hidden'});
    await page.getByRole('heading', {level: 3, name: chapter.title, exact: true}).waitFor();
    assert.equal(await prose.textContent(), chapter.body);
  };

  await verifyWorkbench(current);
  await page.getByRole('button', {name: '版本记录', exact: true}).click();
  await dialog.getByRole('button').filter({hasText: source.label}).click();
  await dialog.getByRole('button', {name: '对比版本', exact: true}).click();
  const target = dialog.getByRole('combobox', {name: '对比目标'});
  assert.equal(await target.inputValue(), 'current');
  const option = target.getByRole('option', {name: new RegExp(alternate.label)});
  await target.selectOption({label: await option.evaluate(item => item.label)});
  await chapterRow(saved.title).waitFor();
  assert.equal(await dialog.getByRole('button', restore).count(), 0, 'saved-to-saved comparison');
  await target.selectOption('current');
  for (const chapter of [moved, added, removed]) {
    const row = chapterRow(chapter.title);
    await row.waitFor();
    assert.equal(await row.getByRole('button', restore).count(), 0, chapter.title);
  }

  const button = chapterRow(current.title).getByRole('button', restore);
  // Mount reconciles local turns with the empty service and persists the result.
  // Use that write as a readiness signal before measuring preview/cancellation.
  await page.waitForFunction(({key, id, turnId}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)
      ?.messages.find(message => message.turnId === turnId)?.turnStatus === 'interrupted',
    {key: storageKey, id: project.id, turnId: project.messages[0].turnId});
  const initial = await readProject(page);
  checkManuscript(initial, project.chapters);
  assert.deepEqual(initial.versions, project.versions);
  // Count even identical writes during preview and cancellation.
  await page.evaluate(key => {
    window.projectStorageWrites = 0;
    for (const method of ['setItem', 'removeItem', 'clear']) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (...args) {
        if (this === localStorage && (method === 'clear' || args[0] === key)) window.projectStorageWrites++;
        return original.apply(this, args);
      };
    }
  }, storageKey);
  await button.click();
  await preview.getByRole('button', {name: '取消恢复', exact: true}).click();
  await preview.waitFor({state: 'hidden'});
  await button.waitFor();
  await page.clock.runFor(500);
  assert.equal(await page.evaluate(() => window.projectStorageWrites), 0, 'cancellation must not write project storage');
  assert.deepEqual(await readProject(page), initial);

  await button.click();
  await preview.getByRole('button', {name: '确认恢复本章', exact: true}).click();
  await verifyWorkbench(saved);
  await page.waitForFunction(({key, id, count}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.versions.length === count,
    {key: storageKey, id: project.id, count: initial.versions.length + 2});
  const committed = await readProject(page);
  checkManuscript(committed, restoredChapters);
  checkSnapshots(committed.versions);

  await page.reload();
  await verifyWorkbench(saved);
  const reloaded = await readProject(page);
  checkManuscript(reloaded, restoredChapters);
  assert.deepEqual(reloaded.versions, committed.versions, 'snapshot IDs and payloads survive reload');

  // Undo through the same single-chapter action using the pre-restore snapshot.
  const backup = committed.versions.at(-2);
  await page.getByRole('button', {name: '版本记录', exact: true}).click();
  await dialog.getByRole('button').filter({hasText: backup.label}).click();
  await dialog.getByRole('button', {name: '对比版本', exact: true}).click();
  await chapterRow(saved.title).getByRole('button', restore).click();
  await preview.getByRole('button', {name: '确认恢复本章', exact: true}).click();
  await verifyWorkbench(current);
  await page.waitForFunction(({key, id, count}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.versions.length === count,
    {key: storageKey, id: project.id, count: committed.versions.length + 2});
  const reverted = await readProject(page);
  checkManuscript(reverted, project.chapters);
  assert.deepEqual(reverted.versions.slice(0, -2), committed.versions);
  assert.deepEqual(reverted.versions.at(-2).chapters, restoredChapters);
  assert.deepEqual(reverted.versions.at(-1).chapters, project.chapters);
}

const runsDir = await mkdtemp(path.join(tmpdir(), 'talewick-chapter-restore-'));
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
  console.log('PASS chapter restore eligibility, cancellation without writes, selected chapter only, both snapshots, reload and rollback');
} finally {
  await browser?.close();
  if (runtime) {
    await runtime.close();
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
  }
  await rm(runsDir, {recursive: true, force: true});
}
