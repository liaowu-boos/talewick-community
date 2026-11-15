import {useMemo} from 'react';
import {Button} from '@/components/base/buttons/button';
import type {IsolatedHistoryRecord} from '@/model/independent-review';
import {findReportVersions} from '@/model/report-version';
import type {Project, Version} from '@/model/types';
import {IsolatedHistoryRows} from './IsolatedHistoryRows';
import type {useIndependentReviewHistory} from './useIndependentReviewHistory';

interface Props {
  project: Project;
  version: Version;
  history: ReturnType<typeof useIndependentReviewHistory>;
  hasUnsavedDraft: boolean;
  reportId?: string;
}

export function SavedVersionReports({project, version, history, hasUnsavedDraft, reportId}: Props) {
  const {scoped, readingHistory, historyError, refresh} = history;
  // Older snapshots omit the book title. Keep each receipt's title with its chapters
  // so that the server can verify the original full-manuscript binding at open time.
  const groups = useMemo(() => {
    const reports = reportId === undefined ? scoped.isolatedReports : scoped.isolatedReports.filter(report => report.id === reportId);
    const matches = findReportVersions([version], reports);
    const grouped = new Map<string, IsolatedHistoryRecord[]>();
    for (const report of reports) {
      if (!matches.has(report.id)) continue;
      const rows = grouped.get(report.title);
      if (rows) rows.push(report);
      else grouped.set(report.title, [report]);
    }
    return grouped;
  }, [version, scoped.isolatedReports, reportId]);
  return <section aria-label="存稿评阅报告" className="mb-4 flex flex-col gap-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-body-medium">存稿评阅报告</h4>
      <Button type="button" size="xs" variant="secondary" disabled={readingHistory} onClick={() => void refresh()}>
        {readingHistory ? '正在读取…' : '刷新存稿报告'}
      </Button>
    </div>
    {version.title === undefined && groups.size > 0 && <p className="text-caption-1-regular text-text-secondary">此存稿未记录书名，报告列表使用登记时的书名。</p>}
    {historyError && <p role="alert" className="text-caption-1-regular text-text-error-primary">{historyError}</p>}
    {groups.size === 0 && !readingHistory && !historyError &&
      <p className="text-caption-1-regular text-text-secondary">{reportId ? '所选报告已不在此存稿的评阅历史中。' : '这份存稿暂无已登记的三路报告。'}</p>}
    {Array.from(groups, ([title, reports]) => <IsolatedHistoryRows key={title}
      project={{...project, title, chapters: version.chapters}} reports={reports}
      hasUnsavedDraft={hasUnsavedDraft} snapshotLabel={version.label}/>)}
  </section>;
}
