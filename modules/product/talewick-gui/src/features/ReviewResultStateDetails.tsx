import { Badge } from '@/components/base/badges/badge';
import { Button } from '@/components/base/buttons/button';
import type { IndependentReviewTask } from '@/model/independent-review';
import type { EvidenceAuditTask } from '@/model/review-evidence-audit';
import { independentReviewSnapshotForEvidence, type IndependentReviewSnapshot, type IndependentReviewView, type ReviewEvidenceLocation } from '@/model/independent-review-view';
import { anonymousReviewComparison, eventGroundingState, premiseCoverageState, reviewResultState } from '@/model/review-result-state';

const labels: Record<string, string> = { complete: '阅读流程已完成', incomplete: '仍有未完成部分', not_available: '暂无完整记录',
  bound: '已展示引文可逐字定位', invalid: '存在无效引文或定位失败', not_checked: '未核查', pending: '等待复核记录',
  checked: '结构核对已完成，语义未证实', needs_attention: '存在待复核依据', invalid_binding: '复核与本报告绑定不一致', opinions_available: '保留独立解释意见' };

export function ReviewResultStateDetails({ task, view, audits = [] }: { task: IndependentReviewTask; view: IndependentReviewView | null; audits?: readonly EvidenceAuditTask[] }) {
  const state = reviewResultState(task, view, audits), anonymous = anonymousReviewComparison(task);
  const rows = [['全文阅读完成', state.fullTextReading], ['引文绑定校验', state.citationBinding],
    ['事件时序复核', state.eventSequence], ['文学解释意见', state.literaryInterpretation]];
  return <details className="mt-3 rounded-3xl border border-border-button-default p-3">
    <summary className="cursor-pointer text-body-2-medium">四类结果状态{state.requiresReview ? ' · 需要复核' : ''}</summary>
    <div className="mt-3 flex flex-col gap-3">{rows.map(([label, status]) => <div key={label} className="flex flex-wrap items-center gap-2">
      <span className="text-body-2-medium">{label}</span><Badge color="neutral">{labels[status] || '状态待核实'}</Badge>
    </div>)}</div>
    <p className="mt-3 text-caption-1-regular text-text-secondary">阅读流程完成、引文能定位、事件依据的结构核对和文学解释是不同结果。检查记录不表示小说质量通过，也不授权自动采用。</p>
    {state.requiresReview && <p className="mt-2 text-caption-1-regular text-text-error-primary">引文或事件依据仍需复核；原意见保留，不能据此认定质量通过或自动采用。</p>}
    <p className="mt-2 text-caption-1-regular text-text-secondary">当前展示 {state.citations.displayed} 条引文，其中 {state.citations.bound} 条有唯一冻结原文位置；定位准确不证明评语判断正确。</p>
    {anonymous && <details className="mt-2"><summary className="cursor-pointer text-caption-1-medium">同输入比较的登记信息</summary>
      <p className="mt-2 break-all text-caption-1-regular text-text-secondary">登记 SHA：{task.anonymousComparison!.registrationSHA256}</p>
      <p className="mt-2 break-all text-caption-1-regular text-text-secondary">共同输入 SHA：{task.anonymousComparison!.sharedInputSHA256}</p>
      <p className="mt-2 text-caption-1-regular text-text-secondary">两稿仅以 A/B 展示；写作者身份保存在独立来源记录中，不进入评审输入。本页不推断模型优劣。</p>
    </details>}
  </details>;
}

