import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterWritingBudget } from './chapter-budget.mjs';
import { runChecks } from '../../validation/runtime/checks.mjs';

const plan = {
  lengthPolicyVersion: 'chapter-budget-1',
  chapters: [
    { id: 'ch-1', targetHanMin: 200, targetHan: 300, targetHanMax: 400 },
    { id: 'ch-2', targetHanMin: 200, targetHan: 300, targetHanMax: 400 },
    { id: 'ch-3', targetHanMin: 500, targetHan: 700, targetHanMax: 900 },
  ],
};

test('actual prose reserves later minimum capacity without erasing a feasible current minimum', () => {
  const input = {
    requirements: { targetHanMin: 900, targetHanMax: 1200 }, plan, chapterIndex: 1,
    previousChapters: [{ id: 'ch-1', body: '甲'.repeat(500) }],
  };
  const before = structuredClone(input);
  const budget = chapterWritingBudget(input);
  assert.deepEqual(budget.currentChapter, { id: 'ch-2', min: 200, target: 300, max: 400 });
  assert.deepEqual(budget.operationalChapter, {
    id: 'ch-2', min: 200, target: 200, max: 200, status: 'constrained_by_actual_prose', executable: true,
    targetAllowance: 0, maxAllowance: 200, availableHan: 200, shortfallToPlannedMin: 0,
    futureReserve: { chapterCount: 1, plannedMin: 500, plannedTarget: 700 },
    nonTruncationRule: '控制展开尺度，不裁切模型返回正文；必要行动、因果交接和结局仍须完整。',
    fallbackAction: null,
  });
  assert.deepEqual(input, before);
});

test('exhausted headroom is explicit and never becomes a negative or silent slice', () => {
  const budget = chapterWritingBudget({
    requirements: { targetHanMin: 900, targetHanMax: 1100 }, plan,
    chapterIndex: 2, previousChapters: [{ id: 'ch-1', body: '甲'.repeat(1200) }],
  });
  assert.deepEqual(budget.operationalChapter, {
    id: 'ch-3', min: null, target: null, max: null, status: 'no_safe_headroom', executable: false,
    targetAllowance: 0, maxAllowance: 0, availableHan: 0, shortfallToPlannedMin: 500,
    futureReserve: { chapterCount: 0, plannedMin: 0, plannedTarget: 0 },
    nonTruncationRule: '控制展开尺度，不裁切模型返回正文；必要行动、因果交接和结局仍须完整。',
    fallbackAction: '没有满足计划最低容量的可执行范围；按批准计划完整写完必要行动，终检依据实际完成正文判定篇幅是否满足。',
  });
  assert.match(budget.guidance, /小于当前章计划最低容量的余额不能作为可执行章目标/);
  assert.match(budget.guidance, /终检依据实际完成正文判定篇幅是否满足/);
  assert.match(budget.guidance, /不会静默裁切/);
});

test('final checks return an explicit request conformance decision and exact delta', () => {
  const chapters = [{ id: 'ch-1', title: '不计标题', body: '甲乙丙' }];
  const met = runChecks({ chapters, requirements: { targetHanMin: 3, targetHanMax: 3, targetChapterCount: 1 } });
  assert.equal(met.requestConformance.status, 'MET');
  assert.equal(met.requestConformance.length.status, 'MET');
  const over = runChecks({ chapters, requirements: { targetHanMin: 1, targetHanMax: 2, targetChapterCount: 1 } });
  assert.equal(over.requestConformance.status, 'NOT_MET');
  assert.deepEqual(over.requestConformance.length, {
    status: 'ABOVE_MAXIMUM', actualHan: 3, min: 1, max: 2,
    belowMinimumBy: 0, aboveMaximumBy: 1,
  });
  const unknown = runChecks({ chapters });
  assert.equal(unknown.requestConformance.status, 'NOT_EVALUATED');
});
