import type { Project } from './types';
import { manuscriptRevision } from './runtime';

export type IndependentReviewStatus = 'queued' | 'running' | 'complete' | 'interrupted' | 'cancelled' | 'needs_attention' | 'stale';
export const INDEPENDENT_READING_FOCUS_VERSION = 'literary-reading-six-1';
export const PARAGRAPH_CITATION_MODE = 'paragraph_refs_v1';
export type ModelCitationMode = typeof PARAGRAPH_CITATION_MODE;
export interface IndependentReviewTask {
  id: string;
  projectId: string;
  requestId: string;
  caseId: string;
  mode: 'single' | 'compare';
  sourceTaskId?: string;
  readingFocusVersion?: string;
  modelCitationMode?: ModelCitationMode;
  linkedAttemptId?: string;
  status: IndependentReviewStatus;
  manuscriptRevision: string;
  createdAt: string;
  updatedAt: string;
  progress: { phase: string; completedStages: number; totalStages: number };
  report: unknown | null;
  partialReport?: unknown;
  partialSnapshotProjection?: unknown;
  partialSnapshotUnavailable?: { code: string; message: string };
  recoveryCapabilities?: { whitespace_only: boolean; position_repair: boolean };
  recoveries?: { requestId: string; stageId: string; mode: 'whitespace_only' | 'position_repair' | 'audited_nondispatch'; status: string; originalError?: { code: string; message: string } | null }[];
  invalidReadingRetry?: { available: boolean; eligible: boolean; remainingAttempts: number; stageId?: string; reason?: string };
  invalidReadingRetries?: { requestId: string; stageId: string; status: string; originalError?: { code: string; message: string } | null }[];
  error: { code: string; message: string; recoverable: boolean; stage?: string } | null;
}

async function call(path: string, body?: unknown) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : '独立全文评阅服务未能完成请求。');
  return value;
}

export async function listIndependentReviews(projectId: string): Promise<{ available: boolean; readingFocusVersions: string[]; modelCitationModes: string[]; tasks: IndependentReviewTask[] }> {
  const value = await call(`/api/independent-reviews?projectId=${encodeURIComponent(projectId)}`);
  return { ...value, readingFocusVersions: value.readingFocusVersions ?? [], modelCitationModes: value.modelCitationModes ?? [] };
}

export function comparableWholeQualityTask(project: Project) {
  const binding = project.runtime, task = binding?.task, whole = task?.result?.wholeRevision as Record<string, unknown> | undefined;
  const current = { title: project.title, chapters: project.chapters };
  return Boolean(binding && task?.status === 'completed' && task.revisionMode === 'whole-manuscript-v2'
    && whole?.schemaVersion === 'whole-manuscript-quality-1' && ['candidate_ready', 'candidate_ready_reread_incomplete', 'candidate_ready_cross_check_incomplete', 'no_change'].includes(String(whole.status))
    && binding.request.baseRevision === manuscriptRevision(project) && JSON.stringify(current) === JSON.stringify(binding.baseManuscript));
}

export async function startIndependentReview(project: Project, mode: 'single' | 'compare', modelCitationMode?: ModelCitationMode): Promise<IndependentReviewTask> {
  if (modelCitationMode !== undefined && modelCitationMode !== PARAGRAPH_CITATION_MODE) throw new Error('不支持这套证据定位方式。');
  const task = project.runtime?.task;
  if (mode === 'compare' && (!task || !comparableWholeQualityTask(project))) throw new Error('当前没有与这版原稿精确绑定的整稿候选。');
  const value = await call('/api/independent-reviews', { projectId: project.id, requestId: `review-${crypto.randomUUID()}`, caseId: `case-${crypto.randomUUID()}`,
    title: project.title, chapters: project.chapters, manuscriptRevision: manuscriptRevision(project), mode, readingFocusVersion: INDEPENDENT_READING_FOCUS_VERSION,
    ...(modelCitationMode !== undefined ? { modelCitationMode } : {}),
    ...(mode === 'compare' ? { sourceTaskId: task!.id } : {}) });
  return value.task;
}

export async function independentReviewAction(id: string, action: 'cancel' | 'retry'): Promise<IndependentReviewTask> {
  return (await call(`/api/independent-reviews/${id}/${action}`, {})).task;
}

export function independentReviewRecoveryModes(task: IndependentReviewTask) {
  if (task.status !== 'needs_attention' || !task.error?.stage || !['QUOTE_NOT_FOUND', 'QUOTE_POSITION_NOT_UNIQUE'].includes(task.error.code)) return [];
  return (['whitespace_only', 'position_repair'] as const).filter(mode => task.recoveryCapabilities?.[mode]
    && !task.recoveries?.some(item => item.stageId === task.error?.stage && item.mode === mode));
}

export async function recoverIndependentReview(task: IndependentReviewTask, mode: 'whitespace_only' | 'position_repair'): Promise<IndependentReviewTask> {
  if (!task.error?.stage) throw new Error('没有可恢复的失败阶段。');
  return (await call(`/api/independent-reviews/${task.id}/recover`, {
    requestId: `recover-${task.error.stage}-${mode}`, stageId: task.error.stage, mode,
  })).task;
}

export function canRetryInvalidIndependentReading(task: IndependentReviewTask): boolean {
  const inspection = task.invalidReadingRetry;
  return task.status === 'needs_attention' && inspection?.available === true && inspection.eligible === true
    && inspection.remainingAttempts === 1 && Boolean(inspection.stageId) && inspection.stageId === task.error?.stage
    && !task.invalidReadingRetries?.some(entry => entry.stageId === inspection.stageId);
}

export async function retryInvalidIndependentReading(task: IndependentReviewTask): Promise<IndependentReviewTask> {
  if (!canRetryInvalidIndependentReading(task)) throw new Error('当前阶段未获准一次独立重读，或本阶段已尝试。');
  const stageId = task.invalidReadingRetry!.stageId!;
  return (await call(`/api/independent-reviews/${task.id}/retry-invalid-reading`, {
    requestId: `retry-invalid-reading-${stageId}`, stageId,
  })).task;
}
