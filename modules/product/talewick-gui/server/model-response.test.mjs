import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.mjs';
import { readModelResponse } from './model-response.mjs';

const config = { baseURL: 'https://api.deepseek.com', apiKey: 'synthetic-key', model: 'deepseek-v4-flash', timeoutMs: 100, idleTimeoutMs: 40 };
const input = { stage: 'planning', system: '只返回 JSON', user: '合成故事，不含用户资料', maxTokens: 6000 };
const encode = value => new TextEncoder().encode(value);
const chunk = (delta = {}, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const end = (finish = 'stop') => `${chunk({}, finish)}data: [DONE]\n\n`;
const settle = () => new Promise(resolve => setImmediate(resolve));
function controlled() {
  let controller, cancelled = false;
  const body = new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled = true; } });
  return { response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    send: value => controller.enqueue(typeof value === 'string' ? encode(value) : value),
    close: () => controller.close(), fail: error => controller.error(error), get cancelled() { return cancelled; } };
}
const sse = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });

test('native SSE handles split UTF-8, CRLF, multiple data lines, comments and trailing usage', async () => {
  const source = controlled();
  let progress = 0;
  const read = readModelResponse(source.response, { onProgress() { progress++; } });
  const text = ': keep-alive\r\n\r\n' + chunk({ reasoning_content: 'private transient reasoning' }).replaceAll('\n', '\r\n')
    + 'data: {"choices": [\r\ndata: {"index":0,"delta":{"content":"夜里，她推开门。"},"finish_reason":null}]}\r\n\r\n'
    + chunk({}, 'stop') + 'data: {"choices":[],"usage":{"completion_tokens":12}}\n\ndata: [DONE]\n\n';
  for (const byte of encode(text)) source.send(Uint8Array.of(byte));
  const result = await read;
  assert.deepEqual(result, { finish_reason: 'stop', message: { content: '夜里，她推开门。' }, hasReasoning: true });
  assert.equal(progress, 2);
  assert.equal(source.cancelled, true);
  assert.doesNotMatch(JSON.stringify(result), /private transient reasoning/);
});

test('SSE requires a valid finish and DONE, never accepts partial output', async t => {
  const cases = [
    ['missing DONE', chunk({ content: '半篇' }) + chunk({}, 'stop')],
    ['missing finish', chunk({ content: '半篇' }) + 'data: [DONE]\n\n'],
    ['missing event terminator', chunk({ content: '半篇' }) + chunk({}, 'stop') + 'data: [DONE]'],
    ['unknown finish', chunk({ content: '正文' }, 'invented') + 'data: [DONE]\n\n'],
    ['extra content after finish', chunk({ content: '正文' }, 'stop') + chunk({ content: '尾巴' }) + 'data: [DONE]\n\n'],
    ['invalid JSON', 'data: {bad}\n\n'],
    ['HTTP 200 provider error', 'data: {"error":{"message":"synthetic-key private-input"}}\n\n'],
    ['invalid choice', 'data: {"choices":[{"index":0,"delta":{"content":["bad"]},"finish_reason":"stop"}]}\n\n'],
  ];
  for (const [name, text] of cases) await t.test(name, async () => {
    await assert.rejects(readModelResponse(sse(text)), error => {
      assert.doesNotMatch(error.message, /synthetic-key|private-input|半篇|尾巴/);
      return /未完成|无法识别/.test(error.message);
    });
  });
});

test('reader rejects broken UTF-8 and redacts a failed provider body', async () => {
  await assert.rejects(readModelResponse(sse(new Uint8Array([0xe4, 0xb8]))), /无法识别/);
  const source = controlled();
  const read = readModelResponse(source.response);
  source.fail(new Error('private upstream request synthetic-key'));
  await assert.rejects(read, error => /未完成/.test(error.message) && !error.message.includes('synthetic-key'));
});

test('reader enforces total, event and collected content byte limits', async t => {
  for (const [name, text, limits] of [
    ['total', ': keep-alive\n\n'.repeat(20), { responseBytes: 100 }],
    ['event', 'data: ' + 'x'.repeat(90), { eventBytes: 80 }],
    ['content', chunk({ content: '中文正文' }) + end(), { contentBytes: 10 }],
  ]) await t.test(name, () => assert.rejects(readModelResponse(sse(text), { limits }), /读取上限/));
});

test('explicit JSON compatibility keeps content and a reasoning flag, rejects an SSE MIME mismatch', async () => {
  const result = await readModelResponse(Response.json({ choices: [{ finish_reason: 'stop', message: { content: '完整正文', reasoning_content: 'private reasoning' } }] }));
  assert.deepEqual(result, { finish_reason: 'stop', message: { content: '完整正文' }, hasReasoning: true });
  await assert.rejects(readModelResponse(new Response(chunk({ content: '正文' }) + end(), { headers: { 'content-type': 'application/json' } })), /无法识别/);
  await assert.rejects(readModelResponse(new Response('{}')), /无法识别/);
});

test('native business call preserves JSON mode, token budget, stream and reasoning configuration', async () => {
  let body;
  const model = createModel(config, async (_url, init) => { body = JSON.parse(init.body); return sse(chunk({ content: '{"title":"合成"}' }) + end()); });
  assert.equal(await model.complete(input), '{"title":"合成"}');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 32768);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, undefined);
});

