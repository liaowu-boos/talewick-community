import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from './index.mjs';
import { adjudicationFingerprint, createAdjudicationInput, validateAdjudication } from '../../../validation/runtime/review-adjudication.mjs';

// Integration of the real HTTP server, task storage and default fixed workflow.
// The only replacement is an explicit model stub. No external API is called and
// these tiny fixed texts do not validate real novels, model quality or Full15.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const originalBodies = [
  '小禾听不见钟声。她走进钟楼，发现齿轮已经松脱，决定亲手修好它。',
  '她重新装好齿轮。钟响了，小禾把最后一枚铜钱留给教她修钟的师傅。',
];

function modelStub() {
  const calls = [];
  return {
    calls,
    async complete(args) {
      calls.push(args);
      args.signal?.throwIfAborted();
      const input = JSON.parse(args.user);
      if (args.stage === 'requirements') return JSON.stringify({
        summary: '测试用旧钟故事。', genre: '测试短故事', pointOfView: '第三人称', setting: '山村',
        targetHanMin: input.kind === 'revise' ? null : 1,
        targetHanMax: input.kind === 'revise' ? null : 1000,
        targetChapterCount: 2, requiredElements: [], prohibitions: [], assumptions: [], completeEnding: true,
      });
      if (args.stage === 'planning') {
        await pause(40);
        return JSON.stringify({ characterArcs: [{ character: '小禾', experience: '旧钟停摆', belief: '亲手修复', desire: '钟声恢复', fear: '无法修好', change: '担忧到行动', expression: '修理动作' }], emotionalScenes: Array.from({length:2},()=>({experience:'修钟',cognition:'发现问题',action:'修理',expression:'动作',development:'展开现场',echo:'钟声回应'})), materialDecisions: [], psychologyLimitations: ['明确新版测试替身'], title: '旧钟', premise: '旧钟停摆', ending: '修好了钟', constraints: [], chapters: [
          { title: '停钟', goal: '发现齿轮松脱，决定修钟', scenes: ['检查齿轮并决定修理'], continuity: '下一章落实修理', targetHanMin: 80, targetHan: 100, targetHanMax: 120 },
          { title: '钟声', goal: '修好钟并付出最后的铜钱', scenes: ['装好齿轮并交付铜钱'], continuity: '承接修理决定，钟响后收束', targetHanMin: 80, targetHan: 100, targetHanMax: 120 },
        ] });
      }
      if (args.stage === 'draft:ch-1') return originalBodies[0];
      if (args.stage === 'draft:ch-2') return originalBodies[1];
      if (args.stage === 'requestedRevision') return JSON.stringify({ chapters: [
        { id: input.chapters[1].id, body: input.chapters[1].body.replace('铜钱', '银币') },
      ] });
      if (args.stage === 'review') return JSON.stringify({
        readingObservations: [], summary: '固定 stub 已收到完整测试正文；未做真实模型评阅。', issues: [], strengths: [],
        limitations: ['本响应仅用于 HTTP 和持久化集成测试。'],
      });
      throw new Error(`Unexpected model stub stage: ${args.stage}`);
    },
  };
}

const configFor = (runsDir, configured = true) => ({
  baseURL: 'https://example.invalid/v1', apiKey: configured ? 'fixed-http-test-placeholder' : '',
  model: 'fixed-http-test-stub', port: 4326, timeoutMs: 1000, runsDir,
});
const requestFor = (extra = {}) => ({
  projectId: 'http-project', requestId: 'create-request', kind: 'create',
  idea: '写一个关于山村旧钟的短故事。', context: {}, materials: [], style: null,
  chapters: [], instruction: '', quote: '', baseRevision: 'initial-version', ...extra,
});

