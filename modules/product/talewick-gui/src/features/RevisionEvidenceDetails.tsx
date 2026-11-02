type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row).filter((item): item is Row => Boolean(item)) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const bounded = (value?: Row) => value?.semanticAccuracyEstablished === false && value.automaticAdoption === false && value.literaryPass === 'NOT_ASSESSED';
const premiseLabels: Record<string, string> = { identity_relationship: '身份与关系', speaker_actor: '说话者与行动者',
  intent_completion: '意图与完成状态', transfer_direction: '钱物去向', event_round: '事件与交易轮次' };
const sceneLabels: Record<string, string> = { actor_presence: '人物在场', speaker_action: '说话与动作归属', action_chain: '动作衔接',
  object_transfer: '物件转移', payment_round: '付款与交易轮次', question_answer: '问答衔接' };
const assessmentLabels: Record<string, string> = { supported: '模型认为有依据', contradicted: '存在反证', unsupported: '依据不足', uncertain: '仍不确定',
  incomplete: '核对未完成', intact: '模型未报告衔接问题', broken: '发现衔接问题', removed: '模型判断为整场移除', not_applicable: '未涉及（不代表已核实）' };

function statusLabel(value: Row | undefined, kind: 'plan' | 'scene', missing: boolean) {
  if (missing) return '未进行新核对';
  if (!bounded(value) || value?.schemaVersion !== (kind === 'plan' ? 'revision-plan-fact-result-1' : 'revision-independent-scene-result-1')) return '核对记录不完整';
  if (kind === 'plan' ? !Array.isArray(value.assessments) || value.assessments.length === 0 : !Array.isArray(value.groups)) return '核对记录不完整';
  if (value.status === 'blocked') return kind === 'plan' ? '方案事实存在问题' : '场景衔接存在问题';
  if (value.status === 'incomplete') return '仍有未决或未完成项';
  if (value.status === 'no_changes' && kind === 'scene') return '正文未改动，未发起场景复读';
  if (value.status === 'clear' && (kind === 'scene' || value.clearForExecution === true)) return '模型未报告阻断';
  return '核对记录不完整';
}

function Evidence({ value }: { value: unknown }) {
  return <>{rows(value).map((item, index) => <blockquote key={index} className="mt-2 rounded-lg bg-tw-glass p-3 text-body-2-regular">
    <p className="text-caption-1-regular text-text-tertiary">{({ source: '原稿', candidate: '候选', reference: '参考资料' } as Record<string,string>)[text(item.version)] || '来源未核实'} · {text(item.chapterId) || '章节未列出'}</p>
    <p className="mt-1 whitespace-pre-wrap">{text(item.quote) || '未提供逐字引文'}</p>
  </blockquote>)}</>;
}

function PlanChecks({ value }: { value?: Row }) {
  const checks = rows(value?.assessments);
  return <div className="mt-3 space-y-3">{checks.map((check, index) => <section key={text(check.assertionId) || index} className="rounded-xl border border-border-button-default p-3">
    <p className="text-body-2-medium">方案依据 {index + 1} · {({ decomposed: '已拆分事实前提', no_factual_premise: '模型未识别事实前提', proposal_only: '创作提案，非既成事实', unresolved: '前提尚未拆清' } as Record<string,string>)[text(check.coverage)] || '覆盖记录不完整'}</p>
    {text(check.statement) && <blockquote className="mt-2 whitespace-pre-wrap text-body-2-regular">方案原断言：{text(check.statement)}</blockquote>}
    {text(check.reason) && <p className="mt-1 text-body-2-regular text-text-secondary">{text(check.reason)}</p>}
    {rows(check.facts).map((fact, factIndex) => <div key={text(fact.id) || factIndex} className="mt-3">
      <p className="text-body-2-medium">{assessmentLabels[text(fact.status)] || '事实状态未核实'}</p>
      <blockquote className="mt-1 whitespace-pre-wrap text-body-2-regular">{text(fact.claimQuote)}</blockquote>
      <p className="mt-1 text-body-2-regular text-text-secondary">{text(fact.reason)}</p>
      <Evidence value={fact.support}/><Evidence value={fact.counter}/>
    </div>)}
    <details className="mt-3"><summary className="cursor-pointer text-caption-1-medium">五类前提与方案位置</summary>
      <p className="mt-2 break-all text-caption-1-regular text-text-tertiary">{Array.isArray(check.JSONPointers) ? check.JSONPointers.filter(item => typeof item === 'string').join('、') : text(check.JSONPointer) || '未列出方案位置'}</p>
      {Object.entries(premiseLabels).map(([key,label]) => { const item = row(row(check.premiseChecks)?.[key]);
        return <p key={key} className="mt-2 text-caption-1-regular text-text-secondary">{label}：{({ identified: '已识别前提', none: '未识别前提，不代表事实正确', unresolved: '尚未核实' } as Record<string,string>)[text(item?.disposition)] || '记录缺失'}{text(item?.reason) ? `。${text(item?.reason)}` : ''}</p>;
      })}</details>
  </section>)}{!checks.length && <p className="text-body-2-regular text-text-secondary">未提供可展开的逐项事实核对记录，不能据此判断事实正确。</p>}</div>;
}

