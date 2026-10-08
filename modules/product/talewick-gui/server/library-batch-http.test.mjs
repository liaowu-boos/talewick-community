import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from './index.mjs';
import http from 'node:http';
import {ANALYSIS_REVIEW_CHECKS,ANALYSIS_REVIEW_RUBRIC} from '../../../data/runtime/analysis-review.mjs';
test('real HTTP registers without dispatch, starts ten actual DATA jobs, survives restart, and preserves ordinary uploads',async()=>{
 const runsDir=await mkdtemp(join(tmpdir(),'talewick-batch-http-')),calls=[];
 const config={runsDir,port:4398,baseURL:'https://example.invalid',apiKey:'synthetic-test-key',model:'synthetic',engine:'fixed',timeoutMs:1000};
 const model={async complete(request){calls.push(request.stage);return JSON.stringify(request.stage==='library-review'?{approved:true,notes:['合成接口测试'],rubricVersion:ANALYSIS_REVIEW_RUBRIC,checks:ANALYSIS_REVIEW_CHECKS.map(id=>({id,status:'passed',notes:['合成依据'],unitIds:['u1']}))}:{evidenceMode:'source-lines-v1',overview:'合成样例',coverage:{scope:'unknown',notes:['测试片段']},units:[{id:'u1',title:'收起围巾',event:'她收起围巾，没有回头',psychology:'未知',emotion:'未知',expression:'动作',readerEffectHypothesis:'可能注意离开',locator:{lineStart:1,lineEnd:2},evidence:[{lineStart:1,lineEnd:2}],relatedUnitIds:[]}],limitations:['仅测试接口']});}};
 let runtime;
 const start=async()=>{runtime=await createRuntime({config,model});await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));};
 const stop=async()=>{if(runtime){const old=runtime;runtime=null;await old.close();await new Promise(resolve=>old.server.close(resolve));}};
 const api=async(path,body,headers={})=>{const res=await fetch(`http://127.0.0.1:${runtime.server.address().port}${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return{status:res.status,body:await res.json()};};
 const upload=i=>({requestId:'http-'+i,fileName:i+'.txt',contentBase64:Buffer.from(`她收起围巾。编号${i}。\n她没有回头。`).toString('base64')});
 try{
  await start();assert.equal((await api('/api/runtime')).body.library.batchesAvailable,true);assert.equal(calls.length,0);
  const body={batchId:'ten',sources:Array.from({length:10},(_,i)=>upload(i))};
  assert.equal((await api('/api/library/batches',body,{Origin:'https://untrusted.invalid'})).status,403);
  const badHost=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:runtime.server.address().port,path:'/api/library/batches',method:'POST',headers:{Host:'untrusted.invalid','Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify(body));});assert.equal(badHost,403);
  assert.equal((await api('/api/library/batches',{...body,extra:'x'.repeat(2*1024*1024)})).status,413);assert.equal(calls.length,0);
  assert.equal((await api('/api/library/batches',body)).status,201);assert.equal(calls.length,0);
  assert.ok((await api('/api/library/sources')).body.items.every(s=>s.status==='deferred'));
  await stop();await start();assert.equal((await api('/api/library/batches')).body.queue.registered,10);assert.equal(calls.length,0,'restart never starts deferred work');
  assert.equal((await api('/api/library/batches/run',{})).status,202);
  let progress;for(let i=0;i<500;i++){progress=(await api('/api/library/batches')).body;if(progress.actions.run?.status==='completed')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(progress.actions.run.status,'completed');assert.equal(progress.queue.checked,10);assert.equal(calls.length,20);
  assert.equal((await api('/api/library/sources',upload(99))).status,202);const source=(await api('/api/library/sources')).body.items.find(s=>s.fileName==='99.txt');assert.ok(source);
  await runtime.library.waitSource(source.sourceId);assert.equal((await runtime.library.get(source.sourceId,{includeAnalysis:true})).analysis.reviewStatus,'checked');
  assert.equal((await api('/api/library/batches/recover',{})).status,202);assert.equal(calls.length,22);
  await stop();await start();assert.equal((await api('/api/library/batches')).body.queue.checked,10);assert.equal(calls.length,22);
  const catalog=JSON.parse(await readFile(join(runsDir,'library/catalog.json')));assert.equal(catalog.sources.length,11);assert.ok(catalog.sources.every(s=>s.analysis.reviewStatus==='checked'));
 }finally{await stop();await rm(runsDir,{recursive:true,force:true});}
});