const object = (v: unknown): Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const records = (v: unknown) => Array.isArray(v) ? v.map(object) : [];
function location(value: Record<string, unknown>): ReviewEvidenceLocation | undefined {
  return typeof value.blindId === 'string' && typeof value.chapterId === 'string' && Number.isSafeInteger(value.start)
    && Number(value.start) >= 0 && typeof value.quote === 'string' && value.quote.length > 0
    ? { blindId: value.blindId, chapterId: value.chapterId, start: Number(value.start), quote: value.quote, label: '复核依据' } : undefined;
}
export function ReviewEventGroundingDetails({ task, view, audit, onOpen }: { task: IndependentReviewTask; view: IndependentReviewView | null; audit: EvidenceAuditTask;
  onOpen?: (snapshot: IndependentReviewSnapshot, evidence: ReviewEvidenceLocation) => void }) {
  const state = eventGroundingState(task, audit);
  if (state === 'not_checked') return null;
  const p = audit.eventGrounding!, coverageState = p ? premiseCoverageState(p) : null, assessments = records(object(audit.report).assessments);
  return <details className="mt-3"><summary className="cursor-pointer text-body-2-medium">事件状态与时序复核 · {labels[state]}</summary>
    <p className="mt-2 text-caption-1-regular text-text-secondary">这里只核对评语中提出的事件、状态与时序依据；不按章节顺序推定时间，也不把计划当已发生。结构一致仍不证明事件解释正确，不是新的盲评票。</p>
    {state !== 'invalid_binding' && coverageState === 'not_requested' && !p.completeEvidenceReview && p.eventGroundingPassed && <p className="mt-2 text-caption-1-regular text-text-secondary">额外覆盖检查仍需复核；已保存的结构记录不表示完整依据审查完成。</p>}
    {state !== 'invalid_binding' && coverageState !== 'not_requested' && <details className="mt-3">
      <summary className="cursor-pointer text-body-2-medium">完整评语的前提覆盖 · {coverageState === 'checked' ? '结构核对已完成，语义未证实' : coverageState === 'missing' ? '覆盖记录缺失，仍需复核' : '存在待复核前提'}</summary>
      <p className="mt-2 text-caption-1-regular text-text-secondary">逐句检查先后、因果、转移与完成前提是否都有对应依据；“不涉及”不表示事实正确，结构齐全也不表示文学通过。</p>
      {p.premiseCoverageGates?.map((gate, index) => <section key={index} className="mt-3 rounded-3xl border border-border-button-default p-3">
        <p className="text-body-2-medium">{gate.needsReview ? '该条原意见仍有前提需要复核' : '该条前提覆盖结构一致；语义未证实'}</p>
        {gate.issues?.length > 0 && <details className="mt-2"><summary className="cursor-pointer text-caption-1-medium">查看覆盖问题与定位</summary>
          {gate.issues.map((issue, i) => <p key={i} className="mt-2 break-words text-caption-1-regular text-text-secondary">{issue.code} · {issue.JSONPointer}</p>)}
        </details>}
      </section>)}
    </details>}
    {state === 'invalid_binding' ? <p className="mt-2 text-caption-1-regular text-text-error-primary">复核未绑定当前报告；已停止展示相关判断与引文跳转。</p> : p.checks.map(check => {
      const assessment = assessments.find(a => a.targetId === check.targetId);
      const quotes = records(assessment?.factChecks).flatMap(f => [...records(f.evidence), ...records(f.counterEvidence)]);
      return <section key={check.targetId} className="mt-3 rounded-3xl border border-border-button-default p-3">
        <p className="text-body-2-medium">{check.gate.needsReview ? '该条评语的事实或时序依据需要复核' : '该条依据记录结构一致；语义仍未证实'}</p>
        {check.gate.issues.length > 0 && <details className="mt-2"><summary className="cursor-pointer text-caption-1-medium">查看复核原因与定位</summary>
          {check.gate.issues.map((issue, index) => <p key={index} className="mt-2 break-words text-caption-1-regular text-text-secondary">{issue.code} · {issue.JSONPointer}</p>)}
        </details>}
        {quotes.map((quote, index) => { const e = location(quote), snapshot = e ? independentReviewSnapshotForEvidence(view?.snapshots ?? [], e) : undefined;
          return <blockquote key={index} className="mt-2 rounded-xl border border-separator-border p-3">
            <p className="text-caption-1-regular text-text-secondary">匿名稿 {typeof quote.blindId === 'string' ? quote.blindId : '未绑定'} · {typeof quote.chapterId === 'string' ? quote.chapterId : '章节未绑定'}</p>
            <p className="mt-2 whitespace-pre-wrap font-story text-body-regular">{typeof quote.quote === 'string' ? quote.quote : '未提供可定位引文'}</p>
            {snapshot && e && onOpen ? <Button className="mt-2" size="xs" variant="ghost" onClick={() => onOpen(snapshot, e)}>在冻结原文中查看</Button>
              : <p className="mt-2 text-caption-1-regular text-text-secondary">{snapshot ? '仅展示冻结依据；此入口未提供跳转。' : '缺少唯一、逐字一致的冻结位置，已禁止跳转。'}</p>}
          </blockquote>;
        })}
      </section>;
    })}
    {state !== 'invalid_binding' && <details className="mt-2"><summary className="cursor-pointer text-caption-1-medium">复核版本与绑定</summary>
      <p className="mt-2 break-all text-caption-1-regular text-text-secondary">{p.policyVersion} · {p.toolVersion}</p>
      <p className="mt-2 break-all text-caption-1-regular text-text-secondary">{p.transportVersion} · {p.transportToolVersion}</p>
      <p className="mt-2 break-all text-caption-1-regular text-text-secondary">{p.bindingHash}</p>
    </details>}
  </details>;
}
