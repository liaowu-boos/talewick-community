import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTaskFailure, taskPhase } from './task-failure.mjs';

test('state review rejection is reported as unfinished review, never as a network outage', () => {
  const failure = classifyTaskFailure(Object.assign(new Error('状态专审字段不符'), { code: 'STATE_REVIEW_REJECTED' }), 'continuity-review');
  assert.deepEqual(failure, {
    kind: 'review_output', phase: 'review', retryScope: 'unfinished_review',
    message: '审阅结果的格式或版本绑定未通过校验。正文和已完成步骤已保存；继续任务时只会运行未完成的审阅。',
  });
  assert.doesNotMatch(failure.message, /网络|连接|服务配置/);
});

test('task failures distinguish connection, configuration, writing and delivery checks', () => {
  assert.equal(classifyTaskFailure(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), 'draft:ch-2').kind, 'network');
  assert.equal(classifyTaskFailure(new Error('模型尚未配置，请填写本机模型配置后重试。'), 'planning').kind, 'configuration');
  assert.equal(classifyTaskFailure(new Error('invalid prose'), 'draft:ch-2').kind, 'writing');
  assert.equal(classifyTaskFailure(Object.assign(new Error('invalid result'), { code: 'WORKFLOW_RESULT_UNVERIFIED' }), 'result').kind, 'delivery_check');
});

test('stage grouping separates writing, review and delivery without percentages', () => {
  assert.equal(taskPhase('draft:ch-9'), 'writing');
  assert.equal(taskPhase('continuity-review'), 'review');
  assert.equal(taskPhase('review-adjudication:repair'), 'review');
  assert.equal(taskPhase('validation'), 'check');
});
