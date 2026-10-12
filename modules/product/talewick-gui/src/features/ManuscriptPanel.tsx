import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  RiArrowLeftLine, RiArrowRightLine, RiCheckLine, RiCloseLine, RiDownload2Line,
  RiEditLine, RiExpandDiagonalLine, RiFileTextLine, RiHistoryLine, RiQuoteText,
  RiSaveLine, RiSubtractLine, RiTextWrap, RiArrowGoBackLine,
} from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { IconButton } from '@/components/base/buttons/icon-button';
import { Input } from '@/components/base/input/input';
import { Select, SelectItem } from '@/components/base/select/select';
import { Tabs, TabList, Tab, TabPanel } from '@/components/base/tabs/tabs';
import { SegmentedControl, SegmentedControlItem } from '@/components/base/segmented-control/segmented-control';
import {
  acceptPendingEdits, beginEditing, canApplyPendingEdit, characterCount, hanCharacterCount, exportManuscript, pendingEdits,
  rejectPendingEdits, restoreVersion, saveEditorVersion, snapshotProject, undoEditing, updateChapter,
} from '@/model/store';
import type { Chapter, CompareMode, DocMode, PendingEdit, Project, QuoteSource, Version } from '@/model/types';
import { getEditStart } from '@/model/revision-anchor';
import { cx } from '@/utils/cx';
import { useWorkspace } from '@/features/context';
import { DialogShell, downloadText, EmptyState, formatDate, TextAreaField } from '@/features/shared';
import { Full15ReviewPanel } from '@/features/Full15ReviewPanel';

interface LocalDraft {
  key: string;
  projectId: string;
  chapterId: string;
  title: string;
  body: string;
  baseTitle: string;
  baseBody: string;
}
interface DeferredAction { run: () => void; onDiscard?: () => void }
interface SelectionAnchor { text: string; start: number; x: number; y: number }

/** Session-only drafts survive navigation, and are deliberately excluded from localStorage. */
const sessionDrafts = new Map<string, LocalDraft>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', event => {
    if (sessionDrafts.size) { event.preventDefault(); event.returnValue = ''; }
  });
}
const draftKey = (projectId: string, chapterId: string) => JSON.stringify([projectId, chapterId]);
const makeDraft = (projectId: string, chapter: Chapter): LocalDraft => ({
  key: draftKey(projectId, chapter.id), projectId, chapterId: chapter.id,
  title: chapter.title, body: chapter.body, baseTitle: chapter.title, baseBody: chapter.body,
});
const differs = (left: Pick<Chapter, 'title' | 'body'>, right: Pick<Chapter, 'title' | 'body'>) =>
  left.title !== right.title || left.body !== right.body;

export interface ManuscriptPanelProps { projectId: string; onQuote: (text: string, source?: QuoteSource) => void; savedLabel?: string; progress?: ReactNode }

export function ManuscriptPanel({ projectId, onQuote, savedLabel = '已保存到本机', progress }: ManuscriptPanelProps) {
  const { state } = useWorkspace();
  const project = state.projects.find(item => item.id === projectId);
  useEffect(() => {
    for (const [key, draft] of sessionDrafts) {
      if (!state.projects.some(item => item.id === draft.projectId)) sessionDrafts.delete(key);
    }
  }, [state.projects]);
  if (!project) return null;
  if (!project.chapters.length) return <div className="tw-manuscript"><EmptyState icon={<RiFileTextLine className="size-8 text-tw-warm" />} title="故事正在酝酿" description="文稿完成后，会在这里展开。" /></div>;
  return <ManuscriptContent key={projectId} project={project} onQuote={onQuote} savedLabel={savedLabel} progress={progress} />;
}

