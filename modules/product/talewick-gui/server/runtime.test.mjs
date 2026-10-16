import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskService, validateRequest } from './tasks.mjs';
import { loadConfig, publicConfig } from './config.mjs';
import { createModel } from './model.mjs';

const request = extra => ({ projectId: 'project-1', requestId: 'request-1', kind: 'create', idea: '一篇关于归还钥匙的短篇小说', context: {}, materials: [], style: null, baseRevision: 'initial', ...extra });
const result = { title: '钥匙', chapters: [{ id: 'c1', title: '第一章', body: '她把钥匙放回桌上。' }], review: { summary: '固定测试响应，未做真实模型评阅。' }, warnings: [], checks: {}, knowledge: {} };
function anchoredRequest() {
  const quote = '门还开着。';
  const body = `😀开头：${quote}\n又过了一会。\n${quote}`;
  return request({ kind: 'revise', projectTitle: '重复的门', instruction: '只改所选第二处', quote,
    chapters: [{ id: 'repeat-chapter', title: '第一章', body }], quoteSource: { chapterId: 'repeat-chapter', start: body.lastIndexOf(quote) } });
}
async function until(fn) {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t, workflow, options = {}) {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-task-test-'));
  const service = await new TaskService({ runsDir, model: { complete: async () => 'test only' }, workflow, ...options }).init();
  t.after(async () => { await service.close(); await until(() => !service.busy); await rm(runsDir, { recursive: true, force: true }); });
  return { service, runsDir };
}

test('a synchronous completion hook failure cannot reverse a completed task', async t => {
  let hookCalls = 0;
  const { service, runsDir } = await fixture(t, async () => structuredClone(result), {
    onCompleted() { hookCalls++; throw new Error('isolated auxiliary queue failure'); },
  });
  const task = await service.create(request());
  await until(() => service.get(task.id).status === 'completed' && !service.busy);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hookCalls, 1);
  assert.equal(service.get(task.id).status, 'completed');
  assert.equal(JSON.parse(await readFile(path.join(runsDir, task.id, 'task.json'), 'utf8')).status, 'completed');
  assert.deepEqual(JSON.parse(await readFile(path.join(runsDir, task.id, 'result.json'), 'utf8')), result);
});

test('concurrent duplicate submission executes once and rejects conflicting identity', async t => {
  let calls = 0;
  const { service, runsDir } = await fixture(t, async () => { calls++; return structuredClone(result); });
  const [a, b] = await Promise.all([service.create(request()), service.create(request())]);
  assert.equal(a.id, b.id);
  await assert.rejects(service.create(request({ idea: 'changed request' })), { status: 409 });
  await until(() => service.get(a.id).status === 'completed');
  assert.equal(calls, 1);
  assert.match(await readFile(path.join(runsDir, a.id, 'manuscript.txt'), 'utf8'), /钥匙/);
  assert.equal(service.get(a.id).requestId, 'request-1');
});

test('task input rejects malformed or mismatched anchors before scheduling work', async t => {
  let workflowCalls = 0;
  const { service } = await fixture(t, async () => { workflowCalls++; return structuredClone(result); });
  const input = anchoredRequest();
  const normalized = validateRequest(input);
  assert.deepEqual(normalized.quoteSource, input.quoteSource);
  assert.equal(normalized.projectTitle, input.projectTitle);
  const invalid = [null, [], {},
    { chapterId: 'repeat-chapter', start: String(input.quoteSource.start) },
    { chapterId: 'repeat-chapter', start: -1 },
    { chapterId: 'repeat-chapter', start: 0.5 },
    { chapterId: 'repeat-chapter', start: Number.MAX_SAFE_INTEGER + 1 },
    { chapterId: 'missing-chapter', start: input.quoteSource.start },
    { chapterId: 'repeat-chapter', start: 0 },
  ];
  for (const quoteSource of invalid) await assert.rejects(service.create({ ...input, quoteSource }), { status: 400 });
  await assert.rejects(service.create({ ...input, quote: '' }), { status: 400 });
  assert.deepEqual(service.list(), []);
  assert.equal(workflowCalls, 0);
});

