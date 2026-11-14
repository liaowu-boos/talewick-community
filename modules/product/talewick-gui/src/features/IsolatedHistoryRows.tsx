import {useLayoutEffect, useRef, useState} from 'react';
import {Button} from '@/components/base/buttons/button';
import {manuscriptRevision} from '@/model/runtime';
import type {Project} from '@/model/types';

import type {IsolatedHistoryRecord} from '@/model/independent-review';

type Props = {project: Project; reports: IsolatedHistoryRecord[]; hasUnsavedDraft: boolean};
type Selection =
  | {id: string; status: 'loading'}
  | {id: string; status: 'open'; html: string}
  | {id: string; status: 'error'; message: string};

function createdLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

export function IsolatedHistoryRows({project, reports, hasUnsavedDraft}: Props) {
  const revision = manuscriptRevision(project);
  // Reset the viewer on draft transitions as well as on changes to the saved manuscript.
  return <HistoryRows key={JSON.stringify([project.id, project.title, project.chapters, hasUnsavedDraft])} project={project} reports={reports} hasUnsavedDraft={hasUnsavedDraft} revision={revision} />;
}

function HistoryRows({project, reports, hasUnsavedDraft, revision}: Props & {revision: string}) {
  const [filter, setFilter] = useState<'all' | 'current'>('all');
  const [selection, setSelection] = useState<Selection | null>(null);
  const pending = useRef<{controller: AbortController; timer: ReturnType<typeof setTimeout>} | null>(null);
  const visibleReports = filter === 'current' ? reports.filter(report => report.manuscriptRevision === revision) : reports;
  const selectionVisible = selection !== null && visibleReports.some(report => report.id === selection.id && report.manuscriptRevision === revision);

  function cancelPending() {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    pending.current.controller.abort();
    pending.current = null;
  }

  useLayoutEffect(() => cancelPending, []);
  useLayoutEffect(() => {
    if (selection && !selectionVisible) {
      cancelPending();
      setSelection(null);
    }
  }, [selection, selectionVisible]);

  function close() {
    cancelPending();
    setSelection(null);
  }

  async function open(report: IsolatedHistoryRecord) {
    if (hasUnsavedDraft || report.manuscriptRevision !== revision) return;
    cancelPending();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (pending.current?.controller !== controller) return;
      controller.abort();
      pending.current = null;
      setSelection({id: report.id, status: 'error', message: '打开报告超时，请重试。'});
    }, 15000);
    pending.current = {controller, timer};
    setSelection({id: report.id, status: 'loading'});
    try {
      const response = await fetch(`/api/isolated-reports/${encodeURIComponent(report.id)}/open`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'text/html'},
        mode: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
        body: JSON.stringify({projectId: project.id, title: project.title, chapters: project.chapters, manuscriptRevision: revision}),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(typeof failure?.error === 'string' ? failure.error : `无法打开报告（HTTP ${response.status}）。`);
      }
      const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if (mime !== 'text/html') throw new Error('服务器返回的报告格式有误。');
      const html = await response.text();
      if (!html.trim()) throw new Error('报告内容为空。');
      if (!controller.signal.aborted) setSelection({id: report.id, status: 'open', html});
    } catch (cause) {
      if (!controller.signal.aborted) {
        setSelection({id: report.id, status: 'error', message: cause instanceof Error ? cause.message : '读取报告失败，请重试。'});
      }
    } finally {
      clearTimeout(timer);
      if (pending.current?.controller === controller) pending.current = null;
    }
  }

  return <>
    <div role="group" aria-label="三路报告筛选" className="flex flex-wrap gap-2">
      <Button type="button" size="xs" variant={filter === 'all' ? 'primary' : 'secondary'} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部报告</Button>
      <Button type="button" size="xs" variant={filter === 'current' ? 'primary' : 'secondary'} aria-pressed={filter === 'current'} onClick={() => setFilter('current')}>当前版本</Button>
    </div>
    {visibleReports.length === 0 && <p role="status" className="text-caption-1-regular text-text-secondary">{filter === 'current' ? '当前版本暂无三路报告。' : '暂无三路报告。'}</p>}
    {hasUnsavedDraft && <p className="text-caption-1-regular text-text-secondary">请先保存或撤回正文修改，再打开对应版本的三路报告。</p>}
    {visibleReports.map(report => {
    const stale = report.manuscriptRevision !== revision;
    const current = selectionVisible && !stale && selection?.id === report.id ? selection : null;
    return <article key={report.id} className="flex flex-col gap-2 rounded-xl border border-separator-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0"><h4 className="break-words text-body-2-medium">{report.title}</h4>
          <p className="text-caption-1-regular text-text-secondary">{report.synthetic ? '合成演示 · ' : ''}{(report.version === 'A' || report.version === 'B') && `本轮匿名稿 ${report.version} · `}<time dateTime={report.createdAt}>{createdLabel(report.createdAt)}</time></p>
        </div>
        {current?.status === 'loading' ? <Button type="button" size="xs" variant="secondary" onClick={close}>取消打开</Button> : current?.status === 'open' ? <Button type="button" size="xs" variant="secondary" onClick={close}>关闭报告</Button> :
          <Button type="button" size="xs" variant="secondary" disabled={hasUnsavedDraft || stale} onClick={() => void open(report)}>
            打开三路报告
          </Button>}
      </div>
      {stale && <p className="text-caption-1-regular text-text-secondary">此报告对应其他稿件版本，请切换到对应版本后查看。</p>}
      {current?.status === 'loading' && <p role="status" className="text-caption-1-regular text-text-secondary">正在打开报告…</p>}
      {current?.status === 'error' && <p role="alert" className="text-caption-1-regular text-text-error-primary">{current.message}</p>}
      {current?.status === 'open' && <iframe title={report.title} sandbox="" referrerPolicy="no-referrer" srcDoc={current.html}
        className="h-96 w-full rounded-xl border border-border-button-default bg-background-primary-default" />}
    </article>;
  })}</>;
}
