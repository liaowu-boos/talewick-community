import type { Project } from './types';
import { manuscriptRevision } from './runtime';

export type IndependentReviewStatus = 'queued' | 'running' | 'complete' | 'interrupted' | 'cancelled' | 'needs_attention' | 'stale';
export interface IndependentReviewTask {
  id: string;
  projectId: string;
  requestId: string;
  caseId: string;
  mode: 'single' | 'compare';
  sourceTaskId?: string;
  linkedAttemptId?: string;
  status: IndependentReviewStatus;
  manuscriptRevision: string;
  createdAt: string;
  updatedAt: string;
  progress: { phase: string; completedStages: number; totalStages: number };
  report: unknown | null;
  error: { code: string; message: string; recoverable: boolean } | null;
}

async function call(path: string, body?: unknown) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : '独立全文评阅服务未能完成请求。');
  return value;
}

export async function listIndependentReviews(projectId: string): Promise<{ available: boolean; tasks: IndependentReviewTask[] }> {
  return call(`/api/independent-reviews?projectId=${encodeURIComponent(projectId)}`);
}

export function comparableWholeQualityTask(project: Project) {
  const binding = project.runtime, task = binding?.task, whole = task?.result?.wholeRevision as Record<string, unknown> | undefined;
  const current = { title: project.title, chapters: project.chapters };
  return Boolean(binding && task?.status === 'completed' && task.revisionMode === 'whole-manuscript-v2'
    && whole?.schemaVersion === 'whole-manuscript-quality-1' && ['candidate_ready', 'candidate_ready_reread_incomplete', 'candidate_ready_cross_check_incomplete'].includes(String(whole.status))
    && binding.request.baseRevision === manuscriptRevision(project) && JSON.stringify(current) === JSON.stringify(binding.baseManuscript));
}

export async function startIndependentReview(project: Project, mode: 'single' | 'compare'): Promise<IndependentReviewTask> {
  const task = project.runtime?.task;
  if (mode === 'compare' && (!task || !comparableWholeQualityTask(project))) throw new Error('当前没有与这版原稿精确绑定的整稿候选。');
  const value = await call('/api/independent-reviews', { projectId: project.id, requestId: `review-${crypto.randomUUID()}`, caseId: `case-${crypto.randomUUID()}`,
    title: project.title, chapters: project.chapters, manuscriptRevision: manuscriptRevision(project), mode,
    ...(mode === 'compare' ? { sourceTaskId: task!.id } : {}) });
  return value.task;
}

export async function independentReviewAction(id: string, action: 'cancel' | 'retry'): Promise<IndependentReviewTask> {
  return (await call(`/api/independent-reviews/${id}/${action}`, {})).task;
}
