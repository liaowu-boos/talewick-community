/** From the GUI directory: npm run build && node scripts/saved-version-fork-browser.mjs.
 * Uses the same Playwright/Chrome environment variables as history-project-switch-browser.mjs.
 */
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRuntime} from '../server/index.mjs';

const storageKey='talewick.boardui.gui.v1';
const date='2026-01-01T00:00:00.000Z';
const projectId='synthetic-fork-source';
const source={id:'saved-source',label:'桥边旧稿',title:'旧稿书名',date,
  chapters:[{id:'old-two',title:'桥边',body:'鸟停在栏杆上。\n\n桥下漂过一片叶子。'},
    {id:'old-one',title:'门前',body:'纸页被风翻过。'}]};
const current=[{id:'current',title:'现在的第一章',body:'当前稿件保持原样。'}];
const task={id:'synthetic-task',requestId:'synthetic-request',projectId:projectId,baseRevision:'synthetic-revision',
  kind:'create',status:'completed',createdAt:date,updatedAt:date,engine:'fixed'};
const project={id:projectId,title:'原作品合成',phase:'done',status:'ready',docOpen:true,docMode:'read',selectedChapter:0,
  chapters:current,versions:[source],pendingEdits:[{id:'suggestion',chapterId:'current',before:'当前',after:'此时',reason:'合成建议',status:'pending'}],
  attachments:[{name:'原项目材料',content:'合成材料'}],libraryIds:['synthetic-library'],styleId:'synthetic-style',
  messages:[{role:'assistant',text:'原项目合成对话',turnId:'synthetic-missing-turn',turnStatus:'running'}],
  runtime:{request:{projectId,requestId:task.requestId,baseRevision:task.baseRevision,kind:'create',idea:'合成创作',chapters:current},
    baseManuscript:{title:'原作品合成',chapters:current},task,handledTaskId:task.id},
  runtimeHistory:[{...task,id:'synthetic-history'}],
  importedBaseline:{provenance:'whole_revision_source',qualityCheckStatus:'incomplete',sourceTaskId:task.id,
    sourceRequestId:task.requestId,title:'原作品合成',baseRevision:task.baseRevision,sourceManuscriptSha256:'b'.repeat(64)}};

