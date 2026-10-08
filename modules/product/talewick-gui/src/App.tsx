import { PublicationFeedback } from '@/features/PublicationFeedback';
import { ReadingObservations } from '@/features/ReadingObservations';
import { ReviewAdjudication } from '@/features/ReviewAdjudication';
import { MaterialResults } from './features/MaterialResults';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { RiArrowUpLine, RiAttachment2, RiBookOpenLine, RiChat1Line, RiCheckLine, RiCloseLine, RiHistoryLine, RiPencilLine, RiSettings3Line, RiSparklingLine, RiUser3Line, RiFileTextLine } from '@remixicon/react';
import { MotionConfig } from 'motion/react';
import { Button } from '@/components/base/buttons/button';
import { IconButton } from '@/components/base/buttons/icon-button';
import { Select, SelectItem } from '@/components/base/select/select';
import { Checkbox } from '@/components/base/checkbox/checkbox';
import { FileUpload } from '@/components/base/file-upload/file-upload';
import { Notification, NotificationViewport } from '@/components/base/notification/notification';
import { WorkspaceContext, useWorkspace } from '@/features/context';
import { DialogShell, TextAreaField, Hint, Logo } from '@/features/shared';
import { Home, inspirationNodes } from '@/features/Home';
import { ManuscriptPanel } from '@/features/ManuscriptPanel';
import { SecondaryPage, LoginPage, ProjectsDialog } from '@/features/SecondaryPages';
import { createId, createProject } from '@/model/seed';
import { applyConversationTurn, applyRuntimeTask, attachConversationTask, clearHomeContext, clearSubmittedConversationQuote, loadStateDetailed, pendingEdits, saveState } from '@/model/store';
import { controlTask, findTask, getRuntime, getTask, runtimeBusy, runtimeEngineLabel, runtimeResumeMessage, runtimeStage, submitTask, taskActive } from '@/model/runtime';
import { cancelConversation, ConversationError, CONVERSATION_MESSAGE_LIMIT, conversationBusy, conversationPreflightError, getConversation, makeConversationSubmission, streamConversation, submitConversation } from '@/model/conversation';
import { installLinkedProject, loadLinkedProject, readProjectLink, selectLinkedProject, type RecoveredProject } from '@/model/project-link';
import type { AppState, ConversationTurn, InspirationKey, Mode, Project, RuntimeInfo, RuntimeTask } from '@/model/types';
import { cx } from '@/utils/cx';

const modeNames: Record<Mode, string> = { auto: '一键成稿', light: '轻度参与', pro: '专业审稿' };
const agentActionNames: Record<string, string> = { inspect_plan: '查看方案', read_materials: '查看所选资料', revise_plan: '调整方案', approve_plan: '确认开写', read_chapter: '回看章节', revise_chapter: '按证据修订', review_manuscript: '复核全文', finish_review: '结束本轮审阅' };

