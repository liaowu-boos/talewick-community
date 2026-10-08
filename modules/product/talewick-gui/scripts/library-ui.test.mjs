import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceStatus, indexRebuildActive, canRetryIndex, failureStage, candidateText, diagnosticText } from '../src/model/library.ts';
const base = { status: 'failed', indexStatus: 'failed' };
test('index retry requires saved analysis, including failed draft cases', () => {
  assert.equal(canRetryIndex(base), false);
  assert.equal(canRetryIndex({ ...base, analysisDraft: {} }), false);
  assert.equal(canRetryIndex({ ...base, analysis: {} }), true);
  assert.equal(canRetryIndex({ ...base, analysis: {}, status: 'running' }), false);
});
test('validation, review failure/rejection and indexing are distinct', () => {
  assert.equal(failureStage({ ...base, status: 'running', analysisDraft: {} }), '正在拆解');
  assert.equal(failureStage({ ...base, analysisDraft: {} }), '拆解校验未通过');
  assert.equal(failureStage({ ...base, error: { code: 'INVALID_ANALYSIS' } }), '拆解校验未通过');
  assert.equal(failureStage({ ...base, analysis: { validation: { semanticReview: { approved: false, outcome: 'failed' } } } }), '复核处理失败');
  assert.equal(failureStage({ ...base, analysis: { validation: { semanticReview: { approved: false, outcome: 'rejected' } } } }), '复核未通过');
  assert.equal(failureStage({ ...base, analysis: {} }), '索引未完成');
});
test('candidate projection excludes raw JSON/prompts and tolerates invalid structures', () => {
  assert.equal(candidateText({ overview: '<img>literal', prompt: 'secret', rawJSON: 'secret', units: [null, { title: '单元标题', evidence: [null] }] }), '<img>literal\n\n单元：单元标题');
  assert.doesNotMatch(candidateText('{"prompt":"secret"}'), /secret/);
  assert.equal(diagnosticText({ path: 'units[8].evidence[0]', message: '引文不一致', lineStart: 415 }), '第 9 个分析单元，原文第 415 行：引文不一致');
});

test('source-lines candidates show unverified ranges without inventing or trusting quotes', () => {
  const candidate = { evidenceMode: 'source-lines-v1', units: [{ evidence: [{ lineStart: 541, lineEnd: 541, quote: '不可相信的模型原句' }] }] };
  assert.equal(candidateText(candidate), '未核对引用位置：原文第 541–541 行（范围尚未通过校验）');
  assert.equal(canRetryIndex({ status: 'failed', indexStatus: 'failed', analysisDraft: { candidate } }), false);
});

 test('stale saved analysis permits index-only recovery without treating it as model failure', () => {
   assert.equal(canRetryIndex({status:'partial',indexStatus:'stale',analysis:{validation:{semanticReview:{approved:false,outcome:'rejected'}}}}),true);
   assert.equal(canRetryIndex({status:'completed',indexStatus:'stale'}),false);
   assert.equal(canRetryIndex({status:'running',indexStatus:'stale',analysis:{}}),false);
 });

test('invalid review JSON is a processing failure, not semantic rejection or approval', () => {
 const analysis={reviewStatus:'candidate',validation:{semanticReview:{approved:false,outcome:'failed',diagnostics:[{code:'REVIEW_INVALID_JSON',path:'$',message:'无效 JSON'}]}}};
 assert.equal(failureStage({status:'failed',indexStatus:'failed',analysis}),'复核响应格式错误');
 assert.equal(failureStage({status:'failed',indexStatus:'failed',analysis:{...analysis,validation:{semanticReview:{approved:false,outcome:'failed'}}}}),'复核处理失败');
});

test('index stage is explicit, active-only, and subordinate to revisions',()=>{
 for(const status of ['queued','running']){
  const source={status,indexStatus:'stale',processingStage:'index'};
  assert.equal(indexRebuildActive(source),true);
  assert.equal(sourceStatus(source),status==='queued'?'等待重建索引':'正在重建索引');
  assert.equal(indexRebuildActive({...source,processingStage:undefined}),false);
  assert.equal(sourceStatus({...source,processingStage:undefined}),status==='queued'?'等待拆解':'正在拆解');
  assert.equal(indexRebuildActive({...source,activeRevisionId:'revision'}),false);
  assert.equal(sourceStatus({...source,activeRevisionId:'revision'}),status==='queued'?'等待修订':'修订处理中');
 }
 assert.equal(indexRebuildActive({status:'completed',processingStage:'index'}),false);
 assert.equal(indexRebuildActive({status:'running',processingStage:'other'}),false);
});
