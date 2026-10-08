import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { ConversationService, permitsWriting } from './conversations.mjs';

const config = { baseURL: 'https://model.invalid/v1', agentProvider: 'openai-compatible', model: 'test-model' };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const finish = (reason = 'stop') => ({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage });
const textParts = text => [{ type: 'text-start', id: 'text-1' }, { type: 'text-delta', id: 'text-1', delta: text }, { type: 'text-end', id: 'text-1' }];
const toolCall = (name, input, id = 'call-1') => ({ type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) });
const snapshot = {
  projectId: 'test-project', requestId: 'snapshot-request', kind: 'create', idea: '一个修钟人的故事。',
  context: {}, materials: [], style: null, chapters: [], instruction: '', quote: '', baseRevision: 'empty-v1', projectTitle: '旧钟',
};
const turnBody = (turnId, text, overrides = {}) => ({ turnId, text, snapshot: structuredClone(snapshot), ...overrides });

function partsResult(parts) {
  return { stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] });
    for (const part of parts) controller.enqueue(part);
    controller.close();
  } }) };
}

function controlledStream() {
  let controller;
  let ended = false;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  return {
    ready,
    result(options) {
      return { stream: new ReadableStream({ start(value) {
        controller = value;
        controller.enqueue({ type: 'stream-start', warnings: [] });
        options.abortSignal?.addEventListener('abort', () => {
          if (!ended) { ended = true; controller.error(new DOMException('Aborted', 'AbortError')); }
        }, { once: true });
        resolveReady();
      }, cancel() { ended = true; } }) };
    },
    push(...parts) { assert.equal(ended, false); for (const part of parts) controller.enqueue(part); },
    finish(reason = 'stop') { assert.equal(ended, false); controller.enqueue(finish(reason)); ended = true; controller.close(); },
  };
}

function mockModel(steps) {
  let index = 0;
  return new MockLanguageModelV4({ doStream: async options => {
    assert.ok(index < steps.length, 'the conversation made an unexpected extra model call');
    const step = steps[index++];
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(options) : partsResult(step);
  } });
}

function taskStore() {
  const tasks = new Map();
  const requests = [];
  let attempts = 0;
  return {
    requests,
    get attempts() { return attempts; },
    list(projectId) { return [...tasks.values()].filter(task => task.projectId === projectId).map(task => structuredClone(task)); },
    get(id) { assert.ok(tasks.has(id), `unknown task ${id}`); return structuredClone(tasks.get(id)); },
    async create(request) {
      attempts++;
      // TaskService's durable request id provides the same idempotency contract.
      const prior = [...tasks.values()].find(task => task.requestId === request.requestId);
      if (prior) return structuredClone(prior);
      requests.push(structuredClone(request));
      const task = { id: `task-${requests.length}`, projectId: request.projectId, requestId: request.requestId, status: 'queued', stage: 'queued' };
      tasks.set(task.id, task);
      return structuredClone(task);
    },
  };
}

async function setup(t, model, tasks = taskStore()) {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-conversation-'));
  const service = await new ConversationService({ runsDir, tasks, config, conversationModel: model }).init();
  t.after(async () => { await service.close(); await rm(runsDir, { recursive: true, force: true }); });
  return { service, tasks, runsDir };
}

