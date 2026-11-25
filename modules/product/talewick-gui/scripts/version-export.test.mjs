import assert from 'node:assert/strict';
import test from 'node:test';
import { createProject } from '../src/model/seed.ts';
import { exportManuscript } from '../src/model/store.ts';
import { prepareVersionExport, canExportVersion, renderVersionExport } from '../src/model/version-export.ts';

const copy = value => structuredClone(value);
function fixture() {
  const p = createProject('合成旧稿导出');
  p.title = '当前书名';
  p.chapters = [{ id: 'current', title: '当前章', body: '当前正文不可导出' }];
  p.pendingEdits = [{ after: '私有建议标记' }];
  p.runtime = { rawResponse: '私有回包标记', task: { status: 'running' } };
  p.versions = [
    { id: 'first', label: '初稿', date: '2026-01-01', title: '  旧书名  ',
      chapters: [{ id: 'b', title: '第二章', body: '首行\r\n第二行\n\n𠮷🙂 e\u0301\u2028末行\n' },
        { id: 'a', title: '第一章', body: '' }], privateNote: '私有额外字段' },
    { id: 'second', label: '修订稿', date: '2026-01-02', title: '另一书名',
      chapters: [{ id: 'a', title: '第一章', body: '另一版本正文' }] },
  ];
  return p;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('selected versions preserve exact title, chapter order and Unicode line breaks in both formats', () => {
  const p = fixture(), original = copy(p);
  for (const version of p.versions) {
    const plan = prepareVersionExport(p, version.id);
    freeze(p); freeze(plan);
    assert.equal(canExportVersion(p, plan), true);
    for (const format of ['txt', 'md']) {
      const result = renderVersionExport(p, plan, format, '不得替代存稿书名');
      const prefix = format === 'md' ? '# ' : '';
      const heading = format === 'md' ? '## ' : '';
      const expected = prefix + version.title + '\n\n' + version.chapters
        .map(ch => heading + ch.title + '\n\n' + ch.body).join('\n\n---\n\n');
      assert.equal(result.text, expected);
      assert.equal(result.text, exportManuscript({ ...p, title: version.title }, format, version.chapters));
      assert.ok(result.filename.endsWith('.' + format));
      for (const privateText of ['当前正文不可导出', '私有建议标记', '私有回包标记', '私有额外字段']) {
        assert.equal(result.text.includes(privateText), false);
      }
    }
  }
  assert.deepEqual(p, original);
});

test('titleless and whitespace-title snapshots require an explicit nonblank export title', () => {
  for (const title of [undefined, '', ' \n　']) {
    const p = fixture(); p.versions[0].title = title;
    const plan = prepareVersionExport(p, 'first'), original = copy(p);
    assert.equal(renderVersionExport(p, plan, 'txt'), null);
    assert.equal(renderVersionExport(p, plan, 'txt', ' \t '), null);
    assert.ok(renderVersionExport(p, plan, 'txt', '  明确补题  ').text.startsWith('明确补题\n\n'));
    assert.deepEqual(p, original);
  }
});

test('missing, duplicate and malformed versions cannot prepare an export', () => {
  for (const mutate of [
    p => { p.versions = []; }, p => { p.versions.push(copy(p.versions[0])); },
    p => { p.versions[0].title = 1; }, p => { p.versions[0].label = null; },
    p => { p.versions[0].date = 1; }, p => { p.versions[0].chapters = []; },
    p => { p.versions[0].chapters = null; }, p => { p.versions[0].chapters[0] = null; },
    p => { p.versions[0].chapters[0].id = ''; }, p => { p.versions[0].chapters[0].id = 4; },
    p => { p.versions[0].chapters.push(copy(p.versions[0].chapters[0])); },
    p => { p.versions[0].chapters[0].title = null; }, p => { p.versions[0].chapters[0].body = 2; },
  ]) {
    const p = fixture(); mutate(p); const before = copy(p);
    assert.equal(prepareVersionExport(p, 'first'), null);
    assert.deepEqual(p, before);
  }
});

test('changes to any selected version field, missing sources and wrong projects expire a frozen plan', () => {
  for (const mutate of [
    p => { p.id += 'other'; }, p => { p.versions.shift(); },
    p => { p.versions.push(copy(p.versions[0])); }, p => { p.versions[0].id += 'other'; },
    p => { p.versions[0].label += '改'; }, p => { p.versions[0].date += '改'; },
    p => { p.versions[0].title += '改'; }, p => { p.versions[0].chapters.reverse(); },
    p => { p.versions[0].chapters[0].body += '改'; }, p => { p.versions[0].chapters[0].title += '改'; },
    p => { p.versions[0].privateNote += '改'; },
  ]) {
    const p = fixture(), plan = prepareVersionExport(p, 'first');
    mutate(p); const before = copy(p);
    assert.equal(canExportVersion(p, plan), false);
    assert.equal(renderVersionExport(p, plan, 'md'), null);
    assert.deepEqual(p, before);
  }
  const p = fixture(), before = copy(p), plan = prepareVersionExport(p, 'first');
  plan.version.chapters[0].body = '预览改动';
  assert.equal(canExportVersion(p, plan), false);
  assert.deepEqual(p, before);
});

test('current manuscript, suggestions, task and another version can change without blocking selected history', () => {
  const p = fixture(), plan = prepareVersionExport(p, 'first');
  const expected = renderVersionExport(p, plan, 'md');
  p.title = '当前改名'; p.chapters = []; p.pendingEdits = []; p.runtime = undefined;
  p.versions[1].chapters[0].body = '另一本存稿变化';
  const before = copy(p);
  assert.equal(canExportVersion(p, plan), true);
  assert.deepEqual(renderVersionExport(p, plan, 'md'), expected);
  assert.equal(renderVersionExport(p, plan, 'html'), null);
  assert.deepEqual(p, before);
});

test('filenames remove unsafe characters and bound Unicode byte length with the correct extension', () => {
  for (const [title, label] of [
    ['../../书名/\\:\u0000\n\u202e', '../存稿|?*<>:"'],
    ['🙂'.repeat(200), '𠮷'.repeat(200)],
    ['...', '\\/:*?'],
    ['CON', 'NUL'],
  ]) {
    const p = fixture(); p.versions[0].title = title; p.versions[0].label = label;
    const plan = prepareVersionExport(p, 'first');
    for (const format of ['txt', 'md']) {
      const { filename, text } = renderVersionExport(p, plan, format);
      assert.ok(Buffer.byteLength(filename, 'utf8') <= 205);
      assert.equal(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(filename), false);
      assert.equal(filename.startsWith('.'), false);
      assert.ok(filename.endsWith('.' + format));
      assert.ok(text.startsWith((format === 'md' ? '# ' : '') + title + '\n\n'));
    }
  }
  const p = fixture(), result = renderVersionExport(p, prepareVersionExport(p, 'second'), 'md');
  assert.equal(result.filename, '另一书名-修订稿.md');
});