test('compatible endpoints and older DeepSeek models remain non-streaming', async () => {
  for (const override of [{ agentProvider: 'openai-compatible' }, { model: 'deepseek-chat' }]) {
    let body;
    const model = createModel({ ...config, ...override }, async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '正文' } }] });
    });
    assert.equal(await model.complete(input), '正文');
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 6000);
  }
});

test('real reasoning/content progress extends idle time while the total deadline stays fixed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = controlled();
  const result = createModel(config, async () => source.response).complete(input);
  await settle();
  t.mock.timers.tick(30); source.send(chunk({ reasoning_content: 'private progress' })); await settle();
  t.mock.timers.tick(30); source.send(chunk({ content: '正文' })); await settle();
  t.mock.timers.tick(30); source.send(end());
  assert.equal(await result, '正文');
});

test('keep-alives and empty deltas do not reset the no-progress deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = controlled(); let calls = 0;
  const result = createModel(config, async () => { calls++; return source.response; }).complete(input);
  const rejected = assert.rejects(result, /模型响应超时：长时间未收到生成进展/);
  await settle();
  t.mock.timers.tick(30); source.send(': keep-alive\n\n' + chunk({ role: 'assistant', content: '', reasoning_content: '' })); await settle();
  t.mock.timers.tick(11); await rejected;
  assert.equal(calls, 1);
  assert.equal(source.cancelled, true);
});

test('continuing progress cannot extend the hard deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = controlled(); let calls = 0;
  const result = createModel(config, async () => { calls++; return source.response; }).complete(input);
  const rejected = assert.rejects(result, /模型响应超时：已达到本步骤等待上限/);
  await settle();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(30); source.send(chunk({ reasoning_content: 'progress' })); await settle(); }
  t.mock.timers.tick(11); await rejected;
  assert.equal(calls, 1);
});

test('a caller abort cancels a blocked stream immediately and is never retried', async () => {
  const source = controlled(), controller = new AbortController(), reason = new Error('cancelled by test');
  let calls = 0;
  const result = createModel(config, async () => { calls++; return source.response; }).complete({ ...input, signal: controller.signal });
  const rejected = assert.rejects(result, error => error === reason);
  await settle(); controller.abort(reason); await rejected;
  assert.equal(calls, 1); assert.equal(source.cancelled, true);
});

test('reasoning-only recovery uses the same stream, original request and shared deadline once', async () => {
  const sent = [];
  const model = createModel(config, async (_url, init) => {
    sent.push(init);
    return sent.length === 1 ? sse(chunk({ reasoning_content: 'private' }) + end()) : sse(chunk({ content: '完整正文' }) + end());
  });
  assert.equal(await model.complete(input), '完整正文');
  assert.equal(sent.length, 2); assert.equal(sent[0].signal, sent[1].signal);
  const first = JSON.parse(sent[0].body), second = JSON.parse(sent[1].body);
  assert.deepEqual(second.messages, first.messages);
  assert.equal(second.stream, true); assert.equal(second.max_tokens, 16000);
  assert.deepEqual(second.thinking, { type: 'disabled' });
  assert.doesNotMatch(sent[1].body, /private/);
});

test('recovery cannot reset the hard deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = controlled(), second = controlled(); let calls = 0;
  const result = createModel({ ...config, idleTimeoutMs: 80 }, async () => (++calls === 1 ? first : second).response).complete(input);
  const rejected = assert.rejects(result, /模型响应超时：已达到本步骤等待上限/);
  await settle(); t.mock.timers.tick(70); first.send(chunk({ reasoning_content: 'private' }) + end()); await settle();
  assert.equal(calls, 2); t.mock.timers.tick(31); await rejected;
  assert.equal(calls, 2);
});

test('starting recovery without new generated content does not reset the no-progress clock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = controlled(), second = controlled(); let calls = 0;
  const result = createModel(config, async () => (++calls === 1 ? first : second).response).complete(input);
  const rejected = assert.rejects(result, /模型响应超时：长时间未收到生成进展/);
  await settle(); t.mock.timers.tick(20); first.send(chunk({ reasoning_content: 'private' })); await settle();
  t.mock.timers.tick(30); first.send(end()); await settle();
  assert.equal(calls, 2); t.mock.timers.tick(11); await rejected;
  assert.equal(calls, 2);
});

test('review and prose length recover once; unknown stages and second truncations fail', async () => {
  for (const [stage, secondWorks, expectedCalls] of [['review', true, 2], ['review', false, 2], ['draft:ch-1', true, 2], ['draft:ch-10', false, 2], ['unknown', true, 1]]) {
    let calls = 0;
    const model = createModel(config, async () => {
      calls++;
      return calls === 2 && secondWorks ? sse(chunk({ content: '{"issues":[]}' }) + end())
        : sse(chunk({ reasoning_content: 'private', content: '{"unfinished":' }) + end('length'));
    });
    if (stage !== 'unknown' && secondWorks) assert.equal(await model.complete({ ...input, stage }), '{"issues":[]}');
    else await assert.rejects(model.complete({ ...input, stage }), /长度上限/);
    assert.equal(calls, expectedCalls);
  }
});
