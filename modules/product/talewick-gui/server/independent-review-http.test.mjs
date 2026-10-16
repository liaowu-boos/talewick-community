import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createRuntime } from './index.mjs';
import { independentReviewRequestHash } from './independent-review-service.mjs';
import { productManuscriptRevision } from './full15-service.mjs';

const chapters = [{ id: 'c1', title: '第一章', body: '她把钥匙放回桌上。' }], title = '钥匙';
async function api(server, route, body) { return new Promise(resolve => { const raw=body===undefined?'':JSON.stringify(body), req=Readable.from(raw?[Buffer.from(raw)]:[]); Object.assign(req,{method:body===undefined?'GET':'POST',url:route,headers:{host:'127.0.0.1',...(body===undefined?{}:{'content-type':'application/json'})}}); const res={writeHead(status){this.status=status;},end(value){resolve({status:this.status,body:JSON.parse(String(value))});}}; server.emit('request',req,res); }); }
async function waitFor(server,id){for(let i=0;i<300;i++){const value=await api(server,`/api/independent-reviews/${id}`);if(!['queued','running'].includes(value.body.task.status))return value.body.task;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('timeout');}

test('runtime exposes single review and server-resolved candidate comparison over HTTP', async t => {
  const runsDir=await mkdtemp(path.join(os.tmpdir(),'talewick-independent-http-'));
  const adapter={getIndependentReviewVersions:async()=>({protocolVersion:'p1',rulesVersion:'r1',toolVersion:'t1'}),startIndependentReview:async args=>({schemaVersion:'independent-review-task-1',status:'complete',runDir:path.join(args.runRoot,`run-${args.request.caseId}`),requestHash:independentReviewRequestHash(args.request),versions:{protocolVersion:'p1',rulesVersion:'r1',toolVersion:'t1'},progress:{phase:'complete',completedStages:args.request.mode==='single'?2:7,totalStages:args.request.mode==='single'?2:7},report:{mode:args.request.mode,automaticAdoption:false,literaryPass:'NOT_COMPUTED'},error:null}),resumeIndependentReview:async()=>assert.fail('not expected')};
  const handoff={buildIndependentReviewRequest:({caseId,request})=>({request:{caseId,mode:'compare',baselineChapters:request.chapters,candidate:{mode:'revised',chapters:[{...request.chapters[0],body:'她把钥匙交回失主。'}]},goals:[{id:'g1',statement:'归还钥匙',claimType:'editorial_hypothesis',sourceEvidence:[{chapterId:'c1',quote:'钥匙',start:2}],counterCase:[{chapterId:'c1',quote:'桌上',start:7}],expectedEffect:'行动更清楚',failureCriterion:'仍未归还',requiredOutcomes:[{id:'o1',dimension:'action',description:'归还'}]}]},provenance:{role:'full_candidate'}})};
  const runtime=await createRuntime({config:{runsDir,apiKey:'synthetic',baseURL:'http://127.0.0.1:1',model:'synthetic',port:0},model:{complete:async()=>assert.fail('adapter fixture must not call model')},workflow:async()=>assert.fail('creation workflow not expected'),library:null,publicationFeedback:{list:async()=>[],close:async()=>{}},full15Adapter:null,independentReviewAdapter:adapter,independentReviewAnalyze:async()=>assert.fail('adapter fixture owns analysis'),independentReviewHandoff:handoff});
  t.after(async()=>{await runtime.close();await rm(runsDir,{recursive:true,force:true});});
  const revision=productManuscriptRevision(title,chapters),single=await api(runtime.server,'/api/independent-reviews',{projectId:'project-1',requestId:'single-1',caseId:'case-single',title,chapters,manuscriptRevision:revision,mode:'single'});
  assert.equal(single.status,202);assert.equal((await waitFor(runtime.server,single.body.task.id)).report.literaryPass,'NOT_COMPUTED');
  const sourceId=crypto.randomUUID();runtime.tasks.tasks.set(sourceId,{id:sourceId,projectId:'project-1',requestId:'whole-request',kind:'revise',revisionMode:'whole-manuscript-v2',status:'completed',stage:'complete',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),baseRevision:revision,engine:'fixed',engineVersion:'fixed-workflow-1',result:{title,chapters,wholeRevision:{schemaVersion:'whole-manuscript-quality-1',status:'candidate_ready'}}});
  runtime.tasks.requests.set(sourceId,{projectId:'project-1',requestId:'whole-request',kind:'revise',idea:'修订',context:{},materials:[],style:null,projectTitle:title,chapters,instruction:'归还钥匙',quote:'',baseRevision:revision,revisionMode:'whole-manuscript-v2'});runtime.tasks.artifacts.set(sourceId,{});
  const compared=await api(runtime.server,'/api/independent-reviews',{projectId:'project-1',requestId:'compare-1',caseId:'case-compare',title,chapters,manuscriptRevision:revision,mode:'compare',sourceTaskId:sourceId,candidate:{forged:true}});
  assert.equal(compared.status,202);assert.equal((await waitFor(runtime.server,compared.body.task.id)).report.mode,'compare');
  const state=await api(runtime.server,'/api/runtime');assert.equal(state.body.independentReviews.available,true);
});
