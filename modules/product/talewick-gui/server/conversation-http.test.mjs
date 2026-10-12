import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { MockLanguageModelV4 } from 'ai/test';
import { createRuntime } from './index.mjs';

const projectId = 'socket-test-project';
const allowedOrigin = 'http://127.0.0.1:4323';
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

function controlledModel() {
  let controller;
  let resolveReady;
  let ended = false;
  let signal;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const model = new MockLanguageModelV4({ doStream: async options => {
    assert.equal(model.doStreamCalls.length, 1, 'a subscriber must not start a new model generation');
    signal = options.abortSignal;
    return { stream: new ReadableStream({ start(value) {
      controller = value;
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'text-start', id: 'reply' });
      signal?.addEventListener('abort', () => {
        if (!ended) { ended = true; controller.error(new DOMException('Aborted', 'AbortError')); }
      }, { once: true });
      resolveReady();
    }, cancel() { ended = true; } }) };
  } });
  return {
    model, ready,
    get aborted() { return signal?.aborted; },
    text(delta) { assert.equal(ended, false); controller.enqueue({ type: 'text-delta', id: 'reply', delta }); },
    finish() {
      assert.equal(ended, false);
      controller.enqueue({ type: 'text-end', id: 'reply' });
      controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
      ended = true; controller.close();
    },
  };
}

async function until(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t) {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-conversation-http-'));
  const source = controlledModel();
  let workflowCalls = 0;
  const config = { runsDir, port: 0, baseURL: 'https://model.invalid/v1', apiKey: 'test-only-key', model: 'test-model', agentProvider: 'openai-compatible', engine: 'fixed', timeoutMs: 1000 };
  const runtime = await createRuntime({ config, full15Adapter: null, conversationModel: source.model,
    model: { complete: async () => { assert.fail('no business-model call is authorized by these conversation tests'); } },
    workflow: async () => { workflowCalls++; assert.fail('read-only websocket input must not start manuscript work'); },
  });
  let shutdown;
  const closeRuntime = () => shutdown ||= runtime.close();
  const clients = new Set();
  t.after(async () => {
    await closeRuntime();
    for (const socket of clients) socket.terminate();
    await new Promise(resolve => runtime.server.close(resolve));
    await rm(runsDir, { recursive: true, force: true });
  });
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const baseURL = `http://127.0.0.1:${runtime.server.address().port}`;
  const socketURL = turnId => `${baseURL.replace('http:', 'ws:')}/api/conversations/${projectId}/turns/${turnId}/socket`;
  const submit = async turnId => {
    const response = await fetch(`${baseURL}/api/conversations/${projectId}/turns`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: allowedOrigin },
      body: JSON.stringify({ turnId, text: '你好，先聊聊人物。', snapshot: { projectId, requestId: `snapshot-${turnId}`, kind: 'create', idea: '修钟人的故事。', context: {}, materials: [], style: null, chapters: [], instruction: '', quote: '', baseRevision: 'empty-v1' } }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.turn.status, 'running');
    await source.ready;
    return body.turn;
  };
  const subscribe = async (turnId, options = {}) => {
    const events = [];
    const socket = new WebSocket(socketURL(turnId), { origin: allowedOrigin, handshakeTimeout: 2000, ...options });
    clients.add(socket);
    const observer = { socket, events, closeCode: null, closed: false };
    socket.on('error', () => {});
    socket.on('message', bytes => events.push(JSON.parse(bytes.toString())));
    socket.on('close', code => { observer.closeCode = code; observer.closed = true; clients.delete(socket); });
    await once(socket, 'open');
    await until(() => events.some(event => event.type === 'snapshot'), 'initial websocket snapshot');
    return observer;
  };
  return { runtime, source, baseURL, socketURL, submit, subscribe, closeRuntime, get workflowCalls() { return workflowCalls; } };
}

test('POST plus a real WebSocket delivers text before model finish and then a final snapshot', async t => {
  const { runtime, source, submit, subscribe } = await fixture(t);
  await submit('streaming');
  const client = await subscribe('streaming');
  assert.equal(client.events[0].type, 'snapshot');
  source.text('我们先确定人物的目标，');
  await until(() => client.events.some(event => event.type === 'text'), 'first live delta');
  assert.equal(client.events.find(event => event.type === 'text').delta, '我们先确定人物的目标，');
  assert.equal(runtime.conversations.get(projectId, 'streaming').status, 'running');
  assert.equal(client.events.some(event => event.type === 'done'), false);
  assert.equal(client.closed, false);
  source.text('再聊他的代价。');
  source.finish();
  await until(() => client.closed, 'completed websocket to close');
  const done = client.events.find(event => event.type === 'done');
  assert.ok(done);
  assert.equal(done.turn.status, 'completed');
  assert.equal(done.turn.assistantText, '我们先确定人物的目标，再聊他的代价。');
  assert.equal(client.closeCode, 1000);
  assert.equal(source.model.doStreamCalls.length, 1);
});

