import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { adjudicationView, decisionNames, quoteMatchesResult, reviewIssueId, reviewRecord, reviewText, verifyAdjudicationDisplay } from '@/model/review-adjudication';
import type { Chapter, RuntimeResult } from '@/model/types';

function Fold({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className="flex min-w-0 flex-col gap-3">
    <Button size="small" variant="ghost" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? '收起' : '展开'}{title}</Button>
    {open && <div id={id} className="flex min-w-0 flex-col gap-3">{children}</div>}
  </section>;
}

function Evidence({ title, entries, result }: { title: string; entries: unknown[]; result: RuntimeResult }) {
  return <section className="flex flex-col gap-2" aria-label={title}>
    <h5 className="text-body-2-medium">{title}</h5>
    {!entries.length && <p className="text-body-2-regular text-text-secondary">未记录{title}。</p>}
    {entries.map((entry, index) => {
      const item = reviewRecord(entry) ? entry : {};
      const chapterId = reviewText(item.chapterId);
      const chapter = result.chapters.find(chapter => chapter.id === chapterId);
      return <div key={index} className="flex min-w-0 flex-col gap-1">
        <p className="break-words text-body-2-medium">{chapter?.title || '章节未定位'}{chapterId && ` · ${chapterId}`}</p>
        <blockquote className="whitespace-pre-wrap break-words text-body-regular text-text-secondary">{reviewText(item.quote) || reviewText(entry) || '未记录有效引文'}</blockquote>
        {(reviewText(item.actor) || reviewText(item.role)) && <p className="text-caption-1-regular text-text-secondary">{reviewText(item.actor)} · {({ narration: '叙述', dialogue: '对白', reported_speech: '转述', inference: '推断' } as Record<string, string>)[reviewText(item.role)] || reviewText(item.role)}</p>}
        {reviewText(item.relevance) && <p className="whitespace-pre-wrap text-body-2-regular text-text-secondary">作用：{reviewText(item.relevance)}</p>}
        <p className="text-caption-1-regular text-text-secondary">{quoteMatchesResult(entry, result) ? '逐字匹配本次返回稿；引文匹配不等于解释成立。' : '未匹配本次返回稿，待核实。'}</p>
      </div>;
    })}
  </section>;
}

const statusLabels = { missing: '尚无裁定记录', unverified: '版本绑定待核验', invalid: '裁定记录异常', unsupported: '裁定格式暂不支持', stale: '裁定对应另一版稿件或审稿', bound: '裁定已绑定本次返回稿与原审稿' };
const severityLabels: Record<string, string> = { must_fix: '原审稿建议修改', optional: '原审稿可选建议', error: '原审稿报告错误', warning: '原审稿提醒', info: '原审稿说明' };

