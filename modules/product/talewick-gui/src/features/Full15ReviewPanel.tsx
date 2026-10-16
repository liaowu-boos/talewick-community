import { useCallback, useEffect, useRef, useState } from 'react';
import { RiPlayLine, RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { full15Action, listFull15, startFull15, type Full15Task } from '@/model/full15';
import { acceptsFull15Response, full15PanelAction, full15ReportView } from '@/model/full15-view';
import { manuscriptRevision } from '@/model/runtime';
import type { Project } from '@/model/types';
import type { ReviewEvidenceLocation } from '@/model/independent-review-view';

const names: Record<Full15Task['status'], string> = { queued: '等待辅助检查', running: '辅助检查进行中', interrupted: '辅助检查已中断', cancelled: '辅助检查已取消', complete: '限定辅助检查已完成', incomplete: '辅助检查未完整覆盖', needs_attention: '辅助检查需要处理', stale: '报告对应旧版本' };
const emptySnapshot = (projectId: string) => ({ projectId, available: false, tasks: [] as Full15Task[] });

export function Full15ReviewPanel({ project, hasUnsavedDraft, onLocate }: { project: Project; hasUnsavedDraft: boolean; onLocate: (location: ReviewEvidenceLocation, revision: string) => void }) {
  const [snapshot, setSnapshot] = useState(() => emptySnapshot(project.id));
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [busyProject, setBusyProject] = useState('');
  const [errorState, setErrorState] = useState({ projectId: project.id, message: '' });
  const activeProject = useRef(project.id), refreshSequence = useRef(0);
  activeProject.current = project.id;

  const refresh = useCallback(async () => {
    const projectId = project.id;
    if (activeProject.current !== projectId) return;
    const sequence = ++refreshSequence.current;
    try {
      const value = await listFull15(projectId);
      if (!acceptsFull15Response(activeProject.current, projectId, sequence, refreshSequence.current)) return;
      setSnapshot({ projectId, available: value.available, tasks: value.tasks });
      setErrorState({ projectId, message: '' });
    } catch (error) {
      if (!acceptsFull15Response(activeProject.current, projectId, sequence, refreshSequence.current)) return;
      setErrorState({ projectId, message: error instanceof Error ? error.message : '全文检查状态暂时无法读取。' });
    }
  }, [project.id]);

  useEffect(() => {
    refreshSequence.current += 1;
    setSnapshot(emptySnapshot(project.id));
    setSelectedTaskId('');
    setErrorState({ projectId: project.id, message: '' });
    void refresh();
  }, [project.id, refresh]);

  const scoped = snapshot.projectId === project.id ? snapshot : emptySnapshot(project.id);
  const current = scoped.tasks.find(task => task.id === selectedTaskId) ?? scoped.tasks[0];
  const active = scoped.tasks.find(task => ['queued', 'running'].includes(task.status));
  const stale = Boolean(current && current.manuscriptRevision !== manuscriptRevision(project));
  const action = full15PanelAction(current, stale);
  const busy = busyProject === project.id;
  const error = errorState.projectId === project.id ? errorState.message : '';
  const report = current?.report ? full15ReportView(current.report) : null;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { void refresh(); }, 1200);
    return () => window.clearInterval(timer);
  }, [active?.id, active?.status, refresh]);

  async function run(requestedAction: 'start' | 'retry' | 'cancel') {
    const projectId = project.id;
    setBusyProject(projectId); setErrorState({ projectId, message: '' });
    try {
      if (requestedAction === 'cancel' && active) await full15Action(active.id, requestedAction);
      else if (requestedAction === 'retry' && current) await full15Action(current.id, requestedAction);
      else await startFull15(project);
      if (activeProject.current === projectId) await refresh();
    } catch (cause) {
      if (activeProject.current === projectId) setErrorState({ projectId, message: cause instanceof Error ? cause.message : '全文检查未能开始。' });
    } finally {
      setBusyProject(value => value === projectId ? '' : value);
    }
  }

  function quoteLocation(quote: string): ReviewEvidenceLocation | null {
    const matches = project.chapters.flatMap(chapter => { const values: ReviewEvidenceLocation[] = []; let from = 0, start;
      while ((start = chapter.body.indexOf(quote, from)) >= 0) { values.push({ chapterId: chapter.id, start, quote, label: 'C01–C06 报告引文' }); from = start + Math.max(1, quote.length); }
      return values; });
    return matches.length === 1 ? matches[0] : null;
  }

  const buttonLabel = action === 'retry' ? (current?.status === 'interrupted' ? '继续检查' : '重新检查') : current ? '检查当前版本' : '开始检查';
  return <section className="mx-6 mb-4 rounded-3xl border border-border-button-default bg-tw-glass p-4" aria-label="全文辅助检查">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-body-medium">全文辅助检查</h3><p className="text-caption-1-regular text-text-secondary">C01–C06 限定检查，独立于成稿任务；不会自动改正文。</p></div>
      <div className="flex items-center gap-2">{current && ['queued', 'running'].includes(current.status) && <Button size="small" variant="ghost" disabled={busy} onClick={() => void run('cancel')}>取消检查</Button>}<Button size="small" variant="secondary" leadingIcon={current ? RiRefreshLine : RiPlayLine} disabled={busy || hasUnsavedDraft || !scoped.available || action === null} onClick={() => action && void run(action)}>{buttonLabel}</Button></div></div>
    <p className="mt-2 text-caption-1-regular text-text-secondary">检查范围以本次任务的报告状态为准；未评估、不适用或证据不足的项目会分别标明。</p>
    {hasUnsavedDraft && <p className="mt-3 text-caption-1-regular text-text-secondary">请先保存当前编辑，再提交这份稿件的固定副本。</p>}
    {!scoped.available && <p className="mt-3 text-caption-1-regular text-text-secondary">全文检查暂不可用。你可以继续编辑或导出正文，稍后刷新页面再试。</p>}
    {scoped.tasks.length > 1 && <details className="mt-3"><summary className="cursor-pointer text-caption-1-medium text-text-secondary">历史检查 · {scoped.tasks.length} 次</summary><div className="mt-2 flex flex-wrap gap-2">{scoped.tasks.map((task,index)=><Button key={task.id} size="xs" variant="ghost" aria-pressed={task.id === current?.id} onClick={()=>setSelectedTaskId(task.id)}>{index + 1} · {task.manuscriptRevision === manuscriptRevision(project) ? names[task.status] : '旧版本'}</Button>)}</div></details>}
    {current && <div className="mt-3 flex flex-col gap-2"><p className="text-body-2-medium" role="status">{stale ? '报告对应另一版稿件，请检查当前版本' : names[current.status]}</p>
      <p className="text-caption-1-regular text-text-secondary">{current.progress.completedStages}/2 个分析阶段已保存{current.trigger === 'automatic' ? ' · 成稿后排队' : current.trigger === 'retry' ? ' · 重新检查' : ' · 手动发起'}。{stale ? '旧记录继续保留，不代表当前稿已检查。' : ''}</p>
      {current.error && <p className="text-caption-1-regular text-text-error-primary">{current.error.message}</p>}
      {report && <details className="border-t border-separator-border pt-3"><summary className="cursor-pointer text-body-2-medium">查看检查结果</summary><div className="mt-3 flex flex-col gap-4">
        <p className="text-caption-1-regular text-text-secondary">{report.scopeText}</p>
        {report.checks.map(check => <section key={check.id} className="rounded-2xl border border-separator-border p-3" aria-label={`${check.id} ${check.name}`}><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-body-2-medium">{check.id} · {check.name}</h4><span className="text-caption-1-regular text-text-secondary">{check.statusLabel}</span></div><p className="mt-2 text-body-2-regular text-text-secondary">{check.summary}</p>{check.quotes.map((quote, index) => { const location=quoteLocation(quote); return <blockquote key={index} className="mt-2 border-l-2 border-separator-border pl-3 text-caption-1-regular text-text-secondary">“{quote}”{location&&<Button className="ml-2" size="xs" variant="ghost" disabled={stale} onClick={()=>onLocate(location,current.manuscriptRevision)}>跳到原文</Button>}</blockquote>; })}</section>)}
        <section><h4 className="text-body-2-medium">需核对的问题</h4>{report.issues.length ? report.issues.map(issue => <article key={issue.id} className="mt-3"><p className="text-body-2-medium">{issue.priority ? '优先核对 · ' : ''}{issue.checkId ? `${issue.checkId} ${issue.checkName}` : issue.checkName}</p><p className="mt-1 text-body-2-regular text-text-secondary">{issue.summary}</p>{issue.suggestedVerification && <p className="mt-1 text-caption-1-regular text-text-secondary">建议核对：{issue.suggestedVerification}</p>}{issue.quotes.map((quote, index) => { const location=quoteLocation(quote); return <blockquote key={index} className="mt-2 border-l-2 border-separator-border pl-3 text-caption-1-regular text-text-secondary">“{quote}”{location&&<Button className="ml-2" size="xs" variant="ghost" disabled={stale} onClick={()=>onLocate(location,current.manuscriptRevision)}>跳到原文</Button>}</blockquote>; })}</article>) : <p className="mt-2 text-body-2-regular text-text-secondary">本轮没有记录问题条目；这不表示稿件不存在问题。</p>}</section>
        {report.limitations.length > 0 && <section><h4 className="text-body-2-medium">报告限制</h4>{report.limitations.map((limitation, index) => <p key={index} className="mt-1 text-caption-1-regular text-text-secondary">{limitation}</p>)}</section>}
        <p className="text-caption-1-regular text-text-secondary">完成仅表示本次 C01–C06 范围已运行，不等同于文学质量通过、平台审核通过或发布许可。</p>
      </div></details>}
    </div>}
    {error && <p className="mt-3 text-caption-1-regular text-text-error-primary" role="alert">{error}</p>}
  </section>;
}
