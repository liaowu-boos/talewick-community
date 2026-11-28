import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Install in GUI/server, or audit the product output with these optional paths.
const root = process.env.TALEWICK_GUI || fileURLToPath(new URL('../', import.meta.url));
const component = process.env.SAVED_MANUSCRIPT_PREVIEW || resolve(root, 'src/features/SavedManuscriptPreview.tsx');
const {build} = createRequire(resolve(root, 'package.json'))('esbuild');
const bundled = await build({
  stdin: {
    contents: `
      export {SavedManuscriptPreview} from ${JSON.stringify(component)};
      export {createElement} from 'react';
      export {renderToStaticMarkup} from 'react-dom/server';
    `,
    resolveDir: root, loader: 'tsx',
  },
  alias: {'@': resolve(root, 'src')},
  nodePaths: [resolve(root, 'node_modules')],
  jsx: 'automatic',
  bundle: true, platform: 'node', format: 'esm', write: false,
  banner: {js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(resolve(root, 'package.json'))});`},
});
const {SavedManuscriptPreview, createElement, renderToStaticMarkup} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function fixture() {
  return {
    id: 'synthetic-saved', label: '合成只读存稿', date: '2026-01-01T00:00:00.000Z', title: '原存稿书名',
    chapters: [
      {id: 'same-id', title: '重复章名', body: '合成甲正文。\n第二段保留空行。\n\n末段。'},
      {id: 'distinct-id', title: '重复章名', body: '合成乙正文：& <合成标记> 🙂。'},
      {id: 'same-id', title: '重复章名', body: ''},
    ],
  };
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function render(version) {
  const before = structuredClone(version);
  freeze(version);
  const html = renderToStaticMarkup(createElement(SavedManuscriptPreview, {version}));
  assert.deepEqual(version, before, 'rendering must preserve the complete source snapshot');
  return html;
}
function escaped(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}
function chapterHeadings(html) {
  return [...html.matchAll(/<h4\b([^>]*)>([\s\S]*?)<\/h4>/g)];
}
function bodyParagraphs(html) {
  return [...html.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)]
    .filter(([, attributes]) => attributes.includes('font-story'));
}
function button(html, label) {
  const matches = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, , body]) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() === label);
  assert.equal(matches.length, 1, `exactly one ${label} button`);
  return matches[0][1];
}
const disabled = /\sdisabled(?:=|\s|$)/;

test('all original chapters render together in order despite repeated chapter names or IDs', () => {
  const version = fixture(), html = render(version);
  assert.match(html, /<h3\b[^>]*>原存稿书名<\/h3>/);
  assert.deepEqual(chapterHeadings(html).map(([, , body]) => body), version.chapters.map(chapter => escaped(chapter.title)));
  assert.deepEqual(bodyParagraphs(html).map(([, , body]) => body), version.chapters.map(chapter => escaped(chapter.body)));
  for (const [, attributes] of chapterHeadings(html)) assert.match(attributes, /tabindex="-1"/);
  for (const [, attributes] of bodyParagraphs(html)) {
    assert.ok(attributes.includes('whitespace-pre-wrap'));
    assert.doesNotMatch(attributes, /\shidden(?:=|\s|$)|aria-hidden="true"/);
  }
});

test('titleless legacy snapshot retains the existing missing-title wording and every body', () => {
  const version = fixture();
  delete version.title;
  const html = render(version);
  assert.match(html, /<h3\b[^>]*>存稿未记录书名<\/h3>/);
  assert.equal(bodyParagraphs(html).length, version.chapters.length);
  assert.doesNotMatch(html, /undefined|原存稿书名/);
});

test('initial navigation disables previous, enables next and reports count without claiming a jump', () => {
  const html = render(fixture());
  assert.match(button(html, '上一章'), disabled);
  assert.doesNotMatch(button(html, '下一章'), disabled);
  assert.match(html, /aria-label="存稿章节导航"/);
  assert.match(html, /role="status"[^>]*>共 3 章<\/p>/);
  assert.doesNotMatch(html, /已定位|已跳转/);
});

test('a single empty-body chapter stays present with both navigation boundaries disabled', () => {
  const version = fixture();
  version.chapters = [{id: 'empty-body', title: '', body: ''}];
  const html = render(version);
  assert.deepEqual(chapterHeadings(html).map(([, , body]) => body), ['']);
  assert.deepEqual(bodyParagraphs(html).map(([, , body]) => body), ['']);
  assert.match(button(html, '上一章'), disabled);
  assert.match(button(html, '下一章'), disabled);
  assert.match(html, /role="status"[^>]*>共 1 章<\/p>/);
  assert.doesNotMatch(html, /已定位|已跳转/);
});

test('empty chapter collection renders no invented chapter and disables previous and next', () => {
  const version = fixture();
  version.chapters = [];
  const html = render(version);
  assert.equal(chapterHeadings(html).length, 0);
  assert.equal(bodyParagraphs(html).length, 0);
  assert.match(button(html, '上一章'), disabled);
  assert.match(button(html, '下一章'), disabled);
  assert.match(html, /role="status"[^>]*>共 0 章<\/p>/);
  assert.doesNotMatch(html, /已定位|已跳转|undefined|NaN/);
});


test('blank chapter titles retain original text with readable navigation and focus labels', () => {
  const version = fixture();
  version.chapters = [{id: 'blank', title: '   ', body: '空白标题合成正文'}, {id: 'blank', title: '', body: ''}];
  const html = render(version);
  assert.deepEqual(chapterHeadings(html).map(([, , body]) => body), ['   ', '']);
  assert.match(html, /1\. 未命名章节/);
  for (const [index, heading] of chapterHeadings(html).entries()) {
    assert.ok(heading[1].includes(`aria-label="第 ${index + 1} 章（未命名章节）"`));
  }
});
