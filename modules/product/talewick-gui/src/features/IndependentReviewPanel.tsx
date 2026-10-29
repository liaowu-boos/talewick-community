import { useCallback, useEffect, useRef, useState } from 'react';
import { RiBookOpenLine, RiEyeLine, RiPlayLine, RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { PARAGRAPH_CITATION_MODE, INDEPENDENT_READING_FOCUS_VERSION, comparableWholeQualityTask, canRetryInvalidIndependentReading, retryInvalidIndependentReading, independentReviewAction, independentReviewRecoveryModes, recoverIndependentReview, listIndependentReviews, startIndependentReview, type IndependentReviewTask } from '@/model/independent-review';
import { independentReviewView, independentReviewSnapshotForEvidence, isPartialBlindReport, type IndependentReviewSnapshot, type ReviewEvidenceLocation } from '@/model/independent-review-view';
import { manuscriptRevision } from '@/model/runtime';
import type { Project } from '@/model/types';
import { DialogShell } from '@/features/shared';

const statusNames: Record<IndependentReviewTask['status'], string> = { queued: '等待评阅', running: '独立评阅进行中', complete: '评阅记录已保存', interrupted: '评阅已中断', cancelled: '评阅已取消', needs_attention: '评阅需要处理', stale: '报告对应旧版本' };
const empty = (projectId: string) => ({ projectId, available: false, readingFocusVersions: [] as string[], modelCitationModes: [] as string[], tasks: [] as IndependentReviewTask[] });
interface SnapshotSelection { snapshot: IndependentReviewSnapshot; chapterId: string; evidence?: ReviewEvidenceLocation }

export function IndependentReviewStopReason({ error, partial = false }: { error: IndependentReviewTask['error']; partial?: boolean }) {
  if (!error) return null;
  return <div className="mt-2"><p className="text-caption-1-regular text-text-error-primary">{partial ? '目标核查未完成，已保留全文盲评记录。' : error.code === 'local_file_wait' ? '评阅文件尚未就绪，原任务与已有记录均保留。' : '本次评阅已停止，已完成的阶段和原始记录均保留。'}</p>
    <details className="mt-1"><summary className="cursor-pointer text-caption-1-medium">查看停止原因</summary><p className="mt-2 whitespace-pre-wrap break-words text-caption-1-regular text-text-secondary">{error.message}</p></details>
  </div>;
}

function FrozenSnapshotDialog({ selection, onChange, onClose }: { selection: SnapshotSelection | null; onChange: (value: SnapshotSelection) => void; onClose: () => void }) {
  const snapshot = selection?.snapshot, requestedChapterId = selection?.chapterId, requestedEvidence = selection?.evidence;
  const chapter = snapshot?.chapters.find(item => item.id === requestedChapterId) ?? snapshot?.chapters[0];
  const evidence = requestedEvidence?.chapterId === chapter?.id ? requestedEvidence : undefined;
  const exact = Boolean(chapter && evidence && chapter.body.slice(evidence.start, evidence.start + evidence.quote.length) === evidence.quote);
  return <DialogShell title={snapshot?.label ?? '冻结稿件'} description="这是评阅时封存的只读稿件，不会替换或改动当前编辑正文。" open={Boolean(selection)} onClose={onClose} className="tw-manuscript-version-dialog" footer={<Button onClick={onClose}>关闭</Button>}>
    {snapshot && chapter && <div className="flex flex-col gap-4">
      {snapshot.title && <p className="text-body-2-medium">{snapshot.title}</p>}
      <div className="flex flex-wrap gap-2" aria-label="选择冻结稿章节">{snapshot.chapters.map(item => <Button key={item.id} size="xs" variant={item.id === chapter.id ? 'primary' : 'secondary'} onClick={() => onChange({ snapshot, chapterId: item.id })}>{item.title}</Button>)}</div>
      {evidence && <div className="rounded-xl border border-border-button-default bg-background-tertiary-default p-3"><p className="text-caption-1-medium text-text-tertiary">{evidence.readerId ? `${evidence.readerId} · ` : ''}{evidence.label}</p><p className="mt-1 text-caption-1-regular text-text-secondary">匿名稿 {evidence.blindId || snapshot.blindId || 'M'} · {evidence.chapterId} · UTF-16 位置 {evidence.start}</p></div>}
      <article className="rounded-2xl border border-separator-border p-5"><h4 className="font-story text-title-2-medium">{chapter.title}</h4><div className="mt-4 whitespace-pre-wrap font-story text-manuscript">{exact && evidence ? <>{chapter.body.slice(0, evidence.start)}<mark className="rounded bg-tw-warm/20 px-0.5 text-inherit">{evidence.quote}</mark>{chapter.body.slice(evidence.start + evidence.quote.length)}</> : chapter.body}</div></article>
      {evidence && !exact && <p className="text-caption-1-regular text-text-error-primary">冻结快照中的位置与引文不一致，已停止高亮，避免指向错误文字。</p>}
    </div>}
  </DialogShell>;
}

export function IndependentReviewPanel({ project, hasUnsavedDraft, onLocate }: { project: Project; hasUnsavedDraft: boolean; onLocate: (location: ReviewEvidenceLocation, revision: string) => void }) {
  const [snapshot, setSnapshot] = useState(() => empty(project.id));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [citationMode, setCitationMode] = useState<typeof PARAGRAPH_CITATION_MODE | 'verbatim'>(PARAGRAPH_CITATION_MODE);
  const [snapshotSelection, setSnapshotSelection] = useState<SnapshotSelection | null>(null);
  const activeProject = useRef(project.id), sequence = useRef(0); activeProject.current = project.id;
  const refresh = useCallback(async () => {
    const projectId = project.id, current = ++sequence.current;
    try { const value = await listIndependentReviews(projectId); if (activeProject.current === projectId && current === sequence.current) { setSnapshot({ projectId, ...value }); setError(''); } }
    catch (cause) { if (activeProject.current === projectId && current === sequence.current) setError(cause instanceof Error ? cause.message : '独立评阅状态暂时无法读取。'); }
  }, [project.id]);
  useEffect(() => { sequence.current += 1; setSnapshot(empty(project.id)); setSnapshotSelection(null); setError(''); void refresh(); }, [project.id, refresh]);
  const scoped = snapshot.projectId === project.id ? snapshot : empty(project.id), currentRevision = manuscriptRevision(project);
  const focusedReadingAvailable = scoped.readingFocusVersions.includes(INDEPENDENT_READING_FOCUS_VERSION);
  const paragraphAvailable = scoped.modelCitationModes.includes(PARAGRAPH_CITATION_MODE);
  const selectedCitationUnavailable = citationMode === PARAGRAPH_CITATION_MODE && !paragraphAvailable;
  const active = scoped.tasks.find(task => ['queued', 'running'].includes(task.status));
  useEffect(() => { if (!active) return; const timer = window.setInterval(() => { void refresh(); }, 1200); return () => window.clearInterval(timer); }, [active?.id, active?.status, refresh]);

  async function run(mode: 'single' | 'compare') {
    setBusy(true); setError('');
    try { await startIndependentReview(project, mode, citationMode === PARAGRAPH_CITATION_MODE ? PARAGRAPH_CITATION_MODE : undefined); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '独立评阅未能开始。'); }
    finally { setBusy(false); }
  }
  async function act(task: IndependentReviewTask, action: 'cancel' | 'retry') {
    setBusy(true); setError('');
    try { await independentReviewAction(task.id, action); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '评阅任务操作失败。'); }
    finally { setBusy(false); }
  }
  async function recover(task: IndependentReviewTask, mode: 'whitespace_only' | 'position_repair') {
    setBusy(true); setError('');
    try { await recoverIndependentReview(task, mode); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '引文定位恢复未能开始。'); }
    finally { setBusy(false); }
  }
  async function retryInvalidReading(task: IndependentReviewTask) {
    setBusy(true); setError('');
    try { await retryInvalidIndependentReading(task); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '一次独立重读未能开始。'); }
    finally { setBusy(false); }
  }
  function openSnapshot(snapshot: IndependentReviewSnapshot, evidence?: ReviewEvidenceLocation) {
    setSnapshotSelection({ snapshot, chapterId: evidence?.chapterId ?? snapshot.chapters[0].id, ...(evidence ? { evidence } : {}) });
  }

  return <section className="mx-6 mb-4 rounded-3xl border border-border-button-default bg-tw-glass p-4" aria-label="独立全文评阅">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-body-medium">独立全文评阅</h3><p className="text-caption-1-regular text-text-secondary">新评审围绕六项阅读感受，保留引文、反向证据和不确定性；不会自动修改或采用正文。</p></div>
      <div className="flex flex-wrap gap-2"><Button size="small" variant="secondary" leadingIcon={RiEyeLine} disabled={busy || hasUnsavedDraft || Boolean(active) || !scoped.available || !focusedReadingAvailable || selectedCitationUnavailable} onClick={() => void run('single')}>全文评审</Button>
        <Button size="small" variant="secondary" leadingIcon={RiPlayLine} disabled={busy || hasUnsavedDraft || Boolean(active) || !scoped.available || !focusedReadingAvailable || selectedCitationUnavailable || !comparableWholeQualityTask(project)} onClick={() => void run('compare')}>修订盲评</Button></div></div>
    <div className="mt-3 flex flex-wrap items-center gap-2"><label className="text-caption-1-medium" htmlFor={`review-citation-mode-${project.id}`}>新评阅的证据定位</label><select id={`review-citation-mode-${project.id}`} className="rounded-lg border border-border-button-default bg-background-primary px-2 py-1 text-caption-1-regular" value={citationMode} disabled={busy || Boolean(active)} onChange={event => setCitationMode(event.target.value === PARAGRAPH_CITATION_MODE ? PARAGRAPH_CITATION_MODE : 'verbatim')}><option value={PARAGRAPH_CITATION_MODE}>段落证据定位</option><option value="verbatim">逐字引文（原方式）</option></select></div>
    {citationMode === PARAGRAPH_CITATION_MODE && <p className="mt-2 text-caption-1-regular text-text-secondary">按评阅时冻结正文中的段落定位证据，引文由程序逐字取回；已有评阅保持原样。</p>}
    {scoped.available && selectedCitationUnavailable && <p className="mt-2 text-caption-1-regular text-text-secondary">段落证据定位尚未接通；可明确选择原方式开始新评阅。</p>}
    {hasUnsavedDraft && <p className="mt-3 text-caption-1-regular text-text-secondary">请先保存当前编辑，评阅只接收固定版本。</p>}
    {!scoped.available && <p className="mt-3 text-caption-1-regular text-text-secondary">独立评阅适配器尚未接通；稿件仍可编辑、保存和导出。</p>}
    {scoped.available && !focusedReadingAvailable && <p className="mt-2 text-caption-1-regular text-text-secondary">六项阅读维度评审尚未接通；已有评阅与恢复记录仍可查看。</p>}
    {!comparableWholeQualityTask(project) && <p className="mt-2 text-caption-1-regular text-text-tertiary">候选盲评只对仍与当前原稿精确绑定的整稿质量候选开放；采纳或编辑后请评阅实际新版本。</p>}
    {scoped.tasks.length > 0 && <details className="mt-3 border-t border-separator-border pt-3" open={Boolean(active)}><summary className="cursor-pointer text-body-2-medium">评阅历史 · {scoped.tasks.length} 次</summary><div className="mt-3 flex flex-col gap-3">
      {scoped.tasks.map(task => {
        const partial = isPartialBlindReport(task.partialReport) ? task.partialReport : null;
        const stale = task.manuscriptRevision !== currentRevision, view = task.report || partial ? independentReviewView(task.report || partial, task.mode, { taskId: task.id, partialSnapshotProjection: task.partialSnapshotProjection }) : null;
        return <article key={task.id} className="rounded-2xl border border-separator-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-body-2-medium">{task.mode === 'single' ? '单稿独立初读' : '原稿/候选盲评'} · {stale ? '旧版本' : statusNames[task.status]}</p><p className="mt-1 text-caption-1-regular text-text-secondary">{task.readingFocusVersion === INDEPENDENT_READING_FOCUS_VERSION ? '六项阅读维度 · ' : ''}{task.modelCitationMode === PARAGRAPH_CITATION_MODE ? '段落证据定位 · ' : ''}{task.progress.completedStages}/{task.progress.totalStages} 个阶段已封存 · {new Date(task.createdAt).toLocaleString()}</p></div><div className="flex gap-2">{['queued','running'].includes(task.status) && <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act(task, 'cancel')}>取消</Button>}{task.status === 'interrupted' && <Button size="xs" variant="ghost" leadingIcon={RiRefreshLine} disabled={busy} onClick={() => void act(task, 'retry')}>继续未完成阶段</Button>}{canRetryInvalidIndependentReading(task) && <Button size="xs" variant="ghost" disabled={busy} onClick={() => void retryInvalidReading(task)}>引用无效，重新独立阅读一次</Button>}{independentReviewRecoveryModes(task).map(mode => <Button key={mode} size="xs" variant="ghost" disabled={busy} onClick={() => void recover(task, mode)}>{mode === 'whitespace_only' ? '恢复引文空白并续接' : '仅修复引文定位并续接'}</Button>)}</div></div>
          {stale && <p className="mt-2 text-caption-1-regular text-text-secondary">这份报告绑定旧稿，不表示当前正文已评阅；报告内冻结稿仍可只读查看。</p>}<IndependentReviewStopReason error={task.error} partial={Boolean(partial)} />
          {task.modelCitationMode === PARAGRAPH_CITATION_MODE && <details className="mt-2"><summary className="cursor-pointer text-caption-1-medium">证据定位说明</summary><p className="mt-1 text-caption-1-regular text-text-secondary">证据区只展示从评阅时冻结正文逐字取回、并通过文字与位置校验的引文。模型原始响应与定位记录均保留；定位准确不代表评语中的判断已被核实。</p></details>}
          {partial && <p className="mt-2 text-body-2-medium">全文盲评已完成；目标核查未通过。原失败与独立意见均保留，不会为凑齐阶段重抽判断。</p>}
          {independentReviewRecoveryModes(task).length > 0 && <p className="mt-2 text-caption-1-regular text-text-secondary">只恢复当前失败阶段的引文定位；已封存意见不重跑。恢复成功后仅继续尚未完成的阶段。</p>}
          {canRetryInvalidIndependentReading(task) && <p className="mt-2 text-caption-1-regular text-text-secondary">沿用原稿与原阅读要求，重新独立阅读当前引用无效阶段，不带旧意见。本阶段仅一次；原响应与已封存意见保留，失败不自动补发。</p>}
          {Boolean(task.invalidReadingRetries?.length) && <details className="mt-2"><summary className="cursor-pointer text-caption-1-medium">无效初读重读记录</summary>{task.invalidReadingRetries?.map(item => <p key={item.requestId} className="mt-1 text-caption-1-regular text-text-secondary">一次独立重读 · {item.status} · 原失败：{item.originalError?.message || '已保留'}</p>)}</details>}
          {Boolean(task.recoveries?.length) && <details className="mt-2"><summary className="cursor-pointer text-caption-1-medium">引文恢复记录</summary>{task.recoveries?.map(item => <p key={item.requestId} className="mt-1 text-caption-1-regular text-text-secondary">{item.mode === 'whitespace_only' ? '空白定位恢复' : item.mode === 'audited_nondispatch' ? '已核验未发出的定位恢复' : '单次引文定位修复'} · {item.status} · 原失败：{item.originalError?.message || '已保留'}</p>)}</details>}
          {view && <details className="mt-3"><summary className="cursor-pointer text-body-2-medium">查看结论与完整证据</summary><div className="mt-3 flex flex-col gap-4"><div><p className="text-body-2-medium">{view.headline}</p><p className="mt-1 text-body-2-regular text-text-secondary">{view.boundary}</p></div>
            {view.readerLines.map((line,index)=><p key={index} className="text-body-2-regular text-text-secondary">{line}</p>)}
            {view.attributionLines.length > 0 && <section><h4 className="text-body-2-medium">严重问题属于哪份稿件</h4>{view.attributionLines.map((line,index)=><p key={index} className="mt-1 text-body-2-regular text-text-secondary">{line}</p>)}</section>}
            {view.summaryFindings.length > 0 && <section><h4 className="text-body-2-medium">快速摘要</h4>{view.summaryFindings.map((line,index)=><p key={index} className="mt-1 text-body-2-regular text-text-secondary">{line}</p>)}</section>}
            {view.snapshots.length > 0 && <section><h4 className="text-body-2-medium">评阅时冻结稿件</h4><div className="mt-2 flex flex-wrap gap-2">{view.snapshots.map(item => <Button key={item.id} size="xs" variant="secondary" leadingIcon={RiBookOpenLine} onClick={() => openSnapshot(item)}>{item.label}</Button>)}</div></section>}
            {view.sections.length > 0 && <section><h4 className="text-body-2-medium">完整逐条意见 · {view.findings.length} 条</h4><div className="mt-2 flex flex-col gap-3">{view.sections.map(section => <article key={section.id} className="rounded-xl border border-separator-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h5 className="text-body-2-medium">{section.readerLabel} · {section.stageLabel}</h5>{section.preference && <span className="text-caption-1-regular text-text-secondary">{section.preference}</span>}</div>
              <div className="mt-2 flex flex-col gap-3">{section.findings.map((finding, findingIndex) => <div key={`${section.id}-${finding.id}-${findingIndex}`}><p className="text-body-2-regular text-text-secondary">{finding.detail && <span className="mr-2 text-caption-1-medium text-text-tertiary">{finding.detail}</span>}{finding.status && <span className="mr-2 text-caption-1-medium text-text-tertiary">{finding.status}</span>}{finding.statement}</p>{finding.uncertainty && <p className="mt-1 text-caption-1-regular text-text-secondary">不确定性：{finding.uncertainty}</p>}
                {finding.evidence.map((item,index) => { const frozen = independentReviewSnapshotForEvidence(view.snapshots, item); const safeCurrentJump = task.mode === 'single' && !stale && (!item.blindId || item.blindId === 'M');
                  return <blockquote key={`${item.blindId ?? ''}-${item.chapterId}-${item.start}-${index}`} className="mt-2 rounded-xl border border-border-button-default p-3"><p className="text-caption-1-medium text-text-tertiary">{item.evidenceKind === 'counter' ? '反向证据 · ' : item.evidenceKind === 'supporting' ? '相关证据 · ' : ''}{item.blindId ? `匿名稿 ${item.blindId} · ` : ''}{item.chapterId} · 位置 {item.start}</p><p className="mt-2 whitespace-pre-wrap font-story text-body-regular">“{item.quote}”</p>{frozen ? <Button className="mt-2" size="xs" variant="ghost" onClick={() => openSnapshot(frozen, item)}>在{frozen.label}中查看</Button> : safeCurrentJump ? <Button className="mt-2" size="xs" variant="ghost" onClick={() => onLocate(item, task.manuscriptRevision)}>跳到当前固定稿</Button> : <p className="mt-2 text-caption-1-regular text-text-secondary">缺少对应冻结快照，已禁止跳转，避免把候选引文指向原稿。</p>}</blockquote>; })}
              </div>)}</div></article>)}</div></section>}
            {view.sections.length === 0 && <p className="text-caption-1-regular text-text-secondary">这份旧报告没有携带完整逐条记录；不会用摘要冒充完整意见。</p>}
            {view.limitations.map((line,index)=><p key={index} className="text-caption-1-regular text-text-secondary">{line}</p>)}
          </div></details>}
        </article>;
      })}
    </div></details>}
    {error && <p className="mt-3 text-caption-1-regular text-text-error-primary" role="alert">{error}</p>}
    <FrozenSnapshotDialog selection={snapshotSelection} onChange={setSnapshotSelection} onClose={() => setSnapshotSelection(null)} />
  </section>;
}
