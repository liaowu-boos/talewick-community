import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, writeFile, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const now = () => new Date().toISOString();
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const validId = value => typeof value === 'string' && /^[\w-]{1,160}$/.test(value);
const active = new Set(['queued', 'running']);
const execFileAsync = promisify(execFile);
export const FULL15_LOCAL_FILE_WAIT = '辅助检查任务文件正在等待下载。原任务、正文与已有报告保持不变。';

export async function full15FileState(file) {
  try {
    const info = await lstat(file); if (!info.isFile()) return { available: false, reason: 'not_file' };
    if (process.platform !== 'darwin') return { available: true };
    const { stdout } = await execFileAsync('/usr/bin/stat', ['-f', '%Sf', file], { encoding: 'utf8' });
    const flags = String(stdout).trim().split(',').map(value => value.trim()).filter(Boolean);
    return flags.includes('dataless') ? { available: false, reason: 'dataless' } : { available: true };
  } catch (error) { if (error?.code === 'ENOENT') return { available: false, reason: 'missing' }; throw error; }
}

export function projectFull15Failure(error, cancelled = false) {
  if (cancelled) return { code: 'cancelled', message: '辅助检查已取消；稿件和已有检查材料不受影响。', recoverable: false };
  if (error?.code === 'provider_output_length_limit' && error.providerResponseComplete === true) return {
    code: error.code,
    message: '模型已完整返回本次调用的长度上限终态，但没有形成可保存的检查结果；现场和调用收据已保留，不会自动重发。',
    recoverable: false,
  };
  return { code: error?.code || 'provider_outcome_unknown', message: '辅助检查未取得确定结果；现场已保留，可新建一次重新检查。', recoverable: false };
}

export function manuscriptText(title, chapters) {
  if (typeof title !== 'string' || !Array.isArray(chapters) || !chapters.length || chapters.length > 30
    || /[\r\n]/.test(title)
    || chapters.some(c => !c || typeof c.id !== 'string' || typeof c.title !== 'string' || /[\r\n]/.test(c.title) || typeof c.body !== 'string' || !c.body.trim())) throw fail('INVALID_MANUSCRIPT', '请先保存一份完整可读的稿件。');
  const withoutNumber = chapterTitle => chapterTitle.trim().replace(
    /^第\s*[0-9０-９零〇一二两三四五六七八九十百千]+\s*章(?:\s*[：:、.．—-]\s*|\s+|$)/,
    '',
  ).trim();
  const sections = chapters.map((chapter, index) => {
    const name = withoutNumber(chapter.title);
    return `第${index + 1}章${name ? `：${name}` : ''}\n${chapter.body}`;
  });
  return `书名：${title || '未命名作品'}\n\n${sections.join('\n\n')}\n`;
}

