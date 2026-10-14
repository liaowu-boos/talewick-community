import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterWritingBudget } from './chapter-budget.mjs';

const complete = (id, min, target, max) => ({ id, targetHanMin: min, targetHan: target, targetHanMax: max });
const whole = { targetHanMin: 9000, targetHanMax: 11000 };

function budgetAt({ written, chapters, chapterIndex }) {
  const input = {
    requirements: whole,
    plan: { lengthPolicyVersion: 'chapter-budget-1', chapters },
    chapterIndex,
    previousChapters: written ? [{ id: 'saved-prose', body: '甲'.repeat(written) }] : [],
  };
  const before = structuredClone(input);
  const result = chapterWritingBudget(input);
  assert.deepEqual(input, before, 'budget guidance must not rewrite saved prose or the approved plan');
  return result;
}

test('five remaining Han is reported as a capacity conflict, not an executable chapter range', () => {
  const result = budgetAt({ written: 8945, chapterIndex: 0, chapters: [
    complete('ch-8', 900, 1000, 1100), complete('ch-9', 1100, 1200, 1300), complete('ch-10', 950, 1050, 1150),
  ] });
  assert.deepEqual(result.currentChapter, { id: 'ch-8', min: 900, target: 1000, max: 1100 });
  assert.equal(result.operationalChapter.status, 'insufficient_current_minimum_capacity');
  assert.equal(result.operationalChapter.executable, false);
  assert.deepEqual([result.operationalChapter.min, result.operationalChapter.target, result.operationalChapter.max], [null, null, null]);
  assert.equal(result.operationalChapter.availableHan, 5);
  assert.equal(result.operationalChapter.shortfallToPlannedMin, 895);
  assert.deepEqual(result.operationalChapter.futureReserve, { chapterCount: 2, plannedMin: 2050, plannedTarget: 2250 });
  assert.equal(result.remaining.max, 2055, 'true total remainder stays visible');
});

test('ninety-six remaining Han uses the same explicit conflict contract', () => {
  const result = budgetAt({ written: 9954, chapterIndex: 0, chapters: [
    complete('ch-9', 1100, 1200, 1300), complete('ch-10', 950, 1050, 1150),
  ] });
  assert.equal(result.operationalChapter.status, 'insufficient_current_minimum_capacity');
  assert.equal(result.operationalChapter.executable, false);
  assert.deepEqual([result.operationalChapter.min, result.operationalChapter.target, result.operationalChapter.max], [null, null, null]);
  assert.equal(result.operationalChapter.availableHan, 96);
  assert.equal(result.operationalChapter.shortfallToPlannedMin, 1004);
  assert.deepEqual(result.operationalChapter.futureReserve, { chapterCount: 1, plannedMin: 950, plannedTarget: 1050 });
  assert.match(result.operationalChapter.fallbackAction, /完整写完必要行动/);
});

test('zero headroom remains distinct and does not ask for a zero-character chapter', () => {
  const result = budgetAt({ written: 11264, chapterIndex: 0, chapters: [complete('ch-10', 950, 1050, 1150)] });
  assert.equal(result.operationalChapter.status, 'no_safe_headroom');
  assert.equal(result.operationalChapter.executable, false);
  assert.deepEqual([result.operationalChapter.min, result.operationalChapter.target, result.operationalChapter.max], [null, null, null]);
  assert.equal(result.operationalChapter.availableHan, 0);
  assert.equal(result.operationalChapter.shortfallToPlannedMin, 950);
  assert.equal(result.overrunHan, 264);
  assert.match(result.guidance, /不返回空章、摘要或截断正文/);
});

test('normal contraction stays executable when the current planned minimum still fits', () => {
  const result = chapterWritingBudget({
    requirements: { targetHanMin: 900, targetHanMax: 1200 },
    plan: { lengthPolicyVersion: 'chapter-budget-1', chapters: [
      complete('ch-2', 200, 300, 400), complete('ch-3', 500, 700, 900),
    ] },
    chapterIndex: 0,
    previousChapters: [{ id: 'ch-1', body: '甲'.repeat(500) }],
  });
  assert.deepEqual(result.operationalChapter, {
    id: 'ch-2', min: 200, target: 200, max: 200,
    status: 'constrained_by_actual_prose', executable: true,
    targetAllowance: 0, maxAllowance: 200, availableHan: 200, shortfallToPlannedMin: 0,
    futureReserve: { chapterCount: 1, plannedMin: 500, plannedTarget: 700 },
    nonTruncationRule: '控制展开尺度，不裁切模型返回正文；必要行动、因果交接和结局仍须完整。',
    fallbackAction: null,
  });
});

test('legacy plans without a complete range stay unknown and never receive invented limits', () => {
  const legacy = { chapters: [{ id: 'legacy', targetHan: 700 }] };
  const before = structuredClone(legacy);
  const result = chapterWritingBudget({ requirements: whole, plan: legacy, chapterIndex: 0, previousChapters: [] });
  assert.equal(result.planOrigin, 'legacy_plan');
  assert.deepEqual(result.currentChapter, { id: 'legacy', min: null, target: 700, max: null });
  assert.equal(result.operationalChapter.status, 'plan_range_unavailable');
  assert.equal(result.operationalChapter.executable, false);
  assert.deepEqual([result.operationalChapter.min, result.operationalChapter.target, result.operationalChapter.max], [null, null, null]);
  assert.equal(result.operationalChapter.availableHan, 11000);
  assert.equal(result.operationalChapter.shortfallToPlannedMin, null);
  assert.deepEqual(legacy, before);
});
