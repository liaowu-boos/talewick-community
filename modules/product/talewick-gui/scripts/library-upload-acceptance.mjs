// Isolated HTTP acceptance entry. No credentials/config are loaded here.
// Real runs require the coordinator's explicitly injected, ledger-backed model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRuntime} from '../server/index.mjs';
import {createRetrieveKnowledge} from '../server/library.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const allowedStages=new Set(['library-analysis','library-analysis-revision','library-review','library-relevance']);
function offlineModel(){return {complete:async({stage,user,signal})=>{
 signal?.throwIfAborted();
 if(stage==='library-review')return JSON.stringify({approved:true,rubricVersion:'analysis-review-v2',checks:['fact_attribution','inference_strength','evidence_scope','cross_unit_links','text_scope','reader_effect_hypothesis'].map(id=>({id,status:'passed',notes:['合成离线替身，仅验证接线，不证明语义复核。'],unitIds:['U1']})),notes:['合成离线替身，不是真实模型。']});
 if(stage==='library-relevance'){const input=JSON.parse(user);return JSON.stringify({inputHash:input.inputHash,decisions:input.candidates.map(c=>{const id=c.evidenceText.match(/␞([1-9][0-9]*):/)?.[1];return {candidateId:c.candidateId,relevance:id?'usable':'insufficient_context',reason:'合成离线替身，只验证供应与引用接线，不认证适用性。',...(id?{evidenceIds:[id]}:{})};})});}
 assert.equal(stage,'library-analysis','offline rehearsal does not automatically revise failed analysis');
 const line=JSON.parse(user).lines[0];return JSON.stringify({overview:'离线工程替身',coverage:{scope:'unknown',notes:['合成离线替身']},units:[{id:'U1',title:'场景',locator:{lineStart:1,lineEnd:1},event:'场景',psychology:'未知',emotion:'未知',expression:'文字',readerEffectHypothesis:'未验证',evidence:[{quote:line.text,lineStart:1,lineEnd:1}],relatedUnitIds:[]}],limitations:['仅工程接线，不是实际拆解']});
}};}
export async function runUploadAcceptance({directory,inputPath,mode='offline',adapterPath,query,timeoutMs=900000}={}){
 assert(['offline','real'].includes(mode));assert(path.isAbsolute(directory)&&path.isAbsolute(inputPath),'absolute paths required');
 assert(!directory.split(path.sep).includes('.local-runs'),'production run directories are forbidden');
 if(mode==='real')assert(query&&typeof query.query==='string'&&query.query.trim()&&typeof query.context==='string','real mode requires an explicit retrieval question and context');
 assert(Number.isFinite(timeoutMs)&&timeoutMs>=1000&&timeoutMs<=1800000);
 const original=await fs.readFile(inputPath);assert(original.length>0&&original.length<=128000,'upload byte limit');
 const text=original.toString('utf8');assert(Buffer.from(text).equals(original),'input must be valid UTF-8');assert(text.length<=24000,'upload character limit');
 // Exclusive directory ownership prevents ever opening production or previous test stores.
 await fs.mkdir(directory,{recursive:false,mode:0o700});
 const controller=new AbortController();const deadline=setTimeout(()=>controller.abort(new Error('acceptance deadline exceeded')),timeoutMs);let runtime,adapter,modelCalls=0;const requests=[],stages=[];const start=Date.now();
 const report={mode,realModelVerified:false,browserVerified:false,guiButtonVerified:false,input:{path:inputPath,sha256:hash(original),bytes:original.length},directory,requests,stages,passed:false};
 const save=(name,value)=>fs.writeFile(path.join(directory,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
 const oldFetch=globalThis.fetch;
 if(mode==='offline')globalThis.fetch=async()=>{throw Error('offline rehearsal forbids external fetch');};
 async function stop(){if(!runtime)return;const current=runtime;runtime=null;await current.close();if(current.server.listening)await new Promise((resolve,reject)=>{current.server.close(e=>e?reject(e):resolve());current.server.closeAllConnections();});}
 try{
  if(mode==='real'){
   assert(adapterPath&&path.isAbsolute(adapterPath),'real mode requires an explicit coordinator adapter');
   const factory=await import(pathToFileURL(adapterPath));adapter=await factory.createAcceptanceModel({outputDirectory:directory,signal:controller.signal});
   assert.equal(typeof adapter?.model?.complete,'function');assert.equal(adapter.provenance?.mode,'real');assert.equal(typeof adapter.provenance?.ledgerPath,'string');assert(adapter.provenance.ledgerPath.length);
   report.adapter={path:adapterPath,sha256:hash(await fs.readFile(adapterPath)),...adapter.provenance};
  }else adapter={model:offlineModel(),provenance:{mode:'offline-synthetic'}};
  const model={complete:async args=>{
   assert(allowedStages.has(args.stage),'acceptance cannot dispatch creation/other stages');
   const id=++modelCalls;const signal=AbortSignal.any([controller.signal,...(args.signal?[args.signal]:[])]);const entry={id,stage:args.stage,startedAt:new Date().toISOString()};stages.push(entry);
   await save(`stage-${id}-input.json`,{stage:args.stage,system:args.system,user:args.user,maxTokens:args.maxTokens});
   try{const response=await adapter.model.complete({...args,signal});await save(`stage-${id}-output.json`,{response});entry.status='completed';return response;}
   catch(error){entry.status='failed';entry.error={name:error.name,code:error.code};await save(`stage-${id}-failure.json`,entry);throw error;}
  }};
  const config={runsDir:path.join(directory,'runs'),libraryDir:path.join(directory,'library'),port:0,baseURL:'http://127.0.0.1:1',apiKey:'injected-adapter-only',model:mode==='real'?'injected-real-model':'offline-synthetic',engine:'fixed',timeoutMs,idleTimeoutMs:timeoutMs};
  async function launch(){runtime=await createRuntime({config,model});assert(runtime.library);await new Promise((resolve,reject)=>{runtime.server.once('error',reject);runtime.server.listen(0,'127.0.0.1',resolve);});}
  const api=(route,body)=>new Promise((resolve,reject)=>{
   const data=body===undefined?undefined:JSON.stringify(body);const request=http.request({hostname:'127.0.0.1',port:runtime.server.address().port,path:route,method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(data?{'Content-Length':Buffer.byteLength(data)}:{})}},response=>{
    const chunks=[];response.on('data',x=>chunks.push(x));response.on('error',reject);response.on('end',()=>{try{const bytes=Buffer.concat(chunks);requests.push({method:request.method,route,status:response.statusCode,sha256:hash(bytes)});resolve({status:response.statusCode,body:JSON.parse(bytes)});}catch(e){reject(e);}});
   });request.on('error',reject);request.setTimeout(30000,()=>request.destroy(new Error('local HTTP timeout')));request.end(data);
  });
  await launch();const upload=await api('/api/library/sources',{requestId:'isolated-upload-1',fileName:path.basename(inputPath).replace(/\.[^.]+$/,'.txt'),contentBase64:original.toString('base64'),completeness:'unknown'});assert.equal(upload.status,202);const sourceId=upload.body.source.sourceId;report.sourceId=sourceId;
  let source;const observations=[];
  while(Date.now()-start<timeoutMs){controller.signal.throwIfAborted();const result=await api(`/api/library/sources/${sourceId}?analysis=1`);assert.equal(result.status,200);source=result.body.source;
   const state={status:source.status,indexStatus:source.indexStatus,reviewStatus:source.analysis?.reviewStatus,progress:source.progress};if(JSON.stringify(observations.at(-1))!==JSON.stringify(state))observations.push(state);
   if(['completed','partial','failed','needs_review','cancelled','interrupted'].includes(source.status))break;await new Promise(resolve=>setTimeout(resolve,mode==='offline'?20:1000));
  }
  await save('source-detail.json',source);await save('progress.json',observations);
  assert.equal(source?.status,'completed','upload/analysis/review did not complete');assert.equal(source.indexStatus,'ready');assert.equal(source.analysis.reviewStatus,'checked');assert(source.analysis.validation.semanticReview.recordId);
  const version=await api(`/api/library/sources/${sourceId}/analysis?version=${encodeURIComponent(source.analysis.version)}`);assert.equal(version.status,200);assert.deepEqual(version.body.source.analysis,source.analysis);
  const stored=await api(`/api/library/sources/${sourceId}/text?version=${encodeURIComponent(source.textVersion)}`);assert.equal(stored.status,200);assert.equal(stored.body.source.text,text);
  const querySpec={contractVersion:'v04-contract-1',query:text.split(/\r?\n/).find(x=>x.trim()).slice(0,40),stage:'planning',context:'隔离上传检索验收',budget:{maxCandidates:6,maxUnits:3,maxChars:6000},...query,sourceIds:[sourceId]};
  const packet=await createRetrieveKnowledge(runtime.library)(querySpec,{signal:controller.signal});await save('retrieval.json',packet);
  assert.equal(packet.status,'matched');assert(packet.materials.length>0);assert(packet.materials.every(m=>m.references.every(r=>r.sourceId===sourceId&&r.textVersion===source.textVersion)));
  report.retrievalTransport='existing in-process product adapter; no production HTTP retrieval endpoint';
  const beforeRestart=modelCalls;await stop();await launch();const reopened=await api(`/api/library/sources/${sourceId}?analysis=1`);assert.equal(reopened.status,200);assert.equal(reopened.body.source.analysis.version,source.analysis.version);assert.equal(reopened.body.source.textVersion,source.textVersion);assert.equal(modelCalls,beforeRestart,'restart must not rerun models');
  report.versions={textVersion:source.textVersion,analysisVersion:source.analysis.version,reviewRecordId:source.analysis.validation.semanticReview.recordId};report.passed=true;report.realModelVerified=mode==='real';
 }catch(error){report.failure={name:error.name,code:error.code,message:error.message};throw error;}
 finally{
  clearTimeout(deadline);controller.abort(new Error('acceptance run finished'));try{await stop();report.closed=true;}finally{try{await adapter?.close?.();}finally{globalThis.fetch=oldFetch;report.modelStageCalls=modelCalls;report.elapsedMs=Date.now()-start;await save('acceptance-report.json',report);}}
 }
 return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options={};for(let i=2;i<process.argv.length;i+=2){const names={'--directory':'directory','--input':'inputPath','--mode':'mode','--adapter':'adapterPath','--query-file':'queryFile'};assert(names[process.argv[i]]&&process.argv[i+1],'unknown or missing argument');options[names[process.argv[i]]]=process.argv[i+1];}
 if(options.queryFile){assert(path.isAbsolute(options.queryFile));options.query=JSON.parse(await fs.readFile(options.queryFile,'utf8'));delete options.queryFile;}
 runUploadAcceptance(options).then(r=>console.log(JSON.stringify({passed:r.passed,mode:r.mode,realModelVerified:r.realModelVerified,browserVerified:r.browserVerified,modelStageCalls:r.modelStageCalls,directory:r.directory}))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
