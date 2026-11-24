/** Run from the GUI directory, or set TALEWICK_GUI_ROOT to it.
 * Uses the existing dist and the standard TALEWICK Playwright/Chrome variables.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const guiRoot = path.resolve(process.env.TALEWICK_GUI_ROOT || process.cwd());
const {createRuntime} = await import(pathToFileURL(path.join(guiRoot, 'server/index.mjs')));
const {productManuscriptRevision} = await import(pathToFileURL(path.join(guiRoot, 'server/full15-service.mjs')));
const storageKey = 'talewick.boardui.gui.v1';
const date = '2026-01-01T00:00:00.000Z';
const sourceTitle = '桥边合成手记';
const sourceChapters = [
  {id: 'pier', title: '渡口', body: '纸船在清晨靠岸。\n桥边响起钟声。'},
  {id: 'bridge', title: '木桥', body: '清晨的钟声传到木桥上。'},
];
const candidateChapters = [{...sourceChapters[0], body: '纸船在清晨靠岸。\n桥头的铜钟响了。'}, sourceChapters[1]];
const sourceRevision = productManuscriptRevision(sourceTitle, sourceChapters);
const candidateSha = createHash('sha256').update(JSON.stringify(candidateChapters)).digest('hex');
const evidenceQuote = '纸船在清晨靠岸。';
const staleNotice = '当前书名或正文已变化，此候选对应旧稿。可查看历史复查报告；如需继续修订，请基于当前稿件发起新任务。';

function fixture(applied) {
  const id = applied ? 'synthetic-adopted-title' : 'synthetic-candidate-title';
  const result = {title: sourceTitle, chapters: candidateChapters, baseRevision: sourceRevision,
    wholeRevision: {schemaVersion: 'whole-manuscript-quality-1', status: 'candidate_ready',
      sourceChapters, sourceTitle, diff: {changedChapterIds: ['pier']},
      plan: {items: []}, quality: {independentReading: {summary: '合成独立阅读全文记录'}, unresolved: []},
      adoption: {groups: []}}};
  const task = {id: id + '-task', projectId: id, requestId: id + '-request', baseRevision: sourceRevision,
    kind: 'revise', revisionMode: 'whole-manuscript-v2', status: 'completed', stage: 'completed',
    engine: 'fixed', engineVersion: 'fixed-workflow-2', createdAt: date, updatedAt: date, result};
  const recheck = {id: id + '-recheck', projectId: id, sourceTaskId: task.id, candidateSha256: candidateSha,
    checkerVersion: 'candidate-recheck-cross-chapter-review-r08-1', createdAt: date, updatedAt: date,
    status: 'reviewed_no_reported_conflict', stage: 'complete',
    gate: {eligible: true, reason: 'replay_required_on_selection'}, error: null,
    report: {checkedChapterIds: ['pier', 'bridge'], counts: {confirmed_conflict: 0, ambiguous: 0, resolved: 1},
      findings: [{groupId: 'synthetic-dawn', status: 'resolved', summary: '两处钟声均发生在清晨。',
        sameEventDecision: 'same_event', resolutionReason: '合成引文明确记录相同时段',
        evidence: [{chapterId: 'pier', claimId: 'synthetic-claim', role: 'source', quote: evidenceQuote}]}]}};
  const sourceVersion = {id: id + '-source', label: '合成原始全文', title: sourceTitle, date, chapters: sourceChapters};
  const project = {id, title: sourceTitle, chapters: applied ? candidateChapters : sourceChapters,
    phase: 'complete', status: 'ready', docMode: 'read', docOpen: true, selectedChapter: 0,
    versions: [sourceVersion], pendingEdits: [],
    messages: [{role: 'assistant', text: '合成同步标记', turnId: id + '-missing-turn', turnStatus: 'running'}],
    importedBaseline: {provenance: 'whole_revision_source', sourceTaskId: task.id, sourceRequestId: task.requestId,
      title: sourceTitle, baseRevision: sourceRevision, sourceManuscriptSha256: 'c'.repeat(64), qualityCheckStatus: 'incomplete'},
    runtime: {request: {projectId: id, requestId: task.requestId, baseRevision: sourceRevision, kind: 'revise',
      revisionMode: 'whole-manuscript-v2', idea: '合成整稿修订', chapters: sourceChapters, projectTitle: sourceTitle},
      baseManuscript: {title: sourceTitle, chapters: sourceChapters}, task, handledTaskId: task.id,
      resultDisposition: applied ? 'applied' : 'whole-quality-groups'},
    runtimeHistory: [task]};
  if (applied) project.runtime.candidateRecheckSelection = {
    id: recheck.id, sourceTaskId: task.id, candidateSha256: candidateSha,
    checkerVersion: recheck.checkerVersion, selectedAt: date,
  };
  return {project, task, recheck};
}

async function readProject(page, id) {
  return page.evaluate(({key, id}) => JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id),
    {key: storageKey, id});
}

async function exercise(page, data, applied) {
  const {project, task, recheck} = data;
  const dialog = page.getByRole('dialog');
  const candidateDialog = page.getByRole('dialog', {name: '整稿候选与原稿', exact: true});
  const panel = candidateDialog.getByRole('region', {name: '候选独立事实复查', exact: true});
  const start = panel.getByRole('button', {name: '新建候选复查', exact: true});
  const select = panel.getByRole('button', {name: '明确选择完整候选', exact: true});
  const sourceBanner = '来源存稿《' + sourceTitle + '》 · 原稿检查未完成';
  const openCandidate = async () => {
    await page.getByRole('button', {name: '查看候选与原稿', exact: true}).click();
    await panel.getByText('未报告待决跨章冲突', {exact: false}).waitFor();
  };
  const checkEvidence = async () => {
    const details = panel.locator('details');
    await details.locator('summary').click();
    await panel.locator('blockquote').getByText(evidenceQuote, {exact: true}).waitFor();
    assert.equal(await panel.locator('blockquote p').textContent(), evidenceQuote);
    await details.locator('summary').click();
  };
  const checkBlocked = async () => {
    await panel.getByText(staleNotice, {exact: true}).waitFor();
    assert.equal(await start.isDisabled(), true);
    assert.equal(await select.count(), 1, 'successful historical recheck remains visible');
    assert.equal(await select.isDisabled(), true, 'old candidate cannot be selected again');
    await checkEvidence();
  };
  const closeCandidate = async () => {
    await page.keyboard.press('Escape');
    await candidateDialog.waitFor({state: 'hidden'});
  };

  await page.getByTestId('manuscript-prose').filter({visible: true}).waitFor();
  await page.waitForFunction(({key, id}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.messages[0]?.turnStatus === 'interrupted',
    {key: storageKey, id: project.id});
  const before = await readProject(page, project.id);
  assert.equal(before.runtime.task.id, task.id);
  assert.equal(before.runtime.task.status, 'completed');
  assert.equal(before.runtime.request.revisionMode, 'whole-manuscript-v2');
  assert.equal(before.runtime.handledTaskId, task.id);
  assert.deepEqual(before.runtime.task.result.chapters, candidateChapters);
  assert.equal(before.runtime.task.result.wholeRevision.schemaVersion, 'whole-manuscript-quality-1');
  assert.deepEqual(before.runtime.baseManuscript, {title: sourceTitle, chapters: sourceChapters});
  assert.equal(before.importedBaseline.baseRevision, sourceRevision);
  assert.equal(before.runtime.resultDisposition, applied ? 'applied' : 'whole-quality-groups');
  if (applied) {
    assert.equal(before.runtime.candidateRecheckSelection.id, recheck.id);
    await page.getByText('整稿候选已采纳', {exact: true}).waitFor();
    await page.getByText(sourceBanner, {exact: true}).waitFor();
  } else {
    await page.getByText('原始全文 · 原稿检查未完成', {exact: true}).waitFor();
    assert.equal(productManuscriptRevision(before.title, before.chapters), sourceRevision);
  }
  await openCandidate();
  if (applied) await checkBlocked();
  else {
    assert.equal(await start.isEnabled(), true, 'unchanged source can start a recheck');
    assert.equal(await select.isEnabled(), true, 'synthetic successful recheck is eligible before renaming');
    assert.equal(await panel.getByText(staleNotice, {exact: true}).count(), 0);
    await checkEvidence();
  }
  await closeCandidate();

  const newTitle = applied ? '已采纳稿的新书名' : '待选候选的新书名';
  await page.getByRole('button', {name: '修改书名', exact: true}).click();
  const rename = page.getByRole('region', {name: '修改作品书名', exact: true});
  await rename.getByRole('textbox', {name: '新书名', exact: true}).fill(newTitle);
  await rename.getByRole('button', {name: '确认修改书名', exact: true}).click();
  await dialog.waitFor({state: 'hidden'});
  await page.waitForFunction(({key, id, title}) =>
    JSON.parse(localStorage.getItem(key)).projects.find(item => item.id === id)?.title === title,
    {key: storageKey, id: project.id, title: newTitle});
  const renamed = await readProject(page, project.id);
  assert.deepEqual(renamed.chapters, before.chapters);
  assert.deepEqual(renamed.runtime, before.runtime, 'rename preserves candidate task and review identities');
  assert.deepEqual(renamed.runtimeHistory, before.runtimeHistory);
  assert.deepEqual(renamed.importedBaseline, before.importedBaseline);
  assert.deepEqual(renamed.versions.slice(0, -2), before.versions);
  assert.equal(renamed.versions.length, before.versions.length + 2);
  await page.getByText(sourceBanner, {exact: true}).waitFor();
  assert.equal(await page.getByText('原始全文 · 原稿检查未完成', {exact: true}).count(), 0);
  await openCandidate();
  await checkBlocked();
  await closeCandidate();

  await page.reload();
  await page.getByRole('button', {name: newTitle, exact: true}).waitFor();
  await page.getByText(sourceBanner, {exact: true}).waitFor();
  await openCandidate();
  await checkBlocked();
  await closeCandidate();
  const reloaded = await readProject(page, project.id);
  assert.equal(reloaded.title, newTitle);
  assert.deepEqual(reloaded.chapters, before.chapters);
  assert.equal(reloaded.runtime.resultDisposition, before.runtime.resultDisposition);
  assert.equal(reloaded.runtime.task.id, task.id);
  assert.equal(reloaded.runtime.request.baseRevision, sourceRevision);
  assert.deepEqual(reloaded.importedBaseline, before.importedBaseline);
  assert.deepEqual(reloaded.versions, renamed.versions);
  console.log('PASS ' + (applied ? 'already-adopted candidate stays historical' : 'renamed source disables new recheck and selection') + '; evidence and source identity survive reload');
}

const runsDir = await mkdtemp(path.join(tmpdir(), 'talewick-candidate-title-'));
let runtime, browser;
try {
  const socket = createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const {port} = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  runtime = await createRuntime({config: {port, runsDir, apiKey: '', model: 'offline',
    baseURL: 'https://example.invalid/v1', timeoutMs: 1000}});
  await new Promise((resolve, reject) => runtime.server.once('error', reject).listen(port, '127.0.0.1', resolve));
  const playwright = process.env.TALEWICK_PLAYWRIGHT_MODULE
    ? await import(pathToFileURL(path.resolve(process.env.TALEWICK_PLAYWRIGHT_MODULE))) : await import('playwright');
  browser = await playwright.chromium.launch({headless: true, executablePath: process.env.TALEWICK_BROWSER_EXECUTABLE || undefined});
  const external = [], mutations = [], errors = [];
  for (const applied of [false, true]) {
    const data = fixture(applied);
    const context = await browser.newContext({viewport: {width: 1512, height: 982}, reducedMotion: 'reduce'});
    let recheckReads = 0;
    try {
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
        if (request.method() !== 'GET') { mutations.push(request.url()); return route.abort(); }
        if (url.pathname === '/api/candidate-rechecks') {
          assert.equal(url.searchParams.get('projectId'), data.project.id);
          recheckReads++;
          return route.fulfill({json: {tasks: [data.recheck]}});
        }
        if (url.pathname === '/api/tasks/' + data.task.id) return route.fulfill({json: {task: data.task}});
        return route.continue();
      });
      await context.addInitScript(({origin, key, project}) => {
        if (window.top !== window || location.origin !== origin || localStorage.getItem(key)) return;
        localStorage.setItem(key, JSON.stringify({schemaVersion: 1, activeProjectId: project.id, projects: [project],
          page: 'create', settings: {autoSave: false, reduceMotion: true}}));
      }, {origin, key: storageKey, project: data.project});
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install();
      await page.goto(origin);
      await exercise(page, data, applied);
      assert.ok(recheckReads >= 3, 'candidate history was loaded before rename, after rename and after reload');
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(mutations, [], 'no model submission or mutation API request');
  console.log('PASS no browser errors, external requests or mutation API calls');
} finally {
  await browser?.close();
  if (runtime) {
    await runtime.close();
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
  }
  await rm(runsDir, {recursive: true, force: true});
}