function ManuscriptContent({ project, onQuote, savedLabel, progress }: { project: Project; onQuote: (text: string, source?: QuoteSource) => void; savedLabel: string; progress?: ReactNode }) {
  const { state, update, notify } = useWorkspace();
  const chapter = project.chapters[project.selectedChapter] || project.chapters[0];
  const key = draftKey(project.id, chapter.id);
  const [draft, setDraft] = useState<LocalDraft>(() => sessionDrafts.get(key) || makeDraft(project.id, chapter));
  const [selection, setSelection] = useState<SelectionAnchor | null>(null);
  const [dialog, setDialog] = useState<'versions' | 'export' | 'unsaved' | 'conflict' | null>(null);
  const [deferred, setDeferred] = useState<DeferredAction | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [versionCompare, setVersionCompare] = useState(false);
  const [acceptingIds, setAcceptingIds] = useState<string[] | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const activeDraft = draft.key === key ? draft : sessionDrafts.get(key) || makeDraft(project.id, chapter);
  const hasUnsavedDraft = differs(activeDraft, chapter);
  const draftChanged = activeDraft.title !== activeDraft.baseTitle || activeDraft.body !== activeDraft.baseBody;
  const baselineChapter = project.editorBaseline?.find(item => item.id === chapter.id);
  const canUndo = draftChanged || Boolean(baselineChapter && differs(baselineChapter, chapter));
  const allPending = pendingEdits(project);
  const chapterPending = allPending.filter(edit => edit.chapterId === chapter.id);
  const chapterSuggestions = project.pendingEdits.filter(edit => edit.chapterId === chapter.id);
  const selectedVersion = project.versions.find(version => version.id === versionId) || project.versions.at(-1);
  const typography = { '--manuscript-font-size': `${state.settings.fontSize}px` } as CSSProperties;

  function mutate(recipe: (item: Project) => void) {
    update(next => { const item = next.projects.find(candidate => candidate.id === project.id); if (item) recipe(item); });
  }

  useEffect(() => {
    const saved = sessionDrafts.get(key);
    setDraft(current => {
      if (current.key !== key) return saved || makeDraft(project.id, chapter);
      // Only an explicit session draft is unsaved. Autosaved text follows the latest
      // chapter and its baseline, including a subsequently accepted runtime revision.
      if (!saved) return makeDraft(project.id, chapter);
      return current;
    });
  }, [key, chapter.title, chapter.body, project.id]);

  useEffect(() => { setSelection(null); scrollRef.current?.scrollTo({ top: 0 }); }, [key, project.docMode]);

  useEffect(() => {
    function readSelection() {
      if (project.docMode === 'edit') return;
      const native = window.getSelection();
      if (!native || native.isCollapsed || !native.rangeCount || !panelRef.current) { setSelection(null); return; }
      const range = native.getRangeAt(0);
      const raw = native.toString();
      const text = raw.trim();
      const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
      const prose = startElement?.closest<HTMLElement>('.tw-manuscript-prose');
      if (!prose || !panelRef.current.contains(prose) || !prose.contains(range.commonAncestorContainer)) { setSelection(null); return; }
      const source = startElement?.closest<HTMLElement>('[data-source-start]');
      if (!text || !source || !prose.contains(source)) { setSelection(null); return; }
      // Inserted suggestions are not source text, even if they happen to repeat an old sentence.
      if ([...prose.querySelectorAll('ins')].some(inserted => range.intersectsNode(inserted))) { setSelection(null); return; }
      const prefix = document.createRange();
      prefix.selectNodeContents(source); prefix.setEnd(range.startContainer, range.startOffset);
      const start = Number(source.dataset.sourceStart) + prefix.toString().length + raw.length - raw.trimStart().length;
      if (!Number.isSafeInteger(start) || start < 0 || chapter.body.slice(start, start + text.length) !== text) { setSelection(null); return; }
      const rect = range.getBoundingClientRect();
      const panel = panelRef.current.getBoundingClientRect();
      setSelection({ text, start, x: Math.max(128, Math.min(panel.width - 128, rect.left - panel.left + rect.width / 2)), y: Math.max(72, Math.min(panel.height - 112, rect.top - panel.top - 52)) });
    }
    document.addEventListener('selectionchange', readSelection);
    return () => document.removeEventListener('selectionchange', readSelection);
  }, [chapter.body, project.docMode, project.compare]);

  function changeDraft(field: 'title' | 'body', value: string) {
    const next = { ...activeDraft, [field]: value };
    setDraft(next);
    if (state.settings.autoSave) {
      sessionDrafts.delete(key);
      // If autosave was just enabled, keep both fields of the former local draft.
      mutate(item => { updateChapter(item, chapter.id, { title: next.title, body: next.body }); });
    } else if (differs(next, chapter)) sessionDrafts.set(key, next);
    else sessionDrafts.delete(key);
  }

  function commitDraft(force = false): boolean {
    const sourceMoved = (chapter.title !== activeDraft.baseTitle || chapter.body !== activeDraft.baseBody) && differs(activeDraft, chapter);
    if (sourceMoved && !force) { setDialog('conflict'); return false; }
    const changed = hasUnsavedDraft || Boolean(project.editorBaseline && JSON.stringify(project.editorBaseline) !== JSON.stringify(project.chapters));
    if (changed) mutate(item => {
      if (sourceMoved) snapshotProject(item, '保存草稿前的当前稿');
      updateChapter(item, chapter.id, { title: activeDraft.title, body: activeDraft.body });
      saveEditorVersion(item);
    });
    sessionDrafts.delete(key);
    setDraft({ ...activeDraft, baseTitle: activeDraft.title, baseBody: activeDraft.body });
    if (changed) notify('已保存为新版本，旧稿仍可回看。');
    return true;
  }

  function guard(action: DeferredAction) {
    if (hasUnsavedDraft) { sessionDrafts.set(key, activeDraft); setDeferred(action); setDialog('unsaved'); return; }
    if (project.docMode === 'edit') mutate(item => { saveEditorVersion(item); });
    action.run();
  }

  function discardAndContinue() {
    const action = deferred;
    sessionDrafts.delete(key);
    setDraft(makeDraft(project.id, chapter));
    setDeferred(null); setDialog(null);
    (action?.onDiscard || action?.run)?.();
  }

  function saveAndContinue(force = false) {
    if (!commitDraft(force)) return;
    const action = deferred;
    setDeferred(null); setDialog(null); action?.run();
  }

  function changeMode(mode: DocMode) {
    guard({ run: () => {
      setSelection(null);
      if (mode === 'edit') {
        setDraft(sessionDrafts.get(key) || makeDraft(project.id, chapter));
        mutate(item => beginEditing(item));
      } else mutate(item => { item.docMode = mode; });
    } });
  }

  function changeChapter(id: string) {
    const index = project.chapters.findIndex(item => item.id === id);
    if (index < 0 || index === project.selectedChapter) return;
    guard({ run: () => mutate(item => { item.selectedChapter = index; }) });
  }

  function sendQuote() {
    if (!selection) return;
    const quoted = selection.text;
    const run = () => {
      setSelection(null); window.getSelection()?.removeAllRanges();
      mutate(item => { item.docExpanded = false; }); onQuote(quoted, { chapterId: chapter.id, start: selection.start });
    };
    guard({ run, onDiscard: () => {
      if (chapter.body.slice(selection.start, selection.start + quoted.length) === quoted) run(); else { setSelection(null); notify('已舍弃草稿，请重新选取原稿文字。'); }
    } });
  }

  function undoDraft() {
    if (state.settings.autoSave && baselineChapter) {
      mutate(item => { undoEditing(item); });
      setDraft(makeDraft(project.id, baselineChapter));
    } else setDraft(makeDraft(project.id, chapter));
    sessionDrafts.delete(key); setSelection(null); notify('已撤销本次编辑。');
  }

  function openVersions() {
    guard({ run: () => { setVersionId(null); setVersionCompare(false); setDialog('versions'); } });
  }

  useEffect(() => {
    if (!acceptingIds) return;
    const accepted = project.pendingEdits.filter(edit => acceptingIds.includes(edit.id) && edit.status === 'accepted').length;
    const skipped = acceptingIds.length - accepted;
    notify(accepted ? `已采纳 ${accepted} 处修改，采纳前的稿件已保留。${skipped ? `另有 ${skipped} 处原文已变化，未应用。` : ''}` : '原文已变化，本次没有应用修改。请保留当前稿后重新提出建议。');
    setAcceptingIds(null);
  }, [acceptingIds, project.pendingEdits, notify]);

  function accept(ids?: string[]) {
    const requested = allPending.filter(edit => !ids || ids.includes(edit.id));
    const valid = requested.filter(edit => canApplyPendingEdit(edit, project.chapters.find(item => item.id === edit.chapterId)));
    if (!valid.length) { notify('原文已变化，请保留当前稿后重新提出建议。'); return; }
    setAcceptingIds(requested.map(edit => edit.id));
    mutate(item => { acceptPendingEdits(item, ids); });
  }

  function reject(ids?: string[]) {
    const total = allPending.filter(edit => !ids || ids.includes(edit.id)).length;
    mutate(item => { rejectPendingEdits(item, ids); }); notify(`已保留 ${total} 处原文。`);
  }

  const chapterPicker = <div className="tw-manuscript-chapter-picker">
    <Select aria-label="选择章节" selectedKey={chapter.id} onSelectionChange={value => changeChapter(String(value))} className="min-w-0 flex-1" triggerClassName="w-full bg-tw-glass" popoverClassName="tw-manuscript-chapter-popover">
      {project.chapters.map(item => <SelectItem key={item.id} id={item.id} textValue={item.title}>{item.title}</SelectItem>)}
    </Select>
    <span className="shrink-0 text-caption-1-regular text-text-tertiary">{String(project.selectedChapter + 1).padStart(2, '0')} / {String(project.chapters.length).padStart(2, '0')}</span>
  </div>;

  function manuscriptArticle(mode: CompareMode | 'read') {
    return <article className="tw-manuscript-article">
      <h3 className="font-story text-title-1-medium text-text-primary">{chapter.title}</h3>
      <div className="tw-manuscript-prose text-manuscript" data-testid="manuscript-prose" data-source-start={mode === 'read' ? 0 : undefined}>{mode === 'read' ? chapter.body : <DiffBody chapter={chapter} edits={chapterPending} mode={mode} />}</div>
      <div className="tw-manuscript-end" aria-hidden="true" />
    </article>;
  }

  const navigation = <div className="tw-manuscript-chapter-navigation">
    <Button variant="ghost" size="small" leadingIcon={RiArrowLeftLine} disabled={project.selectedChapter === 0} onClick={() => changeChapter(project.chapters[project.selectedChapter - 1].id)}>上一章</Button>
    <Button variant="ghost" size="small" trailingIcon={RiArrowRightLine} disabled={project.selectedChapter >= project.chapters.length - 1} onClick={() => changeChapter(project.chapters[project.selectedChapter + 1].id)}>下一章</Button>
  </div>;

  return <section ref={panelRef} className="tw-manuscript" aria-label="文稿工作区" style={typography}>
    <header className="tw-manuscript-header"><span className="flex items-center gap-2 text-body-regular text-text-secondary"><RiFileTextLine className="size-4 text-tw-warm" />文稿</span>
      <div className="flex items-center gap-1">
        <IconButton icon={project.docExpanded ? RiSubtractLine : RiExpandDiagonalLine} aria-label={project.docExpanded ? '退出专注阅读' : '专注阅读'} title={project.docExpanded ? '退出专注阅读' : '专注阅读'} onClick={() => mutate(item => { item.docExpanded = !item.docExpanded; })} />
        <Button variant="ghost" size="small" leadingIcon={progress ? RiArrowLeftLine : RiCloseLine} aria-label={progress ? '返回对话' : '收起文稿'} onClick={() => guard({ run: () => mutate(item => { item.docOpen = false; item.docClosedByUser = true; item.docExpanded = false; }) })}>{progress ? '返回对话' : '收起文稿'}</Button>
      </div>
    </header>
    <div className="tw-manuscript-book-heading"><h2 className="font-story text-display-4-regular text-text-primary">{project.title}</h2>
      <div className="flex flex-wrap items-center gap-2 text-caption-1-regular text-text-tertiary"><span>{project.chapters.length} 章</span><span>·</span><span>{hanCharacterCount(project.chapters.map(item => item.body).join('')).toLocaleString()} 汉字</span><span>·</span><span aria-live="polite">{hasUnsavedDraft ? '有未保存的修改' : savedLabel}</span><span className="tw-manuscript-demo">{project.runtime ? '本机稿件' : '演示稿件'}</span></div>
    </div>
    {progress}
    <Full15ReviewPanel project={project} hasUnsavedDraft={hasUnsavedDraft} />
    <Tabs selectedKey={project.docMode} onSelectionChange={value => changeMode(String(value) as DocMode)} className="tw-manuscript-tabs gap-0">
      <div className="tw-manuscript-mode-row"><TabList aria-label="文稿模式" className="tw-manuscript-mode-list"><Tab id="read">阅读</Tab><Tab id="edit">编辑</Tab><Tab id="review" count={allPending.length || undefined}>审阅</Tab></TabList>
        <div className="tw-manuscript-tools"><IconButton icon={RiHistoryLine} aria-label="版本记录" title="版本记录" onClick={openVersions} /><IconButton icon={RiDownload2Line} aria-label="导出稿件" title="导出稿件" onClick={() => guard({ run: () => setDialog('export') })} /></div>
      </div>
      {chapterPicker}
      {project.docMode === 'edit' && <div className="tw-manuscript-edit-status"><span className="flex items-center gap-2"><RiEditLine className="size-4" />{state.settings.autoSave ? '正在编辑 · 修改自动保存' : '手动保存 · 草稿暂存于当前会话'}</span><Button variant="ghost" size="xs" leadingIcon={RiArrowGoBackLine} disabled={!canUndo} onClick={undoDraft}>撤销本次</Button></div>}
      {project.docMode === 'review' && <div className="tw-manuscript-review-status"><span className="text-body-2-medium text-tw-warm">{allPending.length ? `${allPending.length} 处修改待确认` : '所有修改已处理'}</span>
        <SegmentedControl aria-label="审阅对照方式" selectedKeys={new Set([project.compare])} onSelectionChange={keys => { const mode = Array.from(keys)[0]; if (mode) mutate(item => { item.compare = String(mode) as CompareMode; }); }}>
          <SegmentedControlItem id="after">修改后</SegmentedControlItem><SegmentedControlItem id="diff">对比</SegmentedControlItem><SegmentedControlItem id="before">原稿</SegmentedControlItem>
        </SegmentedControl>
        {allPending.length > 0 && <div className="tw-manuscript-review-all"><Button variant="ghost" size="xs" onClick={() => reject()}>全部保留</Button><Button variant="primary" size="xs" onClick={() => accept()}>全部采纳</Button></div>}
      </div>}
      <div ref={scrollRef} className="tw-manuscript-scroll" onScroll={() => setSelection(null)}>
        <TabPanel id="read">{manuscriptArticle('read')}{navigation}</TabPanel>
        <TabPanel id="edit">
          <div className="tw-manuscript-edit-fields">
            <Input aria-label="章节标题" value={activeDraft.title} onChange={value => changeDraft('title', value)} fieldClassName="tw-manuscript-title-field" inputClassName="font-story text-title-1-medium" />
            <TextAreaField label="章节正文" value={activeDraft.body} onChange={value => changeDraft('body', value)} inputRef={bodyRef} rows={15} className="tw-manuscript-editor-field" inputClassName="tw-manuscript-editor-input text-manuscript" onSelect={event => {
              const input = event.currentTarget;
              const raw = input.value.slice(input.selectionStart, input.selectionEnd);
              const selected = raw.trim();
              const start = input.selectionStart + raw.length - raw.trimStart().length;
              if (!selected || !panelRef.current) { setSelection(null); return; }
              const rect = panelRef.current.getBoundingClientRect();
              const field = input.getBoundingClientRect();
              setSelection({ text: selected, start, x: rect.width / 2, y: Math.max(72, Math.min(rect.height - 112, field.top - rect.top + 24)) });
            }} />
          </div>{navigation}
        </TabPanel>
        <TabPanel id="review">{manuscriptArticle(project.compare)}
          <div className="tw-manuscript-suggestions">
            {!chapterSuggestions.length ? <EmptyState icon={<RiTextWrap className="size-7 text-tw-warm" />} title={allPending.length ? '本章没有待审修改' : '每一次修改，都由你决定'} description={allPending.length ? '其他章节还有修改建议，确认后才会写入稿件。' : '选中一段原文，告诉左侧助手你想怎么改。'}>
              {allPending.length > 0 ? <Button variant="secondary" size="small" onClick={() => changeChapter(allPending[0].chapterId)}>查看待审修改</Button> : <Button variant="secondary" size="small" leadingIcon={RiQuoteText} onClick={() => {
                const opening = chapter.body.split(/\n\s*\n/)[0];
                const quoted = opening.trim();
                if (quoted) onQuote(quoted, { chapterId: chapter.id, start: opening.length - opening.trimStart().length });
              }}>引用开篇，试试修改</Button>}
            </EmptyState> : chapterSuggestions.map((edit, index) => <Suggestion key={edit.id} edit={edit} number={index + 1} valid={canApplyPendingEdit(edit, chapter)} onAccept={() => accept([edit.id])} onReject={() => reject([edit.id])} />)}
          </div>{navigation}
        </TabPanel>
      </div>
    </Tabs>
    <footer className="tw-manuscript-footer"><span className="flex items-center gap-2 text-caption-1-regular text-text-tertiary">{project.docMode === 'edit' ? <><RiEditLine className="size-4" />{hanCharacterCount(activeDraft.body).toLocaleString()} 汉字 · {hasUnsavedDraft ? '尚未保存' : '已保存'}</> : <><RiQuoteText className="size-4" />{project.docMode === 'review' ? '采纳前，原稿保持原样' : '选中文字，交给助手修改'}</>}</span>
      {project.docMode === 'edit' ? <Button variant="secondary" size="small" leadingIcon={RiSaveLine} onClick={() => { if (!hasUnsavedDraft && !canUndo) notify('稿件没有新的修改。'); else commitDraft(); }}>保存版本</Button> : <Button variant="ghost" size="small" leadingIcon={RiHistoryLine} onClick={openVersions}>{project.versions.length} 个版本</Button>}
    </footer>
    {selection && <div className="tw-manuscript-selection" style={{ left: selection.x, top: selection.y }} onPointerDown={event => event.preventDefault()}><span className="text-caption-1-regular text-text-secondary">已选 {characterCount(selection.text)} 字符</span><Button variant="primary" size="small" leadingIcon={RiQuoteText} onClick={sendQuote}>交给助手</Button></div>}

    <DialogShell title="这一章还有未保存的修改" description="保存后再继续，或保留当前稿件、舍弃这次草稿。" open={dialog === 'unsaved'} onClose={() => { setDialog(null); setDeferred(null); }} footer={<><Button variant="ghost" onClick={() => { setDialog(null); setDeferred(null); }}>继续编辑</Button><Button variant="secondary" onClick={discardAndContinue}>舍弃草稿</Button><Button variant="primary" leadingIcon={RiSaveLine} onClick={() => saveAndContinue()}>保存并继续</Button></>}>
      <p className="font-story text-title-3-medium">{activeDraft.title}</p><p className="mt-2 text-body-regular text-text-secondary">{hanCharacterCount(activeDraft.body).toLocaleString()} 汉字 · 草稿尚未写入项目数据。</p>
    </DialogShell>
    <DialogShell title="当前稿件已经更新" description="这份草稿基于更早的正文。保存草稿时，会先保留当前稿件的版本副本。" open={dialog === 'conflict'} onClose={() => { setDialog(null); setDeferred(null); }} footer={<><Button variant="ghost" onClick={() => { setDialog(null); setDeferred(null); }}>继续编辑</Button><Button variant="secondary" leadingIcon={RiDownload2Line} onClick={() => downloadText(`${project.title}-未保存草稿.md`, `# ${activeDraft.title}\n\n${activeDraft.body}`)}>导出草稿</Button><Button variant="primary" onClick={() => saveAndContinue(true)}>保存草稿为当前稿</Button></>}><p className="text-body-regular text-text-secondary">你可以导出草稿留存，或保存为当前稿。已有版本不会被删除。</p></DialogShell>
    <DialogShell title="把故事带走" description="只导出当前已保存、已采纳的稿件，待审建议不会写入文件。" open={dialog === 'export'} onClose={() => setDialog(null)}>
      <div className="mb-6 flex items-center gap-4 rounded-3xl border border-border-button-default bg-tw-glass p-4"><RiFileTextLine className="size-8 text-tw-warm" /><div><p className="text-headline-medium">{project.title}</p><p className="text-body-2-regular text-text-secondary">{project.chapters.length} 章 · {hanCharacterCount(project.chapters.map(item => item.body).join('')).toLocaleString()} 汉字</p></div></div>
      <div className="grid grid-cols-2 gap-4">{(['txt', 'md'] as const).map(format => <Button key={format} variant="secondary" leadingIcon={RiDownload2Line} onClick={() => { downloadText(`${project.title}.${format}`, exportManuscript(project, format)); setDialog(null); notify('稿件已导出。'); }}>{format === 'txt' ? '纯文本 TXT' : 'Markdown'}</Button>)}</div>
    </DialogShell>
    <DialogShell title="每一次落笔，都有迹可循。" description="恢复历史版本时，当前稿件也会保留一份副本。" open={dialog === 'versions'} onClose={() => setDialog(null)} className="tw-manuscript-version-dialog" footer={selectedVersion ? <><Button variant="ghost" leadingIcon={RiDownload2Line} onClick={() => { downloadText(`${project.title}-${selectedVersion.label}.md`, exportManuscript(project, 'md', selectedVersion.chapters)); notify('历史版本已导出。'); }}>导出此版本</Button><Button variant="primary" leadingIcon={RiHistoryLine} disabled={JSON.stringify(selectedVersion.chapters) === JSON.stringify(project.chapters)} onClick={() => {
      mutate(item => { restoreVersion(item, selectedVersion.id); });
      for (const [cachedKey, cached] of sessionDrafts) if (cached.projectId === project.id) sessionDrafts.delete(cachedKey);
      const restored = selectedVersion.chapters[Math.min(project.selectedChapter, selectedVersion.chapters.length - 1)];
      if (restored) setDraft(makeDraft(project.id, restored));
      setDialog(null); notify('已恢复这个版本，恢复前的稿件也已保存。');
    }}>恢复此版本</Button></> : undefined}>
      {selectedVersion ? <div className="tw-manuscript-version-layout"><div className="tw-manuscript-version-list" aria-label="选择历史版本">{[...project.versions].reverse().map((version, index) => <Button key={version.id} variant="ghost" onClick={() => setVersionId(version.id)} aria-pressed={version.id === selectedVersion.id} className={cx('tw-manuscript-version-item', version.id === selectedVersion.id && 'is-selected')}><span className="tw-manuscript-version-node" /><span className="flex min-w-0 flex-col gap-1 text-left"><span className="text-body-medium">{version.label}</span><span className="text-caption-1-regular text-text-tertiary">{formatDate(version.date)}</span><span className="text-caption-2-regular text-text-secondary">{version.chapters.length} 章{index === 0 ? ' · 最近版本' : ''}</span></span></Button>)}</div>
        <div className="tw-manuscript-version-preview"><div className="tw-manuscript-version-preview-header"><h3 className="text-headline-medium">{selectedVersion.label}</h3><Button variant="secondary" size="small" aria-pressed={versionCompare} onClick={() => setVersionCompare(value => !value)}>{versionCompare ? '查看全文' : '与当前稿件对比'}</Button></div><div className="tw-manuscript-version-body">{versionCompare ? <VersionComparison previous={selectedVersion} current={project.chapters} /> : <><h3 className="mb-6 font-story text-display-4-regular">{project.title}</h3>{selectedVersion.chapters.map(item => <section key={item.id} className="mb-8"><h4 className="mb-4 font-story text-title-3-medium">{item.title}</h4><p className="whitespace-pre-wrap font-story text-headline-regular text-text-secondary">{item.body}</p></section>)}</>}</div></div>
      </div> : <EmptyState icon={<RiHistoryLine className="size-8 text-tw-warm" />} title="这里会留下故事的变化" description="保存一次版本，就可以从这里回到它。"><Button variant="primary" onClick={() => mutate(item => { snapshotProject(item, '手动保存'); })}>保存当前版本</Button></EmptyState>}
    </DialogShell>
  </section>;
}

