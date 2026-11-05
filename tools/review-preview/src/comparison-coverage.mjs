import assert from 'node:assert/strict';
import { isId, sha256 } from './evidence-store.mjs';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => sha256(Buffer.from(JSON.stringify(value)));
const channels = ['evidence', 'counterEvidence', 'severeHarm.evidence'];

function manuscriptDigest(store, id) {
  const manuscript = JSON.parse(store.get(id, 'manuscript', 'manuscript').bytes);
  assert(Array.isArray(manuscript.chapters), 'Coverage needs manuscript chapters');
  return digest(manuscript.chapters.map(({ id, title, body }) => ({ id, title, body })));
}

// Consume the checker's occurrence rows. A title is never a changed body paragraph.
// The two versions have distinct units. Repeated mentions of one unit count once.
function summarize(rows, units, refs, prefix) {
  assert.equal(rows.length, refs.length, 'Missing or extra coverage occurrence');
  const byPointer = new Map(rows.map(row => [row.pointer, row]));
  let exact = 0, pending = false, sharedBodyOnly = refs.length > 0;
  const changed = new Set(), titles = new Set();
  refs.forEach((ref, index) => {
    const row = byPointer.get(prefix + index);
    assert(row, 'Missing coverage occurrence');
    assert.deepEqual(row.ref, ref, 'Coverage does not match original citation');
    if (row.location !== 'exact') { pending = true; sharedBodyOnly = false; return; }
    exact++;
    assert(Array.isArray(row.unitIds), 'Missing coverage units');
    if (!row.unitIds.length || row.coverage === 'unresolved') pending = true;
    if (row.field !== 'body' || row.coverage !== 'shared_only') sharedBodyOnly = false;
    for (const id of row.unitIds) {
      const unit = units[id];
      assert(unit && unit.unitId === id && unit.side === row.side && unit.field === row.field && unit.chapterId === ref.chapterId, 'Coverage unit mismatch');
      assert(['shared','changed','unresolved'].includes(unit.state), 'Unknown unit state');
      if (unit.state === 'unresolved') pending = true;
      if (unit.state === 'changed') (unit.field === 'body' ? changed : titles).add(id);
      if (unit.state !== 'shared') sharedBodyOnly = false;
    }
  });
  return { exact, total: refs.length, changedParagraphCount: pending || !refs.length ? null : changed.size,
    knownChanged: changed.size, knownChangedTitles:titles.size, sharedOnly: sharedBodyOnly && !pending };
}

export function comparisonViews(store, report) {
  if (report.comparisons === undefined) return [];
  assert(Array.isArray(report.comparisons), 'Comparison list required');
  const ids = new Set(), targets = new Set(), records = new Map(), manuscriptHashes = new Map();
  function record(id) {
    if (!records.has(id)) records.set(id, JSON.parse(store.get(id, report.sourceId, 'evidence').bytes));
    return records.get(id);
  }
  function expectedHash(id) {
    if (!manuscriptHashes.has(id)) manuscriptHashes.set(id, manuscriptDigest(store,id));
    return manuscriptHashes.get(id);
  }
  return report.comparisons.map(opinion => {
    assert(isId(opinion.id) && !ids.has(opinion.id), 'Duplicate or invalid comparison id'); ids.add(opinion.id);
    assert(nonempty(opinion.label) && count(opinion.index), 'Comparison label and original index required');
    const raw = record(opinion.originalId);
    assert(nonempty(raw.preference) && Array.isArray(raw.comparisons) && opinion.index < raw.comparisons.length, 'Original comparison missing');
    const target = `${opinion.originalId}/${opinion.index}`;
    assert(!targets.has(target), 'Duplicate original comparison'); targets.add(target);
    const original = raw.comparisons[opinion.index];
    assert(Array.isArray(original.evidence), 'Original comparison evidence required');
    const exact = opinion.exact ?? null, total = original.evidence.length;
    assert(exact === null || (count(exact) && exact <= total), 'Invalid comparison exact count');
    const view = { id:opinion.id, label:opinion.label, preference:raw.preference,
      exact, total, changedParagraphCount:null, knownChanged:0, knownChangedTitles:0, sharedOnly:false, secondary:[],
      references:[store.ref(opinion.originalId,report.sourceId)] };
    if (opinion.coverageId == null) return view;
    const coverage = record(opinion.coverageId);
    assert.equal(coverage.schemaVersion, 'comparison-citation-coverage-1');
    assert.equal(coverage.binding.baselineSHA256, expectedHash(store.manifest.baselineId), 'Coverage baseline mismatch');
    assert.equal(coverage.binding.candidateSHA256, expectedHash(store.manifest.candidateId), 'Coverage candidate mismatch');
    assert.equal(coverage.binding.comparisonsSHA256,digest(raw.comparisons),'Coverage belongs to other comparisons');
    assert.deepEqual(Object.values(opinion.rolesByBlindId ?? {}).sort(), ['baseline','candidate'], 'Sealed blind roles required');
    assert.deepEqual(coverage.binding.rolesByBlindId, opinion.rolesByBlindId, 'Coverage blind role mismatch');
    const finding = coverage.comparisons[opinion.index];
    assert(finding && finding.comparisonIndex === opinion.index && finding.comparisonId === (original.id ?? null), 'Coverage comparison mismatch');
    const secondary = [];
    for (const channel of channels) {
      const refs = (channel === 'severeHarm.evidence' ? original.severeHarm?.evidence : original[channel]) ?? [];
      const prefix = `/comparisons/${opinion.index}/${channel.replace('.', '/')}/`;
      const rows = coverage.citations.filter(row => row.channel === channel && row.pointer.startsWith(prefix));
      const summary = summarize(rows,coverage.units,refs,prefix);
      if (channel === 'evidence') {
        if (exact !== null) assert.equal(summary.exact,exact,'Comparison exact count mismatch');
        Object.assign(view,summary);
      } else if (refs.length) secondary.push({channel,...summary});
    }
    return {...view, secondary, references:[...view.references,store.ref(opinion.coverageId,report.sourceId)]};
  });
}
