/** From the GUI directory: npm run build && node scripts/isolated-history-browser.mjs
 * Browser selection follows fresh-install-smoke.mjs: playwright or TALEWICK_PLAYWRIGHT_MODULE,
 * plus optional TALEWICK_BROWSER_EXECUTABLE. Uses the production workbench and a temporary archive.
 */
import assert from 'node:assert/strict';
import {mkdtemp, rename, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRuntime} from '../server/index.mjs';
import {createDemoInput} from '../../../../tools/review-preview/demo-isolated-input.mjs';
import {registerWorkbenchReport} from '../../../../tools/review-preview/register-workbench-report.mjs';
import {manuscripts} from '../../../../tools/isolated-anchor-reading/synthetic-fixture.mjs';

const title = '门廊合成稿';
const projectId = 'isolated-history-browser';
const sides = ['A', 'B'];
const records = {};
const runsDir = await mkdtemp(path.join(tmpdir(), 'talewick-history-browser-'));
let runtime, browser;

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const {port} = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function exercise(origin, current) {
  const other = current === 'A' ? 'B' : 'A';
  const context = await browser.newContext({viewport: {width: 1512, height: 982}, reducedMotion: 'reduce'});
  try {
    const external = [], errors = [], opens = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      external.push(url.href);
      return route.abort();
    });
    // Seed only a new browser context. Reports come through the actual registration and HTTP routes.
    await context.addInitScript(({origin, title, projectId, chapters}) => {
      if (window.top !== window || location.origin !== origin) return;
      const project = {id: projectId, title, chapters, phase: 'done', status: 'ready', docOpen: true, docMode: 'read'};
      localStorage.setItem('talewick.boardui.gui.v1', JSON.stringify({schemaVersion: 1, projects: [project],
        activeProjectId: projectId, page: 'create', settings: {autoSave: false, reduceMotion: true}}));
    }, {origin, title, projectId, chapters: manuscripts[current]});
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', err => errors.push(err.message));
    page.on('request', req => {
      if (req.method() === 'POST' && /\/api\/isolated-reports\/[^/]+\/open$/.test(req.url())) opens.push(req.url());
    });
    await page.goto(origin);
    const panel = page.getByRole('region', {name: '独立全文评阅', exact: true});
    const history = panel.locator('details').filter({has: page.locator('summary').filter({hasText: '评阅历史'})});
    await history.locator('summary').click();
    const rows = history.locator('article');
    const row = side => rows.filter({hasText: `匿名稿 ${side}`});
    const openButton = side => row(side).getByRole('button', {name: '打开三路报告'});
    for (const side of sides) {
      await row(side).waitFor({state: 'visible'});
      assert.equal(await row(side).count(), 1);
      assert.equal(await row(side).getByRole('heading', {name: title, exact: true}).count(), 1);
    }
    assert.equal(await rows.count(), 2);
    assert(await openButton(current).isEnabled());
    assert(await openButton(other).isDisabled());
    const url = `${origin}/api/isolated-reports/${records[current].id}/open`;
    const archive = path.join(runsDir, 'isolated-reports', records[current].htmlSHA256 + '.html');
    await rename(archive, archive + '.held');
    try {
      const [missing] = await Promise.all([page.waitForResponse(r => r.url() === url), openButton(current).click()]);
      assert.equal(missing.status(), 409);
      const alert = row(current).getByRole('alert');
      await alert.waitFor();
      assert.match(await alert.innerText(), /本地报告文件缺失.*重新导入/);
      assert.equal(await history.locator('iframe').count(), 0);
      assert.equal(await rows.count(), 2);
    } finally {
      await rename(archive + '.held', archive);
    }
    const [response] = await Promise.all([page.waitForResponse(r => r.url() === url && r.request().method() === 'POST'), openButton(current).click()]);
    assert.equal(response.status(), 200);
    const report = row(current).locator('iframe');
    await report.waitFor({state: 'visible'});
    assert.equal(await report.getAttribute('srcdoc'), await response.text());
    assert.equal(await report.getAttribute('sandbox'), '');

    await page.getByRole('tab', {name: '编辑', exact: true}).click();
    const editor = page.getByRole('textbox', {name: '章节标题', exact: true});
    const savedTitle = await editor.inputValue();
    await report.waitFor({state: 'visible'});
    await editor.fill(savedTitle + '（未保存）');
    await page.getByText('有未保存的修改', {exact: true}).waitFor();
    await report.waitFor({state: 'detached'});
    assert.equal(await rows.count(), 2);
    for (const side of sides) {
      assert(await row(side).isVisible());
      assert(await openButton(side).isDisabled());
    }
    await page.getByRole('button', {name: '撤销本次', exact: true}).click();
    assert.equal(await editor.inputValue(), savedTitle);
    await page.getByText('有未保存的修改', {exact: true}).waitFor({state: 'hidden'});
    assert(await openButton(current).isEnabled());
    assert(await openButton(other).isDisabled());
    assert.equal(await history.locator('iframe').count(), 0);
    // Hold a successful response until the editor has moved on to a new saved draft.
    const savedHtml = await response.text();
    const releaseResponse = Promise.withResolvers();
    await page.route(url, async route => {
      await releaseResponse.promise;
      await route.fulfill({status: 200, contentType: 'text/html', body: savedHtml});
    }, {times: 1});
    try {
      await Promise.all([
        page.waitForRequest(request => request.url() === url && request.method() === 'POST'),
        openButton(current).click(),
      ]);
      const body = page.getByRole('textbox', {name: '章节正文', exact: true});
      await body.fill((await body.inputValue()) + '（合成编辑）');
      await page.getByText('有未保存的修改', {exact: true}).waitFor();
      await page.getByRole('button', {name: '保存版本', exact: true}).click();
      await page.getByText('有未保存的修改', {exact: true}).waitFor({state: 'hidden'});
    } finally {
      releaseResponse.resolve();
    }
    await page.unrouteAll({behavior: 'wait'});
    assert.equal(await rows.count(), 2);
    for (const side of sides) assert(await openButton(side).isDisabled());
    assert.equal(await history.locator('iframe').count(), 0);
    assert.deepEqual(opens, [url, url, url]);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(`PASS ${current}: missing archive reported and restored, both labels, matching report, stale disabled, draft closes report, undo restores access, saving a new version blocks both even with a delayed response`);
  } finally {
    await context.close();
  }
}

try {
  const adapterInput = createDemoInput();
  for (const version of sides) {
    const record = await registerWorkbenchReport({runsDir, projectId, version, manuscript: {title, chapters: manuscripts[version]},
      adapterInput, createdAt: '2026-01-01T00:00:00.000Z', synthetic: true});
    records[version] = record;
  }
  const port = await freePort();
  runtime = await createRuntime({config: {port, runsDir, apiKey: '', model: 'offline', baseURL: 'https://example.invalid/v1', timeoutMs: 1000},
    distDir: process.env.TALEWICK_DIST_DIR || undefined});
  await new Promise((resolve, reject) => runtime.server.once('error', reject).listen(port, '127.0.0.1', resolve));
  const playwright = process.env.TALEWICK_PLAYWRIGHT_MODULE
    ? await import(pathToFileURL(path.resolve(process.env.TALEWICK_PLAYWRIGHT_MODULE))) : await import('playwright');
  browser = await playwright.chromium.launch({headless: true, executablePath: process.env.TALEWICK_BROWSER_EXECUTABLE || undefined});
  for (const side of sides) await exercise(`http://127.0.0.1:${port}`, side);
} finally {
  await browser?.close();
  if (runtime) {
    await runtime.close();
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
  }
  await rm(runsDir, {recursive: true, force: true});
}
