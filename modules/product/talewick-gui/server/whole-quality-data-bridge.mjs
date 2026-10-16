const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateSelection(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !/^[\w-]{1,160}$/.test(id)) || new Set(value).size !== value.length) {
    throw fail('采纳组选择无效。', 400);
  }
  return new Set(value);
}

/** Convert CREATION's already validated finite C06 artifact into the input
 * consumed by FULL15. Partial adoption keeps only materials used by a selected
 * group; it never silently widens the list back to the complete candidate. */
export function full15InputFromWholeQuality({ baseInput, quality, selection, maxChars = 12000 } = {}) {
  if (!record(baseInput?.requirements) || !record(baseInput?.references) || !['standard', 'no_corpus'].includes(baseInput?.profile)) {
    throw fail('关联任务没有可继承的检查要求。');
  }
  const chosen = validateSelection(selection);
  const bundle = quality?.c06References, materialUse = quality?.materialUse;
  if (!record(bundle) || bundle.schemaVersion !== 'whole-quality-c06-reference-bundle-1' || bundle.completeLibraryComparison !== false
    || !Array.isArray(bundle.lists) || !record(materialUse) || !Array.isArray(materialUse.ledgers)) {
    throw fail('关联整稿修订尚未保存有限 C06 参考清单。');
  }
  if (!Number.isSafeInteger(maxChars) || maxChars < 0 || maxChars > 12000) throw fail('C06 参考字符预算无效.', 500);
  const ledgers = new Map(materialUse.ledgers.map(ledger => [ledger?.issueId, ledger]));
  const sources = []; let usedChars = 0;
  for (const list of bundle.lists) {
    if (!record(list) || typeof list.issueId !== 'string' || list.completeLibraryComparison !== false || !Array.isArray(list.references)) throw fail('有限 C06 清单结构无效。');
    const ledger = ledgers.get(list.issueId);
    if (!record(ledger) || !Array.isArray(ledger.decisions)) throw fail('有限 C06 清单缺少用材账本绑定。');
    const decisions = new Map(ledger.decisions.map(decision => [decision?.materialId, decision]));
    for (const reference of list.references) {
      const decision = decisions.get(reference?.materialId);
      if (!record(decision) || decision.decision !== 'used' || !Array.isArray(decision.changeGroupIds)) throw fail('有限 C06 清单与用材账本不一致。');
      if (chosen && !decision.changeGroupIds.some(id => chosen.has(id))) continue;
      if (typeof reference.content !== 'string' || !reference.content.trim() || typeof reference.contentSha256 !== 'string') throw fail('有限 C06 参考片段无效。');
      usedChars += reference.content.length;
      if (usedChars > maxChars) throw fail('实际采纳版本的有限 C06 参考超过 12000 字符，未启动检查。');
      sources.push({ id: `${list.issueId}:${reference.materialId}`, issueId: list.issueId, materialId: reference.materialId,
        title: typeof reference.title === 'string' ? reference.title : reference.materialId, useStatus: 'declared_used', scope: 'fragment',
        content: reference.content, contentSha256: reference.contentSha256, references: structuredClone(reference.references ?? []),
        limitations: structuredClone(reference.limitations ?? []) });
    }
  }
  const references = { schemaVersion: 'full15-whole-quality-c06-references-1',
    coverage: chosen ? 'selected_adoption_declared_used_materials_only' : 'full_candidate_declared_used_materials_only',
    completeLibraryComparison: false, usedChars, maxChars, sources,
    limitations: ['仅核对本清单固定片段；未读取或比较完整资料库。', 'used 是创作阶段采用声明，不等于最终正文作用或文学效果已证实。'] };
  return { requirements: structuredClone(baseInput.requirements), references, profile: sources.length ? 'standard' : 'no_corpus' };
}