export function Composer({ project, onSend, onStop, serviceMessage, onCheck, isBusy = false }: { project?: Project; onSend: () => void; onStop?: () => void; serviceMessage?: string; onCheck?: () => void; isBusy?: boolean }) {
  const { state, update, notify } = useWorkspace();
  const [dialog, setDialog] = useState<'materials' | 'library' | 'style' | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const text = project?.draftInput ?? state.homeIdea;
  const mode = project?.mode ?? state.homeMode;
  const libraryIds = project?.libraryIds ?? state.selectedLibrary;
  const styleId = project ? project.styleId : state.selectedStyle;
  const attachments = project?.attachments ?? state.attachments;
  const activeStyle = state.styles.find(s => s.id === styleId);
  const busy = isBusy || conversationBusy(project);
  const placeholder = project?.chapters.length ? '继续聊聊，或选中文字告诉我怎么修改…' : mode === 'auto' ? '发来一个故事想法，即可自动成稿；未填写的设定由我决定。' : '写下你的想法，故事从这里开始……';
  const change = (value: string) => update(s => { const p = s.projects.find(p => p.id === project?.id); if (p) p.draftInput = value; else s.homeIdea = value; });
  useEffect(() => { if (state.quote) inputRef.current?.focus(); }, [state.quote]);
  return <>
    <div className={cx('composer glass-panel', project && 'composer-chat')} aria-busy={busy}>
      {state.quote && <div className="quote-preview"><RiChat1Line className="size-4 shrink-0" /><span className="text-body-regular">{state.quote}</span><IconButton size="small" icon={RiCloseLine} aria-label="取消引用" onClick={() => update(s => { s.quote = ''; s.quoteSource = undefined; })} /></div>}
      <TextAreaField label="创作想法" focusRing="container" inputRef={inputRef} value={text} onChange={change} rows={2} maxLength={CONVERSATION_MESSAGE_LIMIT} placeholder={placeholder} inputClassName="composer-input" onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (!busy) onSend(); } }} />
      <div className="composer-count text-caption-2-regular" aria-hidden="true">{text.length} / {CONVERSATION_MESSAGE_LIMIT}</div>
      {(attachments.length > 0 || libraryIds.length > 0 || activeStyle) && <div className="composer-context text-caption-1-medium">{attachments.length > 0 && <span>{attachments.length} 份素材</span>}{libraryIds.length > 0 && <span>{libraryIds.length} 篇知识库</span>}{activeStyle && <span>{activeStyle.name}</span>}</div>}
      <div className="composer-toolbar"><div className="composer-tools">
        <Hint text="添加素材"><Button variant="ghost" aria-label="添加素材" leadingIcon={RiAttachment2} onClick={() => setDialog('materials')} className="composer-tool"><span>添加素材</span></Button></Hint>
        <Hint text="引用知识库"><Button variant="ghost" aria-label="引用知识库" leadingIcon={RiBookOpenLine} onClick={() => setDialog('library')} className="composer-tool"><span>知识库</span></Button></Hint>
        <Hint text="选择个人风格"><Button variant="ghost" aria-label="选择个人风格" leadingIcon={RiUser3Line} onClick={() => setDialog('style')} className="composer-tool"><span>个人风格</span></Button></Hint>
      </div><div className="composer-submit">
        <Select aria-label="创作模式" selectedKey={mode} isDisabled={busy || Boolean(project?.chapters.length)} triggerClassName="mode-select" renderValue={<><RiSparklingLine className="size-5" /><span>{modeNames[mode]}{mode !== 'auto' && ' · 暂未接通'}</span></>} onSelectionChange={key => update(s => { const next = key as Mode; const p = s.projects.find(p => p.id === project?.id); if (p) { p.mode = next; p.phase = next === 'pro' ? 'premise' : 'direction'; } else s.homeMode = next; })}>
          <SelectItem id="auto">一键成稿</SelectItem><SelectItem id="light" isDisabled>轻度参与 · 暂未接通</SelectItem><SelectItem id="pro" isDisabled>专业审稿 · 暂未接通</SelectItem>
        </Select>
        <IconButton icon={busy ? RiCloseLine : RiArrowUpLine} aria-label={busy ? "停止回复" : "发送创作想法"} className="send-button" onClick={busy ? onStop : onSend} disabled={busy ? !onStop : !text.trim()} />
      </div></div>
    </div>
    {(serviceMessage || onCheck) && <div className="composer-runtime-status"><p className="text-caption-1-regular text-text-secondary" role="status">{serviceMessage}</p>{onCheck && <Button variant="ghost" size="xs" onClick={onCheck}>检查连接</Button>}</div>}
    <DialogShell title={dialog === 'materials' ? '添加创作素材' : dialog === 'library' ? '引用知识库' : '选择个人风格'} description={dialog === 'materials' ? '导入 TXT 或 Markdown。提交创作时，所选素材会随要求交给已配置的模型服务。' : dialog === 'library' ? '选择本次创作的参考内容，提交时一并交给已配置的模型服务。' : '保存的风格将关联到这次创作。'} open={dialog !== null} onClose={() => setDialog(null)} footer={<Button onClick={() => setDialog(null)}>完成</Button>}>
      {dialog === 'materials' && <div className="flex flex-col gap-4"><FileUpload labels={{ ariaLabel: '导入创作素材', dropText: '拖放文件到这里，或', selectText: '选择文件', maxLabel: '最大', uploadingText: '正在读取', successText: '已读取到本机', unsupportedType: extensions => `支持的文件格式：${extensions}`, tooLarge: maxSize => `文件过大，请选择小于 ${maxSize} 的文件` }} allowedExtensions={['txt', 'md']} maxBytes={1024 * 1024} onUploadComplete={async file => { try { const content = await file.text(); if (!content.trim()) { notify('文件内容为空，请选择有文字的文件。'); return; } update(s => { const p = s.projects.find(p => p.id === project?.id); const target = p?.attachments ?? s.attachments; target.push({ id: createId('attachment'), name: file.name, content, size: file.size }); }); notify(`已添加 ${file.name}`); } catch { notify('无法读取文件，请重新选择。'); } }} />{attachments.map((item, index) => <div key={item.id ?? index} className="flex items-center justify-between gap-4"><span className="break-all text-body-regular">{item.name}</span><IconButton icon={RiCloseLine} aria-label={`移除素材 ${item.name}`} onClick={() => update(s => { const p = s.projects.find(p => p.id === project?.id); (p?.attachments ?? s.attachments).splice(index, 1); })} /></div>)}</div>}
      {dialog === 'library' && <div className="flex flex-col gap-4">{state.library.length ? state.library.map(item => <Checkbox key={item.id} isSelected={libraryIds.includes(item.id)} onChange={selected => update(s => { const p = s.projects.find(p => p.id === project?.id); const current = p?.libraryIds ?? s.selectedLibrary; const ids = selected ? [...current, item.id] : current.filter(id => id !== item.id); if (p) p.libraryIds = ids; else s.selectedLibrary = ids; })}>{item.title}</Checkbox>) : <p className="text-body-regular">知识库还没有内容。可以先在知识库页面导入作品。</p>}</div>}
      {dialog === 'style' && <Select aria-label="本次创作风格" selectedKey={styleId ?? 'none'} onSelectionChange={key => update(s => { const id = key === 'none' ? null : String(key); const p = s.projects.find(p => p.id === project?.id); if (p) p.styleId = id; else s.selectedStyle = id; })}><SelectItem id="none">暂不使用个人风格</SelectItem>{state.styles.map(style => <SelectItem key={style.id} id={style.id}>{style.name}</SelectItem>)}</Select>}
    </DialogShell>
  </>;
}

function TaskMessage({ project, task, onTaskAction, onResult }: { project: Project; task: RuntimeTask; onTaskAction: (action: 'resume' | 'cancel') => void; onResult: (task: RuntimeTask) => void }) {
  const current = project.runtime?.task?.id === task.id;
  const resumeMessage = runtimeResumeMessage(task);
  const busy = taskActive(task);
  return <section className="mt-4 flex flex-col gap-3 rounded-xl border border-border-button-default bg-background-secondary-default p-4" aria-label="创作任务状态" aria-busy={busy}>
    <p className="text-body-medium" aria-live="polite">{runtimeStage(task)}</p>
    <p className="whitespace-pre-wrap text-body-regular text-text-secondary">{resumeMessage || task.question || task.error || (current ? project.runtime?.message : '') || (busy ? '可以继续聊天；稿件完成后会保存在这里。' : task.status === 'completed' ? '本次稿件与检查报告已保留。' : '已有稿件和完成步骤已保留。')}</p>
    {current && project.runtime?.connectionError && <p className="text-caption-1-regular text-text-secondary">{project.runtime.connectionError}</p>}
    <div className="flex flex-wrap gap-2">
      {current && busy && <Button variant="secondary" size="small" disabled={project.runtime?.submitting} onClick={() => onTaskAction('cancel')}>取消创作任务</Button>}
      {current && !resumeMessage && ['failed', 'interrupted', 'cancelled'].includes(task.status) && <Button variant="secondary" size="small" disabled={project.runtime?.submitting} onClick={() => onTaskAction('resume')}>重试任务</Button>}
      {task.partialDraft && <Button variant="secondary" size="small" leadingIcon={RiFileTextLine} onClick={() => onResult(task)}>查看已保存草稿（未完成）</Button>}
      {task.result && <Button variant="secondary" size="small" leadingIcon={RiFileTextLine} onClick={() => onResult(task)}>查看本次结果与检查报告</Button>}
    </div>
  </section>;
}

