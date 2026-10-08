import { createHash } from 'node:crypto';

export const SOURCE_LINES_MODE = 'source-lines-v1';
const fields = ['title', 'event', 'psychology', 'emotion', 'expression', 'readerEffectHypothesis'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const hash = value => createHash('sha256').update(value).digest('hex');

/** Construct literal evidence from a fixed text version; never infer or widen a scene boundary. */
export function inspectAnalysisCandidate(value, text, textVersion) {
  const diagnostics = [];
  const issue = (code, path, message, range) => {
    if (diagnostics.length < 100) diagnostics.push({ code, path, message,
      ...(Number.isSafeInteger(range?.lineStart) ? { lineStart: range.lineStart } : {}),
      ...(Number.isSafeInteger(range?.lineEnd) ? { lineEnd: range.lineEnd } : {}) });
  };
  if (typeof text !== 'string' || typeof textVersion !== 'string' || !textVersion) {
    issue('TEXT_REQUIRED', '$', '缺少固定版本原文。'); return { analysis: null, diagnostics };
  }
  const lines = text.split(/\r\n|\r|\n/);
  const range = (r, path) => {
    const valid = object(r) && Number.isSafeInteger(r.lineStart) && Number.isSafeInteger(r.lineEnd)
      && r.lineStart >= 1 && r.lineEnd >= r.lineStart && r.lineEnd <= lines.length;
    if (!valid) issue('LINE_RANGE', path, `行号必须在当前原文的 1–${lines.length} 行内，且结束行不早于开始行。`, r);
    return valid;
  };
  if (!object(value)) { issue('ANALYSIS_OBJECT', '$', '拆解结果必须是结构化对象。'); return { analysis: null, diagnostics }; }
  const sourceLines = value.evidenceMode === SOURCE_LINES_MODE;
  if (value.evidenceMode !== undefined && !sourceLines) issue('EVIDENCE_MODE', '$.evidenceMode', '无法识别引用生成方式。');
  if (typeof value.overview !== 'string') issue('OVERVIEW', '$.overview', '分析概览须为字符串，不能为对象、数组或缺省。');
  if (!['full', 'first_four', 'unknown'].includes(value.coverage?.scope) || !strings(value.coverage?.notes)) issue('COVERAGE', '$.coverage', '覆盖范围或范围说明无效。');
  if (!strings(value.limitations)) issue('LIMITATIONS', '$.limitations', '缺少分析限制说明。');
  if (!Array.isArray(value.units) || !value.units.length || value.units.length > 40) {
    issue('UNIT_COUNT', '$.units', '分析须包含 1–40 个单元。'); return { analysis: null, diagnostics };
  }
  const ids = new Set(), units = []; let evidenceCount = 0, evidenceCharacters = 0;
  value.units.forEach((u, i) => {
    const path = `$.units[${i}]`;
    if (!object(u)) { issue('UNIT_OBJECT', path, '分析单元格式无效。'); return; }
    if (typeof u.id !== 'string' || !u.id.trim() || ids.has(u.id)) issue('UNIT_ID', `${path}.id`, '单元标识缺失或重复。');
    ids.add(u.id);
    for (const key of fields) if (typeof u[key] !== 'string') issue('UNIT_FIELD', `${path}.${key}`, '分析字段须为文字。');
    const validLocator = range(u.locator, `${path}.locator`);
    if (!strings(u.relatedUnitIds)) issue('RELATED_UNITS', `${path}.relatedUnitIds`, '关联单元标识无效。');
    const evidence = [];
    if (!Array.isArray(u.evidence) || !u.evidence.length || u.evidence.length > 40) issue('EVIDENCE_COUNT', `${path}.evidence`, '每个单元须有 1–40 处引用。');
    else for (const [j, e] of u.evidence.entries()) {
      const ep = `${path}.evidence[${j}]`;
      if (++evidenceCount > 400) { issue('EVIDENCE_BUDGET', ep, '引用数量超过单篇处理上限。'); break; }
      if (!range(e, ep)) continue;
      if (validLocator && (e.lineStart < u.locator.lineStart || e.lineEnd > u.locator.lineEnd)) issue('EVIDENCE_OUTSIDE_UNIT', ep, `引用超出所属场景 ${u.locator.lineStart}–${u.locator.lineEnd} 行，需核对场景划分。`, e);
      const source = lines.slice(e.lineStart - 1, e.lineEnd).join('\n');
      // Legacy candidate responses still use strict supplied quotes; no silent historical upgrade.
      const quote = sourceLines ? source : e.quote;
      if (typeof quote !== 'string' || !quote.trim()) issue('EMPTY_EVIDENCE', ep, '引用不能是空行或空文字。', e);
      else if (!sourceLines && !source.includes(quote)) issue('QUOTE_MISMATCH', ep, '引用文字与指定行原文不一致。', e);
      else {
        evidenceCharacters += quote.length;
        if (evidenceCharacters > 120000) issue('EVIDENCE_BUDGET', ep, '引用文字总量超过单篇处理上限。');
        else evidence.push({ quote, lineStart: e.lineStart, lineEnd: e.lineEnd });
      }
    }
    units.push({ id: u.id, ...Object.fromEntries(fields.map(key => [key, u[key]])), locator: u.locator,
      evidence, relatedUnitIds: u.relatedUnitIds });
  });
  value.units.forEach((u, i) => {
    if (Array.isArray(u?.relatedUnitIds)) u.relatedUnitIds.forEach((id, j) => {
      if (!ids.has(id)) issue('UNKNOWN_RELATED_UNIT', `$.units[${i}].relatedUnitIds[${j}]`, '引用的关联单元不存在。');
    });
  });
  if (diagnostics.length) return { analysis: null, diagnostics };
  const canonicalValue = sourceLines ? { evidenceMode: SOURCE_LINES_MODE, textVersion, overview: value.overview,
    coverage: value.coverage, units, limitations: value.limitations } : value;
  const analysis = { version: `analysis-${hash(JSON.stringify(canonicalValue))}`, textVersion,
    coverage: structuredClone(value.coverage), reviewStatus: 'candidate', overview: value.overview,
    units: structuredClone(units), limitations: [...value.limitations, '引文字面核对通过；语义复核结果见 validation，文学效果未经验证。'],
    validation: { literalEvidence: 'passed', semanticReview: null,
      ...(sourceLines ? { evidenceMode: SOURCE_LINES_MODE, evidenceOrigin: 'fixed_source_line_ranges' } : {}) } };
  return { analysis, diagnostics };
}
