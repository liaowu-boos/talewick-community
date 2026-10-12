import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Full15Service, manuscriptText, productManuscriptRevision } from './full15-service.mjs';

const chapters = [{ id: 'ch-1', title: '第一章', body: '她把钥匙放回桌面。' }];
const input = { projectId: 'project-1', requestId: 'manual-request-1', title: '钥匙', chapters, manuscriptRevision: productManuscriptRevision('钥匙', chapters), runRoot: '/browser/must-not-control' };
const result = args => ({ schemaVersion: 'full15-product-task-1', status: 'complete', runDir: path.join(args.runRoot, 'generated'), manuscriptSha256: args.manuscript.sha256, rulesVersion: 'rules-1', toolVersion: 'tool-1', stages: {}, progress: { phase: 'verified', completedChunks: 2, totalChunks: 2, completedStages: 2 }, report: { path: 'report.json', sha256: 'a'.repeat(64), checks: { C01: 'pass' }, coverageComplete: true }, error: null });
async function settled(service, id) { for (let i=0;i<300;i++) { const task=service.get(id); if (!['queued','running'].includes(task.status) && !service.busy) return task; await new Promise(r=>setTimeout(r,5)); } throw new Error('timeout'); }
async function fixture(t, startFull15Review) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-full15-product-'));
  const calls=[],resumeCalls=[]; const adapter={ getFull15Versions:()=>({rulesVersion:'rules-1',toolVersion:'tool-1'}), startFull15Review: async args => { calls.push(args); return startFull15Review ? startFull15Review(args) : result(args); }, resumeFull15Review:async args=>{resumeCalls.push(args);return result({...args,runRoot:path.dirname(path.dirname(args.runDir))});} };
  const service=await new Full15Service({rootDir,adapter,analyze:async()=>assert.fail('adapter fixture owns calls'),inputForManuscript:async()=>({requirements:{c05_applicable:false},references:{sources:[]},profile:'no_corpus'})}).init();
  t.after(async()=>{await service.close();await rm(rootDir,{recursive:true,force:true});}); return {service,calls,resumeCalls,rootDir};
}

test('manual review freezes exact manuscript and server-owned run root', async t => {
  const f=await fixture(t); const task=await f.service.start(input); const done=await settled(f.service,task.id);
  assert.equal(done.status,'complete'); assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].manuscript.text,manuscriptText(input.title,input.chapters));
  assert.equal(f.calls[0].runRoot,path.join(await realpath(f.rootDir),'runs'));
  assert.notEqual(f.calls[0].runRoot,input.runRoot); assert.equal(f.calls[0].signal instanceof AbortSignal,true);
  assert.equal(f.service.list(input.projectId)[0].frozen,undefined);
});

test('cancelled auxiliary check cannot become complete after a late adapter result', async t => {
  let release; const f=await fixture(t,args=>new Promise(resolve=>{release=()=>resolve(result(args));}));
  const task=await f.service.start(input); while(f.service.get(task.id).status!=='running') await new Promise(r=>setTimeout(r,2));
  await f.service.cancel(task.id); release(); const done=await settled(f.service,task.id);
  assert.equal(done.status,'cancelled'); assert.equal(done.report,null);
});

test('recheck creates a linked attempt and preserves the frozen manuscript', async t => {
  const f=await fixture(t); const first=await f.service.start(input); await settled(f.service,first.id);
  const retry=await f.service.retry(first.id); assert.notEqual(retry.id,first.id); assert.equal(retry.linkedAttemptId,first.id);
  await settled(f.service,retry.id); assert.equal(f.calls[1].manuscript.sha256,f.calls[0].manuscript.sha256);
  assert.equal(f.service.get(first.id).status,'complete');
});

test('same-version incomplete recheck preserves automatic requirements and attempt lineage', async t => {
  const f = await fixture(t, args => ({ ...result(args), status: 'incomplete' }));
  const configuredInput = { requirements: { c05_applicable: true, min_body_length: 9000, max_body_length: 11000, min_chapters: 10, max_chapters: 10 }, references: { sources: [] }, profile: 'no_corpus' };
  const first = await f.service.start(input, { trigger: 'automatic', sourceTaskId: 'automatic-with-spec', configuredInput });
  assert.equal((await settled(f.service, first.id)).status, 'incomplete');
  const retry = await f.service.retry(first.id);
  await settled(f.service, retry.id);
  assert.equal(retry.linkedAttemptId, first.id);
  assert.deepEqual(f.calls[1].requirements, configuredInput.requirements);
  assert.deepEqual(f.calls[1].references, configuredInput.references);
  assert.equal(f.calls[1].manuscript.sha256, f.calls[0].manuscript.sha256);
});

test('server-configured directory aliases resolve before reaching the adapter', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'talewick-full15-alias-'));
  const target = path.join(parent, 'target'), alias = path.join(parent, 'alias');
  await mkdir(target); await symlink(target, alias, 'dir');
  let dispatchedRoot;
  const service = await new Full15Service({ rootDir: alias, adapter: { getFull15Versions: () => ({}), startFull15Review: async args => { dispatchedRoot = args.runRoot; return result(args); } }, analyze: async () => {}, inputForManuscript: async () => ({ requirements: {}, references: { sources: [] }, profile: 'no_corpus' }) }).init();
  t.after(async () => { await service.close(); await rm(parent, { recursive: true, force: true }); });
  const task = await service.start(input);
  assert.equal((await settled(service, task.id)).status, 'complete');
  assert.equal(dispatchedRoot, path.join(await realpath(target), 'runs'));
});