function DiffBody({ chapter, edits, mode }: { chapter: Chapter; edits: PendingEdit[]; mode: CompareMode }) {
  const body = chapter.body;
  const matches = edits.filter(edit => canApplyPendingEdit(edit, chapter)).map(edit => ({ edit, start: getEditStart(body, edit) })).filter(item => item.start >= 0).sort((a, b) => a.start - b.start);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const { edit, start } of matches) {
    if (start < cursor) continue;
    nodes.push(<span key={`source-${cursor}`} data-source-start={cursor}>{body.slice(cursor, start)}</span>);
    nodes.push(mode === 'before' ? <mark key={edit.id} data-source-start={start} className="tw-manuscript-original">{edit.before}</mark> : mode === 'after' ? <ins key={edit.id}>{edit.after}</ins> : <span key={edit.id}><del data-source-start={start}>{edit.before}</del><ins>{edit.after}</ins></span>);
    cursor = start + edit.before.length;
  }
  nodes.push(<span key={`source-${cursor}`} data-source-start={cursor}>{body.slice(cursor)}</span>);
  return <>{nodes}</>;
}

function Suggestion({ edit, number, valid, onAccept, onReject }: { edit: PendingEdit; number: number; valid: boolean; onAccept: () => void; onReject: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return <section className={cx('tw-manuscript-suggestion rounded-3xl border border-border-button-default', edit.status !== 'pending' && 'is-resolved')} aria-label={`修改建议 ${number}`}>
    <div className="tw-manuscript-suggestion-main"><span className="text-title-3-regular text-tw-warm">{String(number).padStart(2, '0')}</span><div className="min-w-0 flex-1"><p className="text-body-medium text-text-primary">{edit.reason}</p>{edit.status === 'pending' && !valid && <p className="mt-2 text-body-2-regular text-text-error-primary">原文已变化，请保留当前稿后重新提出建议。</p>}</div></div>
    {expanded && <div className="tw-manuscript-suggestion-detail"><div><span className="text-caption-1-medium text-text-tertiary">原文</span><p className="mt-2 whitespace-pre-wrap font-story text-headline-regular text-text-secondary">{edit.before}</p></div><div><span className="text-caption-1-medium text-tw-warm">建议</span><p className="mt-2 whitespace-pre-wrap font-story text-headline-regular text-text-primary">{edit.after}</p></div></div>}
    <div className="tw-manuscript-suggestion-actions"><Button variant="ghost" size="xs" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起详情' : '查看详情'}</Button>{edit.status === 'pending' ? <><Button variant="secondary" size="small" onClick={onReject}>保留原文</Button><Button variant="primary" size="small" leadingIcon={RiCheckLine} disabled={!valid} onClick={onAccept}>采纳修改</Button></> : <span className="text-body-2-medium text-text-secondary">{edit.status === 'accepted' ? '已采纳' : '已保留原文'}</span>}</div>
  </section>;
}

function VersionComparison({ previous, current }: { previous: Version; current: Chapter[] }) {
  const ids = [...new Set([...previous.chapters, ...current].map(chapter => chapter.id))];
  const changed = ids.map(id => ({ before: previous.chapters.find(chapter => chapter.id === id), after: current.find(chapter => chapter.id === id) })).filter(pair => pair.before?.body !== pair.after?.body || pair.before?.title !== pair.after?.title);
  if (!changed.length) return <EmptyState icon={<RiCheckLine className="size-8 text-tw-warm" />} title="与当前稿件一致" description="章节标题和正文均未变化。" />;
  return <><div className="tw-manuscript-diff-legend text-caption-1-regular"><span>历史版本</span><span>当前稿件</span></div>{changed.map(({ before, after }) => {
    const oldText = before?.body || '', newText = after?.body || '';
    let start = 0, end = 0;
    while (start < Math.min(oldText.length, newText.length) && oldText[start] === newText[start]) start += 1;
    while (end < Math.min(oldText.length, newText.length) - start && oldText[oldText.length - 1 - end] === newText[newText.length - 1 - end]) end += 1;
    return <section key={after?.id || before?.id} className="tw-manuscript-history-change"><h4 className="mb-4 font-story text-title-3-medium">{after?.title || before?.title}</h4>{before?.title !== after?.title && <p className="mb-4 text-body-regular"><del>{before?.title || '无章节'}</del><ins>{after?.title || '已删除'}</ins></p>}<p className="whitespace-pre-wrap font-story text-headline-regular text-text-secondary">{start > 72 ? '…' : ''}{oldText.slice(Math.max(0, start - 72), start)}<del>{oldText.slice(start, oldText.length - end)}</del><ins>{newText.slice(start, newText.length - end)}</ins>{oldText.slice(oldText.length - end, oldText.length - end + 72)}{end > 72 ? '…' : ''}</p></section>;
  })}</>;
}