function SceneChecks({ value }: { value?: Row }) {
  return <div className="mt-3 space-y-3">{rows(value?.groups).map((group, index) => <section key={text(group.groupId) || index} className="rounded-xl border border-border-button-default p-3">
    <p className="text-body-2-medium">修订组 {index + 1} · {assessmentLabels[text(group.assessment)] || '场景状态未核实'}</p>
    <p className="mt-1 text-body-2-regular text-text-secondary">{text(group.reason)}</p>
    {Object.entries(sceneLabels).map(([key,label]) => { const check = row(row(group.checks)?.[key]);
      return <details key={key} className="mt-3"><summary className="cursor-pointer text-body-2-medium">{label} · {assessmentLabels[text(check?.status)] || '记录缺失'}</summary>
        <p className="mt-2 text-body-2-regular text-text-secondary">{text(check?.reason)}</p>
        <Evidence value={check?.sourceEvidence}/><Evidence value={check?.candidateEvidence}/><Evidence value={check?.counterEvidence}/>
      </details>;
    })}
  </section>)}</div>;
}

function PlanFactDetails({ facts, history, missing }: { facts?: Row; history?: Row; missing: boolean }) {
  const correction = row(history?.correction), initial = row(history?.initialCheck);
  return <details className="rounded-2xl border border-border-button-default p-4" aria-label="方案事实核对">
      <summary className="cursor-pointer text-body-medium">方案事实核对 · {statusLabel(facts,'plan',missing)}</summary>
      <p className="mt-3 text-body-2-regular text-text-secondary">核对方案中的事实前提及原文依据。模型判断仍可能出错；未报告阻断不代表事实已证实或文学质量通过。</p>
      <PlanChecks value={facts}/>
      {correction && initial && <details className="mt-4 rounded-xl bg-tw-glass p-3"><summary className="cursor-pointer text-body-2-medium">修正前的初次核对 · {statusLabel(initial,'plan',false)}</summary>
        <p className="mt-2 text-body-2-regular text-text-secondary">这里只记录唯一一次方案修正；原方案与原核对保持在任务历史中。</p><PlanChecks value={initial}/>
      </details>}
    </details>;
}

export function RevisionEvidenceFailureDetails({ value }: { value: unknown }) {
  const failure = row(value);
  if (failure?.schemaVersion !== 'whole-quality-plan-facts-failure-1' || failure.revisionDispatched !== false
    || failure.automaticAdoption !== false || !['blocked','incomplete'].includes(text(failure.status))) return null;
  return <div className="mt-3 space-y-3" aria-label="修订停止后的方案事实核对">
    <p className="text-body-2-regular text-text-secondary">本次修订在正文改写前停止，未生成完成结果。以下只读记录保留原断言与核对问题，不能授权采纳。</p>
    <PlanFactDetails facts={row(failure.planFacts)} history={row(failure.planHistory)} missing={false}/>
  </div>;
}

/** Read-only host result details; no inference from old reread labels or the current draft. */
export function RevisionEvidenceDetails({ value }: { value: unknown }) {
  const supplied = row(value), evidence = supplied?.schemaVersion === 'whole-quality-revision-evidence-1' ? supplied : undefined;
  const facts = row(evidence?.planFacts), scene = row(evidence?.sceneDependencies), history = row(evidence?.planHistory);
  return <>
    <PlanFactDetails facts={facts} history={history} missing={value === undefined}/>
    <details className="rounded-2xl border border-border-button-default p-4" aria-label="场景复读">
      <summary className="cursor-pointer text-body-medium">场景复读 · {statusLabel(scene,'scene',value === undefined)}</summary>
      <p className="mt-3 text-body-2-regular text-text-secondary">独立核对原稿与候选的场景依赖。问题、不确定和未完成项不能授权采纳；整场移除也只是模型判断，可能漏检。</p>
      <SceneChecks value={scene}/>
    </details>
  </>;
}
