import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {runUploadAcceptance} from './library-upload-acceptance.mjs';
test('real acceptance refuses missing explicit retrieval purpose before creating a store or loading an adapter',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'upload-entry-test-'));try{const input=path.join(root,'sample.txt');await fs.writeFile(input,'合成输入');const directory=path.join(root,'store');await assert.rejects(runUploadAcceptance({directory,inputPath:input,mode:'real',adapterPath:'/nonexistent-adapter.mjs'}),/explicit retrieval question/);await assert.rejects(fs.stat(directory),{code:'ENOENT'});}finally{await fs.rm(root,{recursive:true,force:true});}
});
test('acceptance refuses existing stores and production runs paths without changing them',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'upload-entry-test-'));try{const input=path.join(root,'sample.txt');await fs.writeFile(input,'合成输入');const sentinel=path.join(root,'sentinel');await fs.writeFile(sentinel,'unchanged');await assert.rejects(runUploadAcceptance({directory:root,inputPath:input}),{code:'EEXIST'});assert.equal(await fs.readFile(sentinel,'utf8'),'unchanged');await assert.rejects(runUploadAcceptance({directory:path.join(root,'.local-runs','new'),inputPath:input}),/production run/);}finally{await fs.rm(root,{recursive:true,force:true});}
});

test('actual library review rejection persists partial and fails promptly without retry or retrieval', {timeout:10000}, async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'upload-review-rejection-'));
 const stringify=JSON.stringify;
 // Change only the existing offline model's review response, not DATA or HTTP state.
 const stub=t.mock.method(JSON,'stringify',function(value,...rest){
  if(value?.rubricVersion==='analysis-review-v2' && value.approved===true && value.notes?.[0]==='合成离线替身，不是真实模型。'){
   value={...value,approved:false,checks:value.checks.map((check,index)=>index===0?{...check,status:'needs_revision',notes:['合成拒绝复核响应：事实归属不成立。']}:check),notes:['合成拒绝复核，不是真实模型判断。']};
  }
  return stringify.call(this,value,...rest);
 });
 try{
  const input=path.join(root,'sample.txt'),directory=path.join(root,'store');await fs.writeFile(input,'她攥紧围巾，仍有留恋。');const started=Date.now();
  await assert.rejects(runUploadAcceptance({directory,inputPath:input,mode:'offline',timeoutMs:6000}),/upload\/analysis\/review did not complete/);
  assert(Date.now()-started<3000,'terminal partial must fail promptly rather than wait for the acceptance deadline');
  const source=JSON.parse(await fs.readFile(path.join(directory,'source-detail.json'),'utf8'));
  const report=JSON.parse(await fs.readFile(path.join(directory,'acceptance-report.json'),'utf8'));
  assert.equal(source.status,'partial');assert.equal(source.indexStatus,'ready');assert.equal(source.analysis.reviewStatus,'needs_review');
  assert.equal(source.analysis.validation.semanticReview.approved,false);
  assert.equal(report.passed,false);assert.equal(report.realModelVerified,false);assert.equal(report.closed,true);
  assert.deepEqual(report.stages.map(s=>s.stage),['library-analysis','library-review']);
  assert.equal(report.requests.filter(r=>r.method==='POST').length,1);
  assert.equal(report.requests.some(r=>/retry|revisions|cancel/.test(r.route)),false);
  await assert.rejects(fs.stat(path.join(directory,'retrieval.json')),{code:'ENOENT'});
 }finally{stub.mock.restore();await fs.rm(root,{recursive:true,force:true});}
});
