import { RiEarthLine, RiUser3Line, RiFileTextLine, RiSparklingLine } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { useWorkspace } from '@/features/context';
import type { InspirationKey } from '@/model/types';
import type { ReactNode } from 'react';
import { cx } from '@/utils/cx';

export const inspirationNodes = [
  { id: 'world' as const, title: '世界观', help: '故事发生在\n哪里？', icon: RiEarthLine },
  { id: 'character' as const, title: '角色', help: '他们是谁？\n有什么渴望？', icon: RiUser3Line },
  { id: 'plot' as const, title: '情节', help: '会发生什么？', icon: RiFileTextLine },
  { id: 'theme' as const, title: '主题', help: '你想表达什么？', icon: RiSparklingLine },
];

export function Home({ composer, onContext }: { composer: ReactNode; onContext: (key: InspirationKey) => void }) {
  const { state } = useWorkspace();
  return <section className="home-stage" aria-label="创作灵感画布">
    <header className="home-brand"><span className="text-title-3-semibold">Talewick</span></header>
    <div className="home-intro">
      <h1 className="text-canvas-heading">把零散的灵感，<br />拼成一个完整的故事。</h1>
      <p className="text-headline-regular">无论是一个角色、一个设定，<br />还是一句话的灵感，<br />Talewick 都会陪你一步步构思、<span className="home-copy-end">创作和打磨。</span></p>
    </div>
    <div className="inspiration-canvas" aria-label="故事灵感">
      <svg className="note-connections" viewBox="0 0 600 420" preserveAspectRatio="none" aria-hidden="true">
        <path d="M250 80 C130 70 160 190 146 205" /><path d="M270 90 C330 95 318 182 420 198" />
        <path d="M168 242 C214 305 96 372 302 344" /><path d="M472 234 C488 308 433 312 420 344" />
      </svg>
      {inspirationNodes.map(node => <InspirationNote key={node.id} node={node} saved={Boolean(state.context[node.id])} onClick={() => onContext(node.id)} />)}
    </div>
    <p className="home-motto" aria-hidden="true">Ideas.<br />Characters.<br />Plot.<br />A Bigger You.</p>
    <p className="home-footnote text-caption-2-regular" aria-hidden="true">Talewick<br />More Structure.<br />More Freedom.</p>
    <div className="home-composer">{composer}</div>
  </section>;
}

/** Shared by the four home notes and the interactive design specimen. */
export function InspirationNote({ node, saved, onClick }: { node: typeof inspirationNodes[number]; saved: boolean; onClick: () => void }) {
  return <Button variant="ghost" className={cx('inspiration-node', `node-${node.id}`)} onClick={onClick} aria-label={`编辑${node.title}`}>
    <span className="node-content"><node.icon className="node-icon" /><span><span className="block text-headline-semibold">{node.title}</span><span className="node-help text-body-regular">{saved ? '已添加灵感' : node.help}</span></span></span>
    {saved && <span className="node-dot" aria-hidden="true" />}
  </Button>;
}
