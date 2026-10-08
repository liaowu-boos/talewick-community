import type { AgentDecisionTrace, AppState, Chapter, Project, PartialDraft, QuoteSource, RuntimeBinding, RuntimeEngine, RuntimeInfo, RuntimeRequest, ReadingObservation, RuntimeResult, RuntimeTask, RuntimeTaskStatus } from './types';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const statuses: RuntimeTaskStatus[] = ['queued', 'running', 'needs_input', 'completed', 'failed', 'interrupted', 'cancelled'];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(string) : [];
const supportedEngine = (value: unknown): boolean => value === undefined || value === 'ai-sdk' || value === 'fixed';

export function runtimeEngineLabel(engine?: RuntimeEngine): string { return engine === 'ai-sdk' ? 'Agent 创作' : '固定创作流程'; }

function readAgentTrace(value: unknown): AgentDecisionTrace[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item): AgentDecisionTrace[] => {
    if (!record(item) || (item.phase !== 'plan' && item.phase !== 'review') || !string(item.action) || !item.action.trim() || !string(item.reason) || !item.reason.trim()) return [];
    return [{ phase: item.phase, action: item.action, reason: item.reason,
      ...(Array.isArray(item.evidence) ? { evidence: strings(item.evidence) } : {}),
      ...(Array.isArray(item.targetChapterIds) ? { targetChapterIds: strings(item.targetChapterIds) } : {}),
      ...(typeof item.round === 'number' && Number.isSafeInteger(item.round) && item.round >= 0 ? { round: item.round } : {}),
      ...(string(item.manuscriptSha256) ? { manuscriptSha256: item.manuscriptSha256 } : {}),
      ...(string(item.toolCallId) ? { toolCallId: item.toolCallId } : {}) }];
  });
}

function readQuoteSource(value: unknown): QuoteSource | undefined {
  if (!record(value) || !string(value.chapterId) || !value.chapterId || typeof value.start !== 'number' || !Number.isSafeInteger(value.start) || value.start < 0) return undefined;
  return { chapterId: value.chapterId, start: value.start };
}

function chapters(value: unknown): Chapter[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const result: Chapter[] = [];
  for (const chapter of value) {
    if (!record(chapter) || !string(chapter.id) || !chapter.id || ids.has(chapter.id) || !string(chapter.title) || !string(chapter.body)) return null;
    ids.add(chapter.id); result.push({ id: chapter.id, title: chapter.title, body: chapter.body });
  }
  return result;
}

/** Preserve the current normalized observation contract, never infer approval from missing fields. */
function readReadingObservations(value: unknown): ReadingObservation[] | undefined {
  const textList = (v: unknown): v is string[] => Array.isArray(v) && v.every(string);
  if (!Array.isArray(value) || value.length > 24) return undefined;
  const ids = new Set<string>();
  const output: ReadingObservation[] = [];
  for (const item of value) {
    if (!record(item) || !string(item.id) || !item.id.trim() || ids.has(item.id) || !string(item.observation) || !item.observation.trim() || !string(item.category) || !string(item.suspectedCause) || !Array.isArray(item.evidence) || item.evidence.length > 12 || !item.evidence.every(e => record(e) && string(e.chapterId) && string(e.quote) && typeof e.evidenceVerified === 'boolean') || typeof item.evidenceVerified !== 'boolean' || typeof item.crossScene !== 'boolean' || !record(item.revisionScope)) return undefined;
    const scope = item.revisionScope;
    if (!textList(scope.chapterIds) || !string(scope.action) || !string(scope.reason) || !textList(scope.preserve) || typeof scope.scopeVerified !== 'boolean' || (item.status !== 'proposed' && item.status !== 'needs_evidence') || item.interpretationStatus !== 'model_hypothesis' || item.automaticRevisionAuthorized !== false || item.unresolved !== true || !textList(item.limitations)) return undefined;
    ids.add(item.id);
    output.push({ id: item.id, observation: item.observation, category: item.category, suspectedCause: item.suspectedCause,
      evidence: item.evidence.map(e => ({ chapterId: e.chapterId as string, quote: e.quote as string, evidenceVerified: e.evidenceVerified as boolean })), evidenceVerified: item.evidenceVerified, crossScene: item.crossScene,
      revisionScope: { chapterIds: [...scope.chapterIds], action: scope.action, reason: scope.reason, preserve: [...scope.preserve], scopeVerified: scope.scopeVerified },
      status: item.status as ReadingObservation['status'], interpretationStatus: 'model_hypothesis', automaticRevisionAuthorized: false, unresolved: true, limitations: [...item.limitations] });
  }
  return output;
}

