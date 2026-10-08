/** A new-task planning contract. Literal source anchors are not semantic approval. */
import { createHash } from 'node:crypto';
export const MATERIAL_USE_EVIDENCE_POLICY = 'source-use-evidence-1';

const text = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && value === value.trim();
const fail = message => { throw new Error(`材料使用证据无效：${message}`); };

const sourceBlocks = material => {
  if (material.kind === 'user_selected') return { kind: 'user_selected_content', blocks: [material.content] };
  if (material.kind === 'builtin_abstract_observations') return { kind: 'builtin_observation_text', blocks: [material.content] };
  if (material.kind !== 'retrieved' || !['raw_reference', 'reviewed_analysis'].includes(material.use)
    || !Array.isArray(material.references) || !material.references.length) fail('材料来源类型或定位链无效');
  // Match the DATA relevance parser: line counts and headers bind originals from
  // the tail. A header-like line in analysis cannot introduce an evidence block.
  const lines = material.content.split('\n'), blocks = [];
  let end = lines.length;
  for (let index = material.references.length - 1; index >= 0; index--) {
    const ref = material.references[index];
    if (!Number.isSafeInteger(ref?.lineStart) || !Number.isSafeInteger(ref?.lineEnd)
      || ref.lineStart < 1 || ref.lineEnd < ref.lineStart) fail('原文行范围无效');
    const start = end - (ref.lineEnd - ref.lineStart + 1);
    const header = material.use === 'raw_reference' ? '【原文参考；不作为已发布分析】'
      : `原文（${ref.lineStart}–${ref.lineEnd}）：`;
    if (start < 1 || lines[start - 1] !== header) fail('原文块与行范围不匹配');
    blocks.unshift(lines.slice(start, end).join('\n'));
    end = start - 1;
    if (index > 0 && lines[--end] !== '') fail('原文块间隔无效');
  }
  if (material.use === 'raw_reference' && (material.references.length !== 1 || end !== 0))
    fail('原文材料必须只有一个完整定位块');
  return { kind: 'retrieved_original', blocks };
};

export function normalizeMaterialUseEvidence(item, material, chapters) {
  if (!material || !/^[a-f0-9]{64}$/.test(material.sha256)
    || typeof material.content !== 'string' || !material.content.trim() || material.content.length > 30000
    || createHash('sha256').update(material.content).digest('hex') !== material.sha256)
    fail('采用或拒用材料不在本次供应包内，或正文哈希不符');
  if (!Array.isArray(item.limitations) || item.limitations.length < 1 || item.limitations.length > 8
    || item.limitations.some(value => !text(value, 500))) fail('必须写明1–8条具体不可迁移内容或证据限制');
  if (item.decision === 'decline') {
    if (item.target !== undefined) fail('拒用材料不能声明目标章场');
    return { sourceMaterialSha256: material.sha256 };
  }
  if (item.decision !== 'adopt' || !text(item.mechanism, 240)) fail('采用材料须写明可迁移表达机制');
  if (!Array.isArray(item.sourceQuotes) || item.sourceQuotes.length < 1 || item.sourceQuotes.length > 3
    || item.sourceQuotes.some(value => !text(value, 160) || value.length < 6)
    || new Set(item.sourceQuotes).size !== item.sourceQuotes.length) fail('采用材料须给出1–3段互异的来源原文短引');
  const source = sourceBlocks(material);
  if (item.sourceQuotes.some(quote => !source.blocks.some(block => block.includes(quote))))
    fail('来源短引须逐字见于本材料的原文段，不能只引分析标签或别份材料');
  const target = item.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)
    || JSON.stringify(Object.keys(target).sort()) !== JSON.stringify(['chapterNumber','sceneNumber'])
    || !Number.isInteger(target.chapterNumber) || target.chapterNumber < 1 || target.chapterNumber > chapters.length
    || !Number.isInteger(target.sceneNumber) || target.sceneNumber < 1
    || target.sceneNumber > chapters[target.chapterNumber - 1].scenes.length)
    fail('采用材料须定位本计划中真实存在的章号与场景序号');
  return { mechanism: item.mechanism, sourceQuotes: [...item.sourceQuotes], sourceEvidenceKind: source.kind,
    target: { chapterNumber: target.chapterNumber, sceneNumber: target.sceneNumber },
    sourceMaterialSha256: material.sha256 };
}
