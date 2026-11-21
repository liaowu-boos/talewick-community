import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const bundled = await build({
  stdin: {
    contents: `
      export {VersionForkPreview} from './src/features/VersionForkPreview.tsx';
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
const {VersionForkPreview, createElement, renderToStaticMarkup} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function makePlan() {
  return {projectId:'synthetic-origin',newProjectId:'synthetic-fork',fallbackTitle:'旧稿书名',
    source:{id:'saved',label:'第二稿',date:'2026-01-01',title:'旧稿书名',
      chapters:[{id:'one',title:'桥边',body:'一只鸟飞过。'},{id:'two',title:'门前',body:'纸页翻动。'}]}};
}
function render(blocked=false) {
  return renderToStaticMarkup(createElement(VersionForkPreview, {
    plan:makePlan(),blocked,onConfirm:()=>true,onCancel:()=>{},
  }));
}
test('fork preview identifies the saved source and default new title with isolation notice', () => {
  const html=render();
  for (const text of ['第二稿','旧稿书名','共 2 章','旧稿书名（副本）','原作品不变','旧评阅报告、任务和待审修改不复制'])
    assert.ok(html.includes(text),text);
  assert.match(html,/aria-label="从存稿新建作品"/);
});
test('stale fork disables confirmation while leaving cancellation available', () => {
  for(const blocked of [false,true]) {
    const html=render(blocked);
    const buttons=[...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    const confirm=buttons.find(([, ,body])=>body.includes('确认新建作品'));
    const cancel=buttons.find(([, ,body])=>body.includes('取消新建'));
    assert.ok(confirm); assert.ok(cancel);
    assert.equal(/\sdisabled(?:=|\s|$)/.test(confirm[1]),blocked);
    assert.equal(/\sdisabled(?:=|\s|$)/.test(cancel[1]),false);
    if(blocked) assert.match(html,/role="alert"[^>]*>[^<]*过期/);
  }
});
