import { useEffect, useRef, useState } from 'react';
import { FileTrigger, Pressable, ProgressBar } from 'react-aria-components';
import { Button } from '@/components/base/buttons/button';
import { Select, SelectItem } from '@/components/base/select/select';
import { DialogShell } from './shared';
import { libraryAPI, reviewCheckLabels, reviewCheckStatusLabels, sourceStatus, indexRebuildActive, canRetryIndex, failureStage, candidateText, diagnosticText, type Completeness, type SourceSummary, type SourceDetail, type SourceText } from '@/model/library';
import type { LibraryItem } from '@/model/types';
import './source-library.css';
import { AnalysisRevisions } from './AnalysisRevisions';
import { LibraryBatchProgress } from './LibraryBatchProgress';
import { batchActionAllowed, batchErrorMessage, batchRegistrationAllowed, canCancelSource, canRetryAnalysis, createBatchRequestGate, libraryBatchAPI, prepareBatchImport, type BatchActionKey, type BatchImport, type BatchResponse } from '@/model/library';
const scopes = { unknown: '范围未知', full: '全文', first_four: '前四章' };
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
type Upload = { file: File; requestId: string; completeness: Completeness; error?: string };

export function SourceLibrary({ uploadOpen, onClose, legacyItem }: { uploadOpen: boolean; onClose: () => void; legacyItem: LibraryItem | null }) {
  const [items, setItems] = useState<SourceSummary[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [pages, setPages] = useState(1);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [uploadError, setUploadError] = useState('');
  const closeReader = () => { setSelected(null); requestAnimationFrame(() => returnFocus.current?.focus({ preventScroll: true })); };
  const [scope, setScope] = useState<Completeness>('unknown');
  const [uploading, setUploading] = useState('');
  const [failed, setFailed] = useState<Upload[]>([]);
  const busy = useRef(false);
  const [batchState, setBatchState] = useState<BatchResponse | null>(null);
  const [batchStale, setBatchStale] = useState(true);
  const [batchReadError, setBatchReadError] = useState('');
  const [batchOperationError, setBatchOperationError] = useState('');
  const [batchNotice, setBatchNotice] = useState('');
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchExpanded, setBatchExpanded] = useState(false);
  const [batchScope, setBatchScope] = useState<Completeness>('unknown');
  const [batchImport, setBatchImport] = useState<BatchImport | null>(null);
  const importRef = useRef<BatchImport | null>(null);
  const [batchPending, setBatchPending] = useState<string[]>([]);
  const [deepStatus, setDeepStatus] = useState<{ available: boolean; sourceCount?: number; installId?: string; boundary?: string;
    frozenCatalogSnapshotSha256?: string; liveBoundSourcesSha256?: string; reason?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch('/api/runtime').then(response => response.json()).then(value => { if (alive) setDeepStatus(value.deepReferences ?? { available: false, reason: 'unavailable' }); }).catch(() => { if (alive) setDeepStatus({ available: false, reason: 'runtime_unavailable' }); });
    return () => { alive = false; };
  }, [refresh]);
  const requestGate = useRef(createBatchRequestGate());
  // Keep a late GET, started before an operation, from re-enabling its controls.
  const acceptBatchState = (result: BatchResponse) => {
    setBatchState(result); setBatchStale(false); setBatchReadError('');
    if (importRef.current && result.queue.batches.some(batch => batch.batchId === importRef.current?.batchId)) {
      importRef.current = null; setBatchImport(null); setBatchOperationError('');
      setBatchNotice('已确认本批 10 篇登记。登记只保存原文，请在批量任务区查看状态并开始。');
    }
  };
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      const version = requestGate.current.revision();
      const sources = async () => {
       try {
        const summaries: SourceSummary[] = []; let cursor: string | undefined;
        for (let page = 0; page < pages; page++) {
          const result = await libraryAPI.list(cursor, controller.signal);
          summaries.push(...result.items); cursor = result.nextCursor || undefined;
          if (!cursor) break;
        }
        if (alive) { setItems([...new Map(summaries.map(item => [item.sourceId, item])).values()]); setNextCursor(cursor || null); setError(''); }
      } catch (reason) { if (alive) setError(message(reason)); }
       finally { if (alive) setLoaded(true); }
      };
      const batches = async () => {
        try {
          const result = await libraryBatchAPI.progress(controller.signal);
          if (alive && requestGate.current.accepts(version) && !requestGate.current.pending.size) acceptBatchState(result);
        } catch (reason) {
          if (alive && requestGate.current.accepts(version)) { setBatchReadError(batchErrorMessage(reason)); setBatchStale(true); }
        }
      };
      await Promise.allSettled([sources(), batches()]);
      if (alive) timer = setTimeout(poll, 2500);
    }
    void poll(); return () => { alive = false; clearTimeout(timer); controller.abort(); };
  }, [pages, refresh]);
  const upload = async (jobs: Upload[]) => {
    if (busy.current) return;
    busy.current = true; onClose();
    try {
      for (const job of jobs) {
        setUploading(`正在上传《${job.file.name}》`);
        try {
          await libraryAPI.upload(job.file, job.completeness, job.requestId);
          setFailed(values => values.filter(value => value.requestId !== job.requestId));
          setRefresh(value => value + 1);
        } catch (reason) { setFailed(values => [...values.filter(value => value.requestId !== job.requestId), { ...job, error: message(reason) }]); }
      }
    } finally { busy.current = false; setUploading(''); }
  };
  const choose = (files: FileList | null) => {
    if (!files) return;
    if (files.length > 20) { setUploadError('每次最多选择 20 份文件，请分批上传。'); return; }
    setUploadError('');
    void upload(Array.from(files).map(file => ({ file, completeness: scope, requestId: crypto.randomUUID() })));
  };
  const performBatchWork = async (key: string, work: () => Promise<BatchResponse>) => {
    const ticket = requestGate.current.begin(key);
    if (ticket === null) return;
    setBatchPending([...requestGate.current.pending]);
    setBatchOperationError(''); setBatchNotice('');
    try {
      const result = await work();
      if (requestGate.current.accepts(ticket)) acceptBatchState(result);
      else setBatchStale(true);
    }
    catch (reason) { setBatchOperationError(batchErrorMessage(reason)); setBatchStale(true); }
    finally {
      requestGate.current.finish(key); setBatchPending([...requestGate.current.pending]);
      setRefresh(value => value + 1);
    }
  };
  const chooseBatch = (files: FileList | null) => {
    if (!files || importRef.current || !batchRegistrationAllowed(batchState, [...requestGate.current.pending], batchStale)) return;
    void performBatchWork('register', async () => {
      const payload = await prepareBatchImport(Array.from(files), batchScope);
      importRef.current = payload; setBatchImport(payload); setBatchOpen(false); setBatchExpanded(true);
      return libraryBatchAPI.register(payload);
    });
  };
  const retryRegistration = () => {
    const payload = importRef.current;
    if (!payload || !batchRegistrationAllowed(batchState, [...requestGate.current.pending], batchStale, payload.batchId)) return;
    void performBatchWork('register', () => libraryBatchAPI.register(payload));
  };
  const batchAction = (key: BatchActionKey) => {
    if (!batchActionAllowed(batchState, key, [...requestGate.current.pending], batchStale)) return;
    void performBatchWork(key, () => libraryBatchAPI.action(key));
  };
  const batchSources = new Set(batchState?.queue.registrations.flatMap(batch => batch.sources.flatMap(source => source ? [source.sourceId] : [])) ?? []);
  const isBatchSource = (source?: SourceSummary) => Boolean(source && (batchSources.has(source.sourceId) || source.duplicateOf && batchSources.has(source.duplicateOf)));
  return <section className="source-library" aria-label="后台小说库">
    <div className="source-library-heading"><h2 className="font-story text-title-2-medium">小说拆解</h2><Button variant="ghost" size="small" onClick={() => setRefresh(value => value + 1)}>刷新状态</Button></div>
    <p className="text-body-regular text-text-secondary">上传后在本机后台保存，并由已配置的模型服务分析。创作可从可用结果中查找少量相关材料。</p>
    <section className="mt-3 rounded-xl border border-border-button-default bg-tw-glass p-3" aria-label="深层参考状态"><p className="text-body-2-medium">{deepStatus?.available ? `${deepStatus.sourceCount ?? 0}份深层参考：已接通，可按问题查询` : deepStatus ? '深层参考：当前未接通' : '深层参考：正在检查连接'}</p>
      <p className="mt-1 text-caption-1-regular text-text-secondary">分析用于提供写作参考；是否适合当前故事、是否实际采用，会在创作结果中分别记录。</p>
      <details className="mt-2 text-caption-1-regular text-text-tertiary"><summary className="cursor-pointer">数据来源与校验信息</summary>
        {deepStatus?.available ? <><p className="mt-1 break-all">安装标识 {deepStatus.installId}</p><p className="mt-1 break-all">参考边界 {deepStatus.boundary}</p>
          <p className="mt-1 break-all">冻结目录快照 SHA {deepStatus.frozenCatalogSnapshotSha256}</p><p className="mt-1 break-all">当前 {deepStatus.sourceCount ?? 0} 项绑定 SHA {deepStatus.liveBoundSourcesSha256}</p></> : <p className="mt-1 break-all">{deepStatus?.reason || '正在检查本机安装'}</p>}
      </details></section>
    <div className="mt-3 flex flex-wrap items-center gap-3"><Button variant="secondary" size="small" onClick={() => setBatchOpen(true)}>批量拆解（每批10篇）</Button><p className="text-body-2-regular text-text-tertiary">先登记，再手动开始；普通上传照常使用。</p></div>
    {batchReadError && <p role="alert" className="mt-3 text-body-regular text-text-error-primary">{batchReadError} 已显示的批量状态保留，操作暂不可用。</p>}
    {batchOperationError && <p role="alert" className="mt-3 text-body-regular text-text-error-primary">{batchOperationError}</p>}
    {batchNotice && <p role="status" className="mt-3 text-body-regular text-text-secondary">{batchNotice}</p>}
    {batchPending.includes('register') && <p role="status" className="mt-3 text-body-regular">正在登记这 10 篇原文，尚未请求开始拆解……</p>}
    {batchImport && !batchPending.includes('register') && <div className="mt-3 flex flex-col items-start gap-2"><p className="text-body-regular text-text-secondary">本批登记尚未确认，已保留本次选择的 10 份文件。继续登记会沿用原记录，不会开始分析。</p><div className="flex flex-wrap gap-2"><Button variant="secondary" size="small" disabled={!batchRegistrationAllowed(batchState, batchPending, batchStale, batchImport.batchId)} onClick={retryRegistration}>继续登记本批</Button><Button variant="ghost" size="small" disabled={batchStale || batchPending.length > 0} onClick={() => { importRef.current = null; setBatchImport(null); setBatchNotice('本次文件选择已结束，后台已保存的原文和登记记录仍保留。'); }}>结束本次选择</Button></div><p className="text-body-2-regular text-text-tertiary">文件需更换时可结束本次选择，再选择一组文件登记；后台原记录不会删除。</p></div>}
    {batchState && <LibraryBatchProgress state={batchState} expanded={batchExpanded} onExpand={() => setBatchExpanded(value => !value)} pending={batchPending} stale={batchStale} onAction={batchAction} />}
    {uploading && <p role="status" className="text-body-medium">{uploading}，接收成功后自动排队拆解。</p>}
    {failed.map(job => <div key={job.requestId} className="source-upload-error"><p role="alert" className="text-body-regular text-text-error-primary">《{job.file.name}》上传未确认：{job.error}</p><Button size="small" variant="secondary" disabled={Boolean(uploading)} onClick={() => void upload([job])}>重试上传</Button></div>)}
    {error && <p role="alert" className="text-body-regular text-text-error-primary">{error} 已显示的状态保留，等待重新连接。</p>}
    {!loaded && <p role="status" className="text-body-regular">正在读取小说列表……</p>}
    {loaded && !error && !items.length && <p className="source-empty text-body-regular text-text-tertiary">还没有后台小说。上传一篇作品，拆解结果会保存在这里。</p>}
    <div className="source-library-layout">
      <div className="source-list">{items.map(source => <SourceRow key={source.sourceId} source={source} batchManaged={isBatchSource(source)} onBatch={() => setBatchExpanded(true)} expanded={selected === source.sourceId} onOpen={() => { if (selected === source.sourceId) closeReader(); else { returnFocus.current = document.activeElement as HTMLElement; setSelected(source.sourceId); } }} onChange={() => setRefresh(value => value + 1)} />)}
        {nextCursor && <Button variant="secondary" onClick={() => setPages(value => value + 1)}>加载更多作品</Button>}
      </div>
      {selected && <SourceReader key={selected} id={selected} batchManaged={batchSources.has(selected) || isBatchSource(items.find(item => item.sourceId === selected))} updatedAt={items.find(item => item.sourceId === selected)?.updatedAt} onClose={closeReader} onChange={() => setRefresh(value => value + 1)} />}
    </div>
    <DialogShell title={legacyItem ? `送去拆解：${legacyItem.title}` : '上传小说'} description="每份最多 128,000 字节、24,000 字符；每次最多 20 份，逐文件提交。原文件保存在本机后台，文字会发送给已配置的模型服务分析。" open={uploadOpen} onClose={onClose} className="secondary-form-dialog">
      <p className="mb-2 text-body-medium">这份文本的范围（你的声明）</p><Select aria-label="这份文本的范围（你的声明）" selectedKey={scope} onSelectionChange={value => setScope(String(value) as Completeness)}>{Object.entries(scopes).map(([key, label]) => <SelectItem key={key} id={key}>{label}</SelectItem>)}</Select>
      {uploadError && <p role="alert" className="text-body-regular text-text-error-primary">{uploadError}</p>}
      <div className="mt-6">{legacyItem ? <><p className="mb-4 text-body-regular text-text-secondary">将上传当前浏览器保存的文字副本，原资料和稿件继续保留。</p><Button disabled={Boolean(uploading)} onClick={() => void upload([{ file: new File([legacyItem.content], `${legacyItem.title.replace(/[\\/:*?"<>|]/g, '_')}.txt`, { type: 'text/plain' }), requestId: crypto.randomUUID(), completeness: scope }])}>上传副本并拆解</Button></> : <FileTrigger acceptedFileTypes={['.txt', '.md']} allowsMultiple onSelect={choose}><Pressable><Button disabled={Boolean(uploading)}>选择 TXT 或 Markdown 文件</Button></Pressable></FileTrigger>}</div>
    </DialogShell>
    <DialogShell title="批量拆解（每批10篇）" description="每次恰好选择 10 份 TXT 或 Markdown 文件；每份最多 128,000 字节、24,000 字符。同一任务最多 10 批、100 篇。登记只保存原文，点击开始后才会发送给已配置的模型服务。" open={batchOpen} onClose={() => setBatchOpen(false)} className="secondary-form-dialog">
      <p className="mb-2 text-body-medium">这批文本的范围（你的声明）</p><Select aria-label="这批文本的范围（你的声明）" selectedKey={batchScope} onSelectionChange={value => setBatchScope(String(value) as Completeness)}>{Object.entries(scopes).map(([key, label]) => <SelectItem key={key} id={key}>{label}</SelectItem>)}</Select>
      <p className="mt-4 text-body-regular text-text-secondary">成功登记后，返回批量任务区点击“开始已登记作品”。重复原文不能充数。</p>
      {batchOperationError && <p role="alert" className="mt-3 text-body-regular text-text-error-primary">{batchOperationError}</p>}
      {batchImport ? <p className="mt-3 text-body-regular">上一批登记尚未确认，请关闭窗口并继续登记本批。</p> : <div className="mt-4"><FileTrigger acceptedFileTypes={['.txt', '.md']} allowsMultiple onSelect={chooseBatch}><Pressable><Button disabled={!batchRegistrationAllowed(batchState, batchPending, batchStale)}>选择 10 份文件并登记</Button></Pressable></FileTrigger></div>}
      {!batchRegistrationAllowed(batchState, batchPending, batchStale) && !batchImport && <p className="mt-3 text-body-regular text-text-secondary">{batchState && batchState.queue.registrations.length >= 10 ? '当前任务已达到 10 批上限。' : '请先等待状态核对或当前操作结束；任务暂停时需先处理已有记录。'}</p>}
    </DialogShell>
  </section>;
}

