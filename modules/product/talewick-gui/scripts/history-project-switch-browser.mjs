// Run after npm run build, with the same browser environment as isolated-history-browser.mjs.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {createRuntime} from '../server/index.mjs';
import {productManuscriptRevision} from '../server/full15-service.mjs';

const runsDir = await mkdtemp(path.join(tmpdir(), 'history-project-switch-'));
const socket = createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const origin = 'http://127.0.0.1:' + port;
const chapters = [{id: 'one', title: '合成章节', body: '合成测试文字。'}];
const projects = ['A', 'B'].map(side => ({id: 'switch-' + side, title: '切换合成稿 ' + side,
  chapters, phase: 'done', status: 'ready', docOpen: true, docMode: 'read'}));
const history = side => ({tasks: [], isolatedReports: [{
  id: side.toLowerCase().repeat(64), title: '项目 ' + side + ' 专属报告', synthetic: true,
  createdAt: '2026-01-01T00:00:00Z', manuscriptRevision: productManuscriptRevision('切换合成稿 ' + side, chapters),
}]});
const url = side => origin + '/api/independent-reviews?projectId=switch-' + side;
const release = Promise.withResolvers();
let runtime, browser;
try {
  runtime = await createRuntime({config: {port, runsDir, apiKey: '', model: 'offline', baseURL: 'https://example.invalid/v1', timeoutMs: 1000}});
  await new Promise(resolve => runtime.server.listen(port, '127.0.0.1', resolve));
  const playwright = process.env.TALEWICK_PLAYWRIGHT_MODULE
    ? await import(pathToFileURL(path.resolve(process.env.TALEWICK_PLAYWRIGHT_MODULE))) : await import('playwright');
  browser = await playwright.chromium.launch({headless: true, executablePath: process.env.TALEWICK_BROWSER_EXECUTABLE || undefined});
  const context = await browser.newContext({viewport: {width: 1512, height: 982}, reducedMotion: 'reduce'});
  await context.addInitScript(({origin, projects}) => {
    if (window.top !== window || location.origin !== origin) return;
    localStorage.setItem('talewick.boardui.gui.v1', JSON.stringify({schemaVersion: 1, projects,
      activeProjectId: projects[0].id, page: 'create', settings: {autoSave: false, reduceMotion: true}}));
  }, {origin, projects});
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], external = [], failed = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => failed.push(request.url()));
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.route(url('A'), async route => {
    await release.promise;
    await route.fulfill({json: history('A')});
  });
  await page.route(url('B'), route => route.fulfill({json: history('B')}));
  await page.goto(origin);
  const panel = page.getByRole('region', {name: '独立全文评阅', exact: true});
  await panel.getByRole('button', {name: '正在读取评阅历史…', exact: true}).waitFor();
  await page.getByRole('button', {name: '切换合成稿 A', exact: true}).click();
  await page.getByRole('dialog', {name: '创作记录'}).getByRole('button').filter({hasText: '切换合成稿 B'}).click();
  const historySection = panel.locator('details').filter({has: page.locator('summary').filter({hasText: '评阅历史'})});
  await historySection.locator('summary').click();
  await panel.getByRole('heading', {name: '项目 B 专属报告', exact: true}).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="独立全文评阅"]')?.textContent.includes('项目 B 专属报告'));
  assert(failed.includes(url('A')), 'switching projects must cancel the old request');
  release.resolve();
  await page.unrouteAll({behavior: 'wait'});
  assert.equal(await panel.getByRole('heading', {name: '项目 A 专属报告', exact: true}).count(), 0);

  await page.getByRole('tab', {name: '编辑', exact: true}).click();
  const editor = page.getByRole('textbox', {name: '章节标题', exact: true});
  await editor.fill('未保存的合成标题');
  await page.route(url('B'), route => route.fulfill({json: {tasks: [], isolatedReports: [null]}}));
  const refresh = panel.getByRole('button', {name: '刷新评阅历史', exact: true});
  await refresh.click();
  await panel.getByRole('alert').filter({hasText: '评阅历史记录有误'}).waitFor();
  assert.equal(await panel.getByRole('heading', {name: '项目 B 专属报告', exact: true}).count(), 1);
  assert.equal(await editor.inputValue(), '未保存的合成标题');
  await page.unroute(url('B'));
  await page.route(url('B'), route => route.fulfill({json: history('B')}));
  await refresh.click();
  await panel.getByRole('alert').waitFor({state: 'hidden'});
  assert.equal(await editor.inputValue(), '未保存的合成标题');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('PASS project switch cancels old history; malformed records preserve history and draft; refresh recovers');
} finally {
  release.resolve();
  await browser?.close();
  if (runtime) {
    await runtime.close();
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
  }
  await rm(runsDir, {recursive: true, force: true});
}
