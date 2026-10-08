import { useId, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import type { RuntimeResult } from '@/model/types';
import { materialView, record, records, texts, text, reasonLabel, slotLabel, slotOutcome, consumerLabel, snapshotLabel, relevanceReviewText, initialRetrievalText } from '@/model/material-results';
function MaterialList({ materials }: { materials: Record<string, unknown>[] }) {
  return <div className="flex flex-col gap-3">{materials.map((material, i) => <div key={i} className="flex flex-col gap-1">
    <p className="text-body-2-medium">{text(material.title) || '未命名材料'}</p>
    <p className="text-caption-1-regular text-text-secondary">用途：{material.use === 'raw_reference' ? '原文参考，未经分析复核' : material.use === 'reviewed_analysis' ? '已复核分析，仍需判断适用性' : '材料用途未核验'}</p>
    {records(material.references).map((ref, j) => <p key={j} className="text-caption-1-regular text-text-secondary">来源 {text(ref.sourceId) || '未记录'} · 原文版本 {text(ref.textVersion) || '未记录'} · 分析版本 {text(ref.analysisVersion) || '未记录'}{typeof ref.lineStart === 'number' && typeof ref.lineEnd === 'number' ? ` · 第 ${ref.lineStart}–${ref.lineEnd} 行` : ''}</p>)}
    {texts(material.limitations).map((s, j) => <p key={j} className="text-caption-1-regular text-text-secondary">限制：{s}</p>)}
  </div>)}</div>;
}
export function MaterialResults({ result }: { result: RuntimeResult }) {
  const [open, setOpen] = useState(false); const id = useId(); const view = materialView(result);
  const initialRetrieval = record(result.knowledge.retrieval) ? result.knowledge.retrieval : {};
  const snapshots = records(view.ledger?.snapshots); const bindings = records(view.ledger?.consumerBindings);
  const title = (materialId: unknown) => { for (const s of snapshots) { const m = records(s.materials).find(m => m.id === materialId); if (m) return text(m.title) || text(materialId); } return text(materialId) || '未命名材料'; };
  return <section className="flex min-w-0 flex-col gap-3 border-t border-separator-border pt-4" aria-label="材料来源与补查">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-body-medium">材料来源与补查</h3><Button size="small" variant="ghost" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? '收起材料详情' : '展开材料详情'}</Button></div>
    <p className="break-words text-body-2-regular text-text-secondary">{view.materials.length ? `${view.materials.length} 份参考材料：${view.materials.slice(0, 3).map(m => text(m.title) || '未命名材料').join('、')}${view.materials.length > 3 ? '等' : ''}。` : '没有可展示的材料来源。'}{view.summary}</p>
    <p className="text-body-2-regular text-text-secondary">{initialRetrievalText(initialRetrieval)}</p>
    {open && <div id={id} className="flex min-w-0 flex-col gap-4 break-words">
      <p className="text-caption-1-regular text-text-secondary">补入表示进入参考材料包；实际写作输入见下方记录。材料供应、作者采用和正文落实分别核验，此处不证明后两者。</p>
      <section className="flex flex-col gap-2" aria-label="初始材料筛选"><h4 className="text-body-medium">初始材料筛选</h4><p className="text-caption-1-regular text-text-secondary">{relevanceReviewText(initialRetrieval.relevanceReview, initialRetrieval.relevanceReviewInvalid === true)}</p></section>
      {view.slots.map((slot, i) => {
        const delta = record(slot.delta) ? slot.delta : {};
        return <section key={i} className="flex flex-col gap-2"><h4 className="text-body-medium">{slotLabel(slot.slot)} · {slotOutcome(slot)}</h4>
          {text(slot.question) && <p className="text-body-2-regular">问题：{text(slot.question)}</p>}
          {text(slot.focus) && <p className="text-caption-1-regular text-text-secondary">参考目的：{({ scene: '场景展开', ending: '结尾处理', echo: '前后呼应' } as Record<string, string>)[text(slot.focus)] || '未识别'}</p>}
          {reasonLabel(slot.reason) && <p className="text-body-2-regular text-text-secondary">{reasonLabel(slot.reason)}</p>}
          {records(delta.accepted).map((item, j) => <p key={`accepted-${j}`} className="text-body-2-regular">{['prepared', 'supplied'].includes(text(slot.status)) ? '准备的材料' : '记录中的材料'}：{title(item.id)}</p>)}
          {records(delta.superseded).map((item, j) => <p key={`old-${j}`} className="text-caption-1-regular text-text-secondary">{title(item.byId)} 扩展并替代 {title(item.id)}；旧窗口保留在历史版本中。</p>)}
          {records(delta.dropped).map((item, j) => <div key={`drop-${j}`}><p className="text-body-2-regular text-text-secondary">未补入 {title(item.id)}：{reasonLabel(item.reason) || '原因未记录'}</p>{records(item.coverageGaps).map((gap, k) => <p key={k} className="text-caption-1-regular text-text-secondary">未覆盖来源 {text(gap.sourceId) || '未记录'}{typeof gap.lineStart === 'number' && typeof gap.lineEnd === 'number' ? ` 第 ${gap.lineStart}–${gap.lineEnd} 行` : ''}</p>)}</div>)}
          <p className="text-caption-1-regular text-text-secondary">{relevanceReviewText(slot.relevanceReview, slot.relevanceReviewInvalid === true)}</p>
          {texts(slot.limits).map((s, j) => <p key={`limit-${j}`} className="text-caption-1-regular text-text-secondary">未覆盖或限制：{s}</p>)}
        </section>;
      })}
      <section className="flex flex-col gap-3" aria-label="当前参考材料"><h4 className="text-body-medium">当前参考材料</h4><MaterialList materials={view.materials} /></section>
      {view.ledger && <>
        <section className="flex flex-col gap-2" aria-label="实际写作输入"><h4 className="text-body-medium">实际写作输入</h4>
          {!bindings.length && <p className="text-body-2-regular text-text-secondary">未提供输入绑定，不能判断哪些阶段已使用补充材料。</p>}
          {bindings.map((binding, i) => <div key={i}><p className="text-body-2-regular">{consumerLabel(binding.stage)} · {binding.outcome === 'response_returned' ? '调用已返回响应' : '输入已准备，响应未确认'} · {binding.neutralReview === true && binding.snapshotHash === null ? '中立审稿，未读取外部材料' : snapshotLabel(binding.snapshotHash, snapshots)}</p></div>)}
        </section>
        <section className="flex flex-col gap-3" aria-label="材料版本历史"><h4 className="text-body-medium">材料版本历史</h4>{snapshots.map((s, i) => <div key={i} className="flex flex-col gap-2"><p className="text-body-2-medium">{snapshotLabel(s.hash, snapshots)}{s.hash === view.ledger?.activeSnapshotHash ? ' · 当前' : ''}</p><MaterialList materials={records(s.materials)} /></div>)}</section>
        <p className="text-caption-1-regular text-text-secondary">累计保留 {view.retainedChars ?? '未记录'} / 30000 字符；当前材料 {view.activeChars ?? '未记录'} 字符。被替换的旧窗口仍计入累计预算。</p>
      </>}
    </div>}
  </section>;
}
