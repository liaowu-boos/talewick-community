import test from 'node:test';
import assert from 'node:assert/strict';
import { full15InputFromWholeQuality } from './whole-quality-data-bridge.mjs';

const reference = (materialId, content, issueId = 'issue-1') => ({ issueId, materialId, title: materialId, useStatus: 'declared_used', scope: 'fragment', content,
  contentSha256: materialId.padEnd(64, 'a').slice(0, 64), references: [{ sourceId: `source-${materialId}` }], limitations: [] });

test('FULL15 C06 input follows the actually selected adoption groups', () => {
  const quality = { c06References: { schemaVersion: 'whole-quality-c06-reference-bundle-1', completeLibraryComparison: false,
    lists: [{ issueId: 'issue-1', completeLibraryComparison: false, references: [reference('m1', '甲材料'), reference('m2', '乙材料')] }] },
    materialUse: { ledgers: [{ issueId: 'issue-1', decisions: [
      { materialId: 'm1', decision: 'used', changeGroupIds: ['g1'] }, { materialId: 'm2', decision: 'used', changeGroupIds: ['g2'] },
    ] }] } };
  const value = full15InputFromWholeQuality({ baseInput: { requirements: { c05_applicable: false }, references: { sources: [] }, profile: 'no_corpus' }, quality, selection: ['g2'] });
  assert.equal(value.profile, 'standard');
  assert.deepEqual(value.references.sources.map(item => item.materialId), ['m2']);
  assert.equal(value.references.completeLibraryComparison, false);
  assert.equal(value.references.coverage, 'selected_adoption_declared_used_materials_only');
});

test('missing C06 evidence is explicit and an empty selected version stays no-corpus', () => {
  const baseInput = { requirements: { c05_applicable: false }, references: { sources: [] }, profile: 'no_corpus' };
  assert.throws(() => full15InputFromWholeQuality({ baseInput, quality: {} }), /尚未保存有限 C06/);
  const quality = { c06References: { schemaVersion: 'whole-quality-c06-reference-bundle-1', completeLibraryComparison: false,
    lists: [{ issueId: 'issue-1', completeLibraryComparison: false, references: [reference('m1', '甲材料')] }] },
    materialUse: { ledgers: [{ issueId: 'issue-1', decisions: [{ materialId: 'm1', decision: 'used', changeGroupIds: ['g1'] }] }] } };
  const value = full15InputFromWholeQuality({ baseInput, quality, selection: [] });
  assert.equal(value.profile, 'no_corpus'); assert.deepEqual(value.references.sources, []);
});