function readResult(value: unknown): RuntimeResult | undefined {
  if (!record(value) || !string(value.title) || !record(value.review) || !string(value.review.summary)) return undefined;
  const content = chapters(value.chapters);
  if (!content?.length) return undefined;
  const rawReview = value.review;
  const observations = readReadingObservations(rawReview.readingObservations);
  const reviewMetadata = Object.fromEntries(['readerType', 'readScope', 'phase', 'manuscriptSha256'].filter(key => string(rawReview[key])).map(key => [key, rawReview[key]]));
  const binding = value.reviewAdjudicationBinding;
  const validBinding = record(binding) && ['missing', 'invalid', 'unsupported', 'unverified', 'stale', 'bound'].includes(String(binding.status)) && Array.isArray(binding.diagnostics) && binding.diagnostics.every(string) && string(binding.manuscriptSha256) && /^[a-f0-9]{64}$/.test(binding.manuscriptSha256);
  return { title: value.title, chapters: content,
    reviewOriginal: structuredClone(record(value.reviewOriginal) ? value.reviewOriginal : rawReview),
    review: { summary: value.review.summary, issues: Array.isArray(value.review.issues) ? value.review.issues : [], limitations: Array.isArray(value.review.limitations) ? value.review.limitations : [], ...reviewMetadata,
      ...(Array.isArray(value.review.strengths) && value.review.strengths.every(string) ? { strengths: [...value.review.strengths] } : {}),
      ...(observations ? { readingObservations: observations } : value.review.readingObservations !== undefined || value.review.readingObservationsInvalid === true ? { readingObservationsInvalid: true } : {}) },
    ...(Object.hasOwn(value, 'reviewAdjudication') ? { reviewAdjudication: structuredClone(value.reviewAdjudication) } : {}),
    ...(Array.isArray(value.adjudicationHistory) ? { adjudicationHistory: structuredClone(value.adjudicationHistory) } : {}),
    ...(validBinding ? { reviewAdjudicationBinding: { status: binding.status as NonNullable<RuntimeResult['reviewAdjudicationBinding']>['status'], diagnostics: [...binding.diagnostics as string[]], manuscriptSha256: binding.manuscriptSha256 as string, ...(string(binding.adjudicationSha256) && /^[a-f0-9]{64}$/.test(binding.adjudicationSha256) ? { adjudicationSha256: binding.adjudicationSha256 } : {}) } } : {}),
    checks: record(value.checks) ? value.checks : {}, knowledge: record(value.knowledge) ? value.knowledge : {}, warnings: strings(value.warnings),
    ...(record(value.activeKnowledge) ? { activeKnowledge: value.activeKnowledge } : {}),
    ...(record(value.followupRetrieval) ? { followupRetrieval: value.followupRetrieval } : value.followupRetrieval !== undefined ? { followupRetrievalInvalid: true } : {}),
    agentTrace: readAgentTrace(value.agentTrace) };
}

function readPartialDraft(value: unknown): PartialDraft | undefined {
  if (!record(value) || value.status !== 'unreviewed_partial') return undefined;
  const content = chapters(value.chapters);
  if (!content?.length || content.some(c => !c.id.trim() || !c.title.trim() || !c.body.trim()) || value.availableChapterCount !== content.length || typeof value.expectedChapterCount !== 'number' || !Number.isSafeInteger(value.expectedChapterCount) || value.expectedChapterCount < content.length || value.expectedChapterCount > 30) return undefined;
  return { status: 'unreviewed_partial', chapters: content, availableChapterCount: content.length, expectedChapterCount: value.expectedChapterCount };
}