test('a request id binds its exact UTF-16 anchor and the persisted selection', async t => {
  let workflowCalls = 0;
  const { service, runsDir } = await fixture(t, async () => { workflowCalls++; return structuredClone(result); });
  const input = anchoredRequest();
  const task = await service.create(input);
  await until(() => service.get(task.id).status === 'completed');
  const saved = JSON.parse(await readFile(path.join(runsDir, task.id, 'request.json'), 'utf8'));
  assert.deepEqual(saved.quoteSource, input.quoteSource);
  assert.deepEqual(saved.chapters, input.chapters);
  assert.equal((await service.create(input)).id, task.id);
  const firstOccurrence = input.chapters[0].body.indexOf(input.quote);
  await assert.rejects(service.create({ ...input, quoteSource: { ...input.quoteSource, start: firstOccurrence } }), { status: 409 });
  assert.equal(workflowCalls, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(runsDir, task.id, 'request.json'), 'utf8')).quoteSource, input.quoteSource);
});

test('failed task resumes from completed checkpoints on the same id', async t => {
  let stepOne = 0, attempts = 0;
  const { service } = await fixture(t, async ({ artifacts, checkpoint }) => {
    attempts++;
    if (!artifacts.first) { stepOne++; await checkpoint('first', { complete: true }); }
    if (attempts === 1) throw new Error('temporary model failure');
    return structuredClone(result);
  });
  const first = await service.create(request());
  await until(() => service.get(first.id).status === 'failed' && !service.busy);
  assert.equal((await service.resume(first.id)).id, first.id);
  await until(() => service.get(first.id).status === 'completed');
  assert.equal(stepOne, 1);
  assert.equal(attempts, 2);
});

test('model attempt diagnostics survive failure and resume without saving partial prose or private payloads', async t => {
  let earlierWrites = 0, calls = 0;
  const { service, runsDir } = await fixture(t, async ({ artifacts, checkpoint, model }) => {
    if (!artifacts.earlier) { earlierWrites++; await checkpoint('earlier', { complete: true }); }
    const body = await model.complete({ stage: 'draft:ch-6', system: 'private-prompt-marker', user: 'private-input-marker', maxTokens: 6500 });
    await checkpoint('draft:ch-6', { body });
    return structuredClone(result);
  });
  service.model = createModel({ baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: 'private-key-marker', timeoutMs: 1000 }, async () => {
    calls++;
    return Response.json({ choices: [{ finish_reason: calls <= 2 ? 'length' : 'stop', message: { content: calls <= 2 ? 'private-partial-marker' : '完成本章。', reasoning_content: 'private-reasoning-marker' } }] });
  });
  const first = await service.create(request());
  await until(() => service.get(first.id).status === 'failed' && !service.busy);
  const taskFile = path.join(runsDir, first.id, 'task.json');
  const failed = JSON.parse(await readFile(taskFile, 'utf8'));
  assert.deepEqual(failed.modelAttempts.map(a => [a.stage, a.mode, a.maxOutputTokens, a.finishReason]), [['draft:ch-6', 'primary', 32768, 'length'], ['draft:ch-6', 'recovery', 6500, 'length']]);
  assert.match(failed.error, /第 6 章写作/);
  assert.doesNotMatch(JSON.stringify(failed), /private-(prompt|input|key|partial|reasoning)-marker/);
  assert.deepEqual(JSON.parse(await readFile(path.join(runsDir, first.id, 'artifacts.json'), 'utf8')), { earlier: { complete: true } });
  await service.resume(first.id);
  await until(() => service.get(first.id).status === 'completed' && !service.busy);
  assert.equal(earlierWrites, 1);
  assert.equal(calls, 3);
  const done = JSON.parse(await readFile(taskFile, 'utf8'));
  assert.equal(done.modelAttempts.length, 3);
  assert.equal(done.modelAttempts.at(-1).finishReason, 'stop');
});

