/** From the GUI directory: npm run build && node scripts/version-search-browser.mjs.
 * Uses the same Playwright/Chrome environment variables as history-project-switch-browser.mjs.
 */
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRuntime} from '../server/index.mjs';

const storageKey = 'talewick.boardui.gui.v1';
const date = '2026-01-01T00:00:00.000Z';
const projectId = 'synthetic-version-search';
const oldest = {id: 'oldest', label: '合成初稿', title: '渡口札记', date, chapters: [
  {id: 'pier', title: '晨间渡口', body: '纸船在清晨靠岸。\n船篷落着一片叶子。'},
  {id: 'tower', title: '红砖钟楼', body: '钟楼响了三声，广场上的鸽子飞了起来。'},
]};
const bodyQuery = '蓝色玻璃风铃';
const matching = {id: 'matching', label: '合成修订稿', title: '桥边书信', date, chapters: [
  {id: 'letter', title: '第一封信', body: '信纸摊在桌面上。\n\n这一章没有查找词，但也必须完整导出。🌕'},
  {id: 'window', title: '雨后的窗台', body: '雨停后，屋檐仍在滴水。'.repeat(45)
    + '\n她推开窗，看见蓝色玻璃风铃挂在窗外，铃舌轻轻碰响。\n'
    + '远处的孩子走过石桥。'.repeat(35)},
]};
const newest = {id: 'newest', label: '合成终稿', title: '山中来客', date, chapters: [
  {id: 'hill', title: '山坡上的路', body: '山坡上立着一只纸风车。'},
  {id: 'gate', title: '木门前', body: '她在门前放下一篮红色苹果。'},
]};
const project = {id: projectId, title: '当前稿专属书名', phase: 'complete', status: 'ready',
  docOpen: true, docMode: 'read', selectedChapter: 0,
  chapters: [{id: 'current', title: '当前章', body: '当前正文专属标记，不能进入旧稿导出。'}],
  versions: [oldest, matching, newest],
  messages: [{role: 'assistant', text: '合成挂载同步标记', turnId: 'synthetic-missing-turn', turnStatus: 'running'}],
  pendingEdits: [{id: 'pending', chapterId: 'current', start: 0, before: '当前正文',
    after: '合成待审替换标记', reason: '合成待审原因', status: 'pending'}]};

async function readProject(page) {
  return page.evaluate(({key, id}) => JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id),
    {key: storageKey, id: projectId});
}

