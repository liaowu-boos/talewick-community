import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  RiAddLine, RiArrowLeftLine, RiArrowRightLine, RiArrowUpLine, RiBookOpenLine, RiCheckLine,
  RiDeleteBin6Line, RiDownload2Line, RiEditLine, RiEyeLine,
  RiEyeOffLine, RiFileTextLine, RiLockLine, RiLogoutBoxRLine, RiMailLine,
  RiSearchLine, RiSparklingLine, RiUploadCloud2Line,
} from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { IconButton } from '@/components/base/buttons/icon-button';
import { Input } from '@/components/base/input/input';
import { Select, SelectItem } from '@/components/base/select/select';
import { Tabs, TabList, Tab, TabPanel } from '@/components/base/tabs/tabs';
import { Switch } from '@/components/base/switch/switch';
import { Checkbox } from '@/components/base/checkbox/checkbox';
import { Slider } from '@/components/base/slider/slider';
import { Avatar } from '@/components/base/avatar/avatar';
import { SourceLibrary } from './SourceLibrary';
import { cx } from '@/utils/cx';
import { createId } from '@/model/seed';
import { characterCount, pendingEdits } from '@/model/store';
import { runtimeStage } from '@/model/runtime';
import type { LibraryItem, Project, Settings, StyleProfile } from '@/model/types';
import { useWorkspace } from './context';
import { DialogShell, EmptyState, TextAreaField, downloadText, formatDate } from './shared';

const textTypes = ['小说', '素材', '设定'] as const;
const LIBRARY_CHAR_LIMIT = 1_200_000;
const formatNumber = (value: number) => value.toLocaleString('zh-CN');
const tagsFromText = (value: string) => [...new Set(value.split(/[,，、\n]/).map(v => v.trim()).filter(Boolean))].slice(0, 8);
const emailIsValid = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const safeFilename = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_').trim() || '我的资料';

function SecondaryHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  const { state, update } = useWorkspace();
  const currentProject = state.projects.find(project => project.id === state.activeProjectId);
  return <header className="page-header secondary-heading">
    <div className="secondary-heading-copy">
      {currentProject && <Button variant="ghost" size="small" leadingIcon={RiArrowLeftLine} className="secondary-return" onClick={() => update(s => { s.page = 'create'; })}><span>返回当前创作</span><span className="text-text-tertiary">《{currentProject.title}》</span></Button>}
      <div className="secondary-wordmark text-title-2-semibold">Talewick</div>
      <h1 className="font-story text-title-1-medium">{title}</h1>
      <p className="text-body-regular text-text-secondary">{description}</p>
    </div>
    {actions && <div className="secondary-heading-actions">{actions}</div>}
  </header>;
}

function projectProgressLabel(project: Project) {
  const binding = project.runtime;
  if (binding) {
    if (binding.submitting) return '正在提交任务';
    if (binding.connectionError) return '任务状态待确认';
    if (binding.task && binding.task.status !== 'completed') return runtimeStage(binding.task);
    if (!binding.task) return '等待确认任务';
    if (binding.resultDisposition === 'held') return '结果待查看';
  }
  if (!binding && (project.paused || project.status === 'writing')) return '旧演示任务未接通';
  if (project.paused) return '已暂停';
  if (project.status === 'writing') return project.generationKind === 'opening' ? '开篇生成中' : '全文生成中';
  const pending = pendingEdits(project).length;
  if (pending) return `${pending} 处修改待审`;
  const labels: Record<Project['phase'], string> = {
    direction: '待选故事方向', premise: '待确认方案', turn: '待确认转折',
    opening: '开篇待确认', complete: '全文已生成', revision: '审稿中', done: '审阅已完成',
  };
  return labels[project.phase];
}

function WritingNote({ writing = false }: { writing?: boolean }) {
  return <div className={cx('writing-note', writing && 'writing-note-sage')} aria-hidden="true">
    <RiEditLine className="writing-note-icon" />
    <span className="font-story text-title-3-medium">{writing ? <>给故事<br />一点时间</> : '写下你的语感'}</span>
    <span className="writing-note-rules"><span /><span /><span /></span>
  </div>;
}