export function productManuscriptRevision(title, chapters) {
  const source = JSON.stringify({ title, chapters }); let first = 2166136261, second = 5381;
  for (let i = 0; i < source.length; i++) { first = Math.imul(first ^ source.charCodeAt(i), 16777619); second = Math.imul(second, 33) ^ source.charCodeAt(i); }
  return `manuscript-v1-${source.length}-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
}

/** Product-owned queue/index around the validation adapter. Adapter runs remain immutable. */
export class Full15Service {
  constructor({ rootDir, adapter, analyze, inputForManuscript, taskFileState = full15FileState, taskFileRead = readFile }) {
    this.rootDir = rootDir; this.adapter = adapter; this.analyze = analyze; this.inputForManuscript = inputForManuscript;
    this.taskFileState = taskFileState; this.taskFileRead = taskFileRead; this.waitingFiles = new Map();
    this.tasks = new Map(); this.controllers = new Map(); this.busy = false; this.closed = false; this.mutations = Promise.resolve(); this.writes = new Map();
  }
  async loadStored(id, file) {
    const state = await this.taskFileState(file);
    if (!state.available) { if (state.reason === 'dataless') this.waitingFiles.set(id, file); return false; }
    const task = JSON.parse(await this.taskFileRead(file, 'utf8'));
    if (!validId(task.id) || task.id !== id || !validId(task.projectId)) throw new Error('invalid full15 task');
    if (active.has(task.status)) {
      task.status = task.runDir ? 'queued' : 'needs_attention';
      task.error = task.runDir ? null : { code: 'provider_outcome_unknown', message: '辅助检查在运行目录落盘前中断；不会自动重发，请新建一次重新检查。', recoverable: false };
      task.updatedAt = now(); await this.save(task);
    }
    this.tasks.set(task.id, task); this.waitingFiles.delete(id); return true;
  }
  async refreshWaiting() {
    for (const [id, file] of [...this.waitingFiles]) { try { await this.loadStored(id, file); } catch { throw fail('LOCAL_FILE_BINDING_INVALID', '辅助检查任务文件已下载，但绑定校验未通过；原文件保持不变。', 409); } }
  }
  async init() {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    // This directory is server configuration, never a browser-supplied path.
    // Resolve system aliases such as /tmp before passing the trusted run root.
    this.rootDir = await realpath(this.rootDir);
    for (const name of await readdir(this.rootDir).catch(() => [])) if (/^[a-f0-9-]{36}\.json$/.test(name)) try { await this.loadStored(name.slice(0, -5), path.join(this.rootDir, name)); } catch {}
    this.schedule(); return this;
  }
  available() { return Boolean(this.adapter && this.analyze && this.inputForManuscript && typeof this.adapter.getFull15Versions === 'function'); }
  async versions() { return this.available() ? this.adapter.getFull15Versions() : null; }
  project(task) {
    const copy = structuredClone(task);
    delete copy.frozen; delete copy.result; delete copy.runDir; delete copy.manuscriptSha256;
    delete copy.rulesVersion; delete copy.toolVersion; delete copy.inputVersion;
    if (copy.report) { delete copy.report.path; delete copy.report.sha256; }
    return copy;
  }
  list(projectId) { return [...this.tasks.values()].filter(t => !projectId || t.projectId === projectId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(t => this.project(t)); }
  get(id) { const task = this.tasks.get(id); if (!task) { if (this.waitingFiles.has(id)) throw fail('LOCAL_FILE_WAIT', FULL15_LOCAL_FILE_WAIT, 409); throw fail('NOT_FOUND', '找不到这次辅助检查。', 404); } return this.project(task); }
  async save(task) {
    const target = path.join(this.rootDir, `${task.id}.json`), temp = `${target}.${randomUUID()}.tmp`, snapshot = structuredClone(task);
    const pending=(this.writes.get(task.id)||Promise.resolve()).catch(()=>{}).then(async()=>{await writeFile(temp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 }); await rename(temp, target);});
    this.writes.set(task.id,pending);try{await pending;}finally{if(this.writes.get(task.id)===pending)this.writes.delete(task.id);}
  }
  mutate(fn) { const next=this.mutations.then(fn); this.mutations=next.catch(()=>{}); return next; }
  async reportFor(result) {
    const report = structuredClone(result.report);
    if (!report || typeof report.path !== 'string' || typeof result.runDir !== 'string') return report;
    const reportPath = path.resolve(report.path), runDir = path.resolve(result.runDir);
    if (reportPath !== path.join(runDir, 'report.json')) return report;
    try {
      const raw = await readFile(reportPath);
      if (typeof report.sha256 === 'string' && createHash('sha256').update(raw).digest('hex') !== report.sha256) return report;
      const body = JSON.parse(raw.toString('utf8'));
      if (Array.isArray(body.checks) || (body.checks && typeof body.checks === 'object')) report.checks = body.checks;
      if (Array.isArray(body.issues)) report.issues = body.issues;
      if (Array.isArray(body.priority_issue_ids)) report.priorityIssueIds = body.priority_issue_ids;
      if (Array.isArray(body.limitations)) report.limitations = body.limitations;
    } catch {}
    return report;
  }
  start(input, options = {}) { return this.mutate(() => this.startTask(input, options)); }
  async startTask(input, { trigger = 'manual', linkedAttemptId, sourceTaskId, configuredInput } = {}) {
    if (!this.available()) throw fail('FULL15_UNAVAILABLE', '辅助检查适配器或真实模型调用收据尚未接通。', 503);
    await this.refreshWaiting();
    if (this.waitingFiles.size) throw fail('LOCAL_FILE_WAIT', FULL15_LOCAL_FILE_WAIT, 409);
    if (!validId(input?.projectId) || !validId(input?.requestId) || typeof input.manuscriptRevision !== 'string' || input.manuscriptRevision.length > 256) throw fail('INVALID_REQUEST', '辅助检查请求与稿件版本无效。');
    if (input.sourceTaskId !== undefined && !validId(input.sourceTaskId)) throw fail('INVALID_REQUEST', '关联创作任务标识无效。');
    if (input.selection !== undefined && (!Array.isArray(input.selection) || input.selection.length > 100 || input.selection.some(value => !validId(value)) || new Set(input.selection).size !== input.selection.length)) throw fail('INVALID_REQUEST', '关联采纳组选择无效。');
    const expectedRevision = productManuscriptRevision(input.title, input.chapters);
    if (input.manuscriptRevision !== expectedRevision) throw fail('MANUSCRIPT_VERSION_MISMATCH', '提交的稿件版本与正文不一致，请保存当前版本后重试。', 409);
    const duplicate = [...this.tasks.values()].find(t => t.projectId === input.projectId && t.requestId === input.requestId);
    if (duplicate) {
      if (duplicate.manuscriptRevision !== input.manuscriptRevision) throw fail('REQUEST_CONFLICT', '同一检查请求标识对应了不同稿件。', 409);
      return this.project(duplicate);
    }
    if (sourceTaskId) {
      const existing = [...this.tasks.values()].find(t => t.sourceTaskId === sourceTaskId);
      if (existing) return this.project(existing);
    }
    const sameActive = [...this.tasks.values()].find(t => t.projectId === input.projectId && t.manuscriptRevision === input.manuscriptRevision && active.has(t.status));
    if (sameActive) return this.project(sameActive);
    const text = manuscriptText(input.title, input.chapters), manuscriptSha256 = sha(text);
    const linkedSourceTaskId = validId(input.sourceTaskId) ? input.sourceTaskId : undefined;
    const configured = configuredInput ?? await this.inputForManuscript({ projectId: input.projectId, title: input.title, chapters: structuredClone(input.chapters), text, manuscriptSha256, ...(linkedSourceTaskId ? { sourceTaskId: linkedSourceTaskId } : {}), ...(input.selection !== undefined ? { selection: [...input.selection] } : {}) });
    if (!configured?.requirements || !configured?.references || !['standard','no_corpus'].includes(configured.profile)) throw fail('FULL15_INPUT_UNAVAILABLE', '这份稿件尚未取得明确的检查规格与参考范围。', 409);
    const task = { id: randomUUID(), projectId: input.projectId, requestId: input.requestId, trigger, ...(linkedAttemptId ? { linkedAttemptId } : {}), ...(sourceTaskId ? { sourceTaskId } : {}), ...(linkedSourceTaskId ? { linkedSourceTaskId } : {}), ...(input.selection !== undefined ? { linkedSelection: [...input.selection] } : {}), status: 'queued', manuscriptRevision: input.manuscriptRevision, manuscriptSha256, createdAt: now(), updatedAt: now(), progress: { phase: 'queued', completedChunks: 0, totalChunks: 0, completedStages: 0 }, report: null, error: null,
      frozen: { manuscript: { text, sha256: manuscriptSha256 }, requirements: structuredClone(configured.requirements), references: structuredClone(configured.references), profile: configured.profile } };
    this.tasks.set(task.id, task); await this.save(task); this.schedule(); return this.project(task);
  }
  schedule() { setImmediate(() => { void this.pump(); }); }
  async pump() {
    if (this.busy || this.closed) return;
    const task = [...this.tasks.values()].find(t => t.status === 'queued'); if (!task) return;
    this.busy = true; const controller = new AbortController(); this.controllers.set(task.id, controller);
    task.status = 'running'; task.updatedAt = now(); await this.save(task);
    try {
      const runRoot = path.join(this.rootDir, 'runs'); await mkdir(runRoot,{recursive:true,mode:0o700});
      const before = new Set(await readdir(runRoot));
      const capture = async () => {
        if (task.runDir) return;
        for (const name of (await readdir(runRoot)).filter(name=>!before.has(name)&&/^full15-task-/.test(name))) try {
          const metadata=JSON.parse(await readFile(path.join(runRoot,name,'task.json'),'utf8'));
          if (metadata.manuscriptSha256!==task.manuscriptSha256) continue;
          task.runDir=metadata.runDir;task.rulesVersion=metadata.rulesVersion;task.toolVersion=metadata.toolVersion;task.inputVersion=metadata.inputVersion;task.updatedAt=now();await this.save(task);return;
        } catch {}
      };
      const tracker = task.runDir ? null : setInterval(()=>{void capture();},10);
      let result;
      try {
        const progress = async event => {
          task.progress = { ...task.progress, phase: event.type || task.progress.phase };
          if (event.type === 'prepared' || event.type === 'check_prepared') task.progress.totalChunks += Number(event.chunkCount || 0);
          if (event.type === 'stage_saved') { task.progress.completedStages += 1; task.progress.completedChunks += Number(event.chunkCount || 0); }
          task.updatedAt = now(); await this.save(task);
        };
        result = task.runDir ? await this.adapter.resumeFull15Review({ runDir: task.runDir, manuscriptSha256: task.manuscriptSha256, rulesVersion: task.rulesVersion, inputVersion: task.inputVersion, analyze: this.analyze, signal: controller.signal, onProgress: progress })
          : await this.adapter.startFull15Review({ runRoot, ...structuredClone(task.frozen), analyze: this.analyze, signal: controller.signal, onProgress: progress });
      } finally { if(tracker)clearInterval(tracker);await capture(); }
      if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      task.status = result.status; task.result = result; task.progress = result.progress; task.report = await this.reportFor(result); task.error = result.error; task.rulesVersion = result.rulesVersion; task.toolVersion = result.toolVersion; task.runDir = result.runDir;
    } catch (error) {
      task.status = controller.signal.aborted ? 'cancelled' : 'needs_attention';
      task.error = projectFull15Failure(error, controller.signal.aborted);
    } finally { task.updatedAt = now(); await this.save(task); this.controllers.delete(task.id); this.busy = false; this.schedule(); }
  }
  async cancel(id) { const task = this.tasks.get(id); this.get(id); if (active.has(task.status)) { task.status = 'cancelled'; task.error = { code: 'cancelled', message: '辅助检查已取消；稿件和已有检查材料不受影响。', recoverable: false }; task.updatedAt = now(); await this.save(task); this.controllers.get(id)?.abort(); } return this.get(id); }
  retry(id) { return this.mutate(() => this.retryTask(id)); }
  async retryTask(id) {
    if (!this.available()) throw fail('FULL15_UNAVAILABLE', '辅助检查适配器或真实模型调用收据尚未接通。', 503);
    if (this.waitingFiles.has(id)) { await this.refreshWaiting(); if (this.waitingFiles.has(id)) throw fail('LOCAL_FILE_WAIT', FULL15_LOCAL_FILE_WAIT, 409); }
    const old = this.tasks.get(id); this.get(id);
    if (active.has(old.status)) throw fail('TASK_ACTIVE', '这次辅助检查仍在运行。', 409);
    if (old.status === 'interrupted' && old.runDir) {
      old.status = 'queued'; old.error = null; old.report = null;
      old.progress = { ...old.progress, phase: 'queued' }; old.updatedAt = now();
      await this.save(old); this.schedule(); return this.project(old);
    }
    const task = { id: randomUUID(), projectId: old.projectId, requestId: `retry-${randomUUID()}`, trigger: 'retry', linkedAttemptId: old.id, status: 'queued', manuscriptRevision: old.manuscriptRevision, manuscriptSha256: old.manuscriptSha256, createdAt: now(), updatedAt: now(), progress: { phase: 'queued', completedChunks: 0, totalChunks: 0, completedStages: 0 }, report: null, error: null, frozen: structuredClone(old.frozen) };
    this.tasks.set(task.id, task); await this.save(task); this.schedule(); return this.project(task);
  }
  async close() { this.closed = true; for (const controller of this.controllers.values()) controller.abort(); while (this.busy) await new Promise(resolve => setTimeout(resolve, 5)); await Promise.allSettled(this.writes.values()); }
}

export function createFull15Router({ service, json, bodyJSON }) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/full15')) return false;
    if (url.pathname === '/api/full15' && req.method === 'GET') { json(res, 200, { available: service.available(), versions: await service.versions(), tasks: service.list(url.searchParams.get('projectId')) }); return true; }
    if (url.pathname === '/api/full15' && req.method === 'POST') { json(res, 202, { task: await service.start(await bodyJSON(req)) }); return true; }
    const match = url.pathname.match(/^\/api\/full15\/([a-f0-9-]{36})(?:\/(cancel|retry))?$/);
    if (match && req.method === 'GET' && !match[2]) { json(res, 200, { task: service.get(match[1]) }); return true; }
    if (match && req.method === 'POST' && match[2]) { await bodyJSON(req); json(res, match[2] === 'retry' ? 202 : 200, { task: await service[match[2]](match[1]) }); return true; }
    throw fail('METHOD_NOT_ALLOWED', '这个辅助检查入口不支持当前操作。', 405);
  };
}