test('same-version interrupted work resumes its original run and keeps completed stages', async t => {
  const f=await fixture(t);const first=await f.service.start(input);await settled(f.service,first.id);
  const stored=f.service.tasks.get(first.id);stored.status='interrupted';stored.progress={phase:'interrupted',completedChunks:1,totalChunks:2,completedStages:1};
  const resumed=await f.service.retry(first.id);assert.equal(resumed.id,first.id);assert.equal(resumed.progress.completedStages,1);
  await settled(f.service,first.id);assert.equal(f.calls.length,1);assert.equal(f.resumeCalls.length,1);
});

test('public report includes user-facing issues but excludes paths, hashes and adapter result receipts', async t => {
  const f=await fixture(t,async args=>{
    const runDir=path.join(args.runRoot,'generated');await mkdir(runDir,{recursive:true});
    const body={checks:[{id:'C03',name:'明确知情矛盾',status:'checked',data:{summary:'发现一处需核对。'}}],issues:[{id:'i1',check_id:'C03',reasoning:'两处说法需核对。',citations:[{quote:'原文引句。'}]}],priority_issue_ids:['i1'],limitations:['辅助诊断。']};
    const raw=Buffer.from(JSON.stringify(body));await writeFile(path.join(runDir,'report.json'),raw);
    const value=result(args);value.runDir=runDir;value.report={path:path.join(runDir,'report.json'),sha256:createHash('sha256').update(raw).digest('hex'),checks:[],coverageComplete:true};return value;
  });
  const task=await f.service.start(input),done=await settled(f.service,task.id);
  assert.equal(done.report.issues[0].reasoning,'两处说法需核对。');
  for(const key of ['runDir','manuscriptSha256','rulesVersion','toolVersion','inputVersion','result'])assert.equal(Object.hasOwn(done,key),false);
  assert.equal(Object.hasOwn(done.report,'path'),false);assert.equal(Object.hasOwn(done.report,'sha256'),false);
});

test('automatic submission is idempotent by creation task id', async t => {
  const f=await fixture(t); const automatic={...input,requestId:'creation-1'};const a=await f.service.start(automatic,{trigger:'automatic',sourceTaskId:'creation-task-1'}); const b=await f.service.start(automatic,{trigger:'automatic',sourceTaskId:'creation-task-1'});
  assert.equal(a.id,b.id); await settled(f.service,a.id); assert.equal(f.calls.length,1);
});

test('manual version must match text and concurrent same-manuscript starts are idempotent before input resolution',async t=>{
 let release;const f=await fixture(t);f.service.inputForManuscript=()=>new Promise(resolve=>{release=()=>resolve({requirements:{},references:{sources:[]},profile:'no_corpus'});});
 await assert.rejects(f.service.start({...input,requestId:'bad-version',manuscriptRevision:'manuscript-v1-wrong'}),error=>error.code==='MANUSCRIPT_VERSION_MISMATCH');
 const first=f.service.start({...input,requestId:'race-1'});while(!release)await new Promise(r=>setTimeout(r,1));const second=f.service.start({...input,requestId:'race-2'});release();
 const [a,b]=await Promise.all([first,second]);assert.equal(a.id,b.id);await settled(f.service,a.id);assert.equal(f.calls.length,1);
});

test('a queued persisted run resumes through adapter instead of restarting cold read',async t=>{
 const rootDir=await mkdtemp(path.join(os.tmpdir(),'talewick-full15-resume-')),id=crypto.randomUUID(),runDir=path.join(rootDir,'runs','full15-task-seeded','run');await mkdir(path.dirname(runDir),{recursive:true});
 const text=manuscriptText(input.title,input.chapters),manuscriptSha256=(await import('node:crypto')).createHash('sha256').update(text).digest('hex');
 const saved={id,projectId:input.projectId,requestId:'seeded-request',trigger:'manual',status:'queued',manuscriptRevision:input.manuscriptRevision,manuscriptSha256,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),progress:{phase:'cold_saved',completedChunks:1,totalChunks:2,completedStages:1},report:null,error:null,runDir,rulesVersion:'rules-1',toolVersion:'tool-1',inputVersion:'input-1',frozen:{manuscript:{text,sha256:manuscriptSha256},requirements:{},references:{sources:[]},profile:'no_corpus'}};
 await writeFile(path.join(rootDir,`${id}.json`),JSON.stringify(saved));let starts=0,resumes=0;const adapter={getFull15Versions:()=>({rulesVersion:'rules-1',toolVersion:'tool-1'}),startFull15Review:async()=>{starts++;throw Error('must not start');},resumeFull15Review:async args=>{resumes++;return result({...args,runRoot:path.dirname(path.dirname(runDir))});}};
 const service=await new Full15Service({rootDir,adapter,analyze:async()=>{},inputForManuscript:async()=>({})}).init();t.after(async()=>{await service.close();await rm(rootDir,{recursive:true,force:true});});
 await settled(service,id);assert.equal(starts,0);assert.equal(resumes,1);
});