test('disconnect and reconnect recover a full snapshot without restarting the running model', async t => {
  const { runtime, source, submit, subscribe } = await fixture(t);
  await submit('reconnect');
  const first = await subscribe('reconnect');
  source.text('先确定人物。');
  await until(() => first.events.some(event => event.type === 'text'), 'first connection delta');
  first.socket.close(1000);
  await until(() => first.closed, 'first connection to close');
  assert.equal(runtime.conversations.get(projectId, 'reconnect').status, 'running');
  assert.equal(source.aborted, false);
  source.text('断线期间继续生成。');
  await until(() => runtime.conversations.get(projectId, 'reconnect').assistantText.includes('断线期间'), 'model progress while disconnected');
  const second = await subscribe('reconnect');
  const snapshot = second.events.find(event => event.type === 'snapshot').turn;
  assert.equal(snapshot.assistantText, '先确定人物。断线期间继续生成。');
  assert.equal(snapshot.status, 'running');
  assert.equal(source.model.doStreamCalls.length, 1);
  source.text('最后补齐回复。');
  source.finish();
  await until(() => second.closed, 'reconnected stream to finish');
  assert.equal(second.events.find(event => event.type === 'done').turn.assistantText, '先确定人物。断线期间继续生成。最后补齐回复。');
  assert.equal(source.model.doStreamCalls.length, 1);
});

test('host, origin, path and turn validation reject WebSocket upgrades before subscription', async t => {
  const { source, submit, socketURL } = await fixture(t);
  await submit('authorized-turn');
  const cases = [
    { label: 'foreign origin', url: socketURL('authorized-turn'), options: { origin: 'https://outside.invalid' }, status: 403 },
    { label: 'foreign host', url: socketURL('authorized-turn'), options: { headers: { Host: 'outside.invalid' } }, status: 403 },
    { label: 'wrong path', url: socketURL('authorized-turn').replace('/socket', '/different'), status: 404 },
    { label: 'unexpected query', url: socketURL('authorized-turn') + '?create=true', status: 404 },
    { label: 'unknown turn', url: socketURL('unknown-turn'), status: 404 },
  ];
  for (const entry of cases) await t.test(entry.label, async () => {
    const outcome = await new Promise((resolve, reject) => {
      const socket = new WebSocket(entry.url, { origin: allowedOrigin, handshakeTimeout: 2000, ...entry.options });
      socket.on('error', () => {});
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode);
        socket.terminate();
      });
      socket.once('open', () => { socket.terminate(); reject(new Error('an unauthorized upgrade unexpectedly succeeded')); });
      socket.once('close', () => resolve('closed before HTTP rejection'));
    });
    assert.equal(outcome, entry.status);
  });
  assert.equal(source.model.doStreamCalls.length, 1);
});

test('application messages close a subscription with 1008 and cannot create manuscript tasks', async t => {
  const fixtureValue = await fixture(t);
  const { runtime, source, submit, subscribe } = fixtureValue;
  await submit('read-only');
  const client = await subscribe('read-only');
  client.socket.send(JSON.stringify({ type: 'start_creation', brief: '请开始写小说。', text: '直接开始写。' }));
  await until(() => client.closed, 'read-only policy close');
  assert.equal(client.closeCode, 1008);
  assert.deepEqual(runtime.tasks.list(projectId), []);
  assert.equal(fixtureValue.workflowCalls, 0);
  assert.equal(runtime.conversations.get(projectId, 'read-only').status, 'running');
  assert.equal(source.aborted, false);
  assert.equal(source.model.doStreamCalls.length, 1);
});

test('runtime shutdown interrupts the active model and closes every subscribed WebSocket', async t => {
  const { runtime, source, submit, subscribe, closeRuntime } = await fixture(t);
  await submit('shutdown');
  const clients = await Promise.all([subscribe('shutdown'), subscribe('shutdown')]);
  source.text('关闭前已经收到的内容。');
  await until(() => clients.every(client => client.events.some(event => event.type === 'text')), 'both subscribers to receive partial output');
  await closeRuntime();
  await until(() => clients.every(client => client.closed), 'all runtime sockets to close');
  await until(() => runtime.conversations.listeners.size === 0, 'closed subscription listeners to be removed');
  assert.equal(source.aborted, true);
  assert.equal(runtime.conversations.active.size, 0);
  const turn = runtime.conversations.get(projectId, 'shutdown');
  assert.equal(turn.status, 'interrupted');
  assert.equal(turn.assistantText, '关闭前已经收到的内容。');
  assert.equal(source.model.doStreamCalls.length, 1);
});