async function exercise(page, downloadDir) {
  const dialog = page.getByRole('dialog');
  const list = dialog.getByRole('region', {name: '选择历史版本', exact: true});
  const rows = list.locator('button[aria-pressed]');
  const search = list.getByRole('textbox', {name: '查找存稿', exact: true});
  const rowFor = version => rows.filter({has: page.getByText(version.label, {exact: true})});
  const downloads = [];
  page.on('download', download => downloads.push(download));
  const assertRows = async versions => {
    await page.waitForFunction(count =>
      document.querySelectorAll('[role="dialog"] [aria-label="选择历史版本"] button[aria-pressed]').length === count,
      versions.length);
    assert.equal(await rows.count(), versions.length);
    for (const [index, version] of versions.entries()) {
      const row = rows.nth(index);
      await row.getByText(version.label, {exact: true}).waitFor();
      const number = project.versions.findIndex(item => item.id === version.id) + 1;
      await row.getByText('存稿 ' + number, {exact: true}).waitFor();
    }
  };
  const checkPreview = async version => {
    await dialog.getByRole('heading', {name: version.label, level: 3, exact: true}).waitFor();
    await dialog.getByRole('heading', {name: version.title, level: 3, exact: true}).waitFor();
    for (const chapter of version.chapters) {
      await dialog.getByRole('heading', {name: chapter.title, level: 4, exact: true}).waitFor();
      const body = dialog.getByText(chapter.body, {exact: true});
      await body.waitFor();
      assert.equal(await body.textContent(), chapter.body);
    }
  };
  const checkHidden = async version => {
    await list.getByRole('status').filter({hasText: '预览仍为所选存稿「' + version.label + '」'}).waitFor();
    await list.getByRole('button', {name: '显示所选存稿', exact: true}).waitFor();
    assert.equal(await rowFor(version).count(), 0);
    await checkPreview(version);
  };
  const clearSearch = async buttonName => {
    await list.getByRole('button', {name: buttonName, exact: true}).click();
    assert.equal(await search.inputValue(), '');
    await assertRows([newest, matching, oldest]);
    assert.equal(await list.getByRole('button', {name: '显示所选存稿', exact: true}).count(), 0);
  };

  await page.getByTestId('manuscript-prose').filter({visible: true}).waitFor();
  await page.waitForFunction(({key, id}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.messages[0]?.turnStatus === 'interrupted',
    {key: storageKey, id: projectId});
  const baseline = await readProject(page);
  assert.deepEqual(baseline.versions, project.versions);
  assert.deepEqual(baseline.pendingEdits, project.pendingEdits);
  const unchanged = async () => {
    await page.clock.runFor(500);
    assert.deepEqual(await readProject(page), baseline, 'search, selection and export preserve the complete persisted project');
  };
  await page.getByRole('button', {name: '版本记录', exact: true}).click();
  await assertRows([newest, matching, oldest]);
  await checkPreview(newest);
  await rowFor(oldest).click();
  await checkPreview(oldest);
  assert.equal(await rowFor(oldest).getAttribute('aria-pressed'), 'true');

  await search.fill(bodyQuery);
  await assertRows([matching]);
  const bodyHit = await rowFor(matching).innerText();
  assert.ok(bodyHit.includes(matching.chapters[1].title), 'body result identifies the matching later chapter');
  assert.ok(bodyHit.includes(bodyQuery), 'result snippet contains the actual body match');
  assert.equal(bodyHit.includes(matching.chapters[0].body), false, 'result snippet is from the matching chapter');
  assert.equal(bodyHit.includes(matching.chapters[1].body), false, 'result uses a snippet instead of the full long chapter');
  assert.equal(await rowFor(matching).getAttribute('aria-pressed'), 'false', 'filtering must not select the matching version');
  await checkHidden(oldest);
  await unchanged();
  await clearSearch('清除查找');
  assert.equal(await rowFor(oldest).getAttribute('aria-pressed'), 'true');
  await checkPreview(oldest);

  // A different later-chapter title must also match, while retaining the previous selection.
  await search.fill(newest.chapters[1].title);
  await assertRows([newest]);
  assert.ok((await rowFor(newest).innerText()).includes(newest.chapters[1].title));
  await checkHidden(oldest);
  await clearSearch('显示所选存稿');
  assert.equal(await rowFor(oldest).getAttribute('aria-pressed'), 'true');
  await checkPreview(oldest);

  await search.fill('合成不存在的词XYZ');
  await assertRows([]);
  await list.getByRole('status').filter({hasText: '没有找到匹配的存稿'}).waitFor();
  await checkHidden(oldest);
  await unchanged();
  await clearSearch('清除查找');
  await checkPreview(oldest);

  // Existing label and book-title queries retain the original list numbers.
  await search.fill(matching.label);
  await assertRows([matching]);
  await checkHidden(oldest);
  await search.fill(newest.title);
  await assertRows([newest]);
  await checkHidden(oldest);
  await search.fill('  ' + bodyQuery + '  ');
  await assertRows([matching]);
  await rowFor(matching).click();
  await checkPreview(matching);
  assert.equal(await rowFor(matching).getAttribute('aria-pressed'), 'true');
  assert.equal(await list.getByRole('button', {name: '显示所选存稿', exact: true}).count(), 0);
  await unchanged();

  await dialog.getByRole('button', {name: '导出所选存稿', exact: true}).click();
  const exportPreview = dialog.getByRole('region', {name: '导出所选存稿', exact: true});
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportPreview.getByRole('button', {name: '下载 TXT', exact: true}).click(),
  ]);
  const file = path.join(downloadDir, 'searched-snapshot.txt');
  await download.saveAs(file);
  assert.equal(await download.failure(), null);
  assert.equal(path.extname(download.suggestedFilename()), '.txt');
  const expected = matching.title + '\n\n' + matching.chapters
    .map(chapter => chapter.title + '\n\n' + chapter.body).join('\n\n---\n\n');
  assert.deepEqual(await readFile(file), Buffer.from(expected, 'utf8'),
    'download contains the complete selected historical manuscript, including the nonmatching first chapter');
  await unchanged();
  assert.equal(downloads.length, 1);
  await exportPreview.getByRole('button', {name: '返回存稿', exact: true}).click();
  await checkPreview(matching);
  await dialog.getByRole('button', {name: '关闭窗口', exact: true}).click();
  await dialog.waitFor({state: 'hidden'});
  assert.equal(await page.getByTestId('manuscript-prose').filter({visible: true}).textContent(), project.chapters[0].body);
  await page.reload();
  await page.getByTestId('manuscript-prose').filter({visible: true}).waitFor();
  await unchanged();
  await page.getByRole('button', {name: '版本记录', exact: true}).click();
  assert.equal(await search.inputValue(), '');
  await assertRows([newest, matching, oldest]);
  await unchanged();
}

const runsDir = await mkdtemp(path.join(tmpdir(), 'talewick-version-search-'));
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
  const context = await browser.newContext({viewport: {width: 1512, height: 982}, reducedMotion: 'reduce', acceptDownloads: true});
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
  await exercise(page, runsDir);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(mutations, [], 'local version search and export need no model or mutation API calls');
  console.log('PASS version search: later-chapter text, chapter titles, stable numbering, retained selection, reset, full TXT download and read-only persisted project');
} finally {
  await browser?.close();
  if (runtime) {
    await runtime.close();
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
  }
  await rm(runsDir, {recursive: true, force: true});
}
