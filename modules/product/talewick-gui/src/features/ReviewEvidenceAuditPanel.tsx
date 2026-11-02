import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { ReviewEventGroundingDetails, ReviewResultStateDetails } from '@/features/ReviewResultStateDetails';
import { eventGroundingState } from '@/model/review-result-state';
import type { IndependentReviewTask } from '@/model/independent-review';
import type { IndependentReviewSnapshot, IndependentReviewView, ReviewEvidenceLocation } from '@/model/independent-review-view';
import { auditStateLabels, auditSupportLabels, listReviewEvidenceAudits, startReviewEvidenceAudit, type EvidenceAuditSnapshot, type EvidenceAuditTask } from '@/model/review-evidence-audit';

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const rows = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.map(object) : [];
const text = (v: unknown): string => typeof v === 'string' ? v : '';
const kinds: Record<string, string> = { overall_impression: '整体阅读印象', claim: '逐条意见', literary_focus: '阅读维度', comparison: '两稿比较', goal_rationale: '目标判断理由', goal_outcome: '目标结果判断' };
const basis: Record<string, string> = { narrated_action: '正文叙述的行动', character_statement: '人物说法', narrator_inference: '叙述者推断', editorial_interpretation: '评阅者解读' };
const factStatuses: Record<string, string> = { supported: '有依据支持', contradicted: '存在反证', uncertain: '尚不能确定' };
const factDimensions: Record<string, string> = { identity_relationship: '身份与关系', speaker_actor: '说话人与行动者', intent_completion: '意图与实际完成', transfer_direction: '收付方向', event_round: '事件与轮次', other_explicit_fact: '其他明确事实' };
const coverageLabels: Record<string, string> = { fact_checks: '已列出事实子判断', pure_interpretation: '作为解读保留', unresolved: '仍有未能核实的部分' };
const premiseLabels: Record<string, string> = { identified: '已识别此前提', not_applicable: '复核者认为不涉及', unresolved: '尚未确定是否涉及' };
const premiseDimensions = ['identity_relationship', 'speaker_actor', 'intent_completion', 'transfer_direction', 'event_round'];
const batchLabels: Record<string, string> = { validated: '已核对结构', needs_attention: '需要补查', unsealed: '正在处理或尚未封存', not_dispatched: '尚未发起' };
const auditErrorExplanations: Record<string, string> = {
  AUDIT_PREMISE_FACT_BINDING: '评审报告内部的事实关联未通过核对，需要补查；不能据此判断小说好坏。',
  AUDIT_FACT_STATUS: '评审报告内部的事实状态未通过核对，需要补查；不能据此判断小说好坏。',
};

function AuditPremiseDetails({ assessment, target }: { assessment: Record<string, unknown>; target: Record<string, unknown> }) {
  const sources = rows(target.claimSources), facts = rows(assessment.factChecks);
  return <details className="mt-3"><summary className="cursor-pointer text-body-2-medium">五维前提检查</summary>
    <p className="mt-2 text-caption-1-regular text-text-secondary">以下是复核者对原意见所含前提的判断。“不涉及”不表示事实正确，也可能存在遗漏或误判。</p>
    {rows(assessment.premiseChecks).map((item, index) => {
      const source = sources.find(s => s.JSONPointer === item.JSONPointer), dimensions = object(item.dimensions);
      return <div key={index} className="mt-3">
        {text(source?.text) && <blockquote className="whitespace-pre-wrap font-story text-body-2-regular">{text(source?.text)}</blockquote>}
        {premiseDimensions.map(dimension => { const check = object(dimensions[dimension]); return <div key={dimension} className="mt-2">
          <p className="text-body-2-medium">{factDimensions[dimension]} · {premiseLabels[text(check.disposition)] || '尚未核实'}</p>
          <p className="mt-1 text-body-2-regular">{text(check.reason)}</p>
          {Array.isArray(check.factIds) && check.factIds.length > 0 && <p className="mt-1 text-caption-1-regular">关联：{check.factIds.map(id => {
            const factIndex = facts.findIndex(f => f.factId === id); return factIndex < 0 ? '未识别的子判断' : `子判断${factIndex + 1}`;
          }).join('、')}</p>}
        </div>; })}
      </div>;
    })}
  </details>;
}

