import test from 'node:test';
import assert from 'node:assert/strict';
import {listIndependentReviews} from '../src/model/independent-review.ts';

for (const stage of ['headers', 'body']) {
  test('history timeout cancels stalled ' + stage + ' and allows a fresh read', async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    let signal;
    const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => {
      signal = options.signal;
      const stalled = new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      });
      return stage === 'headers' ? stalled : {ok: true, json: () => stalled};
    });
    const pending = listIndependentReviews('project-test');
    const rejected = assert.rejects(pending, /读取评阅历史超时/);
    await Promise.resolve();
    t.mock.timers.tick(14999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.mockImplementation(async () => Response.json({tasks: []}));
    assert.deepEqual((await listIndependentReviews('project-test')).tasks, []);
  });
}

test('completed and failed reads clear their timers and keep service errors', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const signals = [];
  let reply = {tasks: []}, status = 200;
  t.mock.method(globalThis, 'fetch', async (_url, {signal}) => {
    signals.push(signal);
    return Response.json(reply, {status});
  });
  assert.deepEqual((await listIndependentReviews('project-test')).isolatedReports, []);
  reply = {error: '合成服务暂不可用'};
  status = 503;
  await assert.rejects(listIndependentReviews('project-test'), /合成服务暂不可用/);
  t.mock.timers.tick(15000);
  assert(signals.every(signal => !signal.aborted));
});

test('caller cancellation aborts the request and remains distinct from a timeout', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let requestSignal;
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, {signal}) => {
    requestSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
  });
  const caller = new AbortController();
  const pending = listIndependentReviews('project-test', caller.signal);
  const rejected = assert.rejects(pending, {name: 'AbortError'});
  caller.abort();
  await rejected;
  assert.equal(requestSignal.aborted, true);
  t.mock.timers.tick(15000);
  await assert.rejects(listIndependentReviews('project-test', caller.signal), {name: 'AbortError'});
  assert.equal(fetch.mock.callCount(), 1, 'already cancelled callers dispatch no request');
});

test('history rejects foreign, malformed and duplicate rows while accepting legacy report sides', async t => {
  const task = {id: 'task-one', projectId: 'project-test', mode: 'single', status: 'running',
    manuscriptRevision: 'saved', createdAt: '2026-01-01T00:00:00Z', progress: {completedStages: 0, totalStages: 1}};
  const report = {id: 'report-one', title: '合成稿', manuscriptRevision: 'saved',
    createdAt: '2026-01-01T00:00:00Z', synthetic: true};
  let reply = {tasks: [task], isolatedReports: [report]};
  t.mock.method(globalThis, 'fetch', async () => Response.json(reply));
  assert.equal((await listIndependentReviews('project-test')).isolatedReports[0].version, undefined);
  const invalid = [
    {tasks: [null]}, {tasks: [{...task, projectId: 'other-project'}]},
    {tasks: [{...task, progress: null}]}, {tasks: [{...task, status: 'unknown'}]},
    {tasks: [task, task]}, {tasks: [], isolatedReports: [null]},
    {tasks: [], isolatedReports: [report, report]},
    {tasks: [], isolatedReports: [{...report, version: 'candidate'}]},
    {tasks: [], isolatedReports: [{...report, createdAt: 'invalid'}]},
  ];
  for (reply of invalid) await assert.rejects(listIndependentReviews('project-test'), /评阅历史记录有误/);
});
