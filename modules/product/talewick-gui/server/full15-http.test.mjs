import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createRuntime } from './index.mjs';

const chapters=[{id:'c1',title:'第一章',body:'她把钥匙放回桌上。'}];
const creationResult={title:'钥匙',chapters,review:{summary:'合成测试审阅。'},warnings:[],checks:{},knowledge:{}};
const request={projectId:'project-auto',requestId:'request-auto',kind:'create',idea:'合成测试',context:{},materials:[],style:null,chapters:[],instruction:'',quote:'',baseRevision:'empty'};
async function api(server,route,body){return new Promise(resolve=>{const text=body===undefined?'':JSON.stringify(body);const req=Readable.from(text?[Buffer.from(text)]:[]);Object.assign(req,{method:body===undefined?'GET':'POST',url:route,headers:{host:'127.0.0.1',...(body===undefined?{}:{'content-type':'application/json'})}});const res={writeHead(status){this.status=status;},end(value){resolve({status:this.status,body:JSON.parse(String(value))});}};server.emit('request',req,res);});}
async function waitFor(read,predicate){for(let i=0;i<400;i++){const value=await read();if(predicate(value))return value;await new Promise(r=>setTimeout(r,5));}throw new Error('timeout');}

test('automatic auxiliary failure stays separate from completed creation and manual route binds saved version',async t=>{
 const runsDir=await mkdtemp(path.join(os.tmpdir(),'talewick-full15-http-'));
 const adapter={getFull15Versions:()=>({rulesVersion:'synthetic-rules',toolVersion:'synthetic-tool'}),startFull15Review:async()=>{throw Object.assign(Error('synthetic invalid output'),{code:'model_output_invalid'});}};
 const runtime=await createRuntime({config:{runsDir,apiKey:'synthetic-test-key',baseURL:'http://127.0.0.1:1',model:'synthetic',port:0},model:{complete:async()=>{throw Error('no model expected');}},workflow:async()=>structuredClone(creationResult),library:null,publicationFeedback:{list:async()=>[],close:async()=>{}},full15Adapter:adapter,full15Analyze:async()=>{throw Error('synthetic adapter does not call analyze');},full15InputForManuscript:async()=>({requirements:{c05_applicable:false},references:{sources:[]},profile:'no_corpus'})});
 t.after(async()=>{await runtime.close();await rm(runsDir,{recursive:true,force:true});});
 const submitted=(await api(runtime.server,'/api/tasks',request)).body.task;
 const creation=await waitFor(async()=>(await api(runtime.server,`/api/tasks/${submitted.id}`)).body.task,t=>t.status==='completed');
 assert.equal(creation.status,'completed');
 const auxiliary=await waitFor(async()=>(await api(runtime.server,'/api/full15?projectId=project-auto')).body.tasks[0],t=>t?.status==='needs_attention');
 assert.equal(auxiliary.error.code,'model_output_invalid'); assert.equal((await api(runtime.server,`/api/tasks/${submitted.id}`)).body.task.status,'completed');
 const manual=await api(runtime.server,'/api/full15',{projectId:'old-project',requestId:'manual-old-1',title:'旧稿',chapters,manuscriptRevision:(await import('./full15-service.mjs')).productManuscriptRevision('旧稿',chapters),runRoot:'/browser/not-allowed'});
 assert.equal(manual.status,202); assert.equal(manual.body.task.trigger,'manual'); assert.equal(Object.hasOwn(manual.body.task,'frozen'),false);
});
