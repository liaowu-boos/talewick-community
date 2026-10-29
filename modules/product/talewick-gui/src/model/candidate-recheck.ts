import type { Chapter } from './types';

export const CANDIDATE_RECHECK_VERSION = 'candidate-recheck-cross-chapter-review-r08-1';
export interface CandidateRecheckTask {
  id: string; projectId: string; sourceTaskId: string; candidateSha256: string; checkerVersion: string;
  createdAt: string; updatedAt: string; stage: string;
  status: 'queued' | 'running' | 'reviewed_no_reported_conflict' | 'failed' | 'needs_attention' | 'interrupted';
  gate: { eligible: boolean; reason: string };
  report: { findings?: Array<{ groupId: string; status: string; summary: string; sameEventDecision?: string; resolutionReason?: string;
    evidence?: Array<{ claimId?: string; chapterId?: string; quote?: string; role?: string }> }>;
    comparisonGroups?: Array<{ id: string; dimension?: string; rationale?: string }>;
    counts?: Record<string, number>; checkedChapterIds?: string[]; implementationVersion?: string } | null;
  error: { code: string; message: string } | null;
}

/** Display gate only; the click still asks the server to replay the sealed check. */
export function canOfferCandidateSelection(task: CandidateRecheckTask, projectId: string, sourceTaskId: string): boolean {
  return task.projectId === projectId && task.sourceTaskId === sourceTaskId
    && task.checkerVersion === CANDIDATE_RECHECK_VERSION
    && task.status === 'reviewed_no_reported_conflict' && task.gate.eligible === true
    && /^[a-f0-9]{64}$/.test(task.candidateSha256);
}

async function call(path: string, body?: unknown) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : '候选复查服务暂时不可用。');
  return value;
}

export async function listCandidateRechecks(projectId: string): Promise<CandidateRecheckTask[]> {
  const value = await call(`/api/candidate-rechecks?projectId=${encodeURIComponent(projectId)}`);
  return Array.isArray(value.tasks) ? value.tasks : [];
}

export async function startCandidateRecheck(projectId: string, sourceTaskId: string): Promise<CandidateRecheckTask> {
  return (await call('/api/candidate-rechecks', { projectId, sourceTaskId })).task;
}

export async function authorizeCandidateRecheck(id: string, projectId: string, sourceTaskId: string): Promise<CandidateRecheckTask> {
  return (await call(`/api/candidate-rechecks/${encodeURIComponent(id)}/authorize`, { projectId, sourceTaskId })).task;
}

export async function candidateChapterSha256(chapters: Chapter[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(chapters.map(({ id, title, body }) => ({ id, title, body }))));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
