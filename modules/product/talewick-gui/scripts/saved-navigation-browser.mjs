/** From the GUI directory: npm run build && node scripts/saved-navigation-browser.mjs.
 * Uses the same Playwright/Chrome environment variables as history-project-switch-browser.mjs.
 */
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRuntime} from '../server/index.mjs';
import {productManuscriptRevision} from '../server/full15-service.mjs';

const storageKey = 'talewick.boardui.gui.v1';
const date = '2026-01-01T00:00:00.000Z';
const projectId = 'synthetic-saved-navigation';
const versionA = {id: 'version-a', label: '合成旧稿甲', title: '桥边旧事', date, chapters: [
  {id: 'shared-first', title: '甲稿的渡口', body: '纸船靠岸。甲稿开篇保留完整。\n\n' + '渡口的石阶映着灯光。'.repeat(130)},
  {id: 'shared-second', title: '甲稿的木桥', body: '甲稿第二章的独有正文。\n' + '木桥下的水声一直没有停。'.repeat(180)},
  {id: 'shared-last', title: '甲稿的钟楼', body: '甲稿末章以清晨钟声结尾。🌕\n\n' + '广场上的鸽子慢慢飞起。'.repeat(90)},
]};
const versionB = {id: 'version-b', label: '合成旧稿乙', title: '山中来信', date, chapters: [
  {id: 'shared-first', title: '乙稿的山坡', body: '乙稿第一章写山坡上的风车。\n' + '树林中的风吹过纸页。'.repeat(100)},
  {id: 'shared-second', title: '乙稿的木屋', body: '乙稿第二章写木屋里的来信。\n\n' + '信纸上的墨迹渐渐干了。'.repeat(150)},
  {id: 'shared-last', title: '乙稿的归途', body: '乙稿末章写她沿着小径回家。🌒\n' + '路旁的树影落在鞋面上。'.repeat(75)},
]};
const versionC = {id: 'version-c', label: '合成存稿丙', title: '院中记录', date,
  chapters: [
    {id: 'garden', title: '同名章节', body: '院中的红色纸鸢挂在树上。'},
    {id: 'garden-2', title: '同名章节', body: '重复章名仍应定位第二章。'},
    {id: 'garden-3', title: '', body: '空标题的第三章正文。'},
    {id: 'garden-4', title: '   ', body: '纯空白标题的第四章正文。'},
  ]};
const project = {id: projectId, title: '当前作品专属书名', phase: 'complete', status: 'ready',
  docOpen: true, docMode: 'read', selectedChapter: 0,
  chapters: [{id: 'current', title: '当前稿章节', body: '当前工作稿正文，独立于所有历史存稿。'}],
  versions: [versionA, versionB, versionC],
  messages: [{role: 'assistant', text: '合成挂载同步标记', turnId: 'synthetic-missing-turn', turnStatus: 'running'}],
  pendingEdits: [{id: 'pending', chapterId: 'current', start: 0, before: '当前工作稿', after: '合成待审替换',
    reason: '导航不应改变的合成建议', status: 'pending'}]};
const reports = [versionA, versionB].map((version, index) => ({
  id: (index === 0 ? 'a' : 'b').repeat(64), title: version.title, createdAt: date, synthetic: true,
  manuscriptRevision: productManuscriptRevision(version.title, version.chapters),
}));

async function readProject(page) {
  return page.evaluate(({key, id}) => JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id),
    {key: storageKey, id: projectId});
}