test('known provider receipts persist privately when a structured stage rejects returned content', async t => {
  const { service, runsDir } = await fixture(t, async ({ model }) => {
    await model.complete({ stage: 'whole-quality:applicability', system: 'private-system', user: 'private-user' });
    throw new Error('unreachable');
  });
  service.model = { complete: async options => {
    await options.onReceipt({ provider: 'synthetic', invocationId: 'inv-returned', contextId: 'ctx-returned' });
    throw new Error('returned content rejected');
  } };
  const submitted = await service.create(request());
  await until(() => service.get(submitted.id).status === 'failed' && !service.busy);
  assert.equal(service.get(submitted.id).providerReceipts, undefined);
  const saved = JSON.parse(await readFile(path.join(runsDir, submitted.id, 'task.json'), 'utf8'));
  assert.deepEqual(saved.providerReceipts.map(item => [item.stage, item.invocationId, item.contextId]), [['whole-quality:applicability', 'inv-returned', 'ctx-returned']]);
  assert.doesNotMatch(JSON.stringify(saved), /private-system|private-user/);
});

test('missing creative input waits for a new request and survives restart without publishing a manuscript', async t => {
  const question = '这篇故事希望写多少字、分几章？';
  let calls = 0;
  const workflow = async ({ request: input }) => {
    calls++;
    if (input.requestId === 'request-1') throw Object.assign(new Error(question), { code: 'INPUT_REQUIRED' });
    return structuredClone(result);
  };
  const { service, runsDir } = await fixture(t, workflow);
  const first = await service.create(request());
  await until(() => service.get(first.id).status === 'needs_input' && !service.busy);
  const waiting = service.get(first.id);
  assert.equal(waiting.question, question);
  assert.equal(waiting.error, undefined);
  assert.equal(waiting.result, undefined);
  for (const name of ['result.json', 'manuscript.txt']) await assert.rejects(readFile(path.join(runsDir, first.id, name)), { code: 'ENOENT' });
  assert.equal((await service.create(request())).id, first.id, 'duplicate submissions retain the waiting question');
  await assert.rejects(service.resume(first.id), error => error.status === 409 && /输入框.*补充.*发送/.test(error.message));
  assert.equal(calls, 1, 'input questions must not retry automatically or through resume');
  await service.close();
  const reopened = await new TaskService({ runsDir, model: {}, workflow }).init();
  t.after(() => reopened.close());
  assert.equal(reopened.get(first.id).status, 'needs_input');
  assert.equal(reopened.get(first.id).question, question);
  assert.equal(reopened.get(first.id).error, undefined);
  const next = await reopened.create(request({ requestId: 'request-2', idea: request().idea + '\n\n写 3000 字，分 3 章。' }));
  await until(() => reopened.get(next.id).status === 'completed');
  assert.equal(calls, 2, 'a supplemented request can proceed on the same project');
  assert.equal(reopened.get(first.id).status, 'needs_input');
  await reopened.close();
});

test('cancellation cannot be replaced by a late model success', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const { service, runsDir } = await fixture(t, async () => { await wait; return structuredClone(result); });
  const task = await service.create(request());
  await until(() => service.get(task.id).status === 'running');
  await service.cancel(task.id); release();
  await until(() => !service.busy);
  assert.equal(service.get(task.id).status, 'cancelled');
  assert.equal(service.get(task.id).result, undefined);
  const disk = JSON.parse(await readFile(path.join(runsDir, task.id, 'task.json'), 'utf8'));
  assert.equal(disk.status, 'cancelled');
});

test('one project cannot start two distinct simultaneous tasks', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const { service } = await fixture(t, async () => { await wait; return structuredClone(result); });
  const responses = await Promise.allSettled([service.create(request()), service.create(request({ requestId: 'request-2' }))]);
  release();
  assert.equal(responses.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(responses.find(r => r.status === 'rejected').reason.status, 409);
});

test('restart restores a completed result and marks interrupted work honestly', async t => {
  const { service, runsDir } = await fixture(t, async () => structuredClone(result));
  const task = await service.create(request());
  await until(() => service.get(task.id).status === 'completed');
  await service.close();
  const file = path.join(runsDir, task.id, 'task.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.status = 'running'; delete saved.result;
  await writeFile(file, JSON.stringify(saved));
  const reopened = await new TaskService({ runsDir, model: {}, workflow: async () => result }).init();
  assert.equal(reopened.get(task.id).status, 'interrupted');
  assert.equal(reopened.get(task.id).requestId, request().requestId);
  await reopened.close();
});

test('a second service cannot rewrite or resume the live service task directory', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const { service, runsDir } = await fixture(t, async () => { await wait; return structuredClone(result); });
  const task = await service.create(request());
  await until(() => service.get(task.id).status === 'running');
  const second = new TaskService({ runsDir, model: {}, workflow: async () => result });
  await assert.rejects(second.init(), /已有创作服务/);
  assert.equal(JSON.parse(await readFile(path.join(runsDir, task.id, 'task.json'), 'utf8')).status, 'running');
  release(); await until(() => !service.busy); await service.close();
  const next = await new TaskService({ runsDir, model: {}, workflow: async () => result }).init();
  assert.equal(next.get(task.id).status, 'completed');
  await next.close();
});

