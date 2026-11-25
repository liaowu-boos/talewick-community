/** From the GUI directory: npm run build && node scripts/version-export-browser.mjs.
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
const projectId = 'synthetic-version-export';
const currentChapters = [
  {id: 'pier', title: '当前渡口章', body: '当前正文专属标记：铜铃响了。'},
  {id: 'bridge', title: '当前桥边章', body: '当前第二章专属标记：雨停了。'},
];
const named = {id: 'named-source', label: '有书名旧存稿', title: '旧日桥边手记', date,
  chapters: [
    {id: 'bridge', title: '旧稿先写木桥', body: '木桥下游过一条鱼。\n\n水面映出月亮。🌕'},
    {id: 'pier', title: '旧稿后写渡口', body: '纸船在清晨靠岸。\n船篷落了一片叶子。'},
  ]};
const legacy = {id: 'legacy-source', label: '未记录书名的存稿', date,
  chapters: [
    {id: 'bay', title: '无名稿的浅湾', body: '浅湾停着一只红色纸船。🌒'},
    {id: 'hill', title: '无名稿的山坡', body: '山坡上立着风车。\n\n它慢慢转过半圈。'},
  ]};
const task = {id: 'synthetic-export-task', projectId, requestId: 'synthetic-export-request',
  baseRevision: 'synthetic-export-revision', kind: 'create', status: 'completed',
  engine: 'fixed', engineVersion: 'fixed-workflow-2', stage: 'completed', createdAt: date, updatedAt: date,
  result: {title: '任务回包专属书名', chapters: currentChapters,
    review: {summary: '评阅回包专属标记：这些意见不得进入整稿。', issues: [], limitations: []}}};
const project = {id: projectId, title: '当前作品专属书名', phase: 'complete', status: 'ready',
  docOpen: true, docMode: 'read', selectedChapter: 0, chapters: currentChapters, versions: [named, legacy],
  messages: [{role: 'assistant', text: '合成挂载同步标记', turnId: 'synthetic-missing-turn', turnStatus: 'running'}],
  pendingEdits: [{id: 'synthetic-pending', chapterId: 'pier', start: 0,
    before: '当前正文', after: '建议替换专属标记', reason: '合成待审建议原因', status: 'pending'}],
  runtime: {request: {projectId, requestId: task.requestId, baseRevision: task.baseRevision,
    kind: 'create', idea: '合成旧任务', chapters: currentChapters},
    baseManuscript: {title: '旧任务输入书名', chapters: currentChapters}, task, handledTaskId: task.id},
  runtimeHistory: [task]};
const legacyReportTitle = '报告元数据书名不得代填';
const reports = [named, legacy].map((version, index) => {
  const title = version.title ?? legacyReportTitle;
  return {id: (index === 0 ? 'a' : 'b').repeat(64), title, createdAt: date, synthetic: true,
    manuscriptRevision: productManuscriptRevision(title, version.chapters)};
});

async function readProject(page) {
  return page.evaluate(({key, id}) => JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id),
    {key: storageKey, id: projectId});
}

function expectedText(version, title, format) {
  const headings = format === 'md';
  return (headings ? '# ' : '') + title + '\n\n' + version.chapters
    .map(chapter => (headings ? '## ' : '') + chapter.title + '\n\n' + chapter.body)
    .join('\n\n---\n\n');
}

async function exercise(page, downloadDir) {
  const dialog = page.getByRole('dialog');
  const preview = dialog.getByRole('region', {name: '导出所选存稿', exact: true});
  const entry = dialog.getByRole('button', {name: '导出所选存稿', exact: true});
  const exportTitle = preview.getByRole('textbox', {name: '导出书名', exact: true});
  const back = preview.getByRole('button', {name: '返回存稿', exact: true});
  const rows = dialog.locator('[aria-label="选择历史版本"] button[aria-pressed]');
  const downloads = [];
  page.on('download', download => downloads.push(download));
  const pick = async version => {
    await rows.filter({has: page.getByText(version.label, {exact: true})}).click();
    await dialog.getByRole('heading', {name: version.label, exact: true}).waitFor();
    for (const chapter of version.chapters) await dialog.getByText(chapter.body, {exact: true}).waitFor();
  };
  const openExport = async () => { await entry.click(); await preview.waitFor(); };
  const returnToSnapshot = async () => {
    await back.click();
    await preview.waitFor({state: 'hidden'});
    await entry.waitFor();
  };
  const closeHistory = async () => {
    await dialog.getByRole('button', {name: '关闭窗口', exact: true}).click();
    await dialog.waitFor({state: 'hidden'});
  };
  let baseline;
  const unchanged = async () => {
    await page.clock.runFor(500);
    assert.deepEqual(await readProject(page), baseline, 'export preserves every persisted project field');
  };
  const checkDownload = async (version, title, format) => {
    const previousCount = downloads.length;
    if (process.env.TALEWICK_SCREENSHOT && previousCount === 2) {
      await page.screenshot({path: process.env.TALEWICK_SCREENSHOT});
    }
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      preview.getByRole('button', {name: format === 'md' ? '下载 Markdown' : '下载 TXT', exact: true}).click(),
    ]);
    const file = path.join(downloadDir, 'download-' + (previousCount + 1) + '.' + format);
    await download.saveAs(file);
    assert.equal(await download.failure(), null);
    assert.equal(path.extname(download.suggestedFilename()), '.' + format);
    const bytes = await readFile(file);
    assert.deepEqual(bytes, Buffer.from(expectedText(version, title, format), 'utf8'),
      'downloaded UTF-8 bytes match the selected snapshot, including order and whitespace');
    const decoded = bytes.toString('utf8');
    for (const marker of [project.title, ...currentChapters.map(chapter => chapter.body),
      project.pendingEdits[0].after, project.pendingEdits[0].reason, task.result.title,
      task.result.review.summary, task.id, legacyReportTitle]) {
      assert.equal(decoded.includes(marker), false, 'export excludes current manuscript, suggestions and report/task metadata');
    }
    const other = version.id === named.id ? legacy : named;
    for (const chapter of other.chapters) assert.equal(decoded.includes(chapter.body), false, 'exports do not mix versions');
    await page.clock.runFor(500);
    assert.equal(downloads.length, previousCount + 1, 'one download per click');
    await unchanged();
  };
  const checkLegacyBlank = async () => {
    assert.equal(await exportTitle.inputValue(), '', 'missing title requires explicit author input');
    const count = downloads.length;
    for (const blank of ['', '   ']) {
      await exportTitle.fill(blank);
      assert.equal(await preview.getByRole('button', {name: '下载 Markdown', exact: true}).isDisabled(), true);
      assert.equal(await preview.getByRole('button', {name: '下载 TXT', exact: true}).isDisabled(), true);
      await exportTitle.press('Enter');
      await page.clock.runFor(500);
      assert.equal(downloads.length, count);
      await unchanged();
    }
  };

  await page.getByTestId('manuscript-prose').filter({visible: true}).waitFor();
  await page.waitForFunction(({key, id}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.messages[0]?.turnStatus === 'interrupted',
    {key: storageKey, id: projectId});
  baseline = await readProject(page);
  assert.deepEqual(baseline.chapters, currentChapters);
  assert.deepEqual(baseline.versions, [named, legacy]);
  assert.deepEqual(baseline.pendingEdits, project.pendingEdits);
  assert.equal(baseline.runtime.task.id, task.id);
  assert.equal(baseline.runtime.task.result.review.summary, task.result.review.summary);
  assert.equal(baseline.runtime.handledTaskId, task.id);
  assert.equal(baseline.runtimeHistory[0].id, task.id);

  await page.getByRole('button', {name: '版本记录', exact: true}).click();
  await pick(named);
  await openExport();
  await returnToSnapshot();
  await unchanged();
  assert.equal(downloads.length, 0, 'cancelling creates no download');
  await dialog.getByRole('button', {name: '对比版本', exact: true}).click();
  await dialog.getByRole('region', {name: '存稿对比', exact: true}).waitFor();
  await openExport();
  await checkDownload(named, named.title, 'md');
  await checkDownload(named, named.title, 'txt');
  await returnToSnapshot();
  await dialog.getByRole('region', {name: '存稿对比', exact: true}).waitFor();
  await dialog.getByRole('button', {name: '查看全文', exact: true}).click();

  await pick(legacy);
  await openExport();
  await checkLegacyBlank();
  const suppliedTitle = '作者填写的临时导出书名';
  await exportTitle.fill(suppliedTitle);
  await checkDownload(legacy, suppliedTitle, 'txt');
  await checkDownload(legacy, suppliedTitle, 'md');
  await returnToSnapshot();
  assert.equal(Object.hasOwn((await readProject(page)).versions.find(version => version.id === legacy.id), 'title'), false);

  // Switching back and re-opening the titleless version must clear the previous export title.
  await pick(named);
  await openExport();
  await checkDownload(named, named.title, 'txt');
  await returnToSnapshot();
  await pick(legacy);
  await openExport();
  await checkLegacyBlank();
  const cancelledCount = downloads.length;
  await exportTitle.fill('应该取消的临时书名');
  await returnToSnapshot();
  await unchanged();
  assert.equal(downloads.length, cancelledCount);
  await closeHistory();
  await page.reload();
  await page.getByTestId('manuscript-prose').filter({visible: true}).waitFor();
  await unchanged();
  assert.equal(await page.getByTestId('manuscript-prose').filter({visible: true}).textContent(), currentChapters[0].body);

  // The report-linked snapshot entrance must export manuscript text without opening a report.
  const review = page.getByRole('region', {name: '独立全文评阅', exact: true});
  await review.locator('summary').filter({hasText: '评阅历史'}).click();
  for (const [index, version] of [named, legacy].entries()) {
    const report = reports[index];
    const row = review.locator('article').filter({has: page.getByRole('heading', {name: report.title, exact: true})});
    await row.getByRole('button', {name: '查看对应存稿', exact: true}).click();
    await dialog.getByRole('heading', {name: version.label, exact: true}).waitFor();
    await openExport();
    const title = version.title ?? '报告入口的临时导出书名';
    if (!version.title) { await checkLegacyBlank(); await exportTitle.fill(title); }
    await checkDownload(version, title, 'md');
    await returnToSnapshot();
    if (index === 0) {
      await pick(legacy);
      assert.equal(await dialog.getByRole('button', {name: '恢复此版本', exact: true}).count(), 0);
      await openExport();
      await checkLegacyBlank();
      await exportTitle.fill('切换存稿后的临时导出书名');
      await checkDownload(legacy, '切换存稿后的临时导出书名', 'txt');
      await returnToSnapshot();
    }
    await closeHistory();
  }
  assert.equal(downloads.length, 8);
  await page.reload();
  await page.getByTestId('manuscript-prose').filter({visible: true}).waitFor();
  await unchanged();
}

const runsDir = await mkdtemp(path.join(tmpdir(), 'talewick-version-export-'));
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
  await page.clock.install();
  await page.goto(origin);
  await exercise(page, runsDir);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(mutations, [], 'history export requires no model or mutation API calls');
  console.log('PASS historical exports: exact downloaded bytes, titleless naming, repeated selection, report-linked snapshots, project preservation and reload');
} finally {
  await browser?.close();
  if (runtime) {
    await runtime.close();
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
  }
  await rm(runsDir, {recursive: true, force: true});
}
