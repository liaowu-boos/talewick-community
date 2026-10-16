import test from 'node:test';
import assert from 'node:assert/strict';
import { independentReviewView } from './independent-review-view.ts';

const citations = Array.from({ length: 61 }, (_, index) => ({ blindId: index % 2 ? 'B' : 'A', chapterId: 'c1', quote: `证据${index}`, start: index }));
const independent = (readerId: string, suffix: string) => ({
  schemaVersion: 'whole-quality-independent-reading-1', readerId,
  entries: [{ blindId: 'A', overallImpression: `${readerId}整体意见`, claims: Array.from({ length: 14 }, (_, index) => ({
    id: `${readerId}-${index}`, claimType: 'editorial_hypothesis', statement: `${readerId}第${index + 1}条判断${suffix}`,
    evidence: index === 13 ? citations : [citations[index]],
  })) }, { blindId: 'B', overallImpression: `${readerId}候选稿整体意见`, claims: [{
    id: `${readerId}-candidate`, claimType: 'editorial_hypothesis', statement: `${readerId}候选稿判断${suffix}`, evidence: [citations[1]],
  }] }],
});
const pair = (readerId: string) => ({ schemaVersion: 'whole-quality-blind-pair-1', readerId, preference: 'mixed', comparisons: [{
  id: `${readerId}-comparison`, claimType: 'editorial_hypothesis', statement: `${readerId}两稿比较`, severeHarm: false,
  evidence: [{ blindId: 'A', chapterId: 'c1', quote: '同一位置', start: 2 }, { blindId: 'B', chapterId: 'c1', quote: '同一位置', start: 2 }],
}] });
const goal = { schemaVersion: 'whole-quality-goal-audit-1', goalAssessments: [{ goalId: 'g1', status: 'partially_implemented', rationale: '目标只落实了一部分', outcomes: [{ outcomeId: 'o1', status: 'partially_implemented', explanation: '候选增加行动但代价不足', baselineEvidence: [citations[0]], candidateEvidence: [citations[1]] }] }] };

test('r05 completion evidence labels deblinded readings and frozen goal text', () => {
  const first = independent('reader-1', '甲'), second = independent('reader-2', '乙'), firstPair = pair('reader-1'), secondPair = pair('reader-2');
  const report = {
    readerViews: [
      { readerId: 'reader-1', preference: 'first', order: ['A', 'B'], selectedBlindId: 'A' },
      { readerId: 'reader-2', preference: 'second', order: ['B', 'A'], selectedBlindId: 'A' },
    ],
    divergentReadings: { records: [{ readerId: 'reader-1', recordSha256: 'pair-1', comparisons: firstPair.comparisons }] },
    completionEvidence: {
      independentReadings: [{ readerId: 'reader-1', recordSha256: 'independent-1', record: first }, { readerId: 'reader-2', recordSha256: 'independent-2', record: second }],
      blindPairReviews: [{ readerId: 'reader-1', recordSha256: 'pair-1', record: firstPair }, { readerId: 'reader-2', recordSha256: 'pair-2', record: secondPair }],
      goalAudit: { recordSha256: 'goal', record: goal },
      frozenGoals: [{ id: 'g1', statement: '让主角以行动承担选择的代价', requiredOutcomes: [{ id: 'o1', dimension: 'action', description: '候选稿出现可见行动及其代价' }] }],
      manuscriptBindings: {
        A: { blindId: 'A', role: 'baseline', chapters: [{ id: 'c1', title: '原稿章', body: '同一位置，原稿后文。' }] },
        B: { blindId: 'B', role: 'candidate', chapters: [{ id: 'c1', title: '候选章', body: '同一位置，候选后文。' }] },
      },
    },
    automaticAdoption: false, literaryPass: 'NOT_COMPUTED', limitations: [],
  };
  const view = independentReviewView(report, 'compare');
  assert.deepEqual(view.readerLines, [
    '读者 1：倾向冻结原稿（匿名稿A；先读）',
    '读者 2：倾向冻结原稿（匿名稿A；后读）',
  ]);
  assert.equal(view.sections.length, 5);
  assert.ok(view.findings.includes('reader-1第14条判断甲'));
  assert.ok(view.findings.includes('reader-2第14条判断乙'));
  assert.equal(view.summaryFindings.length, 4);
  const fourteenth = view.sections.find(section => section.readerId === 'reader-1' && section.stage === 'independent_reading')?.findings.find(finding => finding.statement.includes('第14条'));
  const readerOneReadings = view.sections.find(section => section.readerId === 'reader-1' && section.stage === 'independent_reading')?.findings ?? [];
  assert.ok(readerOneReadings.filter(finding => finding.statement.includes('reader-1整体') || finding.statement.includes('reader-1第')).every(finding => finding.detail === '冻结原稿 · 匿名稿 A'));
  assert.ok(readerOneReadings.filter(finding => finding.statement.includes('reader-1候选稿')).every(finding => finding.detail === '冻结候选稿 · 匿名稿 B'));
  assert.equal(fourteenth?.evidence.length, 61);
  const pairFinding = view.sections.find(section => section.readerId === 'reader-1' && section.stage === 'blind_pair')?.findings[0];
  assert.deepEqual(pairFinding?.evidence.map(item => [item.blindId, item.documentRole]), [['A', 'source'], ['B', 'candidate']]);
  assert.deepEqual(view.snapshots.map(item => [item.blindId, item.role]), [['A', 'source'], ['B', 'candidate']]);
  const goalFindings = view.sections.find(section => section.stage === 'goal_audit')?.findings ?? [];
  assert.equal(goalFindings.find(finding => finding.statement === '目标只落实了一部分')?.detail, '目标：让主角以行动承担选择的代价');
  assert.equal(goalFindings.find(finding => finding.statement === '候选增加行动但代价不足')?.detail, '预定结果：候选稿出现可见行动及其代价');
});

