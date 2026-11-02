import { FACT_SUPPORT_INSTRUCTION } from './review-evidence-audit-facts.mjs';

export const PREMISE_SUPPORT_POLICY = 'fact-premise-decomposition-and-two-axes-3';
export const PREMISE_RESPONSE_VERSION = 'review-evidence-audit-3';
export const PREMISE_DIMENSIONS = Object.freeze([
  'identity_relationship', 'speaker_actor', 'intent_completion', 'transfer_direction', 'event_round',
]);
const DISPOSITIONS = ['identified', 'not_applicable', 'unresolved'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const ensure = (ok, code, JSONPointer) => {
  if (!ok) throw Object.assign(new Error(`${code} at ${JSONPointer}`), { code, JSONPointer });
};
const exact = (v, keys, code, path) => ensure(object(v) && Object.keys(v).length === keys.length
  && keys.every(k => Object.hasOwn(v, k)), code, path);
const equalSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every(v => b.includes(v));

// A distinct policy, not an edit to v2's frozen instruction or fact schema.
export const PREMISE_SUPPORT_INSTRUCTION = `${FACT_SUPPORT_INSTRUCTION}

【v3先行步骤：逐字段、逐类检查事实前提，不以审美名义整句跳过】
先读每个claimSources字段，把句中的可核实前提与感受/解释分开；然后核对事实，最后才作原有两轴文学解释。字段出现在statement、uncertainty、rationale或explanation，都须同样处理。整句是审美意见，不表示其人物关系、动作主体、钱物流向、意图/完成或前后事件前提也是纯感受。
对每个claimSource恰好一条premiseChecks，用原JSONPointer绑定。dimensions五项全部填写：identity_relationship查身份/关系前提；speaker_actor查是谁说/做了什么；intent_completion查想做、提议、拒绝与已经完成的区别；transfer_direction查物品/款项从谁到谁及返还、净流向、债务推断；event_round查此前是否发生、是否同一事件/轮次、重复/撤回/另一次。必须先补读涉及的前后文，不把只读局部的未知说成不存在。
每项disposition：identified表示已从原字段拆出这一类事实前提，factIds列此字段具有该dimension的全部factChecks；not_applicable表示原字段确实没有这一类前提，factIds为空；unresolved表示尚不能确定是否含有/如何拆出这一类前提，factIds可列已拆出的相关事实，但该字段factCoverage必须unresolved。每项reason一句简短具体理由，避免复述意见或故事。前提已明确、只是正文无法核实其真假，仍用identified，并把factChecks.status标uncertain、写明limits；不得用not_applicable逃避核查。
上文“按适用性”适用于事实的dimensions，不免除这里五项前提检查；无需强造五类事实。pure_interpretation仅当五项检查全为not_applicable且没有任何可核实事实（包括other_explicit_fact）时可用。含事实前提与情感的混合句必须保留其原话事实片段，不把整个句子称为主观而免查。其它明确事实仍用原other_explicit_fact结构；无证据/无法拆分可unresolved，不能编造支持。
通用虚构例子（不是本包故事答案）：
“领航员把借来的罗盘还给学员，让我觉得释然。”前半句包含行动者、物品流向和此前借用关系；后半句是感受。先从前半句逐字取factChecks，再判断感受的依据范围，不能整句pure_interpretation。
“守门人说要落闸，所以闸门已经关闭，场面令人安心。”说话与意图不等于完成；先核对是谁说、实际是否关闸，再解释安心感。若全文只有这句人物表态，完成事实可uncertain，不据此补写事实。
“邮差再次交还包裹，显出迟来的勇气。”核对谁向谁交还、此前是否交还过及是否同一轮事件；勇气是解释，不能使“再次交还”的事实前提免查。同一准确原片段可有多个dimensions，无需重复建立同一片段。
“我读后感到宁静。”若没有嵌入人物、行为、交易或时序前提，可五项简短说明不适用并标pure_interpretation；不强迫负面、事实或改变偏好。
上述例子只说明拆分方法，不是关键词规则，也不预设本文正确答案。宿主只核对逐字段五项齐全、factIds/原片段/anchors绑定与结论自洽，不能替你证明适用性或语义正确。保持短reason和全部原citation覆盖；五项检查可用极短说明，不重复长篇摘要。`;

export function premiseAssessmentContractFields() {
  const obj = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
  const text = { type: 'string', minLength: 1 };
  const check = () => obj({ disposition: { enum: DISPOSITIONS },
    factIds: { type: 'array', uniqueItems: true, items: text }, reason: text });
  return { premiseChecks: { type: 'array', items: obj({ JSONPointer: text,
    dimensions: obj(Object.fromEntries(PREMISE_DIMENSIONS.map(d => [d, check()]))) }) } };
}

// Called after v2 fact validation. This prevents a structural shortcut, not a
// semantic mistake: a model can still wrongly report every premise inapplicable.
export function validatePremiseAssessment({ target, assessment, assessmentIndex }) {
  const root = `/assessments/${assessmentIndex}/premiseChecks`;
  const sources = new Set(target.claimSources.map(s => s.JSONPointer)), seen = new Set();
  ensure(Array.isArray(assessment.premiseChecks) && assessment.premiseChecks.length === sources.size,
    'AUDIT_PREMISE_COVERAGE', root);
  for (const [i, entry] of assessment.premiseChecks.entries()) {
    const path = `${root}/${i}`;
    exact(entry, ['JSONPointer', 'dimensions'], 'AUDIT_PREMISE_FIELDS', path);
    ensure(sources.has(entry.JSONPointer) && !seen.has(entry.JSONPointer), 'AUDIT_PREMISE_SOURCE', path);
    seen.add(entry.JSONPointer);
    exact(entry.dimensions, PREMISE_DIMENSIONS, 'AUDIT_PREMISE_DIMENSIONS', `${path}/dimensions`);
    const coverage = assessment.factCoverage.find(c => c.JSONPointer === entry.JSONPointer);
    let unresolved = false, allAbsent = true;
    for (const dimension of PREMISE_DIMENSIONS) {
      const check = entry.dimensions[dimension], checkPath = `${path}/dimensions/${dimension}`;
      exact(check, ['disposition', 'factIds', 'reason'], 'AUDIT_PREMISE_CHECK_FIELDS', checkPath);
      ensure(DISPOSITIONS.includes(check.disposition) && nonempty(check.reason) && Array.isArray(check.factIds),
        'AUDIT_PREMISE_CHECK', checkPath);
      const expected = assessment.factChecks.filter(f => f.claim.JSONPointer === entry.JSONPointer
        && f.dimensions.includes(dimension)).map(f => f.factId);
      ensure(equalSet(check.factIds, expected), 'AUDIT_PREMISE_FACT_BINDING', checkPath);
      if (check.disposition === 'identified') ensure(check.factIds.length > 0, 'AUDIT_PREMISE_IDENTIFIED_EMPTY', checkPath);
      if (check.disposition === 'not_applicable') ensure(check.factIds.length === 0, 'AUDIT_PREMISE_ABSENT_FACT', checkPath);
      unresolved ||= check.disposition === 'unresolved';
      allAbsent &&= check.disposition === 'not_applicable';
    }
    if (unresolved) ensure(coverage.disposition === 'unresolved', 'AUDIT_PREMISE_UNRESOLVED_COVERAGE', path);
    if (coverage.disposition === 'pure_interpretation') {
      ensure(allAbsent, 'AUDIT_PREMISE_PURE_INTERPRETATION', path);
    }
  }
}
