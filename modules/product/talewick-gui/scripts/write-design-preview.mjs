import { readFile, writeFile } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
const html = await readFile(new URL('index.html', dist), 'utf8');
const preview = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-view="design">')
  .replace(/<title>[^<]*<\/title>/, '<title>Talewick · 视觉样板</title>');
await writeFile(new URL('design-preview.html', dist), preview);
console.log('Built design-preview.html with the same version of the shared UI components.');