async function startRuntime(config, model) {
  // Intentionally omit workflow: this exercises createRuntime's actual default runWorkflow.
  const runtime = await createRuntime({ config, model });
  try {
    await new Promise((resolve, reject) => {
      runtime.server.once('error', reject);
      runtime.server.listen(0, '127.0.0.1', () => { runtime.server.off('error', reject); resolve(); });
    });
    return { ...runtime, base: `http://127.0.0.1:${runtime.server.address().port}` };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

async function closeRuntime(runtime) {
  if (!runtime) return;
  await runtime.close();
  if (runtime.server.listening) {
    await new Promise((resolve, reject) => {
      runtime.server.close((error) => error ? reject(error) : resolve());
      runtime.server.closeAllConnections();
    });
  }
}

async function api(runtime, route, { method = 'GET', body, headers = {} } = {}) {
  // No Origin for ordinary calls: the temporary test port differs from configured UI origins.
  const response = await fetch(`${runtime.base}${route}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}

async function completed(runtime, id) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const result = await api(runtime, `/api/tasks/${id}`);
    assert.equal(result.status, 200);
    const task = result.body.task;
    if (task.status === 'completed') return task;
    assert.ok(['queued', 'running'].includes(task.status), `Task stopped as ${task.status}: ${task.error ?? ''}`);
    await pause(100);
  }
  throw new Error('Timed out waiting for the fixed workflow integration task.');
}

test('HTTP create and revise use the real workflow, persist checks and preserve the old manuscript', async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-http-flow-'));
  const model = modelStub();
  let runtime;
  try {
    runtime = await startRuntime(configFor(runsDir), model);
    const status = await api(runtime, '/api/runtime');
    assert.equal(status.status, 200);
    assert.equal(status.body.configured, true);
    assert.equal(JSON.stringify(status.body).includes('fixed-http-test-placeholder'), false);

    const submitted = await api(runtime, '/api/tasks', { method: 'POST', body: requestFor() });
    assert.equal(submitted.status, 202);
    assert.ok(['queued', 'running'].includes(submitted.body.task.status));
    const first = await completed(runtime, submitted.body.task.id);
    assert.deepEqual(first.result.chapters.map((chapter) => chapter.body), originalBodies);
    assert.equal(first.result.runtimeVersion, 'fixed-workflow-2');
    assert.equal(first.result.checks.full15.status, 'NOT_EVALUATED');
    assert.equal(first.result.checks.literaryQuality, 'NOT_ASSESSED');
    assert.equal(first.result.checks.chapterCount, 2);

    const firstDir = path.join(runsDir, first.id);
    const oldText = await readFile(path.join(firstDir, 'manuscript.txt'), 'utf8');
    const oldResultBytes = await readFile(path.join(firstDir, 'result.json'), 'utf8');
    const oldResult = JSON.parse(oldResultBytes);
    assert.match(oldText, /旧钟/);
    assert.match(oldText, /铜钱/);
    assert.deepEqual(oldResult.checks, first.result.checks);
    assert.equal(JSON.parse(await readFile(path.join(firstDir, 'task.json'), 'utf8')).status, 'completed');
    const artifacts = JSON.parse(await readFile(path.join(firstDir, 'artifacts.json'), 'utf8'));
    assert.equal(artifacts['draft:ch-1'].body, originalBodies[0]);
    assert.equal(artifacts.result.checks.manuscriptSha256, first.result.checks.manuscriptSha256);

    const revisionInput = requestFor({
      requestId: 'revise-request', kind: 'revise', baseRevision: first.result.checks.manuscriptSha256,
      chapters: first.result.chapters, instruction: '把第二章的铜钱改成银币，其余内容保持原样。', quote: '铜钱',
    });
    const submittedRevision = await api(runtime, '/api/tasks', { method: 'POST', body: revisionInput });
    assert.equal(submittedRevision.status, 202);
    assert.notEqual(submittedRevision.body.task.id, first.id);
    const revision = await completed(runtime, submittedRevision.body.task.id);
    assert.equal(revision.kind, 'revise');
    assert.equal(revision.result.chapters[0].body, originalBodies[0]);
    assert.match(revision.result.chapters[1].body, /银币/);
    assert.equal(revision.result.baseRevision, first.result.checks.manuscriptSha256);
    assert.equal(revision.result.review.phase, 'after_requested_revision');
    assert.equal(revision.result.review.manuscriptSha256, revision.result.checks.manuscriptSha256);
    assert.notEqual(revision.result.checks.manuscriptSha256, first.result.checks.manuscriptSha256);
    assert.match(await readFile(path.join(runsDir, revision.id, 'manuscript.txt'), 'utf8'), /银币/);
    assert.equal(await readFile(path.join(firstDir, 'manuscript.txt'), 'utf8'), oldText);
    assert.equal(await readFile(path.join(firstDir, 'result.json'), 'utf8'), oldResultBytes);
    const publicOldResult = (await api(runtime, `/api/tasks/${first.id}`)).body.task.result;
    const { reviewAdjudicationBinding, ...storedFields } = publicOldResult;
    // The HTTP-only binding is derived metadata; every persisted field must remain identical.
    assert.deepEqual(storedFields, oldResult);
    assert.deepEqual(publicOldResult, first.result);
    assert.equal(Object.hasOwn(oldResult, 'reviewAdjudicationBinding'), false);
    assert.equal(Object.hasOwn(artifacts.result, 'reviewAdjudicationBinding'), false);
    const checked = validateAdjudication(oldResult.reviewAdjudication, createAdjudicationInput({
      chapters: oldResult.chapters, review: oldResult.review, requirements: oldResult.requirements,
    }));
    assert.equal(reviewAdjudicationBinding.status, 'bound');
    assert.equal(reviewAdjudicationBinding.manuscriptSha256, oldResult.checks.manuscriptSha256);
    assert.equal(reviewAdjudicationBinding.adjudicationSha256, adjudicationFingerprint(checked));
    assert.equal(checked.modelReviewPassed, false);
    assert.equal(checked.semanticValidity, 'not_evaluated');
    assert.equal(checked.systemGo, false);
    assert.equal(await readFile(path.join(firstDir, 'result.json'), 'utf8'), oldResultBytes);
    const listed = await api(runtime, '/api/tasks?projectId=http-project');
    assert.equal(listed.body.tasks.length, 2);
    assert.equal(model.calls.filter(({ stage }) => stage === 'requestedRevision').length, 1);
    for (const call of model.calls.filter(({ stage }) => stage === 'review')) {
      assert.deepEqual(Object.keys(JSON.parse(call.user)).sort(), ['chapters', 'requirements']);
    }
  } finally {
    await closeRuntime(runtime);
    await rm(runsDir, { recursive: true, force: true });
  }
});

test('unconfigured HTTP runtime remains readable and refuses creation without inventing a draft', async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-http-unconfigured-'));
  const model = modelStub();
  let runtime;
  try {
    runtime = await startRuntime(configFor(runsDir, false), model);
    const status = await api(runtime, '/api/runtime');
    assert.equal(status.status, 200);
    assert.equal(status.body.configured, false);
    const submitted = await api(runtime, '/api/tasks', { method: 'POST', body: requestFor() });
    assert.equal(submitted.status, 503);
    assert.match(submitted.body.error, /尚未配置/);
    assert.deepEqual((await api(runtime, '/api/tasks')).body.tasks, []);
    assert.equal(model.calls.length, 0);
    assert.equal((await readdir(runsDir, { withFileTypes: true })).filter((entry) => /^[a-f0-9-]{36}$/.test(entry.name)).length, 0);
  } finally {
    await closeRuntime(runtime);
    await rm(runsDir, { recursive: true, force: true });
  }
});

test('cross-origin HTTP requests are rejected before any task or model call', async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-http-origin-'));
  const model = modelStub();
  let runtime;
  try {
    runtime = await startRuntime(configFor(runsDir), model);
    const rejected = await api(runtime, '/api/tasks', {
      method: 'POST', body: requestFor(), headers: { Origin: 'https://unrelated.example' },
    });
    assert.equal(rejected.status, 403);
    assert.match(rejected.body.error, /当前页面不能访问/);
    assert.deepEqual((await api(runtime, '/api/tasks')).body.tasks, []);
    assert.equal(model.calls.length, 0);
  } finally {
    await closeRuntime(runtime);
    await rm(runsDir, { recursive: true, force: true });
  }
});

test('a second runtime cannot take ownership of a live runsDir', async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-http-ownership-'));
  let runtime;
  let unexpectedSecond;
  try {
    const config = configFor(runsDir);
    runtime = await startRuntime(config, modelStub());
    await assert.rejects(async () => {
      unexpectedSecond = await createRuntime({ config, model: modelStub() });
    }, /已有创作服务/);
    assert.equal((await api(runtime, '/api/runtime')).status, 200);
    assert.equal((await readdir(path.join(runsDir, '.runtime-owners'))).length, 1);
  } finally {
    await closeRuntime(unexpectedSecond);
    await closeRuntime(runtime);
    await rm(runsDir, { recursive: true, force: true });
  }
});
