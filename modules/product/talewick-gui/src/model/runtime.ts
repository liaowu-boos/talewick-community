import type { AgentDecisionTrace, AppState, Chapter, Project, PartialDraft, QuoteSource, RuntimeBinding, RuntimeEngine, RuntimeInfo, RuntimeRequest, ReadingObservation, RuntimeResult, RuntimeTask, RuntimeTaskFailure, RuntimeTaskStatus } from './types';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const statuses: RuntimeTaskStatus[] = ['queued', 'running', 'needs_input', 'completed', 'failed', 'interrupted', 'cancelled'];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(string) : [];
const supportedEngine = (value: unknown): boolean => value === undefined || value === 'ai-sdk' || value === 'fixed';
const failureKinds: RuntimeTaskFailure['kind'][] = ['review_output', 'delivery_check', 'network', 'configuration', 'writing', 'unknown', 'interrupted', 'cancelled'];
const retryScopes: RuntimeTaskFailure['retryScope'][] = ['unfinished_review', 'unfinished_check', 'unfinished_writing', 'unfinished_step'];

function readTaskFailure(value: unknown): RuntimeTaskFailure | undefined {
  if (!record(value) || !failureKinds.includes(value.kind as RuntimeTaskFailure['kind']) || !['writing', 'review', 'check', 'step'].includes(String(value.phase))
    || !retryScopes.includes(value.retryScope as RuntimeTaskFailure['retryScope']) || !string(value.message) || !value.message.trim()) return undefined;
  if (value.recoverable !== undefined && typeof value.recoverable !== 'boolean') return undefined;
  return { kind: value.kind as RuntimeTaskFailure['kind'], phase: value.phase as RuntimeTaskFailure['phase'], retryScope: value.retryScope as RuntimeTaskFailure['retryScope'], message: value.message,
    ...(typeof value.recoverable === 'boolean' ? { recoverable: value.recoverable } : {}) };
}

export function runtimeEngineLabel(engine?: RuntimeEngine): string { return engine === 'ai-sdk' ? 'Agent 创作' : '固定创作流程'; }

export function wholeRevisionDispositionLabel(disposition?: RuntimeBinding['resultDisposition']): string {
  if (disposition === 'applied') return '已整体采纳';
  if (disposition === 'partially-applied') return '已采纳部分修订组';
  if (disposition === 'declined') return '已保留原稿';
  if (disposition === 'whole-revision-candidate') return '待确认';
  if (disposition === 'whole-quality-groups') return '修订组待确认';
  if (disposition === 'held') return '当前稿已变化，无法自动采纳';
  return '未记录';
}

export function wholeRevisionRereadPresentation(value: unknown): { status: 'complete' | 'bounded' | 'incomplete'; omissions: string[] } {
  if (!record(value) || !record(value.reread) || value.reread.schemaVersion !== 'whole-revision-reread-1') return { status: 'incomplete', omissions: [] };
  const coverage = value.reread.coverage;
  if (!record(coverage)) return { status: 'incomplete', omissions: [] };
  const omissions = strings(coverage.omissions);
  if (coverage.status === 'bounded') return { status: 'bounded', omissions };
  if (coverage.status === 'complete' && omissions.length === 0) return { status: 'complete', omissions: [] };
  return { status: 'incomplete', omissions };
}

export interface WholeRevisionRereadReport {
  summary: string;
  introducedIssueCount: number;
  unsupportedChangeCount: number;
  changeChecks: Array<{ planItemId: string; assessment: string; reason: string; risks: string[]; evidence: unknown[] }>;
  introducedIssues: Array<{ id: string; type: string; observation: string; limitations: string[]; evidence: unknown[] }>;
}

