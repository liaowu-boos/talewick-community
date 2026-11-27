import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Install in GUI/server, or set TALEWICK_GUI for a read-only run from outputs.
const root = process.env.TALEWICK_GUI || fileURLToPath(new URL('../', import.meta.url));
const {build} = createRequire(resolve(root, 'package.json'))('esbuild');
const bundled = await build({
  stdin: {
    contents: `
      export {VersionList} from './src/features/VersionList.tsx';
      export {createElement} from 'react';
      export {renderToStaticMarkup} from 'react-dom/server';
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  bundle: true, platform: 'node', format: 'esm', write: false,
  banner: {js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(resolve(root, 'package.json'))});`},
});
const {VersionList, createElement, renderToStaticMarkup} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function fixture() {
  return [
    {id: 'first', label: '同名存稿', date: '2026-01-01T00:00:00.000Z', chapters: [{id: 'a', title: '合成章一', body: '合成正文一勿展示'}]},
    {id: 'second', label: '同名存稿', date: '2026-01-01T00:00:00.000Z', title: '合成书名', chapters: [{id: 'a', title: '合成章二', body: '合成正文二勿展示'}]},
    {id: 'third', label: '中间存稿', date: '2026-01-02T00:00:00.000Z', title: '合成书名', chapters: [{id: 'a', title: '合成章三', body: ''}]},
    {id: 'fourth', label: '末尾存稿', date: '2026-01-03T00:00:00.000Z', title: '新合成书名', chapters: [{id: 'a', title: '合成章四', body: '合成正文四勿展示'}]},
  ];
}

function render(versions, selectedId) {
  const before = structuredClone(versions);
  const html = renderToStaticMarkup(createElement(VersionList, {
    versions, selectedId,
    onSelect: () => assert.fail('rendering must not auto-select any saved version'),
  }));
  assert.deepEqual(versions, before, 'rendering must not reorder or mutate source versions');
  return html;
}

function rows(html) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attributes]) => /\baria-pressed="(?:true|false)"/.test(attributes))
    .map(([, attributes, content]) => {
      const text = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const number = text.match(/存稿\s+(\d+)/);
      assert.ok(number, 'each saved-version row retains its original ordinal');
      return {number: Number(number[1]), selected: /\baria-pressed="true"/.test(attributes), text};
    });
}

test('empty query preserves reverse insertion order, original ordinals and latest identity', () => {
  const html = render(fixture(), 'second');
  const visible = rows(html);
  assert.deepEqual(visible.map(row => row.number), [4, 3, 2, 1]);
  assert.deepEqual(visible.filter(row => row.selected).map(row => row.number), [2]);
  assert.deepEqual(visible.filter(row => row.text.includes('最近版本')).map(row => row.number), [4]);
  assert.match(html, /aria-label="选择历史版本"/);
  assert.doesNotMatch(html, /该存稿未出现在查找结果中|没有找到匹配的存稿|清除查找/);
});

test('duplicate labels and dates stay separate and selected styling follows version ID', () => {
  for (const [selectedId, expected] of [['first', 1], ['second', 2]]) {
    const visible = rows(render(fixture(), selectedId));
    assert.equal(visible.filter(row => row.text.includes('同名存稿')).length, 2);
    assert.deepEqual(visible.filter(row => row.selected).map(row => row.number), [expected]);
  }
});

test('searchable saved bodies are not printed in the initial list and legacy title stays optional', () => {
  const versions = fixture();
  const html = render(versions, 'first');
  assert.equal(rows(html).length, 4);
  for (const version of versions) {
    for (const chapter of version.chapters) if (chapter.body) assert.ok(!html.includes(chapter.body));
  }
  assert.doesNotMatch(html, /undefined|Invalid Date/);
});

test('empty history shows an empty state without invented or selected rows', () => {
  const html = render([], 'missing');
  assert.equal(rows(html).length, 0);
  assert.ok(html.includes('暂无历史存稿。'));
  assert.doesNotMatch(html, /最近版本|显示所选存稿/);
});
