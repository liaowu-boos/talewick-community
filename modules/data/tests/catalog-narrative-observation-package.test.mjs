import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCatalogNarrativeObservationRecords,
  locateCatalogEvidence,
  selectCatalogAnalysisUnits,
} from '../runtime/catalog-narrative-observation-package.mjs';
import {NARRATIVE_OBSERVATION_PACKAGE_MANIFEST_VERSIONS} from '../runtime/narrative-observation-batch.mjs';

const sourceText = ['甲打开门。', '乙沉默。', '甲把信放下。', '乙转身离开。', '雨停了。', '灯亮了。'].join('\n');
const fields = index => ({
  id: `u${index + 1}`,
  title: `单元${index + 1}`,
  event: `第${index + 1}个局部事件改变了人物行动。`,
  psychology: `人物对第${index + 1}个事件的认识发生变化。`,
  emotion: `情绪由动作和停顿组织。`,
  expression: `短句突出第${index + 1}个事件。`,
  readerEffectHypothesis: `可能让读者注意第${index + 1}个变化。`,
  locator: {lineStart: index + 1, lineEnd: index + 1},
  evidence: [{quote: sourceText.split('\n')[index], lineStart: index + 1, lineEnd: index + 1}],
  relatedUnitIds: [],
});
const units = Array.from({length: 6}, (_, index) => fields(index));
const row = {
  sourceId: 'source-1',
  title: '测试故事',
  sourceSha256: 'a'.repeat(64),
  textVersion: `text-v2-lf-${'a'.repeat(64)}`,
  completeness: 'unknown',
  analysis: {
    version: 'analysis-v1',
    textVersion: `text-v2-lf-${'a'.repeat(64)}`,
    reviewStatus: 'checked',
    units,
    limitations: ['只据测试文本。'],
    validation: {
      literalEvidence: 'passed',
      semanticReview: {
        approved: true,
        recordId: 'review-1',
        sourceId: 'source-1',
        textVersion: `text-v2-lf-${'a'.repeat(64)}`,
        analysisVersion: 'analysis-v1',
      },
    },
  },
};

test('production installer accepts only the legacy and catalog-analysis package manifest contracts', () => {
  assert.deepEqual([...NARRATIVE_OBSERVATION_PACKAGE_MANIFEST_VERSIONS], [
    'legacy-sidecars-r02-package-manifest-v1',
    'catalog-analysis-observation-package-manifest-v3',
  ]);
  assert.equal(Object.isFrozen(NARRATIVE_OBSERVATION_PACKAGE_MANIFEST_VERSIONS), true);
});

test('selectCatalogAnalysisUnits spans first through last units', () => {
  assert.deepEqual(selectCatalogAnalysisUnits(units).map(unit => unit.id), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
});

test('buildCatalogNarrativeObservationRecords preserves substantive reviewed fields and literal evidence', () => {
  const result = buildCatalogNarrativeObservationRecords(row, sourceText);
  assert.equal(result.selectedObservations.length, 6);
  assert.equal(result.selectedEvidenceCount, 6);
  assert.equal(result.auditedEvidenceCount, 6);
  assert.equal(result.gaps.length, 0);
  assert.match(result.selectedObservations[0].value.psychology, /认识发生变化/);
  assert.match(result.selectedObservations[0].value.emotion, /情绪/);
  assert.match(result.selectedObservations[0].value.readerEffectHypothesis, /可能/);
  assert.equal(result.selectedObservations[0].field, undefined);
  assert.equal(result.selectedObservations[0].evidence[0].cue, '甲打开门。');
  assert.equal(result.selectedObservations[0].evidence[0].verification.status, 'verified');
});

test('position-spread summary keeps unit meaning and never invents narrative-function labels', () => {
  const wideText = Array.from({length: 16}, (_, index) => `第${index + 1}单元原文。`).join('\n');
  const wideUnits = Array.from({length: 16}, (_, index) => ({
    id: `U${index + 1}`,
    title: index === 12 ? '公开护妻与对峙' : `原分析单元${index + 1}`,
    event: index === 12 ? '人物在公开场合护妻，随后发生当面对峙。' : `第${index + 1}单元事件。`,
    psychology: '只据动作与言语推断。',
    emotion: '只据局部文本判断。',
    expression: '保留原分析表达。',
    readerEffectHypothesis: '可能引导读者注意局部变化。',
    locator: {lineStart: index + 1, lineEnd: index + 1},
    evidence: [{quote: `第${index + 1}单元原文。`, lineStart: index + 1, lineEnd: index + 1}],
    relatedUnitIds: [],
  }));
  const wideRow = {...row, analysis: {...row.analysis, units: wideUnits}};
  const result = buildCatalogNarrativeObservationRecords(wideRow, wideText);
  assert.deepEqual(result.selectedObservations.map(item => item.unitId), ['U1', 'U4', 'U7', 'U10', 'U13', 'U16']);
  assert.equal(result.selectedObservations[4].title, '公开护妻与对峙');
  assert.equal(result.selectedObservations[4].value.event, '人物在公开场合护妻，随后发生当面对峙。');
  assert.equal(result.selectedObservations.every(item => item.field === undefined), true);
  assert.match(result.selectedObservations[4].value.applicabilityBoundary, /不推断章节号、叙事功能/);
});

test('locateCatalogEvidence rejects a quote outside its declared line window', () => {
  assert.throws(() => locateCatalogEvidence(sourceText, {quote: '灯亮了。', lineStart: 1, lineEnd: 1}, row.textVersion, 'intro_contract', 'E001'),
    error => error.code === 'CATALOG_EVIDENCE_MISMATCH');
});