/** Read report claims for display without turning them into product verdicts. */
export function wholeRevisionRereadReport(value: unknown): WholeRevisionRereadReport {
  const reread = record(value) && record(value.reread) ? value.reread : {};
  const changeChecks = Array.isArray(reread.changeChecks) ? reread.changeChecks.flatMap(item => record(item) ? [{
    planItemId: string(item.planItemId) ? item.planItemId : '', assessment: string(item.assessment) ? item.assessment : '', reason: string(item.reason) ? item.reason : '',
    risks: strings(item.risks), evidence: Array.isArray(item.evidence) ? structuredClone(item.evidence) : [],
  }] : []) : [];
  const introducedIssues = Array.isArray(reread.introducedIssues) ? reread.introducedIssues.flatMap(item => record(item) ? [{
    id: string(item.id) ? item.id : '', type: string(item.claimType) ? item.claimType : '', observation: string(item.observation) ? item.observation : '',
    limitations: strings(item.limitations), evidence: Array.isArray(item.evidence) ? structuredClone(item.evidence) : [],
  }] : []) : [];
  return { summary: string(reread.summary) ? reread.summary : '', introducedIssueCount: introducedIssues.length,
    unsupportedChangeCount: changeChecks.filter(item => ['partly_supported', 'not_supported', 'uncertain'].includes(item.assessment)).length,
    changeChecks, introducedIssues };
}

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
  if (!record(value) || !string(value.title)) return undefined;
  const wholeRevision = record(value.wholeRevision) ? structuredClone(value.wholeRevision) : undefined;
  if (!wholeRevision && (!record(value.review) || !string(value.review.summary))) return undefined;
  const content = chapters(value.chapters);
  if (!content?.length) return undefined;
  const rawReview = record(value.review) && string(value.review.summary) ? value.review : {summary: ''};
  const observations = readReadingObservations(rawReview.readingObservations);
  const reviewMetadata = Object.fromEntries(['readerType', 'readScope', 'phase', 'manuscriptSha256'].filter(key => string(rawReview[key])).map(key => [key, rawReview[key]]));
  const binding = value.reviewAdjudicationBinding;
  const validBinding = record(binding) && ['missing', 'invalid', 'unsupported', 'unverified', 'stale', 'bound'].includes(String(binding.status)) && Array.isArray(binding.diagnostics) && binding.diagnostics.every(string) && string(binding.manuscriptSha256) && /^[a-f0-9]{64}$/.test(binding.manuscriptSha256);
  return { title: value.title, chapters: content,
    ...(string(value.baseRevision) ? { baseRevision: value.baseRevision } : {}),
    ...(typeof value.revisionApplied === 'boolean' ? { revisionApplied: value.revisionApplied } : {}),
    ...(value.qualityCheckStatus === 'incomplete' ? { qualityCheckStatus: 'incomplete' as const } : {}),
    ...(record(value.review) ? {reviewOriginal: structuredClone(record(value.reviewOriginal) ? value.reviewOriginal : rawReview)} : {}),
    review: { summary: rawReview.summary as string, issues: Array.isArray(rawReview.issues) ? rawReview.issues : [], limitations: Array.isArray(rawReview.limitations) ? rawReview.limitations : [], ...reviewMetadata,
      ...(Array.isArray(rawReview.strengths) && rawReview.strengths.every(string) ? { strengths: [...rawReview.strengths] } : {}),
      ...(observations ? { readingObservations: observations } : rawReview.readingObservations !== undefined || rawReview.readingObservationsInvalid === true ? { readingObservationsInvalid: true } : {}) },
    ...(Object.hasOwn(value, 'reviewAdjudication') ? { reviewAdjudication: structuredClone(value.reviewAdjudication) } : {}),
    ...(Array.isArray(value.adjudicationHistory) ? { adjudicationHistory: structuredClone(value.adjudicationHistory) } : {}),
    ...(validBinding ? { reviewAdjudicationBinding: { status: binding.status as NonNullable<RuntimeResult['reviewAdjudicationBinding']>['status'], diagnostics: [...binding.diagnostics as string[]], manuscriptSha256: binding.manuscriptSha256 as string, ...(string(binding.adjudicationSha256) && /^[a-f0-9]{64}$/.test(binding.adjudicationSha256) ? { adjudicationSha256: binding.adjudicationSha256 } : {}) } } : {}),
    checks: record(value.checks) ? value.checks : {}, knowledge: record(value.knowledge) ? value.knowledge : {}, warnings: strings(value.warnings),
    ...(wholeRevision ? { wholeRevision } : {}),
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
    kind: value.kind as RuntimeTask['kind'], ...(['whole-manuscript-v1', 'whole-manuscript-v2'].includes(String(value.revisionMode)) ? { revisionMode: value.revisionMode as RuntimeTask['revisionMode'] } : {}), status: value.status as RuntimeTaskStatus, stage: string(value.stage) ? value.stage : '',
    createdAt: string(value.createdAt) ? value.createdAt : '', updatedAt: string(value.updatedAt) ? value.updatedAt : '',
    error: value.status !== 'needs_input' && string(value.error) ? value.error : undefined,
    failure: value.status !== 'needs_input' ? readTaskFailure(value.failure) : undefined,
    question: string(value.question) ? value.question : undefined,
    partialDraft: value.kind === 'create' && ['failed', 'interrupted', 'cancelled'].includes(String(value.status)) && !value.result ? readPartialDraft(value.partialDraft) : undefined,
    result: value.status === 'needs_input' ? undefined : readResult(value.result) };
}

