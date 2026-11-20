import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const bundled = await build({
  stdin: {
    contents: `
      export {VersionRestorePreview} from './src/features/VersionRestorePreview.tsx';
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
const {VersionRestorePreview, createElement, renderToStaticMarkup} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function makePlan() {
  return {
    projectId: 'synthetic-story',
    source: {
      id: 'saved-story', label: '合成存稿', date: '2026-01-01T00:00:00.000Z', title: '旧书名',
      chapters: [
        {id: 'door', title: '门前', body: '她推开门。'},
        {id: 'other', title: '窗前', body: '窗外落着雨。'},
      ],
    },
    current: {
      title: '现书名',
      chapters: [
        {id: 'door', title: '门前', body: '她拉开门。'},
        {id: 'other', title: '窗前', body: '窗外落着雨。'},
      ],
    },
    pendingEdits: [
      {id: 'edit-door', chapterId: 'door', before: '拉', after: '叩', reason: '合成意见', status: 'pending'},
      {id: 'edit-other', chapterId: 'other', before: '雨', after: '雪', reason: '另一章合成意见', status: 'pending'},
    ],
  };
}

function render(plan = makePlan(), blocked = false) {
  return renderToStaticMarkup(createElement(VersionRestorePreview, {
    plan, blocked, onConfirm: () => {}, onCancel: () => {},
  }));
}

function marked(html, tag) {
  return [...html.matchAll(new RegExp('<' + tag + '>(.*?)</' + tag + '>', 'gs'))].map(match => match[1]);
}

function buttons(html) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attributes, content]) => ({
    text: content.replace(/<[^>]*>/g, '').trim(),
    disabled: /\sdisabled(?:\s|=|$)/.test(attributes),
  }));
}

test('whole restore preview deletes current title and text and inserts saved title and text', () => {
  const html = render();
  assert.ok(html.includes('从当前稿到来源存稿'));
  assert.deepEqual(marked(html, 'del'), ['现书名', '拉']);
  assert.deepEqual(marked(html, 'ins'), ['旧书名', '推']);
});

test('whole restore preview explains clearing pending suggestions across chapters', () => {
  const html = render();
  assert.match(html, /已有修改建议及处理记录共 2 条将清除/);
});

test('an untitled legacy snapshot uses the current book title in the comparison', () => {
  const plan = makePlan();
  delete plan.source.title;
  const html = render(plan);
  assert.ok(html.includes('沿用当前书名「现书名」'));
  assert.deepEqual(marked(html, 'del'), ['拉']);
  assert.deepEqual(marked(html, 'ins'), ['推']);
  assert.doesNotMatch(html, /无法核对书名|书名变更|undefined/);
});

test('expired whole restore preview disables confirmation and permits cancellation', () => {
  for (const blocked of [false, true]) {
    const html = render(makePlan(), blocked);
    const actions = buttons(html);
    const confirm = actions.find(action => action.text.includes('确认恢复'));
    const cancel = actions.find(action => action.text.includes('取消恢复'));
    assert.ok(confirm, 'expected whole restore confirmation');
    assert.ok(cancel, 'expected cancellation');
    assert.equal(confirm.disabled, blocked);
    assert.equal(cancel.disabled, false);
    if (blocked) assert.match(html, /role="alert"[^>]*>[^<]*过期/);
  }
});
