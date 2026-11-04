import assert from 'node:assert/strict';
import {binding, isId} from './evidence-store.mjs';
const text = x => typeof x === 'string' && x.trim().length > 0;
const count = x => Number.isSafeInteger(x) && x >= 0;
export const labels = {
  process: {pending:'未导入评阅', running:'流程进行中', complete:'流程完成', failed:'流程失败', partial:'流程未完整完成'},
  citations: {pending:'引用待检查', partial:'引用检查不完整', passed:'已检查引用全部精确', failed:'引用检查未通过'},
  factReview: {pending:'待核实', partial:'部分核实', complete_with_corrections:'已核实，存在事实纠错', complete_no_findings:'已审范围未发现事实错误'},
  literaryQuality: {pending:'文学质量待判断', improved:'局部改善，未判整稿通过', tradeoff:'存在得失，保留文学分歧', not_accepted:'文学质量未通过', accepted:'文学质量已明确验收'},
  adoption: {pending:'未作采纳建议', retain_baseline:'建议保留基线', recommend_candidate:'建议以候选继续编辑，尚未执行'},
};
function refs(store, ids, sourceId, required = false) {
  assert(Array.isArray(ids) && new Set(ids).size === ids.length, 'Distinct evidence ids required');
  if (required) assert(ids.length > 0, 'Saved evidence required');
  return ids.map(id => { store.get(id, sourceId, 'evidence'); return store.ref(id, sourceId); });
}
function reportJSON(store, id, sourceId, kind) {
  const v = JSON.parse(store.get(id, sourceId, kind).bytes);
  binding(v, store.manifest); assert.equal(v.sourceId, sourceId, 'Report source mismatch');
  return v;
}
export function adaptResult(store) {
  const m = store.manifest;
  assert(text(m.title) && text(m.versionLabel), 'Title and explicit version required');
  assert(Array.isArray(m.sources), 'Sources required');
  const seen = new Set();
  const sources = m.sources.map(s => {
    assert(isId(s.id) && !['coordinator', 'manuscript'].includes(s.id) && !seen.has(s.id), 'Duplicate/reserved source'); seen.add(s.id);
    assert(text(s.label));
    if (s.reportId === null) return {id:s.id, label:s.label, process:{status:'pending', completed:0, total:null, summary:'此版本尚未导入该来源评阅。'}, citations:{status:'pending', total:null, checked:0, exact:0, failures:[], originalPassed:null, summary:'尚未导入该来源引用检查。'}, references:[]};
    const r = reportJSON(store, s.reportId, s.id, 'source-report');
    assert.equal(r.schemaVersion, 'review-source-result-1');
    const p = r.process, c = r.citations;
    assert(p && Object.hasOwn(labels.process, p.status) && count(p.completed) && (p.total === null || count(p.total)) && text(p.summary), 'Invalid process');
    if (p.total !== null) assert(p.completed <= p.total);
    if (p.status === 'complete') assert(p.total > 0 && p.completed === p.total, 'Incomplete process cannot be complete');
    assert(c && (c.total === null || count(c.total)) && count(c.checked) && count(c.exact) && Array.isArray(c.failures) && text(c.summary), 'Invalid citations');
    assert(c.originalPassed === true || c.originalPassed === false || c.originalPassed === null, 'Explicit original check state required');
    assert(c.exact + c.failures.length === c.checked, 'Citation counts inconsistent');
    if (c.total !== null) assert(c.checked <= c.total);
    const locations = new Set();
    for (const f of c.failures) { assert(text(f.code) && text(f.location) && !locations.has(f.location), 'Failure needs unique location'); locations.add(f.location); }
    let status = 'pending';
    if (c.failures.length || c.originalPassed === false) status = 'failed';
    else if (c.checked > 0) status = c.total !== null && c.checked === c.total && c.originalPassed === true ? 'passed' : 'partial';
    assert(!(c.originalPassed === true && status !== 'passed'), 'Contradictory citation pass');
    const references = [store.ref(s.reportId, s.id), ...refs(store, r.references, s.id, p.status !== 'pending' || status !== 'pending')];
    return {id:s.id, label:s.label, process:structuredClone(p), citations:{...structuredClone(c), status}, references};
  });
  const conclusion = {};
  if (m.conclusionId === null) {
    for (const key of ['factReview','literaryQuality','adoption']) conclusion[key] = {status:'pending', summary:labels[key].pending, references:[]};
  } else {
    const r = reportJSON(store, m.conclusionId, 'coordinator', 'conclusion');
    assert.equal(r.schemaVersion, 'review-conclusion-result-1');
    assert.equal(r.authority, 'coordinator');
    for (const key of ['factReview','literaryQuality','adoption']) {
      const v = r[key]; assert(v && Object.hasOwn(labels[key],v.status) && text(v.summary), `Invalid ${key}`);
      conclusion[key] = {status:v.status, summary:v.summary, references:[store.ref(m.conclusionId,'coordinator'), ...refs(store,v.references,'coordinator',v.status !== 'pending')]};
    }
  }
  const statuses = sources.map(s => s.citations.status);
  const citationOverall = statuses.includes('failed') ? 'failed' : statuses.length && statuses.every(s => s === 'passed') ? 'passed' : statuses.some(s => s !== 'pending') ? 'partial' : 'pending';
  return {schemaVersion:'review-result-view-1', title:m.title, versionLabel:m.versionLabel, caseId:m.caseId,
    baselineSHA256:m.baselineSHA256, candidateSHA256:m.candidateSHA256, manifestSHA256:store.manifestSHA256,
    sources, conclusion, citationOverall, literaryAccepted:conclusion.literaryQuality.status === 'accepted',
    adopted:false, automaticAdoption:false, providerCalls:0,
    manuscripts:[store.ref(m.baselineId,'manuscript'),store.ref(m.candidateId,'manuscript')]};
}