export function ProjectsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, openProject, startNew } = useWorkspace();
  const [query, setQuery] = useState('');
  const projects = useMemo(() => [...state.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter(p => `${p.title} ${p.idea}`.toLowerCase().includes(query.trim().toLowerCase())), [state.projects, query]);
  const close = () => { setQuery(''); onClose(); };
  return <DialogShell open={open} onClose={close} title="创作记录" description="接着写，或开启一个新世界。" className="projects-dialog"
    footer={<div className="projects-dialog-footer"><span className="text-body-regular text-text-tertiary">所有故事，都从一个念头开始。</span><span className="text-caption-1-medium text-text-tertiary"><kbd>Esc</kbd> 关闭</span></div>}>
    <div className="projects-search-row">
      <Input aria-label="搜索创作记录" leadingIcon={RiSearchLine} placeholder="搜索作品或灵感" value={query} onChange={setQuery} className="min-w-0 flex-1" />
      <Button leadingIcon={RiAddLine} onClick={() => { close(); startNew(); }}>新建创作</Button>
    </div>
    <p className="mb-3 mt-6 text-body-medium text-text-tertiary">最近创作</p>
    {projects.length ? <div className="project-switch-list">{projects.map(project => <Button key={project.id} variant="ghost" className={cx('project-switch-row', state.activeProjectId === project.id && 'is-current')} onClick={() => { close(); openProject(project.id); }}>
      <RiFileTextLine className="project-file-icon" aria-hidden />
      <span className="project-switch-copy"><span className="project-switch-title"><strong className="text-headline-medium">{project.title}</strong><span className={cx('project-status text-caption-1-medium', (!project.runtime || project.runtime.task?.status === 'completed') && !project.paused && project.status !== 'writing' && !pendingEdits(project).length && (project.phase === 'complete' || project.phase === 'done') && 'is-ready')}>{projectProgressLabel(project)}</span></span><span className="text-body-regular text-text-secondary project-switch-description">{project.idea || '还没写下的想法，等你继续。'}</span></span>
      <span className="project-switch-time text-caption-1-medium text-text-tertiary">{formatDate(project.updatedAt)}</span><RiArrowRightLine className="size-5 shrink-0" aria-hidden />
    </Button>)}</div> : <EmptyState icon={<RiSearchLine className="size-8 text-foreground-icon-tertiary" />} title={state.projects.length ? '还没有找到这个故事' : '故事，等你写下第一句'} description={state.projects.length ? '试试其他关键词，或者清除搜索。' : '把一个想法写下来，就会出现在这里。'}>{query ? <Button variant="secondary" onClick={() => setQuery('')}>清除搜索</Button> : <Button onClick={() => { close(); startNew(); }}>开始创作</Button>}</EmptyState>}
  </DialogShell>;
}

