import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { canOfferCandidateSelection, listCandidateRechecks, startCandidateRecheck, type CandidateRecheckTask } from '@/model/candidate-recheck';
import type { Project } from '@/model/types';

const label: Record<CandidateRecheckTask['status'], string> = {
  queued: '等待复查', running: '正在复查', reviewed_no_reported_conflict: '未报告待决跨章冲突',
  failed: '事实复查失败或发现冲突', needs_attention: '仍有无法判定的事实', interrupted: '复查中断',
};

export function CandidateRecheckPanel({ project, onSelect }: { project: Project; onSelect: (task: CandidateRecheckTask) => Promise<void> }) {
  const sourceTaskId = project.runtime?.task?.id;
  const [tasks, setTasks] = useState<CandidateRecheckTask[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (!sourceTaskId) return;
    try { setTasks((await listCandidateRechecks(project.id)).filter(task => task.sourceTaskId === sourceTaskId)); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '暂时无法读取复查记录。'); }
  }, [project.id, sourceTaskId]);
  useEffect(() => { setTasks([]); void refresh(); }, [refresh]);
  useEffect(() => {
    if (!tasks.some(task => ['queued', 'running'].includes(task.status))) return;
    const timer = window.setInterval(() => { void refresh(); }, 1200);
    return () => window.clearInterval(timer);
  }, [tasks, refresh]);
  async function start() {
    if (!sourceTaskId) return;
    setBusy(true); setError('');
    try { await startCandidateRecheck(project.id, sourceTaskId); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法开始候选复查。'); }
    finally { setBusy(false); }
  }
  return <section className="rounded-2xl border border-border-button-default p-4" aria-label="候选独立事实复查">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-body-medium">候选独立事实复查</h3>
      <p className="mt-1 text-caption-1-regular text-text-secondary">新任务绑定这次来源任务和完整候选。旧跨章核查失败记录继续保留；复查只判断事实，不代表文学质量通过。</p></div>
      <Button size="small" variant="secondary" disabled={busy || tasks.some(task => ['queued','running'].includes(task.status))} onClick={() => void start()}>新建候选复查</Button></div>
    {error && <p className="mt-3 text-caption-1-regular text-text-error-primary" role="alert">{error}</p>}
    {!tasks.length && <p className="mt-3 text-caption-1-regular text-text-tertiary">当前候选还没有新复查记录。</p>}
    {tasks.map(task => <article key={task.id} className="mt-3 rounded-xl bg-tw-glass p-3">
      <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-body-2-medium">{label[task.status]} · {new Date(task.createdAt).toLocaleString()}</p>
        <p className="mt-1 break-all text-caption-1-regular text-text-tertiary">来源任务 {task.sourceTaskId} · 候选 SHA {task.candidateSha256.slice(0, 16)}… · {task.checkerVersion}</p>
        {task.stage && ['queued','running'].includes(task.status) && <p className="mt-1 text-caption-1-regular text-text-secondary">进度：{task.stage}</p>}</div>
        {canOfferCandidateSelection(task, project.id, sourceTaskId || '') && <Button size="small" variant="primary" disabled={busy} onClick={() => { setBusy(true); void onSelect(task).catch(cause => setError(cause instanceof Error ? cause.message : '选择失败。')).finally(() => setBusy(false)); }}>明确选择完整候选</Button>}</div>
      {task.error && <p className="mt-2 text-caption-1-regular text-text-error-primary">{task.error.message}</p>}
      {task.report && <details className="mt-3"><summary className="cursor-pointer text-body-2-medium">复查事实与分歧 · 冲突 {task.report.counts?.confirmed_conflict ?? '?'} / 未判定 {task.report.counts?.ambiguous ?? '?'}</summary>
        <div className="mt-2 space-y-2"><p className="text-caption-1-regular text-text-tertiary">覆盖章节：{task.report.checkedChapterIds?.join('、') || '未列出'} · 已解释 {task.report.counts?.resolved ?? 0} 组</p>{task.report.findings?.map((finding, index) => <div key={finding.groupId || index} className="rounded-lg border border-border-button-default p-2">
          <p className="text-body-2-medium">{finding.status === 'ambiguous' ? '仍未判定' : finding.status === 'confirmed_conflict' ? '确认冲突' : '已解释'} · {finding.groupId}</p><p className="mt-1 text-body-2-regular text-text-secondary">{finding.summary}</p>
          {finding.resolutionReason && <p className="mt-1 text-caption-1-regular text-text-tertiary">裁定依据：{finding.resolutionReason} · 同一事件：{finding.sameEventDecision || '未列出'}</p>}
          {finding.evidence?.map((evidence, evidenceIndex) => <blockquote key={`${evidence.claimId || evidence.chapterId}-${evidenceIndex}`} className="mt-2 rounded-lg bg-tw-glass p-2 text-body-2-regular"><span className="text-caption-1-regular text-text-tertiary">{evidence.chapterId || '未列出章节'} · {evidence.role || '证据'}</span><p className="mt-1 whitespace-pre-wrap">{evidence.quote || '未提供逐字证据'}</p></blockquote>)}
        </div>)}{!task.report.findings?.length && <p className="text-caption-1-regular text-text-secondary">未提取到需裁定的跨章比较组。</p>}</div></details>}
    </article>)}
  </section>;
}
