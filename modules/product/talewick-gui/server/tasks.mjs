import { mkdir, readFile, readdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { engineBinding } from './engines.mjs';
import { projectReviewAdjudication } from './service-public.mjs';
import { assertWorkflowResultReady } from './workflow-result-gate.mjs';
import { projectCodexAttempt } from './model.mjs';
import { cancelledFailure, classifyTaskFailure, interruptedFailure } from './task-failure.mjs';

const active = new Set(['queued', 'running']);
const recoverable = new Set(['failed', 'interrupted', 'cancelled']);
export const CREATE_STATE_REVIEW_MODE = 'create-state-review-v1';
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Read-only saved draft projection; never a reviewed result or a resume operation. */
export function projectPartialDraft(task, artifacts) {
  if (!recoverable.has(task.status) || task.kind !== 'create' || task.result || !record(artifacts)) return undefined;
  // Agent drafting uses the controlled plan, so an invalid controlled checkpoint must not fall back.
  const plan = Object.hasOwn(artifacts, 'agentPlan') ? artifacts.agentPlan?.plan : task.engine === 'ai-sdk' ? undefined : artifacts.plan;
  if (!record(plan) || !Array.isArray(plan.chapters) || !plan.chapters.length || plan.chapters.length > 30) return undefined;
  const ids = new Set();
  for (const chapter of plan.chapters) {
    if (!record(chapter) || typeof chapter.id !== 'string' || !chapter.id.trim() || ids.has(chapter.id) || typeof chapter.title !== 'string' || !chapter.title.trim()) return undefined;
    ids.add(chapter.id);
  }
  // A saved final candidate can be newer than draft checkpoints (e.g. review or
  // result validation failed after a bounded revision). Show its exact text as
  // unreviewed; a malformed final checkpoint must not fall back to an older draft.
  if (Object.hasOwn(artifacts, 'result')) {
    const candidate = artifacts.result?.chapters;
    if (!Array.isArray(candidate) || candidate.length !== plan.chapters.length || candidate.some((chapter, index) =>
      !record(chapter) || chapter.id !== plan.chapters[index].id || chapter.title !== plan.chapters[index].title || typeof chapter.body !== 'string' || !chapter.body.trim())) return undefined;
    return { status: 'unreviewed_partial', chapters: candidate.map(({ id, title, body }) => ({ id, title, body })), availableChapterCount: candidate.length, expectedChapterCount: plan.chapters.length };
  }
  const chapters = plan.chapters.flatMap(planned => {
    const draft = artifacts[`draft:${planned.id}`];
    if (!record(draft) || draft.id !== planned.id || draft.title !== planned.title || typeof draft.body !== 'string' || !draft.body.trim()) return [];
    return [{ id: draft.id, title: draft.title, body: draft.body }];
  });
  return chapters.length ? { status: 'unreviewed_partial', chapters, availableChapterCount: chapters.length, expectedChapterCount: plan.chapters.length } : undefined;
}

/** Validate only this version's public task input; arbitrary paths are never accepted. */
export function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('创作请求格式不正确。');
  for (const key of ['projectId', 'requestId']) if (typeof body[key] !== 'string' || !/^[\w-]{1,160}$/.test(body[key])) throw fail('任务标识无效，请重新提交。');
  if (!['create', 'revise'].includes(body.kind)) throw fail('当前入口支持一键成稿与稿件修改。');
  if (typeof body.idea !== 'string' || !body.idea.trim() || body.idea.length > 12000) throw fail('请提供不超过 12000 字符的创作要求。');
  if (typeof body.baseRevision !== 'string' || body.baseRevision.length > 200000) throw fail('缺少本次稿件版本。');
  if (body.projectTitle !== undefined && (typeof body.projectTitle !== 'string' || body.projectTitle.length > 2000)) throw fail('作品标题过长或格式不正确。');
  const materials = body.materials ?? [];
  if (!Array.isArray(materials) || materials.length > 30 || materials.some(m => !m || typeof m.content !== 'string' || m.content.length > 100000 || typeof m.title !== 'string')) throw fail('参考材料过多或格式不正确，请减少本次选取的材料。');
  const context = body.context ?? {};
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.values(context).some(v => typeof v !== 'string' || v.length > 12000)) throw fail('创作背景格式不正确。');
  const style = body.style ?? null;
  if (style !== null && (typeof style !== 'object' || Array.isArray(style) || JSON.stringify(style).length > 20000)) throw fail('风格内容过长或格式不正确。');
  const chapters = body.chapters ?? [];
  if (!Array.isArray(chapters) || chapters.length > 30 || chapters.some(c => !c || typeof c.id !== 'string' || typeof c.title !== 'string' || typeof c.body !== 'string' || c.body.length > 100000)) throw fail('稿件章节格式不正确。');
  if (new Set(chapters.map(c => c.id)).size !== chapters.length) throw fail('稿件存在重复章节标识。');
  if (body.kind === 'revise' && (!chapters.length || typeof body.instruction !== 'string' || !body.instruction.trim())) throw fail('修改任务需要原稿和明确的修改要求。');
  if ((body.instruction !== undefined && typeof body.instruction !== 'string') || (body.quote !== undefined && typeof body.quote !== 'string')) throw fail('修改要求和选段必须是文字。');
  if ((body.instruction?.length ?? 0) > 12000 || (body.quote?.length ?? 0) > 100000) throw fail('修改要求或选段过长。');
  let quoteSource;
  if (body.quoteSource !== undefined) {
    const source = body.quoteSource;
    if (body.kind !== 'revise' || !body.quote || !source || typeof source !== 'object' || Array.isArray(source) || typeof source.chapterId !== 'string' || !Number.isSafeInteger(source.start) || source.start < 0) throw fail('选段位置无效，请重新选择要修改的原文。');
    const chapter = chapters.find(item => item.id === source.chapterId);
    if (!chapter || chapter.body.slice(source.start, source.start + body.quote.length) !== body.quote) throw fail('选段与本次稿件不一致，请重新选择原文后提交。');
    quoteSource = { chapterId: source.chapterId, start: source.start };
  }
  return { projectId: body.projectId, requestId: body.requestId, kind: body.kind, idea: body.idea, context, materials, style, chapters, instruction: body.instruction ?? '', quote: body.quote ?? '', baseRevision: body.baseRevision, ...(body.projectTitle !== undefined ? { projectTitle: body.projectTitle } : {}), ...(quoteSource ? { quoteSource } : {}) };
}

