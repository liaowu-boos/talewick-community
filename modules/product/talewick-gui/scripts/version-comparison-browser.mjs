/** From the GUI directory: npm run build && node scripts/version-comparison-browser.mjs.
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
const projectId = 'synthetic-version-comparison';
const chapters = [
  {id: 'desk', title: '东侧小屋', body: '纸船靠岸'},
  {id: 'garden', title: '西侧花园', body: '树影落在窗沿。'},
];
const originalTitle = '桂花收件簿';
const date = '2026-01-01T00:00:00.000Z';
const source = {id: 'source', label: '草稿一', title: originalTitle, date, chapters};
const rewritten = {...source, id: 'rewrite', label: '修辞稿二', chapters: [{...chapters[0], body: '风筝升空'}, chapters[1]]};
const reordered = {...source, id: 'reorder', label: '顺序稿三', chapters: [chapters[1], chapters[0]]};
const renamed = {...source, id: 'rename', label: '更名稿四', title: '水杉投递簿'};
const legacy = {id: 'legacy', label: '归档五', date, chapters};
const passage = '院中落了一场雨。'.repeat(200);
const longDraft = {...source, id: 'long-source', label: '长章起点',
  chapters: [{...chapters[0], body: '她推开门。\n' + passage + '\n来信：🌕。'}]};
const longRevision = {...longDraft, id: 'long-revised', label: '自动保存',
  chapters: [{...chapters[0], body: '她拉开门。\n' + passage + '\n来信：🌑。'}]};
const duplicateLabel = {...source, id: 'autosave', label: longRevision.label};
const project = {id: projectId, title: '银杏值班簿', phase: 'done', status: 'ready', docMode: 'read', docOpen: true,
  chapters: [{...chapters[0], body: '铜铃轻响'}, chapters[1]], versions: [source, rewritten, reordered, renamed, legacy, longDraft, longRevision, duplicateLabel],
  pendingEdits: [{id: 'pending', chapterId: 'desk', start: 0, before: '铜铃', after: '银铃', reason: '合成待审意见', status: 'pending'}]};

async function checkStoredProject(page) {
  const stored = await page.evaluate(({storageKey, projectId}) => {
    const state = JSON.parse(localStorage.getItem(storageKey));
    return state.projects.find(item => item.id === projectId);
  }, {storageKey, projectId});
  for (const field of ['title', 'chapters', 'pendingEdits', 'versions']) assert.deepEqual(stored[field], project[field], field);
}

async function exercise(page) {
  const history = page.getByRole('button', {name: '版本记录', exact: true});
  const dialog = page.getByRole('dialog');
  const pickSource = version => dialog.getByRole('button').filter({hasText: version.label}).click();
  const compare = dialog.getByRole('button', {name: '对比版本', exact: true});
  const fullText = dialog.getByRole('button', {name: '查看全文', exact: true});
  const target = dialog.getByRole('combobox', {name: '对比目标', exact: true});
  const pickTarget = async version => {
    const option = target.getByRole('option', {name: new RegExp(version.label)});
    await target.selectOption({label: await option.evaluate(element => element.label)});
  };
  const comparison = dialog.getByRole('region', {name: /版本比较/});
  const changedBody = async (before, after) => {
    assert((await dialog.locator('del').allTextContents()).includes(before));
    assert((await dialog.locator('ins').allTextContents()).includes(after));
  };

  await history.click();
  await pickSource(source);
  await compare.click();
  assert.equal(await target.inputValue(), 'current');
  await changedBody(chapters[0].body, project.chapters[0].body);
  await pickTarget(rewritten);
  await changedBody(chapters[0].body, rewritten.chapters[0].body);

  await pickTarget(reordered);
  for (const [index, chapter] of chapters.entries()) {
    const moved = comparison.getByRole('heading', {name: chapter.title, exact: true}).locator('..');
    assert.match(await moved.innerText(), new RegExp(`第\\s*${index + 1}\\s*章.*第\\s*${2 - index}\\s*章`));
  }
  assert.equal(await comparison.locator('del, ins').count(), 0, 'Moving chapters alone does not change their text');

  await pickTarget(renamed);
  await changedBody(source.title, renamed.title);

  // The former target is now the source. It must no longer be a selectable destination.
  await pickSource(renamed);
  if (!(await target.isVisible())) await compare.click();
  const selectableLabels = await target.locator('option:enabled').allTextContents();
  assert(!selectableLabels.some(label => label.includes(renamed.label)));
  assert(!(await target.locator('option:checked').textContent()).includes(renamed.label));
  await pickTarget(legacy);
  const unknownTitle = await comparison.innerText();
  assert.match(unknownTitle, /未记录|未知|未保存|缺失|记录不全|无法核对/);
  assert(!unknownTitle.includes(project.title), 'A snapshot without a title must not inherit the live title');

  await pickSource(longDraft);
  const autosaves = await target.getByRole('option', {name: /自动保存/}).allTextContents();
  assert.equal(autosaves.length, 2);
  assert.notEqual(autosaves[0], autosaves[1], 'same-time autosaves need distinct labels');
  await target.selectOption({label: autosaves[0]});
  assert.equal(await comparison.getByText(passage, {exact: false}).count(), 0);
  await comparison.locator('summary').click();
  await comparison.locator('del').first().waitFor({state: 'visible'});
  assert.deepEqual(await comparison.locator('del').allTextContents(), ['推', '🌕']);
  assert.deepEqual(await comparison.locator('ins').allTextContents(), ['拉', '🌑']);
  const sides = comparison.getByRole('region', {name: /正文$/});
  assert.deepEqual(await sides.locator('p').allTextContents(), [longDraft.chapters[0].body, longRevision.chapters[0].body]);
  await fullText.click();
  await target.waitFor({state: 'hidden'});
  await compare.click();
  assert.equal(await target.inputValue(), 'current');
  await pickTarget(source);
  await page.keyboard.press('Escape');
  await dialog.waitFor({state: 'hidden'});
  await history.click();
  await pickSource(source);
  await compare.click();
  assert.equal(await target.inputValue(), 'current');
  await changedBody(chapters[0].body, project.chapters[0].body);
  await page.keyboard.press('Escape');
  await dialog.waitFor({state: 'hidden'});
  assert.equal(await page.getByTestId('manuscript-prose').filter({visible: true}).textContent(), project.chapters[0].body);
  await checkStoredProject(page);
}

const runsDir = await mkdtemp(path.join(tmpdir(), 'talewick-version-comparison-'));
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
  await page.goto(origin);
  await exercise(page);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('PASS current and saved targets, source exclusion, reset, chapter order, changed and missing titles, read-only project state');
} finally {
  await browser?.close();
  if (runtime) {
    await runtime.close();
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
  }
  await rm(runsDir, {recursive: true, force: true});
}
