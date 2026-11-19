import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const bundled = await build({
  stdin: {
    contents: `
      export {VersionList} from './src/features/VersionList.tsx';
      export {createElement} from 'react';
      export {renderToStaticMarkup} from 'react-dom/server';
    `,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    loader: 'tsx',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  banner: {js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(fileURLToPath(import.meta.url))});`},
});
const {VersionList, createElement, renderToStaticMarkup} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

const firstChapter = {id: 'door', title: '门口', body: '合成正文甲：灯下只有一把椅子。'};
const secondChapter = {id: 'stairs', title: '楼梯', body: '合成正文乙：楼上的脚步停住了。'};
const versions = [
  {
    id: 'saved-first', label: '结尾修改', date: '2026-01-01T00:00:00.000Z',
    chapters: [firstChapter],
  },
  {
    id: 'saved-second', label: '结尾修改', date: '2026-01-01T00:00:00.000Z',
    title: '合成小说', chapters: [firstChapter, secondChapter],
  },
];

function render(selectedId) {
  return renderToStaticMarkup(createElement(VersionList, {
    versions, selectedId, onSelect: () => {},
  }));
}

function versionButtons(html) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, , content]) => content.includes('结尾修改'))
    .map(([, attributes, content]) => ({
      selected: /aria-pressed="true"/.test(attributes),
      text: content.replace(/<[^>]*>/g, '').trim(),
    }));
}

test('same-name, same-date snapshots both render and selection follows the version ID', () => {
  for (const [selectedId, count] of [['saved-first', 1], ['saved-second', 2]]) {
    const rows = versionButtons(render(selectedId));
    assert.equal(rows.length, 2, 'both saved versions must remain selectable');
    const selected = rows.filter(row => row.selected);
    assert.equal(selected.length, 1);
    assert.match(selected[0].text, new RegExp(count + '\\s*章'));
    assert.match(rows.find(row => !row.selected).text, new RegExp((3 - count) + '\\s*章'));
  }
});

test('a legacy snapshot without a book title remains visible and selectable', () => {
  const html = render('saved-first');
  const selected = versionButtons(html).find(row => row.selected);
  assert.ok(selected);
  assert.match(selected.text, /结尾修改/);
  assert.match(selected.text, /1\s*章/);
  assert.doesNotMatch(html, /undefined|Invalid Date/);
});

test('the version list excludes manuscript bodies from its rendered markup', () => {
  const html = render('saved-second');
  assert.equal(versionButtons(html).length, 2);
  assert.ok(!html.includes(firstChapter.body));
  assert.ok(!html.includes(secondChapter.body));
  assert.doesNotMatch(html, /合成正文甲|合成正文乙/);
});