export function readRuntimeBinding(value: unknown, projectId: string): RuntimeBinding | undefined {
  if (!record(value) || !record(value.request) || !record(value.baseManuscript)) return undefined;
  const request = value.request;
  if (request.revisionMode !== undefined && !['whole-manuscript-v1', 'whole-manuscript-v2'].includes(String(request.revisionMode))) return undefined;
  const baseChapters = chapters(value.baseManuscript.chapters);
  const inputChapters = chapters(request.chapters);
  if (request.projectId !== projectId || !string(request.requestId) || !string(request.baseRevision) || !string(request.idea) || !['create', 'revise'].includes(String(request.kind)) || !baseChapters || !inputChapters || !string(value.baseManuscript.title)) return undefined;
  const context = record(request.context) ? request.context : {};
  const quoteSource = readQuoteSource(request.quoteSource);
  if (request.quoteSource !== undefined && !quoteSource) return undefined;
  const style = record(request.style) ? request.style : null;
  const task = readRuntimeTask(value.task);
  if (task && (task.projectId !== projectId || task.requestId !== request.requestId || task.baseRevision !== request.baseRevision || task.kind !== request.kind || task.revisionMode !== request.revisionMode)) return undefined;
  return { request: { projectId, requestId: request.requestId, baseRevision: request.baseRevision, kind: request.kind as RuntimeRequest['kind'], idea: request.idea,
    ...(string(request.projectTitle) ? { projectTitle: request.projectTitle } : {}),
    context: { character: string(context.character) ? context.character : '', world: string(context.world) ? context.world : '', plot: string(context.plot) ? context.plot : '', theme: string(context.theme) ? context.theme : '' },
    materials: Array.isArray(request.materials) ? request.materials.filter(record).filter(item => string(item.id) && string(item.title) && string(item.content)).map(item => ({ id: item.id as string, title: item.title as string, content: item.content as string })) : [],
    style: style ? { name: string(style.name) ? style.name : '', description: string(style.description) ? style.description : '', rules: string(style.rules) ? style.rules : '', traits: strings(style.traits) } : null,
    chapters: inputChapters, instruction: string(request.instruction) ? request.instruction : '', quote: string(request.quote) ? request.quote : '', ...(['whole-manuscript-v1', 'whole-manuscript-v2'].includes(String(request.revisionMode)) ? { revisionMode: request.revisionMode as RuntimeRequest['revisionMode'] } : {}), ...(quoteSource ? { quoteSource } : {}) },
    baseManuscript: { title: value.baseManuscript.title, chapters: baseChapters }, task,
    submitting: false,
    connectionError: string(value.connectionError) ? value.connectionError : undefined,
    handledTaskId: string(value.handledTaskId) && value.handledTaskId === task?.id ? value.handledTaskId : undefined,
    resultDisposition: ['applied', 'partially-applied', 'proposals', 'held', 'whole-revision-candidate', 'whole-quality-groups', 'declined'].includes(String(value.resultDisposition)) ? value.resultDisposition as RuntimeBinding['resultDisposition'] : undefined,
    ...(record(value.qualityAdoption) && Array.isArray(value.qualityAdoption.selectedGroupIds) && Array.isArray(value.qualityAdoption.declinedGroupIds)
      && value.qualityAdoption.selectedGroupIds.every(string) && value.qualityAdoption.declinedGroupIds.every(string)
      && typeof value.qualityAdoption.fullCandidateRereadInherited === 'boolean'
      && ['full-candidate', 'selected-groups-unchecked'].includes(String(value.qualityAdoption.rereadScope)) ? { qualityAdoption: {
        selectedGroupIds: [...value.qualityAdoption.selectedGroupIds], declinedGroupIds: [...value.qualityAdoption.declinedGroupIds],
        fullCandidateRereadInherited: value.qualityAdoption.fullCandidateRereadInherited,
        rereadScope: value.qualityAdoption.rereadScope as NonNullable<RuntimeBinding['qualityAdoption']>['rereadScope'],
      } } : {}),
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

export function makeWholeRevisionRequest(project: Project, state: AppState, requestId: string, instruction: string): RuntimeRequest {
  const request = makeRuntimeRequest(project, state, requestId, instruction, '');
  if (request.kind !== 'revise') throw new Error('整稿修订需要已有完整稿件。');
  delete request.quoteSource;
  request.quote = '';
  request.revisionMode = 'whole-manuscript-v2';
  return request;
}

export function taskActive(task?: RuntimeTask): boolean { return task?.status === 'queued' || task?.status === 'running'; }
export function runtimeBusy(project?: Project): boolean { return Boolean(project?.runtime?.submitting || taskActive(project?.runtime?.task)); }

export function runtimeTaskPhase(task?: RuntimeTask): RuntimeTaskFailure['phase'] {
  if (task?.failure?.phase) return task.failure.phase;
  const stage = task?.stage ?? '';
  if (stage === 'continuity-review' || stage === 'continuity-chain-review' || stage === 'review' || stage === 'revisionReview' || stage === 'agent:reviewManuscript'
    || stage.startsWith('review-adjudication') || stage.startsWith('reviewAdjudication') || stage.startsWith('agent:review')) return 'review';
  if (/^(draft|revision):/.test(stage) || stage.startsWith('agent:reviseChapter:') || ['write', 'writing', 'manuscript', 'revise', 'revision'].includes(stage)) return 'writing';
  if (['checks', 'validation', 'result', 'delivery'].includes(stage)) return 'check';
  return 'step';
}

export function runtimeProgressDetail(task?: RuntimeTask): string {
  const phase = runtimeTaskPhase(task);
  if (taskActive(task) && task?.revisionMode === 'whole-manuscript-v2') return '正在独立阅读全文、核对主要问题并形成可分组审阅的有限修改。候选不会覆盖当前稿件。';
  if (taskActive(task) && task?.revisionMode === 'whole-manuscript-v1') return '正在阅读全文、形成方案并修改关联场景。候选不会覆盖当前稿件；独立复读状态会如实保留。';
  if (taskActive(task)) return phase === 'writing' ? '正在生成或修改正文。已完成章节会随任务检查点保存。'
    : phase === 'review' ? '正文已经生成，正在审阅当前稿件。'
      : phase === 'check' ? '正文已经生成，正在核对交付条件。' : '正在准备本次任务。';
  if (task?.status === 'failed') return task.failure?.message || '当前步骤未完成。已完成步骤已保存；继续任务时只会运行未完成步骤。';
  if (task?.status === 'interrupted') return task.failure?.message || '运行已中断。已完成步骤已保存；可以继续未完成步骤。';
  if (task?.status === 'cancelled') return task.failure?.message || '任务已取消。已完成步骤仍保留；需要时可继续未完成步骤。';
  return '';
}

export function runtimeResumeLabel(task?: RuntimeTask): string {
  switch (task?.failure?.retryScope) {
    case 'unfinished_review': return '继续未完成审阅';
    case 'unfinished_check': return '继续未完成检查';
    case 'unfinished_writing': return '继续未完成写作';
    default: return '继续未完成步骤';
  }
}

/** A stored task remains readable; its engine version is never silently upgraded. */
export function runtimeResumeMessage(task?: RuntimeTask): string {
  if (!task || !['failed', 'interrupted', 'cancelled'].includes(task.status)) return '';
  if (task.failure?.recoverable === false) return task.failure.message;
  const versions = { fixed: 'fixed-workflow-2', 'ai-sdk': 'ai-sdk-7.0.93-talewick-2' };
  return task.engineVersion !== versions[task.engine] ? '该任务使用旧版或未记录版本的执行引擎，当前版本不能恢复；原稿和任务结果仍可查看。' : '';
}

const stageNames: Record<string, string> = { queued: '等待开始', requirements: '整理创作要求', request: '整理创作要求', requestSpec: '整理创作要求', request_spec: '整理创作要求', knowledge: '准备参考材料', plan: '规划故事', planning: '规划故事', write: '撰写正文', writing: '撰写正文', manuscript: '撰写正文', revise: '准备修改建议', revision: '准备修改建议', requestedRevision: '整理修改要求', review: '审阅稿件', revisionReview: '审阅修改结果', checks: '检查交付结果', validation: '检查交付结果', result: '保存稿件与报告', delivery: '保存稿件与报告', completed: '任务完成', failed: '任务未完成', interrupted: '任务已中断', cancelled: '任务已取消' };
stageNames['planning:material-decisions'] = '正在判断补查材料';
stageNames['continuity-chain-review'] = '正在核对时间与状态连续性';
stageNames['agent:plan'] = 'Agent 正在判断创作方案';
stageNames['agent:review'] = 'Agent 正在判断修订方案';
stageNames['requirements:repair'] = '正在校正创作规格';
stageNames.needs_input = '补充创作要求';
export function runtimeStage(task: RuntimeTask): string {
  if (task.status === 'completed' && task.stage === '稿件已生成，部分检查未完成') return task.stage;
  if (!taskActive(task)) return stageNames[task.status] || '任务状态待确认';
  if (task.stage === 'review-adjudication' || task.stage.startsWith('review-adjudication:') || task.stage === 'reviewAdjudication' || task.stage.startsWith('reviewAdjudication:')) return '核对审稿证据与争议';
  if (task.stage.startsWith('followup:')) return '查找补充参考';
  if (task.stage.startsWith('knowledge-returned:')) return '整理本次写作结果';
  if (task.stage.startsWith('knowledge-use:')) return '准备本次写作材料';
  if (task.stage === 'whole-quality:cross-chapter:extract') return '正在提取跨章事实与证据';
  if (task.stage === 'whole-quality:cross-chapter:adjudicate') return '正在裁定跨章冲突与待澄清项';
  if (task.stage === 'whole-quality:cross-chapter:extract:format-repair') return '正在校正跨章事实报告格式';
  if (task.stage === 'whole-quality:cross-chapter:adjudicate:format-repair') return '正在校正跨章裁定报告格式';
  if (task.stage.startsWith('whole-quality:')) return task.stage.includes('reread') || task.stage.includes('check') ? '正在复核修改目标与风险' : task.stage.includes('reading') ? '正在独立阅读全文' : task.stage.includes('retrieval') || task.stage.includes('material') ? '正在核对问题所需材料' : task.stage.includes('plan') ? '正在形成场景联动方案' : task.stage.includes('revision') ? '正在执行有限改写' : '正在处理整稿质量步骤';
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
