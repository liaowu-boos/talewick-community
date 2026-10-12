import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsFull15Response, full15PanelAction, full15ReportView } from '../src/model/full15-view.ts';

test('panel starts the current manuscript when an old failed report is stale', () => {
  assert.equal(full15PanelAction({ status: 'needs_attention' }, true), 'start');
  assert.equal(full15PanelAction({ status: 'interrupted' }, true), 'start');
});

test('panel resumes or rechecks same-version unfinished work and disables active work', () => {
  assert.equal(full15PanelAction({ status: 'interrupted' }, false), 'retry');
  assert.equal(full15PanelAction({ status: 'needs_attention' }, false), 'retry');
  assert.equal(full15PanelAction({ status: 'queued' }, false), null);
  assert.equal(full15PanelAction({ status: 'running' }, false), null);
  for (const status of ['incomplete', 'complete', 'cancelled']) {
    assert.equal(full15PanelAction({ status }, false), 'retry');
    assert.equal(full15PanelAction({ status }, true), 'start');
  }
});

test('late refreshes cannot replace another project or a newer response', () => {
  assert.equal(acceptsFull15Response('project-b', 'project-a', 2, 2), false);
  assert.equal(acceptsFull15Response('project-a', 'project-a', 1, 2), false);
  assert.equal(acceptsFull15Response('project-a', 'project-a', 2, 2), true);
});

test('report view exposes Chinese check states, issue summaries and exact quotes without internal receipts', () => {
  const view = full15ReportView({
    path: '/private/run/report.json', sha256: 'a'.repeat(64),
    checks: [
      { id: 'C01', name: '交付规格', status: 'checked', data: { body_han_count: 10877, explicit_chapter_count: 10 } },
      { id: 'C05', name: '四五章承接', status: 'not_applicable', data: { summary: '本次要求明确不适用。' } },
      { id: 'C06', name: '有限参考文本重合', status: 'not_evaluated', data: { reason: '没有获准参考范围。' } },
    ],
    issues: [{ id: 'issue-1', check_id: 'C03', reasoning: '人物前后说法需要人工核对。', suggested_verification: '比较两处叙述的时间。', citations: [{ quote: '钥匙一直在她手里。' }, { quote: '钥匙早已交出。' }] }],
    priorityIssueIds: ['issue-1'], limitations: ['定位存在不证明判断正确。'],
  });
  assert.deepEqual(view.checks.map(item => [item.id, item.statusLabel]), [['C01', '已检查'], ['C05', '不适用'], ['C06', '未评估']]);
  assert.match(view.checks[0].summary, /10877.*10 章/);
  assert.equal(view.issues[0].priority, true);
  assert.equal(view.issues[0].summary, '人物前后说法需要人工核对。');
  assert.deepEqual(view.issues[0].quotes, ['钥匙一直在她手里。', '钥匙早已交出。']);
  assert.doesNotMatch(JSON.stringify(view), /private\/run|aaaaaaaaaaaaaaaa/);
  assert.match(view.scopeText, /不适用.*未评估.*不表示通过/);
});
