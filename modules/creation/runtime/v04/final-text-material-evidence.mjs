import { createHash } from 'node:crypto';

export const FINAL_TEXT_MATERIAL_EVIDENCE_VERSION = 'final-text-material-evidence-1';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const manuscriptSha256 = chapters => createHash('sha256').update(JSON.stringify(chapters.map(({ id, title, body }) => ({ id, title, body })))).digest('hex');
const ensure = (condition, message) => { if (!condition) throw new Error(`最终正文用材证据无效：${message}`); };

function validateChapters(chapters) {
  ensure(Array.isArray(chapters) && chapters.length > 0, '正文为空');
  const ids = new Set();
  return chapters.map(chapter => {
    ensure(object(chapter) && typeof chapter.id === 'string' && chapter.id && typeof chapter.title === 'string'
      && typeof chapter.body === 'string' && chapter.body && !ids.has(chapter.id), '章节字段无效或重复');
    ids.add(chapter.id); return structuredClone(chapter);
  });
}

function validateBinding(binding) {
  ensure(object(binding) && typeof binding.sourceId === 'string' && binding.sourceId
    && /^[a-f0-9]{64}$/.test(binding.sourceSha256) && typeof binding.textVersion === 'string' && binding.textVersion,
  'DATA来源绑定缺少sourceId、sourceSha256或textVersion');
  return structuredClone(binding);
}

/**
 * Bind DATA source identities and exact final-text locations to CREATION's
 * author declaration. Literal presence is deliberately not a literary-effect verdict.
 */
export function buildFinalTextMaterialEvidence({ chapters, materialDecisions, claims } = {}) {
  const manuscript = validateChapters(chapters);
  ensure(Array.isArray(materialDecisions) && Array.isArray(claims), '材料决定或核验声明不是数组');
  const adopted = materialDecisions.filter(item => item?.decision === 'adopt');
  const adoptedById = new Map(adopted.map(item => [item.materialId, item]));
  ensure(adoptedById.size === adopted.length && adopted.every(item => typeof item.materialId === 'string' && item.materialId
    && /^[a-f0-9]{64}$/.test(item.sourceMaterialSha256) && typeof item.mechanism === 'string' && item.mechanism
    && object(item.target)), '采用声明缺少唯一材料身份、来源哈希、机制或计划目标');
  ensure(claims.length === adopted.length, '每份采用材料须有且只有一条最终正文核验记录；拒用材料不得声明正文落实');
  const seen = new Set();
  const items = claims.map(claim => {
    ensure(object(claim) && typeof claim.materialId === 'string' && !seen.has(claim.materialId), '核验材料身份缺失或重复');
    seen.add(claim.materialId);
    const decision = adoptedById.get(claim.materialId);
    ensure(decision && claim.sourceMaterialSha256 === decision.sourceMaterialSha256, '核验记录与采用声明的材料或来源哈希不一致');
    ensure(Array.isArray(claim.sourceBindings) && claim.sourceBindings.length > 0, '缺少DATA来源绑定');
    ensure(Array.isArray(claim.manuscriptEvidence) && claim.manuscriptEvidence.length > 0, '缺少最终正文逐字证据');
    ensure(Array.isArray(claim.limitations) && claim.limitations.length > 0
      && claim.limitations.every(item => typeof item === 'string' && item.trim()), '须保留核验限制');
    const evidence = claim.manuscriptEvidence.map(entry => {
      ensure(object(entry) && typeof entry.chapterId === 'string' && Number.isSafeInteger(entry.start) && entry.start >= 0
        && typeof entry.quote === 'string' && entry.quote && typeof entry.purpose === 'string' && entry.purpose.trim(),
      '最终正文引文字段无效');
      const chapter = manuscript.find(item => item.id === entry.chapterId);
      ensure(chapter?.body.slice(entry.start, entry.start + entry.quote.length) === entry.quote, '最终正文引文或UTF-16位置不符');
      return { chapterId: entry.chapterId, start: entry.start, quote: entry.quote, purpose: entry.purpose,
        bodySha256: sha256(chapter.body) };
    });
    return {
      materialId: claim.materialId,
      sourceMaterialSha256: claim.sourceMaterialSha256,
      sourceBindings: claim.sourceBindings.map(validateBinding),
      authorDeclaration: { mechanism: decision.mechanism, plannedTarget: structuredClone(decision.target),
        status: decision.status ?? 'author_declared_not_text_verified' },
      manuscriptEvidence: evidence,
      verificationStatus: 'literal_text_located_not_literary_effect_verified',
      limitations: [...claim.limitations],
    };
  });
  const body = { schemaVersion: FINAL_TEXT_MATERIAL_EVIDENCE_VERSION,
    manuscriptSha256: manuscriptSha256(manuscript), items,
    boundary: '程序只核对DATA来源身份、作者采用声明及最终正文逐字位置；不证明材料机制确实产生预期文学作用，也不是独立目标核查。' };
  return { ...body, evidenceBundleSha256: sha256(body) };
}
