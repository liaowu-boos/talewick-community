import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const dataUrl = async (file, mime) => `data:${mime};base64,${(await fs.readFile(file)).toString('base64')}`;
let html = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
const scriptTag = html.match(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/);
const styleTag = html.match(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
if (!scriptTag || !styleTag) throw new Error('Vite build entry not found. Run npm run build first.');
const scriptFile = path.resolve(dist, scriptTag[1]);
const styleFile = path.resolve(dist, styleTag[1]);
let css = await fs.readFile(styleFile, 'utf8');
for (const match of [...css.matchAll(/url\(([^)]+)\)/g)]) {
  const url = match[1].replace(/^['"]|['"]$/g, '');
  if (url.startsWith('data:') || url.startsWith('#')) continue;
  const file = path.resolve(path.dirname(styleFile), url);
  const ext = path.extname(file);
  const mime = ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : ext === '.png' ? 'image/png' : 'application/octet-stream';
  css = css.replaceAll(match[0], `url("${await dataUrl(file, mime)}")`);
}
const images = {};
for (const name of await fs.readdir(path.join(dist, 'assets'))) {
  if (name.endsWith('.png')) images[name] = await dataUrl(path.join(dist, 'assets', name), 'image/png');
}
const code = `window.TALEWICK_ASSETS=${JSON.stringify(images)};\n${await fs.readFile(scriptFile, 'utf8')}`.replace(/<\/script/gi, '<\\/script');
html = html.replace(scriptTag[0], '').replace(styleTag[0], () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`);
html = html.replace('href="./favicon.svg"', `href="${await dataUrl(path.join(dist, 'favicon.svg'), 'image/svg+xml')}"`);
html = html.replace('</body>', () => `<script type="module">${code}</script>\n</body>`);
const output = path.join(root, 'Talewick.html');
await fs.writeFile(output, html);
console.log(`Created ${output} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB), with fonts, images, styles and application code embedded.`);