function AuditCitations({ value }: { value: unknown }) {
  return <>{rows(value).map((e, i) => <blockquote key={i} className="mt-2 rounded-xl border border-border-button-default p-3">
    <p className="text-caption-1-regular text-text-secondary">匿名稿 {text(e.blindId)} · {text(e.chapterId)}{basis[text(e.basis)] ? ` · ${basis[text(e.basis)]}` : ''}</p>
    <p className="mt-1 whitespace-pre-wrap font-story text-body-2-regular">{text(e.quote)}</p>
    {text(e.explanation) && <p className="mt-1 text-caption-1-regular text-text-secondary">{text(e.explanation)}</p>}
  </blockquote>)}</>;
}

function AuditFactDetails({ assessment, target }: { assessment: Record<string, unknown>; target: Record<string, unknown> }) {
  const facts = rows(assessment.factChecks), coverage = rows(assessment.factCoverage), sources = rows(target.claimSources), dependencies = object(assessment.factDependencies);
  const references = (value: unknown) => Array.isArray(value) && value.length
    ? value.map(id => { const index = facts.findIndex(f => f.factId === id); return index < 0 ? '未识别的子判断' : `子判断${index + 1}`; }).join('、') : '未列出依赖的子判断';
  return <details className="mt-3"><summary className="cursor-pointer text-body-2-medium">事实子判断 · {facts.length} 项</summary>
    <p className="mt-2 text-caption-1-regular text-text-secondary">以下是复核者对原意见的分项判断，仍可能有遗漏或误判；不认证事实，不改变原评语或盲评票数。</p>
    {coverage.map((item, index) => { const source = sources.find(s => s.JSONPointer === item.JSONPointer); return <div key={index} className="mt-3">
      {text(source?.text) && <blockquote className="whitespace-pre-wrap font-story text-body-2-regular">{text(source?.text)}</blockquote>}
      <p className="mt-1 text-body-2-medium">{coverageLabels[text(item.disposition)] || '覆盖情况待核实'}</p>
      <p className="mt-1 text-body-2-regular">{text(item.reason)}</p>
      {Array.isArray(item.factIds) && item.factIds.length > 0 && <p className="mt-1 text-caption-1-regular">{references(item.factIds)}</p>}
    </div>; })}
    {facts.map((fact, index) => <section key={text(fact.factId) || index} className="mt-3 rounded-xl border border-separator-border p-3">
      <h6 className="text-body-2-medium">子判断{index + 1} · {factStatuses[text(fact.status)] || '判断待核实'}</h6>
      <p className="mt-2 text-caption-1-regular text-text-secondary">原意见中的片段</p>
      <blockquote className="mt-1 whitespace-pre-wrap font-story text-body-2-regular">{text(object(fact.claim).quote)}</blockquote>
      <p className="mt-1 text-caption-1-regular text-text-secondary">{Array.isArray(fact.dimensions) ? fact.dimensions.map(value => factDimensions[text(value)] || '维度待核实').join(' · ') : ''} · {basis[text(fact.basis)] || '依据类型未确定'}</p>
      <p className="mt-2 text-body-2-regular">{text(fact.reason)}</p>
      {text(fact.supportedScope) && <p className="mt-1 text-caption-1-regular">支持范围：{text(fact.supportedScope)}</p>}
      {text(fact.limits) && <p className="mt-1 text-caption-1-regular">限制：{text(fact.limits)}</p>}
      {rows(fact.evidence).length > 0 && <><p className="mt-2 text-caption-1-medium">支持依据</p><AuditCitations value={fact.evidence}/></>}
      {rows(fact.counterEvidence).length > 0 && <><p className="mt-2 text-caption-1-medium">反向证据</p><AuditCitations value={fact.counterEvidence}/></>}
    </section>)}
    <p className="mt-3 text-caption-1-regular">原引文栏依赖：{references(dependencies.originalCitationSupport)}</p>
    <p className="mt-1 text-caption-1-regular">补读全文栏依赖：{references(dependencies.wholeTextCheck)}</p>
  </details>;
}

