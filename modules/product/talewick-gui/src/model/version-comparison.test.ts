import assert from 'node:assert/strict';
import test from 'node:test';
import type { Chapter } from './types.ts';
import { compareManuscripts } from './version-comparison.ts';

const chapter = (id: string): Chapter => ({ id, title: '合成章节' + id, body: '合成正文' + id });
const [a, b, c, d, e, x] = Array.from('abcdex', chapter);
const compare = (before: Chapter[], after: Chapter[]) =>
  compareManuscripts({ chapters: before }, { chapters: after });

test('title changes are independent of chapter changes and missing titles remain unknown', () => {
  const cases = [
    [undefined, undefined, 'unknown'], ['', undefined, 'unknown'], [undefined, '', 'unknown'],
    ['', '', 'same'], ['原题', '原题', 'same'], ['', '新题', 'changed'],
  ] as const;
  for (const [beforeTitle, afterTitle, titleStatus] of cases) {
    assert.deepEqual(compareManuscripts({ title: beforeTitle, chapters: [a] },
      { title: afterTitle, chapters: [{ ...a }] }), { titleStatus, orderChanged: false, chapters: [] });
  }
});

test('insertions and deletions alone do not move retained chapters', () => {
  assert.deepEqual(compare([a, b, c, d], [x, a, c]), {
    titleStatus: 'unknown', orderChanged: false, chapters: [
      { id: x.id, after: x, beforeIndex: -1, afterIndex: 0, moved: false },
      { id: b.id, before: b, beforeIndex: 1, afterIndex: -1, moved: false },
      { id: d.id, before: d, beforeIndex: 3, afterIndex: -1, moved: false },
    ],
  });
  assert.equal(compare([], []).orderChanged, false);
  assert.deepEqual(compare([a], [b]).chapters.map(row => row.id), [b.id, a.id]);
});

test('all chapters that cross another are listed, including one whose index remains the same', () => {
  const edited = { ...c, body: '改一个字' };
  const result = compare([a, b, c, d, e], [a, d, edited, b, e]);
  assert.equal(result.orderChanged, true);
  assert.deepEqual(result.chapters, [
    { id: d.id, before: d, after: d, beforeIndex: 3, afterIndex: 1, moved: true },
    { id: c.id, before: c, after: edited, beforeIndex: 2, afterIndex: 2, moved: true },
    { id: b.id, before: b, after: b, beforeIndex: 1, afterIndex: 3, moved: true },
  ]);
});

test('reports chapter title and text edits, ignoring unrelated shifts in index', () => {
  const renamed = { ...a, title: '另一个章名' };
  const revised = { ...d, body: d.body + '。' };
  const result = compare([a, b, c, d], [x, renamed, c, b, revised]);
  assert.equal(result.orderChanged, true);
  assert.deepEqual(result.chapters.map(row => [row.id, row.beforeIndex, row.afterIndex, row.moved]), [
    ['x', -1, 0, false], ['a', 0, 1, false], ['c', 2, 2, true], ['b', 1, 3, true], ['d', 3, 4, false],
  ]);
  assert.equal(result.chapters[1].after, renamed);
  assert.equal(result.chapters[4].after, revised);
});
