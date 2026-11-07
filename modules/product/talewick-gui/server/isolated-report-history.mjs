import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open, readdir} from 'node:fs/promises';
import path from 'node:path';
import {productManuscriptRevision} from './full15-service.mjs';

export const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
const fail = (message, status) => Object.assign(new Error(message), {status});
const mismatch = () => fail('报告与当前稿件版本不符，请切回评阅时的版本。', 409);

export function manuscriptBinding(title, chapters) {
  if (typeof title !== 'string' || !Array.isArray(chapters) || !chapters.length ||
      chapters.some(ch => !ch || ![ch.id, ch.title, ch.body].every(v => typeof v === 'string')) ||
      new Set(chapters.map(ch => ch.id)).size !== chapters.length) throw mismatch();
  const canonical = chapters.map(({id, title, body}) => ({id, title, body}));
  return {manuscriptRevision:productManuscriptRevision(title, chapters),
    manuscriptSHA256:bytesHash(JSON.stringify({title, chapters:canonical}))};
}

function projectPrefix(projectId) {
  if (typeof projectId !== 'string' || !/^[\w-]{1,160}$/.test(projectId)) throw fail('项目标识无效。', 400);
  return bytesHash(projectId) + '-';
}

export function receiptName(projectId, id) {
  if (!digestPattern.test(id)) throw fail('无效的报告标识。', 400);
  return projectPrefix(projectId) + id + '.json';
}

async function verifiedBytes(root, name, digest, maxBytes) {
  const file = await open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.size > maxBytes) throw fail('报告文件无效。', 409);
    const bytes = await file.readFile();
    if (bytesHash(bytes) !== digest) throw fail('报告档案已改变，已停止打开。', 409);
    return bytes;
  } finally { await file.close(); }
}

async function readReceipt(root, projectId, id) {
  const data = await verifiedBytes(root, receiptName(projectId, id), id, 32 * 1024);
  const row = JSON.parse(data);
  const date = typeof row?.createdAt === 'string' ? new Date(row.createdAt) : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString() !== row.createdAt ||
      row.schemaVersion !== 'workbench-isolated-report-1' || row.projectId !== projectId ||
      typeof row.title !== 'string' || typeof row.synthetic !== 'boolean' ||
      !['A','B'].includes(row.version) || !/^manuscript-v1-\d+-[a-f0-9]+-[a-f0-9]+$/.test(row.manuscriptRevision) ||
      ![row.planSHA256,row.htmlSHA256,row.manuscriptSHA256].every(v => typeof v === 'string' && digestPattern.test(v))) throw mismatch();
  return row;
}

export async function listReports(root, projectId) {
  const prefix = projectPrefix(projectId);
  const names = await readdir(root).catch(err => { if (err.code === 'ENOENT') return []; throw err; });
  const rows = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const id = name.slice(prefix.length, -5);
    if (!digestPattern.test(id)) continue;
    try {
      const {title, createdAt, manuscriptRevision, synthetic} = await readReceipt(root, projectId, id);
      rows.push({id, title, createdAt, manuscriptRevision, synthetic});
    } catch { /* Invalid receipts cannot authorize a history entry. Other rows remain usable. */ }
  }
  return rows.sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function isolatedReportRouter({root, bodyJSON, json}) {
  return async (req, res, url) => {
    if (url.pathname === '/api/isolated-reports' && req.method === 'GET') {
      json(res, 200, {reports:await listReports(root, url.searchParams.get('projectId'))});
      return true;
    }
    const match = /^\/api\/isolated-reports\/([a-f0-9]{64})\/open$/.exec(url.pathname);
    if (!match || req.method !== 'POST') return false;
    const body = await bodyJSON(req, 16 * 1024 * 1024);
    let html;
    try {
      const row = await readReceipt(root, body?.projectId, match[1]);
      const current = manuscriptBinding(body.title, body.chapters);
      if (current.manuscriptSHA256 !== row.manuscriptSHA256 || current.manuscriptRevision !== row.manuscriptRevision ||
          body.manuscriptRevision !== row.manuscriptRevision) throw mismatch();
      html = await verifiedBytes(root, row.htmlSHA256 + '.html', row.htmlSHA256, 32 * 1024 * 1024);
    } catch (err) {
      if (err.code === 'ENOENT') throw fail('当前项目找不到这份报告。', 404);
      throw err;
    }
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'"});
    res.end(html);
    return true;
  };
}