function Chat({ project, onSend, onStop, onHistory, serviceMessage, onCheck, onTaskAction, onResult }: { project: Project; onSend: () => void; onStop: () => void; onHistory: () => void; serviceMessage: string; onCheck: () => void; onTaskAction: (action: 'resume' | 'cancel') => void; onResult: (task: RuntimeTask) => void }) {
  const { update } = useWorkspace();
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const lastUser = [...project.messages].reverse().find(message => message.role === 'user');
  const lastReply = [...project.messages].reverse().find(message => message.role === 'assistant');
  useEffect(() => {
    followBottom.current = true;
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [project.id, lastUser?.id, lastUser?.turnId, lastUser?.date]);
  useEffect(() => {
    if (followBottom.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [project.messages.length, lastReply?.text, lastReply?.turnStatus, project.phase, project.status]);
  const binding = project.runtime;
  const tasks = [...(project.runtimeHistory ?? []), ...(binding?.task ? [binding.task] : [])];
  const linkedTasks = new Set(project.messages.map(message => message.taskId).filter(Boolean));
  return <section className="chat-pane" aria-label="与创作助手交流">
    <header className="chat-header"><Button variant="ghost" onClick={onHistory} className="project-switch text-title-3-medium">{project.title}</Button><span className="text-caption-1-medium text-text-secondary">创作对话</span></header>
    <div ref={scrollRef} className="chat-scroll" onScroll={() => {
      const scroll = scrollRef.current;
      if (scroll) followBottom.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 96;
    }}><div className="chat-content">
      <div className="demo-note text-caption-1-regular">对话会保留在本机与当前服务 · 稿件修改由你决定是否采纳</div>
      {project.messages.map((message, index) => {
        const task = tasks.find(item => item.id === message.taskId);
        return <div key={message.id ?? index} className={cx('message', message.role === 'user' ? 'message-user' : 'message-agent')}>
          {message.role === 'assistant' && <div className="agent-mark"><Logo className="size-8" /></div>}
          <div className="message-content">{message.role === 'assistant' && <div className="mb-3 text-body-medium text-text-secondary">Talewick</div>}{message.quote && <blockquote className="mb-3 rounded-xl bg-tw-selection p-3 text-body-regular">{message.quote}</blockquote>}
            <p className="whitespace-pre-wrap text-headline-regular" aria-live={message.role === 'assistant' ? 'polite' : undefined}>{message.text || (message.turnStatus === 'running' ? '正在思考…' : '')}</p>
            {message.connectionError && <p className="mt-2 text-caption-1-regular text-text-secondary">{message.connectionError}</p>}
            {message.turnError && <p className="mt-2 text-caption-1-regular text-text-secondary">{message.turnError}</p>}
            {message.turnStatus === 'cancelled' && <p className="mt-2 text-caption-1-regular text-text-secondary">回复已停止，已收到的内容仍然保留。</p>}
            {message.artifact && <Button variant="secondary" leadingIcon={RiFileTextLine} trailingIcon={RiBookOpenLine} className="artifact-link" onClick={() => update(s => { const p = s.projects.find(p => p.id === project.id)!; p.docOpen = true; p.docClosedByUser = false; p.docUpdated = false; })}>打开文稿 · {project.chapters.length} 章</Button>}
            {task && <TaskMessage project={project} task={task} onTaskAction={onTaskAction} onResult={onResult} />}
          </div></div>;
      })}
      {tasks.filter(task => !linkedTasks.has(task.id)).map(task => <div key={task.id} className="message message-agent"><div className="agent-mark"><Logo className="size-8" /></div><div className="message-content"><TaskMessage project={project} task={task} onTaskAction={onTaskAction} onResult={onResult} /></div></div>)}
      {binding && !binding.task && <div className="message message-agent"><div className="message-content"><p className="text-body-regular">{binding.connectionError || '正在恢复此前的创作任务。'}</p><Button variant="secondary" size="small" onClick={() => onTaskAction('resume')}>重试任务</Button></div></div>}
      <div ref={endRef} />
    </div></div>
    <div className="chat-composer-wrap"><Composer project={project} onSend={onSend} onStop={onStop} serviceMessage={serviceMessage} onCheck={onCheck} /><p className="composer-hint text-caption-2-regular">⌘ / Ctrl + Enter 发送 · 修改建议采纳后才会更新正文</p></div>
  </section>;
}

function toolsBlocked(project: Project | undefined, state: AppState): string {
  if (project && pendingEdits(project).length) return '已有待审修改，本轮可以继续讨论；采纳或保留这些修改后才能再次改稿。';
  if (runtimeBusy(project)) return '创作任务正在后台运行，可以继续聊天；本轮不会另开创作任务。';
  if (!project?.chapters.length && (project?.mode ?? state.homeMode) !== 'auto') return '当前参与模式可以聊天；如需生成稿件，请切换为一键成稿。';
  if (state.quote) {
    const source = state.quoteSource;
    const chapter = source ? project?.chapters.find(item => item.id === source.chapterId) : undefined;
    const occurrences = source ? 0 : (project?.chapters ?? []).reduce((count, item) => count + item.body.split(state.quote).length - 1, 0);
    const matches = source ? Boolean(chapter && Number.isSafeInteger(source.start) && source.start >= 0 && chapter.body.slice(source.start, source.start + state.quote.length) === state.quote) : occurrences === 1;
    if (!matches) return '引用原文已变化或位置不明确，本轮可以讨论；请保存稿件并重新选择后再改稿。';
  }
  return '';
}

export default function App() {
  const [initial] = useState(() => { const loaded = loadStateDetailed(); loaded.state.homeMode = 'auto'; return loaded; });
  const [projectLink] = useState(() => readProjectLink(window.location.search));
  const projectLinkLoad = useRef<Promise<RecoveredProject> | null>(null);
  const [state, setState] = useState(initial.state);
  const stateRef = useRef(state);
  stateRef.current = state;
  const pendingRequests = useRef(new Set<string>());
  const streams = useRef(new Map<string, AbortController>());
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [runtimeError, setRuntimeError] = useState('');
  const [inspectedTaskSnapshot, setInspectedTask] = useState<RuntimeTask | null>(null);
  const [toast, setToast] = useState(initial.warning ?? '');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextKey, setContextKey] = useState<InspirationKey | null>(null);
  const [contextDraft, setContextDraft] = useState('');
  const [chatWidth, setChatWidth] = useState(43);
  const splitterRef = useRef<HTMLDivElement>(null);
  const notify = useCallback((message: string) => setToast(message), []);
  const update = useCallback((recipe: (draft: AppState) => void) => setState(current => { const next = structuredClone(current); recipe(next); return next; }), []);
  const checkConnection = useCallback(async () => {
    try { setRuntime(await getRuntime()); setRuntimeError(''); }
    catch (error) { setRuntime(null); setRuntimeError(error instanceof Error ? error.message : '无法连接创作服务。'); }
  }, []);
  useEffect(() => { void checkConnection(); }, [checkConnection]);
  const serviceMessage = runtimeError || (runtime ? `新任务使用 ${runtime.engineLabel} · ${runtime.configured && runtime.ready ? `模型服务已配置${runtime.model ? ` · ${runtime.model}` : ''}` : runtime.message || '模型服务尚未配置，想法和现有稿件可以先保存在本机。'}` : '正在检查本地创作服务…');
  const recordTask = useCallback((task: RuntimeTask, projectId = task.projectId, requestId?: string) => update(s => {
    const p = s.projects.find(item => item.id === projectId);
    if (requestId && p?.runtime?.request.requestId !== requestId) return;
    if (p) applyRuntimeTask(p, task);
  }), [update]);
  const recordError = useCallback((projectId: string, requestId: string, error: unknown) => update(s => {
    const p = s.projects.find(item => item.id === projectId);
    if (!p?.runtime || p.runtime.request.requestId !== requestId) return;
    p.runtime.submitting = false;
    p.runtime.connectionError = error instanceof Error ? error.message : '创作服务暂时不可用，当前稿件已保留。';
    p.status = taskActive(p.runtime.task) ? 'writing' : p.chapters.length ? 'ready' : 'draft';
  }), [update]);
  const openProject = useCallback((id: string) => { update(s => { s.activeProjectId = id; s.page = 'create'; s.quote = ''; s.quoteSource = undefined; }); setHistoryOpen(false); }, [update]);
  const startNew = useCallback(() => update(s => { s.activeProjectId = null; s.page = 'create'; s.quote = ''; s.quoteSource = undefined; }), [update]);
  const project = state.projects.find(p => p.id === state.activeProjectId);
  const inspectedProject = state.projects.find(p => p.id === inspectedTaskSnapshot?.projectId);
  const updatedInspectedTask = [inspectedProject?.runtime?.task, ...(inspectedProject?.runtimeHistory ?? [])].find(task => task?.id === inspectedTaskSnapshot?.id);
  const inspectedTask = updatedInspectedTask && (!inspectedTaskSnapshot?.updatedAt || updatedInspectedTask.updatedAt >= inspectedTaskSnapshot.updatedAt) ? updatedInspectedTask : inspectedTaskSnapshot;
  const hasDoc = Boolean(project?.docOpen && project.chapters.length);
  const savedBoundary = useRef('');
  const saveCurrentState = useCallback(() => { const saved = saveState(stateRef.current); if (!saved.ok) setToast(saved.error ?? '本地保存失败，请导出文稿备份。'); }, []);
  useEffect(() => {
    const boundary = JSON.stringify([state.activeProjectId, state.projects.map(p => [p.id, p.messages.length, p.messages.filter(message => message.turnId && message.role === 'assistant').map(message => [message.turnId, message.turnStatus]), p.runtime?.task?.id, p.runtime?.task?.status])]);
    if (boundary !== savedBoundary.current) { savedBoundary.current = boundary; saveCurrentState(); return; }
    const timer = window.setTimeout(saveCurrentState, 200);
    return () => window.clearTimeout(timer);
  }, [state, saveCurrentState]);
  useEffect(() => {
    window.addEventListener('pagehide', saveCurrentState);
    return () => window.removeEventListener('pagehide', saveCurrentState);
  }, [saveCurrentState]);
  useEffect(() => { document.documentElement.dataset.reduceMotion = String(state.settings.reduceMotion); }, [state.settings.reduceMotion]);
  const polling = state.projects.filter(p => p.runtime?.task && (taskActive(p.runtime.task) || (p.runtime.task.status === 'completed' && p.runtime.handledTaskId !== p.runtime.task.id))).map(p => p.runtime!.task!.id).sort().join('|');
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: number | undefined;
    const ids = new Set(polling.split('|'));
    const poll = async () => {
      const bindings = stateRef.current.projects.flatMap(p => p.runtime?.task && ids.has(p.runtime.task.id) ? [{ projectId: p.id, requestId: p.runtime.request.requestId, taskId: p.runtime.task.id }] : []);
      await Promise.all(bindings.map(async item => {
        try { const task = await getTask(item.taskId); if (!stopped) recordTask(task, item.projectId, item.requestId); }
        catch (error) { if (!stopped) recordError(item.projectId, item.requestId, error); }
      }));
      if (!stopped) timer = window.setTimeout(() => { void poll(); }, 1800);
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [polling, recordTask, recordError]);
  useEffect(() => {
    // Refresh known tasks once too: the server may have recovered a previous terminal state.
    let stopped = false;
    for (const p of initial.state.projects) {
      if (!p.runtime) continue;
      const request = p.runtime.request;
      const existingTask = p.runtime.task;
      if (existingTask) {
        void getTask(existingTask.id).then(task => {
          if (!stopped) recordTask(task, p.id, request.requestId);
        }).catch(error => { if (!stopped && taskActive(existingTask)) recordError(p.id, request.requestId, error); });
        continue;
      }
      // POST may have succeeded before its task id reached the browser.
      void findTask(p.id, request.requestId).then(task => {
        if (stopped) return;
        if (task) recordTask(task, p.id, request.requestId);
        else recordError(p.id, request.requestId, new Error('此前的提交尚未找到。可以重试，已提交的相同请求不会重复生成。'));
      }).catch(error => { if (!stopped) recordError(p.id, request.requestId, error); });
    }
    return () => { stopped = true; };
  }, [initial, recordTask, recordError]);
  const recordTurn = useCallback((turn: ConversationTurn) => update(s => {
    const p = s.projects.find(item => item.id === turn.projectId);
    if (p) { if (turn.task) clearSubmittedConversationQuote(s, p, turn.task.request, turn.task.task); applyConversationTurn(p, turn); }
  }), [update]);
  const watchTurn = useCallback((projectId: string, turnId: string) => {
    const key = `${projectId}/${turnId}`;
    if (streams.current.get(key) && !streams.current.get(key)!.signal.aborted) return;
    const controller = new AbortController(); streams.current.set(key, controller);
    let deltaBuffer = '';
    let deltaTimer: ReturnType<typeof setTimeout> | undefined;
    const flushDeltas = () => {
      clearTimeout(deltaTimer); deltaTimer = undefined;
      const delta = deltaBuffer; deltaBuffer = '';
      if (!delta) return;
      update(s => {
        const message = s.projects.find(p => p.id === projectId)?.messages.find(item => item.role === 'assistant' && item.turnId === turnId);
        if (message?.turnStatus === 'running') { message.text += delta; message.connectionError = undefined; }
      });
    };
    void (async () => {
      let retries = 0;
      while (!controller.signal.aborted) {
        try {
          await streamConversation(projectId, turnId, controller.signal, event => {
            if (event.type === 'text') {
              deltaBuffer += event.delta;
              if (deltaTimer === undefined) deltaTimer = setTimeout(flushDeltas, 40);
              return;
            }
            // Boundaries replace or finish a reply, so commit received deltas before them.
            flushDeltas();
            update(s => {
              const p = s.projects.find(item => item.id === projectId); if (!p) return;
              if (event.type === 'snapshot' || event.type === 'done') {
                if (event.turn.task) clearSubmittedConversationQuote(s, p, event.turn.task.request, event.turn.task.task);
                applyConversationTurn(p, event.turn);
              } else if (event.type === 'task') {
                clearSubmittedConversationQuote(s, p, event.request, event.task);
                attachConversationTask(p, turnId, event.request, event.task);
              }
            });
          });
          return;
        } catch (error) {
          flushDeltas();
          if (controller.signal.aborted) return;
          const terminal = error instanceof ConversationError && [400, 401, 403, 404, 409].includes(error.status);
          update(s => {
            const message = s.projects.find(p => p.id === projectId)?.messages.find(item => item.role === 'assistant' && item.turnId === turnId);
            if (!message || message.turnStatus !== 'running') return;
            if (terminal) { message.turnStatus = 'interrupted'; message.turnError = '暂时无法恢复这轮回复，已保留收到的内容。恢复连接后刷新可重新读取。'; message.connectionError = undefined; }
            else message.connectionError = '连接中断，正在恢复这轮回复；已经收到的内容会保留。';
          });
          if (terminal) return;
          retries++;
          await new Promise<void>(resolve => { const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, Math.min(1000 * retries, 10000)); controller.signal.addEventListener('abort', finish, { once: true }); });
        }
      }
    })().finally(() => { flushDeltas(); if (streams.current.get(key) === controller) streams.current.delete(key); });
  }, [update]);
  useEffect(() => {
    let stopped = false;
    for (const project of initial.state.projects) {
      void getConversation(project.id).then(turns => {
        if (stopped) return;
        update(s => {
          const p = s.projects.find(item => item.id === project.id); if (!p) return;
          for (const turn of turns) { if (turn.task) clearSubmittedConversationQuote(s, p, turn.task.request, turn.task.task); applyConversationTurn(p, turn); }
          const found = new Set(turns.map(turn => turn.id));
          for (const message of p.messages) if (message.turnId && message.role === 'assistant' && message.turnStatus === 'running' && !found.has(message.turnId)) {
            message.turnStatus = 'interrupted'; message.turnError = '未在服务端找到这轮回复，输入与已收到的内容仍保留。'; message.connectionError = undefined;
          }
        });
        for (const turn of turns) if (turn.status === 'running') watchTurn(project.id, turn.id);
      }).catch(() => {
        if (stopped) return;
        for (const message of project.messages) if (message.role === 'assistant' && message.turnId && message.turnStatus === 'running') watchTurn(project.id, message.turnId);
      });
    }
    return () => { stopped = true; for (const controller of streams.current.values()) controller.abort(); };
  }, [initial, update, watchTurn]);
  useEffect(() => {
    if (!projectLink.projectId && !projectLink.error) return;
    // Consume the link once for this page load; subsequent renders and project switches stay local.
    const url = new URL(window.location.href);
    if (url.searchParams.has('project')) { url.searchParams.delete('project'); window.history.replaceState(window.history.state, '', url); }
    if (projectLink.error) { notify(projectLink.error); return; }
    const projectId = projectLink.projectId!;
    if (initial.state.projects.some(item => item.id === projectId)) { update(s => selectLinkedProject(s, projectId)); return; }
    let stopped = false;
    notify('正在恢复链接中的创作任务，你可以继续使用本机其他项目。');
    // Strict Mode may reattach this effect; share its read-only request instead of importing twice.
    projectLinkLoad.current ??= loadLinkedProject(projectId);
    void projectLinkLoad.current.then(recovered => {
      if (stopped) return;
      update(s => {
        const stillAtEntry = s.activeProjectId === initial.state.activeProjectId && s.page === initial.state.page;
        installLinkedProject(s, recovered, stillAtEntry);
      });
      for (const message of recovered.project.messages) if (message.role === 'assistant' && message.turnStatus === 'running' && message.turnId) watchTurn(projectId, message.turnId);
      notify('已恢复已提交的对话与创作任务。其他浏览器中未提交的编辑仍保留在原浏览器。');
    }).catch(error => { if (!stopped) notify(error instanceof Error ? error.message : '暂时无法恢复这条创作链接，现有项目已保留。'); });
    return () => { stopped = true; };
  }, [initial, projectLink, update, watchTurn, notify]);
  const send = async () => {
    const current = stateRef.current;
    const existing = current.projects.find(p => p.id === current.activeProjectId);
    const text = (existing?.draftInput ?? current.homeIdea).trim();
    const guard = existing?.id || 'new-project';
    if (!text || conversationBusy(existing) || pendingRequests.current.has(guard)) return;
    const blocked = toolsBlocked(existing, current);
    if (blocked) notify(blocked);
    pendingRequests.current.add(guard);
    const draft = existing ? structuredClone(existing) : createProject(text, current.homeMode);
    if (!existing) {
      draft.context = structuredClone(current.context); draft.libraryIds = [...current.selectedLibrary]; draft.styleId = current.selectedStyle; draft.attachments = structuredClone(current.attachments);
      draft.messages = [];
    }
    const turnId = createId('turn');
    const submission = makeConversationSubmission(draft, current, turnId, createId('request'), text, current.quote, !blocked);
    const preflightError = conversationPreflightError(submission, draft);
    if (preflightError) { pendingRequests.current.delete(guard); notify(preflightError); return; }
    const createdAt = new Date().toISOString();
    draft.messages.push({ id: `turn-user-${turnId}`, role: 'user', turnId, text, quote: current.quote || undefined, date: createdAt });
    draft.messages.push({ id: `turn-assistant-${turnId}`, role: 'assistant', turnId, turnStatus: 'running', text: '', date: createdAt });
    draft.draftInput = ''; draft.updatedAt = createdAt;
    update(s => {
      if (existing) { const index = s.projects.findIndex(p => p.id === existing.id); if (index >= 0) s.projects[index] = draft; }
      else { s.projects.unshift(draft); clearHomeContext(s); s.activeProjectId = draft.id; }
    });
    try {
      const turn = await submitConversation(draft.id, submission); recordTurn(turn);
      if (turn.status === 'running') watchTurn(draft.id, turn.id);
    } catch (error) {
      // An uncertain POST is recovered read-only; never generate another turn automatically.
      try {
        const turns = await getConversation(draft.id);
        for (const turn of turns) { recordTurn(turn); if (turn.status === 'running') watchTurn(draft.id, turn.id); }
        if (!turns.some(turn => turn.id === turnId)) update(s => {
          const message = s.projects.find(p => p.id === draft.id)?.messages.find(item => item.role === 'assistant' && item.turnId === turnId);
          if (message) { message.turnStatus = 'failed'; message.turnError = error instanceof Error ? error.message : '消息未发送成功，输入已保留。'; }
        });
      } catch { watchTurn(draft.id, turnId); }
      void checkConnection();
    } finally { pendingRequests.current.delete(guard); }
  };
  const stopReply = async () => {
    const p = stateRef.current.projects.find(item => item.id === stateRef.current.activeProjectId);
    const message = p ? [...p.messages].reverse().find(item => item.role === 'assistant' && item.turnStatus === 'running') : undefined;
    if (!p || !message?.turnId) return;
    try {
      const turn = await cancelConversation(p.id, message.turnId);
      streams.current.get(`${p.id}/${message.turnId}`)?.abort(); recordTurn(turn);
    } catch (error) { notify(error instanceof Error ? error.message : '暂时无法停止回复，请稍后再试。'); }
  };
  const actOnTask = async (action: 'resume' | 'cancel') => {
    const current = stateRef.current;
    const p = current.projects.find(item => item.id === current.activeProjectId);
    const binding = p?.runtime;
    if (!p || !binding || pendingRequests.current.has(p.id)) return;
    pendingRequests.current.add(p.id);
    update(s => { const target = s.projects.find(item => item.id === p.id); if (target?.runtime?.request.requestId === binding.request.requestId) { target.runtime.submitting = true; target.runtime.connectionError = undefined; } });
    try {
      let task = binding.task;
      if (!task) task = await findTask(p.id, binding.request.requestId);
      if (action === 'resume' && runtimeResumeMessage(task)) throw new Error(runtimeResumeMessage(task));
      if (task) recordTask(action === 'cancel' || ['failed', 'interrupted', 'cancelled'].includes(task.status) ? await controlTask(task.id, action) : task, p.id, binding.request.requestId);
      else if (action === 'resume') recordTask(await submitTask(binding.request), p.id, binding.request.requestId);
      else recordError(p.id, binding.request.requestId, new Error('尚未确认服务端任务，无法确认取消。请检查连接后重试。'));
    } catch (error) { recordError(p.id, binding.request.requestId, error); void checkConnection(); }
    finally { pendingRequests.current.delete(p.id); }
  };
  const resizeFromPointer = (clientX: number) => { const rect = splitterRef.current?.parentElement?.getBoundingClientRect(); if (rect) setChatWidth(Math.max(32, Math.min(60, (clientX - rect.left) / rect.width * 100))); };
  return <MotionConfig reducedMotion={state.settings.reduceMotion ? 'always' : 'user'}><WorkspaceContext.Provider value={{ state, update, notify, openProject, startNew }}>
    <div className={cx('app-shell', state.page === 'create' && !project && 'is-home')}>
      {!state.account.signedIn ? <LoginPage /> : <>
        <nav className="tool-rail" aria-label="主导航"><Button variant="ghost" className="brand-button" aria-label="Talewick 创作首页" onClick={startNew}><Logo /></Button><div className="rail-main">
          <Hint text="新建创作"><IconButton icon={RiPencilLine} aria-label="新建创作" className={cx('rail-button', state.page === 'create' && 'is-active')} onClick={startNew} /></Hint>
          <Hint text="创作记录"><IconButton icon={RiHistoryLine} aria-label="创作记录" className="rail-button" onClick={() => setHistoryOpen(true)} /></Hint>
          <Hint text="知识库"><IconButton icon={RiBookOpenLine} aria-label="知识库" className={cx('rail-button', state.page === 'library' && 'is-active')} onClick={() => update(s => { s.page = 'library'; })} /></Hint>
          <Hint text="发布复盘"><IconButton icon={RiFileTextLine} aria-label="发布复盘" className={cx('rail-button', state.page === 'publication-feedback' && 'is-active')} onClick={() => update(s => { s.page = 'publication-feedback'; })} /></Hint>
          <Hint text="个人风格"><IconButton icon={RiSparklingLine} aria-label="个人风格" className={cx('rail-button', state.page === 'styles' && 'is-active')} onClick={() => update(s => { s.page = 'styles'; })} /></Hint>
        </div><div className="rail-bottom"><Hint text="设置"><IconButton icon={RiSettings3Line} aria-label="设置" className={cx('rail-button', state.page === 'settings' && 'is-active')} onClick={() => update(s => { s.page = 'settings'; })} /></Hint><Hint text="我的账号"><IconButton icon={RiUser3Line} aria-label="我的账号" className={cx('rail-button', state.page === 'account' && 'is-active')} onClick={() => update(s => { s.page = 'account'; })} /></Hint></div></nav>
        <main className="workspace">
          {state.page === 'publication-feedback' ? <PublicationFeedback /> : state.page !== 'create' ? <SecondaryPage /> : !project ? <Home composer={<Composer onSend={() => { void send(); }} serviceMessage={serviceMessage} onCheck={() => { void checkConnection(); }} />} onContext={key => { setContextKey(key); setContextDraft(state.context[key]); }} /> : <div className={cx('creation-workspace', hasDoc && 'has-document', project.docExpanded && 'document-expanded')} style={{ '--chat-width': `${chatWidth}%` } as CSSProperties}>
            <Chat project={project} onStop={() => { void stopReply(); }} onSend={() => { void send(); }} onHistory={() => setHistoryOpen(true)} serviceMessage={[serviceMessage, toolsBlocked(project, state)].filter(Boolean).join(' · ')} onCheck={() => { void checkConnection(); }} onTaskAction={action => { void actOnTask(action); }} onResult={setInspectedTask} />
            {hasDoc && <><div ref={splitterRef} className="workspace-splitter" role="separator" tabIndex={0} aria-label="调整对话和文稿宽度" aria-orientation="vertical" aria-valuemin={32} aria-valuemax={60} aria-valuenow={Math.round(chatWidth)} onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setChatWidth(w => Math.max(32, Math.min(60, w + (e.key === 'ArrowRight' ? 2 : -2)))); } }} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); resizeFromPointer(e.clientX); }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) resizeFromPointer(e.clientX); }} onPointerUp={e => e.currentTarget.releasePointerCapture(e.pointerId)} /><ManuscriptPanel projectId={project.id} onQuote={(text, source) => update(s => { s.quote = text; s.quoteSource = source; const p = s.projects.find(p => p.id === project.id)!; p.docExpanded = false; if (window.matchMedia('(max-width: 900px)').matches) { p.docOpen = false; p.docClosedByUser = true; } })} /></>}
            {!hasDoc && project.chapters.length > 0 && <Button variant="secondary" leadingIcon={RiBookOpenLine} className="reopen-document" onClick={() => update(s => { const p = s.projects.find(p => p.id === project.id)!; p.docOpen = true; p.docClosedByUser = false; p.docUpdated = false; })}>{project.docUpdated ? '查看更新的文稿' : '打开文稿'}</Button>}
          </div>}
        </main><ProjectsDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />
      </>}
    </div>
    <DialogShell title="已保存草稿（未完成）" description="本次任务尚未完成。这里展示写作阶段保存的初稿，可能未包含后续修订。" open={Boolean(inspectedTask?.partialDraft)} onClose={() => setInspectedTask(null)} footer={<Button onClick={() => setInspectedTask(null)}>关闭</Button>}>
      {inspectedTask?.partialDraft && <div className="flex flex-col gap-4">
        <p className="text-body-medium">任务状态：{{ failed: '失败', interrupted: '中断', cancelled: '已取消' }[inspectedTask.status as 'failed' | 'interrupted' | 'cancelled']} · 已保存 {inspectedTask.partialDraft.availableChapterCount} / 计划 {inspectedTask.partialDraft.expectedChapterCount} 章</p>
        <p className="text-body-regular text-text-secondary">此处只读查看，不会替换你正在编辑的文稿。</p>
        {inspectedTask.partialDraft.chapters.map(chapter => <section key={chapter.id} className="flex flex-col gap-2"><h3 className="text-title-3-medium">{chapter.title}</h3><p className="whitespace-pre-wrap font-story text-headline-regular">{chapter.body}</p></section>)}
      </div>}
    </DialogShell>
    <DialogShell title={inspectedTask?.result?.title || '本次任务结果'} description="这里保留该任务返回的稿件和审阅说明。查看结果不会修改当前正文。" open={Boolean(inspectedTask?.result)} onClose={() => setInspectedTask(null)} footer={<Button onClick={() => setInspectedTask(null)}>关闭</Button>}>
      {inspectedTask?.result && <div className="flex flex-col gap-4">
        <p className="text-caption-1-regular text-text-secondary">本次执行：{runtimeEngineLabel(inspectedTask.engine)}{inspectedTask.engineVersion && ` · ${inspectedTask.engineVersion}`}</p>
        <ReviewAdjudication key={`adjudication-${inspectedTask.id}`} result={inspectedTask.result} currentChapters={inspectedProject?.chapters} />
        <MaterialResults key={inspectedTask.id} result={inspectedTask.result} />
        <ReadingObservations key={`reading-${inspectedTask.id}`} result={inspectedTask.result} />
        {Boolean(inspectedTask.result.agentTrace?.length) && <section className="flex flex-col gap-3" aria-label="Agent 决策摘要">
          <p className="text-body-medium">Agent 决策摘要</p>
          {inspectedTask.result.agentTrace!.map((decision, index) => {
            const targets = (decision.targetChapterIds ?? []).map(id => inspectedTask.result!.chapters.find(chapter => chapter.id === id)?.title || `章节 ${id}`);
            const action = Object.prototype.hasOwnProperty.call(agentActionNames, decision.action) ? agentActionNames[decision.action] : decision.action;
            return <section key={`${decision.toolCallId || index}-${index}`} className="flex flex-col gap-2 rounded-xl border border-border-button-default p-4">
              <p className="text-body-medium">{decision.phase === 'plan' ? '创作方案' : '稿件审阅'} · {action}{decision.round !== undefined && ` · 第 ${decision.round} 轮`}</p>
              <p className="whitespace-pre-wrap text-body-regular">理由：{decision.reason}</p>
              {targets.length > 0 && <p className="text-caption-1-regular text-text-secondary">涉及章节：{targets.join('、')}</p>}
              {(decision.evidence ?? []).filter(item => item.trim()).map((item, evidenceIndex) => <p key={evidenceIndex} className="whitespace-pre-wrap text-body-regular text-text-secondary">依据：{item}</p>)}
            </section>;
          })}
        </section>}
        {typeof inspectedTask.result.checks.bodyHanCount === 'number' && typeof inspectedTask.result.checks.chapterCount === 'number' && <p className="text-body-medium">正文 {inspectedTask.result.checks.bodyHanCount} 汉字 · {inspectedTask.result.checks.chapterCount} 章</p>}
        {Array.isArray(inspectedTask.result.checks.issues) && inspectedTask.result.checks.issues.map((issue, index) => issue && typeof issue === 'object' && typeof issue.message === 'string' ? <p key={`check-${index}`} className="text-body-regular text-text-secondary">{issue.message}</p> : null)}
        {inspectedTask.result.checks.full15 && typeof inspectedTask.result.checks.full15 === 'object' && (inspectedTask.result.checks.full15 as Record<string, unknown>).status === 'NOT_EVALUATED' ? <p className="text-body-regular text-text-secondary">Full15 本次未运行，以上为现有基础检查与创作审阅结果。</p> : null}
        {[...inspectedTask.result.warnings, ...(inspectedTask.result.review.limitations ?? [])].filter((item): item is string => typeof item === 'string').map((item, index) => <p key={index} className="text-body-regular text-text-secondary">{item}</p>)}
        <p className="text-caption-1-regular text-text-secondary">检查报告用于说明本次覆盖范围，不等同于作品质量保证。</p>
        {inspectedTask.result.chapters.map(chapter => <section key={chapter.id} className="flex flex-col gap-2"><p className="text-title-3-medium">{chapter.title}</p><p className="whitespace-pre-wrap font-story text-headline-regular">{chapter.body}</p></section>)}
      </div>}
    </DialogShell>
    <DialogShell title={`添加${inspirationNodes.find(n => n.id === contextKey)?.title ?? ''}灵感`} description="只需写下你已经想到的部分，剩下的可以在对话中慢慢展开。" open={contextKey !== null} onClose={() => setContextKey(null)} footer={<Button leadingIcon={RiCheckLine} onClick={() => { if (contextKey) update(s => { s.context[contextKey] = contextDraft; }); setContextKey(null); }}>保存灵感</Button>}><TextAreaField label="灵感内容" value={contextDraft} onChange={setContextDraft} rows={6} autoFocus placeholder="一个人物、一处场景，或者一句还没说完的话…" /></DialogShell>
    <NotificationViewport className="tw-notification-viewport" aria-label="操作提示" position="bottom-right">{toast && <Notification key={toast} title={toast} status="information" autoDismissDuration={5500} onDismiss={() => setToast('')} closeLabel="关闭提示" />}</NotificationViewport>
  </WorkspaceContext.Provider></MotionConfig>;
}