test('configuration remains server-side and missing keys cannot call a provider', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'talewick-config-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env.local');
  await writeFile(file, 'TALEWICK_API_KEY="example-secret-test-only"\nTALEWICK_MODEL=example-model\n');
  const config = await loadConfig({}, file);
  assert.equal(config.apiKey, 'example-secret-test-only');
  assert.equal(publicConfig(config).configured, true);
  assert.equal(JSON.stringify(publicConfig(config)).includes(config.apiKey), false);
  const missing = await loadConfig({}, path.join(dir, 'absent'));
  assert.equal(publicConfig(missing).configured, false);
  let calls = 0;
  await assert.rejects(createModel(missing, async () => { calls++; }).complete({ system: 'test', user: 'test' }), /尚未配置/);
  assert.equal(calls, 0);
});

test('plain provider adapter sends explicit text, handles truncation and redacts errors', async () => {
  const config = { baseURL: 'https://example.invalid/v1', apiKey: 'test-private-key', model: 'test-model', timeoutMs: 1000 };
  let sent;
  const model = createModel(config, async (url, init) => { sent = { url, init }; return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '真实接口格式的固定测试文本' } }] }) }; });
  assert.match(await model.complete({ system: '规则', user: '正文材料' }), /固定测试/);
  assert.equal(sent.url, 'https://example.invalid/v1/chat/completions');
  const body = JSON.parse(sent.init.body);
  assert.equal(body.model, 'test-model'); assert.equal(body.tools, undefined);
  const truncated = createModel(config, async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }) }));
  await assert.rejects(truncated.complete({ system: '', user: '' }), /长度上限/);
  const rejected = createModel(config, async () => ({ ok: false, status: 401, text: async () => config.apiKey }));
  await assert.rejects(rejected.complete({ system: '', user: '' }), error => error.message.includes('401') && !error.message.includes(config.apiKey));
});

test('DeepSeek V4 business calls allow thinking alongside requirements, prose and revision output', async () => {
  const config = { baseURL: 'https://api.deepseek.com', apiKey: 'private-test-key', model: 'deepseek-v4-flash', timeoutMs: 1000 };
  const requests = [];
  const model = createModel(config, async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '完整结果', reasoning_content: 'private-thinking-test' } }] });
  });
  for (const [stage, maxTokens] of [['requirements', 2500], ['draft:ch-1', 6500], ['requestedRevision', 20000], ['planning', 6000], ['agent:replan', 6000]]) {
    assert.equal(await model.complete({ stage, system: '阶段规则', user: '测试材料', maxTokens }), '完整结果');
  }
  assert.deepEqual(requests.map(body => body.max_tokens), [32768, 32768, 32768, 32768, 32768]);
  await model.complete({ stage: 'requestedRevision', system: '', user: '', maxTokens: 1000000 });
  assert.equal(requests.at(-1).max_tokens, 32768, 'an oversized caller budget must still have a fixed paid-output ceiling');
  assert.ok(requests.every(body => body.thinking?.type !== 'disabled'));
  assert.ok(requests.every(body => body.tools === undefined));

  let calls = 0;
  const truncated = createModel(config, async () => {
    calls++;
    return Response.json({ choices: [{ finish_reason: 'length', message: { content: '不完整正文', reasoning_content: 'private-thinking-test' } }] });
  });
  await assert.rejects(truncated.complete({ stage: 'requirements', system: '', user: '', maxTokens: 2500 }), error => {
    assert.match(error.message, /长度上限/);
    assert.ok(!error.message.includes('不完整正文') && !error.message.includes('private-thinking-test') && !error.message.includes(config.apiKey));
    return true;
  });
  assert.equal(calls, 2, 'truncated output must fail after its single bounded recovery');
});

