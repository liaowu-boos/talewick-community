import {useEffect, useRef, useState} from 'react';
import {Button} from '@/components/base/buttons/button';
import {manuscriptRevision} from '@/model/runtime';
import type {Project} from '@/model/types';

import type {IsolatedHistoryRecord} from '@/model/independent-review';

type Props = {project: Project; reports: IsolatedHistoryRecord[]};
type Selection =
  | {id: string; status: 'loading'}
  | {id: string; status: 'open'; html: string}
  | {id: string; status: 'error'; message: string};

function createdLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

export function IsolatedHistoryRows({project, reports}: Props) {
  const revision = manuscriptRevision(project);
  // Remount on either identity change so a previous iframe cannot survive a render.
  return <HistoryRows key={JSON.stringify([project.id, project.title, project.chapters])} project={project} reports={reports} revision={revision} />;
}

function HistoryRows({project, reports, revision}: Props & {revision: string}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  function close() {
    pending.current?.abort();
    pending.current = null;
    setSelection(null);
  }

  async function open(report: IsolatedHistoryRecord) {
    if (report.manuscriptRevision !== revision) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
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
      if (pending.current === controller) pending.current = null;
    }
  }

  return <>{reports.map(report => {
    const stale = report.manuscriptRevision !== revision;
    const current = !stale && selection?.id === report.id ? selection : null;
    return <article key={report.id} className="flex flex-col gap-2 rounded-xl border border-separator-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0"><h4 className="break-words text-body-2-medium">{report.title}</h4>
          <p className="text-caption-1-regular text-text-secondary">{report.synthetic ? '合成演示 · ' : ''}<time dateTime={report.createdAt}>{createdLabel(report.createdAt)}</time></p>
        </div>
        {current?.status === 'open' ? <Button type="button" size="xs" variant="secondary" onClick={close}>关闭报告</Button> :
          <Button type="button" size="xs" variant="secondary" disabled={stale || current?.status === 'loading'} onClick={() => void open(report)}>
            {current?.status === 'loading' ? '正在打开…' : '打开三路报告'}
          </Button>}
      </div>
      {stale && <p className="text-caption-1-regular text-text-secondary">此报告对应其他稿件版本，请切换到对应版本后查看。</p>}
      {current?.status === 'error' && <p role="alert" className="text-caption-1-regular text-text-error-primary">{current.message}</p>}
      {current?.status === 'open' && <iframe title={report.title} sandbox="" referrerPolicy="no-referrer" srcDoc={current.html}
        className="h-96 w-full rounded-xl border border-border-button-default bg-background-primary-default" />}
    </article>;
  })}</>;
}
