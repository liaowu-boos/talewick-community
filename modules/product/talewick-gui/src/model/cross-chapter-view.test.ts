import test from 'node:test';
import assert from 'node:assert/strict';
import { crossChapterSummary } from './cross-chapter-view.ts';

test('r02 shape counts candidate confirmed findings instead of all comparison groups', () => {
  const quality = {
    crossChapterReview: {
      schemaVersion: 'whole-quality-cross-chapter-bundle-1',
      review: {
        schemaVersion: 'cross-chapter-review-result-1',
        comparisonGroups: Array.from({ length: 20 }, (_, index) => ({ id: `source-group-${index + 1}` })),
        findings: [{ status: 'ambiguous' }, { status: 'resolved' }],
      },
    },
    crossChapterResolution: { items: [] },
    crossChapterRecheck: {
      schemaVersion: 'whole-quality-cross-chapter-bundle-1',
      review: {
        schemaVersion: 'cross-chapter-review-result-1',
        comparisonGroups: Array.from({ length: 20 }, (_, index) => ({ id: `candidate-group-${index + 1}` })),
        findings: [
          { groupId: 'ch4', status: 'confirmed_conflict' },
          { groupId: 'ch9', status: 'confirmed_conflict' },
          ...Array.from({ length: 13 }, () => ({ status: 'resolved' })),
        ],
      },
    },
  };
  assert.deepEqual(crossChapterSummary(quality), {
    sourceConfirmed: 0,
    sourceAmbiguous: 1,
    sourceResolved: 1,
    repairedOriginalIssues: 0,
    unrepairedOriginalIssues: 0,
    candidateConfirmed: 2,
    candidateRecheckPresent: true,
    label: '跨章事实核查（原稿确认 0 · 原定问题已修 0 · 候选仍有冲突 2）',
  });
});

test('older cross result remains visible without inventing a candidate recheck', () => {
  const quality = {
    crossChapterReview: {
      schemaVersion: 'whole-quality-cross-chapter-bundle-1',
      review: {
        schemaVersion: 'cross-chapter-review-result-1',
        findings: [{ status: 'confirmed_conflict' }, { status: 'ambiguous' }, { status: 'resolved' }],
      },
    },
    crossChapterResolution: { items: [{ repairStatus: 'unresolved' }] },
  };
  assert.deepEqual(crossChapterSummary(quality), {
    sourceConfirmed: 1,
    sourceAmbiguous: 1,
    sourceResolved: 1,
    repairedOriginalIssues: 0,
    unrepairedOriginalIssues: 1,
    candidateConfirmed: 0,
    candidateRecheckPresent: false,
    label: '跨章事实核查（原稿确认 1 · 原定问题已修 0 · 候选复查未记录）',
  });
  assert.equal(crossChapterSummary({}), null);
});

test('exhausted candidate protocol is shown as incomplete rather than zero conflicts', () => {
  const summary = crossChapterSummary({crossChapterReview:{schemaVersion:'whole-quality-cross-chapter-bundle-1',review:{schemaVersion:'cross-chapter-review-result-1',findings:[]}},
    crossChapterRecheckIncomplete:{status:'incomplete'},crossChapterResolution:{items:[]}});
  assert.equal(summary?.candidateRecheckPresent,false);
  assert.match(summary!.label,/候选核查未完成/u);
  assert.doesNotMatch(summary!.label,/候选仍有冲突 0/u);
});