test('mixed and no-clear preferences keep their completed-report meaning', () => {
  const view = independentReviewView({ readerViews: [
    { readerId: 'reader-1', preference: 'mixed' },
    { readerId: 'reader-2', preference: 'no_clear_preference' },
  ] }, 'compare');
  assert.deepEqual(view.readerLines, ['读者 1：两稿各有取舍', '读者 2：无明确偏好']);
  const unfinished = independentReviewView({
    readerViews: [{ readerId: 'reader-1', preference: 'first', order: ['A', 'B'], selectedBlindId: 'A' }],
    manuscriptBindings: { A: { blindId: 'A', role: 'baseline' } },
  }, 'compare');
  assert.deepEqual(unfinished.readerLines, ['读者 1：倾向先读稿'], 'role identity stays blind before completion evidence exists');
  const legacyGoal = independentReviewView({ goalAudit: { record: goal } }, 'compare');
  assert.deepEqual(legacyGoal.sections[0].findings.map(item => item.detail), ['目标 g1', '结果 o1']);
  const limitations = independentReviewView({ limitations: [
    'Blind preference does not prove goal implementation.',
    'Goal implementation does not by itself grant adoption.',
    'Mixed or divergent findings require a narrowed recheck rather than aggregation.',
    'Unknown limitation stays unchanged.',
  ] }, 'compare').limitations;
  assert.deepEqual(limitations, [
    '盲评偏好不能证明预定目标已经落实。',
    '目标落实本身不代表候选稿可以直接采用。',
    '意见混合或存在分歧时，需要缩小范围复核，不能合并为统一结论。',
    'Unknown limitation stays unchanged.',
  ]);
});

test('frozen body and citation retain whitespace and emoji UTF-16 offsets exactly', () => {
  const body = '  😀开头  结尾 \n', quote = ' 😀开头  ', start = 1;
  const report = {
    readerViews: [{ readerId: 'reader-1', recordSha256: 'single-1', record: {
      schemaVersion: 'whole-quality-independent-reading-1', readerId: 'reader-1',
      entries: [{ blindId: 'M', overallImpression: '保留空白', claims: [{ id: 'c1', claimType: 'hard_fact', statement: '引文包含首尾空白', evidence: [{ blindId: 'M', chapterId: 'ch-1', quote, start }] }] }],
    } }],
    completionEvidence: { manuscript: { blindId: 'M', role: 'baseline', chapters: [{ id: 'ch-1', title: ' 第一章 ', body }] } },
  };
  const view = independentReviewView(report, 'single'), evidence = view.sections[0].findings.find(item => item.statement === '引文包含首尾空白')?.evidence[0];
  assert.equal(view.snapshots[0].chapters[0].body, body);
  assert.equal(view.snapshots[0].chapters[0].title, '第一章');
  assert.equal(evidence?.quote, quote);
  assert.equal(evidence?.start, start);
  assert.equal(body.slice(start, start + quote.length), quote);
  assert.equal('😀'.length, 2, 'offset fixture must exercise JavaScript UTF-16 code units');
  assert.equal(body.slice(start + 1, start + 3), '😀');
});
