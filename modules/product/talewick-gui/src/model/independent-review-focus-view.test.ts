import test from 'node:test';
import assert from 'node:assert/strict';
import { independentReviewView } from './independent-review-view.ts';

const ids = ['continuation_desire', 'psychological_turns', 'emotional_payoff', 'middle_late_pacing', 'scene_explanation', 'choice_cost'];
const evidence = [{ blindId: 'A', chapterId: 'c1', quote: '  原句\n', start: 2 }];
const counterEvidence = [{ blindId: 'B', chapterId: 'c2', quote: '反向的原句', start: 4 }];

test('an exact citation does not label a model hard_fact claim as verified text fact', () => {
  const quote = '下午三点，我在巷口下了车。';
  const report = { schemaVersion: 'independent-review-single-result-1', records: [{ record: { readerId: 'reader-2', entries: [{
    blindId: 'M', claims: [{ id: 'claim', claimType: 'hard_fact', statement: '主人公是儿子。', evidence: [{ blindId: 'M', chapterId: 'c1', quote, start: 0 }] }],
  }] } }] };
  const before = structuredClone(report), view = independentReviewView(report, 'single'), claim = view.sections[0].findings[0];
  assert.equal(claim.status, '模型事实判断'); assert.equal(claim.statement, '主人公是儿子。');
  assert.equal(claim.evidence[0].quote, quote); assert.deepEqual(report, before);
});

test('v3 renders each sealed focus with separate counterevidence and uncertainty without inventing a pass', () => {
  const readings = { schemaVersion: 'whole-quality-independent-reading-2', readerId: 'reader-1', entries: [{ blindId: 'A', readScope: 'whole', overallImpression: '并无明显改善', claims: [],
    focusAssessments: ids.map(focusId => ({ focusId, claimType: 'editorial_hypothesis', statement: `${focusId}仍有不确定性`, evidence, counterEvidence: [], uncertainty: '未找到足够反例，结论仅限本次阅读。' })) }] };
  const pairs = { schemaVersion: 'whole-quality-blind-pair-3', readerId: 'reader-2', preference: 'mixed', comparisons: ids.map((focusId, i) => ({ id: `comparison-${i}`, focusId,
    claimType: 'editorial_hypothesis', statement: `${focusId}两稿各有取舍`, severeHarm: { status: 'none', blindIds: [], evidence: [] }, evidence, counterEvidence, uncertainty: '反向证据使本判断不能扩大。' })) };
  const report = { schemaVersion: 'whole-quality-evaluation-result-3', automaticAdoption: false, literaryPass: 'NOT_COMPUTED',
    severeHarmAttribution: { baselineIssues: [], candidateRisks: [], unknown: [{}] },
    completionEvidence: { independentReadings: [{ record: readings }], blindPairReviews: [{ record: pairs }], manuscriptBindings: { A: { blindId: 'A', role: 'baseline' }, B: { blindId: 'B', role: 'candidate' } } } };
  const before = structuredClone(report), view = independentReviewView(report, 'compare');
  const readingFindings = view.sections[0].findings.filter(item => item.id.includes('-focus-')), comparisons = view.sections[1].findings;
  assert.equal(readingFindings.length, 6); assert.equal(comparisons.length, 6);
  assert.ok(readingFindings.every(item => item.uncertainty === '未找到足够反例，结论仅限本次阅读。'));
  assert.ok(comparisons.every(item => item.uncertainty === '反向证据使本判断不能扩大。'));
  assert.deepEqual(comparisons[0].evidence.map(item => item.evidenceKind), ['supporting', 'counter']);
  assert.equal(comparisons[0].evidence[0].quote, '  原句\n'); assert.equal(comparisons[0].evidence[1].quote, '反向的原句');
  assert.match(readingFindings[0].detail || '', /继续阅读意愿的变化/); assert.match(readingFindings[5].detail || '', /人物选择及其代价/);
  assert.ok(view.attributionLines.includes('问题归属待核对：1 条')); assert.ok(view.limitations.includes('本任务不计算文学质量通过。'));
  assert.deepEqual(report, before);
  const partial = independentReviewView({ schemaVersion: 'independent-review-partial-blind-report-1', completeBlindReview: true, completedBlindStages: 6,
    taskStatus: 'needs_attention', goalAuditStatus: 'needs_attention', automaticAdoption: false, literaryPass: 'NOT_COMPUTED',
    isolatedReadings: [{ record: readings }], blindPairReviews: [{ record: pairs }] }, 'compare');
  assert.equal(partial.headline, '全文盲评已完成；目标核查未通过'); assert.equal(partial.sections[0].findings.filter(item => item.id.includes('-focus-')).length, 6);
});

test('old reports without six-focus observations are not relabelled or filled with invented dimensions', () => {
  const view = independentReviewView({ readerViews: [{ record: { schemaVersion: 'whole-quality-independent-reading-1', readerId: 'reader-1', entries: [{ blindId: 'M', overallImpression: '旧初读意见', claims: [] }] } }] }, 'single');
  assert.deepEqual(view.findings, ['旧初读意见']); assert.equal(view.sections[0].findings[0].uncertainty, undefined);
  assert.ok(!view.findings.some(item => ids.some(id => item.includes(id))));
});
