import type { ReactNode } from 'react';
import { Badge } from '@/components/base/badges/badge';
import { ButtonLink } from '@/components/base/buttons/button';
import { cx } from '@/utils/cx';

type Evidence = {id:string; label:string; url:string; sha256:string};
type State = {status:string; summary:string; references:Evidence[]};
export type ReviewResultView = {
  title:string; versionLabel:string; caseId:string; baselineSHA256:string; candidateSHA256:string;
  citationOverall:string; literaryAccepted:boolean; adopted:false;
  manuscripts:Evidence[];
  sources:{id:string;label:string;process:{status:string;completed:number;total:number|null;summary:string};citations:{status:string;total:number|null;checked:number;exact:number;originalPassed:boolean|null;failures:{code:string;location:string;anchorId?:string}[];summary:string};references:Evidence[]}[];
  conclusion:{factReview:State;literaryQuality:State;adoption:State};
};
type Labels = Record<string, Record<string,string>>;
function Panel({title,children}:{title:string;children:ReactNode}) {
  return <section className={cx('rounded-3xl border border-border-button-default bg-background-primary-default p-4 flex flex-col gap-3')}><h2 className="text-headline-medium">{title}</h2>{children}</section>;
}
function EvidenceLinks({items}:{items:Evidence[]}) {
  return <details><summary className="text-body-medium cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring">查看证据（{items.length}）</summary><ul className="flex flex-col gap-3 p-4">{items.map(r=><li key={r.id} className="flex flex-col gap-1"><ButtonLink href={r.url} download variant="secondary" size="small">{r.label}</ButtonLink><code className="text-caption-1-regular break-all">SHA256 {r.sha256}</code></li>)}</ul></details>;
}
export function ResultEvidencePanel({view,labels}:{view:ReviewResultView;labels:Labels}) {
  return <main className="mx-auto max-w-5xl p-6 flex flex-col gap-4 text-body-regular">
    <header className="flex flex-col gap-3"><p className="text-caption-1-semibold text-text-secondary">Talewick · 只读评阅证据</p><h1 className="text-title-2-medium">{view.title}</h1><p>{view.versionLabel}</p><p>全文质量：{view.conclusion.literaryQuality.status==='pending'?'待判断':view.literaryAccepted?'已明确验收':'未通过整稿验收'} · 实际采纳：未执行</p><p>流程完成、引用定位、事实判断与文学评价分别记录。</p></header>
    <Panel title="稿件版本"><p>以下结果仅适用于这组全文。新候选须重新绑定证据。</p><dl className="flex flex-col gap-2"><dt>基线 SHA256</dt><dd className="text-caption-1-regular break-all">{view.baselineSHA256}</dd><dt>候选 SHA256</dt><dd className="text-caption-1-regular break-all">{view.candidateSHA256}</dd></dl><EvidenceLinks items={view.manuscripts}/></Panel>
    <Panel title="各来源的流程与引用"><p className={cx('text-body-medium',view.citationOverall==='failed'&&'text-text-error-primary')}>引用完整性：{labels.citations[view.citationOverall]}</p><p>某一来源定位成功不会覆盖另一来源失败。定位成功只证明引文位置，不证明观点成立。</p>{view.sources.map(s=><article key={s.id} className="flex flex-col gap-3 p-4 border border-separator-border rounded-xl"><h3 className="text-headline-medium">{s.label}</h3><p><Badge>{labels.process[s.process.status]}</Badge>　{s.process.completed}/{s.process.total??'未登记'} 阶段</p><p>{s.process.summary}</p><p className={cx('text-body-medium',s.citations.status==='failed'&&'text-text-error-primary')}>{labels.citations[s.citations.status]} · 精确 {s.citations.exact} / 共 {s.citations.total??'未知'} · 失败 {s.citations.failures.length}</p><p>{s.citations.summary}</p>{s.citations.failures.length>0&&<ul className="flex flex-col gap-2">{s.citations.failures.map(f=><li key={f.location}><code className="break-all">{f.location}</code> · {f.code}{f.anchorId&&` · ${f.anchorId}`}</li>)}</ul>}<EvidenceLinks items={s.references}/></article>)}</Panel>
    {(['factReview','literaryQuality','adoption'] as const).map((key,index)=><Panel key={key} title={['人工事实核实','文学取舍','采纳建议'][index]}><p className="text-body-medium">{labels[key][view.conclusion[key].status]}</p><p>{view.conclusion[key].summary}</p><EvidenceLinks items={view.conclusion[key].references}/></Panel>)}
    <footer className="text-body-2-regular text-text-secondary">本页没有发起模型请求、修改原评语或执行采纳。</footer>
  </main>;
}
