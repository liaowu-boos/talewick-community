import { useCallback, useState, type ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import { RiArrowRightLine, RiBookOpenLine, RiCheckLine, RiFileTextLine, RiPauseLine, RiPlayLine, RiRefreshLine, RiRestartLine } from '@remixicon/react';
import { Button, ButtonLink } from '@/components/base/buttons/button';
import { Input } from '@/components/base/input/input';
import { Switch } from '@/components/base/switch/switch';
import { Tabs, TabList, Tab, TabPanel } from '@/components/base/tabs/tabs';
import { Notification, NotificationViewport } from '@/components/base/notification/notification';
import { AgentThinking } from '@/components/application/agent-thinking/agent-thinking';
import { Composer } from '@/App';
import { InspirationNote, inspirationNodes } from '@/features/Home';
import { ManuscriptPanel } from '@/features/ManuscriptPanel';
import { DialogShell, EmptyState, Logo, TextAreaField } from '@/features/shared';
import { WorkspaceContext } from '@/features/context';
import { createId, createInitialState } from '@/model/seed';
import type { AppState, InspirationKey } from '@/model/types';

const colors = [
  ['画布', '--color-background-full', '页面底色'], ['纸面', '--tw-paper', '输入与文稿'],
  ['墨色', '--tw-ink', '文字与主要操作'], ['暗红', '--tw-warm', '选中与审阅标记'],
  ['角色', '--tw-note-rose', '人物与渴望'], ['世界观', '--tw-note-blue', '地点与规则'],
  ['情节', '--tw-note-cream', '事件与冲突'], ['主题', '--tw-note-sage', '故事想说的话'],
];
const flowStates = [['idle', '待开始'], ['writing', '生成中'], ['paused', '已暂停'], ['error', '失败'], ['complete', '完成']] as const;
type FlowState = typeof flowStates[number][0];

function specimenState() {
  const state = createInitialState();
  const project = state.projects[0];
  project.id = createId('design-specimen');
  project.docMode = 'review';
  project.pendingEdits = [{ id: 'specimen-edit', chapterId: project.chapters[0].id, before: '她把钥匙攥紧，指节渐渐发白。', after: '她把钥匙攥紧，又缓缓松开。', reason: '把强烈情绪收回到一个更克制的动作。', status: 'pending' }];
  return state;
}

function SpecSection({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return <section id={id} className="spec-section" aria-labelledby={`${id}-title`}><header className="spec-section-heading"><h2 id={`${id}-title`} className="text-title-2-semibold">{title}</h2><p className="text-body-regular text-text-secondary">{description}</p></header>{children}</section>;
}

export function DesignPreview() {
  const [state, setState] = useState(specimenState);
  const [toast, setToast] = useState('');
  const [flow, setFlow] = useState<FlowState>('idle');
  const [contextKey, setContextKey] = useState<InspirationKey | null>(null);
  const [contextDraft, setContextDraft] = useState('');
  const [name, setName] = useState('雨停之前');
  const [hasMaterial, setHasMaterial] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const update = useCallback((recipe: (draft: AppState) => void) => setState(current => { const next = structuredClone(current); recipe(next); return next; }), []);
  const notify = useCallback((message: string) => setToast(message), []);
  const reset = () => { setState(specimenState()); setFlow('idle'); setName('雨停之前'); setHasMaterial(false); setContextKey(null); setEpoch(value => value + 1); setToast('样板已恢复初始状态'); };
  const appHref = window.location.protocol === 'file:' ? './Talewick.html' : './';
  const flowContent = {
    idle: <><RiFileTextLine className="size-7" /><h3 className="text-headline-semibold">从一个想法开始</h3><p>先写下你想讲的故事，再选择自己的参与方式。</p><Button onClick={() => setFlow('writing')} leadingIcon={RiPlayLine}>体验生成状态</Button></>,
    writing: <><AgentThinking label="正在整理故事线索…" tone="primary" shimmer={false} showTimer={false} /><p>这里展示持续工作的反馈，不预估未知的完成时间。</p><div className="spec-actions"><Button variant="secondary" leadingIcon={RiPauseLine} onClick={() => setFlow('paused')}>暂停</Button><Button onClick={() => setFlow('complete')}>模拟完成</Button></div></>,
    paused: <><RiPauseLine className="size-7" /><h3 className="text-headline-semibold">故事先停在这里</h3><p>保留已有想法，继续时从当前步骤接上。</p><Button leadingIcon={RiPlayLine} onClick={() => setFlow('writing')}>继续生成</Button></>,
    error: <Notification status="error" title="这次生成没有完成" description="你的想法仍然保留，可以重新尝试。此处仅模拟失败样式。" dismissible={false} actions={[{label:'重新尝试',onClick:()=>setFlow('writing')}]} />,
    complete: <><RiCheckLine className="size-7" /><h3 className="text-headline-semibold">文稿已经准备好</h3><p>接下来可以阅读、直接编辑，或逐条审阅修改建议。</p><ButtonLink href="#manuscript" leadingIcon={RiBookOpenLine}>查看文稿样板</ButtonLink></>,
  } satisfies Record<FlowState, ReactNode>;
  return <MotionConfig reducedMotion={state.settings.reduceMotion ? 'always' : 'user'}><WorkspaceContext.Provider value={{ state, update, notify, openProject: () => notify('样板中的数据只用于视觉体验'), startNew: reset }}>
    <div className="design-specimen" data-reduce-motion={state.settings.reduceMotion} data-doc-expanded={state.projects[0].docExpanded}>
      <header className="spec-topbar"><a href="#" className="spec-brand" aria-label="Talewick 视觉样板顶部"><Logo /><span className="text-headline-semibold">Talewick</span></a><div className="spec-actions"><Button variant="ghost" leadingIcon={RiRestartLine} onClick={reset}>重置样板</Button><ButtonLink variant="secondary" href={appHref} trailingIcon={RiArrowRightLine}>进入创作</ButtonLink></div></header>
      <main className="spec-main">
        <div className="spec-intro"><div><h1 className="text-canvas-heading">让每一次落笔，<br />都有同一种语感。</h1><p className="text-headline-regular text-text-secondary">Talewick 的视觉样板。把颜色、文字和交互放在一起，<br className="spec-desktop-break" />让下一页也延续这份纸上的秩序。</p></div><div className="spec-intro-note"><span className="text-body-medium">这页可以直接操作</span><p className="text-body-regular">点击便签、输入想法、切换状态，或试着采纳一条修改。</p><span className="text-caption-1-regular text-text-secondary">仅使用临时样例，刷新后复原</span></div></div>
        <nav className="spec-nav" aria-label="视觉样板章节">{[['foundations','颜色与文字'],['notes','灵感便签'],['composer','创作输入'],['states','状态反馈'],['manuscript','文稿审阅'],['dimensions','尺寸与验收']].map(([id,label])=><ButtonLink key={id} variant="ghost" size="small" href={`#${id}`}>{label}</ButtonLink>)}</nav>
        <SpecSection id="foundations" title="颜色有各自的职责" description="纸面承载内容，墨色支撑阅读，彩色只标记不同的灵感。">
          <div className="spec-palette">{colors.map(([label,token,role])=><div className="spec-color" key={token}><div className="spec-swatch" style={{background:`var(${token})`}} /><div><h3 className="text-body-semibold">{label}</h3><p className="text-caption-1-regular text-text-secondary">{role}</p><code className="text-caption-2-regular">{token}</code></div></div>)}</div>
          <div className="spec-type-grid"><div><p className="text-caption-1-medium text-text-secondary">引导标题 · 手写体</p><p className="text-canvas-heading">把零散的灵感，<br />拼成一个完整的故事。</p><p className="text-body-regular text-text-secondary">只出现在创作引导中，常规操作继续使用清晰的无衬线字体。</p></div><div className="spec-prose-paper"><p className="text-caption-1-medium text-text-secondary">文稿正文 · 宋体</p><h3 className="font-story text-title-2-regular">第一章　那封没有寄出的信</h3><p className="spec-prose">傍晚六点，雨把书店门前的台阶洗成了深灰色。林晚回来交接钥匙，门缝里却卡着一只湿透的信封。</p><p className="text-caption-1-regular text-text-secondary">默认 18px，正文大小可在设置中调整。</p></div></div>
        </SpecSection>
        <SpecSection id="notes" title="把灵感放到纸上" description="点击任意便签编辑。保存后显示提示点和“已添加灵感”，颜色仍表示它的类别。">
          <div className="spec-note-grid">{inspirationNodes.map(node=><InspirationNote key={node.id} node={node} saved={Boolean(state.context[node.id])} onClick={()=>{setContextKey(node.id);setContextDraft(state.context[node.id]);}} />)}</div>
        </SpecSection>
        <SpecSection id="composer" title="写作从一个安静的输入区开始" description="空内容时发送按钮禁用；点击输入只出现光标，工具和模式选择保留各自的交互。">
          <div className="spec-composer-tools"><Button variant="secondary" size="small" onClick={()=>update(s=>{s.homeIdea='一位退休邮递员，决定替一封没有地址的信找人。';s.quote='';s.quoteSource=undefined;})}>载入一个想法</Button><Button variant="ghost" size="small" onClick={()=>update(s=>{s.homeIdea='';s.quote='';s.quoteSource=undefined;})}>清空输入</Button></div>
          <div className="spec-composer"><Composer key={epoch} isBusy={flow === 'writing'} onSend={()=>{setFlow('writing');notify('已切换到生成中样板，可在下方查看反馈');}} /></div>
          <p className="spec-detail text-caption-1-regular text-text-secondary">⌘ / Ctrl + Enter 也可发送。素材与风格选择复用主界面组件；轻度参与与专业审稿仍标为未接通。</p>
        </SpecSection>
        <SpecSection id="states" title="每一种状态，都有明确的回应" description="切换下方标签查看状态。失败仅为样板模拟；主界面的状态来自本地任务服务。">
          <Tabs selectedKey={flow} onSelectionChange={key=>setFlow(key as FlowState)}><TabList aria-label="创作反馈状态">{flowStates.map(([id,label])=><Tab key={id} id={id}>{label}</Tab>)}</TabList>{flowStates.map(([id])=><TabPanel key={id} id={id}><div className="spec-flow" role="status">{flowContent[id]}</div></TabPanel>)}</Tabs>
          <div className="spec-state-grid"><div className="spec-controls"><h3 className="text-headline-semibold">表单与按钮</h3><Input label="作品名称样板" value={name} onChange={setName} isInvalid={!name.trim()} hint={!name.trim()?'请填写作品名称。':'清空内容可以查看错误提示。'} /><Input label="暂不可编辑" value="生成时保留原有设置" isDisabled /><div className="spec-actions"><Button disabled={!name.trim()} onClick={()=>notify('样例名称已确认')}>确认名称</Button><Button variant="secondary" onClick={()=>setName('雨停之前')}>恢复示例</Button><Button disabled>不可用</Button></div><div className="spec-switch-row"><div><span className="text-body-medium">减少动态效果</span><p className="text-caption-1-regular text-text-secondary">只影响本页样板</p></div><Switch className="spec-switch" aria-label="样板减少动态效果" isSelected={state.settings.reduceMotion} onChange={value=>update(s=>{s.settings.reduceMotion=value;})} /></div></div>
            <div className="spec-empty">{hasMaterial?<div className="spec-material"><RiFileTextLine className="size-7" /><h3 className="text-headline-semibold">旧书店的物件清单</h3><p className="text-body-regular text-text-secondary">蓝色抽屉、借阅簿，以及一台电池盖坏了的录音机。</p><Button variant="secondary" onClick={()=>setHasMaterial(false)}>返回空状态</Button></div>:<EmptyState icon={<RiBookOpenLine className="size-7" />} title="这里还没有素材" description="从一段文字或一份自己的作品开始积累。"><Button variant="secondary" onClick={()=>setHasMaterial(true)}>添加示例素材</Button></EmptyState>}</div>
          </div>
        </SpecSection>
        <SpecSection id="manuscript" title="修改留给作者决定" description="这是主界面使用的真实文稿组件。可切换阅读、编辑与审阅，查看原稿对比、采纳建议或打开版本记录。">
          <div className="spec-actions spec-manuscript-actions"><Button variant="secondary" size="small" leadingIcon={RiRefreshLine} onClick={()=>{setState(specimenState());setEpoch(value=>value+1);notify('已恢复待审阅的示例文稿');}}>恢复审阅样例</Button><p className="text-caption-1-regular text-text-secondary">这里的修改不会写入你的创作项目。</p></div>
          <div className="spec-manuscript-frame">{state.projects[0].docOpen ? <ManuscriptPanel savedLabel="仅保留在本页样板" key={epoch} projectId={state.projects[0].id} onQuote={(quote,source)=>{update(s=>{s.quote=quote;s.quoteSource=source;});notify('引用已放入上方创作输入样板');}} /> : <EmptyState icon={<RiBookOpenLine className="size-7" />} title="文稿样板已收起" description="刚才的修改仍保留在本页。"><Button onClick={()=>update(s=>{s.projects[0].docOpen=true;})}>重新打开文稿样板</Button></EmptyState>}</div>
        </SpecSection>
        <SpecSection id="dimensions" title="下一页也有可以遵循的尺度" description="以下是现有界面的实际尺寸。新页面沿用这些关系，具体场景再按设计规范选择。">
          <div className="spec-table-scroll"><table className="spec-table text-body-regular"><caption className="sr-only">Talewick 尺寸与响应式规范</caption><thead><tr><th>界面元素</th><th>桌面</th><th>窄屏与手机</th></tr></thead><tbody><tr><th>工具导航</th><td>72px 宽，44px 操作按钮</td><td>≤1100px 宽 64px；≤600px 改为底部 64px 高</td></tr><tr><th>首页输入</th><td>最小高 190px，圆角 20px</td><td>手机最小高 170px，圆角 16px</td></tr><tr><th>模式 / 发送</th><td>高 44px / 44px 圆形</td><td>手机均为 40px 高</td></tr><tr><th>灵感便签</th><td>便签画布宽 48%，类别固定四色</td><td>手机两列，每张宽 44%、高 82px</td></tr><tr><th>文稿正文</th><td>默认 18px，可设 16–24px</td><td>≤900px 优先展示文稿，收起后返回对话</td></tr></tbody></table></div>
          <div className="spec-acceptance"><h3 className="text-headline-semibold">每次交付前一起检查</h3><ul className="text-body-regular"><li>主次文字清晰，按钮的禁用、选中与错误状态能够辨认。</li><li>空白输入只显示一个完整白色区域，点击后不新增内外框。</li><li>未出稿时没有空文稿栏；打开文稿后仍能返回对话。</li><li>1440px、当前窗口与 390px 手机宽度下无横向溢出、文字孤行和按钮遮挡。</li><li>键盘能进入控件、切换标签、关闭弹窗，并回到触发位置。</li></ul></div>
        </SpecSection>
        <footer className="spec-footer text-caption-1-regular text-text-secondary"><span>Talewick · Paper Canvas</span><span>设计规范与实际组件配套，样板为临时演示。</span></footer>
      </main>
    </div>
    <DialogShell title={`编辑${inspirationNodes.find(node=>node.id===contextKey)?.title??''}灵感`} description="留下一句已想到的内容即可。" open={contextKey!==null} onClose={()=>setContextKey(null)} footer={<Button leadingIcon={RiCheckLine} onClick={()=>{if(contextKey)update(s=>{s.context[contextKey]=contextDraft;});setContextKey(null);notify('已保存到便签样板');}}>保存灵感</Button>}><TextAreaField label="样板灵感内容" value={contextDraft} onChange={setContextDraft} rows={4} autoFocus /></DialogShell>
    {toast&&<NotificationViewport><Notification status="information" title={toast} key={toast} autoDismissDuration={5500} closeLabel="关闭样板提示" onDismiss={()=>setToast('')} /></NotificationViewport>}
  </WorkspaceContext.Provider></MotionConfig>;
}
