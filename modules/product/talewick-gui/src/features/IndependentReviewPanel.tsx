import { useCallback, useEffect, useRef, useState } from 'react';
import { RiBookOpenLine, RiEyeLine, RiPlayLine, RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { comparableWholeQualityTask, independentReviewAction, listIndependentReviews, startIndependentReview, type IndependentReviewTask } from '@/model/independent-review';
import { independentReviewView, type IndependentReviewSnapshot, type ReviewEvidenceLocation } from '@/model/independent-review-view';
import { manuscriptRevision } from '@/model/runtime';
import type { Project } from '@/model/types';
import { DialogShell } from '@/features/shared';

const statusNames: Record<IndependentReviewTask['status'], string> = { queued: '等待评阅', running: '独立评阅进行中', complete: '评阅记录已保存', interrupted: '评阅已中断', cancelled: '评阅已取消', needs_attention: '评阅需要处理', stale: '报告对应旧版本' };
const empty = (projectId: string) => ({ projectId, available: false, tasks: [] as IndependentReviewTask[] });
interface SnapshotSelection { snapshot: IndependentReviewSnapshot; chapterId: string; evidence?: ReviewEvidenceLocation }

function snapshotForEvidence(snapshots: IndependentReviewSnapshot[], evidence: ReviewEvidenceLocation) {
  if (evidence.blindId) {
    const exact = snapshots.find(snapshot => snapshot.blindId === evidence.blindId);
    if (exact) return exact;
  }
  if (evidence.documentRole) {
    const roles = snapshots.filter(snapshot => snapshot.role === evidence.documentRole);
    if (roles.length === 1) return roles[0];
  }
  return snapshots.length === 1 ? snapshots[0] : undefined;
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
  const [snapshotSelection, setSnapshotSelection] = useState<SnapshotSelection | null>(null);
  const activeProject = useRef(project.id), sequence = useRef(0); activeProject.current = project.id;
  const refresh = useCallback(async () => {
    const projectId = project.id, current = ++sequence.current;
    try { const value = await listIndependentReviews(projectId); if (activeProject.current === projectId && current === sequence.current) { setSnapshot({ projectId, ...value }); setError(''); } }
    catch (cause) { if (activeProject.current === projectId && current === sequence.current) setError(cause instanceof Error ? cause.message : '独立评阅状态暂时无法读取。'); }
  }, [project.id]);
  useEffect(() => { sequence.current += 1; setSnapshot(empty(project.id)); setSnapshotSelection(null); setError(''); void refresh(); }, [project.id, refresh]);
  const scoped = snapshot.projectId === project.id ? snapshot : empty(project.id), currentRevision = manuscriptRevision(project);
  const active = scoped.tasks.find(task => ['queued', 'running'].includes(task.status));
  useEffect(() => { if (!active) return; const timer = window.setInterval(() => { void refresh(); }, 1200); return () => window.clearInterval(timer); }, [active?.id, active?.status, refresh]);

  async function run(mode: 'single' | 'compare') {
    setBusy(true); setError('');
    try { await startIndependentReview(project, mode); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '独立评阅未能开始。'); }
    finally { setBusy(false); }
  }
  async function act(task: IndependentReviewTask, action: 'cancel' | 'retry') {
    setBusy(true); setError('');
    try { await independentReviewAction(task.id, action); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '评阅任务操作失败。'); }
    finally { setBusy(false); }
  }
  function openSnapshot(snapshot: IndependentReviewSnapshot, evidence?: ReviewEvidenceLocation) {
    setSnapshotSelection({ snapshot, chapterId: evidence?.chapterId ?? snapshot.chapters[0].id, ...(evidence ? { evidence } : {}) });
  }

  return <section className="mx-6 mb-4 rounded-3xl border border-border-button-default bg-tw-glass p-4" aria-label="独立全文评阅">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-body-medium">独立全文评阅</h3><p className="text-caption-1-regular text-text-secondary">隔离写作上下文的全文初读与候选盲评；不会自动修改或采用正文。</p></div>
      <div className="flex flex-wrap gap-2"><Button size="small" variant="secondary" leadingIcon={RiEyeLine} disabled={busy || hasUnsavedDraft || Boolean(active) || !scoped.available} onClick={() => void run('single')}>评阅当前稿</Button>
        <Button size="small" variant="secondary" leadingIcon={RiPlayLine} disabled={busy || hasUnsavedDraft || Boolean(active) || !scoped.available || !comparableWholeQualityTask(project)} onClick={() => void run('compare')}>盲评原稿与候选</Button></div></div>
    {hasUnsavedDraft && <p className="mt-3 text-caption-1-regular text-text-secondary">请先保存当前编辑，评阅只接收固定版本。</p>}
    {!scoped.available && <p className="mt-3 text-caption-1-regular text-text-secondary">独立评阅适配器尚未接通；稿件仍可编辑、保存和导出。</p>}
    {!comparableWholeQualityTask(project) && <p className="mt-2 text-caption-1-regular text-text-tertiary">候选盲评只对仍与当前原稿精确绑定的整稿质量候选开放；采纳或编辑后请评阅实际新版本。</p>}
    {scoped.tasks.length > 0 && <details className="mt-3 border-t border-separator-border pt-3" open={Boolean(active)}><summary className="cursor-pointer text-body-2-medium">评阅历史 · {scoped.tasks.length} 次</summary><div className="mt-3 flex flex-col gap-3">
      {scoped.tasks.map(task => {
        const stale = task.manuscriptRevision !== currentRevision, view = task.report ? independentReviewView(task.report, task.mode) : null;
        return <article key={task.id} className="rounded-2xl border border-separator-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-body-2-medium">{task.mode === 'single' ? '单稿独立初读' : '原稿/候选盲评'} · {stale ? '旧版本' : statusNames[task.status]}</p><p className="mt-1 text-caption-1-regular text-text-secondary">{task.progress.completedStages}/{task.progress.totalStages} 个阶段已封存 · {new Date(task.createdAt).toLocaleString()}</p></div><div className="flex gap-2">{['queued','running'].includes(task.status) && <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act(task, 'cancel')}>取消</Button>}{!['queued','running'].includes(task.status) && task.status !== 'complete' && <Button size="xs" variant="ghost" leadingIcon={RiRefreshLine} disabled={busy} onClick={() => void act(task, 'retry')}>重新评阅</Button>}</div></div>
          {stale && <p className="mt-2 text-caption-1-regular text-text-secondary">这份报告绑定旧稿，不表示当前正文已评阅；报告内冻结稿仍可只读查看。</p>}{task.error && <p className="mt-2 text-caption-1-regular text-text-error-primary">{task.error.message}</p>}
          {view && <details className="mt-3"><summary className="cursor-pointer text-body-2-medium">查看结论与完整证据</summary><div className="mt-3 flex flex-col gap-4"><div><p className="text-body-2-medium">{view.headline}</p><p className="mt-1 text-body-2-regular text-text-secondary">{view.boundary}</p></div>
            {view.readerLines.map((line,index)=><p key={index} className="text-body-2-regular text-text-secondary">{line}</p>)}
            {view.summaryFindings.length > 0 && <section><h4 className="text-body-2-medium">快速摘要</h4>{view.summaryFindings.map((line,index)=><p key={index} className="mt-1 text-body-2-regular text-text-secondary">{line}</p>)}</section>}
            {view.snapshots.length > 0 && <section><h4 className="text-body-2-medium">评阅时冻结稿件</h4><div className="mt-2 flex flex-wrap gap-2">{view.snapshots.map(item => <Button key={item.id} size="xs" variant="secondary" leadingIcon={RiBookOpenLine} onClick={() => openSnapshot(item)}>{item.label}</Button>)}</div></section>}
            {view.sections.length > 0 && <section><h4 className="text-body-2-medium">完整逐条意见 · {view.findings.length} 条</h4><div className="mt-2 flex flex-col gap-3">{view.sections.map(section => <article key={section.id} className="rounded-xl border border-separator-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h5 className="text-body-2-medium">{section.readerLabel} · {section.stageLabel}</h5>{section.preference && <span className="text-caption-1-regular text-text-secondary">{section.preference}</span>}</div>
              <div className="mt-2 flex flex-col gap-3">{section.findings.map((finding, findingIndex) => <div key={`${section.id}-${finding.id}-${findingIndex}`}><p className="text-body-2-regular text-text-secondary">{finding.detail && <span className="mr-2 text-caption-1-medium text-text-tertiary">{finding.detail}</span>}{finding.status && <span className="mr-2 text-caption-1-medium text-text-tertiary">{finding.status}</span>}{finding.statement}</p>
                {finding.evidence.map((item,index) => { const frozen = snapshotForEvidence(view.snapshots, item); const safeCurrentJump = task.mode === 'single' && !stale && (!item.blindId || item.blindId === 'M');
                  return <blockquote key={`${item.blindId ?? ''}-${item.chapterId}-${item.start}-${index}`} className="mt-2 rounded-xl border border-border-button-default p-3"><p className="text-caption-1-medium text-text-tertiary">{item.blindId ? `匿名稿 ${item.blindId} · ` : ''}{item.chapterId} · 位置 {item.start}</p><p className="mt-2 whitespace-pre-wrap font-story text-body-regular">“{item.quote}”</p>{frozen ? <Button className="mt-2" size="xs" variant="ghost" onClick={() => openSnapshot(frozen, item)}>在{frozen.label}中查看</Button> : safeCurrentJump ? <Button className="mt-2" size="xs" variant="ghost" onClick={() => onLocate(item, task.manuscriptRevision)}>跳到当前固定稿</Button> : <p className="mt-2 text-caption-1-regular text-text-secondary">缺少对应冻结快照，已禁止跳转，避免把候选引文指向原稿。</p>}</blockquote>; })}
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