/** File-backed sequential task runner; each successful stage is saved for recovery. */
export class TaskService {
  constructor({ runsDir, model, workflow, engine = 'fixed', onCompleted }) {
    this.runsDir = runsDir; this.model = model; this.workflow = workflow;
    this.defaultEngine = engineBinding(engine); this.onCompleted = onCompleted;
    this.tasks = new Map(); this.requests = new Map(); this.artifacts = new Map(); this.controller = null; this.busy = false; this.closing = false;
    this.mutations = Promise.resolve(); this.writes = new Map();
  }
  async init() {
    await mkdir(this.runsDir, { recursive: true, mode: 0o700 });
    await this.acquireOwnership();
    for (const entry of await readdir(this.runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      try {
        const folder = path.join(this.runsDir, entry.name);
        const task = JSON.parse(await readFile(path.join(folder, 'task.json'), 'utf8'));
        if (task.engine === undefined && task.engineVersion === undefined) Object.assign(task, { engine: 'fixed', engineVersion: 'fixed-workflow-1' });
        const request = validateRequest(JSON.parse(await readFile(path.join(folder, 'request.json'), 'utf8')));
        if (task.id !== entry.name || task.projectId !== request.projectId || task.requestId !== request.requestId) throw new Error('invalid task');
        const artifacts = JSON.parse(await readFile(path.join(folder, 'artifacts.json'), 'utf8'));
        this.tasks.set(task.id, task); this.requests.set(task.id, request); this.artifacts.set(task.id, artifacts);
        if (active.has(task.status)) { task.status = 'interrupted'; task.failure = interruptedFailure('上次运行中断。已完成步骤已保存；可以继续未完成步骤。'); task.error = task.failure.message; task.updatedAt = now(); await this.save(task); }
      } catch { console.warn(`未载入不完整的本地任务目录：${entry.name}。原文件已保留。`); }
    }
    return this;
  }
  async acquireOwnership() {
    const folder = path.join(this.runsDir, '.runtime-owners');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const name = `${process.pid}-${randomUUID()}`;
    this.ownerFile = path.join(folder, name);
    await writeFile(this.ownerFile, now(), { flag: 'wx', mode: 0o600 });
    try {
      // 每个实例先登记自己再检查其他存活实例；同时启动时最多一个能接管。
      // 崩溃留下的死亡进程标记被忽略，不删除其他实例的标记，避免抢锁竞态。
      for (const entry of await readdir(folder)) {
        const match = entry.match(/^(\d+)-[a-f0-9-]{36}$/);
        if (!match || entry === name) continue;
        let alive = true;
        try { process.kill(Number(match[1]), 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (alive) throw fail('该任务目录已有创作服务在使用，请使用已启动的服务。', 409);
      }
    } catch (error) { await unlink(this.ownerFile).catch(() => {}); this.ownerFile = null; throw error; }
  }
  async write(id, name, value) {
    const folder = path.join(this.runsDir, id);
    const temp = path.join(folder, `.${name}.${randomUUID()}.tmp`);
    const text = JSON.stringify(value, null, 2) + '\n';
    const key = `${id}/${name}`;
    const pending = (this.writes.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      await writeFile(temp, text, { mode: 0o600 });
      await rename(temp, path.join(folder, name));
    });
    this.writes.set(key, pending);
    try { await pending; } finally { if (this.writes.get(key) === pending) this.writes.delete(key); }
  }
  async save(task) { await this.write(task.id, 'task.json', task); }
  get(id) { const task = this.tasks.get(id); if (!task) throw fail('找不到这次任务，原有浏览器稿件仍可编辑和导出。', 404); const projected = structuredClone(task); delete projected.partialDraft; delete projected.createStateReviewMode; const partialDraft = projectPartialDraft(task, this.artifacts.get(id)); if (partialDraft) projected.partialDraft = partialDraft; if (projected.result?.chapters && projected.result?.review) projected.result.reviewAdjudicationBinding = projectReviewAdjudication(projected.result); return projected; }
  list(projectId) { return [...this.tasks.values()].filter(t => !projectId || t.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(t => this.get(t.id)); }
  ensureIdleProject(projectId, except) { if ([...this.tasks.values()].some(t => t.id !== except && t.projectId === projectId && active.has(t.status))) throw fail('这个项目已有任务正在运行，请等待或取消后再提交。', 409); }
  mutate(fn) { const next = this.mutations.then(fn); this.mutations = next.catch(() => {}); return next; }
  create(input) { return this.mutate(() => this.createTask(input)); }
  async createTask(input) {
    if (this.closing) throw fail('服务正在停止，请稍后重试。', 503);
    const request = validateRequest(input);
    const previous = [...this.tasks.values()].find(t => t.projectId === request.projectId && t.requestId === request.requestId);
    if (previous) {
      if (digest(this.requests.get(previous.id)) !== digest(request)) throw fail('这次请求标识对应的内容已经改变，请创建新请求。', 409);
      return this.get(previous.id);
    }
    this.ensureIdleProject(request.projectId);
    const task = { id: randomUUID(), projectId: request.projectId, requestId: request.requestId, kind: request.kind, ...this.defaultEngine, status: 'queued', stage: '等待开始', createdAt: now(), updatedAt: now(), baseRevision: request.baseRevision,
      ...(request.kind === 'create' && this.defaultEngine.engine === 'ai-sdk' ? { createStateReviewMode: CREATE_STATE_REVIEW_MODE } : {}) };
    await mkdir(path.join(this.runsDir, task.id), { mode: 0o700 });
    await this.write(task.id, 'request.json', request); await this.write(task.id, 'artifacts.json', {}); await this.save(task);
    this.requests.set(task.id, request); this.artifacts.set(task.id, {}); this.tasks.set(task.id, task);
    this.schedule(); return this.get(task.id);
  }
  schedule() { setImmediate(() => { void this.pump().catch(() => console.error('本地任务保存失败，请检查目录写入权限后重启服务。')); }); }
  async pump() {
    if (this.busy || this.closing) return;
    const task = [...this.tasks.values()].find(t => t.status === 'queued');
    if (!task) return;
    this.busy = true; this.controller = { id: task.id, abort: new AbortController() };
    const signal = this.controller.abort.signal;
    task.status = 'running'; task.stage = '整理需求'; task.updatedAt = now(); delete task.error; delete task.failure; delete task.question;
    try {
      await this.save(task);
      const checkpoint = async (key, value) => {
        signal.throwIfAborted();
        const artifacts = { ...this.artifacts.get(task.id), [key]: structuredClone(value) };
        await this.write(task.id, 'artifacts.json', artifacts);
        this.artifacts.set(task.id, artifacts);
        if (key === 'requestSpec' && task.createStateReviewMode !== undefined) {
          if (value?.createStateReviewMode !== task.createStateReviewMode) throw new Error('新建任务的全文状态审阅模式未写入请求规格，已停止本次任务。');
          delete task.createStateReviewMode;
        }
        signal.throwIfAborted();
        if (!key.startsWith('agent:')) task.stage = key;
        task.updatedAt = now(); await this.save(task);
      };
      const model = { complete: async args => {
        signal.throwIfAborted(); task.stage = args.stage || task.stage; task.updatedAt = now(); await this.save(task);
        return this.model.complete({ ...args, signal, onAttempt: async metrics => {
          signal.throwIfAborted();
          const entry = { at: now(), stage: args.stage, mode: metrics.mode === 'recovery' ? 'recovery' : 'primary', hasReasoning: metrics.hasReasoning === true };
          if (typeof metrics.requestedModel === 'string') entry.requestedModel = metrics.requestedModel;
          if (args.stage === 'library-relevance' && metrics.provider === 'codex-cli') {
            Object.assign(entry, projectCodexAttempt(metrics, { requestedModel: 'gpt-6.1-sol', effort: 'high',
              status: metrics.status === 'completed' ? 'completed' : 'rejected' }));
          }
          for (const key of ['attempt', 'maxOutputTokens', 'contentCharacters', 'elapsedMs']) if (Number.isSafeInteger(metrics[key]) && metrics[key] >= 0) entry[key] = metrics[key];
          if (['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource'].includes(metrics.finishReason)) entry.finishReason = metrics.finishReason;
          task.modelAttempts = [...(task.modelAttempts ?? []).slice(-127), entry];
          task.updatedAt = now(); await this.save(task);
        } });
      } };
      const binding = engineBinding(task.engine, task.engineVersion);
      const progress = async stage => { signal.throwIfAborted(); task.stage = stage; task.updatedAt = now(); await this.save(task); };
      const saved = this.artifacts.get(task.id), hasRequestSpec = Object.hasOwn(saved, 'requestSpec');
      const persistedMode = saved.requestSpec?.createStateReviewMode;
      if (task.kind === 'create' && hasRequestSpec && persistedMode !== undefined && persistedMode !== CREATE_STATE_REVIEW_MODE) throw new Error('任务保存的全文状态审阅模式未知，未继续执行。');
      const createStateReviewMode = task.kind === 'create' && (hasRequestSpec ? persistedMode : task.createStateReviewMode);
      const result = await this.workflow({ request: structuredClone(this.requests.get(task.id)), model, artifacts: structuredClone(saved), checkpoint, signal, progress,
        ...(createStateReviewMode ? { createStateReviewMode } : {}), ...binding });
      signal.throwIfAborted();
      if (!Array.isArray(result?.chapters) || !result.chapters.length || result.chapters.some(c => !c.id || !c.title || !c.body?.trim())) throw new Error('创作没有产出完整可读取的章节，本次未标记完成。');
      try { assertWorkflowResultReady(result, this.artifacts.get(task.id)?.requestSpec); }
      catch (error) {
        // Preserve the actual returned manuscript separately; it is not a completed result.
        await this.write(task.id, 'unverified-result.json', result);
        throw error;
      }
      result.review = { ...result.review, summary: typeof result.review?.summary === 'string' ? result.review.summary : '本次没有可用的语义复核摘要。' };
      result.warnings = Array.isArray(result.warnings) ? result.warnings : [];
      await this.write(task.id, 'result.json', result);
      const text = `${result.title || '完整小说'}\n\n${result.chapters.map(c => `${c.title}\n\n${c.body}`).join('\n\n')}\n`;
      // TXT 同样保存到本次任务目录；浏览器仍可继续编辑并导出后续版本。
      await writeFile(path.join(this.runsDir, task.id, 'manuscript.txt'), text, { mode: 0o600 });
      signal.throwIfAborted();
      task.result = result; task.status = 'completed'; task.stage = '创作完成'; task.updatedAt = now(); await this.save(task);
      // Queue auxiliary work after the durable completion write. It must not delay
      // manuscript readability or turn a saved creation into a failed task.
      void Promise.resolve().then(() => this.onCompleted?.(this.get(task.id), structuredClone(this.requests.get(task.id)), structuredClone(this.artifacts.get(task.id)))).catch(() => {});
    } catch (error) {
      if (task.status !== 'cancelled') {
        if (!this.closing && error.code === 'INPUT_REQUIRED') {
          task.status = 'needs_input'; task.stage = '等待补充创作要求';
          task.question = error.message || '请补充创作要求后再发送。'; delete task.error; delete task.result;
        } else {
          task.status = this.closing ? 'interrupted' : 'failed';
          task.failure = this.closing ? interruptedFailure('服务已停止。已完成步骤已保存；可以继续未完成步骤。') : classifyTaskFailure(error, task.stage);
          task.error = task.failure.message;
        }
        task.updatedAt = now(); await this.save(task);
      }
    } finally { this.controller = null; this.busy = false; if (!this.closing) this.schedule(); }
  }
  resume(id) { return this.mutate(() => this.resumeTask(id)); }
  async resumeTask(id) {
    if (this.closing) throw fail('服务正在停止，请稍后重试。', 503);
    const task = this.tasks.get(id); this.get(id);
    engineBinding(task.engine, task.engineVersion);
    if (task.status === 'needs_input') throw fail('请在输入框补充创作要求并发送，不能直接重试缺少要求的原任务。', 409);
    if (!recoverable.has(task.status)) throw fail('只有失败、中断或取消的任务可以继续。', 409);
    if (this.controller?.id === id) throw fail('任务正在结束当前调用，请稍后继续。', 409);
    this.ensureIdleProject(task.projectId, task.id);
    task.status = 'queued'; task.updatedAt = now(); delete task.error; delete task.failure; await this.save(task); this.schedule(); return this.get(id);
  }
  cancel(id) { return this.mutate(() => this.cancelTask(id)); }
  async cancelTask(id) {
    const task = this.tasks.get(id); this.get(id);
    if (!active.has(task.status)) return this.get(id);
    task.status = 'cancelled'; task.failure = cancelledFailure(); task.error = task.failure.message; task.updatedAt = now();
    if (this.controller?.id === id) this.controller.abort.abort();
    await this.save(task); return this.get(id);
  }
  async close() {
    this.closing = true;
    await this.mutations;
    this.controller?.abort.abort();
    for (const task of this.tasks.values()) if (task.status === 'queued') { task.status = 'interrupted'; task.failure = interruptedFailure('服务已停止。已完成步骤已保存；可以继续未完成步骤。'); task.error = task.failure.message; task.updatedAt = now(); await this.save(task); }
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 10));
    await Promise.allSettled(this.writes.values());
    if (this.ownerFile) { await unlink(this.ownerFile).catch(error => { if (error.code !== 'ENOENT') throw error; }); this.ownerFile = null; }
  }
}