function LibraryPage() {
  const { state, update, notify } = useWorkspace();
  const currentProject = state.projects.find(project => project.id === state.activeProjectId);
  const selectedLibrary = currentProject ? currentProject.libraryIds : state.selectedLibrary;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('全部');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [legacyItem, setLegacyItem] = useState<LibraryItem | null>(null);
  const [draft, setDraft] = useState<LibraryItem | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [error, setError] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const filtered = useMemo(() => state.library.filter(item => (filter === '全部' || item.type === filter) && `${item.title} ${item.content} ${item.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase().trim())), [state.library, filter, query]);
  const openItem = (item?: LibraryItem) => { const value: LibraryItem = item ? structuredClone(item) : { id: createId('material'), title: '', type: '素材', content: '', chars: 0, status: 'ready', date: new Date().toISOString(), tags: [] }; setDraft(value); setTagInput(value.tags.join('，')); setError(''); };
  const saveItem = () => {
    if (!draft) return;
    if (!draft.title.trim()) { setError('请先为这份资料起个名字。'); return; }
    if (!draft.content.trim()) { setError('写下一些内容，再保存到知识库。'); return; }
    const total = state.library.reduce((sum, item) => sum + (item.id === draft.id ? 0 : item.content.length), 0);
    if (total + draft.content.length > LIBRARY_CHAR_LIMIT) { setError('本地资料容量已接近上限，请先导出并移除部分资料。'); return; }
    const next: LibraryItem = { ...draft, title: draft.title.trim(), tags: tagsFromText(tagInput), chars: characterCount(draft.content), status: 'ready', error: undefined, date: new Date().toISOString() };
    update(s => { const index = s.library.findIndex(item => item.id === next.id); if (index < 0) s.library.unshift(next); else s.library[index] = next; });
    setDraft(null); notify('资料已保存在本地知识库');
  };
  const toggleReference = (id: string) => {
    const selected = selectedLibrary.includes(id);
    update(s => {
      const target = s.projects.find(project => project.id === currentProject?.id);
      const references = target ? target.libraryIds : s.selectedLibrary;
      const next = selected ? references.filter(value => value !== id) : [...new Set([...references, id])];
      if (target) target.libraryIds = next;
      else s.selectedLibrary = next;
    });
    notify(currentProject ? selected ? '已移出当前作品的参考资料' : `已加入《${currentProject.title}》的参考资料` : selected ? '已移出创作参考' : '已加入下一次创作的参考资料');
  };
  const confirmDelete = () => {
    if (!deleteId) return;
    update(s => { s.library = s.library.filter(item => item.id !== deleteId); s.selectedLibrary = s.selectedLibrary.filter(id => id !== deleteId); s.styles.forEach(style => { style.sourceIds = style.sourceIds.filter(id => id !== deleteId); }); s.projects.forEach(project => { project.libraryIds = project.libraryIds.filter(id => id !== deleteId); }); });
    setDeleteId(null); setDraft(null); notify('资料已删除，已写成的稿件与风格规则仍然保留');
  };
  return <section className="secondary-page library-page">
    <SecondaryHeader title="知识库" description="收藏自己的作品、经验与设定，为下一次创作积累灵感。" actions={<><Button leadingIcon={RiUploadCloud2Line} onClick={() => { setLegacyItem(null); setUploadOpen(true); }}>上传作品</Button><Button variant="secondary" leadingIcon={RiAddLine} onClick={() => openItem()}>新建素材</Button></>} />
    <Button variant="ghost" className="library-upload-hero paper-panel" onClick={() => { setLegacyItem(null); setUploadOpen(true); }}>
      <span className="library-document-art" aria-hidden><RiFileTextLine /></span><span className="library-upload-copy"><strong className="font-story text-title-2-medium">把你的故事，放进这里</strong><span className="text-headline-regular text-text-secondary">导入小说、文档或创作素材</span><span className="text-body-regular text-text-tertiary">支持 TXT、Markdown · 上传后在后台保存并拆解</span></span><span className="library-upload-action" aria-hidden><RiArrowUpLine className="size-8" /></span>
    </Button>
    <SourceLibrary uploadOpen={uploadOpen} onClose={() => setUploadOpen(false)} legacyItem={legacyItem} />
    <h2 className="font-story text-title-2-medium">浏览器资料</h2>
    <p className="text-body-regular text-text-secondary">原有资料继续保留；选择“送去拆解”才会上传文字副本。</p>
    <div className="library-toolbar"><Tabs selectedKey={filter} onSelectionChange={key => setFilter(String(key))}><TabList aria-label="资料类型">{['全部', ...textTypes].map(type => <Tab key={type} id={type}>{type}</Tab>)}</TabList></Tabs><Input aria-label="搜索知识库" value={query} onChange={setQuery} leadingIcon={RiSearchLine} placeholder="搜索资料" className="library-search" /></div>
    {filtered.length ? <div className="library-grid">{filtered.map(item => <article key={item.id} className={cx('library-card paper-panel', selectedLibrary.includes(item.id) && 'is-selected', item.status === 'error' && 'has-error')}>
      <div className="library-card-heading"><RiFileTextLine className="library-card-icon" aria-hidden /><div><h2 className="font-story text-title-3-medium">{item.title}</h2><p className="text-body-2-regular text-text-tertiary">{item.type} · {item.status === 'ready' ? `${formatNumber(item.chars)} 字` : item.status === 'processing' ? '正在读取' : '导入未完成'}</p></div><IconButton icon={RiEditLine} size="small" aria-label={`查看与编辑${item.title}`} onClick={() => openItem(item)} className="library-card-edit" /></div>
      <p className={cx('library-card-excerpt font-story text-headline-regular', item.status === 'error' ? 'text-text-error-primary' : 'text-text-secondary')}>{item.status === 'processing' ? '正在整理这份文字，稍等片刻……' : item.error || item.content.replace(/[#>*_`]/g, '').slice(0, 90)}</p>
      <div className="library-tags">{item.tags.slice(0, 3).map(tag => <span key={tag} className="text-body-2-regular">{tag}</span>)}</div>
      <footer><Button variant="ghost" size="small" disabled={item.status !== 'ready'} onClick={() => { setLegacyItem(item); setUploadOpen(true); }}>送去拆解</Button><span className="text-caption-1-medium text-text-tertiary">{new Date(item.date).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</span><Button variant="ghost" size="small" leadingIcon={selectedLibrary.includes(item.id) ? RiCheckLine : RiAddLine} disabled={item.status !== 'ready'} onClick={() => toggleReference(item.id)} aria-pressed={selectedLibrary.includes(item.id)}>{selectedLibrary.includes(item.id) ? currentProject ? '当前作品使用' : '已选用' : currentProject ? '用于当前作品' : '用于创作'}</Button></footer>
    </article>)}</div> : <EmptyState icon={<RiBookOpenLine className="size-10 text-foreground-icon-secondary" />} title={state.library.length ? '没有找到这份灵感' : '把你的第一份文字，留在这里'} description={state.library.length ? '试试其他关键词，或清除筛选。' : '上传自己的小说，或记录一段人物设定、生活观察。'}><Button variant="secondary" onClick={() => { if (state.library.length) { setQuery(''); setFilter('全部'); } else setUploadOpen(true); }}>{state.library.length ? '清除筛选' : '上传第一份作品'}</Button></EmptyState>}
    <p className="secondary-footnote text-body-2-regular text-text-tertiary"><RiLockLine className="size-4" aria-hidden />本区资料保存在当前浏览器；选用于创作或送去拆解时，相关文字会交给后台与模型服务处理。</p>
    <DialogShell title={draft && state.library.some(l => l.id === draft.id) ? '查看与编辑资料' : '留住这一份灵感'} open={Boolean(draft) && !deleteId} onClose={() => setDraft(null)} className="secondary-form-dialog"
      footer={<><Button variant="ghost" leadingIcon={RiDownload2Line} disabled={!draft?.content} onClick={() => { if (draft) downloadText(`${safeFilename(draft.title)}.txt`, draft.content); }}>导出 TXT</Button>{draft && state.library.some(l => l.id === draft.id) && <Button variant="danger" leadingIcon={RiDeleteBin6Line} onClick={() => setDeleteId(draft.id)}>删除资料</Button>}<Button onClick={saveItem}>保存资料</Button></>}>
      {draft && <div className="secondary-form"><div className="secondary-form-pair"><Input label="名称" value={draft.title} onChange={title => { setDraft({ ...draft, title }); setError(''); }} maxLength={80} placeholder="为这份资料起个名字" /><div className="secondary-form-field"><span className="text-body-medium">类型</span><Select aria-label="资料类型" selectedKey={draft.type} onSelectionChange={type => setDraft({ ...draft, type: String(type) as LibraryItem['type'] })}>{textTypes.map(type => <SelectItem key={type} id={type}>{type}</SelectItem>)}</Select></div></div><Input label="标签" value={tagInput} onChange={setTagInput} placeholder="如：悬疑，人物，留白；用逗号分隔" maxLength={120} /><div className="secondary-form-field"><span className="text-body-medium">内容</span><TextAreaField label="资料内容" value={draft.content} onChange={content => { setDraft({ ...draft, content }); setError(''); }} rows={10} placeholder="写下或粘贴你的文字……" inputClassName="font-story" /></div><div className="secondary-form-meta text-caption-1-medium text-text-tertiary"><span>资料保存在当前浏览器</span><span>{formatNumber(characterCount(draft.content))} 字</span></div>{draft.error && <p className="text-body-regular text-text-error-primary">{draft.error} 可以在上方直接补充文字。</p>}{error && <p role="alert" className="text-body-regular text-text-error-primary">{error}</p>}</div>}
    </DialogShell>
    <DialogShell title="删除这份资料？" description="本地资料会被移除，已经写成的稿件和已保存的风格规则会保留。" open={Boolean(deleteId)} onClose={() => setDeleteId(null)} footer={<><Button variant="secondary" onClick={() => setDeleteId(null)}>保留资料</Button><Button variant="danger" onClick={confirmDelete}>确认删除</Button></>}><p className="text-headline-medium">{draft?.title}</p><p className="mt-3 text-body-regular text-text-tertiary">如果还需要这份文字，可以返回详情先导出 TXT。</p></DialogShell>
  </section>;
}