test('compatible and older model business calls keep their existing output limits', async () => {
  for (const config of [
    { baseURL: 'https://model.example.invalid/v1', agentProvider: 'openai-compatible', model: 'deepseek-v4-flash' },
    { baseURL: 'https://api.deepseek.com', agentProvider: 'deepseek', model: 'deepseek-chat' },
  ]) {
    const requests = [];
    const model = createModel({ ...config, apiKey: 'private-test-key', timeoutMs: 1000 }, async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '完成' } }] });
    });
    for (const maxTokens of [2500, 6500, 20000]) await model.complete({ system: '', user: '', maxTokens });
    assert.deepEqual(requests.map(body => body.max_tokens), [2500, 6500, 16000]);
    assert.ok(requests.every(body => body.thinking === undefined && body.reasoning_effort === undefined));
  }
});

const nativeV4Config = { baseURL: 'https://api.deepseek.com', apiKey: 'private-test-key', model: 'deepseek-v4-flash', timeoutMs: 1000 };
const reasoningOnlyChoice = { finish_reason: 'stop', message: { content: '', reasoning_content: 'private-reasoning-that-is-not-a-manuscript' } };
const providerResponse = choice => Response.json({ choices: [choice] });
const delayedProviderResponse = (choice, { beforeRead = () => {}, delayMs = 0 } = {}) => {
  let timer;
  return new Response(new ReadableStream({
    start(controller) {
      timer = setTimeout(() => {
        beforeRead();
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ choices: [choice] })));
        controller.close();
      }, delayMs);
    },
    cancel() { clearTimeout(timer); },
  }), { headers: { 'content-type': 'application/json' } });
};

test('native V4 retries a stopped reasoning-only response once with the original request and deadline', async () => {
  const sent = [];
  const model = createModel(nativeV4Config, async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return providerResponse(sent.length === 1 ? reasoningOnlyChoice : { finish_reason: 'stop', message: { content: '她把钟交还给村里。' } });
  });
  const input = { stage: 'draft:ch-1', system: '只写本章正文，不改用户要求。', user: '主角把钟归还给村里。', maxTokens: 6500 };
  assert.equal(await model.complete(input), '她把钟交还给村里。');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.thinking, undefined);
  assert.deepEqual(sent[1].body.thinking, { type: 'disabled' });
  assert.deepEqual(sent.map(item => item.body.max_tokens), [32768, 6500]);
  assert.deepEqual(sent[1].body.messages, sent[0].body.messages);
  assert.deepEqual(sent[1].body.messages, [{ role: 'system', content: input.system }, { role: 'user', content: input.user }]);
  assert.equal(sent[1].url, sent[0].url);
  assert.equal(sent[1].body.model, nativeV4Config.model);
  assert.equal(sent[1].init.signal, sent[0].init.signal, 'fallback must reuse the same total timeout signal');
  assert.equal(sent[1].init.redirect, 'error');
  assert.ok(sent.every(item => !JSON.stringify(item.body).includes(reasoningOnlyChoice.message.reasoning_content)));
});

test('the reasoning-only fallback uses a bounded prose budget without an added thinking reserve', async () => {
  for (const [maxTokens, expected] of [[100, 512], [25000, 16000], [1000000, 16000]]) {
    const requests = [];
    const model = createModel({ ...nativeV4Config, model: 'deepseek-v4-pro' }, async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return providerResponse(requests.length === 1 ? reasoningOnlyChoice : { finish_reason: 'stop', message: { content: '完整正文' } });
    });
    assert.equal(await model.complete({ system: '', user: '', maxTokens }), '完整正文');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].max_tokens, expected);
  }
});

test('a second empty response fails after exactly two calls and never exposes reasoning', async () => {
  let calls = 0;
  const model = createModel(nativeV4Config, async () => {
    calls++;
    return providerResponse({ ...reasoningOnlyChoice, message: { ...reasoningOnlyChoice.message, content: ' \n\t ' } });
  });
  await assert.rejects(model.complete({ system: '规则', user: '创作要求' }), error => {
    assert.match(error.message, /没有返回正文/);
    assert.ok(!error.message.includes(nativeV4Config.apiKey) && !error.message.includes(reasoningOnlyChoice.message.reasoning_content));
    return true;
  });
  assert.equal(calls, 2);
});