const readState=page=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),storageKey);
const textChapters=chapters=>chapters.map(({title,body})=>({title,body}));
async function exercise(page) {
  const dialog=page.getByRole('dialog');
  const preview=dialog.getByRole('region',{name:'从存稿新建作品',exact:true});
  const entry=dialog.getByRole('button',{name:'以此存稿新建作品',exact:true});
  const confirm=preview.getByRole('button',{name:'确认新建作品',exact:true});
  const name=preview.getByRole('textbox',{name:'新作品名称',exact:true});
  await page.getByTestId('manuscript-prose').filter({visible:true}).waitFor();
  await page.waitForFunction(({key,id})=>JSON.parse(localStorage.getItem(key)).projects.find(p=>p.id===id)?.messages[0]?.turnStatus==='interrupted',
    {key:storageKey,id:projectId});
  const original=(await readState(page)).projects.find(p=>p.id===projectId);
  assert.equal(original.runtime.task.id,task.id);
  assert.equal(original.runtimeHistory.length,1);
  assert.equal(original.importedBaseline.sourceTaskId,task.id);
  assert.equal(original.pendingEdits.length,1);
  const review=page.getByRole('region',{name:'独立全文评阅',exact:true});
  await review.locator('summary').filter({hasText:'评阅历史'}).click();
  await review.getByRole('heading',{name:'原作品专属合成报告',exact:true}).waitFor();
  await page.getByRole('button',{name:'版本记录',exact:true}).click();
  await dialog.getByRole('heading',{name:source.title,exact:true}).waitFor();
  await entry.click();
  assert.equal(await name.inputValue(),'旧稿书名（副本）');
  await preview.getByRole('button',{name:'取消新建',exact:true}).click();
  await entry.waitFor();
  await page.clock.runFor(500);
  assert.deepEqual((await readState(page)).projects,[original],'cancel must not alter any project');
  await entry.click();
  await name.fill('   ');
  assert.equal(await confirm.isDisabled(),true);
  await name.press('Enter');
  assert.deepEqual((await readState(page)).projects,[original]);
  await name.fill('独立改写合成');
  if(process.env.TALEWICK_SCREENSHOT)await page.screenshot({path:process.env.TALEWICK_SCREENSHOT,fullPage:true});
  await confirm.click();
  await dialog.waitFor({state:'hidden'});
  await page.getByRole('heading',{name:source.chapters[0].title,level:3,exact:true}).waitFor();
  await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).projects.length===2,storageKey);
  const created=await readState(page);
  const fork=created.projects.find(p=>p.id===created.activeProjectId);
  assert.notEqual(fork.id,projectId);
  assert.equal(fork.title,'独立改写合成');
  assert.equal(fork.mode,'auto');
  assert.deepEqual(textChapters(fork.chapters),textChapters(source.chapters));
  assert.deepEqual(created.projects.find(p=>p.id===projectId),original);
  assert.equal(fork.docMode,'read');
  for(const field of ['runtime','importedBaseline'])assert.equal(fork[field],undefined);
  assert.equal(fork.runtimeHistory?.length??0,0);
  for(const field of ['pendingEdits','attachments','libraryIds'])assert.deepEqual(fork[field],[]);
  assert.equal(fork.styleId,null);
  assert.equal(fork.messages.length,1);
  assert.notEqual(fork.messages[0].text,original.messages[0].text);
  assert.equal(fork.versions.length,1);
  assert.notEqual(fork.versions[0].id,source.id);
  assert.deepEqual(fork.versions[0].chapters,fork.chapters);
  const oldIds=new Set([...current,...source.chapters].map(c=>c.id));
  assert.equal(new Set(fork.chapters.map(c=>c.id)).size,source.chapters.length);
  assert.ok(fork.chapters.every(c=>!oldIds.has(c.id)));
  assert.equal(await page.getByRole('heading',{name:'原作品专属合成报告',exact:true}).count(),0);
  await page.getByText('本机稿件',{exact:true}).waitFor();
  await page.reload();
  await page.getByRole('heading',{name:source.chapters[0].title,level:3,exact:true}).waitFor();
  assert.deepEqual(textChapters((await readState(page)).projects.find(p=>p.id===fork.id).chapters),textChapters(source.chapters));
  await page.getByRole('tab',{name:'编辑',exact:true}).click();
  const changed='独立作品的新正文。\n原作品不随之修改。';
  await page.getByRole('textbox',{name:'章节正文',exact:true}).fill(changed);
  await page.getByRole('button',{name:'保存版本',exact:true}).click();
  await page.waitForFunction(({key,id,body})=>JSON.parse(localStorage.getItem(key)).projects.find(p=>p.id===id)?.chapters[0]?.body===body,
    {key:storageKey,id:fork.id,body:changed});
  await page.reload();
  await page.getByRole('tab',{name:'阅读',exact:true}).click();
  assert.equal(await page.getByTestId('manuscript-prose').filter({visible:true}).textContent(),changed);
  const edited=(await readState(page)).projects.find(p=>p.id===fork.id);
  assert.deepEqual(edited.versions[0],fork.versions[0],'initial snapshot retains the source manuscript');
  await page.getByRole('button',{name:fork.title,exact:true}).click();
  await page.getByRole('dialog',{name:'创作记录'}).getByRole('button').filter({hasText:project.title}).click();
  await page.getByRole('heading',{name:current[0].title,level:3,exact:true}).waitFor();
  assert.equal(await page.getByTestId('manuscript-prose').filter({visible:true}).textContent(),current[0].body);
  const final=await readState(page);
  assert.deepEqual(final.projects.find(p=>p.id===projectId),original);
  assert.equal(final.projects.find(p=>p.id===fork.id).chapters[0].body,changed);
}
const runsDir = await mkdtemp(path.join(tmpdir(), 'talewick-version-fork-'));
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
  const external = [], errors = [], writes = [];
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
  await context.route('**/api/independent-reviews?*', route => {
    const id=new URL(route.request().url()).searchParams.get('projectId');
    return route.fulfill({json:{tasks:[],isolatedReports:id===project.id ? [{
      id:'a'.repeat(64),title:'原作品专属合成报告',createdAt:date,synthetic:true,manuscriptRevision:'synthetic-revision',
    }] : []}});
  });
  const page = await context.newPage();
  page.on('request', request => {if(request.method()!=='GET')writes.push(request.url());});
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.goto(origin);
  await exercise(page);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(writes, [], 'forking and editing require no model or mutation API calls');
  console.log('PASS saved-version fork: cancel, blank name, source isolation, fresh identities, report separation, editing, reload and return to original');
} finally {
  await browser?.close();
  if (runtime) {
    await runtime.close();
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
  }
  await rm(runsDir, {recursive: true, force: true});
}