function StylePage() {
  const { state, update, notify } = useWorkspace();
  const currentProject = state.projects.find(project => project.id === state.activeProjectId);
  const selectedStyleId = currentProject ? currentProject.styleId : state.selectedStyle;
  const selectedSources = currentProject ? currentProject.libraryIds : state.selectedLibrary;
  const [draft, setDraft] = useState<StyleProfile | null>(null);
  const [traits, setTraits] = useState('');
  const [error, setError] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const active = state.styles.find(style => style.id === selectedStyleId);
  const readySources = state.library.filter(item => item.status === 'ready');
  const openStyle = (item?: StyleProfile, useSources = false) => { const style: StyleProfile = item ? structuredClone(item) : { id: createId('style'), name: '', description: '', sourceIds: useSources ? [...selectedSources] : [], traits: [], rules: '', active: false, date: new Date().toISOString() }; setDraft(style); setTraits(style.traits.join('，')); setError(''); };
  const saveStyle = () => {
    if (!draft) return;
    if (!draft.name.trim()) { setError('请为这份风格起个名字。'); return; }
    if (!draft.rules.trim()) { setError('至少写下一条具体的创作规则。'); return; }
    const next = { ...draft, name: draft.name.trim(), description: draft.description.trim(), traits: tagsFromText(traits), date: new Date().toISOString() };
    update(s => { const index = s.styles.findIndex(style => style.id === next.id); if (index < 0) s.styles.push(next); else s.styles[index] = next; }); setDraft(null); notify('个人风格已保存');
  };
  const activate = (id: string) => {
    const selected = selectedStyleId === id;
    update(s => {
      const target = s.projects.find(project => project.id === currentProject?.id);
      if (target) target.styleId = selected ? null : id;
      else {
        s.selectedStyle = selected ? null : id;
        s.styles.forEach(style => { style.active = style.id === s.selectedStyle; });
      }
    });
    notify(currentProject ? selected ? '当前作品已停用这份风格' : `《${currentProject.title}》将参考这份风格规则` : selected ? '已停用个人风格' : '下一次创作将参考这份风格规则');
  };
  const template = () => { if (!draft) return; setDraft({ ...draft, name: draft.name || '我的叙事习惯', description: draft.description || '用细节推动故事，让情绪留在字里行间。', rules: '用人物动作和具体物件表现情绪，避免直接解释感受。\n对话保持简短，让每句话推动人物关系或故事。\n长短句交替，用短句落下关键动作。\n章节结尾留下一个具体问题，不用总结代替故事。\n保留必要的留白，避免堆叠抽象情绪词。' }); setTraits('短句，细节叙事，留白'); notify('已填入演示规则，请按自己的写作习惯修改'); };
  return <section className="secondary-page personal-style-page">
    <SecondaryHeader title="个人风格" description="从自己的作品中，整理节奏、措辞与叙事偏爱。" actions={<Button leadingIcon={RiAddLine} onClick={() => openStyle()}>新建风格</Button>} />
    <div className="style-signature paper-panel"><WritingNote /><div className="style-signature-copy"><span className="text-body-medium text-text-secondary">{currentProject ? '当前作品的创作风格' : active ? '下一次创作的风格' : '你的创作风格'}</span><h2 className="font-story text-title-1-medium">{active?.name || '每个人，都有自己的语感'}</h2><p className="text-headline-regular text-text-secondary">{active?.description || (currentProject ? '当前作品尚未使用个人风格，可以从下方选择一份。' : '把你的写作偏爱，整理成下一次创作的起点。')}</p><div className="style-traits">{(active?.traits || ['节奏', '措辞', '叙事习惯']).slice(0, 4).map(trait => <span className="text-body-medium" key={trait}>{trait}</span>)}</div></div><div className="style-signature-action"><Button variant="secondary" leadingIcon={RiEditLine} onClick={() => openStyle(active)}>{active ? '编辑规则' : '建立风格'}</Button><span className="text-body-regular text-text-tertiary">{active ? active.sourceIds.length ? `参考 ${active.sourceIds.length} 份个人作品` : '手动整理的写作规则' : '从自己的文字出发'}</span></div></div>
    <div className="secondary-section-heading"><h2 className="text-headline-medium">我的风格手册</h2><p className="text-body-regular text-text-tertiary">每一种表达，都可以慢慢打磨</p></div>
    {state.styles.length ? <div className="style-library-grid">{state.styles.map(style => <article className={cx('style-rule-card paper-panel', style.id === selectedStyleId && 'is-active')} key={style.id}><header><h3 className="font-story text-title-2-medium">{style.name}</h3><span className={cx('text-body-2-medium', style.id === selectedStyleId ? 'text-tw-warm' : 'text-text-tertiary')}>{style.id === selectedStyleId ? <><RiCheckLine className="size-4" aria-hidden />{currentProject ? '当前作品使用' : '使用中'}</> : style.sourceIds.length ? '作品参考' : '手动整理'}</span></header><ul>{style.rules.split(/\n/).map(rule => rule.replace(/^\d+[.、．]\s*/, '').trim()).filter(Boolean).slice(0, 3).map((rule, i) => <li className="text-headline-regular text-text-secondary" key={i}>{rule}</li>)}</ul><div className="style-source-line text-body-regular text-text-tertiary"><RiBookOpenLine className="size-5 shrink-0" aria-hidden /><span>{style.sourceIds.length ? `参考：${style.sourceIds.map(id => state.library.find(item => item.id === id)?.title).filter(Boolean).join('、') || '已归档作品'}` : '手动整理的创作规则'}</span></div><footer><Button variant="ghost" size="small" trailingIcon={RiArrowRightLine} onClick={() => openStyle(style)}>查看规则</Button><Button variant={style.id === selectedStyleId ? 'ghost' : 'secondary'} size="small" onClick={() => activate(style.id)} aria-pressed={style.id === selectedStyleId}>{style.id === selectedStyleId ? '停用风格' : currentProject ? '用于当前作品' : '用于创作'}</Button></footer></article>)}</div> : <EmptyState icon={<RiSparklingLine className="size-10 text-tw-warm" />} title="从你的一段文字开始" description="整理几条写作习惯，就能建立第一份个人风格。"><Button onClick={() => openStyle()}>建立我的风格</Button></EmptyState>}
    <Button variant="ghost" className="style-from-source paper-panel" onClick={() => openStyle(undefined, true)}><RiBookOpenLine className="size-7 shrink-0" aria-hidden /><span className="font-story text-headline-regular">从自己的小说，整理一份新的风格手册。</span><span className="text-body-medium">从作品开始 <RiArrowRightLine className="size-5" aria-hidden /></span></Button>
    <p className="secondary-footnote text-body-2-regular text-text-tertiary">这里保存你确认过的规则；自动学习个人风格将在后端接入后提供。</p>
    <DialogShell title={draft && state.styles.some(style => style.id === draft.id) ? '编辑风格规则' : '整理你的写作习惯'} open={Boolean(draft) && !deleteId} onClose={() => setDraft(null)} className="secondary-form-dialog" footer={<>{draft && state.styles.some(style => style.id === draft.id) && <Button variant="danger" leadingIcon={RiDeleteBin6Line} onClick={() => setDeleteId(draft.id)}>删除风格</Button>}<Button onClick={saveStyle}>保存风格</Button></>}>
      {draft && <div className="secondary-form"><Input label="风格名称" value={draft.name} onChange={name => { setDraft({ ...draft, name }); setError(''); }} maxLength={40} placeholder="如：克制的悬疑叙事" /><Input label="一句话描述" value={draft.description} onChange={description => setDraft({ ...draft, description })} maxLength={120} placeholder="你希望文字是什么样子" /><div className="secondary-form-field"><span className="text-body-medium">参考作品 <span className="text-text-tertiary">可选</span></span>{readySources.length ? <div className="style-source-picker">{readySources.map(source => <Checkbox key={source.id} isSelected={draft.sourceIds.includes(source.id)} onChange={selected => setDraft({ ...draft, sourceIds: selected ? [...draft.sourceIds, source.id] : draft.sourceIds.filter(id => id !== source.id) })}>{source.title}</Checkbox>)}</div> : <p className="text-body-regular text-text-tertiary">知识库还没有资料，也可以先手动写下规则。</p>}</div><Input label="风格标签" value={traits} onChange={setTraits} placeholder="短句，细节叙事，留白；用逗号分隔" maxLength={120} /><div className="secondary-form-field"><span className="text-body-medium">写作规则</span><TextAreaField label="写作规则" value={draft.rules} onChange={rules => { setDraft({ ...draft, rules }); setError(''); }} rows={7} maxLength={12000} placeholder="写下偏爱的叙述方式、常用句式，以及希望避免的表达……" /></div><div className="style-template-row"><p className="text-body-2-regular text-text-tertiary">需要一点起点？先填入示例，再改成自己的规则。</p><Button variant="secondary" size="small" leadingIcon={RiSparklingLine} onClick={template}>填入演示规则</Button></div>{error && <p role="alert" className="text-body-regular text-text-error-primary">{error}</p>}</div>}
    </DialogShell>
    <DialogShell title="删除这份风格？" open={Boolean(deleteId)} onClose={() => setDeleteId(null)} description="删除后不会改变已经写成的稿件。" footer={<><Button variant="secondary" onClick={() => setDeleteId(null)}>保留风格</Button><Button variant="danger" onClick={() => { update(s => { s.styles = s.styles.filter(style => style.id !== deleteId); if (s.selectedStyle === deleteId) s.selectedStyle = null; s.projects.forEach(project => { if (project.styleId === deleteId) project.styleId = null; }); }); setDeleteId(null); setDraft(null); notify('风格已删除'); }}>确认删除</Button></>}><p className="text-headline-medium">{draft?.name}</p></DialogShell>
  </section>;
}

