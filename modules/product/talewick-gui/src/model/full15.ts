import type { Project } from './types';
import { manuscriptRevision } from './runtime';

export type Full15Status = 'queued' | 'running' | 'interrupted' | 'cancelled' | 'complete' | 'incomplete' | 'needs_attention' | 'stale';
export interface Full15Task {
  id: string; projectId: string; trigger: 'automatic' | 'manual' | 'retry'; status: Full15Status;
  manuscriptRevision: string; createdAt: string; updatedAt: string;
  progress: { phase: string; completedChunks: number; totalChunks: number; completedStages: number };
  report: { checks: unknown; issues?: unknown; priorityIssueIds?: unknown; limitations?: unknown; coverageComplete: boolean } | null;
  error: { code: string; message: string; recoverable: boolean } | null;
  linkedAttemptId?: string;
}

async function call(path: string, body?: unknown) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : '辅助检查服务未能完成请求。');
  return value;
}

export async function listFull15(projectId: string): Promise<{ available: boolean; tasks: Full15Task[] }> {
  return call(`/api/full15?projectId=${encodeURIComponent(projectId)}`);
}
export async function startFull15(project: Project): Promise<Full15Task> {
  const value = await call('/api/full15', { projectId: project.id, requestId: `manual-${crypto.randomUUID()}`, title: project.title, chapters: project.chapters, manuscriptRevision: manuscriptRevision(project) }); return value.task;
}
export async function full15Action(id: string, action: 'cancel' | 'retry'): Promise<Full15Task> { return (await call(`/api/full15/${id}/${action}`, {})).task; }
