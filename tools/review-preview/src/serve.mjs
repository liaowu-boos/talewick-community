import http from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readContained, sha256} from './evidence-store.mjs';
import assert from 'node:assert/strict';
export async function loadSite(root, expectedHash) {
  const raw = await readContained(root,'site-manifest.json');
  assert.equal(sha256(raw),expectedHash,'Site manifest hash mismatch');
  const manifest = JSON.parse(raw), routes = new Map();
  assert.equal(manifest.schemaVersion,'review-static-site-1');
  for (const entry of manifest.entries) {
    assert(/^\/(?:[a-zA-Z0-9_./-]*)$/.test(entry.url) && !routes.has(entry.url),'Invalid route');
    const bytes = await readContained(root,entry.path);
    assert.equal(sha256(bytes),entry.sha256,'Site asset hash mismatch');
    assert(['text/html; charset=utf-8','application/json; charset=utf-8','text/css; charset=utf-8','text/plain; charset=utf-8','font/woff','font/woff2'].includes(entry.contentType));
    routes.set(entry.url,{bytes,contentType:entry.contentType,download:entry.download===true});
  }
  return routes;
}
export function createPreviewServer(routes) {
  return http.createServer((req,res)=>{
    const port = res.socket.localPort;
    const hosts = [`127.0.0.1:${port}`,`localhost:${port}`];
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('Cache-Control','no-store');
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !hosts.map(h=>'http://'+h).includes(req.headers.origin)) || (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site']))) {res.writeHead(403);res.end('Forbidden');return;}
    if (req.method !== 'GET') {res.writeHead(405,{Allow:'GET'});res.end('GET only');return;}
    // Raw exact route lookup: never normalize or decode a user-supplied filesystem path.
    const asset = routes.get(req.url);
    if (!asset) {res.writeHead(404);res.end('Not found');return;}
    res.setHeader('Content-Type',asset.contentType);
    if(asset.download)res.setHeader('Content-Disposition','attachment; filename="evidence.txt"');
    res.writeHead(200);res.end(asset.bytes);
  });
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [root,hash,portText='4965']=process.argv.slice(2), port=Number(portText);
  assert(Number.isInteger(port)&&port>0&&port<65536);
  const server=createPreviewServer(await loadSite(root,hash));
  server.listen(port,'127.0.0.1',()=>console.log(`Verified read-only preview http://127.0.0.1:${port}`));
}