export function readRuntimeTask(value: unknown): RuntimeTask | undefined {
  if (!record(value) || !string(value.id) || !value.id || !string(value.projectId) || !string(value.requestId) || !string(value.baseRevision) || !['create', 'revise'].includes(String(value.kind)) || !statuses.includes(value.status as RuntimeTaskStatus)) return undefined;
  if (!supportedEngine(value.engine)) return undefined;
  return { id: value.id, projectId: value.projectId, requestId: value.requestId, baseRevision: value.baseRevision,
    engine: value.engine === 'ai-sdk' ? 'ai-sdk' : 'fixed', engineVersion: string(value.engineVersion) ? value.engineVersion : '',
    kind: value.kind as RuntimeTask['kind'], status: value.status as RuntimeTaskStatus, stage: string(value.stage) ? value.stage : '',
    createdAt: string(value.createdAt) ? value.createdAt : '', updatedAt: string(value.updatedAt) ? value.updatedAt : '',
    error: value.status !== 'needs_input' && string(value.error) ? value.error : undefined,
    question: string(value.question) ? value.question : undefined,
    partialDraft: value.kind === 'create' && ['failed', 'interrupted', 'cancelled'].includes(String(value.status)) && !value.result ? readPartialDraft(value.partialDraft) : undefined,
    result: value.status === 'needs_input' ? undefined : readResult(value.result) };
}

export function readRuntimeBinding(value: unknown, projectId: string): RuntimeBinding | undefined {
  if (!record(value) || !record(value.request) || !record(value.baseManuscript)) return undefined;
  const request = value.request;
  const baseChapters = chapters(value.baseManuscript.chapters);
  const inputChapters = chapters(request.chapters);
  if (request.projectId !== projectId || !string(request.requestId) || !string(request.baseRevision) || !string(request.idea) || !['create', 'revise'].includes(String(request.kind)) || !baseChapters || !inputChapters || !string(value.baseManuscript.title)) return undefined;
  const context = record(request.context) ? request.context : {};
  const quoteSource = readQuoteSource(request.quoteSource);
  if (request.quoteSource !== undefined && !quoteSource) return undefined;
  const style = record(request.style) ? request.style : null;
  const task = readRuntimeTask(value.task);
  if (task && (task.projectId !== projectId || task.requestId !== request.requestId || task.baseRevision !== request.baseRevision || task.kind !== request.kind)) return undefined;
  return { request: { projectId, requestId: request.requestId, baseRevision: request.baseRevision, kind: request.kind as RuntimeRequest['kind'], idea: request.idea,
    ...(string(request.projectTitle) ? { projectTitle: request.projectTitle } : {}),
    context: { character: string(context.character) ? context.character : '', world: string(context.world) ? context.world : '', plot: string(context.plot) ? context.plot : '', theme: string(context.theme) ? context.theme : '' },
    materials: Array.isArray(request.materials) ? request.materials.filter(record).filter(item => string(item.id) && string(item.title) && string(item.content)).map(item => ({ id: item.id as string, title: item.title as string, content: item.content as string })) : [],
    style: style ? { name: string(style.name) ? style.name : '', description: string(style.description) ? style.description : '', rules: string(style.rules) ? style.rules : '', traits: strings(style.traits) } : null,
    chapters: inputChapters, instruction: string(request.instruction) ? request.instruction : '', quote: string(request.quote) ? request.quote : '', ...(quoteSource ? { quoteSource } : {}) },
    baseManuscript: { title: value.baseManuscript.title, chapters: baseChapters }, task,
    submitting: false,
    connectionError: string(value.connectionError) ? value.connectionError : undefined,
    handledTaskId: string(value.handledTaskId) && value.handledTaskId === task?.id ? value.handledTaskId : undefined,
    resultDisposition: ['applied', 'proposals', 'held'].includes(String(value.resultDisposition)) ? value.resultDisposition as RuntimeBinding['resultDisposition'] : undefined,
    message: string(value.message) ? value.message : undefined };
}