function SettingsPage() {
  const { state, update, notify } = useWorkspace();
  const [draft, setDraft] = useState<Settings>({ ...state.settings });
  const dirty = draft.fontSize !== state.settings.fontSize || draft.autoSave !== state.settings.autoSave || draft.reduceMotion !== state.settings.reduceMotion;
  return <section className="secondary-page settings-page"><SecondaryHeader title="设置" description="调整阅读与保存习惯，把注意力留给故事。" />
    <div className="settings-layout"><div className="settings-main paper-panel"><section><h2 className="text-headline-medium text-text-secondary">阅读</h2><div className="settings-reading"><div className="setting-label-row"><div><h3 className="text-headline-medium">稿件字号</h3><p className="text-body-regular text-text-tertiary">调整文稿区域的正文大小</p></div><span className="setting-value text-body-medium">{draft.fontSize} px</span></div><Slider aria-label="稿件字号" value={draft.fontSize} minValue={16} maxValue={24} step={1} showTooltip={false} thumbLabel="" onChange={fontSize => setDraft({ ...draft, fontSize })} /><div className="slider-endpoints text-body-2-regular text-text-tertiary"><span>16</span><span>24</span></div><div className="settings-prose-sample font-story text-text-secondary" style={{ fontSize: `${draft.fontSize}px` }}><p>雨停的时候，巷口的灯恰好亮了。</p><p>她把那封没有署名的信，重新放进口袋。</p></div></div></section><section><h2 className="text-headline-medium text-text-secondary">创作体验</h2><div className="settings-preferences"><div className="setting-preference-row"><div><h3 className="text-headline-medium">自动保存稿件</h3><p className="text-body-regular text-text-tertiary">编辑后自动保存，让灵感安心留下。</p></div><Switch className="settings-switch" aria-label="自动保存稿件" isSelected={draft.autoSave} onChange={autoSave => setDraft({ ...draft, autoSave })} /></div><div className="setting-preference-row"><div><h3 className="text-headline-medium">减少动态效果</h3><p className="text-body-regular text-text-tertiary">减少卡片移动与界面过渡。</p></div><Switch className="settings-switch" aria-label="减少动态效果" isSelected={draft.reduceMotion} onChange={reduceMotion => setDraft({ ...draft, reduceMotion })} /></div></div></section><footer><span className="text-body-2-regular text-text-tertiary">{dirty ? '有未保存的设置' : '设置仅影响当前浏览器'}</span><Button onClick={() => { update(s => { s.settings = { ...draft }; }); notify('设置已保存'); }}>保存设置</Button></footer></div><aside className="settings-reflection"><WritingNote writing /><h2 className="font-story text-title-1-medium">在这里，慢慢写。</h2><p className="font-story text-headline-regular text-text-secondary">舒适的界面，<br />是为了让故事留得更久。</p><div className="settings-signature"><span className="font-story text-title-3-medium">Talewick</span><span className="text-body-regular text-text-tertiary">你的私人创作空间</span></div></aside></div>
  </section>;
}