export function ReviewAdjudication({ result, currentChapters }: { result: RuntimeResult; currentChapters?: Chapter[] }) {
  const view = adjudicationView(result, currentChapters);
  const originalReview = result.reviewOriginal ?? result.review;
  const originalIssues = Array.isArray(originalReview.issues) ? originalReview.issues : [];
  const [verified, setVerified] = useState<{ result: RuntimeResult; status: typeof view.status }>();
  useEffect(() => {
    let active = true;
    void verifyAdjudicationDisplay(result).then(status => { if (active) setVerified({ result, status }); }, () => { if (active) setVerified({ result, status: 'unverified' }); });
    return () => { active = false; };
  }, [result]);
  const status = view.status === 'bound' ? verified?.result === result ? verified.status : 'unverified' : view.status;
  const bound = status === 'bound';
  return <section className="flex min-w-0 flex-col gap-3 border-t border-separator-border pt-4" aria-label="审稿裁定与版本">
    <h3 className="text-body-medium">审稿裁定与版本</h3>
    <p className="text-body-2-medium" role="status">{bound && view.notRequired ? '原审稿没有必修建议，本轮无需裁定' : statusLabels[status]}</p>
    <p className="text-body-2-regular text-text-secondary">{view.currentVersion === 'same' ? '当前已保存正文与本次返回稿一致。' : view.currentVersion === 'changed' ? '当前已保存正文与本次返回稿不同；以下为返回稿的历史记录，不代表当前稿已审阅。' : '未取得当前稿件，以下仅对应本次返回稿。'} 查看不会修改正文或接受修改建议。</p>
    <p className="text-body-2-regular text-text-secondary">{bound ? `记录：确认 ${view.counts.confirm} · 不采纳 ${view.counts.reject} · 待核实 ${view.counts.uncertain}。` : '尚无已核验且适用于本次返回稿的裁定；可展开保留的原始记录。'} 裁定不等同于最终事实或作品质量保证。</p>
    <Fold title="裁定与争议详情">
      {bound && view.value && <p className="text-body-2-regular text-text-secondary">来源标记：{view.value.origin === 'provided_model_adjudication_response' ? '模型响应裁定' : view.value.origin === 'program_no_must_fix' ? '程序判定无需裁定，未调用裁定模型' : '未识别，详见原始记录'}</p>}
      {(result.reviewAdjudicationBinding?.diagnostics ?? []).map((text, i) => <p key={i} className="text-body-2-regular text-text-secondary">{text}</p>)}
      {view.value && <p className="break-all text-caption-1-regular text-text-secondary">裁定稿件 SHA-256：{reviewText(view.value.manuscriptSha256) || '未记录'}<br />原审稿 SHA-256：{reviewText(view.value.sourceReviewSha256) || '未记录'}</p>}
      {bound && view.items.map((item, index) => <article key={index} className="flex min-w-0 flex-col gap-3 rounded-3xl border border-border-button-default p-4" aria-label={`裁定 ${index + 1}`}>
        <h4 className="break-words text-body-medium">{`原审稿第 ${item.issueIndex + 1} 项`} · {item.valid ? `记录：${decisionNames[item.outcome]}` : '记录异常，不能认定裁定结果'}</h4>
        {reviewRecord(item.issue) && <p className="whitespace-pre-wrap text-body-regular">原审稿意见：{reviewText(item.issue.explanation ?? item.issue.message ?? item.issue.description ?? item.issue.summary) || '详见原审稿记录'}</p>}
        <p className="whitespace-pre-wrap text-body-regular">裁定理由：{item.reason || '未记录'}</p>
        <p className="text-caption-1-regular text-text-secondary">{item.scope === 'external_verification_required' ? '需要外部事实核验' : item.scope === 'text_internal' ? '文本内部判断' : '核验范围未记录'} · {item.revisionEligible === true ? '上游记录：可供修订流程选择' : item.revisionEligible === false ? '上游记录：不触发自动修订' : '修订资格未记录'}</p>
        {[['替代解释', item.alternativeExplanation], ['人物知情范围', item.characterKnowledge]].map(([label, assessment]) => reviewRecord(assessment) ? <p key={String(label)} className="whitespace-pre-wrap text-body-2-regular text-text-secondary">{String(label)}：{reviewText(assessment.reason)}</p> : null)}
        <Evidence title="支持证据" entries={item.evidence} result={result} />
        <Evidence title="反证" entries={item.counterEvidence} result={result} />
      </article>)}
      {result.reviewAdjudication !== undefined && <Fold title="裁定原始记录"><pre className="whitespace-pre-wrap break-all text-caption-1-regular text-text-secondary">{JSON.stringify(result.reviewAdjudication, null, 2)}</pre></Fold>}
      {Boolean(result.adjudicationHistory?.length) && <Fold title="历次裁定记录（不含历史正文）"><p className="text-body-2-regular text-text-secondary">此处仅保留裁定及其原审稿，未提供对应的历史正文。历史引文不与本次返回稿匹配，也不据此判为错误引用。</p>{result.adjudicationHistory!.map((entry, index) => <Fold key={index} title={`第 ${index + 1} 次原始记录`}><pre className="whitespace-pre-wrap break-all text-caption-1-regular text-text-secondary">{JSON.stringify(entry, null, 2)}</pre></Fold>)}</Fold>}
    </Fold>
    <Fold title={`原审稿（${originalIssues.length} 项）`}>
      <p className="whitespace-pre-wrap text-body-regular">{reviewText(originalReview.summary)}</p>
      <p className="text-body-2-regular text-text-secondary">以下保留原审稿建议；其中“建议修改”不表示已经裁定确认。</p>
      {originalIssues.map((issue, index) => {
        if (!reviewRecord(issue)) return <p key={index} className="whitespace-pre-wrap text-body-regular">{reviewText(issue) || JSON.stringify(issue)}</p>;
        const chapterId = reviewText(issue.chapterId);
        const severity = reviewText(issue.severity);
        const quote = reviewText(issue.quote);
        const issueId = reviewIssueId(issue);
        const decision = bound ? view.items.find(item => item.valid && item.issueIndex === index) : undefined;
        return <article key={index} className="flex min-w-0 flex-col gap-2 rounded-3xl border border-border-button-default p-4">
          <h4 className="break-words text-body-medium">{[issueId, result.chapters.find(c => c.id === chapterId)?.title || chapterId, severityLabels[severity] || severity].filter(Boolean).join(' · ') || `原审稿意见 ${index + 1}`}</h4>
          <p className="text-caption-1-regular text-text-secondary">{decision ? `裁定记录：${decisionNames[decision.outcome]}` : '此项尚未取得可对应的裁定'}</p>
          <p className="whitespace-pre-wrap text-body-regular">{reviewText(issue.explanation ?? issue.message ?? issue.description ?? issue.summary)}</p>
          {quote && <blockquote className="whitespace-pre-wrap text-body-regular text-text-secondary">原文：{quote}</blockquote>}
          {reviewText(issue.suggestion) && <p className="whitespace-pre-wrap text-body-regular">原修改建议：{reviewText(issue.suggestion)}</p>}
          <Fold title="此项原始记录"><pre className="whitespace-pre-wrap break-all text-caption-1-regular text-text-secondary">{JSON.stringify(issue, null, 2)}</pre></Fold>
        </article>;
      })}
    </Fold>
  </section>;
}