test('cancellation or expiry after the first response prevents the fallback from starting', async t => {
  await t.test('cancelled while the first response is read', async () => {
    const controller = new AbortController();
    let calls = 0;
    const cancelled = new Error('test cancellation');
    const model = createModel(nativeV4Config, async () => {
      calls++;
      return delayedProviderResponse(reasoningOnlyChoice, { beforeRead: () => controller.abort(cancelled) });
    });
    await assert.rejects(model.complete({ system: '', user: '', signal: controller.signal }), error => error === cancelled);
    assert.equal(calls, 1);
  });
  await t.test('the original deadline has expired before fallback', async () => {
    let calls = 0;
    const model = createModel({ ...nativeV4Config, timeoutMs: 20 }, async () => {
      calls++;
      return delayedProviderResponse(reasoningOnlyChoice, { delayMs: 40 });
    });
    await assert.rejects(model.complete({ system: '', user: '' }), /模型响应超时/);
    assert.equal(calls, 1);
  });
});

test('unknown stages only recover a stopped native V4 response with reasoning and no content', async t => {
  const cases = [
    { label: 'length in an unknown stage is not a retry trigger', choice: { ...reasoningOnlyChoice, finish_reason: 'length' }, error: /长度上限/ },
    { label: 'other finish reason', choice: { ...reasoningOnlyChoice, finish_reason: 'content_filter' }, error: /未正常完成/ },
    { label: 'missing finish reason', choice: { message: reasoningOnlyChoice.message }, error: /完整结束前中断/ },
    { label: 'no reasoning', choice: { finish_reason: 'stop', message: { content: '' } } },
    { label: 'blank reasoning', choice: { finish_reason: 'stop', message: { content: '', reasoning_content: ' \n ' } } },
    { label: 'incompatible content shape', choice: { finish_reason: 'stop', message: { content: [{ text: 'unexpected shape' }], reasoning_content: 'thinking' } }, error: /无法识别/ },
    { label: 'compatible provider', config: { agentProvider: 'openai-compatible' }, choice: reasoningOnlyChoice },
    { label: 'older native model', config: { model: 'deepseek-chat' }, choice: reasoningOnlyChoice },
  ];
  for (const { label, config, choice, error } of cases) await t.test(label, async () => {
    let calls = 0;
    const model = createModel({ ...nativeV4Config, ...config }, async () => { calls++; return providerResponse(choice); });
    await assert.rejects(model.complete({ system: '', user: '' }), error || /没有返回正文/);
    assert.equal(calls, 1);
  });
});

test('provider transport and HTTP failures stay redacted and never cause an extra automatic call', async t => {
  for (const phase of ['first response', 'fallback']) for (const failure of ['network', 'HTTP']) await t.test(`${phase}: ${failure}`, async () => {
    let calls = 0;
    const model = createModel(nativeV4Config, async () => {
      calls++;
      if (phase === 'fallback' && calls === 1) return providerResponse(reasoningOnlyChoice);
      if (failure === 'network') throw new Error(nativeV4Config.apiKey);
      return { ok: false, status: 401, text: async () => nativeV4Config.apiKey };
    });
    await assert.rejects(model.complete({ system: '', user: '' }), error => {
      assert.match(error.message, failure === 'network' ? /无法连接模型服务/ : /HTTP 401/);
      assert.ok(!error.message.includes(nativeV4Config.apiKey));
      return true;
    });
    assert.equal(calls, phase === 'fallback' ? 2 : 1);
  });
});

test('native DeepSeek explicitly requests JSON objects for every structured business stage', async () => {
  const stages = ['requirements', 'requirements:repair', 'planning', 'agent:replan', 'review', 'agent:reviewManuscript', 'revisionReview', 'requestedRevision'];
  const requests = [];
  const model = createModel(nativeV4Config, async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return providerResponse({ finish_reason: 'stop', message: { content: '{"summary":"结构化测试结果"}' } });
  });
  for (const stage of stages) await model.complete({ stage, system: '仅返回 JSON 对象，保留本阶段字段契约。', user: '本次输入' });
  assert.equal(requests.length, stages.length);
  for (const request of requests) {
    assert.deepEqual(request.response_format, { type: 'json_object' });
    assert.equal(request.messages[0].content, '仅返回 JSON 对象，保留本阶段字段契约。');
    assert.equal(request.messages[1].content, '本次输入');
    assert.equal(request.stage, undefined, 'internal stage names are not provider API parameters');
  }
});

