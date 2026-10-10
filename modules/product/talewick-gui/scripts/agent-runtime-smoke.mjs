#!/usr/bin/env node
/** Real ToolLoopAgent + real local HTTP/browser; only the language models are mocks.
 * This does not call a remote provider or establish real model/novel quality.
 * Shared fixture exports are also used by server/agent-http.test.mjs.
 */
import assert from 'node:assert/strict';
import { syntheticAdjudication } from './synthetic-adjudication.mjs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { createRuntime } from '../server/index.mjs';

export const originalBodies = ['小禾走进钟楼，发现齿轮松脱，决定亲手修好它。', '她重新装好齿轮。钟响了，她把最后一枚铜钱交给师傅。'];
export const revisedBody = originalBodies[1].replace('铜钱', '银币');
export const secretMarker = 'mock-credential-never-return-this-marker';
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function waitGate(value, signal) {
  signal?.throwIfAborted();
  let abort;
  try { await Promise.race([value.promise, new Promise((_, reject) => {
    abort = () => reject(signal.reason || new Error('Mock call cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
  })]); } finally { if (abort) signal?.removeEventListener('abort', abort); }
  signal?.throwIfAborted();
}
export async function until(predicate, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await pause(50); }
  throw new Error(label);
}

function decisionContext(options) {
  const messages = options.prompt || [];
  let initial = {};
  for (const message of messages) if (message.role === 'user') {
    const text = Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('') : message.content;
    try { const value = JSON.parse(text); if (value && typeof value === 'object' && value.phase) initial = value; } catch { /* Ordinary non-JSON instructions do not supply state. */ }
  }
  const actions = (initial.completedActions || []).map(item => typeof item === 'string' ? item : item.action);
  for (const message of messages) if (message.role === 'assistant' && Array.isArray(message.content)) {
    for (const part of message.content) if (part.type === 'tool-call') actions.push(part.toolName);
  }
  const available = (options.tools || []).map(tool => tool.name);
  return { initial, actions, available, phase: initial.phase || (available.includes('approve_plan') ? 'plan' : 'review') };
}

/** The mock chooses SDK tool calls from actual tool/message state, never calls tools itself. */
export function makeAgentModels({ adjudicationDecision = 'confirm', reviewDecision = 'finish', replan = false, prematureFinish = false, failFixedReviewOnce = false, invalidIssueIndexes = false, pauseBefore } = {}) {
  const controls = { pauseBefore, invalidIssueIndexes, gate: gate(), paused: false };
  const decisions = [];
  const stageCalls = [];
  let fixedReviewFailed = false;
  const agentModel = new MockLanguageModelV4({
    provider: 'explicit-agent-test', modelId: 'mock-tool-decisions',
    doGenerate: async options => {
      options.abortSignal?.throwIfAborted();
      const context = decisionContext(options);
      const { actions, phase } = context;
      let action, input;
      if (phase === 'plan') {
        if (!actions.includes('inspect_plan')) action = 'inspect_plan';
        else if (replan && !actions.includes('revise_plan')) action = 'revise_plan';
        else action = 'approve_plan';
        input = { reason: action === 'revise_plan' ? '测试决策：补清付出代价。' : '测试决策：方案符合两章范围。', ...(action === 'revise_plan' ? { feedback: '第二章明确用最后一枚钱支付修钟代价。' } : {}) };
      } else {
        const revision = actions.lastIndexOf('revise_chapter');
        if (!actions.includes('read_chapter')) action = 'read_chapter';
        else if (reviewDecision === 'revise' && revision < 0) action = 'revise_chapter';
        else if (revision >= 0 && prematureFinish && actions.lastIndexOf('finish_review') < revision) action = 'finish_review';
        else if (revision >= 0 && actions.lastIndexOf('review_manuscript') < revision) action = 'review_manuscript';
        else action = 'finish_review';
        input = { reason: action === 'revise_chapter' ? '测试决策：按有原文证据的问题调整第二章。' : action === 'finish_review' ? '测试决策：保留已审阅正文并结束。' : '测试决策：核对当前稿件。',
          ...(['read_chapter', 'revise_chapter'].includes(action) ? { chapterId: 'ch-2' } : {}),
          ...(action === 'revise_chapter' ? { issueIndexes: [controls.invalidIssueIndexes ? 999 : 0] } : {}) };
      }
      const decision = { phase, action, input, resumed: Boolean(context.initial.resumed), available: context.available, completedActions: (context.initial.completedActions || []).map(item => typeof item === 'string' ? item : item.action) };
      decisions.push(decision);
      if (controls.pauseBefore === action) { controls.paused = true; await waitGate(controls.gate, options.abortSignal); }
      return {
        content: [{ type: 'tool-call', toolCallId: `mock-call-${randomUUID()}`, toolName: action, input: JSON.stringify(input) }],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [],
      };
    },
  });
  const model = { async complete(args) {
    args.signal?.throwIfAborted();
    const input = JSON.parse(args.user);
    stageCalls.push({ stage: args.stage, input });
    if (args.stage === 'review-adjudication') return syntheticAdjudication(input, adjudicationDecision);
    if (args.stage === 'requirements') return JSON.stringify({ summary: '固定测试：山村旧钟。', genre: '测试短故事', pointOfView: '第三人称', setting: '山村', targetHanMin: input.kind === 'revise' ? null : 1, targetHanMax: input.kind === 'revise' ? null : 1000, targetChapterCount: 2, requiredElements: [], prohibitions: [], assumptions: [], completeEnding: true });
    if (['planning', 'agent:replan'].includes(args.stage)) return JSON.stringify({ characterArcs: [{ character: '小禾', experience: '旧钟停摆', belief: '亲手修复', desire: '钟声恢复', fear: '无法修好', change: '担忧到行动', expression: '修理动作' }], emotionalScenes: Array.from({length:2},()=>({experience:'修钟',cognition:'发现问题',action:'修理',expression:'动作',development:'展开现场',echo:'钟声回应'})), materialDecisions: [], psychologyLimitations: ['明确新版测试替身'], title: '旧钟', premise: '旧钟停摆，需要修理。', ending: '小禾修好钟并支付代价。', constraints: [], chapters: [
      { title: '停钟', goal: '发现齿轮松脱，决定修钟。', scenes: ['检查齿轮并决定修理'], continuity: '下一章落实修理', targetHanMin: 80, targetHan: 100, targetHanMax: 120 },
      { title: '钟声', goal: args.stage === 'agent:replan' ? '修好钟，支付最后一枚钱。' : '修好钟。', scenes: ['修好钟并支付代价'], continuity: '承接修理决定，钟响后收束', targetHanMin: 80, targetHan: 100, targetHanMax: 120 },
    ] });
    if (args.stage === 'draft:ch-1') return originalBodies[0];
    if (args.stage === 'draft:ch-2') return originalBodies[1];
    if (['agent:reviseChapter:ch-2', 'revision:ch-2'].includes(args.stage)) {
      if (input.revisionScope?.ranges) return JSON.stringify({ replacements: input.revisionScope.ranges.map(range => ({ start: range.start, end: range.end, quote: range.quote, replacement: range.quote.replace('铜钱', '银币') })) });
      return input.currentChapter.body.replace('铜钱', '银币');
    }
    if (args.stage === 'requestedRevision') {
      if (input.selection) return JSON.stringify({ replacement: input.selection.text.replace('铜钱', '银币') });
      const current = input.chapters.find(chapter => chapter.id === 'ch-2');
      return JSON.stringify({ chapters: [{ id: current.id, body: current.body.replace('铜钱', '银币') }] });
    }
    if (['review', 'revisionReview', 'agent:reviewManuscript'].includes(args.stage)) {
      if (failFixedReviewOnce && !fixedReviewFailed && args.stage === 'review') { fixedReviewFailed = true; throw new Error('Fixed legacy review interrupted for recovery test'); }
      const current = input.chapters.find(chapter => chapter.id === 'ch-2');
      return JSON.stringify({ readingObservations: [], summary: '模拟模型已读取当前测试正文。', issues: current?.body.includes('铜钱') ? [{ chapterId: 'ch-2', category: '物件细节', severity: 'must_fix', quote: '铜钱', explanation: '测试替身指定必修意见：把钱的材质明确为银币。', suggestion: '将铜钱改为银币，保留其他动作。' }] : [], strengths: [], limitations: ['仅验证真实 SDK 与本地任务接通；不是实际模型质量评估。'] });
    }
    if (args.stage === 'continuity-review') return JSON.stringify({
      inputHash: input.inputHash,
      manuscriptSha256: input.manuscriptSha256,
      checkedChapterIds: input.chapters.map(chapter => chapter.id),
      checkedDimensions: ['knowledge', 'obligation', 'physical_state', 'time', 'promise'],
      coverage: { status: 'complete', omissions: [] },
      comparisons: [],
      hintChecks: (input.transitionHints?.hints ?? []).map(hint => ({
        hintId: hint.id, status: 'explained', comparisonIds: [],
        reason: '合成测试已检查该提示，未发现跨章状态冲突。',
      })),
    });
    throw new Error(`Unrecognized ordinary stage in agent fixture: ${args.stage}`);
  } };
  return { model, agentModel, stageCalls, decisions, controls };
}

export const requestFor = extra => ({ projectId: 'agent-http-project', requestId: 'agent-create', kind: 'create', idea: '两章测试：小禾修好山村旧钟。', context: {}, materials: [], style: null, chapters: [], instruction: '', quote: '', baseRevision: 'initial', ...extra });
export const configFor = (runsDir, engine = 'ai-sdk', port = 4326) => ({ baseURL: 'https://example.invalid/v1', apiKey: secretMarker, model: 'explicit-agent-fixture', port, timeoutMs: 30000, runsDir, engine });
export async function startAgentFixture(config, models, distDir) {
  const runtime = await createRuntime({ config, model: models.model, agentModel: models.agentModel, conversationModel: models.conversationModel, ...(distDir ? { distDir } : {}) });
  await new Promise((resolve, reject) => { runtime.server.once('error', reject); runtime.server.listen(config.port === 4326 ? 0 : config.port, '127.0.0.1', resolve); });
  return { ...runtime, base: `http://127.0.0.1:${runtime.server.address().port}`, config, models };
}
export async function closeFixture(runtime) {
  if (!runtime) return;
  runtime.models.controls.pauseBefore = undefined; runtime.models.controls.gate.resolve();
  await runtime.close();
  if (runtime.server.listening) await new Promise(resolve => { runtime.server.close(resolve); runtime.server.closeAllConnections(); });
}
export async function api(runtime, route, body) {
  const response = await fetch(runtime.base + route, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
export async function taskAt(runtime, id, statuses = ['completed']) {
  return until(async () => {
    const response = await api(runtime, `/api/tasks/${id}`); assert.equal(response.status, 200);
    if (statuses.includes(response.body.task.status)) return response.body.task;
    assert.ok(['queued', 'running'].includes(response.body.task.status), `Task stopped: ${response.body.task.status}: ${response.body.task.error || ''}`);
    return false;
  }, 'Timed out waiting for agent fixture task');
}

// Browser conversations use the real SDK and server tools with an explicit mock provider.
function makeConversationModel() {
  return new MockLanguageModelV4({ doStream: async options => {
    const lastUser = options.prompt.findLastIndex(message => message.role === 'user');
    const alreadySubmitted = options.prompt.slice(lastUser + 1).some(message => message.role === 'tool');
    const name = options.tools?.find(t => ['start_creation', 'revise_manuscript'].includes(t.name))?.name;
    const parts = [{ type: 'stream-start', warnings: [] }];
    if (name && !alreadySubmitted) {
      parts.push({ type: 'tool-call', toolCallId: randomUUID(), toolName: name, input: JSON.stringify({ brief: name === 'start_creation' ? '写一个两章的旧钟测试故事。' : '将第二章铜钱修改为银币。' }) });
    } else {
      parts.push({ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: '已提交创作任务，请查看稿件。' }, { type: 'text-end', id: 'reply' });
    }
    const reason = name && !alreadySubmitted ? 'tool-calls' : 'stop';
    parts.push({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
    return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) };
  } });
}

async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function runBrowserSmoke() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dist = path.resolve(process.env.TALEWICK_SMOKE_DIST || path.join(root, 'dist'));
  const reportDir = path.resolve(process.env.TALEWICK_SMOKE_REPORT_DIR || path.join(root, 'agent-evidence', 'browser'));
  const report = { startedAt: new Date().toISOString(), scope: 'Real ToolLoopAgent and HTTP, SDK mock model, isolated browser. No remote model or quality claim.', cases: [], captures: [], pageErrors: [], externalRequests: [] };
  const contexts = [], runtimes = []; let browser;
  const storageKey = 'talewick.boardui.gui.v1';
  const state = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
  const active = value => value.projects.find(project => project.id === value.activeProjectId);
  const waitProject = (page, predicate) => until(async () => { const value = await state(page); return value && active(value) && predicate(active(value)) ? active(value) : false; }, 'Browser task state did not reach the expected state', 60000);
  async function send(page, text) { await page.getByRole('textbox', { name: '创作想法', exact: true }).fill(text); await page.getByRole('button', { name: '发送创作想法', exact: true }).click(); }
  async function check(name, run) { const start = Date.now(); await run(); report.cases.push({ name, status: 'PASS', durationMs: Date.now() - start }); }
  async function pageFor(options) {
    const models = makeAgentModels(options), runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-agent-browser-'));
    models.conversationModel = makeConversationModel();
    const runtime = await startAgentFixture(configFor(runsDir, 'ai-sdk', await freePort()), models, dist); runtimes.push(runtime);
    const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, reducedMotion: 'reduce' }); contexts.push(context);
    await context.route('**/*', route => { const url = route.request().url(); if (url.startsWith(runtime.base + '/') || /^(data:|blob:)/.test(url)) return route.continue(); report.externalRequests.push(url); return route.abort(); });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.goto(runtime.base, { waitUntil: 'domcontentloaded' }); await page.getByRole('textbox', { name: '创作想法', exact: true }).waitFor();
    return { page, runtime, models };
  }
  try {
    await mkdir(reportDir, { recursive: true }); report.distIndexSha256 = createHash('sha256').update(await readFile(path.join(dist, 'index.html'))).digest('hex');
    const module = process.env.TALEWICK_PLAYWRIGHT_MODULE ? await import(pathToFileURL(path.resolve(process.env.TALEWICK_PLAYWRIGHT_MODULE))) : await import('playwright');
    browser = await module.chromium.launch({ headless: true, executablePath: process.env.TALEWICK_BROWSER_EXECUTABLE || undefined });
    const fixture = await pageFor({ reviewDecision: 'finish' });
    await check('agent create survives refresh and exposes real tool decisions in its report', async () => {
      await send(fixture.page, '写一个两章的旧钟测试故事。');
      let project = await waitProject(fixture.page, item => item.runtime?.task?.id);
      const id = project.runtime.task.id;
      await fixture.page.reload({ waitUntil: 'domcontentloaded' });
      project = await waitProject(fixture.page, item => item.runtime?.resultDisposition === 'applied');
      assert.equal(project.runtime.task.id, id); assert.equal(project.runtime.task.engine, 'ai-sdk');
      assert.deepEqual(project.chapters.map(chapter => chapter.body), originalBodies);
      assert.ok(fixture.models.agentModel.doGenerateCalls.length >= 4, 'Real SDK must request multiple mock model steps');
      await fixture.page.getByRole('button', { name: '查看本次结果与检查报告', exact: true }).click();
      const dialog = fixture.page.getByRole('dialog');
      await dialog.getByText('Agent 决策摘要', { exact: true }).waitFor();
      assert.match(await dialog.innerText(), /测试决策/); assert.equal((await dialog.innerText()).includes(secretMarker), false);
      const file = path.join(reportDir, 'agent-decision-report.png'); await fixture.page.screenshot({ path: file, fullPage: true }); report.captures.push(file);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    });
    await check('agent revision remains a proposal until accepted and preserves prior manuscript', async () => {
      const before = active(await state(fixture.page));
      await send(fixture.page, '把第二章的铜钱改成银币，其他内容保留。');
      let project = await waitProject(fixture.page, item => item.runtime?.resultDisposition === 'proposals');
      assert.deepEqual(project.chapters, before.chapters);
      assert.equal(project.runtime.task.engine, 'ai-sdk'); assert.ok(project.runtime.task.result.agentTrace.some(entry => entry.action === 'finish_review'));
      await fixture.page.getByRole('button', { name: '全部采纳', exact: true }).click();
      project = await waitProject(fixture.page, item => item.chapters[1].body === revisedBody);
      assert.equal(project.chapters[0].body, before.chapters[0].body);
      assert.ok(project.versions.some(version => version.chapters[1]?.body === originalBodies[1]));
    });
    await check('cancelled agent resumes the same task without repeating a completed plan revision', async () => {
      const fixture = await pageFor({ replan: true, pauseBefore: 'approve_plan' });
      await send(fixture.page, '写两章旧钟故事，明确主角支付的代价。');
      await until(() => fixture.models.controls.paused, 'Agent mock did not reach the post-replan pause');
      let project = await waitProject(fixture.page, item => item.runtime?.task?.status === 'running');
      const id = project.runtime.task.id;
      await fixture.page.getByRole('button', { name: '取消创作任务', exact: true }).click();
      await waitProject(fixture.page, item => item.runtime?.task?.status === 'cancelled');
      await until(() => !fixture.runtime.tasks.busy, 'Cancelled agent did not finish');
      fixture.models.controls.pauseBefore = undefined; fixture.models.controls.gate.resolve();
      await fixture.page.reload({ waitUntil: 'domcontentloaded' });
      await fixture.page.getByRole('button', { name: '重试任务', exact: true }).click();
      project = await waitProject(fixture.page, item => item.runtime?.resultDisposition === 'applied');
      assert.equal(project.runtime.task.id, id);
      assert.equal(fixture.models.stageCalls.filter(call => call.stage === 'agent:replan').length, 1);
      assert.equal(project.runtime.task.result.agentTrace.filter(entry => entry.action === 'revise_plan').length, 1);
    });
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []); report.status = 'PASS';
  } catch (error) { report.status = 'FAIL'; report.error = error.stack || String(error); process.exitCode = 1; }
  finally {
    for (const context of contexts) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    for (const runtime of runtimes) await closeFixture(runtime).catch(() => {});
    report.finishedAt = new Date().toISOString(); await mkdir(reportDir, { recursive: true });
    const filename = path.join(reportDir, `agent-runtime-smoke-${report.startedAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(filename, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: report.status, report: filename, cases: report.cases, error: report.error }, null, 2));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runBrowserSmoke();
