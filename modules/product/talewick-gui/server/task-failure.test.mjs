import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStoredFailurePolicy, classifyTaskFailure, EXHAUSTED_WHOLE_QUALITY_MESSAGE, isStoredWholeQualityReadingFailureCandidate, taskFailureRecoverable, taskPhase } from './task-failure.mjs';

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

test('exhausted whole-quality correction requires a new revision instead of replaying the checkpoint', () => {
  const failure = classifyTaskFailure(Object.assign(new Error('two invalid responses'), { code: 'WHOLE_QUALITY_FORMAT_FAILED' }), 'whole-quality:reading:repair-response');
  assert.deepEqual(failure, {
    kind: 'review_output', phase: 'review', retryScope: 'unfinished_review', recoverable: false,
    message: EXHAUSTED_WHOLE_QUALITY_MESSAGE,
  });
  assert.match(failure.message, /原稿、诊断输入和已保存现场仍保留/);
  assert.match(failure.message, /重新发起整稿修订/);
  assert.doesNotMatch(failure.message, /继续任务|只会运行未完成/);
});

test('synthetic historical task is blocked only with saved-response proof that both readings are invalid', () => {
  const task = {
    id: '66666666-6666-4666-8666-666666666666', revisionMode: 'whole-manuscript-v2', status: 'failed',
    stage: 'whole-quality:reading:repair-response',
    modelAttempts: [{ stage: 'whole-quality:reading' }, { stage: 'whole-quality:reading:format-repair' }],
    failure: { kind: 'unknown', phase: 'step', retryScope: 'unfinished_step', message: '当前步骤未完成。' },
  };
  assert.equal(isStoredWholeQualityReadingFailureCandidate(task), true);
  applyStoredFailurePolicy(task, { schemaVersion: 'whole-quality-reading-failure-inspection-1', stage: 'whole-quality:reading', exhausted: true });
  assert.equal(task.failure.recoverable, false);
  assert.equal(task.failure.message, EXHAUSTED_WHOLE_QUALITY_MESSAGE);
  assert.equal(taskFailureRecoverable(task), false);
  assert.equal(taskFailureRecoverable({ status: 'failed', failure: { kind: 'unknown' } }), true);
});

test('stage and attempt count alone never block historical recovery', () => {
  const failure = { kind: 'unknown', phase: 'step', retryScope: 'unfinished_step', message: '旧记录' };
  const task = { revisionMode: 'whole-manuscript-v2', status: 'failed', stage: 'whole-quality:reading:repair-response',
    modelAttempts: [{ stage: 'whole-quality:reading' }, { stage: 'whole-quality:reading:format-repair' }], failure: structuredClone(failure) };
  applyStoredFailurePolicy(task, { schemaVersion: 'whole-quality-reading-failure-inspection-1', stage: 'whole-quality:reading', exhausted: false, reason: 'repair_valid' });
  assert.deepEqual(task.failure, failure);
  assert.equal(taskFailureRecoverable(task), true);
  applyStoredFailurePolicy(task, undefined);
  assert.deepEqual(task.failure, failure);
  assert.equal(isStoredWholeQualityReadingFailureCandidate({ ...task, stage: 'whole-quality:plan:repair-response' }), false);
});
