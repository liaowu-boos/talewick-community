import { createHash } from 'node:crypto';
import { affectedSceneContexts, resolveOpportunityEvidence, SCENE_DEPENDENCY_KINDS } from './goal-opportunity.mjs';

export const PLAN_PROTOCOL_VERSION = 'whole-quality-plan-protocol-feedback-1';
export const PLAN_REPAIR_VERSION = 'whole-quality-plan-format-repair-2';
export const PLAN_HANDLING_VALUES = Object.freeze(['preserve', 'revise', 'remove_with_scene', 'not_applicable']);
export const PLAN_DEPENDENCY_RULES = Object.freeze([
  'not_applicable: sourceEvidence and targetIds must BOTH be empty. An unchanged but evidenced dependency is not the absence of a dependency.',
  'preserve: sourceEvidence has 1–3 exact original citations inside the affected scene/context; any targetIds must belong to the same group. This label does not authorize editing that evidence.',
  'revise: sourceEvidence has 1–3 exact citations; nonempty targetIds belong to the same group and their union must fully cover every cited source span.',
  'remove_with_scene: satisfy revise coverage AND fully cover every declared scene from entryEvidence start through exitEvidence end. Removing one transaction is not deleting the entire scene.',
  'No target may overlap a protected preserve span. Do not delete evidence, widen targets, move protected text or change a literary judgment to satisfy these conditions.',
]);
const clone = structuredClone;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const canonical = x => Array.isArray(x) ? x.map(canonical) : object(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
export const planProtocolHash = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const sha = x => createHash('sha256').update(x).digest('hex');
const ensure = (ok, message, code = 'WHOLE_QUALITY_PLAN_PROTOCOL') => { if (!ok) throw Object.assign(Error(message), { code }); };
const covers = (range, targets) => {
  let end = range.start;
  for (const t of targets.filter(t => t.chapterId === range.chapterId).slice().sort((a,b) => a.start - b.start)) {
    if (t.start > end) break; end = Math.max(end, t.start + t.quote.length); if (end >= range.end) return true;
  }
  return false;
};
const sceneRange = scene => ({ chapterId: scene.chapterId, start: scene.entryEvidence.start, end: scene.exitEvidence.start + scene.exitEvidence.quote.length });
const span = e => ({ chapterId: e.chapterId, start: e.start, end: e.start + e.quote.length });

export function extendPlanProtocolContract(base) {
  const result = clone(base), dependency = result.itemSchema?.properties?.sceneDependencies?.items;
  if (dependency) dependency.conditionalConstraints = [...PLAN_DEPENDENCY_RULES];
  result.planProtocolVersion = PLAN_PROTOCOL_VERSION;
  result.globalConstraints = [...(result.globalConstraints ?? []), ...PLAN_DEPENDENCY_RULES];
  return result;
}

/** Complete scan of the target/protection and scene-dependency constraints,
 * not a substitute for the full plan validator. No quote repair or auto-labels.
 */
export function collectPlanProtocolFeedback({ rawResponse, input, normalizeEvidence, maxLocations = 40, maxChars = 24000 }) {
  ensure(Number.isInteger(maxLocations) && maxLocations >= 0 && maxLocations <= 100 && Number.isInteger(maxChars) && maxChars >= 0 && maxChars <= 48000, '诊断预算无效。');
  let plan; try { plan = JSON.parse(rawResponse); } catch { return { schemaVersion: PLAN_PROTOCOL_VERSION, status: 'not_scanned', reason: 'malformed_json', diagnostics: [], totalCount: null, remainingCount: null }; }
  if (!Array.isArray(plan?.items)) return { schemaVersion: PLAN_PROTOCOL_VERSION, status: 'not_scanned', reason: 'items_not_array', diagnostics: [], totalCount: null, remainingCount: null };
  const all = [], add = (pointer, rule, details = {}) => all.push({ pointer, rule, ...details });
  const checked = (fn, pointer) => { try { return fn(); } catch (error) { add(pointer, 'invalid_shape_or_exact_evidence', { code: error.code ?? 'INVALID', message: String(error.message).slice(0, 500) }); return null; } };
  for (const [ii, rawItem] of plan.items.entries()) {
    const ip = `/items/${ii}`;
    if (!Array.isArray(rawItem?.targets) || !Array.isArray(rawItem?.preserve)) { add(ip, 'invalid_target_or_preservation_array'); continue; }
    const targets = rawItem.targets.map((t, ti) => checked(() => ({ id: t.id, sceneId: t.sceneId,
      ...normalizeEvidence(Object.fromEntries(Object.entries(t).filter(([k]) => !['id','sceneId'].includes(k))), input.chapters) }), `${ip}/targets/${ti}`)).filter(Boolean);
    const protection = rawItem.preserve.map((e, pi) => checked(() => normalizeEvidence(e, input.chapters), `${ip}/preserve/${pi}`)).filter(Boolean);
    for (const [ti, t] of targets.entries()) for (const [pi, p] of protection.entries()) if (t.chapterId === p.chapterId && t.start < p.start + p.quote.length && p.start < t.start + t.quote.length)
      add(`${ip}/targets/${ti}`, 'target_overlaps_protection', { target: span(t), protectedPointer: `${ip}/preserve/${pi}`, protectedSpan: span(p) });
    if (!input.requestSpec?.goalImprovementPolicy) continue;
    const item = { ...rawItem, targets }, ds = item.sceneDependencies;
    if (!Array.isArray(ds)) { add(`${ip}/sceneDependencies`, 'dependencies_not_array'); continue; }
    if (item.decision !== 'revise') { if (ds.length) add(`${ip}/sceneDependencies`, 'preserve_group_requires_empty_dependencies'); continue; }
    if (ds.length !== 5) add(`${ip}/sceneDependencies`, 'exactly_five_ordered_dependencies_required');
    const contexts = checked(() => affectedSceneContexts(input.chapters, input.reading, { items: [item] }), ip);
    for (const [di, d] of ds.entries()) {
      const pointer = `${ip}/sceneDependencies/${di}`;
      if (!object(d) || d.kind !== SCENE_DEPENDENCY_KINDS[di] || !PLAN_HANDLING_VALUES.includes(d.handling)) { add(pointer, 'kind_order_or_handling_invalid'); continue; }
      if (!Array.isArray(d.targetIds) || !Array.isArray(d.sourceEvidence)) { add(pointer, 'invalid_dependency_arrays'); continue; }
      if (!d.targetIds.every(id => targets.some(t => t.id === id))) add(`${pointer}/targetIds`, 'target_ownership');
      if (d.sourceEvidence.length > 3 || (d.handling !== 'not_applicable' && !d.sourceEvidence.length)) add(`${pointer}/sourceEvidence`, 'evidence_count');
      const refs = d.sourceEvidence.map((e, ei) => checked(() => resolveOpportunityEvidence(e, input.chapters), `${pointer}/sourceEvidence/${ei}`)).filter(Boolean);
      const authorized = targets.filter(t => d.targetIds.includes(t.id));
      const details = { kind: d.kind, handling: d.handling, evidenceRanges: refs.map(span), authorizedTargets: authorized.map(t => ({ id: t.id, ...span(t) })) };
      if (contexts && refs.some(e => !contexts.some(c => c.chapterId === e.chapterId && e.start >= c.source.start && e.start + e.quote.length <= c.source.end))) add(pointer, 'affected_scene_context_range', details);
      if (d.handling === 'not_applicable' && (d.sourceEvidence.length || d.targetIds.length)) add(pointer, 'not_applicable_requires_empty_evidence_and_targets', details);
      if (['revise','remove_with_scene'].includes(d.handling)) {
        if (!authorized.length || refs.some(e => !covers(span(e), authorized))) add(pointer, 'changed_dependency_requires_full_authorized_coverage', details);
        if (d.handling === 'remove_with_scene') {
          const ranges = checked(() => item.sceneIds.map(id => sceneRange(input.reading.sceneChanges.find(s => s.id === id))), pointer);
          if (ranges && ranges.some(range => !covers(range, authorized))) add(pointer, 'remove_with_scene_requires_full_declared_scenes', { ...details, declaredScenes: ranges });
        }
      }
    }
  }
  const diagnostics = []; let chars = 0;
  for (const row of all) { const size = JSON.stringify(row).length; if (diagnostics.length >= maxLocations || chars + size > maxChars) break; diagnostics.push(row); chars += size; }
  const body = { schemaVersion: PLAN_PROTOCOL_VERSION, status: 'scanned', rawResponseSha256: sha(rawResponse), planInputHash: planProtocolHash(input),
    scope: 'all target/protection and scene-dependency locations; full validator remains authoritative',
    diagnostics, totalCount: all.length, remainingCount: all.length - diagnostics.length, maxLocations, maxChars };
  return { ...body, feedbackSha256: planProtocolHash(body) };
}
