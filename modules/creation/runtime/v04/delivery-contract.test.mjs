import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { retrievalQuery, validateRetrieval, knowledgeForAuthor, prepareWorkflowKnowledge } from './knowledge.mjs';
import { freezeRetrieval, sealKnowledge, inspectFrozenKnowledge } from './check-retrieval.mjs';
import { runWorkflow } from '../workflow.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
const request = { kind: 'create', idea: '合成工程：修钟，不生成正文', context: {}, materials: [] };
const requirements = { summary: request.idea, targetHanMin: 9000, targetHanMax: 11000, targetChapterCount: 8, completeEnding: true, usesChapter4Cut: false };
const ref = (line, unitIds = []) => ({ sourceId: 'same-book', textVersion: 'text-1', sourceSha256: hash('合成原文'), analysisVersion: 'analysis-1', lineStart: line, lineEnd: line, unitIds });
const make = (q = retrievalQuery(request, requirements, 30000)) => ({ contractVersion: 'v04-contract-1', packetId: 'SYNTHETIC_MULTIPART', query: q,
  status: 'matched', materials: [1, 2, 3].map((i) => ({ id: `m${i}`, title: '同一合成作品', kind: 'retrieved', use: 'raw_reference',
    content: `合成片段${i}。`, sha256: hash(`合成片段${i}。`), references: i === 2 ? [ref(10), ref(20)] : [ref(i === 1 ? 1 : 30)],
    selectionReason: '仅验证多段供给', limitations: ['未复核，非文学效果样本'] })),
  candidates: [], usedChars: [1,2,3].reduce((n,i)=>n+`合成片段${i}。`.length,0), limits: ['工程替身'] });

test('new creation requests narrative; optional evidenceType validates without rewriting legacy queries', () => {
  assert.equal(retrievalQuery(request, requirements, 30000).evidenceType, 'narrative');
  for (const type of [undefined, 'narrative', 'performance']) {
    const q = retrievalQuery(request, requirements, 30000); if (type === undefined) delete q.evidenceType; else q.evidenceType = type;
    const result = { ...make(q), status:'uncovered', materials:[], usedChars:0 };
    assert.deepEqual(validateRetrieval(result,q),result);
    if(type===undefined)assert.equal(Object.hasOwn(result.query,'evidenceType'),false);
  }
  for (const type of [null, '', 'all', 1, {}, ['narrative']]) {
    const q={...retrievalQuery(request,requirements,30000),evidenceType:type};
    assert.throws(()=>validateRetrieval(make(q),q),/evidenceType/);
  }
  const q=retrievalQuery(request,requirements,30000), changed=make({...q,evidenceType:'performance'});
  assert.throws(()=>validateRetrieval(changed,q),/查询/);
  const legacy=make({...q});delete legacy.query.evidenceType;
  assert.throws(()=>validateRetrieval(legacy,q),/查询/);
});

