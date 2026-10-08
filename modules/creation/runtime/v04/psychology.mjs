import { MATERIAL_USE_EVIDENCE_POLICY, normalizeMaterialUseEvidence } from './material-use-evidence.mjs';
export const CREATION_POLICY_VERSION = 'v04-creation-1';
const text = value => typeof value === 'string' ? value.trim() : '';
const list = value => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
const required = (value, keys, path, fieldErrors) => {
  const result = Object.fromEntries(keys.map(key => [key, text(value?.[key])]));
  for (const key of keys) if (!result[key]) fieldErrors.push(`${path}.${key}`);
  return result;
};
const assertRequiredFields = fieldErrors => {
  if (fieldErrors.length) throw Object.assign(new Error(`心理／情绪规划必填字段缺失、为空白或不是字符串：${fieldErrors.join('、')}。允许明确记录未知，不允许模板占位。`), {
    code: 'PLANNING_REQUIRED_FIELDS', details: fieldErrors.map(path => ({ path, expected: 'non_empty_string' })),
  });
};

export function normalizePsychology(value, chapters, { materialEvidencePolicyVersion, materialSources = [] } = {}) {
  if (materialEvidencePolicyVersion !== undefined && materialEvidencePolicyVersion !== MATERIAL_USE_EVIDENCE_POLICY)
    throw new Error('未知材料使用证据策略版本。');
  if (!Array.isArray(value.characterArcs) || !value.characterArcs.length || value.characterArcs.length > 12) {
    throw new Error('心理规划需要 1–12 个人物的经历、认知和行动联系。');
  }
  const fieldErrors = [];
  const characterArcs = value.characterArcs.map((item, index) => required(item,
    ['character', 'experience', 'belief', 'desire', 'fear', 'change', 'expression'], `characterArcs[${index}]`, fieldErrors));
  if (!Array.isArray(value.emotionalScenes) || value.emotionalScenes.length !== chapters.length) {
    // Preserve character-field precedence when chapter structure prevents collection.
    assertRequiredFields(fieldErrors);
    throw new Error('心理规划需要逐章说明场景展开和前后情绪联系。');
  }
  const emotionalScenes = value.emotionalScenes.map((item, index) => ({ chapterId: chapters[index].id,
    ...required(item, ['experience', 'cognition', 'action', 'expression', 'development', 'echo'], `emotionalScenes[${index}]`, fieldErrors) }));
  assertRequiredFields(fieldErrors);
  if (!Array.isArray(value.materialDecisions) || value.materialDecisions.length > 100) throw new Error('规划需要有界的 materialDecisions 数组；没有材料时为空。');
  let materialDecisions = value.materialDecisions.map(item => ({
    materialId: text(item.materialId), decision: item.decision,
    reason: text(item.reason), limitations: list(item.limitations), status: 'author_declared_not_text_verified',
  }));
  if (materialDecisions.some(item => !item.materialId || !item.reason || !['adopt', 'decline'].includes(item.decision))
      || new Set(materialDecisions.map(item => item.materialId)).size !== materialDecisions.length) throw new Error('材料采用声明缺少身份、理由或有效决定，或重复记录。');
  if (materialEvidencePolicyVersion === MATERIAL_USE_EVIDENCE_POLICY) {
    const byId = new Map(materialSources.map(material => [material.id, material]));
    const decided = new Set(materialDecisions.map(item => item.materialId));
    if (decided.size !== byId.size || [...byId.keys()].some(id => !decided.has(id)))
      throw new Error('材料使用证据无效：须逐份声明本次供应材料的 adopt 或 decline；可全部拒用。');
    materialDecisions = materialDecisions.map((decision, index) => ({ ...decision,
      ...normalizeMaterialUseEvidence(value.materialDecisions[index], byId.get(decision.materialId), chapters) }));
  }
  return { creationPolicyVersion: CREATION_POLICY_VERSION, characterArcs, emotionalScenes, materialDecisions,
    psychologyLimitations: list(value.psychologyLimitations) };
}

/** Observations remain hypotheses even when quotations exist. They grant no editing permission. */
export function normalizeReadingObservations(value, chapters) {
  if (!Array.isArray(value) || value.length > 24) throw new Error('整体阅读诊断须为至多 24 项的 readingObservations 数组；没有发现可为空。');
  const ids = new Set(chapters.map(chapter => chapter.id));
  return value.map((item, index) => {
    const observation = text(item?.observation);
    if (!observation) throw new Error('整体阅读诊断缺少具体观察。');
    if (!Array.isArray(item.evidence) || item.evidence.length > 12) throw new Error('每项整体观察须提供至多 12 处 evidence；无法定位时可为空。');
    const evidence = item.evidence.map(entry => {
      const chapterId = text(entry.chapterId), quote = text(entry.quote);
      const chapter = chapters.find(chapter => chapter.id === chapterId);
      return { chapterId, quote, evidenceVerified: !!quote && !!chapter?.body.includes(quote) };
    });
    const chapterIds = [...new Set(list(item.revisionScope?.chapterIds))];
    const evidenceVerified = evidence.length > 0 && evidence.every(entry => entry.evidenceVerified);
    const scopeVerified = chapterIds.length > 0 && chapterIds.every(id => ids.has(id)
      && evidence.some(entry => entry.chapterId === id && entry.evidenceVerified));
    return { id: `reading-${index + 1}`, observation, category: text(item.category),
      suspectedCause: text(item.suspectedCause), evidence, evidenceVerified,
      crossScene: new Set(evidence.filter(entry => entry.evidenceVerified).map(entry => entry.chapterId)).size > 1,
      revisionScope: { chapterIds, action: text(item.revisionScope?.action), reason: text(item.revisionScope?.reason),
        preserve: list(item.revisionScope?.preserve), scopeVerified },
      status: evidenceVerified && scopeVerified ? 'proposed' : 'needs_evidence',
      interpretationStatus: 'model_hypothesis', automaticRevisionAuthorized: false,
      unresolved: true, limitations: list(item.limitations) };
  });
}
