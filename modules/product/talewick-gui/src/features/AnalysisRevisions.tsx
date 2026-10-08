import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { TextAreaField } from './shared';
import { libraryAPI, revisionRequestRejected, revisionActive, revisionLabel, candidateText, diagnosticText, type RevisionSummary, type RevisionDetail, type SourceDetail } from '@/model/library';
const message = (reason: unknown) => reason instanceof Error ? reason.message : '操作失败，请刷新修订历史核对。';
export function AnalysisRevisions({ source, onChange }: { source: SourceDetail; onChange: () => void }) {
  const [open, setOpen] = useState(false); const [items, setItems] = useState<RevisionSummary[]>([]);
  const [pollError, setPollError] = useState('');
  const [loaded, setLoaded] = useState(false); const [error, setError] = useState(''); const [instructions, setInstructions] = useState('');
  const [selected, setSelected] = useState<string | null>(null); const [attempt, setAttempt] = useState<RevisionDetail | null>(null);
  const [historical, setHistorical] = useState<{ version: string; analysis: NonNullable<SourceDetail['analysis']> } | null>(null);
  const [busy, setBusy] = useState(false); const [uncertain, setUncertain] = useState(false); const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true); const operations = useRef(new Set<AbortController>()); const changed = useRef(onChange); changed.current = onChange;
  const wasActive = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const controller of operations.current) controller.abort(); }; }, []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let keepPolling = false;
      try {
        const result = await libraryAPI.revisions(source.sourceId, controller.signal);
        if (controller.signal.aborted) return;
        setItems(result.items); setLoaded(true); setPollError('');
        const active = result.items.some(item => revisionActive(item.status));
        keepPolling = active || Boolean(source.activeRevisionId) || ['queued', 'running'].includes(source.status);
        if (wasActive.current && !active) changed.current(); wasActive.current = active;
        if (selected) { const detail = await libraryAPI.revision(source.sourceId, selected, controller.signal); if (!controller.signal.aborted) setAttempt(detail.attempt); }
      } catch (reason) { if (!controller.signal.aborted) setPollError(message(reason)); }
      finally { if (!controller.signal.aborted && keepPolling) timer = setTimeout(poll, 1800); }
    }
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [open, source.sourceId, source.activeRevisionId, source.revisionCount, source.status, selected, refresh]);
  const active = items.some(item => revisionActive(item.status)) || ['queued', 'running'].includes(source.status);
  async function submit(reviewAttempt?: RevisionDetail) {
    const version = source.analysis?.version;
    if (!version || busy || active || uncertain || !loaded) return;
    if (reviewAttempt ? reviewAttempt.canRetryReview !== true : !instructions.trim() || instructions.length > 8000) return;
    const controller = new AbortController(); operations.current.add(controller); setBusy(true); setError('');
    try {
      const result = reviewAttempt
        ? await libraryAPI.retryRevisionReview(source.sourceId, reviewAttempt.revisionId, version, controller.signal)
        : await libraryAPI.revise(source.sourceId, version, instructions, controller.signal);
      if (!mounted.current) return;
      wasActive.current = true; setItems(values => [...values, result.attempt]); setSelected(result.attempt.revisionId); setAttempt(null); setHistorical(null); if (!reviewAttempt) setInstructions(''); setRefresh(value => value + 1); changed.current();
    } catch (reason) { if (mounted.current) { const uncertainResult = !revisionRequestRejected(reason); setError(uncertainResult ? `${message(reason)} 提交未确认时请先核对历史，不要重复提交。` : message(reason)); setUncertain(uncertainResult); changed.current(); } }
    finally { operations.current.delete(controller); if (mounted.current) setBusy(false); }
  }
  async function cancel() {
    if (busy) return; setBusy(true); setError('');
    const controller = new AbortController(); operations.current.add(controller);
    try { await libraryAPI.action(source.sourceId, 'cancel', undefined, controller.signal); if (mounted.current) { setRefresh(value => value + 1); changed.current(); } }
    catch (reason) { if (mounted.current) setError(message(reason)); }
    finally { operations.current.delete(controller); if (mounted.current) setBusy(false); }
  }
  async function readParent() {
    if (!attempt) return;
    const controller = new AbortController(); operations.current.add(controller); const version = attempt.parentAnalysisVersion;
    setHistorical(null); setError('');
    try { const result = await libraryAPI.historicalAnalysis(source.sourceId, version, controller.signal); if (!controller.signal.aborted) setHistorical({ version, analysis: result.source.analysis }); }
    catch (reason) { if (!controller.signal.aborted) setError(message(reason)); }
    finally { operations.current.delete(controller); }
  }
  function select(id: string) { for (const controller of operations.current) if (!busy) controller.abort(); setSelected(id); setAttempt(null); setHistorical(null); }
  const candidateReview = attempt?.candidate && typeof attempt.candidate === 'object' ? (attempt.candidate as NonNullable<SourceDetail['analysis']>).validation?.semanticReview : undefined;
  return <section className="source-unit" aria-label="分析修订">
    <Button variant="secondary" size="small" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '收起修订操作与历史' : '修订分析与查看历史'}</Button>
    {open && <div className="flex flex-col gap-4 mt-4">
      <p className="text-body-regular text-text-secondary">新修订会重新分析并独立复核，可能产生费用。仅发布成功才替换当前分析；失败、拒绝和旧版本都会保留。下方新建操作会产生新的拆解结果。</p>
      <p className="source-prose text-body-2-regular text-text-tertiary">本次提交绑定当前分析版本：{source.analysis?.version}</p>
      <TextAreaField label="修订意见" value={instructions} onChange={setInstructions} maxLength={8000} isDisabled={busy || active} placeholder="指出需要核对的事实归属、推断依据或引用范围。" />
      <p className="text-body-2-regular text-text-tertiary">{instructions.length} / 8000 字符</p>
      <Button variant="secondary" disabled={busy || active || uncertain || !loaded || !instructions.trim()} onClick={() => void submit()}>{busy ? '正在提交操作' : '创建新修订并复核'}</Button>
      {pollError && <p role="alert" className="text-body-regular text-text-error-primary">{pollError} 已有历史保留，可刷新重连。</p>}
      {error && <p role="alert" className="text-body-regular text-text-error-primary">{error}</p>}
      <Button variant="ghost" size="small" onClick={() => setRefresh(value => value + 1)}>刷新修订历史</Button>
      {uncertain && <><p className="text-body-regular">意见已保留。先刷新历史核对是否已创建尝试；版本冲突时还需核对已刷新的当前分析。</p><Button variant="secondary" size="small" disabled={active || !loaded} onClick={() => setUncertain(false)}>已核对，允许重新提交</Button></>}
      {!loaded && <p role="status">正在读取修订历史……</p>}
      {loaded && !items.length && <p className="text-body-regular text-text-tertiary">尚无修订尝试。</p>}
      {items.map(item => <div key={item.revisionId}><p className="source-prose text-body-regular">{item.kind === 'review_only' ? '仅复核 · ' : '修订 · '}{revisionLabel(item)} · {item.createdAt}</p><Button variant="ghost" size="small" onClick={() => select(item.revisionId)}>查看修订 {item.revisionId}</Button></div>)}
      {items.some(item => revisionActive(item.status)) && <Button variant="secondary" size="small" disabled={busy} onClick={() => void cancel()}>取消当前修订</Button>}
      {selected && !attempt && <p role="status">正在读取修订尝试……</p>}
      {attempt && <section key={attempt.revisionId} className="source-unit" aria-label="修订尝试详情"><h3 className="text-headline-medium">{revisionLabel(attempt)}</h3><p className="source-prose text-body-2-regular text-text-tertiary">修订：{attempt.revisionId} · 基于版本：{attempt.parentAnalysisVersion}</p>
        {attempt.kind === 'review_only' && <p className="text-body-regular text-text-secondary">本次仅复核，复用原尝试的已保存拆解结果，没有重新分析。</p>}
        {attempt.derivedFromRevisionId && <Button variant="ghost" size="small" onClick={() => select(attempt.derivedFromRevisionId!)}>查看原尝试 {attempt.derivedFromRevisionId}</Button>}
        {attempt.canRetryReview === true && <div><p className="text-body-regular text-text-secondary">可复用这次已保存的拆解结果，仅再次调用复核，可能产生费用。将创建新尝试，原历史不变。</p><Button variant="secondary" size="small" disabled={busy || active || uncertain || !loaded} onClick={() => void submit(attempt)}>重试复核</Button></div>}
        <p className="source-prose text-body-regular">修订意见：{attempt.instructions}</p>
        {attempt.status !== 'published' && <p className="text-body-regular text-text-secondary">本次尝试尚未发布。下方尝试候选与页面中的当前分析是不同记录；当前分析仍保留。</p>}
        {attempt.error && <p className="text-body-regular text-text-error-primary">{attempt.error.message}</p>}
        {attempt.diagnostics.map((diagnostic, index) => <p key={index} className="source-prose text-body-regular text-text-error-primary">{diagnosticText(diagnostic)}</p>)}
        {candidateReview && <div><p className="text-body-medium">本次候选复核：{candidateReview.outcome === 'failed' ? '处理失败' : candidateReview.approved ? '通过' : '未通过'}</p>{candidateReview.notes.map((note, index) => <p key={index} className="source-prose text-body-regular">{note}</p>)}</div>}
        <details className="source-unit"><summary className="text-body-medium">查看本次修订候选</summary><p className="text-body-2-regular text-text-secondary">这是本次尝试的候选；格式校验与复核状态以上方记录为准。</p><pre className="source-prose text-body-regular">{attempt.candidate ? candidateText(attempt.candidate) : '本次尚无可展示的候选；请查看诊断。'}</pre></details>
        <Button variant="ghost" size="small" onClick={() => void readParent()}>查看该次修订的父版本</Button>
        {historical && <details open className="source-unit"><summary className="source-prose text-body-medium">历史分析版本：{historical.version}</summary><pre className="source-prose text-body-regular">{candidateText(historical.analysis)}</pre></details>}
      </section>}
    </div>}
  </section>;
}
