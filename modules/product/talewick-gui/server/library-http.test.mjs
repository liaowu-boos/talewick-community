import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from './index.mjs';

test('real runtime injects library, enforces wire bounds, lazy details and closes service', async()=>{
 const runsDir=await mkdtemp(join(tmpdir(),'talewick-product-library-http-'));
 const calls=[];let closed=0;
 const source={contractVersion:'v04-contract-1',sourceId:'test-source',title:'明确测试',fileName:'x.txt',sourceSha256:'a'.repeat(64),textVersion:'v1',completeness:'unknown',status:'partial',indexStatus:'failed',progress:{completed:1,total:null,label:'已保存'},createdAt:'2026-09-08',updatedAt:'2026-09-08',analysis:{overview:'only fetched on demand',validation:{semanticReview:{recordId:'test-review'}}}};
 const library={
  importSource:async input=>{calls.push(input);return source;},list:async()=>({items:[source],nextCursor:null}),
  get:async(id,options)=>{calls.push({id,options});return source;},readSource:async()=>({...source,text:'exact text',encoding:'utf8'}),
  retry:async(id,options)=>{calls.push({id,options});return source;},cancel:async()=>source,
  retrieve:async()=>{throw Error('not called by test');},close:async()=>{closed++;},
 };
 const runtime=await createRuntime({full15Adapter:null,config:{runsDir,port:4398,baseURL:'https://example.invalid',apiKey:'',model:'test',engine:'fixed',timeoutMs:1000},library,
  narrativeObservation:{projector:undefined,status:{available:false,reason:'fixture_unavailable',contractVersion:'narrative-observation-runtime-1'}},
  model:{complete(){throw Error('No model call authorized in test');}}});
 await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
 const api=async(route,body,headers={})=>{const res=await fetch(`http://127.0.0.1:${runtime.server.address().port}${route}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 try {
  const runtimeStatus=(await api('/api/runtime')).body.library;
  assert.equal(runtimeStatus.available,true);
  assert.deepEqual(runtimeStatus.narrativeObservations,{available:false,reason:'fixture_unavailable',contractVersion:'narrative-observation-runtime-1'});
  const input={requestId:'id-1',fileName:'x.txt',contentBase64:Buffer.from('原字节').toString('base64')};
  assert.equal((await api('/api/library/sources',input)).status,202);assert.deepEqual(calls[0].bytes,Buffer.from('原字节'));assert.equal(calls[0].completeness,'unknown');
  assert.equal((await api('/api/library/sources')).body.items[0].analysis,undefined);
  const detail=(await api('/api/library/sources/test-source?analysis=1')).body.source;
  assert.equal(detail.indexStatus,'failed');assert.equal(detail.analysis.validation.semanticReview.recordId,'test-review');
  assert.deepEqual(calls.at(-1),{id:'test-source',options:{includeAnalysis:true}});
  assert.equal((await api('/api/library/sources/test-source/text?version=v1')).body.source.text,'exact text');
  assert.equal((await api('/api/library/sources/test-source/retry',{stage:'index'})).status,200);
  assert.equal((await api('/api/library/sources/test-source/cancel',{})).status,200);
  assert.equal((await api('/api/library/sources',{...input,contentBase64:'invalid'})).status,400);
  assert.equal((await api('/api/library/sources',{...input,contentBase64:'A'.repeat(2*1024*1024)})).status,413);
  assert.equal((await api('/api/library/sources',input,{Origin:'https://untrusted.invalid'})).status,403);
 } finally {await runtime.close();await new Promise(resolve=>runtime.server.close(resolve));await rm(runsDir,{recursive:true,force:true});}
 assert.equal(closed,1);
});
