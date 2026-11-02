import type { ReviewEventGrounding } from './review-result-state.ts';

export interface EvidenceAuditTask {
  id: string;
  projectId: string;
  sourceReviewTaskId: string;
  status: 'queued' | 'running' | 'complete' | 'needs_attention' | 'interrupted' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  formatNormalizationVersion?: 'citation-check-reason-alias-1';
  auditPolicyVersion?: 'original-citation-and-whole-text-1' | 'fact-subclaims-and-two-axes-2' | 'fact-premise-decomposition-and-two-axes-3';
  executionVersion?: string;
  progress?: { totalBatches: number; completedBatches: number; failedBatches: number };
  batches?: Array<{ batchId: string; status: string; error?: { code: string; message: string } | null }>;
  report: unknown | null;
  targets?: unknown[];
  eventGrounding?: ReviewEventGrounding;
  canonicalAuditComplete?: boolean;
  completeEvidenceReview?: boolean;
  semanticAccuracyProven?: false;
  eventGroundingPolicyVersion?: ReviewEventGrounding['policyVersion'];
  error?: { code: string; message: string } | null;
  automaticAdoption: false;
  literaryPass: 'NOT_COMPUTED';
  originalReviewUnchanged: true;
}
export interface EvidenceAuditSnapshot { available: boolean; eligible: boolean; reason: string | null; tasks: EvidenceAuditTask[] }

async function call(id: string, body?: { requestId: string }) {
  const response = await fetch(`/api/independent-reviews/${encodeURIComponent(id)}/evidence-audits`, {
    method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : '语义依据复核暂不可用。');
  return value;
}
export async function listReviewEvidenceAudits(id: string): Promise<EvidenceAuditSnapshot> { return call(id); }
export async function startReviewEvidenceAudit(id: string): Promise<EvidenceAuditTask> {
  // Stable request identifier plus server frozen-input dedup prevents click/restart rerolls.
  return (await call(id, { requestId: `evidence-audit-${id}` })).task;
}
export const auditSupportLabels: Record<string, string> = { supported: '有依据支持', partial: '仅部分支持', unsupported: '依据不足或存在反证', uncertain: '尚不能确定' };
export const auditStateLabels: Record<EvidenceAuditTask['status'], string> = {
  queued: '等待复核', running: '语义依据复核中', complete: '依据复核记录已保存', needs_attention: '复核未完成', interrupted: '复核已中断', cancelled: '复核已停止',
};