async function until(predicate, label) {
  const expires = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= expires) assert.fail(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function completed(service, id) {
  await until(() => !service.active.has(snapshot.projectId), 'conversation to stop');
  return service.get(snapshot.projectId, id);
}

class ResponseCapture extends EventEmitter {
  events = [];
  writableLength = 0;
  destroyed = false;
  ended = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  flushHeaders() {}
  write(chunk) { this.events.push(JSON.parse(chunk)); return true; }
  end() { this.ended = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

test('the browser receives a real text delta while the model is still running', async t => {
  const source = controlledStream();
  const { service } = await setup(t, mockModel([options => source.result(options)]));
  await service.start(snapshot.projectId, turnBody('stream-first', '你好'));
  await source.ready;
  const response = new ResponseCapture();
  service.stream(snapshot.projectId, 'stream-first', {}, response);
  source.push({ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: '你好，' });
  await until(() => response.events.some(event => event.type === 'text'), 'first text delta');
  assert.equal(response.events[0].type, 'snapshot');
  assert.equal(response.events.find(event => event.type === 'text').delta, '你好，');
  assert.equal(service.get(snapshot.projectId, 'stream-first').status, 'running');
  assert.equal(response.events.some(event => event.type === 'done'), false);
  assert.equal(response.ended, false);
  source.push({ type: 'text-delta', id: 'reply', delta: '想聊什么故事？' }, { type: 'text-end', id: 'reply' });
  source.finish();
  const turn = await completed(service, 'stream-first');
  assert.equal(turn.status, 'completed');
  assert.equal(turn.assistantText, '你好，想聊什么故事？');
  assert.equal(response.events.at(-1).type, 'done');
  assert.equal(response.ended, true);
  assert.match(response.headers['Content-Type'], /application\/x-ndjson/);
});

test('the next model turn includes imported history and the actual previous reply', async t => {
  const model = mockModel([[...textParts('修钟人可以叫小禾。'), finish()], [...textParts('小禾已经有了守钟的理由。'), finish()]]);
  const { service } = await setup(t, model);
  const history = [{ role: 'user', text: '背景设在一座海边小镇。' }, { role: 'assistant', text: '我们保留海边小镇的设定。' }];
  await service.start(snapshot.projectId, turnBody('context-1', '先讨论人物。', { history }));
  await completed(service, 'context-1');
  await service.start(snapshot.projectId, turnBody('context-2', '给小禾一个守钟的理由。'));
  assert.equal((await completed(service, 'context-2')).status, 'completed');
  const secondPrompt = JSON.stringify(model.doStreamCalls[1].prompt);
  for (const text of ['背景设在一座海边小镇。', '先讨论人物。', '修钟人可以叫小禾。', '给小禾一个守钟的理由。']) assert.ok(secondPrompt.includes(text));
});

test('greetings, discussions and editor locks never expose manuscript write tools', async t => {
  const cases = [
    { text: '你好' },
    { text: '先讨论一下主角为什么要修钟。' },
    { text: '我在考虑写一篇小说，还没有决定。' },
    { text: '请解释“帮我写一篇小说”这句话。' },
    { text: '不要写，先讨论。' },
    { text: '不要现在开始写。' },
    { text: '不是要你写一篇小说，只是聊聊。' },
    { text: '如何写一篇小说？' },
    { text: '请帮我写一篇小说需要多少时间？' },
    { text: '帮我写一篇小说，这个功能收费吗？' },
    { text: '不要急于开始写作。' },
    { text: '请开始写一篇小说。', allowTools: false },
  ];
  for (let index = 0; index < cases.length; index++) await t.test(cases[index].text, async t => {
    const model = mockModel([[...textParts('我们先聊聊这个人物。'), finish()]]);
    const { service, tasks } = await setup(t, model);
    await service.start(snapshot.projectId, turnBody(`safe-${index}`, cases[index].text, { allowTools: cases[index].allowTools }));
    await completed(service, `safe-${index}`);
    assert.deepEqual(model.doStreamCalls[0].tools.map(item => item.name), ['read_task_status']);
    assert.equal(tasks.attempts, 0);
  });
});

test('explicit creation submits once across repeated tool calls and the same turn id', async t => {
  const text = '按这个方案开始写一篇 3000 字的小说。';
  const args = { brief: '保留海边修钟人的设定，写 3000 字。' };
  const source = controlledStream();
  const model = mockModel([
    [toolCall('start_creation', args), finish('tool-calls')],
    [toolCall('start_creation', { ...args, brief: '后续调用不能替换已经冻结的创作要求。' }, 'call-repeat'), finish('tool-calls')],
    options => source.result(options),
  ]);
  const { service, tasks } = await setup(t, model);
  const body = turnBody('write-once', text);
  await service.start(snapshot.projectId, body);
  await source.ready;
  await until(() => tasks.requests.length === 1, 'one actual task');
  const repeated = await service.start(snapshot.projectId, structuredClone(body));
  assert.equal(repeated.id, body.turnId);
  assert.equal(tasks.attempts, 1);
  assert.equal(tasks.requests[0].idea, args.brief);
  await assert.rejects(service.start(snapshot.projectId, { ...body, text: '现在改成另一个故事。' }), error => error.status === 409);
  source.push(...textParts('创作任务已提交。'));
  source.finish();
  const turn = await completed(service, body.turnId);
  assert.equal(turn.status, 'completed');
  assert.equal(turn.task.task.id, tasks.list(snapshot.projectId)[0].id);
  assert.equal(tasks.requests.length, 1);
  await service.start(snapshot.projectId, structuredClone(body));
  assert.equal(model.doStreamCalls.length, 3);
  assert.equal(tasks.requests.length, 1);
});

test('an invented model confirmation cannot authorize writing after a user greeting', async t => {
  const model = mockModel([
    [toolCall('start_creation', { brief: '修钟人的故事', confirmationQuote: '请开始写一篇小说。' }), finish('tool-calls')],
    [...textParts('你好，你想聊一个什么故事？'), finish()],
  ]);
  const { service, tasks } = await setup(t, model);
  await service.start(snapshot.projectId, turnBody('invented-quote', '你好'));
  await completed(service, 'invented-quote');
  assert.deepEqual(model.doStreamCalls[0].tools.map(item => item.name), ['read_task_status']);
  assert.equal(tasks.attempts, 0);
});

test('the actual user instruction authorizes writing without requiring a model to quote it exactly', async t => {
  const text = '不要悬疑，直接写一篇 400–600 字的温暖故事。';
  const model = mockModel([
    [toolCall('start_creation', { brief: '写一篇温暖的短故事，篇幅 400–600 字。', confirmationQuote: '直接写一篇400-600字故事' }), finish('tool-calls')],
    [...textParts('温暖故事的创作任务已提交。'), finish()],
  ]);
  const { service, tasks } = await setup(t, model);
  await service.start(snapshot.projectId, turnBody('actual-permission', text));
  const turn = await completed(service, 'actual-permission');
  assert.equal(turn.status, 'completed');
  assert.equal(tasks.requests.length, 1);
  assert.equal(tasks.requests[0].instruction, text);
  assert.ok(Object.values(tasks.requests[0].context).some(value => value.includes(text)));
  assert.equal(turn.task.task.id, tasks.list(snapshot.projectId)[0].id);
});

test('stopping a streamed reply retains its partial text and does not mark it completed', async t => {
  const source = controlledStream();
  const { service, runsDir } = await setup(t, mockModel([options => source.result(options)]));
  await service.start(snapshot.projectId, turnBody('cancel-partial', '先讨论人物。'));
  await source.ready;
  source.push({ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: '我们可以先确定小禾的目标，' });
  await until(() => service.get(snapshot.projectId, 'cancel-partial').assistantText.length > 0, 'partial reply');
  const turn = await service.cancel(snapshot.projectId, 'cancel-partial');
  assert.equal(turn.status, 'cancelled');
  assert.equal(turn.assistantText, '我们可以先确定小禾的目标，');
  const saved = JSON.parse(await readFile(path.join(runsDir, '.conversations', `${snapshot.projectId}.json`), 'utf8'));
  assert.equal(saved.turns[0].status, 'cancelled');
  assert.equal(saved.turns[0].assistantText, turn.assistantText);
});

test('shutdown waits for a pending start to finish saving before it closes active work', async t => {
  const source = controlledStream();
  const { service } = await setup(t, mockModel([options => source.result(options)]));
  const save = service.save.bind(service);
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const saving = new Promise(resolve => { entered = resolve; });
  let first = true;
  service.save = async project => {
    if (first) { first = false; entered(); await gate; }
    return save(project);
  };
  const start = service.start(snapshot.projectId, turnBody('close-pending', '你好'));
  await saving;
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'close must not return while start can still create a new model run');
  } finally {
    release();
    await Promise.allSettled([start, closing]);
  }
  assert.equal(service.active.size, 0);
  assert.notEqual(service.get(snapshot.projectId, 'close-pending').status, 'running');
});

test('shutdown and crash recovery retain partial replies and reconnect a durably submitted task', async t => {
  const text = '请开始写一篇小说。';
  const source = controlledStream();
  const model = mockModel([[toolCall('start_creation', { brief: '修钟人的故事。' }), finish('tool-calls')], options => source.result(options)]);
  const { service, tasks, runsDir } = await setup(t, model);
  await service.start(snapshot.projectId, turnBody('restart-partial', text));
  await source.ready;
  source.push({ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: '创作任务已提交，' });
  await until(() => service.get(snapshot.projectId, 'restart-partial').assistantText.length > 0, 'partial task reply');
  await service.close();
  const stopped = service.get(snapshot.projectId, 'restart-partial');
  assert.equal(stopped.status, 'interrupted');
  assert.equal(stopped.task.task.status, 'queued');
  const file = path.join(runsDir, '.conversations', `${snapshot.projectId}.json`);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  // Simulate the documented crash window: intent is durable, task exists, link was not saved.
  saved.turns[0].status = 'running';
  delete saved.turns[0].task;
  await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  const recovered = await new ConversationService({ runsDir, tasks, config, conversationModel: mockModel([]) }).init();
  t.after(() => recovered.close());
  const turn = recovered.get(snapshot.projectId, 'restart-partial');
  assert.equal(turn.status, 'interrupted');
  assert.equal(turn.assistantText, '创作任务已提交，');
  assert.equal(turn.task.task.id, stopped.task.task.id);
  assert.equal(tasks.attempts, 1);
  assert.equal(tasks.requests.length, 1);
});

test('a revision tool cannot replace the server snapshot, baseline or UTF-16 selection anchor', async t => {
  const quote = '门还开着。';
  const body = `😀序：${quote}\n过了一会。${quote}`;
  const text = '请把选中的这句话改成“她把门关好了。”。';
  const selected = { ...structuredClone(snapshot), kind: 'revise', instruction: text, baseRevision: 'frozen-manuscript-v2', quote,
    chapters: [{ id: 'original', title: '原来的章名', body }], quoteSource: { chapterId: 'original', start: body.lastIndexOf(quote) } };
  const model = mockModel([
    [toolCall('revise_manuscript', { brief: '改变选中的门。', baseRevision: 'forged', quoteSource: { chapterId: 'original', start: 0 }, chapters: [{ id: 'original', title: '伪造章名', body: '整章被替换。' }] }), finish('tool-calls')],
    [...textParts('修改任务已提交。'), finish()],
  ]);
  const { service, tasks } = await setup(t, model);
  await service.start(snapshot.projectId, turnBody('anchor', text, { snapshot: selected }));
  assert.equal((await completed(service, 'anchor')).status, 'completed');
  assert.equal(tasks.requests.length, 1);
  const request = tasks.requests[0];
  assert.deepEqual(request.quoteSource, selected.quoteSource);
  assert.deepEqual(request.chapters, selected.chapters);
  assert.equal(request.quote, quote);
  assert.equal(request.baseRevision, selected.baseRevision);
  assert.equal(request.instruction, text);
  assert.equal(request.kind, 'revise');
});

test('truncated responses and stream errors retain partial content without claiming completion', async t => {
  for (const failure of ['length', 'error']) await t.test(failure, async t => {
    const errors = [];
    t.mock.method(console, 'error', (...args) => { errors.push(args.map(String).join(' ')); });
    const chunks = [...textParts('尚未说完的回复')];
    chunks.push(failure === 'length' ? finish('length') : { type: 'error', error: new Error('provider-only private diagnostic') });
    const { service, runsDir } = await setup(t, mockModel([chunks]));
    await service.start(snapshot.projectId, turnBody(`failed-${failure}`, '先聊人物。'));
    const turn = await completed(service, `failed-${failure}`);
    assert.equal(turn.status, 'failed');
    assert.equal(turn.assistantText, '尚未说完的回复');
    assert.doesNotMatch(turn.error, /provider-only private diagnostic/);
    const record = await readFile(path.join(runsDir, '.conversations', `${snapshot.projectId}.json`), 'utf8');
    assert.equal(JSON.parse(record).turns[0].status, 'failed');
    assert.doesNotMatch(record, /provider-only private diagnostic/);
    assert.equal(errors.some(message => message.includes('provider-only private diagnostic')), false, 'the SDK must not log unsanitized provider errors');
  });
});

test('reasoning and provider metadata never enter public events or the durable conversation', async t => {
  const secret = 'INTERNAL_REASONING_ONLY_9d1a';
  const source = controlledStream();
  const { service, runsDir } = await setup(t, mockModel([options => source.result(options)]));
  await service.start(snapshot.projectId, turnBody('no-reasoning', '聊聊这个故事。'));
  await source.ready;
  const response = new ResponseCapture();
  service.stream(snapshot.projectId, 'no-reasoning', {}, response);
  source.push({ type: 'reasoning-start', id: 'reason' }, { type: 'reasoning-delta', id: 'reason', delta: secret }, { type: 'reasoning-end', id: 'reason', providerMetadata: { private: { trace: secret } } }, ...textParts('我们先看看小禾想守住什么。'));
  source.finish();
  const turn = await completed(service, 'no-reasoning');
  assert.equal(turn.status, 'completed');
  assert.equal(turn.assistantText, '我们先看看小禾想守住什么。');
  for (const visible of [turn, service.list(snapshot.projectId), response.events]) assert.equal(JSON.stringify(visible).includes(secret), false);
  assert.equal((await readFile(path.join(runsDir, '.conversations', `${snapshot.projectId}.json`), 'utf8')).includes(secret), false);
});

test('writing permission distinguishes a direct instruction from a question or a refusal', () => {
  assert.equal(permitsWriting('请开始写一篇小说。'), true);
  assert.equal(permitsWriting('如何写一篇小说？'), false);
  assert.equal(permitsWriting('不要写，先聊人物。'), false);
  assert.equal(permitsWriting('不要悬疑，直接写一篇温暖故事。'), true);
  assert.equal(permitsWriting('不要现在开始写。'), false);
  assert.equal(permitsWriting('不是要你写一篇小说。'), false);
  assert.equal(permitsWriting('好的', '现在开始写作吗？'), true);
  assert.equal(permitsWriting('好的', '我们继续讨论人物。'), false);
});

test('auto starts a generic writing request without requiring a topic or another confirmation', async t => {
  const input = '帮我写一篇小说。';
  const model = mockModel([
    [toolCall('start_creation', { brief: '系统自行决定人物、题材和情节，写成一篇完整短篇。' }), finish('tool-calls')],
    [...textParts('我来确定故事细节，已经开始成稿。'), finish()],
  ]);
  const { service, tasks } = await setup(t, model);
  await service.start(snapshot.projectId, turnBody('auto-generic', input, {
    mode: 'auto', snapshot: { ...structuredClone(snapshot), idea: input },
  }));
  const turn = await completed(service, 'auto-generic');
  assert.equal(turn.status, 'completed');
  assert.equal(tasks.requests.length, 1);
  assert.equal(tasks.requests[0].instruction, input);
  assert.match(tasks.requests[0].context['创作参与模式'], /一键成稿/);
  assert.match(tasks.requests[0].context['创作参与模式'], /自动|默认|自行/);
  assert.match(tasks.requests[0].context['创作参与模式'], /用户/);
  assert.match(tasks.requests[0].context['创作参与模式'], /系统/);
  assert.ok(turn.task, 'the same conversation turn must expose the actual submitted task');
});

test('auto exposes creation for a story seed without requiring an imperative writing phrase', async t => {
  const input = '一名修船师收到亡父的信。';
  const model = mockModel([
    [toolCall('start_creation', { brief: input }), finish('tool-calls')],
    [...textParts('我会围绕这封信展开故事，正在成稿。'), finish()],
  ]);
  const { service, tasks } = await setup(t, model);
  await service.start(snapshot.projectId, turnBody('auto-seed', input, {
    mode: 'auto', snapshot: { ...structuredClone(snapshot), idea: input },
  }));
  const turn = await completed(service, 'auto-seed');
  assert.equal(turn.status, 'completed');
  assert.ok(model.doStreamCalls[0].tools.some(item => item.name === 'start_creation'));
  assert.equal(tasks.requests.length, 1);
  assert.equal(tasks.requests[0].idea, input);
  assert.ok(Object.values(tasks.requests[0].context).some(value => value.includes(input)));
});

test('auto forces an explicit initial writing tool and returns to automatic choice after submission', async t => {
  const model = mockModel([
    [toolCall('start_creation', { brief: '写一篇 600 字、一章的修船师故事，结尾温暖。' }), finish('tool-calls')],
    [...textParts('600 字、单章、温暖结尾的任务已提交。'), finish()],
  ]);
  const { service, tasks } = await setup(t, model);
  const input = '直接写一篇 600 字的修船师故事，只要一章，结尾温暖。';
  await service.start(snapshot.projectId, turnBody('auto-force', input, { mode: 'auto' }));
  assert.equal((await completed(service, 'auto-force')).status, 'completed');
  assert.deepEqual(model.doStreamCalls[0].toolChoice, { type: 'tool', toolName: 'start_creation' });
  assert.deepEqual(model.doStreamCalls[1].toolChoice, { type: 'auto' });
  assert.equal(tasks.requests.length, 1);
  assert.equal(tasks.requests[0].instruction, input);
  assert.ok(Object.values(tasks.requests[0].context).some(value => value.includes(input)), 'explicit user specifications survive the automatic-mode defaults');
});

test('auto still keeps greetings, discussion requests, refusals and questions conversational', async t => {
  const inputs = [
    '你好',
    '先聊聊一名修船师收到亡父的信，不要写正文。',
    '不要开始写，我还要改设定。',
    '一名修船师收到亡父的信，这个设定有什么问题？',
    '你可以做什么？',
  ];
  for (let index = 0; index < inputs.length; index++) await t.test(inputs[index], async t => {
    const model = mockModel([[...textParts('可以，我们先交流。'), finish()]]);
    const { service, tasks } = await setup(t, model);
    await service.start(snapshot.projectId, turnBody(`auto-conversation-${index}`, inputs[index], { mode: 'auto' }));
    assert.equal((await completed(service, `auto-conversation-${index}`)).status, 'completed');
    assert.deepEqual(model.doStreamCalls[0].tools.map(item => item.name), ['read_task_status']);
    assert.equal(tasks.attempts, 0);
  });
});

test('unconnected light and pro creation modes cannot start a new manuscript', async t => {
  for (const mode of ['light', 'pro']) await t.test(mode, async t => {
    const model = mockModel([[...textParts('当前参与模式尚未接通，可以先继续讨论故事。'), finish()]]);
    const { service, tasks } = await setup(t, model);
    await service.start(snapshot.projectId, turnBody(`mode-${mode}`, '请直接开始写一篇小说。', { mode }));
    assert.equal((await completed(service, `mode-${mode}`)).status, 'completed');
    assert.deepEqual(model.doStreamCalls[0].tools.map(item => item.name), ['read_task_status']);
    assert.equal(tasks.attempts, 0);
  });
});

test('conversation mode is validated and is part of the durable turn identity', async t => {
  const model = mockModel([[...textParts('你好。'), finish()]]);
  const { service, tasks } = await setup(t, model);
  for (const mode of ['automatic', '', null, 0, {}, ['auto']]) {
    await assert.rejects(service.start(snapshot.projectId, turnBody('mode-invalid', '你好', { mode })), error => error.status === 400);
  }
  assert.equal(model.doStreamCalls.length, 0);
  const body = turnBody('mode-idempotent', '你好', { mode: 'auto' });
  await service.start(snapshot.projectId, body);
  await completed(service, 'mode-idempotent');
  assert.equal((await service.start(snapshot.projectId, structuredClone(body))).id, body.turnId);
  await assert.rejects(service.start(snapshot.projectId, { ...body, mode: 'light' }), error => error.status === 409);
  assert.equal(model.doStreamCalls.length, 1);
  assert.equal(tasks.attempts, 0);
});

test('a missing mode remains compatible with an explicit auto retry of the same turn', async t => {
  const model = mockModel([[...textParts('你好。'), finish()]]);
  const { service } = await setup(t, model);
  const body = turnBody('mode-legacy-default', '你好');
  await service.start(snapshot.projectId, body);
  await completed(service, body.turnId);
  assert.equal((await service.start(snapshot.projectId, { ...body, mode: 'auto' })).id, body.turnId);
  assert.equal(model.doStreamCalls.length, 1);
});

test('another auto writing message cannot create a second task while the first is queued', async t => {
  const model = mockModel([
    [toolCall('start_creation', { brief: '修船师故事。' }), finish('tool-calls')],
    [...textParts('第一篇正在成稿。'), finish()],
    [toolCall('start_creation', { brief: '另一篇不能并发覆盖当前稿件。' }, 'parallel-attempt'), finish('tool-calls')],
    [...textParts('已有任务正在运行，请等这篇完成。'), finish()],
  ]);
  const { service, tasks } = await setup(t, model);
  await service.start(snapshot.projectId, turnBody('auto-running-first', '请开始写一篇修船师的小说。', { mode: 'auto' }));
  await completed(service, 'auto-running-first');
  assert.equal(tasks.requests.length, 1);
  await service.start(snapshot.projectId, turnBody('auto-running-second', '再帮我写一篇别的故事。', { mode: 'auto' }));
  await completed(service, 'auto-running-second');
  assert.equal(tasks.attempts, 1, 'the running-task guard must apply even when a model attempts the tool again');
  assert.equal(tasks.requests.length, 1);
  assert.deepEqual(model.doStreamCalls[2].toolChoice, { type: 'auto' });
});
