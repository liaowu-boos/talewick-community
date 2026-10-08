import { useId, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import type { RuntimeResult } from '@/model/types';

export function ReadingObservations({ result }: { result: RuntimeResult }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const review = result.review;
  const observations = review.readingObservations;
  const chapterName = (chapterId: string) => result.chapters.find(c => c.id === chapterId)?.title || `章节 ${chapterId || '未记录'}`;
  return <section className="flex min-w-0 flex-col gap-3 border-t border-separator-border pt-4" aria-label="整体阅读观察">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-body-medium">整体阅读观察</h3><Button size="small" variant="ghost" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? '收起整体阅读观察' : '展开整体阅读观察'}</Button></div>
    <p className="text-body-2-regular text-text-secondary">{review.readingObservationsInvalid ? '观察记录不完整或版本不兼容，暂不能展示；不代表没有问题。' : observations ? `记录 ${observations.length} 项${observations.length ? `，其中 ${observations.filter(o => o.status === 'needs_evidence').length} 项待补证据、${observations.filter(o => o.unresolved).length} 项尚未解决` : ''}。` : '这份结果未保存整体阅读观察记录。'} 查看不会修改正文，观察不构成文学合格结论。</p>
    {open && <div id={id} className="flex min-w-0 flex-col gap-4">
      {review.readerType && <p className="break-words text-body-2-regular text-text-secondary">阅读来源：{review.readerType === 'independent_context_model_call' ? '独立上下文模型调用' : review.readerType}</p>}
      {review.readScope && <p className="whitespace-pre-wrap text-body-2-regular text-text-secondary">阅读范围：{review.readScope}</p>}
      {review.phase && <p className="text-body-2-regular text-text-secondary">审稿阶段：{review.phase === 'after_controller_revision' ? '修订后复读' : review.phase}</p>}
      {review.manuscriptSha256 && <p className="break-all text-caption-1-regular text-text-secondary">审稿对应稿件指纹：{review.manuscriptSha256}</p>}
      {Boolean(review.strengths?.length) && <section className="flex flex-col gap-2" aria-label="模型记录的优点"><h4 className="text-body-medium">模型记录的优点</h4>{review.strengths!.map((value, index) => <p key={index} className="whitespace-pre-wrap text-body-regular">{value}</p>)}</section>}
      {observations?.map((item, index) => <article key={item.id} aria-label={`阅读观察 ${index + 1}`} className="flex min-w-0 flex-col gap-2 rounded-3xl border border-border-button-default p-4">
        <h4 className="text-body-medium">{index + 1}. {item.category || '阅读观察'}</h4>
        <p className="text-body-2-medium">{item.status === 'needs_evidence' ? '待补证据' : '观察提议'} · {item.unresolved ? '尚未解决' : '状态未记录'}</p>
        <p className="text-caption-1-regular text-text-secondary">{item.interpretationStatus === 'model_hypothesis' ? '模型推测' : '解释状态未记录'} · {item.automaticRevisionAuthorized === false ? '不自动授权改稿' : '授权状态未记录'}</p>
        <p className="whitespace-pre-wrap text-body-regular">{item.observation}</p>
        {item.suspectedCause && <p className="whitespace-pre-wrap text-body-regular text-text-secondary">原因推测：{item.suspectedCause}</p>}
        <p className="text-caption-1-regular text-text-secondary">记录的整体引文状态：{item.evidenceVerified ? '全部引文已匹配' : '引文证据未完整核验'} · {item.crossScene ? '跨场景观察' : '非跨场景观察'}</p>
        {item.evidence.map((entry, evidenceIndex) => <div key={evidenceIndex} className="flex flex-col gap-1"><p className="text-body-2-medium">{chapterName(entry.chapterId)}</p><blockquote className="whitespace-pre-wrap text-body-regular text-text-secondary">{entry.quote || '未记录引文'}</blockquote><p className="text-caption-1-regular text-text-secondary">{entry.evidenceVerified ? '记录：引文已匹配本次审阅稿。' : '记录：引文未匹配本次审阅稿，待核实。'}</p></div>)}
        {!item.evidence.length && <p className="text-body-2-regular text-text-secondary">未记录可定位的引文。</p>}
        <p className="text-body-2-medium">建议修订范围：{item.revisionScope.chapterIds.length ? item.revisionScope.chapterIds.map(chapterName).join('、') : '未记录'} · {item.revisionScope.scopeVerified ? '范围已核验' : '范围待核验'}</p>
        {item.revisionScope.action && <p className="whitespace-pre-wrap text-body-regular">建议动作：{item.revisionScope.action}</p>}
        {item.revisionScope.reason && <p className="whitespace-pre-wrap text-body-regular text-text-secondary">范围理由：{item.revisionScope.reason}</p>}
        {item.revisionScope.preserve.map((value, i) => <p key={i} className="whitespace-pre-wrap text-body-2-regular">保留项：{value}</p>)}
        {item.limitations.map((value, i) => <p key={i} className="whitespace-pre-wrap text-body-2-regular text-text-secondary">观察局限：{value}</p>)}
      </article>)}
    </div>}
  </section>;
}