function AccountPage() {
  const { state, update, notify } = useWorkspace();
  const [name, setName] = useState(state.account.name);
  const [email, setEmail] = useState(state.account.email);
  const [error, setError] = useState('');
  if (!state.account.signedIn) return <LoginPage />;
  const saveProfile = (event: FormEvent) => { event.preventDefault(); if (!name.trim()) { setError('填写一个你喜欢的称呼吧。'); return; } if (!emailIsValid(email)) { setError('请输入完整的邮箱格式。'); return; } update(s => { s.account.name = name.trim(); s.account.email = email.trim(); }); setError(''); notify('个人资料已保存在本机'); };
  return <section className="secondary-page account-page"><SecondaryHeader title="我的账号" description={`你好，${state.account.name}。这是你的创作空间，也是故事暂时停靠的地方。`} />
    <div className="account-layout"><form className="profile-card paper-panel" onSubmit={saveProfile}><div className="profile-identity"><Avatar src={state.account.avatar} initials={state.account.name.slice(0, 1)} alt="当前账号头像" className="profile-avatar text-title-1-medium" /><div><h2 className="font-story text-title-1-medium">{state.account.name}</h2><p className="text-body-regular text-text-secondary">创作者 <span className="profile-demo-label text-caption-1-medium">本地演示</span></p></div></div><div className="profile-form"><Input label="称呼" value={name} onChange={value => { setName(value); setError(''); }} maxLength={24} autoComplete="nickname" /><Input label="邮箱" type="email" value={email} onChange={value => { setEmail(value); setError(''); }} autoComplete="email" />{error && <p className="text-body-regular text-text-error-primary" role="alert">{error}</p>}<Button type="submit" leadingIcon={RiCheckLine}>保存资料</Button></div></form><div className="account-writing paper-panel"><h2 className="font-story text-title-2-medium">我的创作</h2><dl><div><dt className="font-story text-headline-regular">创作项目</dt><dd className="text-title-2-medium">{state.projects.length}</dd></div><div><dt className="font-story text-headline-regular">知识库资料</dt><dd className="text-title-2-medium">{state.library.filter(item => item.status === 'ready').length}</dd></div><div><dt className="font-story text-headline-regular">个人风格</dt><dd className="text-title-2-medium">{state.styles.length}</dd></div></dl><p className="font-story text-headline-regular text-text-secondary">属于你的故事，正在慢慢成形。</p><p className="mt-3 text-body-2-regular text-text-tertiary">演示账号不提供云端同步，资料保存在当前浏览器。</p></div></div>
    <footer className="account-footer"><span className="font-story text-headline-regular text-text-tertiary">Talewick · 从想法，到整个世界。</span><Button variant="ghost" leadingIcon={RiLogoutBoxRLine} onClick={() => { update(s => { s.account.signedIn = false; }); notify('已退出演示账号，本地创作仍然保留'); }}>退出账号</Button></footer>
  </section>;
}

