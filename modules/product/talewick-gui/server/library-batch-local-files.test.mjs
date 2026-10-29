import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLibraryBatchService } from './library-batch-service.mjs';
import { createLibraryBatchQueue, libraryBatchFileState } from './library-batches.mjs';
import { createLibraryBatchRouter } from './library-batch-router.mjs';
import { createRuntime } from './index.mjs';

const waiting = { code: 'BATCH_LOCAL_FILE_WAIT' };
const resident = async () => ({ available: true });
const unavailable = async () => ({ available: false, reason: 'dataless' });
const deny = async () => assert.fail('No analysis, model, or background work is permitted');
function library() {
  return Object.fromEntries(['registerSource', 'startSource', 'waitSource', 'verifyIndexBinding', 'get', 'readSource', 'cancel'].map(k => [k, deny]));
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'talewick-batch-local-files-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function bytes(root) {
  const result = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    result[entry.name] = entry.isDirectory() ? await bytes(file) : (await readFile(file)).toString('base64');
  }
  return result;
}

for (const blocked of ['service.json', 'queue/queue.json', 'queue/.owner.json', '.', 'queue']) {
  test(`startup rejects dataless ${blocked} before acquiring ownership or replacing records`, async t => {
    const rootDir = await fixture(t);
    await mkdir(path.join(rootDir, 'queue'));
    await writeFile(path.join(rootDir, 'service.json'), 'preserved service placeholder');
    await writeFile(path.join(rootDir, 'queue/queue.json'), 'preserved queue placeholder');
    if (blocked === 'queue/.owner.json') await writeFile(path.join(rootDir, blocked), 'preserved owner placeholder');
    const before = await bytes(rootDir), inspected = [];
    const fileState = async file => {
      inspected.push(file);
      return file === path.resolve(rootDir, blocked) ? unavailable() : resident();
    };
    await assert.rejects(createLibraryBatchService({ library: library(), rootDir, ownsLibrary: false, fileState }), waiting);
    assert.ok(inspected.includes(path.resolve(rootDir, blocked)));
    assert.deepEqual(await bytes(rootDir), before, 'no owner, replacement state, or recovery writes');
  });
}

test('downloaded stores reopen byte-for-byte, retain owner exclusion, and never dispatch at startup', async t => {
  const rootDir = await fixture(t);
  assert.deepEqual(await libraryBatchFileState(path.join(rootDir, 'missing')), { available: false, reason: 'missing' });
  const service = await createLibraryBatchService({ library: library(), rootDir, ownsLibrary: false });
  assert.equal(service.progress().registered, 0);
  const owned = await bytes(rootDir);
  assert.deepEqual(await libraryBatchFileState(path.join(rootDir, 'service.json')), { available: true });
  await assert.rejects(createLibraryBatchService({ library: library(), rootDir, ownsLibrary: false }), { code: 'BATCH_STORE_BUSY' });
  assert.deepEqual(await bytes(rootDir), owned);
  await service.close();
  const saved = await bytes(rootDir);
  const restored = await createLibraryBatchService({ library: library(), rootDir, ownsLibrary: false });
  assert.equal(restored.progress().registered, 0);
  await restored.close();
  assert.deepEqual(await bytes(rootDir), saved);
});

test('downloaded queued work remains queued on reopen without repeating analysis', async t => {
  const rootDir = await fixture(t);
  const queue = await createLibraryBatchQueue({ rootDir, processOne: deny });
  await queue.addBatch({ batchId: 'saved-batch', sources: Array.from({ length: 10 }, (_, i) => ({
    sourceId: `saved-${i}`, sourceSha256: String(i).repeat(64), textVersion: 'text-1', expectedAnalysisVersion: null,
  })) });
  await queue.close();
  const saved = await bytes(rootDir);
  const restored = await createLibraryBatchQueue({ rootDir, processOne: deny });
  assert.equal(restored.progress().queued, 10);
  assert.equal(restored.progress().attempts, 0);
  await restored.close();
  assert.deepEqual(await bytes(rootDir), saved);
});

