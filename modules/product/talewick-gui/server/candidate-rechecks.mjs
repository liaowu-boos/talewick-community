import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { manuscriptFingerprint } from '../../../validation/runtime/checks.mjs';
import { CANDIDATE_RECHECK_VERSION, prepareCandidateRecheck, runCandidateRecheck, checkCandidateRecheckAdoption } from '../../../validation/runtime/candidate-recheck.mjs';

export const PRODUCT_RECHECK_VERSION = CANDIDATE_RECHECK_VERSION;
const idPattern = /^[\w-]{1,160}$/;
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const execFileAsync = promisify(execFile);

async function localJSON(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail('LOCAL_FILE_INVALID', '候选复查文件不是普通本地文件。');
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('/usr/bin/stat', ['-f', '%Sf', file]);
    if (stdout.trim().split(',').includes('dataless')) throw fail('LOCAL_FILE_WAIT', '候选复查文件仍是 iCloud 占位，原记录保持不变。');
  }
  return JSON.parse(await readFile(file, 'utf8'));
}

/** A separate, append-only queue. Only the server chooses input and model. */
export class CandidateRecheckService {
  constructor({ rootDir, tasks, model, runRecheck = runCandidateRecheck, checkAdoption = checkCandidateRecheckAdoption }) {
    this.rootDir = rootDir; this.tasks = tasks; this.model = model; this.runRecheck = runRecheck; this.checkAdoption = checkAdoption;
    this.records = new Map(); this.active = new Set(); this.writes = new Map(); this.runs = new Set(); this.closed = false;
  }
  async init() {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.rootDir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const record = await localJSON(path.join(this.rootDir, name));
      if (record.id !== name.slice(0, -5) || !idPattern.test(record.projectId) || !idPattern.test(record.sourceTaskId))
        throw fail('RECORD_BINDING_INVALID', '候选复查记录身份无效。');
      if (['queued', 'running'].includes(record.status)) {
        record.status = 'interrupted'; record.error = { code: 'PROCESS_INTERRUPTED', message: '复查运行中断；已保留现场，不自动重发。' };
        await this.save(record);
      }
      this.records.set(record.id, record);
    }
    return this;
  }
  source(projectId, sourceTaskId) {
    if (!idPattern.test(projectId) || !idPattern.test(sourceTaskId)) throw fail('INVALID_ID', '项目或来源任务身份无效。', 400);
    const task = this.tasks.get(sourceTaskId), request = this.tasks.requests.get(sourceTaskId);
    if (task.projectId !== projectId || task.status !== 'completed' || task.revisionMode !== 'whole-manuscript-v2'
      || task.result?.wholeRevision?.schemaVersion !== 'whole-manuscript-quality-1' || !Array.isArray(task.result.chapters)
      || request?.projectId !== projectId || request?.requestId !== task.requestId || request?.kind !== 'revise'
      || request?.revisionMode !== 'whole-manuscript-v2' || !Array.isArray(request.chapters))
      throw fail('SOURCE_TASK_MISMATCH', '来源任务不属于本项目的完整整稿候选。');
    return { task, request };
  }
  async save(record) {
    const target = path.join(this.rootDir, `${record.id}.json`), snapshot = structuredClone(record);
    const previous = this.writes.get(record.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    });
    this.writes.set(record.id, next);
    try { await next; } finally { if (this.writes.get(record.id) === next) this.writes.delete(record.id); }
  }
  project(record) {
    const source = (() => { try { return this.source(record.projectId, record.sourceTaskId).task; } catch { return null; } })();
    const bindingValid = source && record.candidateSha256 === manuscriptFingerprint(source.result.chapters)
      && record.checkerVersion === PRODUCT_RECHECK_VERSION && record.result?.binding?.sourceTaskId === record.sourceTaskId
      && record.result?.binding?.candidateSHA === record.candidateSha256;
    return { id: record.id, projectId: record.projectId, sourceTaskId: record.sourceTaskId,
      candidateSha256: record.candidateSha256, checkerVersion: record.checkerVersion,
      createdAt: record.createdAt, updatedAt: record.updatedAt, status: record.status,
      stage: record.stage, gate: { eligible: Boolean(bindingValid && record.status === 'reviewed_no_reported_conflict'), reason: bindingValid ? 'replay_required_on_selection' : 'stale_or_invalid_binding' },
      report: record.result?.crossChapterResult ?? null, error: record.error ?? null };
  }
  list(projectId) {
    if (!idPattern.test(projectId)) throw fail('INVALID_ID', '项目身份无效。', 400);
    return [...this.records.values()].filter(record => record.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(record => this.project(record));
  }
  async start(input = {}) {
    if (this.closed) throw fail('SERVICE_CLOSED', '候选复查服务正在关闭。', 503);
    if (!input || Object.keys(input).sort().join(',') !== 'projectId,sourceTaskId')
      throw fail('INPUT_FIELDS', '只接收 projectId 和 sourceTaskId；复查结论由服务端产生。', 400);
    const { task } = this.source(input.projectId, input.sourceTaskId);
    if (!this.model || typeof this.model.complete !== 'function') throw fail('MODEL_UNAVAILABLE', '候选复查模型尚未接通。', 503);
    const sameActive = [...this.records.values()].find(record => record.sourceTaskId === task.id && ['queued', 'running'].includes(record.status));
    if (sameActive) throw fail('RECHECK_ACTIVE', '这份候选已有复查任务在运行。');
    const timestamp = new Date().toISOString();
    const record = { id: randomUUID(), projectId: task.projectId, sourceTaskId: task.id,
      candidateSha256: manuscriptFingerprint(task.result.chapters), checkerVersion: PRODUCT_RECHECK_VERSION,
      createdAt: timestamp, updatedAt: timestamp, status: 'queued', stage: 'queued',
      prepared: prepareCandidateRecheck({ sourceTaskId: task.id, candidateChapters: task.result.chapters,
        priorFailureIds: task.result.wholeRevision?.status === 'candidate_ready_cross_check_incomplete' ? [task.id] : [] }),
      artifacts: {}, result: null, error: null };
    await this.save(record); this.records.set(record.id, record);
    const run = Promise.resolve().then(() => this.process(record.id));
    this.runs.add(run);
    void run.finally(() => this.runs.delete(run)).catch(() => {});
    return this.project(record);
  }
  async process(id) {
    const record = this.records.get(id);
    if (!record || this.active.has(id) || record.status !== 'queued') return;
    this.active.add(id);
    try {
      const { task } = this.source(record.projectId, record.sourceTaskId);
      if (record.candidateSha256 !== manuscriptFingerprint(task.result.chapters)) throw fail('STALE_CANDIDATE', '来源候选已经变化。');
      record.status = 'running'; record.stage = 'extract'; record.updatedAt = new Date().toISOString(); await this.save(record);
      const progress = async stage => { record.stage = typeof stage === 'string' ? stage : 'running'; record.updatedAt = new Date().toISOString(); await this.save(record); };
      const result = await this.runRecheck({ prepared: record.prepared, model: this.model,
        artifacts: { store: record.artifacts, checkpoint: async (key, value) => {
          await this.save({ ...record, artifacts: { ...record.artifacts, [key]: value }, stage: key, updatedAt: new Date().toISOString() });
          record.stage = key; record.updatedAt = new Date().toISOString();
        } }, onProgress: async value => progress(value?.stage) });
      if (result.binding?.sourceTaskId !== record.sourceTaskId || result.binding?.candidateSHA !== record.candidateSha256
        || !['failed', 'needs_attention', 'reviewed_no_reported_conflict'].includes(result.status))
        throw fail('RECHECK_REPORT_BINDING', '复查结果未绑定当前来源任务和完整候选。');
      record.result = result;
      record.status = result.status;
      record.stage = 'complete'; record.updatedAt = new Date().toISOString(); await this.save(record);
    } catch (error) {
      record.status = 'failed'; record.error = { code: typeof error?.code === 'string' ? error.code : 'RECHECK_FAILED', message: error?.message || '候选复查未完成。' };
      record.stage = 'failed'; record.updatedAt = new Date().toISOString(); await this.save(record);
    } finally { this.active.delete(id); }
  }
  async authorize(id, { projectId, sourceTaskId } = {}) {
    const record = this.records.get(id);
    if (!record || record.projectId !== projectId || record.sourceTaskId !== sourceTaskId)
      throw fail('RECHECK_NOT_FOUND', '找不到与本项目和来源任务绑定的复查。', 404);
    const { task } = this.source(projectId, sourceTaskId);
    if (record.checkerVersion !== PRODUCT_RECHECK_VERSION || record.candidateSha256 !== manuscriptFingerprint(task.result.chapters)
      || record.status !== 'reviewed_no_reported_conflict' || !record.result)
      throw fail('RECHECK_NOT_ELIGIBLE', '复查版本、候选哈希或事实状态不满足采纳条件。');
    const gate = await this.checkAdoption({ result: record.result, prepared: record.prepared, artifacts: record.artifacts,
      sourceTaskId, candidateChapters: task.result.chapters, checkerVersion: PRODUCT_RECHECK_VERSION });
    if (!gate.eligible) throw fail('RECHECK_REPLAY_FAILED', `复查原始记录未通过重放绑定：${gate.reason}`);
    return this.project(record);
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.runs]);
    await Promise.allSettled([...this.writes.values()]);
  }
}

export function createCandidateRecheckRouter({ service, json, bodyJSON, canRun }) {
  return async (req, res, url) => {
    if (url.pathname === '/api/candidate-rechecks') {
      if (req.method === 'GET') { json(res, 200, { available: true, checkerVersion: PRODUCT_RECHECK_VERSION, tasks: service.list(url.searchParams.get('projectId')) }); return true; }
      if (req.method === 'POST') {
        if (!canRun()) throw fail('MODEL_UNAVAILABLE', '本地模型尚未配置，候选复查没有启动。', 503);
        json(res, 202, { task: await service.start(await bodyJSON(req)) }); return true;
      }
    }
    const match = url.pathname.match(/^\/api\/candidate-rechecks\/([a-f0-9-]{36})\/authorize$/);
    if (match && req.method === 'POST') { json(res, 200, { task: await service.authorize(match[1], await bodyJSON(req)) }); return true; }
    return false;
  };
}
