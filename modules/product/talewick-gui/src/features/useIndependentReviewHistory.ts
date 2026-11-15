import {useCallback, useEffect, useRef, useState} from 'react';
import {listIndependentReviews, type IndependentReviewTask, type IsolatedHistoryRecord} from '@/model/independent-review';

const empty = (projectId: string) => ({ projectId, available: false, readingFocusVersions: [] as string[], modelCitationModes: [] as string[], isolatedReports: [] as IsolatedHistoryRecord[], tasks: [] as IndependentReviewTask[] });

export function useIndependentReviewHistory(projectId: string) {
  const [snapshot, setSnapshot] = useState(() => empty(projectId));
  const [readingHistory, setReadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const activeProject = useRef(projectId), sequence = useRef(0); activeProject.current = projectId;
  const pendingHistory = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (activeProject.current !== projectId) return;
    pendingHistory.current?.abort();
    const controller = new AbortController();
    pendingHistory.current = controller;
    const current = ++sequence.current;
    const isCurrent = () => activeProject.current === projectId && current === sequence.current;
    setReadingHistory(true);
    try {
      const value = await listIndependentReviews(projectId, controller.signal);
      if (isCurrent()) {
        setSnapshot({ ...value, projectId });
        setHistoryError('');
      }
    } catch (cause) {
      if (isCurrent() && !controller.signal.aborted) setHistoryError(cause instanceof Error ? cause.message : '评阅历史暂时无法读取。');
    } finally {
      if (isCurrent()) setReadingHistory(false);
      if (pendingHistory.current === controller) pendingHistory.current = null;
    }
  }, [projectId]);
  useEffect(() => {
    sequence.current += 1;
    setSnapshot(empty(projectId));
    setHistoryError('');
    void refresh();
    return () => {
      sequence.current += 1;
      pendingHistory.current?.abort();
      pendingHistory.current = null;
    };
  }, [projectId, refresh]);
  const scoped = snapshot.projectId === projectId ? snapshot : empty(projectId);
  const active = scoped.tasks.find(task => ['queued', 'running'].includes(task.status));
  useEffect(() => {
    if (!active || readingHistory) return;
    const timer = window.setTimeout(() => { void refresh(); }, 1200);
    return () => window.clearTimeout(timer);
  }, [active?.id, active?.status, readingHistory, refresh]);

  return {scoped, active, historyError, readingHistory, refresh};
}