function SourceRow({ source, batchManaged, onBatch, expanded, onOpen, onChange }: { source: SourceSummary; batchManaged: boolean; onBatch: () => void; expanded: boolean; onOpen: () => void; onChange: () => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);
  async function action(kind: 'cancel' | 'retry', stage?: 'analysis' | 'index') {
    if (actionPending.current || batchManaged || kind === 'cancel' && !canCancelSource(source)) return;
    actionPending.current = true;
    setBusy(true); setError(''); try { await libraryAPI.action(source.sourceId, kind, stage); onChange(); } catch (reason) { setError(message(reason)); } finally { actionPending.current = false; setBusy(false); }
  }
  const active = ['queued', 'running'].includes(source.status);
  const rebuildingIndex = indexRebuildActive(source);
  return <article className="source-row">
    <h3 className="text-headline-medium">{source.title}</h3>
    <p className="text-body-regular text-text-secondary">{sourceStatus(source)} · {scopes[source.completeness]}</p>
    {active && <ProgressBar aria-label={`${source.title}${source.activeRevisionId ? '修订' : rebuildingIndex ? '索引重建' : '拆解'}进度`} isIndeterminate={rebuildingIndex || Boolean(source.activeRevisionId) || source.progress.total === null || source.progress.total <= 0} value={source.progress.completed} maxValue={Math.max(1, source.progress.total ?? 1)} className="source-progress">{({ percentage, isIndeterminate }) => <><p className="text-body-2-regular text-text-tertiary">{source.activeRevisionId ? '正在处理修订，展开查看当前阶段' : rebuildingIndex ? sourceStatus(source) : source.progress.label}{!isIndeterminate && ` · ${Math.round(percentage ?? 0)}%`}</p><div className="source-progress-track"><div className={isIndeterminate ? 'source-progress-fill source-progress-indeterminate' : 'source-progress-fill'} style={isIndeterminate ? undefined : { width: `${percentage ?? 0}%` }} /></div></>}</ProgressBar>}
    {source.indexStatus !== 'failed' && <p className="text-body-2-regular text-text-tertiary">{source.status === 'deferred' ? '原文已保存，尚未开始分析。' : source.indexStatus === 'ready' && source.status !== 'completed' ? '原文可检索；分析是否通过复核请查看结果。' : { pending: '等待加入创作检索', ready: '已加入创作检索', stale: '检索需要更新' }[source.indexStatus]}</p>}
    {source.indexStatus === 'failed' && <p className="text-body-2-regular text-text-secondary">索引未完成；请查看详情确认拆解、复核状态。</p>}
    {source.error && <p className="text-body-2-regular text-text-error-primary">{source.error.message}</p>}
    <div className="source-row-actions"><Button variant="ghost" size="small" aria-expanded={expanded} onClick={onOpen}>{expanded ? '收起拆解结果' : '查看拆解结果'}</Button>
      {canCancelSource(source) && (batchManaged ? <Button variant="ghost" size="small" onClick={onBatch}>查看批量任务</Button> : <Button variant="ghost" size="small" disabled={busy} onClick={() => void action('cancel')}>{source.status === 'deferred' ? '取消登记' : rebuildingIndex ? '取消重建' : '取消拆解'}</Button>)}
    </div>{error && <p role="alert" className="text-body-regular text-text-error-primary">{error}</p>}

  </article>;
}

