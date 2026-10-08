import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const text = (value) => typeof value === 'string' ? value.trim() : '';

/** Preserve selected materials and optionally merge a fixed retrieval packet; never query implicitly. */
export async function prepareKnowledge(request = {}, { retrievalResult } = {}) {
  const selected = (Array.isArray(request.materials) ? request.materials : []).map((item, index) => {
    const content = text(item?.content);
    if (!content) throw new Error(`所选材料 ${index + 1} 没有正文，请补充或取消选择。`);
    return {
      id: text(item.id) || `selected-${index + 1}`,
      title: text(item.title) || `所选材料 ${index + 1}`,
      content,
      kind: 'user_selected',
      sha256: hash(content),
      evidence_status: '用户选中资料；来源与创作增益未由本次流程验证',
    };
  });
  const style = request.style ? {
    name: text(request.style.name),
    description: text(request.style.description),
    rules: structuredClone(request.style.rules ?? []),
    traits: structuredClone(request.style.traits ?? []),
  } : null;
  // Public distribution has no private corpus or derived sample observations.
  const builtin = [];
  const retrieved = [];
  if (retrievalResult !== undefined) {
    if (retrievalResult?.contractVersion !== 'v04-contract-1' || !['matched', 'uncovered', 'unavailable'].includes(retrievalResult.status) || !Array.isArray(retrievalResult.materials)) throw new Error('检索结果合同无效。');
    if (retrievalResult.status !== 'matched' && retrievalResult.materials.length) throw new Error('未命中结果不能携带材料。');
    if (retrievalResult.status === 'matched' && !retrievalResult.materials.length) throw new Error('命中结果必须包含材料。');
    for (const item of retrievalResult.materials) {
      if (!['raw_reference', 'reviewed_analysis'].includes(item?.use)) throw new Error('新检索材料用途无效或缺失。');
      if (item.kind !== 'retrieved' || typeof item.content !== 'string' || !item.content || item.sha256 !== hash(item.content) || !Array.isArray(item.references) || !item.references.length) throw new Error('检索材料正文、哈希或来源链无效。');
      for (const ref of item.references) {
        if (item.use === 'reviewed_analysis' && (!Array.isArray(ref?.unitIds) || !ref.unitIds.length)) throw new Error('已复核分析的来源须包含实际分析单元。');
        if (item.use === 'reviewed_analysis' && !text(ref?.reviewRecordId)) throw new Error('已复核分析的每条来源须有 reviewRecordId。');
        if (!ref.sourceId || !ref.textVersion || !ref.analysisVersion || !ref.sourceSha256 || !Array.isArray(ref.unitIds) || !Number.isInteger(ref.lineStart) || !Number.isInteger(ref.lineEnd) || ref.lineStart < 1 || ref.lineEnd < ref.lineStart) throw new Error('检索来源定位无效。');
      }
      retrieved.push(structuredClone(item));
    }
    if (retrievalResult.usedChars !== retrieved.reduce((n, m) => n + m.content.length, 0)) throw new Error('检索材料计量不一致。');
  }
  const materials = [...selected, ...builtin, ...retrieved];
  if (materials.reduce((sum, item) => sum + item.content.length, 0) > 30_000) {
    throw new Error('本轮选中材料与内置观察合计超过 3 万字符，请减少材料后重试；程序不会静默截断原文。');
  }
  return {
    schemaVersion: 1,
    packetId: `knowledge-${hash(JSON.stringify({ materials, style })).slice(0, 16)}`,
    method: retrievalResult ? 'basic+retrieval' : 'basic',
    ...(retrievalResult ? { retrieval: structuredClone(retrievalResult) } : {}),
    coverage: materials.length ? 'partial' : 'uncovered',
    materials,
    style,
    evidence_status: 'UNPROVEN',
    limits: [
      '覆盖只表示本次收到材料，不表示材料有效或充分。',
      ...(retrievalResult ? ['自动检索结果已固定；适用性与创作增益尚未证明。', ...(retrievalResult.limits ?? [])] : ['未启动全库检索、原文回退、数据拆解、结构簇重建或方法对照实验。']),
      '公开版不附带内部样本或拆解资料；仅使用用户提供或本机检索所得的材料。',
    ],
  };
}