test('root and queue symlinks remain forbidden, and changed owner is never removed', async t => {
  const root = await fixture(t), target = path.join(root, 'target'), link = path.join(root, 'link');
  await mkdir(target); await symlink(target, link);
  await assert.rejects(createLibraryBatchService({ library: library(), rootDir: link, ownsLibrary: false }), { code: 'BATCH_STORE_SYMLINK' });
  const nested = path.join(root, 'nested'); await mkdir(nested); await symlink(target, path.join(nested, 'queue'));
  await assert.rejects(createLibraryBatchService({ library: library(), rootDir: nested, ownsLibrary: false }), { code: 'BATCH_STORE_SYMLINK' });
  assert.deepEqual(await readdir(target), []);
  const queue = await createLibraryBatchQueue({ rootDir: target, processOne: deny });
  const owner = path.join(target, '.owner.json'), foreign = '{"pid":1,"token":"foreign-owner"}';
  await writeFile(owner, foreign);
  await assert.rejects(queue.close(), { code: 'BATCH_STORE_CONFLICT' });
  assert.equal(await readFile(owner, 'utf8'), foreign);
});

test('queue rechecks locality before later reads and never deletes an unavailable owner', async t => {
  const rootDir = await fixture(t); let blocked;
  const fileState = file => file === blocked ? unavailable() : resident();
  const queue = await createLibraryBatchQueue({ rootDir, processOne: deny, fileState });
  blocked = path.join(rootDir, 'queue.json');
  await assert.rejects(queue.run(), waiting);
  const before = await bytes(rootDir);
  blocked = path.join(rootDir, '.owner.json');
  await assert.rejects(queue.close(), waiting);
  assert.deepEqual(await bytes(rootDir), before);
});

test('unavailable batch routes return 503 before parsing, scheduling, or claiming success', async () => {
  let response;
  const router = createLibraryBatchRouter({ service: null, unavailableCode: 'BATCH_LOCAL_FILE_WAIT',
    json: (_res, status, body) => { response = { status, body }; }, bodyJSON: deny, canRun: deny });
  for (const [method, suffix] of [['GET', ''], ['POST', ''], ['POST', '/run'], ['POST', '/recover'], ['POST', '/saved/cancel']]) {
    assert.equal(await router({ method }, {}, new URL(`http://localhost/api/library/batches${suffix}`)), true);
    assert.equal(response.status, 503);
    assert.deepEqual(Object.keys(response.body), ['error']);
    assert.equal(response.body.error.code, 'BATCH_LOCAL_FILE_WAIT');
    assert.match(response.body.error.message, /尚未下载.*写作与全文评阅仍可使用/);
    assert.equal(response.body.error.retryable, false);
  }
});

async function request(runtime, url, headers = {}) {
  let result;
  await runtime.server.listeners('request')[0]({ method: 'GET', url, headers: { host: '127.0.0.1:4326', ...headers } }, {
    writeHead(status) { result = { status }; },
    end(text) { result.body = JSON.parse(text); },
  });
  return result;
}

test('runtime keeps writing and independent review available while only cloud-wait batches degrade', async t => {
  const runsDir = await fixture(t), rootDir = path.join(runsDir, 'library-batches');
  await mkdir(rootDir);
  const stateFile = path.join(rootDir, 'service.json'), original = 'preserved inaccessible service record';
  await writeFile(stateFile, original);
  let closed = 0;
  const runtime = await createRuntime({ config: { runsDir, baseURL: 'https://api.deepseek.com', apiKey: 'test-only',
    model: 'deepseek-v4-flash', port: 4326, engine: 'fixed', agentProvider: 'deepseek' },
    model: { complete: deny }, workflow: deny, library: { ...library(), close: async () => { closed++; } },
    publicationFeedback: { close: async () => {} },
    libraryBatchFileState: file => file === stateFile ? unavailable() : resident(),
  });
  t.after(() => runtime.close());
  assert.equal(runtime.server.listening, false, 'the smoke test never opens a network listener');
  const info = await request(runtime, '/api/runtime');
  assert.equal(info.status, 200);
  assert.equal(info.body.configured, true);
  assert.equal(info.body.library.available, true);
  assert.equal(info.body.library.batchesAvailable, false);
  assert.equal(info.body.library.batchesUnavailableCode, 'BATCH_LOCAL_FILE_WAIT');
  assert.equal(info.body.independentReviews.available, true);
  assert.equal(info.body.full15.available, true);
  assert.equal(closed, 0);
  const tasks = await request(runtime, '/api/tasks');
  assert.equal(tasks.status, 200); assert.deepEqual(tasks.body.tasks, []);
  const reviews = await request(runtime, '/api/independent-reviews');
  assert.equal(reviews.status, 200); assert.equal(reviews.body.available, true);
  const batches = await request(runtime, '/api/library/batches');
  assert.equal(batches.status, 503); assert.equal(batches.body.error.code, 'BATCH_LOCAL_FILE_WAIT');
  assert.equal((await request(runtime, '/api/runtime', { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal(await readFile(stateFile, 'utf8'), original);
  assert.deepEqual(await readdir(rootDir), ['service.json']);
});
