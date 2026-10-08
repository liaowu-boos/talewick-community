import test from 'node:test';
import assert from 'node:assert/strict';
import {relevanceReviewText} from '../src/model/material-results.ts';
const valid={receiptId:'00000000-0000-4000-8000-000000000001',inputHash:'a'.repeat(64),status:'completed',sentCount:3,notReviewedCount:1,usableCount:1,irrelevantCount:1,insufficientContextCount:1};
test('public relevance counts distinguish completed, failed, not reviewed and legacy',()=>{
 assert.match(relevanceReviewText(valid),/1 项可作参考，1 项不相关，1 项上下文不足/);
 assert.match(relevanceReviewText({...valid,status:'failed',usableCount:0,irrelevantCount:0,insufficientContextCount:0}),/未完成/);
 assert.match(relevanceReviewText({...valid,status:'not_reviewed',sentCount:0,usableCount:0,irrelevantCount:0,insufficientContextCount:0}),/本次未送审/);
 assert.match(relevanceReviewText(undefined),/未记录/);
});
test('invalid or incompatible summaries cannot imply a completed review or render raw fields',()=>{
 for(const bad of [null,{}, {...valid,sentCount:4},{...valid,sentCount:30},{...valid,notReviewedCount:-1},{...valid,inputHash:'bad'},{...valid,rawResponse:'PRIVATE_PAYLOAD'},{...valid,status:'other'}]){
  const output=relevanceReviewText(bad);assert.match(output,/不完整或不兼容/);assert.doesNotMatch(output,/PRIVATE_PAYLOAD|已筛选/);
 }
 assert.match(relevanceReviewText(valid,true),/不完整或不兼容/);
});

test('frontend conservative parsing agrees with frozen DATA structure without browser crypto import',async()=>{
 const {validateRelevanceReview}=await import('../../../data/runtime/relevance.mjs');
 const samples=[undefined,valid,null,{...valid,receiptId:valid.receiptId.replace('a','A')},{...valid,inputHash:null},{...valid,status:'unknown'},{...valid,sentCount:0},{...valid,notReviewedCount:20},{...valid,status:'failed'},{...valid,status:'failed',usableCount:0,irrelevantCount:0,insufficientContextCount:0},{...valid,status:'not_reviewed',sentCount:0,usableCount:0,irrelevantCount:0,insufficientContextCount:0}];
 for(const sample of samples){let good=true;try{validateRelevanceReview(sample);}catch{good=false;}
  assert.equal(!relevanceReviewText(sample).includes('不完整或不兼容'),good);
 }
});

test('failed summary never claims transport dispatch or provider delivery',()=>{
 const output=relevanceReviewText({...valid,status:'failed',usableCount:0,irrelevantCount:0,insufficientContextCount:0});
 assert.match(output,/本次准备筛选 3 项，另有 1 项未纳入/);assert.doesNotMatch(output,/已送审|已收到|已发送/);
});
