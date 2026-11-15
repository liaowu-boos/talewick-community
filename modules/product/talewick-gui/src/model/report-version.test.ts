import assert from 'node:assert/strict';
import test from 'node:test';
import type { IsolatedHistoryRecord } from './independent-review.ts';
import { findReportVersions } from './report-version.ts';
import { manuscriptRevision } from './runtime.ts';
import type { Chapter, Project, Version } from './types.ts';

const chapters = [
  { id: 'first', title: '第一章', body: '合成正文甲。' },
  { id: 'second', title: '第二章', body: '合成正文乙。' },
];
const saved: Version = { id: 'v1', label: '存稿', date: '2026-02-02', title: '原题', chapters };

function reportFor(title: string, source = chapters): IsolatedHistoryRecord {
  return { id: 'synthetic-report', title, createdAt: '2026-02-03', synthetic: true,
    manuscriptRevision: manuscriptRevision({ title, chapters: source }) };
}

function findReportVersion(project: Pick<Project, 'versions'>, report: IsolatedHistoryRecord) {
  return findReportVersions(project.versions, [report]).get(report.id);
}

function versionMatchesReport(version: Version, report: IsolatedHistoryRecord) {
  return findReportVersions([version], [report]).has(report.id);
}

test('receipts on the same manuscript retain distinct IDs across review dates', () => {
  const first = reportFor('原题');
  const repeat = {...first, id: 'second-review', createdAt: '2026-02-04'};
  const changed = {...reportFor('原题', chapters.slice(1)), id: 'new-revision'};
  const matches = findReportVersions([saved], [repeat, changed, first]);
  assert.equal(matches.size, 2);
  assert.equal(matches.get(first.id), saved);
  assert.equal(matches.get(repeat.id), saved);
});

test('a renamed project can locate its old report only among its own saved versions', () => {
  const project = { title: '新题', chapters, versions: [saved] };
  assert.equal(findReportVersion(project, reportFor('原题')), saved);
  assert.equal(findReportVersion(project, reportFor('新题')), undefined);
  assert.equal(findReportVersion({ ...project, versions: [] }, reportFor('新题')), undefined);
  assert.equal(versionMatchesReport({ ...saved, title: '' }, reportFor('原题')), false);
});

test('a titleless version uses each receipt title together with that receipt revision', () => {
  const legacy: Version = { id: 'legacy', date: '', label: '旧存稿', chapters };
  for (const title of ['原题', '另一题']) {
    assert.equal(findReportVersion({ versions: [legacy] }, reportFor(title)), legacy);
  }
  assert.equal(versionMatchesReport(legacy, { ...reportFor('原题'), title: '另一题' }), false);
});

test('each matching duplicate is a candidate and lookup returns the last matching array entry', () => {
  const receipt = reportFor('原题');
  const latest = { ...saved, id: 'v2', date: '2026-01-01', chapters: structuredClone(chapters) };
  const versions = [saved, latest, { ...saved, id: 'v3', title: '新题' }];
  assert.equal(versionMatchesReport(saved, receipt), true);
  assert.equal(versionMatchesReport(latest, receipt), true);
  assert.equal(findReportVersion({ versions }, receipt), latest);
  assert.deepEqual(versions.map(v => v.id), ['v1', 'v2', 'v3']);
});

test('chapter text, identity, title and order all participate in the lookup', () => {
  for (const changed of [
    [{ ...chapters[0], body: '合成正文丙。' }, chapters[1]],
    [{ ...chapters[0], id: 'another' }, chapters[1]],
    [{ ...chapters[0], title: '改章名' }, chapters[1]],
    [...chapters].reverse(), chapters.slice(1),
  ]) {
    assert.equal(findReportVersion({ versions: [{ ...saved, chapters: changed }] }, reportFor('原题')), undefined);
  }
});

test('invalid chapter lists are rejected even if their serialized revision matches', () => {
  for (const invalid of [[], [null], [chapters[0], chapters[0]], [{ ...chapters[0], id: 1 }],
    [{ ...chapters[0], title: null }], [{ ...chapters[0], body: 1 }], [{ id: 'first', title: '' }]]) {
    const malformed = invalid as unknown as Chapter[];
    assert.equal(versionMatchesReport({ ...saved, chapters: malformed }, reportFor('原题', malformed)), false);
  }
});
