const roles = Object.freeze({ priorDraft: 'prior_model_output', independentFindings: 'prior_ai_review', priorDraftProvenance: 'background_provenance' });
/** Original user instructions, copied by the program; not model-extracted claims or verified facts. */
export function userRequirementSources(request) {
  return [['/idea', request.idea], ['/instruction', request.instruction], ['/context/instruction', request.context?.instruction]]
    .filter(([,text]) => typeof text === 'string' && text.trim()).map(([path,text]) => ({path,text}));
}
/** Lossless role partition: keeps every background value, without interpreting its text. */
export function requirementsSourceView(input) {
  if (!input.context || typeof input.context !== 'object' || Array.isArray(input.context)) return structuredClone(input);
  const referenceOnlyContext = Object.entries(input.context).filter(([key]) => Object.hasOwn(roles,key))
    .map(([key,value]) => ({path:'/context/'+key,role:roles[key],value:structuredClone(value)}));
  if (!referenceOnlyContext.length) return structuredClone(input);
  const currentRequest=structuredClone(input);
  for (const item of referenceOnlyContext) delete currentRequest.context[item.path.slice('/context/'.length)];
  return {currentRequest,referenceOnlyContext};
}
export const REQUIREMENT_ORIGIN_RULE = 'requirements.userRequirementSources是程序逐字保留的本次用户指令及来源路径，不是模型生成的假设；与模型归类的assumptions冲突时按原指令处理。旧模型方案及AI核对意见仍只是参考，不能替用户增加禁令。';

/** Absent on historical snapshots; do not invent retrospective source authority. */
export const requirementOriginSuffix = requirements => Array.isArray(requirements.userRequirementSources) ? `\n${REQUIREMENT_ORIGIN_RULE}` : '';