export function LoginPage() {
  const { state, update, notify } = useWorkspace();
  const [tab, setTab] = useState('login');
  const [email, setEmail] = useState(state.account.email || '');
  const [name, setName] = useState(state.account.name || '');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [codeMode, setCodeMode] = useState(false);
  const [code, setCode] = useState('');
  const [codeRequested, setCodeRequested] = useState(false);
  const [error, setError] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const changeTab = (key: string) => { setTab(key); setCodeMode(false); setError(''); setPassword(''); };
  const requestCode = () => { if (!emailIsValid(email)) { setError('先填写完整的邮箱，再体验验证码登录。'); return; } setCodeRequested(true); setError(''); notify('演示验证码为 123456，不会发送真实邮件'); };
  const signIn = (event: FormEvent) => {
    event.preventDefault();
    if (!emailIsValid(email)) { setError('请输入完整的邮箱格式，例如 you@example.com。'); return; }
    if (tab === 'register' && !name.trim()) { setError('先填写一个你喜欢的称呼。'); return; }
    if (codeMode ? code !== '123456' : password.length < 6) { setError(codeMode ? '演示验证码为 123456。' : '输入至少 6 位演示密码即可，密码不会保存或发送。'); return; }
    update(s => { s.account = { ...s.account, name: name.trim() || s.account.name || '创作者', email: email.trim(), signedIn: true }; s.page = 'create'; });
    setPassword(''); setCode(''); notify(tab === 'register' ? '演示账号已创建，欢迎来到 Talewick' : '欢迎回来，已进入本地演示账号');
  };
  const fields = <form className="login-form" onSubmit={signIn}>
    {tab === 'register' && <Input label="称呼" value={name} onChange={setName} placeholder="希望怎么称呼你" maxLength={24} autoComplete="nickname" />}
    <Input label="邮箱" type="email" value={email} onChange={value => { setEmail(value); setError(''); setCodeRequested(false); }} placeholder="you@example.com" autoComplete="email" />
    {codeMode ? <><div className="login-code-row"><Input label="演示验证码" value={code} onChange={value => { setCode(value); setError(''); }} placeholder="输入 123456" maxLength={6} inputMode="numeric" autoComplete="one-time-code" /><Button variant="secondary" onClick={requestCode}>{codeRequested ? '再次获取' : '获取验证码'}</Button></div><p className="text-body-2-regular text-text-tertiary">{codeRequested ? '演示验证码：123456；未发送真实邮件。' : '当前仅演示验证码流程，不会发送邮件。'}</p></> : <div className="login-password"><Input label="密码" type={visible ? 'text' : 'password'} value={password} onChange={value => { setPassword(value); setError(''); }} placeholder="输入至少 6 位演示密码" autoComplete={tab === 'register' ? 'new-password' : 'current-password'} /><IconButton icon={visible ? RiEyeOffLine : RiEyeLine} aria-label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(value => !value)} className="password-visibility" /></div>}
    {tab === 'login' && !codeMode && <Button variant="ghost" size="small" className="forgot-password" onClick={() => setResetOpen(true)}>忘记密码？</Button>}
    {error && <p className="text-body-regular text-text-error-primary" role="alert">{error}</p>}
    <Button type="submit" className="login-submit">{tab === 'register' ? '创建演示账号' : '登录'}</Button>
    {tab === 'login' && <><div className="login-divider text-body-regular text-text-tertiary"><span />或<span /></div><Button variant="secondary" leadingIcon={codeMode ? RiLockLine : RiMailLine} className="login-alternate" onClick={() => { setCodeMode(value => !value); setError(''); }}>{codeMode ? '使用密码登录' : '邮箱验证码登录'}</Button></>}
  </form>;
  return <section className="secondary-page login-page"><div className="secondary-wordmark text-title-2-semibold">Talewick</div><div className="login-layout"><div className="login-story"><div className="login-notes" aria-hidden="true"><div className="login-note login-note-rose"><RiEditLine /><span className="font-story text-title-3-medium">一个念头</span></div><div className="login-note login-note-blue"><RiFileTextLine /><span className="font-story text-title-3-medium">一页故事</span><span className="login-note-line" /><span className="login-note-line" /></div><div className="login-note login-note-sage"><RiBookOpenLine /><span className="font-story text-title-3-medium">你的世界</span></div></div><h1 className="font-story text-title-1-medium">从想法，到整个世界。</h1><p className="font-story text-headline-regular text-text-secondary">把你的故事，留在这里。<br />每一次落笔，都有迹可循。</p></div><div className="login-card paper-panel"><h2 className="font-story text-title-1-medium">{tab === 'register' ? '写下新的开始' : '欢迎回来'}</h2><p className="text-headline-regular text-text-secondary">登录你的 Talewick 创作空间</p><Tabs selectedKey={tab} onSelectionChange={key => changeTab(String(key))} className="login-tabs"><TabList aria-label="账号操作"><Tab id="login">登录</Tab><Tab id="register">注册</Tab></TabList><TabPanel id="login">{tab === 'login' && fields}</TabPanel><TabPanel id="register">{tab === 'register' && fields}</TabPanel></Tabs><p className="login-create-account text-body-regular text-text-secondary">{tab === 'login' ? '还没有账号？' : '已经有账号？'}<Button variant="ghost" size="small" onClick={() => changeTab(tab === 'login' ? 'register' : 'login')}>{tab === 'login' ? '创建账号' : '返回登录'}</Button></p><p className="login-demo-note text-caption-1-medium text-text-tertiary"><RiLockLine className="size-3.5 shrink-0" aria-hidden />本地交互演示，密码不会保存或发送</p></div></div><DialogShell title="找回密码" description="当前是本地演示账号，无需找回真实密码。" open={resetOpen} onClose={() => setResetOpen(false)} footer={<><Button variant="secondary" onClick={() => setResetOpen(false)}>返回登录</Button><Button onClick={() => { setResetOpen(false); setCodeMode(true); setCodeRequested(true); notify('请使用演示验证码 123456'); }}>体验验证码登录</Button></>}><p className="text-body-regular text-text-secondary">你可以使用任意 6 位及以上演示密码，或体验验证码 123456 登录。</p></DialogShell></section>;
}

export function SecondaryPage() {
  const { state } = useWorkspace();
  switch (state.page) {
    case 'library': return <LibraryPage />;
    case 'styles': return <StylePage />;
    case 'settings': return <SettingsPage />;
    case 'account': return <AccountPage />;
    default: return null;
  }
}