test('prose, unspecified stages and compatible providers retain ordinary text response settings', async () => {
  const cases = [
    ...['draft:ch-1', 'revision:ch-1', 'agent:reviseChapter', 'unknown-json-stage', undefined].map(stage => ({ config: nativeV4Config, stage })),
    { config: { ...nativeV4Config, agentProvider: 'openai-compatible' }, stage: 'review' },
    { config: { ...nativeV4Config, baseURL: 'https://compatible.example.invalid/v1' }, stage: 'planning' },
  ];
  for (const { config, stage } of cases) {
    let request;
    const model = createModel(config, async (_url, init) => {
      request = JSON.parse(init.body);
      return providerResponse({ finish_reason: 'stop', message: { content: '原有文本输出' } });
    });
    assert.equal(await model.complete({ stage, system: '保留当前规则；材料里出现 JSON 也不改变阶段。', user: '测试输入' }), '原有文本输出');
    assert.equal(request.response_format, undefined);
  }
});

test('the reasoning-only recovery retains JSON response mode and the complete review prompt', async () => {
  const requests = [];
  const review = { summary: '完整审稿摘要', issues: [], strengths: [], limitations: [] };
  const input = { stage: 'review', system: '只依据正文审稿，返回 JSON：summary、issues、strengths、limitations。', user: '{"chapters":[{"body":"她把钟还给村里。"}]}', maxTokens: 6000 };
  const model = createModel(nativeV4Config, async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return providerResponse(requests.length === 1 ? reasoningOnlyChoice : { finish_reason: 'stop', message: { content: JSON.stringify(review) } });
  });
  assert.deepEqual(JSON.parse(await model.complete(input)), review);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.response_format?.type === 'json_object'));
  assert.deepEqual(requests[1].messages, requests[0].messages);
  assert.deepEqual(requests[1].thinking, { type: 'disabled' });
  assert.equal(requests[1].max_tokens, 6000);
});

const truncatedReviewChoice = {
  finish_reason: 'length',
  message: { content: '{"summary":"未完成的审稿', reasoning_content: 'private-truncated-review-thinking' },
};

test('native V4 truncated JSON reviews discard the first output and recover once without thinking', async t => {
  for (const stage of ['review', 'agent:reviewManuscript', 'revisionReview']) await t.test(stage, async () => {
    const sent = [];
    const completeReview = { summary: '仅使用重新完成的审稿', issues: [], strengths: [], limitations: [] };
    const input = { stage, system: '基于完整正文审阅，返回 JSON；不得降低审阅标准。', user: '{"chapters":[{"body":"合成测试正文。"}]}', maxTokens: 6000 };
    const model = createModel(nativeV4Config, async (url, init) => {
      sent.push({ url, init, body: JSON.parse(init.body) });
      return providerResponse(sent.length === 1 ? truncatedReviewChoice : { finish_reason: 'stop', message: { content: JSON.stringify(completeReview) } });
    });
    assert.deepEqual(JSON.parse(await model.complete(input)), completeReview);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].url, sent[0].url);
    assert.equal(sent[1].body.model, sent[0].body.model);
    assert.deepEqual(sent[1].body.messages, sent[0].body.messages);
    assert.ok(sent.every(item => item.body.response_format?.type === 'json_object'));
    assert.equal(sent[0].body.thinking, undefined);
    assert.deepEqual(sent[1].body.thinking, { type: 'disabled' });
    assert.deepEqual(sent.map(item => item.body.max_tokens), [32768, 6000]);
    assert.equal(sent[1].init.signal, sent[0].init.signal, 'both responses share the original total deadline');
    assert.equal(sent[1].init.redirect, 'error');
    assert.ok(sent.every(item => !JSON.stringify(item.body).includes(truncatedReviewChoice.message.reasoning_content)));
    assert.ok(sent.every(item => !JSON.stringify(item.body).includes(truncatedReviewChoice.message.content)));
  });
});

