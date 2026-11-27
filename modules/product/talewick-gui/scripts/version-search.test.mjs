import assert from 'node:assert/strict';
import test from 'node:test';
import { searchVersions } from '../src/model/version-search.ts';

function version(id, chapters = [], extra = {}) {
  return { id, label: '合成存稿', date: '2026-01-01', chapters, ...extra };
}
const chapter = (title, body) => ({ id: title, title, body });

test('blank searches return every version in reverse original order with stable original numbers', () => {
  const versions = [version('old'), version('middle'), version('new')];
  for (const query of ['', ' \t\n　']) {
    const result = searchVersions(versions, query);
    assert.deepEqual(result, [
      { version: versions[2], number: 3 }, { version: versions[1], number: 2 }, { version: versions[0], number: 1 },
    ]);
    assert.equal(result[0].version, versions[2]);
  }
  assert.deepEqual(searchVersions([], '文字'), []);
});

test('name or book-title matches take precedence, ignore case and preserve duplicate labels', () => {
  const versions = [
    version('a', [chapter('章节', 'needle正文')], { label: 'Needle' }),
    version('b', [], { title: 'NEEDLE书名' }),
    version('c', [], { label: 'Needle' }),
    version('d'),
  ];
  const result = searchVersions(versions, '  needle  ');
  assert.deepEqual(result, [
    { version: versions[2], number: 3 }, { version: versions[1], number: 2 }, { version: versions[0], number: 1 },
  ]);
  assert.deepEqual(searchVersions([version('legacy')], '旧书名'), []);
});

test('the first matching chapter supplies its title and snippet, including title-only matches', () => {
  const first = version('first', [chapter('无关', '没有匹配'), chapter('中间章', '目标在这里'), chapter('目标末章', '后来')]);
  assert.deepEqual(searchVersions([first], '目标')[0].match, { chapterTitle: '中间章', excerpt: '目标在这里' });
  const titleOnly = version('title', [chapter('目标章节', '正文无匹配'), chapter('次章', '目标')]);
  assert.deepEqual(searchVersions([titleOnly], '目标')[0].match, { chapterTitle: '目标章节', excerpt: '' });
  assert.equal(searchVersions([version('case', [chapter('章', 'An APPLE appears')])], 'apple')[0].match.excerpt, 'An APPLE appears');
});

test('query syntax stays literal and never joins fields or chapters', () => {
  const versions = [version('literal', [chapter('章', '字符 .* [x] (a|b) \\d+')])];
  for (const query of ['.*', '[x]', '(a|b)', '\\d+']) assert.equal(searchVersions(versions, query).length, 1);
  assert.equal(searchVersions(versions, '字符.*').length, 0);
  const boundaries = version('boundaries', [chapter('丙', '丁'), chapter('戊', '己')], { label: '甲', title: '乙' });
  for (const query of ['甲乙', '乙丙', '丙丁', '丁戊', '丁己']) {
    assert.deepEqual(searchVersions([boundaries], query), []);
  }
});

test('body excerpts surround hits and preserve original Unicode code points and line breaks', () => {
  for (const body of [
    '目标' + '🙂'.repeat(150),
    '🙂'.repeat(150) + '目标',
    '🙂'.repeat(150) + '目标\r\n𠮷e\u0301' + '🙂'.repeat(150),
    'İ'.repeat(150) + 'TARGET' + '𠮷'.repeat(150),
  ]) {
    const query = body.includes('TARGET') ? 'target' : '目标';
    const result = searchVersions([version('unicode', [chapter('原章节', body)])], query)[0];
    const excerpt = result.match.excerpt;
    assert.ok(Array.from(excerpt).length <= 100);
    assert.ok(excerpt.toLowerCase().includes(query));
    assert.ok(body.includes(excerpt));
    assert.equal(excerpt.isWellFormed(), true);
    if (body.includes('\r\n')) assert.ok(excerpt.includes('\r\n'));
  }
  const longQuery = '🙂'.repeat(120);
  const excerpt = searchVersions([version('long', [chapter('章', longQuery)])], longQuery)[0].match.excerpt;
  assert.equal(Array.from(excerpt).length, 100);
});

test('frozen inputs remain untouched and filtering does not renumber or mutate selection', () => {
  const versions = [version('a', [chapter('甲', '找我')]), version('b'), version('c', [chapter('丙', '找我')])];
  const before = structuredClone(versions);
  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  freeze(versions);
  const selectedId = 'b';
  const result = searchVersions(versions, '找我');
  assert.deepEqual(result.map(row => [row.version.id, row.number]), [['c', 3], ['a', 1]]);
  assert.equal(result.some(row => row.version.id === selectedId), false);
  assert.equal(selectedId, 'b');
  assert.deepEqual(versions, before);
});
