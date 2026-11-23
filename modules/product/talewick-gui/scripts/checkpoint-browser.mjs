/** From the GUI directory: npm run build && node scripts/checkpoint-browser.mjs.
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
const projectId = 'synthetic-checkpoint';
const chapters = [
  {id: 'pier', title: '渡口', body: '纸旗落在石阶上。\n\n小船驶向东岸。🌕'},
  {id: 'bridge', title: '木桥', body: '木桥下游过一条鱼。'},
];
const oldVersion = {id: 'old-snapshot', label: '合成旧存稿', title: '过去的书名',
  date: '2026-01-01T00:00:00.000Z', chapters: [chapters[1], {...chapters[0], body: '旧稿停在西岸。'}]};
const project = {id: projectId, title: '河岸值班簿', phase: 'done', status: 'ready',
  docMode: 'read', docOpen: true, selectedChapter: 0, chapters, versions: [oldVersion],
  messages: [{role: 'assistant', text: '合成挂载同步标记', turnId: 'synthetic-missing-turn', turnStatus: 'running'}],
  pendingEdits: [
    {id: 'pending', chapterId: 'pier', start: 0, before: '纸旗', after: '布旗', reason: '合成待审意见', status: 'pending'},
    {id: 'accepted', chapterId: 'bridge', start: 0, before: '旧桥', after: '木桥', reason: '合成已处理意见', status: 'accepted'},
  ]};

async function readProject(page) {
  return page.evaluate(({key, id}) => JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id),
    {key: storageKey, id: projectId});
}

function checkCheckpoint(stored, before, label) {
  assert.equal(stored.versions.length, before.versions.length + 1, 'exactly one named snapshot');
  assert.deepEqual(stored.versions.slice(0, -1), before.versions, 'all older snapshots retain their full payload');
  const snapshot = stored.versions.at(-1);
  assert.ok(snapshot.id && !before.versions.some(version => version.id === snapshot.id));
  assert.ok(Number.isFinite(Date.parse(snapshot.date)));
  assert.equal(snapshot.label, label);
  assert.equal(snapshot.title, before.title);
  assert.deepEqual(snapshot.chapters, before.chapters, 'snapshot includes exact current IDs, order, names and text');
  const expected = {...before, versions: stored.versions, updatedAt: stored.updatedAt};
  assert.deepEqual(stored, expected, 'checkpoint only appends a version and updates the project timestamp');
  return snapshot;
}

async function exercise(page) {
  const dialog = page.getByRole('dialog');
  const preview = dialog.getByRole('region', {name: '保存命名存稿', exact: true});
  const entry = dialog.getByRole('button', {name: '保存当前稿件为新存稿', exact: true});
  const name = preview.getByRole('textbox', {name: '存稿名称', exact: true});
  const confirm = preview.getByRole('button', {name: '确认保存存稿', exact: true});
  const cancel = preview.getByRole('button', {name: '取消保存存稿', exact: true});
  const history = page.getByRole('button', {name: '版本记录', exact: true});
  const editor = page.getByRole('textbox', {name: '章节正文', exact: true});
  const guard = page.getByRole('dialog', {name: '这一章还有未保存的修改', exact: true});
  const rows = dialog.locator('[aria-label="选择历史版本"] button[aria-pressed]');
  const closeHistory = async () => {
    await page.keyboard.press('Escape');
    await dialog.waitFor({state: 'hidden'});
  };
  const checkSelected = async snapshot => {
    await dialog.getByRole('heading', {name: snapshot.label, exact: true}).waitFor();
    const selected = rows.filter({has: page.getByText(snapshot.label, {exact: true})});
    assert.equal(await selected.getAttribute('aria-pressed'), 'true');
    await dialog.getByRole('heading', {name: snapshot.title, exact: true}).waitFor();
    for (const chapter of snapshot.chapters) {
      const body = dialog.getByText(chapter.body, {exact: true});
      await body.waitFor();
      assert.equal(await body.textContent(), chapter.body);
    }
  };
  const saveNamed = async (label, before) => {
    await entry.click();
    await name.fill(label);
    await confirm.click();
    await preview.waitFor({state: 'hidden'});
    await page.waitForFunction(({key, id, count}) =>
      JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.versions.length === count,
      {key: storageKey, id: projectId, count: before.versions.length + 1});
    const stored = await readProject(page);
    const snapshot = checkCheckpoint(stored, before, label);
    await checkSelected(snapshot);
    return stored;
  };

  await page.getByTestId('manuscript-prose').filter({visible: true}).waitFor();
  // Mount reconciliation has its own delayed save. Observe its persisted result first.
  await page.waitForFunction(({key, id}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.messages[0]?.turnStatus === 'interrupted',
    {key: storageKey, id: projectId});
  const initial = await readProject(page);
  assert.deepEqual(initial.chapters, chapters);
  assert.deepEqual(initial.versions, [oldVersion]);
  assert.deepEqual(initial.pendingEdits, project.pendingEdits);
  await history.click();
  await rows.filter({has: page.getByText(oldVersion.label, {exact: true})}).click();
  await checkSelected(oldVersion);
  await entry.click();
  await name.fill('应取消的合成存稿');
  await cancel.click();
  await preview.waitFor({state: 'hidden'});
  await page.clock.runFor(500);
  assert.deepEqual(await readProject(page), initial, 'cancel changes no project field');
  await checkSelected(oldVersion);

  await entry.click();
  for (const blank of ['', '   ']) {
    await name.fill(blank);
    assert.equal(await confirm.isDisabled(), true);
    await name.press('Enter');
    await preview.waitFor();
    await page.clock.runFor(500);
    assert.deepEqual(await readProject(page), initial, 'blank names cannot save');
  }
  await cancel.click();
  const first = await saveNamed('渡口检查点 🌕', initial);
  const firstSnapshot = first.versions.at(-1);
  await page.reload();
  await history.click();
  await checkSelected(firstSnapshot);
  assert.deepEqual(await readProject(page), first, 'checkpoint and original project fields survive reload');
  await closeHistory();

  await page.getByRole('tab', {name: '编辑', exact: true}).click();
  const changed = '修改后的渡口。\n纸船驶过新桥。🌒';
  await editor.fill(changed);
  await page.getByRole('button', {name: '保存版本', exact: true}).click();
  await page.waitForFunction(({key, id, body}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.chapters[0].body === body,
    {key: storageKey, id: projectId, body: changed});
  await history.click();
  await entry.waitFor();
  await page.clock.runFor(500);
  const edited = await readProject(page);
  assert.deepEqual(edited.chapters, [{...chapters[0], body: changed}, chapters[1]]);
  assert.deepEqual(edited.pendingEdits, initial.pendingEdits);
  assert.deepEqual(edited.versions.slice(0, first.versions.length), first.versions);
  const second = await saveNamed('修改后的命名存稿', edited);
  assert.deepEqual(second.versions.find(version => version.id === firstSnapshot.id), firstSnapshot);
  await closeHistory();

  // Leave a local draft, dismiss the guard once, then discard it through the same guard.
  const discardedBody = '这段合成草稿应该被舍弃。';
  await editor.fill(discardedBody);
  await history.click();
  await guard.waitFor();
  assert.equal(await preview.count(), 0);
  await page.clock.runFor(500);
  assert.deepEqual(await readProject(page), second, 'uncommitted draft is not persisted');
  await guard.getByRole('button', {name: '继续编辑', exact: true}).click();
  await guard.waitFor({state: 'hidden'});
  assert.equal(await editor.inputValue(), discardedBody);
  await history.click();
  await guard.getByRole('button', {name: '舍弃草稿', exact: true}).click();
  await entry.waitFor();
  await page.clock.runFor(500);
  assert.deepEqual(await readProject(page), second, 'discard keeps the last saved manuscript');
  const discarded = await saveNamed('舍弃草稿后存稿', second);
  assert.equal(discarded.versions.at(-1).chapters[0].body, changed);
  await closeHistory();

  // Saving through the guard creates an editor version before the named checkpoint.
  const guardedBody = '通过保存并继续留下的正文。\n这是第四份命名存稿。';
  await editor.fill(guardedBody);
  await history.click();
  await guard.getByRole('button', {name: '保存并继续', exact: true}).click();
  await entry.waitFor();
  await page.waitForFunction(({key, id, body}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.chapters[0].body === body,
    {key: storageKey, id: projectId, body: guardedBody});
  const guardSaved = await readProject(page);
  assert.equal(guardSaved.versions.length, discarded.versions.length + 1);
  assert.deepEqual(guardSaved.versions.slice(0, -1), discarded.versions);
  assert.deepEqual(guardSaved.versions.at(-1).chapters, guardSaved.chapters);
  assert.deepEqual(guardSaved.pendingEdits, initial.pendingEdits);
  const final = await saveNamed('保存草稿后存稿', guardSaved);
  await page.reload();
  await history.click();
  await checkSelected(final.versions.at(-1));
  assert.deepEqual(await readProject(page), final);
  await rows.filter({has: page.getByText(firstSnapshot.label, {exact: true})}).click();
  await checkSelected(firstSnapshot);
  await page.clock.runFor(500);
  assert.deepEqual(await readProject(page), final, 'viewing the earlier checkpoint remains read-only');
}

async function exerciseAutosaved(page) {
  await page.getByRole('textbox', {name:'章节正文',exact:true}).waitFor();
  await page.waitForFunction(({key,id})=>JSON.parse(localStorage.getItem(key)).projects.find(p=>p.id===id)?.messages[0]?.turnStatus==='interrupted',
    {key:storageKey,id:projectId});
  const before=await readProject(page);
  assert.equal(before.versions.length,0);
  assert.notDeepEqual(before.editorBaseline,before.chapters);
  await page.getByRole('button',{name:'版本记录',exact:true}).click();
  const dialog=page.getByRole('dialog');
  const entry=dialog.getByRole('button',{name:'保存当前稿件为新存稿',exact:true});
  await entry.waitFor();
  await page.clock.runFor(500);
  assert.deepEqual(await readProject(page),before,'opening history preserves autosaved text and undo baseline');
  await entry.click();
  const preview=dialog.getByRole('region',{name:'保存命名存稿',exact:true});
  await preview.getByRole('button',{name:'取消保存存稿',exact:true}).click();
  await page.clock.runFor(500);
  assert.deepEqual(await readProject(page),before,'cancelling first checkpoint retains zero versions and editor baseline');
  await entry.click();
  await preview.getByRole('textbox',{name:'存稿名称',exact:true}).fill('自动保存稿的检查点');
  if(process.env.TALEWICK_SCREENSHOT)await page.screenshot({path:process.env.TALEWICK_SCREENSHOT,fullPage:true});
  await preview.getByRole('button',{name:'确认保存存稿',exact:true}).click();
  await page.waitForFunction(({key,id})=>JSON.parse(localStorage.getItem(key)).projects.find(p=>p.id===id)?.versions.length===1,
    {key:storageKey,id:projectId});
  checkCheckpoint(await readProject(page),before,'自动保存稿的检查点');
}

const runsDir = await mkdtemp(path.join(tmpdir(), 'talewick-checkpoint-'));
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
  const autoContext=await browser.newContext({viewport:{width:1512,height:982},reducedMotion:'reduce'});
  await autoContext.route('**/*',route=>{
    if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}
    if(route.request().method()!=='GET'){mutations.push(route.request().url());return route.abort();}
    return route.continue();
  });
  await autoContext.addInitScript(({origin,storageKey,project,chapters})=>{
    if(window.top!==window||location.origin!==origin||localStorage.getItem(storageKey))return;
    const p={...project,versions:[],docMode:'edit',editorBaseline:chapters,
      chapters:[{...chapters[0],body:'自动保存后的合成正文。'},chapters[1]]};
    localStorage.setItem(storageKey,JSON.stringify({schemaVersion:1,activeProjectId:p.id,projects:[p],
      page:'create',settings:{autoSave:true,reduceMotion:true}}));
  },{origin,storageKey,project,chapters});
  const autoPage=await autoContext.newPage();
  autoPage.setDefaultTimeout(10000); autoPage.on('pageerror',error=>errors.push(error.message));
  await autoPage.clock.install(); await autoPage.goto(origin);
  await exerciseAutosaved(autoPage);
  await autoContext.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(mutations, [], 'local checkpoints need no model or mutation API calls');
  console.log('PASS named checkpoints: cancellation, blank names, exact snapshots, selection, reload, later edits and unsaved-draft guards');
} finally {
  await browser?.close();
  if (runtime) {
    await runtime.close();
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
  }
  await rm(runsDir, {recursive: true, force: true});
}
