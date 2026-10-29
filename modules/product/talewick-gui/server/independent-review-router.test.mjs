import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IndependentReviewService, createIndependentReviewRouter, independentReviewRequestHash } from './independent-review-service.mjs';
import { productManuscriptRevision } from './full15-service.mjs';

const chapters = [{ id: 'c1', title: '第一章', body: '窗外下着雨。' }];
const body = { projectId: 'project-http', requestId: 'request-http', caseId: 'case-http', title: '雨', chapters, manuscriptRevision: productManuscriptRevision('雨', chapters), mode: 'single' };

async function waitFor(service, id) { for (let i=0;i<200;i++) { const value=service.get(id); if (!['queued','running'].includes(value.status)) return value; await new Promise(resolve=>setTimeout(resolve,5)); } throw new Error('timeout'); }
async function request(router, method, route, payload) {
  let response; const req = { method }; const res = {};
  const json = (_res, status, value) => { response = { status, value }; };
  const handled = await router(req, res, new URL(route, 'http://127.0.0.1'), json, payload);
  return { handled, ...response };
}

test('router exposes create, list, get, cancel and retry contract without internal paths', async t => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-review-router-'));
  let service;
  const adapter = { getIndependentReviewVersions: async () => ({ protocolVersion: 'p1', rulesVersion: 'r1', toolVersion: 't1' }),
    startIndependentReview: async args => ({ schemaVersion: 'independent-review-task-1', status: 'complete', runDir: path.join(args.runRoot, 'run'), requestHash: independentReviewRequestHash(args.request), versions: {}, progress: { phase: 'complete', completedStages: 2, totalStages: 2 }, report: { automaticAdoption: false, literaryPass: 'NOT_COMPUTED' }, error: null }),
    resumeIndependentReview: async () => assert.fail('not expected') };
  service = await new IndependentReviewService({ rootDir, adapter, analyze: async()=>{}, prepareRequest: input => ({ request: { caseId: input.caseId, mode: 'single', baselineChapters: input.chapters }, provenance: {} }) }).init();
  t.after(async()=>{await service.close();await rm(rootDir,{recursive:true,force:true});});
  const router = createIndependentReviewRouter({ service, json: (_res,status,value)=>{_res.status=status;_res.value=value;}, bodyJSON: async req=>req.payload });
  const invoke = async (method, route, payload) => { const req={method,payload},res={}; const handled=await router(req,res,new URL(route,'http://127.0.0.1')); return {handled,status:res.status,value:res.value}; };
  const created = await invoke('POST','/api/independent-reviews',body); assert.equal(created.status,202); assert.equal(created.value.task.mode,'single');
  const done = await waitFor(service,created.value.task.id); assert.equal(done.status,'complete');
  const listed = await invoke('GET','/api/independent-reviews?projectId=project-http'); assert.equal(listed.value.tasks.length,1);
  const one = await invoke('GET',`/api/independent-reviews/${done.id}`); assert.equal(one.status,200); assert.equal(Object.hasOwn(one.value.task,'runDir'),false); assert.equal(one.value.task.report.literaryPass,'NOT_COMPUTED');
  await assert.rejects(invoke('POST',`/api/independent-reviews/${done.id}/retry`,{}), error => error.code === 'REVIEW_RERUN_FORBIDDEN' && error.status === 409);
});