test('same-book materials and non-contiguous independent refs survive real data merge, disk freeze, and isolated author view', async t => {
  const dir=await mkdtemp(join(tmpdir(),'creation-freeze-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const result=make(), before=structuredClone(result);
  const envelope=await freezeRetrieval({request,requirements,result});
  assert.equal(envelope.knowledge.retrieval.mergeAdapter,'data');
  assert.equal(envelope.knowledge.materials.length,3);
  assert.deepEqual(envelope.knowledge.materials.map(x=>x.references),result.materials.map(x=>x.references));
  await writeFile(join(dir,'knowledge.json'),JSON.stringify(envelope));
  const read=JSON.parse(await readFile(join(dir,'knowledge.json'))), view=inspectFrozenKnowledge(read).authorView;
  assert.deepEqual(view.materials.map(x=>x.references),before.materials.map(x=>x.references));
  assert.deepEqual(view.materials[1].references.map(x=>[x.lineStart,x.lineEnd]),[[10,10],[20,20]]);
  view.materials[1].references[0].unitIds.push('cannot-leak');view.materials[0].limitations.push('cannot-leak');view.limits.push('cannot-leak');
  assert.deepEqual(result,before);assert.deepEqual(read,envelope);
  const direct=knowledgeForAuthor(envelope.knowledge);direct.materials[0].references[0].lineEnd=999;
  assert.equal(envelope.knowledge.materials[0].references[0].lineEnd,1);
});

test('raw range budget cannot be bypassed with shared analysis IDs; exact duplicate ranges are rejected, not collapsed', () => {
  const result=make();result.materials[0].references=Array.from({length:7},(_,i)=>ref(100+i,['shared-unit']));
  assert.throws(()=>validateRetrieval(result,result.query),/预算/);
  const duplicate=make();duplicate.materials[2].references=[structuredClone(duplicate.materials[0].references[0])];
  assert.throws(()=>validateRetrieval(duplicate,duplicate.query),/重复/);
  const good=make();assert.equal(validateRetrieval(good,good.query).materials.length,3);
});

test('shared character budget is applied before supply and complete content is never clipped', async () => {
  const input={...request,materials:[{id:'selected',content:'字'.repeat(29980)}]}, q=retrievalQuery(input,requirements,20), result=make(q);
  assert.ok(result.usedChars<=20);
  const frozen=await freezeRetrieval({request:input,requirements,result});
  assert.equal(frozen.knowledge.materials.reduce((n,x)=>n+x.content.length,0),29980+result.usedChars);
  const over=make(q);over.materials[0].content='字'.repeat(21);over.materials[0].sha256=hash(over.materials[0].content);over.usedChars=over.materials.reduce((n,x)=>n+x.content.length,0);
  await assert.rejects(freezeRetrieval({request:input,requirements,result:over}),/预算/);
});

test('raw stays raw after freeze and reviewed claims require every reference to have a record', async () => {
  const result=make(), frozen=await freezeRetrieval({request,requirements,result});
  assert.ok(frozen.knowledge.materials.every(x=>x.use==='raw_reference'));
  assert.ok(inspectFrozenKnowledge(frozen).authorView.materials.every(x=>x.applicability.includes('仅原文')));
  result.materials[1].use='reviewed_analysis';for(const r of result.materials[1].references)r.unitIds=['unit'];
  result.materials[1].references[0].reviewRecordId='SYNTHETIC_NOT_REVIEWED';
  await assert.rejects(freezeRetrieval({request,requirements,result}),/逐来源复核/);
});

test('legacy frozen knowledge resumes without adding evidenceType, requerying or producing prose', async () => {
  const legacyResult=make();delete legacyResult.query.evidenceType;
  const legacy={materials:legacyResult.materials,style:null,limits:['历史'],retrieval:legacyResult};
  const envelope=sealKnowledge(legacy);assert.equal(inspectFrozenKnowledge(envelope).evidenceType,null);
  const artifacts={};const stop=new Error('stop before planning output');
  await assert.rejects(runWorkflow({request,model:{complete:async({stage})=>{assert.equal(stage,'requirements');return JSON.stringify(requirements);}},
    checkpoint:async(key,value)=>{artifacts[key]=value;throw stop;}}),/stop before/);
  artifacts.knowledge=structuredClone(legacy);
  await assert.rejects(runWorkflow({request,artifacts,retrieveKnowledge:async()=>assert.fail('no legacy requery'),model:{complete:async({stage})=>{assert.equal(stage,'planning');throw stop;}}}),/stop before/);
  assert.deepEqual(artifacts.knowledge,legacy);assert.equal(Object.hasOwn(artifacts.knowledge.retrieval.query,'evidenceType'),false);
  assert.equal(Object.keys(artifacts).some(x=>x.startsWith('draft:')),false);
  envelope.knowledge.materials[0].references[0].lineEnd++;
  assert.throws(()=>inspectFrozenKnowledge(envelope),/哈希/);
});


test('a merger cannot relabel raw input as reviewed or drop one of its independent references', async () => {
  for (const mutate of [
    item => { item.use='reviewed_analysis'; item.references=item.references.map(r=>({...r,unitIds:['fake'],reviewRecordId:'fake'})); },
    item => { item.references=item.references.slice(0,1); },
  ]) {
    const result=make();
    const prepare=async (_,options)=>({materials:options ? options.retrievalResult.materials.map(item=>{ const value=structuredClone(item);if(value.id==='m2')mutate(value);return value; }) : [],style:null,limits:[]});
    await assert.rejects(prepareWorkflowKnowledge({request,requirements,prepareKnowledge:prepare,retrieveKnowledge:async()=>result}),/合并丢失或改变/);
  }
});


test('standalone CLI works through a symlink, inspects frozen data and refuses existing output directories', async t => {
  const dir=await mkdtemp(join(tmpdir(),'creation-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const executable=fileURLToPath(new URL('./check-retrieval.mjs',import.meta.url));
  const link=join(dir,'linked-check.mjs');await symlink(executable,link);
  const input=join(dir,'case.json');await writeFile(input,JSON.stringify({request,requirements,result:make()}));
  const exec=promisify(execFile), destination=join(dir,'frozen');
  const run=await exec(process.execPath,[link,'freeze',input,destination]);assert.match(run.stdout,/integrity_checked/);
  const saved=await readFile(join(destination,'frozen.json'),'utf8');
  const inspected=await exec(process.execPath,[link,'inspect',join(destination,'frozen.json'),join(dir,'inspected')]);assert.match(inspected.stdout,/narrative/);
  await assert.rejects(exec(process.execPath,[link,'freeze',input,destination]),/EEXIST/);
  assert.equal(await readFile(join(destination,'frozen.json'),'utf8'),saved);
});


test('performance rejects raw and reviewed narrative matches but retains empty uncovered/unavailable', () => {
  const q={...retrievalQuery(request,requirements,30000),evidenceType:'performance'};
  for(const use of ['raw_reference','reviewed_analysis']) {
    const result=make(q);
    for(const material of result.materials){material.use=use;for(const ref of material.references){ref.unitIds=['unit'];ref.reviewRecordId='SYNTHETIC_RECORD';}}
    assert.throws(()=>validateRetrieval(result,q),/performance 查询不能接收叙事材料/);
  }
  for(const status of ['uncovered','unavailable']) {
    const result={...make(q),status,materials:[],usedChars:0};
    assert.deepEqual(validateRetrieval(result,q),result);
    result.candidates=[{id:'narrative',sourceId:'same-book',reason:'叙事候选不能代替表现观察'}];
    assert.throws(()=>validateRetrieval(result,q),/performance/);
    result.candidates=[];result.limits=[];
    assert.throws(()=>validateRetrieval(result,q),/说明缺口/);
  }
});

test('raw duplicate identity uses source bytes/version/range across aliases and still preserves distinct ranges or bytes', () => {
  const q=retrievalQuery(request,requirements,30000),result=make(q);
  result.materials[2].references=[{...result.materials[0].references[0],sourceId:'same-bytes-alias'}];
  assert.throws(()=>validateRetrieval(result,q),/原文区间重复/);
  result.materials[2].references[0].lineStart=40;result.materials[2].references[0].lineEnd=40;
  assert.equal(validateRetrieval(result,q).materials.length,3);
  result.materials[2].references=[{...result.materials[0].references[0],sourceId:'different-book',sourceSha256:hash('不同原文')}];
  assert.equal(validateRetrieval(result,q).materials.length,3);
});
