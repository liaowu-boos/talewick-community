import test from 'node:test';import assert from 'node:assert/strict';
import {initialRetrievalText,relevanceReviewText,slotOutcome} from '../src/model/material-results.ts';import {readRuntimeTask} from '../src/model/runtime.ts';
const task=status=>({id:'t',projectId:'p',requestId:'r',baseRevision:'b',kind:'create',status:'completed',result:{title:'合成',chapters:[{id:'ch-1',title:'章',body:'保留正文'}],review:{summary:'合成审阅'},checks:{},warnings:[],knowledge:{materials:[],retrieval:{status,materials:[],usedChars:0}}}});
test('bridge keeps uncovered and unavailable distinct, with zero materials',()=>{for(const status of ['uncovered','unavailable']){const r=readRuntimeTask(task(status)).result;assert.equal(r.knowledge.retrieval.status,status);assert.deepEqual(r.knowledge.materials,[]);assert.equal(r.chapters[0].body,'保留正文');}});
test('failure cannot be described as absence even if candidate review completed',()=>{const value={status:'unavailable',relevanceReview:{status:'completed',usableCount:7},error:{message:'PRIVATE_ERROR'}};const t=initialRetrievalText(value);assert.match(t,/未取得可用结果.*无法判断/);assert.doesNotMatch(t,/未找到|PRIVATE|已取得参考/);assert.match(initialRetrievalText({status:'uncovered'}),/检索完成.*未找到覆盖本次问题/);});
test('malformed and legacy statuses never claim successful retrieval',()=>{for(const v of [undefined,null,{},[],{status:['uncovered']},{status:'future'}])assert.doesNotMatch(initialRetrievalText(v),/检索完成|已取得参考|未找到/);});
test('follow-up failure and lack of coverage remain separate',()=>{assert.match(slotOutcome({status:'unavailable'}),/未取得可用结果/);assert.match(slotOutcome({status:'uncovered'}),/未找到覆盖问题/);});

test('matched does not overwrite later adoption verification',()=>{assert.equal(initialRetrievalText({status:'matched'}),'初始检索已取得参考材料；是否采用及效果需结合后续记录判断。');});
