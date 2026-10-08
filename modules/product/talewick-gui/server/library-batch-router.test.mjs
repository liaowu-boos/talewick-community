import test from 'node:test';
import assert from 'node:assert/strict';
import {createLibraryBatchRouter} from './library-batch-router.mjs';
const sources=()=>Array.from({length:10},(_,i)=>({requestId:'test-'+i,fileName:i+'.txt',contentBase64:Buffer.from('合成文本'+i).toString('base64')}));
const tick=()=>new Promise(r=>setImmediate(r));
function harness(overrides={},canRun=()=>true){
 const calls=[],service={progress:()=>({batches:[{batchId:'b1'}],registered:10}),addBatch:async input=>{calls.push(input);},run:async()=>{calls.push('run');},recover:async()=>{calls.push('recover');},cancelBatch:async id=>{calls.push(['cancel',id]);},...overrides};
 const route=createLibraryBatchRouter({service,json:(res,status,body)=>Object.assign(res,{status,body}),bodyJSON:async req=>req.body,canRun});
 return {calls,async request(method,path='/api/library/batches',body){const res={};res.handled=await route({method,body},res,new URL(path,'http://localhost'));return res;}};
}
test('registration validates all ten files before calling DATA and does not start work',async()=>{
 const h=harness(),valid=sources();
 assert.equal((await h.request('POST','/api/library/batches',{batchId:'b1',sources:valid})).status,201);
 assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].sources[9].bytes,Buffer.from('合成文本9'));
 const broken=sources();broken[9].contentBase64='bad';
 assert.equal((await h.request('POST','/api/library/batches',{batchId:'b2',sources:broken})).status,400);assert.equal(h.calls.length,1);
 for(const body of [{batchId:'b2',sources:valid.slice(1)},{batchId:'../b',sources:valid},{batchId:'b',sources:valid,extra:true}])assert.equal((await h.request('POST','/api/library/batches',body)).status,400);
 assert.equal(h.calls.length,1);
});
test('GET, invalid methods and unknown routes never dispatch',async()=>{
 const h=harness();assert.equal((await h.request('GET')).status,200);assert.equal((await h.request('GET','/api/library/batches/run')).status,405);
 assert.equal((await h.request('POST','/api/library/batches/nope',{})).status,404);assert.equal((await h.request('GET','/api/library/sources')).handled,false);assert.deepEqual(h.calls,[]);
});
test('long run responds 202, deduplicates active requests, observes errors without leaking provider text',async()=>{
 let reject;const work=new Promise((_,r)=>{reject=r;}),h=harness({run:()=>work});
 const started=await h.request('POST','/api/library/batches/run',{});assert.equal(started.status,202);assert.equal(started.body.actions.run.status,'running');
 assert.equal((await h.request('POST','/api/library/batches/run',{})).status,409);
 reject(Object.assign(Error('secret-provider-raw'),{code:'private-code'}));await tick();
 const read=await h.request('GET');assert.equal(read.body.actions.run.status,'failed');assert.equal(read.body.actions.run.error.code,'PROCESSING_FAILED');assert.doesNotMatch(JSON.stringify(read),/secret|private-code|promise/i);
});
test('unconfigured start and invalid control bodies are rejected before dispatch',async()=>{
 const h=harness({},()=>false);
 assert.equal((await h.request('POST','/api/library/batches/run',{})).status,503);
 for(const body of [[],null,{restart:true}])assert.equal((await h.request('POST','/api/library/batches/recover',body)).status,400);
 assert.deepEqual(h.calls,[]);
});
test('recover and known-batch cancel are explicit and observe asynchronous completion',async()=>{
 const h=harness();assert.equal((await h.request('POST','/api/library/batches/missing/cancel',{})).status,404);
 assert.equal((await h.request('POST','/api/library/batches/b1/cancel',{})).status,202);assert.equal((await h.request('POST','/api/library/batches/recover',{})).status,202);await tick();
 assert.deepEqual(h.calls,[['cancel','b1'],'recover']);const result=await h.request('GET');assert.equal(result.body.actions.recover.status,'completed');assert.equal(result.body.actions['cancel:b1'].status,'completed');
});
test('body limits and missing service return explicit safe HTTP errors',async()=>{
 for(const status of [400,413,415]){const res={},route=createLibraryBatchRouter({service:{progress(){}},json:(r,s,b)=>Object.assign(r,{status:s,body:b}),bodyJSON:async()=>{throw Object.assign(Error('raw'),{status});}});await route({method:'POST'},res,new URL('http://localhost/api/library/batches'));assert.equal(res.status,status);assert.doesNotMatch(JSON.stringify(res),/raw/);}
 const res={},route=createLibraryBatchRouter({service:null,json:(r,s,b)=>Object.assign(r,{status:s,body:b}),bodyJSON:async()=>({})});await route({method:'GET'},res,new URL('http://localhost/api/library/batches'));assert.equal(res.status,503);assert.equal(res.body.error.code,'BATCH_UNAVAILABLE');
});
