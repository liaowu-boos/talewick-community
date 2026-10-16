import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPublicationFeedbackRouter, createPublicationFeedbackService, PUBLICATION_FEEDBACK_LOCAL_FILE_WAIT, publicationFeedbackFileState } from './publication-feedback.mjs';

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-publication-feedback-cloud-'));
  const catalog = path.join(rootDir, 'catalog.json');
  const original = Buffer.from('x'.repeat(69));
  await writeFile(catalog, original);
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  return { rootDir, catalog, original };
}

function adapters(calls) {
  return {
    async createPublicationFeedbackStore() {
      calls.initialize++;
      return {
        async listPublications() { calls.read++; return [{ id: 'stored-publication' }]; },
        async createPublication(payload) { calls.write++; return { id: 'new-publication', ...payload, reviews: [] }; },
        async close() { calls.close++; },
      };
    },
  };
}

const counts = () => ({ initialize: 0, read: 0, write: 0, close: 0 });
const waiting = error => error.code === 'LOCAL_FILE_WAIT' && error.status === 503 && error.message === PUBLICATION_FEEDBACK_LOCAL_FILE_WAIT;

test('dataless catalog never initializes, reads, writes, or changes the original bytes', async t => {
  const f = await fixture(t), calls = counts();
  const service = await createPublicationFeedbackService({ rootDir: f.rootDir, model: {}, adapters: adapters(calls),
    catalogFileState: async file => { assert.equal(file, f.catalog); return { available: false, reason: 'dataless' }; } });

  await assert.rejects(service.list(), waiting);
  await assert.rejects(service.create({ title: 'must not write' }), waiting);
  assert.deepEqual(calls, { initialize: 0, read: 0, write: 0, close: 0 });

  const responses = [];
  const router = createPublicationFeedbackRouter({ service, json: (_res, status, body) => responses.push({ status, body }), bodyJSON: async () => ({}) });
  assert.equal(await router({ method: 'GET' }, {}, new URL('http://localhost/api/publication-feedback')), true);
  assert.deepEqual(responses, [{ status: 503, body: { error: PUBLICATION_FEEDBACK_LOCAL_FILE_WAIT, code: 'LOCAL_FILE_WAIT' } }]);

  await service.close();
  await assert.rejects(service.list(), error => error.code === 'SERVICE_CLOSED' && error.status === 503);
  assert.deepEqual(calls, { initialize: 0, read: 0, write: 0, close: 0 }, 'close never initializes a waiting store');
  assert.deepEqual(await readFile(f.catalog), f.original);
});

test('one request initializes after hydration and normal reads and writes resume', async t => {
  const f = await fixture(t), calls = counts(); let hydrated = false;
  const service = await createPublicationFeedbackService({ rootDir: f.rootDir, model: {}, adapters: adapters(calls),
    catalogFileState: async () => hydrated ? { available: true } : { available: false, reason: 'dataless' } });
  await assert.rejects(service.list(), waiting);
  hydrated = true;

  const [first, second] = await Promise.all([service.list(), service.list()]);
  assert.deepEqual(first, [{ id: 'stored-publication' }]);
  assert.deepEqual(second, first);
  assert.equal(calls.initialize, 1, 'concurrent hydration initializes once');
  const created = await service.create({ title: 'hydrated' });
  assert.equal(created.id, 'new-publication');
  assert.deepEqual(calls, { initialize: 1, read: 2, write: 1, close: 0 });
  await service.close();
  assert.equal(calls.close, 1);
  assert.deepEqual(await readFile(f.catalog), f.original, 'service wrapper never replaces the hydrated catalog');
});

test('ordinary missing or materialized catalogs keep eager initialization and metadata errors propagate', async t => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-publication-feedback-normal-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  assert.deepEqual(await publicationFeedbackFileState(path.join(rootDir, 'catalog.json')), { available: false, reason: 'missing' });
  await writeFile(path.join(rootDir, 'catalog.json'), '{}');
  assert.deepEqual(await publicationFeedbackFileState(path.join(rootDir, 'catalog.json')), { available: true });

  const eager = counts();
  const service = await createPublicationFeedbackService({ rootDir, model: {}, adapters: adapters(eager), catalogFileState: async () => ({ available: true }) });
  assert.equal(eager.initialize, 1);
  await service.close();

  const sentinel = Object.assign(new Error('metadata failure'), { code: 'EACCES' }), untouched = counts();
  await assert.rejects(createPublicationFeedbackService({ rootDir, model: {}, adapters: adapters(untouched), catalogFileState: async () => { throw sentinel; } }), error => error === sentinel);
  assert.equal(untouched.initialize, 0);
});

test('the real non-dataless store still initializes eagerly and closes normally', async t => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-publication-feedback-real-store-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const service = await createPublicationFeedbackService({ rootDir, model: { complete: async () => assert.fail('model must not run') }, configured: () => false });
  assert.deepEqual(await service.list(), []);
  const catalog = JSON.parse(await readFile(path.join(rootDir, 'catalog.json'), 'utf8'));
  assert.deepEqual(catalog, { schemaVersion: 'publication-feedback-catalog-v1', publications: [] });
  await service.close();
});


test('closing an active review preserves its failed record before closing its already-open store', async t => {
  const f=await fixture(t);let started, reviewStarted=new Promise(resolve=>{started=resolve;}), persisted, closed=0;
  const publication={id:'active',revision:1,textSha256:'a'.repeat(64),observations:[{id:'observation'}],reviews:[]};
  const service=await createPublicationFeedbackService({rootDir:f.rootDir,model:{},catalogFileState:async()=>({available:true}),adapters:{
    createPublicationFeedbackStore:async()=>({getPublication:async()=>structuredClone(publication),
      addReview:async(_id,result)=>{assert.equal(closed,0);persisted=result;return {...publication,reviews:[{id:'failed-review',...result}]};},
      close:async()=>{closed++;}}),
    assessPublication:()=>({}),comparePublications:()=>({}),buildPublicationFeedbackRequest:()=>({inputHash:'b'.repeat(64)}),
    analyzePublicationFeedback:async({signal})=>{started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));},
  }});
  const running=service.review('active',{expectedRevision:1});await reviewStarted;
  const closing=service.close();const result=await running;await closing;
  assert.equal(persisted.status,'failed');assert.equal(result.review.status,'failed');assert.equal(closed,1);
  assert.deepEqual(await readFile(f.catalog),f.original);
});
