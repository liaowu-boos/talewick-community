const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v))
  && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());
const text = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n && v === v.trim();
const ensure = (ok, message) => { if (!ok) throw new Error(`referenceIntent 无效：${message}`); };
const list = (v, min) => Array.isArray(v) && v.length >= min && v.length <= 3
  && v.every(s => text(s, 240)) && new Set(v).size === v.length;
const basisValue = (request, pointer) => ({ '/idea': request?.idea, '/instruction': request?.instruction,
  '/context/instruction': request?.context?.instruction })[pointer];

/** List only real nonempty user requirement paths; never infer aliases from old drafts. */
export function availableReferenceBasis(request) {
  return ['/idea', '/instruction', '/context/instruction'].filter(p =>
    typeof basisValue(request, p) === 'string' && basisValue(request, p).trim());
}

/** Ground the model's pointer selection in this request without rewriting its contents. */
export function referenceBasisContract(request) {
  return `本次 referenceIntent.basis 可用路径只有：${JSON.stringify(availableReferenceBasis(request))}。逐字选择其中的路径；/instruction 与 /context/instruction 不互为别名，不得自行补出不存在的路径。路径存在只证明可引用，不证明该原文支持提炼结论。`;
}

/** Validate a single reference need, not whether its claimed semantics are correct. */
export function validateReferenceIntent(value, { question, request } = {}) {
  ensure(exact(value, ['purpose', 'evidenceNeeds', 'contextNeeds', 'basis']), '只允许 purpose/evidenceNeeds/contextNeeds/basis');
  ensure(text(question, 240), '须同时提供合法 referenceQuestion');
  ensure(['facts', 'expression', 'performance'].includes(value.purpose), '每次仅一个用途，不接受 mixed');
  ensure(list(value.evidenceNeeds, 1), 'evidenceNeeds 须为1–3个已trim非空、不重复且≤240字符的证据要求');
  ensure(list(value.contextNeeds, 0), 'contextNeeds 须为0–3个已trim非空、不重复且≤240字符的上下文要求');
  ensure(Array.isArray(value.basis) && value.basis.length >= 1 && value.basis.length <= 3
    && new Set(value.basis).size === value.basis.length, 'basis须为1–3个不重复的原需求字段路径');
  const allowed = availableReferenceBasis(request);
  const invalid = value.basis.filter(p => !allowed.includes(p));
  ensure(invalid.length === 0, `basis含不存在、空白或不允许的原需求路径：${JSON.stringify(invalid)}；本次可用：${JSON.stringify(allowed)}。不能引用来源答案或旧草案，也不能将/instruction与/context/instruction互换`);
  return structuredClone(value);
}

/** Map validated intent to the existing free-text context contract without adding a query stage. */
export function referenceNeedView(question, intent) {
  const evidenceRule = intent.purpose === 'expression'
    ? '逐项核对来源自身是否展示所需组织关系；主问题中的当前关系、触发、希望呈现与迁移限制说明本篇难点，不能整组转成来源必须重演的剧情。除所选需要明确要求研究身份或对象本身外，不以题材、职业、物件相同作为准入条件；所需同一主体、明确身份与因果条件仍须由证据及上下文支持。只有情绪词或类似动作不足，不能凭目标故事补齐来源机制。来源触发、心理理解与表达或行动后果只按本问题需要核对，不强制所有材料同一情绪方向或同时满足全部环节。'
    : intent.purpose === 'facts'
      ? '逐项核对所问对象、条件和具体命题的直接证据；类比、文学效果和相同词汇不能替代事实证据。'
      : '只能使用可追溯的独立表现指标及口径；叙事原文不能提供表现数值。';
  return { origin: 'model_proposed_reference_need_not_user_requirement', basis: structuredClone(intent.basis), question, purpose: intent.purpose, evidenceNeeds: structuredClone(intent.evidenceNeeds),
    contextNeeds: structuredClone(intent.contextNeeds), evidenceRule,
    sufficiencyRule: '本轮证据要求为共同必要条件；缺失必要前后文应记不足，不能猜测填补、反转否定或凑数。满足文字结构不证明语义正确。' };
}