function SourceReader({ id, updatedAt, batchManaged, onClose, onChange }: { id: string; updatedAt?: string; batchManaged: boolean; onClose: () => void; onChange: () => void }) {
  const reader = useRef<HTMLElement | null>(null);
  useEffect(() => { reader.current?.focus({ preventScroll: true }); if (matchMedia('(max-width: 900px)').matches) reader.current?.scrollIntoView({ block: 'start' }); }, []);
  const [source, setSource] = useState<SourceDetail | null>(null); const [error, setError] = useState('');
  const [text, setText] = useState<SourceText | null>(null); const [textError, setTextError] = useState(''); const [reading, setReading] = useState(false);
  const [refresh, setRefresh] = useState(0); const textController = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void libraryAPI.get(id, controller.signal).then(result => { if (!controller.signal.aborted) setSource(result.source); }).catch(reason => { if (!controller.signal.aborted) setError(message(reason)); });
    return () => controller.abort();
  }, [id, updatedAt, refresh]);
  useEffect(() => () => textController.current?.abort(), []);
  const version = source?.analysis?.textVersion || source?.textVersion;
  useEffect(() => { setText(null); setTextError(''); textController.current?.abort(); setReading(false); }, [version]);
  async function readText() {
    if (!version) return; const controller = new AbortController(); textController.current = controller; setReading(true); setTextError('');
    try { const result = await libraryAPI.text(id, version, controller.signal); if (!controller.signal.aborted) setText(result.source); }
    catch (reason) { if (!controller.signal.aborted) setTextError(message(reason)); }
    finally { if (!controller.signal.aborted) setReading(false); }
  }
  const [indexBusy, setIndexBusy] = useState(false);
  async function retryIndex() {
    if (!source || batchManaged || !canRetryIndex(source) || indexBusy) return;
    setIndexBusy(true);
    try { await libraryAPI.action(id, 'retry', 'index'); setRefresh(value => value + 1); onChange(); }
    catch (reason) { setError(message(reason)); }
    finally { setIndexBusy(false); }
  }
  const analysis = source?.analysis;
  const review = analysis?.validation?.semanticReview;
  const reviewFailed = review?.outcome === 'failed';
  const rejected = Boolean(review && !review.approved && review.outcome !== 'failed');
  const [analysisBusy, setAnalysisBusy] = useState(false);
  async function retryAnalysis() {
    if (!source || !canRetryAnalysis(source, batchManaged) || analysisBusy) return;
    setAnalysisBusy(true); setError('');
    try { await libraryAPI.action(id, 'retry', 'analysis'); setRefresh(value => value + 1); onChange(); }
    catch (reason) { setError(message(reason)); }
    finally { setAnalysisBusy(false); }
  }
  return <aside ref={reader} tabIndex={-1} className="source-reader paper-panel outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring" aria-label="拆解详情">
    <div className="source-library-heading"><h2 className="font-story text-title-2-medium">{source?.title || '拆解详情'}</h2><Button variant="ghost" size="small" onClick={onClose}>收起</Button></div>
    {error && <><p role="alert" className="text-body-regular text-text-error-primary">{error}</p><Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>重试读取</Button></>}
    {!source && !error && <p role="status">正在读取拆解结果……</p>}
    {source && <p className="source-prose text-body-2-regular text-text-tertiary">来源登记：{source.sourceId}{source.duplicateOf ? ` · 与 ${source.duplicateOf} 为相同原文` : ''}</p>}
    {source && <p role="status" className="text-body-medium">{failureStage(source)}</p>}
    {batchManaged && <p className="text-body-regular text-text-secondary">此作品属于批量任务，开始、取消或恢复核对请使用上方批量任务区。核对不会重新分析失败作品。</p>}
    {source?.analysisDraft && <details className="source-unit"><summary className="text-body-medium outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring">查看未核对候选与诊断</summary>
      <p className="text-body-regular text-text-secondary">以下候选未通过拆解校验，未经复核，不用于创作检索。已有分析结果另行保留。</p>
      <p className="text-body-2-regular text-text-tertiary">候选对应文本版本：{source.analysisDraft.textVersion}</p>
      {source.analysisDraft.diagnostics.map((diagnostic, index) => <p key={index} className="source-prose text-body-regular text-text-error-primary">{diagnosticText(diagnostic)}</p>)}
      {!source.analysisDraft.diagnostics.length && <p className="text-body-regular">未提供具体诊断，请重试拆解。</p>}
      <pre className="source-prose text-body-regular">{candidateText(source.analysisDraft.candidate)}</pre>
    </details>}
    {reviewFailed && <p className="text-body-regular text-text-secondary">复核尚未形成有效结论，不代表批准或拒绝。已保存的候选分析尚未通过语义复核；结构与引用校验通过不等于内容正确。</p>}
    {source && Boolean(source.revisionCount) && <p className="text-body-regular text-text-secondary">已有修订历史，请展开具体尝试查看可用操作。仅符合条件的尝试可再次复核；内容修改请创建新修订。</p>}
    {source && rejected && <p className="text-body-regular text-text-secondary">语义复核未通过，原文、分析与复核意见已保留；此状态不支持直接重试拆解。分析尚未准入创作检索。{source.indexStatus === 'ready' ? '原文已加入检索，可作为未复核材料使用。' : '原文索引尚不可用，可查看已保存的原文。'}</p>}
    {source && canRetryAnalysis(source, batchManaged) && <div><Button variant="secondary" size="small" disabled={analysisBusy} onClick={() => void retryAnalysis()}>{reviewFailed ? '重试复核' : '重试拆解'}</Button><p className="text-body-2-regular text-text-tertiary">{reviewFailed ? '重试仅重新请求模型复核，可能产生费用；复用已保存的候选分析，保留原文和历史记录。' : '重试拆解可能重新请求模型（包括复核）并产生费用；已有结果和原文保留。'}</p></div>}
    {source?.indexStatus === 'stale' && <p className="text-body-regular text-text-secondary">检索需要更新。重建索引仅使用已保存的原文与分析，不会调用模型，也不会改变复核结论。</p>}
    {source && !batchManaged && canRetryIndex(source) && <Button variant="secondary" size="small" disabled={indexBusy || Boolean(error)} onClick={() => void retryIndex()}>{source.indexStatus === 'stale' ? '重建索引' : '重试加入检索'}</Button>}
    {source && !analysis && <p className="text-body-regular text-text-secondary">暂时没有已保存的分析结果。{sourceStatus(source)}。</p>}
    {source && analysis && <AnalysisRevisions source={source} onChange={() => { setRefresh(value => value + 1); onChange(); }} />}
    {analysis && <details className="source-unit"><summary className="text-headline-medium outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring">展开当前分析详情</summary><p className="text-body-2-regular text-text-tertiary">分析覆盖：{scopes[analysis.coverage.scope]} · {{ candidate: '候选分析，待复核', checked: '已复核', needs_review: '需要复核' }[analysis.reviewStatus]}</p><p className="source-prose text-body-regular">{analysis.overview}</p>
      {review && <section aria-label="语义复核记录"><p className="source-prose text-body-2-regular text-text-tertiary">复核记录：{review.recordId} · {review.outcome === 'failed' ? '处理失败' : review.approved ? '通过' : '未通过'} · {review.method} · {review.reviewedAt}</p><p className="text-body-medium">复核意见</p>{review.notes.map((note, index) => <p key={index} className="source-prose text-body-regular text-text-secondary">{note}</p>)}
        {review.checks?.length ? <><p className="source-prose text-body-2-regular text-text-tertiary">复核标准：{review.rubricVersion || '未标明版本'}。以下为复核者的逐项判断，不代表文学效果已获验证。</p>{review.checks.map((check, index) => <section key={`${check.id}-${index}`} className="source-unit" aria-label={reviewCheckLabels[check.id] || '其他复核项'}><h4 className="text-body-medium">{reviewCheckLabels[check.id] || '其他复核项'} · {reviewCheckStatusLabels[check.status] || '状态未知'}</h4>{check.unitIds.length > 0 && <p className="source-prose text-body-2-regular text-text-tertiary">关联单元：{check.unitIds.join('、')}</p>}{check.notes.map((note, noteIndex) => <p key={noteIndex} className="source-prose text-body-regular text-text-secondary">{note}</p>)}</section>)}</> : <p className="text-body-2-regular text-text-tertiary">此记录未提供逐项复核结果，保留原有复核意见。</p>}
      </section>}
      {[...analysis.coverage.notes, ...analysis.limitations].map((note, index) => <p key={index} className="text-body-regular text-text-secondary">{note}</p>)}
      {analysis.units.length === 0 && <p className="text-body-regular text-text-tertiary">尚未保存可查看的分析单元。</p>}
      {analysis.units.map(unit => <section key={unit.id} className="source-unit"><h3 className="text-headline-medium">{unit.title}</h3><p className="text-body-2-regular text-text-tertiary">第 {unit.locator.lineStart}–{unit.locator.lineEnd} 行</p><dl>{[['事件', unit.event], ['心理', unit.psychology], ['情绪', unit.emotion], ['表达', unit.expression], ['读者感受假设', unit.readerEffectHypothesis]].map(([label, value]) => <div key={label}><dt className="text-body-medium">{label}</dt><dd className="source-prose text-body-regular text-text-secondary">{value || '尚无充分分析'}</dd></div>)}</dl>{unit.evidence.map((evidence, index) => <blockquote key={index} className="source-prose text-body-regular">{evidence.quote}<footer className="text-body-2-regular text-text-tertiary">依据：第 {evidence.lineStart}–{evidence.lineEnd} 行</footer></blockquote>)}{unit.relatedUnitIds.length > 0 && <p className="text-body-2-regular text-text-tertiary">关联单元：{unit.relatedUnitIds.join('、')}</p>}</section>)}
    </details>}
    {source && <div className="source-original"><Button variant="secondary" disabled={reading} onClick={() => text ? setText(null) : void readText()}>{reading ? '正在读取原文' : text ? '收起原文' : '查看对应版本原文'}</Button>{textError && <p role="alert" className="text-body-regular text-text-error-primary">{textError}</p>}{text && <><p className="text-body-2-regular text-text-tertiary">{text.encoding} · 文本版本 {text.textVersion}</p><pre className="source-prose font-story text-headline-regular">{text.text}</pre></>}</div>}
  </aside>;
}