async function exercise(page, downloadDir) {
  const dialog = page.getByRole('dialog');
  const navigation = dialog.getByLabel('存稿章节导航', {exact: true});
  const previous = navigation.getByRole('button', {name: '上一章', exact: true});
  const next = navigation.getByRole('button', {name: '下一章', exact: true});
  const rows = dialog.locator('[aria-label="选择历史版本"] button[aria-pressed]');
  const search = dialog.getByRole('textbox', {name: '查找存稿', exact: true});
  const rowFor = version => rows.filter({has: page.getByText(version.label, {exact: true})});
  const downloads = [];
  page.on('download', download => downloads.push(download));
  const checkFullText = async version => {
    await dialog.getByRole('heading', {name: version.title, level: 3, exact: true}).waitFor();
    const chapterTitles = version.chapters.map(chapter => chapter.title);
    const headings = await dialog.getByRole('heading', {level: 4}).allTextContents();
    assert.deepEqual(headings.filter(title => chapterTitles.includes(title)), chapterTitles,
      'all chapter headings remain rendered in source order');
    for (const chapter of version.chapters) {
      const body = dialog.getByText(chapter.body, {exact: true});
      await body.waitFor({state: 'attached'});
      assert.equal(await body.textContent(), chapter.body, 'full paragraph text remains in the DOM');
    }
  };
  const checkFocus = async chapter => {
    await page.waitForTimeout(100);
    await page.waitForFunction(title => {
      const heading = [...document.querySelectorAll('[role="dialog"] h4')]
        .find(element => element.textContent === title);
      if (!heading || document.activeElement !== heading) return false;
      const rect = heading.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.bottom > innerHeight) return false;
      for (let parent = heading.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          const clip = parent.getBoundingClientRect();
          if (rect.top < clip.top - 1 || rect.bottom > clip.bottom + 1) return false;
        }
      }
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === heading || heading.contains(hit);
    }, chapter.title);
    assert.equal(await dialog.locator('.tw-manuscript-version-layout').evaluate(el => el.scrollTop), 0,
      'chapter navigation must not scroll the clipped layout and hide the version list');
    assert.equal(await dialog.locator('.tw-manuscript-version-preview').evaluate(el => el.scrollTop), 0,
      'chapter navigation preserves the preview header');
    const navBox = await navigation.boundingBox();
    const paneBox = await dialog.locator('.tw-manuscript-version-body').boundingBox();
    assert.ok(navBox.y >= paneBox.y && navBox.y + navBox.height <= paneBox.y + paneBox.height,
      'navigation stays visible inside the reading pane');
  };
  const pickVersion = async version => {
    await rowFor(version).click();
    await navigation.waitFor();
    await checkFullText(version);
    assert.equal(await dialog.locator('.tw-manuscript-version-body').evaluate(el => el.scrollTop), 0, 'switching snapshots starts reading at the top');
    assert.equal(await previous.isDisabled(), true, 'switching snapshots resets navigation to the first chapter');
    assert.equal(await next.isEnabled(), version.chapters.length > 1);
  };
  const jumpToLast = async version => {
    await navigation.getByRole('button', {name: /跳转存稿章节/}).click();
    await page.waitForTimeout(250);
    await page.getByRole('option', {name: new RegExp(version.chapters.at(-1).title)}).click();
    await checkFocus(version.chapters.at(-1));
    assert.equal(await next.isDisabled(), true);
    assert.equal(await previous.isEnabled(), true);
  };
  const closeHistory = async () => {
    await dialog.getByRole('button', {name: '关闭窗口', exact: true}).click();
    await dialog.waitFor({state: 'hidden'});
  };
  let baseline;
  const unchanged = async () => {
    await page.waitForTimeout(500);
    assert.deepEqual(await readProject(page), baseline, 'saved navigation preserves the entire persisted project');
  };
  const downloadWhole = async version => {
    await dialog.getByRole('button', {name: '导出所选存稿', exact: true}).click();
    const preview = dialog.getByRole('region', {name: '导出所选存稿', exact: true});
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      preview.getByRole('button', {name: '下载 TXT', exact: true}).click(),
    ]);
    const file = path.join(downloadDir, version.id + '-' + downloads.length + '.txt');
    await download.saveAs(file);
    assert.equal(await download.failure(), null);
    assert.equal(path.extname(download.suggestedFilename()), '.txt');
    const expected = version.title + '\n\n' + version.chapters
      .map(chapter => chapter.title + '\n\n' + chapter.body).join('\n\n---\n\n');
    assert.deepEqual(await readFile(file), Buffer.from(expected, 'utf8'),
      'navigation exports all selected-version chapters with exact text and order');
    await preview.getByRole('button', {name: '返回存稿', exact: true}).click();
    await navigation.waitFor();
    await checkFullText(version);
    await unchanged();
  };

  await page.getByTestId('manuscript-prose').filter({visible: true}).waitFor();
  await page.waitForFunction(({key, id}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.messages[0]?.turnStatus === 'interrupted',
    {key: storageKey, id: projectId});
  baseline = await readProject(page);
  assert.deepEqual(baseline.versions, project.versions);
  assert.deepEqual(baseline.chapters, project.chapters);
  assert.deepEqual(baseline.pendingEdits, project.pendingEdits);
  await page.getByRole('button', {name: '版本记录', exact: true}).click();
  await pickVersion(versionA);
  await next.click();
  await checkFocus(versionA.chapters[1]);
  await checkFullText(versionA);
  await previous.click();
  await checkFocus(versionA.chapters[0]);
  assert.equal(await previous.isDisabled(), true);
  await jumpToLast(versionA);
  if (process.env.TALEWICK_SCREENSHOT) await page.screenshot({path: process.env.TALEWICK_SCREENSHOT, fullPage: true});
  await unchanged();
  await downloadWhole(versionA);
  await jumpToLast(versionA);

  await pickVersion(versionB);
  await next.click();
  await checkFocus(versionB.chapters[1]);
  assert.equal(await dialog.getByRole('heading', {name: versionA.chapters[1].title, exact: true}).count(), 0);
  await search.fill(versionC.label);
  assert.equal(await rows.count(), 1);
  await dialog.getByRole('status').filter({hasText: '预览仍为所选存稿「' + versionB.label + '」'}).waitFor();
  await checkFullText(versionB);
  assert.equal(await previous.isEnabled(), true, 'filtering keeps the selected snapshot navigation position');
  await next.click();
  await checkFocus(versionB.chapters[2]);
  assert.equal(await next.isDisabled(), true);
  await dialog.getByRole('button', {name: '显示所选存稿', exact: true}).click();
  assert.equal(await search.inputValue(), '');
  assert.equal(await rows.count(), 3);
  await unchanged();

  await dialog.getByRole('button', {name: '对比版本', exact: true}).click();
  await navigation.waitFor({state: 'hidden'});
  await dialog.getByRole('region', {name: '存稿对比', exact: true}).waitFor();
  await dialog.getByRole('button', {name: '查看全文', exact: true}).click();
  await navigation.waitFor();
  await checkFullText(versionB);
  await jumpToLast(versionB);
  await previous.click();
  await checkFocus(versionB.chapters[1]);
  await downloadWhole(versionB);
  await closeHistory();
  await unchanged();

  const review = page.getByRole('region', {name: '独立全文评阅', exact: true});
  await review.locator('summary').filter({hasText: '评阅历史'}).click();
  const reportRow = review.locator('article').filter({has: page.getByRole('heading', {name: versionA.title, exact: true})});
  await reportRow.getByRole('button', {name: '查看对应存稿', exact: true}).click();
  await navigation.waitFor();
  await checkFullText(versionA);
  assert.equal(await previous.isDisabled(), true);
  await next.click();
  await checkFocus(versionA.chapters[1]);
  await jumpToLast(versionA);
  for (const name of ['恢复此版本', '恢复本章', '确认恢复整稿', '保存当前稿件为新存稿']) {
    assert.equal(await dialog.getByRole('button', {name, exact: true}).count(), 0, 'report snapshot remains read-only');
  }
  await downloadWhole(versionA);
  await closeHistory();
  assert.equal(downloads.length, 3);
  await page.reload();
  await page.getByTestId('manuscript-prose').filter({visible: true}).waitFor();
  assert.equal(await page.getByTestId('manuscript-prose').filter({visible: true}).textContent(), project.chapters[0].body);
  await unchanged();
  await page.getByRole('button', {name: '版本记录', exact: true}).click();
  await pickVersion(versionB);
  await jumpToLast(versionB);
  await unchanged();
  await rowFor(versionC).click();
  const sourceHeadings = dialog.locator('h4.font-story');
  assert.deepEqual(await sourceHeadings.allTextContents(), versionC.chapters.map(chapter => chapter.title));
  for (let index = 1; index < versionC.chapters.length; index++) {
    await navigation.getByRole('button', {name: /跳转存稿章节/}).click();
    await page.waitForTimeout(250);
    await page.getByRole('option', {name: `${index + 1}. ${versionC.chapters[index].title.trim() || '未命名章节'}`, exact: true}).click();
    await page.waitForTimeout(100);
    const heading = sourceHeadings.nth(index);
    assert.equal(await heading.evaluate(el => document.activeElement === el), true, 'duplicate or blank chapter uses its own index');
    assert.ok((await heading.boundingBox()).height > 0, 'blank heading still has a visible focus area');
    if (index >= 2) assert.equal(await heading.getAttribute('aria-label'), `第 ${index + 1} 章（未命名章节）`);
    assert.deepEqual(await sourceHeadings.allTextContents(), versionC.chapters.map(chapter => chapter.title));
  }
  assert.equal(await next.isDisabled(), true);
  await unchanged();
}

const runsDir = await mkdtemp(path.join(tmpdir(), 'talewick-saved-navigation-'));
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
  const context = await browser.newContext({viewport: {width: Number(process.env.TALEWICK_VIEWPORT_WIDTH || 1512), height: 982}, reducedMotion: 'reduce', acceptDownloads: true});
  const external = [], errors = [], mutations = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) {
      if (route.request().method() === 'GET') {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/independent-reviews') {
          assert.equal(url.searchParams.get('projectId'), project.id);
          return route.fulfill({json: {tasks: [], isolatedReports: reports}});
        }
        return route.continue();
      }
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
  await page.goto(origin);
  try { await exercise(page, runsDir); } catch (error) {
    if (process.env.TALEWICK_SCREENSHOT) await page.screenshot({path: process.env.TALEWICK_SCREENSHOT, fullPage: true});
    throw error;
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(mutations, [], 'saved navigation and export need no model or mutation API calls');
  console.log('PASS saved navigation: heading focus and visibility, boundaries, source reset, hidden selection, comparison, report entry, complete TXT downloads and reload');
} finally {
  await browser?.close();
  if (runtime) {
    await runtime.close();
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
  }
  await rm(runsDir, {recursive: true, force: true});
}