export function ReviewEvidenceAuditDetails({ task, reviewTask }: { task: EvidenceAuditTask; reviewTask?: IndependentReviewTask }) {
  const report = object(task.report), coverage = object(report.coverage), targets = rows(task.targets);
  if (task.eventGrounding && (!reviewTask || eventGroundingState(reviewTask, task) === 'invalid_binding')) return null;
  const boundCanonical = reviewTask && task.canonicalAuditComplete === true && ['checked', 'needs_attention'].includes(eventGroundingState(reviewTask, task));
  if ((!boundCanonical && task.status !== 'complete') || report.automaticAdoption !== false || report.literaryPass !== 'NOT_COMPUTED'
    || report.originalReviewUnchanged !== true || coverage.complete !== true) return null;
  return <details className="mt-2"><summary className="cursor-pointer text-body-2-medium">查看语义依据复核 · {Number(coverage.completed)} 项</summary>
    <p className="mt-2 text-caption-1-regular text-text-secondary">分别核对原引文能支持什么、补读全文还有什么依据。复核者也可能误判；这些分类不是盲评票数、质量分或采纳许可，原评语保持原样。</p>
    {report.representationStatus === 'recovered_from_format' && <p className="mt-2 text-caption-1-regular text-text-secondary">已按固定规则恢复字段表示，原响应与校验记录均保留。评语判断未改，这不表示质量提高。</p>}
    {rows(report.assessments).map((row, index) => {
      const target = targets.find(t => t.targetId === row.targetId) ?? {}, original = object(target.original), citation = object(row.originalCitationSupport), whole = object(row.wholeTextCheck);
      const originalText = text(original.statement) || text(original.rationale) || text(original.reason) || text(original.observation) || text(original.summary);
      return <section key={text(row.targetId) || index} className="mt-3 rounded-xl border border-separator-border p-3">
        <h5 className="text-body-2-medium">{kinds[text(target.kind)] || '原评阅意见'}{text(target.readerId) === 'reader-1' ? ' · 读者一' : text(target.readerId) === 'reader-2' ? ' · 读者二' : ''}</h5>
        {originalText && <p className="mt-2 whitespace-pre-wrap text-body-2-regular">原意见：{originalText}</p>}
        {['fact-subclaims-and-two-axes-2', 'fact-premise-decomposition-and-two-axes-3'].includes(task.auditPolicyVersion ?? '') && <AuditFactDetails assessment={row} target={target}/>}
        {task.auditPolicyVersion === 'fact-premise-decomposition-and-two-axes-3' && <AuditPremiseDetails assessment={row} target={target}/>}
        <p className="mt-2 text-body-2-medium">原引文：{auditSupportLabels[text(citation.status)] || '待核实'}</p>
        <p className="mt-1 text-body-2-regular">{text(citation.reason)}</p>
        {text(citation.supportedScope) && <p className="mt-1 text-caption-1-regular">支持范围：{text(citation.supportedScope)}</p>}
        {text(citation.limits) && <p className="mt-1 text-caption-1-regular">限制：{text(citation.limits)}</p>}
        <details className="mt-2"><summary className="cursor-pointer text-caption-1-medium">原来引用的文字</summary><AuditCitations value={target.originalCitations}/>{rows(citation.citationChecks).map((check, i) => <p key={i} className="mt-2 text-caption-1-regular">第{i + 1}条：{auditSupportLabels[text(check.status)] || '待核实'} · {basis[text(check.basis)] || '依据类型待核实'}。{text(check.reason)}</p>)}</details>
        <p className="mt-3 text-body-2-medium">补读全文：{auditSupportLabels[text(whole.status)] || '待核实'}</p>
        <p className="mt-1 text-body-2-regular">{text(whole.reason)}</p>
        {text(whole.supportedScope) && <p className="mt-1 text-caption-1-regular">支持范围：{text(whole.supportedScope)}</p>}
        {text(whole.limits) && <p className="mt-1 text-caption-1-regular">限制：{text(whole.limits)}</p>}
        <AuditCitations value={whole.evidence}/>
        {rows(whole.counterEvidence).length > 0 && <><p className="mt-2 text-caption-1-medium">反向证据</p><AuditCitations value={whole.counterEvidence}/></>}
        {Array.isArray(whole.mechanicalFactsUsed) && whole.mechanicalFactsUsed.includes('identical_manuscripts') && <p className="mt-2 text-caption-1-regular">两稿正文经逐字核对相同；这不表示文学质量更好。</p>}
      </section>;
    })}
  </details>;
}