test('a truncated review cannot succeed with even parseable first JSON when recovery fails', async t => {
  for (const failure of ['length', 'empty', 'network', 'HTTP']) await t.test(failure, async () => {
    let calls = 0;
    const model = createModel(nativeV4Config, async () => {
      calls++;
      if (calls === 1) return providerResponse({ ...truncatedReviewChoice, message: { ...truncatedReviewChoice.message, content: '{"summary":"不可采用的首轮报告","issues":[]}' } });
      if (failure === 'network') throw new Error(`private provider error ${nativeV4Config.apiKey}`);
      if (failure === 'HTTP') return { ok: false, status: 503, text: async () => 'private provider error' };
      return providerResponse(failure === 'length' ? truncatedReviewChoice : reasoningOnlyChoice);
    });
    const pattern = { length: /长度上限/, empty: /没有返回正文/, network: /无法连接模型服务/, HTTP: /HTTP 503/ }[failure];
    await assert.rejects(model.complete({ stage: 'review', system: '审阅规则', user: '合成正文' }), error => {
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, /不可采用的首轮报告|private provider error|private-truncated-review-thinking/);
      assert.ok(!error.message.includes(nativeV4Config.apiKey));
      return true;
    });
    assert.equal(calls, 2, 'no third attempt and no fallback to the truncated first response');
  });
});

test('empty-stop recovery and truncated-review recovery share a single total retry allowance', async () => {
  for (const [first, second, error] of [
    [reasoningOnlyChoice, truncatedReviewChoice, /长度上限/],
    [truncatedReviewChoice, reasoningOnlyChoice, /没有返回正文/],
  ]) {
    let calls = 0;
    const model = createModel(nativeV4Config, async () => providerResponse(++calls === 1 ? first : second));
    await assert.rejects(model.complete({ stage: 'review', system: '审阅规则', user: '合成正文' }), error);
    assert.equal(calls, 2);
  }
});

test('truncated-review recovery excludes other providers, models, stages and missing reasoning', async t => {
  const cases = [
    ...['agent:reviseChapter', 'draft:', 'revision:', 'agent:controller', 'unknown-review-stage', undefined].map(stage => ({ label: `stage ${stage}`, stage })),
    { label: 'compatible provider', stage: 'review', config: { agentProvider: 'openai-compatible' } },
    { label: 'older native model', stage: 'review', config: { model: 'deepseek-chat' } },
    { label: 'no reasoning', stage: 'review', message: { content: '{"summary":"partial' } },
    { label: 'blank reasoning', stage: 'review', message: { content: '', reasoning_content: ' \n ' } },
    { label: 'invalid reasoning shape', stage: 'review', message: { content: '', reasoning_content: ['not-text'] }, error: /无法识别/ },
  ];
  for (const item of cases) await t.test(item.label, async () => {
    let calls = 0;
    const model = createModel({ ...nativeV4Config, ...item.config }, async () => {
      calls++;
      return providerResponse({ ...truncatedReviewChoice, ...(item.message ? { message: item.message } : {}) });
    });
    await assert.rejects(model.complete({ stage: item.stage, system: '原规则', user: '合成测试' }), item.error || /长度上限/);
    assert.equal(calls, 1);
  });
});

test('cancellation and the original deadline can prevent truncated-review recovery', async t => {
  await t.test('cancelled before the first response finishes', async () => {
    const controller = new AbortController();
    const reason = new Error('test review cancellation');
    let calls = 0;
    const model = createModel(nativeV4Config, async () => {
      calls++;
      return delayedProviderResponse(truncatedReviewChoice, { beforeRead: () => controller.abort(reason) });
    });
    await assert.rejects(model.complete({ stage: 'review', system: '', user: '', signal: controller.signal }), error => error === reason);
    assert.equal(calls, 1);
  });
  await t.test('deadline expires while reading the first response', async () => {
    let calls = 0;
    const model = createModel({ ...nativeV4Config, timeoutMs: 20 }, async () => {
      calls++;
      return delayedProviderResponse(truncatedReviewChoice, { delayMs: 40 });
    });
    await assert.rejects(model.complete({ stage: 'review', system: '', user: '' }), /模型响应超时/);
    assert.equal(calls, 1);
  });
});
