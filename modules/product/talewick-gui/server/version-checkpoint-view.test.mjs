import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const bundled = await build({
  stdin: {
    contents: `
      export {VersionCheckpointPreview} from './src/features/VersionCheckpointPreview.tsx';
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
const {VersionCheckpointPreview, createElement, renderToStaticMarkup} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function render(blocked=false) {
  const plan={projectId:'synthetic',versionId:'checkpoint',title:'合成作品',
    chapters:[{id:'a',title:'第一章',body:'合成正文。'}]};
  return renderToStaticMarkup(createElement(VersionCheckpointPreview,{
    plan,blocked,pendingCount:2,onConfirm:()=>true,onCancel:()=>{},
  }));
}
test('checkpoint preview identifies saved manuscript and distinguishes opinions from snapshot text',()=>{
  const html=render();
  for(const text of ['合成作品','共 1 章','待审建议共 2 条','继续保留在当前作品中','不包含在存稿里','旧存稿会保留'])
    assert.ok(html.includes(text),text);
  assert.match(html,/aria-label="保存命名存稿"/);
  assert.match(html,/placeholder="例如：交给试读前"/);
});
test('empty initial name disables confirm and stale preview explains why cancellation is available',()=>{
  for(const blocked of [false,true]){
    const html=render(blocked);
    const buttons=[...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    const confirm=buttons.find(([, ,body])=>body.includes('确认保存存稿'));
    const cancel=buttons.find(([, ,body])=>body.includes('取消保存存稿'));
    assert.ok(confirm);assert.ok(cancel);
    assert.match(confirm[1],/\sdisabled(?:=|\s|$)/);
    assert.doesNotMatch(cancel[1],/\sdisabled(?:=|\s|$)/);
    if(blocked)assert.match(html,/role="alert"[^>]*>[^<]*过期/);
  }
});