export function ReviewEvidenceAuditPanel({ reviewTaskId, reviewTask, reviewView = null, onOpenSnapshot }: { reviewTaskId: string; reviewTask?: IndependentReviewTask; reviewView?: IndependentReviewView | null;
  onOpenSnapshot?: (snapshot: IndependentReviewSnapshot, evidence: ReviewEvidenceLocation) => void }) {
  const [snapshot, setSnapshot] = useState<EvidenceAuditSnapshot | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try { setSnapshot(await listReviewEvidenceAudits(reviewTaskId)); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '复核状态暂不可读。'); }
  }, [reviewTaskId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const active = snapshot?.tasks.some(t => ['queued', 'running'].includes(t.status));
  useEffect(() => { if (!active) return; const timer = window.setInterval(() => void refresh(), 2000); return () => window.clearInterval(timer); }, [active, refresh]);
  const run = async () => {
    setBusy(true); setError('');
    try { await startReviewEvidenceAudit(reviewTaskId); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '复核未能开始。'); }
    finally { setBusy(false); }
  };
  return <section className="mt-3 border-t border-separator-border pt-3" aria-label="评阅语义依据复核">
    <div className="flex items-center justify-between gap-2"><h4 className="text-body-2-medium">语义依据复核</h4>{snapshot?.available && snapshot.eligible && snapshot.tasks.length === 0 && <Button size="xs" variant="secondary" disabled={busy} onClick={() => void run()}>复核评语依据</Button>}</div>
    <p className="mt-1 text-caption-1-regular text-text-secondary">独立核对评语与正文的关系，保留原意见；不增加盲评票，不自动采纳。</p>
    {reviewTask && <ReviewResultStateDetails task={reviewTask} view={reviewView} audits={snapshot?.tasks ?? []}/>}
    {snapshot && (!snapshot.available || !snapshot.eligible) && <p className="mt-2 text-caption-1-regular text-text-secondary">{snapshot.available ? '当前评阅尚不满足复核条件。' : '语义依据复核尚未接通。'}</p>}
    {snapshot?.tasks.map(task => <article key={task.id} className="mt-2"><p className="text-body-2-medium">{auditStateLabels[task.status] || '复核状态待核实'}</p><ReviewEvidenceAuditDetails task={task} reviewTask={reviewTask}/>
      {task.progress && task.progress.totalBatches > 0 && <><p className="mt-1 text-caption-1-regular text-text-secondary">逐批复核：已结算 {task.progress.completedBatches}/{task.progress.totalBatches} 批，需补查 {task.progress.failedBatches} 批；结算不表示判断正确。</p><details className="mt-2"><summary className="cursor-pointer text-caption-1-medium">批次情况</summary>{task.batches?.map((batch, index) => <div key={batch.batchId} className="mt-2"><p className="text-caption-1-regular">第{index + 1}批 · {batchLabels[batch.status] || '状态待核实'}</p>{batch.error && <details className="mt-1"><summary className="cursor-pointer text-caption-1-medium">查看停止原因</summary><p className="mt-1 break-words text-caption-1-regular">{batch.error.code} · {batch.error.message}</p></details>}</div>)}</details></>}
      {reviewTask && <ReviewEventGroundingDetails task={reviewTask} view={reviewView} audit={task} onOpen={onOpenSnapshot}/>}
      {task.error && <>{auditErrorExplanations[task.error.code] && <p className="mt-1 text-caption-1-regular text-text-secondary">{auditErrorExplanations[task.error.code]}</p>}<p className="mt-1 text-caption-1-regular text-text-secondary">现场和原评阅均已保留，不自动补发。</p><details className="mt-1"><summary className="cursor-pointer text-caption-1-medium">查看停止原因</summary><p className="mt-2 break-words text-caption-1-regular">错误代码：{task.error.code}</p><p className="mt-2 break-words whitespace-pre-wrap text-caption-1-regular">{task.error.message}</p></details></>}
    </article>)}
    {error && <p className="mt-2 text-caption-1-regular text-text-error-primary" role="alert">{error}</p>}
  </section>;
}