/** A compact transport identity; applyRuntimeTask also compares the exact source snapshot. */
export function manuscriptRevision(project: Pick<Project, 'title' | 'chapters'>): string {
  const source = JSON.stringify({ title: project.title, chapters: project.chapters });
  let first = 2166136261; let second = 5381;
  for (let i = 0; i < source.length; i++) { first = Math.imul(first ^ source.charCodeAt(i), 16777619); second = Math.imul(second, 33) ^ source.charCodeAt(i); }
  return `manuscript-v1-${source.length}-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
}

export function makeRuntimeRequest(project: Project, state: AppState, requestId: string, instruction: string, quote: string): RuntimeRequest {
  const selectedStyle = state.styles.find(style => style.id === project.styleId);
  return { projectId: project.id, projectTitle: project.title, requestId, kind: project.chapters.length ? 'revise' : 'create',
    idea: [project.idea, ...(project.extraIdeas ?? [])].filter(Boolean).join('\n\n'), context: structuredClone(project.context),
    materials: [...state.library.filter(item => project.libraryIds.includes(item.id) && item.status === 'ready').map(item => ({ id: item.id, title: item.title, content: item.content })),
      ...project.attachments.map((item, index) => ({ id: item.id || `attachment-${index}`, title: item.name, content: item.content }))],
    style: selectedStyle ? { name: selectedStyle.name, description: selectedStyle.description, rules: selectedStyle.rules, traits: [...selectedStyle.traits] } : null,
    chapters: structuredClone(project.chapters), instruction, quote, ...(quote && state.quoteSource ? { quoteSource: structuredClone(state.quoteSource) } : {}), baseRevision: manuscriptRevision(project) };
}

export function taskActive(task?: RuntimeTask): boolean { return task?.status === 'queued' || task?.status === 'running'; }
export function runtimeBusy(project?: Project): boolean { return Boolean(project?.runtime?.submitting || taskActive(project?.runtime?.task)); }

/** A stored task remains readable; its engine version is never silently upgraded. */
export function runtimeResumeMessage(task?: RuntimeTask): string {
  if (!task || !['failed', 'interrupted', 'cancelled'].includes(task.status)) return '';
  const versions = { fixed: 'fixed-workflow-2', 'ai-sdk': 'ai-sdk-7.0.93-talewick-2' };
  return task.engineVersion !== versions[task.engine] ? '该任务使用旧版或未记录版本的执行引擎，当前版本不能恢复；原稿和任务结果仍可查看。' : '';
}

const stageNames: Record<string, string> = { queued: '等待开始', requirements: '整理创作要求', request: '整理创作要求', requestSpec: '整理创作要求', request_spec: '整理创作要求', knowledge: '准备参考材料', plan: '规划故事', planning: '规划故事', write: '撰写正文', writing: '撰写正文', manuscript: '撰写正文', revise: '准备修改建议', revision: '准备修改建议', requestedRevision: '整理修改要求', review: '审阅稿件', revisionReview: '审阅修改结果', checks: '检查交付结果', validation: '检查交付结果', result: '保存稿件与报告', delivery: '保存稿件与报告', completed: '任务完成', failed: '任务未完成', interrupted: '任务已中断', cancelled: '任务已取消' };
stageNames['agent:plan'] = 'Agent 正在判断创作方案';
stageNames['agent:review'] = 'Agent 正在判断修订方案';
stageNames['requirements:repair'] = '正在校正创作规格';
stageNames.needs_input = '补充创作要求';
export function runtimeStage(task: RuntimeTask): string {
  if (!taskActive(task)) return stageNames[task.status] || '任务状态待确认';
  if (task.stage === 'review-adjudication' || task.stage.startsWith('review-adjudication:') || task.stage === 'reviewAdjudication' || task.stage.startsWith('reviewAdjudication:')) return '核对审稿证据与争议';
  if (task.stage.startsWith('followup:')) return '查找补充参考';
  if (task.stage.startsWith('knowledge-returned:')) return '整理本次写作结果';
  if (task.stage.startsWith('knowledge-use:')) return '准备本次写作材料';
  const chapter = task.stage.match(/^(draft|revision):ch-(\d+)$/);
  if (chapter) return `${chapter[1] === 'draft' ? '正在撰写' : '正在修改'}第 ${chapter[2]} 章`;
  if (task.stage.startsWith('agent:plan:') || task.stage === 'agent:replan') return 'Agent 正在检查和调整故事方案';
  if (task.stage.startsWith('agent:review:')) return 'Agent 正在检查和选择修订事项';
  if (task.stage.startsWith('agent:reviseChapter:')) return '正在执行 Agent 选定的章节修订';
  if (task.stage === 'agent:reviewManuscript') return '独立审稿正在复核修改后的全文';
  return stageNames[task.stage] || (['等待开始', '整理需求', '创作完成'].includes(task.stage) ? task.stage : stageNames[task.status]) || '正在处理本次创作';
}

export class RuntimeError extends Error {
  constructor(message: string, public status = 0) { super(message); this.name = 'RuntimeError'; }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  if (globalThis.location?.protocol === 'file:') throw new RuntimeError('当前是独立页面。请通过本地启动入口打开工作台，再连接创作服务。');
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = record(data) && string(data.message) ? data.message : record(data) && string(data.error) ? data.error : '';
      throw new RuntimeError(detail || (response.status === 503 ? '模型服务尚未配置。想法和稿件已保留，配置完成后可以重试。' : `创作服务暂时无法完成请求（${response.status}）。`), response.status);
    }
    if (!record(data)) throw new RuntimeError('未收到有效的创作服务响应，请确认已启动本地服务。');
    return data;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('暂时无法连接本地创作服务。现有稿件已保留，请启动服务后重试。');
  } finally { globalThis.clearTimeout(timeout); }
}

export async function getRuntime(): Promise<RuntimeInfo> {
  const data = await request('/api/runtime');
  if (!record(data) || typeof data.configured !== 'boolean' || typeof data.ready !== 'boolean') throw new RuntimeError('创作服务返回的配置状态无法识别。');
  if (!supportedEngine(data.engine)) throw new RuntimeError('当前创作引擎无法识别，请更新工作台后重试。');
  const engine: RuntimeEngine = data.engine === 'ai-sdk' ? 'ai-sdk' : 'fixed';
  return { configured: data.configured, ready: data.ready, provider: string(data.provider) ? data.provider : '', model: string(data.model) ? data.model : '', message: string(data.message) ? data.message : '',
    engine, engineVersion: string(data.engineVersion) ? data.engineVersion : '', engineLabel: string(data.engineLabel) && data.engineLabel.trim() ? data.engineLabel : runtimeEngineLabel(engine) };
}

function responseTask(data: unknown): RuntimeTask {
  const task = record(data) ? readRuntimeTask(data.task) : undefined;
  if (!task) throw new RuntimeError('创作服务返回的任务记录无法识别，结果尚未应用。');
  return task;
}
export async function submitTask(body: RuntimeRequest): Promise<RuntimeTask> { return responseTask(await request('/api/tasks', { method: 'POST', body: JSON.stringify(body) })); }
export async function getTask(id: string): Promise<RuntimeTask> { return responseTask(await request(`/api/tasks/${encodeURIComponent(id)}`)); }
export async function controlTask(id: string, action: 'resume' | 'cancel'): Promise<RuntimeTask> { return responseTask(await request(`/api/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' })); }
export async function findTask(projectId: string, requestId: string): Promise<RuntimeTask | undefined> {
  const data = await request(`/api/tasks?projectId=${encodeURIComponent(projectId)}`);
  if (!record(data) || !Array.isArray(data.tasks)) throw new RuntimeError('无法读取此前提交的任务。');
  return data.tasks.map(readRuntimeTask).find(task => task?.projectId === projectId && task.requestId === requestId);
}
