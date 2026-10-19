#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFile, stat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

async function readReady(path, encoding = undefined) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Not a regular file: ${path}`);
  return readFile(path, encoding);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    if (!values[index]?.startsWith('--') || values[index + 1] === undefined) throw new TypeError('Arguments must be --name value pairs');
    parsed[values[index].slice(2)] = values[index + 1];
  }
  return parsed;
}

function reviewBindingValid(row) {
  const analysis = row.analysis, review = analysis?.validation?.semanticReview;
  return analysis?.reviewStatus === 'checked'
    && analysis?.validation?.literalEvidence === 'passed'
    && review?.approved === true
    && review.sourceId === row.sourceId
    && review.textVersion === row.textVersion
    && review.analysisVersion === analysis.version
    && analysis.textVersion === row.textVersion;
}

function lineStarts(text) {
  const lines = text.split('\n'), starts = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  return {lines, starts};
}

function verifyEvidence(text, evidence) {
  const index = lineStarts(text), start = evidence.lineStart, end = evidence.lineEnd;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > index.lines.length || !nonempty(evidence.quote)) return false;
  return index.lines.slice(start - 1, end).join('\n').includes(evidence.quote);
}

function fieldCoverage(units, field) {
  const populated = units.filter(unit => nonempty(unit[field]));
  const withSharedUnitEvidence = populated.filter(unit => Array.isArray(unit.evidence) && unit.evidence.length > 0);
  const fieldSpecificEvidence = units.flatMap(unit => Array.isArray(unit.evidence) ? unit.evidence : [])
    .filter(evidence => Array.isArray(evidence.supports) && evidence.supports.includes(field));
  return {
    actualField: `analysis.units[].${field}`,
    totalUnits: units.length,
    populatedUnits: populated.length,
    unitsWithSharedUnitEvidence: withSharedUnitEvidence.length,
    fieldSpecificEvidenceRecords: fieldSpecificEvidence.length,
    fieldSpecificEvidenceCoverage: fieldSpecificEvidence.length > 0,
    evidenceMeaning: fieldSpecificEvidence.length > 0
      ? 'evidence explicitly names this field'
      : 'evidence is attached to the analysis unit as a whole; it does not independently prove this field',
  };
}

function markdownEscape(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

const args = parseArgs(process.argv.slice(2));
for (const name of ['library-root', 'source-list', 'package-root', 'json-output', 'md-output']) {
  if (!args[name]) throw new TypeError(`Required: --${name} PATH`);
}
const libraryRoot = resolve(args['library-root']);
const packageRoot = resolve(args['package-root']);
const sourceListPath = resolve(args['source-list']);
const jsonOutput = resolve(args['json-output']);
const mdOutput = resolve(args['md-output']);

const catalogBytes = await readReady(join(libraryRoot, 'catalog.json'));
const sourceListBytes = await readReady(sourceListPath);
const catalog = JSON.parse(catalogBytes), sourceList = JSON.parse(sourceListBytes);
if (!Array.isArray(catalog.sources) || !Array.isArray(sourceList.sources) || sourceList.sources.length !== 99) throw new Error('Audit requires catalog and exactly 99 remaining sources');
const rows = new Map(catalog.sources.map(row => [row.sourceId, row]));
const sources = [];

for (const listed of sourceList.sources) {
  const row = rows.get(listed.sourceId);
  if (!row) throw new Error(`Missing catalog source ${listed.sourceId}`);
  const sourceText = await readReady(join(libraryRoot, 'objects', `${row.sourceSha256}.lf-v2.txt`), 'utf8');
  const selectionPath = join(packageRoot, 'unit-observations', `${row.sourceId}.json`);
  const selectionBytes = await readReady(selectionPath);
  const selection = JSON.parse(selectionBytes);
  const analysis = row.analysis ?? null, units = Array.isArray(analysis?.units) ? analysis.units : [];
  const allEvidence = units.flatMap(unit => Array.isArray(unit.evidence) ? unit.evidence : []);
  const literalVerifiedEvidence = allEvidence.filter(evidence => verifyEvidence(sourceText, evidence)).length;
  const psychology = fieldCoverage(units, 'psychology');
  const emotion = fieldCoverage(units, 'emotion');
  const expression = fieldCoverage(units, 'expression');
  const readerEffect = fieldCoverage(units, 'readerEffectHypothesis');
  const explicitEmotionProgressionUnits = units.filter(unit => nonempty(unit.emotionProgression)).length;
  const explicitAuthorDecisionUnits = units.filter(unit => nonempty(unit.authorDecision)
    || nonempty(unit.authorIntent) || nonempty(unit.creativeDecision)).length;
  const usable = reviewBindingValid(row) && units.length > 0
    && psychology.populatedUnits === units.length && emotion.populatedUnits === units.length
    && allEvidence.length > 0 && literalVerifiedEvidence === allEvidence.length;
  const hasSummary = selection?.selectedUnitCount === 6 && Array.isArray(selection.selectedObservations)
    && selection.selectedObservations.length === 6;
  const classification = usable ? 'existing_analysis_usable' : hasSummary ? 'summary_index_only' : 'missing_analysis';
  const review = analysis?.validation?.semanticReview ?? {};
  const remainingGaps = [
    {code: 'no_new_semantic_analysis_this_round', detail: '本轮只新增检索注册、六单元摘要与既有证据复核；没有生成新的 emotion、psychology 或 author-decision 分析版本。'},
    {code: 'emotion_progression_not_explicit', detail: '存在逐单元 emotion 字段，但没有跨单元 emotionProgression/情绪推进字段；不能仅凭单元顺序宣称已分析完整情绪推进。'},
    {code: 'psychology_is_inference', detail: 'psychology 是基于文本的分析判断，不是人物真实内心事实；原始 evidence 绑定单元整体，没有逐 psychology 字段归因。'},
    {code: 'author_decision_absent', detail: '没有 authorDecision/authorIntent/creativeDecision 字段；expression 不能改称作者决策，文本也不能证明作者真实意图。'},
    {code: 'field_specific_evidence_absent', detail: '原始 evidence 没有 supports 字段级绑定，因此 emotion/psychology 仅能称“非空字段且有共享单元证据”，不能称字段级直接证据覆盖。'},
    {code: 'reader_and_quality_unvalidated', detail: 'readerEffectHypothesis 仍是假说；文学质量与真人读者效果未经验证。'},
  ];
  sources.push({
    sourceId: row.sourceId,
    title: row.title,
    sourceSha256: row.sourceSha256,
    textVersion: row.textVersion,
    declaredCompleteness: row.completeness ?? 'unknown',
    preexistingCatalogAnalysis: {
      existedBeforeThisRound: Boolean(analysis),
      version: analysis?.version ?? null,
      contentVersion: analysis?.contentVersion ?? null,
      parentAnalysisVersion: analysis?.parentAnalysisVersion ?? null,
      revisionId: analysis?.revisionId ?? null,
      textVersion: analysis?.textVersion ?? null,
      reviewStatus: analysis?.reviewStatus ?? null,
      literalEvidenceStatus: analysis?.validation?.literalEvidence ?? null,
      semanticReview: {
        recordId: review.recordId ?? null,
        approved: review.approved === true,
        outcome: review.outcome ?? null,
        method: review.method ?? null,
        reviewedAt: review.reviewedAt ?? null,
        bindingValid: reviewBindingValid(row),
      },
      unitCount: units.length,
      evidenceRecordCount: allEvidence.length,
      literalEvidenceReverifiedThisAudit: literalVerifiedEvidence,
      unitsWithEvidence: units.filter(unit => Array.isArray(unit.evidence) && unit.evidence.length > 0).length,
      coverage: analysis?.coverage ?? null,
      limitations: Array.isArray(analysis?.limitations) ? analysis.limitations : [],
    },
    currentRoundContribution: {
      type: 'summary_index_registration_and_existing_evidence_reverification_only',
      newAnalysisVersionCreated: false,
      newEmotionAnalysisUnits: 0,
      newPsychologyAnalysisUnits: 0,
      newAuthorDecisionAnalysisUnits: 0,
      neutralSidecarAdded: true,
      selectedSummaryPath: selectionPath,
      selectedSummarySha256: hash(selectionBytes),
      selectedUnitCount: selection.selectedUnitCount,
      selectedUnitIds: selection.selectedObservations.map(item => item.unitId),
      selectedEvidenceCount: selection.selectedEvidenceCount,
      catalogEvidenceReverifiedDuringPackageBuild: listed.auditedCatalogEvidence,
    },
    actualSemanticCoverage: {
      emotion,
      psychology,
      expression,
      readerEffectHypothesis: readerEffect,
      emotionalProgression: {
        actualField: null,
        explicitUnits: explicitEmotionProgressionUnits,
        available: explicitEmotionProgressionUnits > 0,
        note: '逐单元 emotion 不等于显式跨单元情绪推进。',
      },
      authorDecision: {
        actualField: null,
        explicitUnits: explicitAuthorDecisionUnits,
        available: explicitAuthorDecisionUnits > 0,
        note: 'expression 是文本表达观察，不是作者决策或作者意图证据。',
      },
    },
    classification,
    classificationMeaning: classification === 'existing_analysis_usable'
      ? '本轮之前已有与当前文本版本绑定、checked/approved、逐字证据通过的 catalog 单元分析；不表示本轮新完成分析。'
      : classification === 'summary_index_only'
        ? '只有本轮摘要/索引可见，既有 catalog analysis 未达到可用标准。'
        : '没有达到可用标准的既有 analysis，也没有完整六单元摘要。',
    remainingGaps,
  });
}

const count = value => sources.filter(source => source.classification === value).length;
const sum = getter => sources.reduce((total, source) => total + getter(source), 0);
const summary = {
  sourceCount: sources.length,
  baselineSemanticState: {
    existingAnalysisUsable: count('existing_analysis_usable'),
    summaryIndexOnly: count('summary_index_only'),
    missingAnalysis: count('missing_analysis'),
  },
  currentRoundContribution: {
    sourcesWithNewSemanticAnalysis: 0,
    sourcesWithSummaryIndexAndExistingEvidenceReverificationOnly: sources.length,
  },
  preexistingAnalysis: {
    totalUnits: sum(source => source.preexistingCatalogAnalysis.unitCount),
    totalEvidenceRecords: sum(source => source.preexistingCatalogAnalysis.evidenceRecordCount),
    literalEvidenceReverifiedThisAudit: sum(source => source.preexistingCatalogAnalysis.literalEvidenceReverifiedThisAudit),
    checkedReviewBindingsValid: sources.filter(source => source.preexistingCatalogAnalysis.semanticReview.bindingValid).length,
  },
  actualFieldCoverage: {
    emotionPopulatedUnits: sum(source => source.actualSemanticCoverage.emotion.populatedUnits),
    emotionUnitsWithSharedUnitEvidence: sum(source => source.actualSemanticCoverage.emotion.unitsWithSharedUnitEvidence),
    emotionFieldSpecificEvidenceRecords: sum(source => source.actualSemanticCoverage.emotion.fieldSpecificEvidenceRecords),
    psychologyPopulatedUnits: sum(source => source.actualSemanticCoverage.psychology.populatedUnits),
    psychologyUnitsWithSharedUnitEvidence: sum(source => source.actualSemanticCoverage.psychology.unitsWithSharedUnitEvidence),
    psychologyFieldSpecificEvidenceRecords: sum(source => source.actualSemanticCoverage.psychology.fieldSpecificEvidenceRecords),
    explicitEmotionProgressionUnits: sum(source => source.actualSemanticCoverage.emotionalProgression.explicitUnits),
    explicitAuthorDecisionUnits: sum(source => source.actualSemanticCoverage.authorDecision.explicitUnits),
  },
  futureModelScope: {
    toFillMissingBaselineUnitAnalysis: count('summary_index_only') + count('missing_analysis'),
    toCreateNewAnalysisBeyondExistingCatalog: sources.length,
    toCreateExplicitCrossUnitEmotionProgression: sources.filter(source => !source.actualSemanticCoverage.emotionalProgression.available).length,
    toCreateEvidenceBoundObservableCraftDecisionHypotheses: sources.filter(source => !source.actualSemanticCoverage.authorDecision.available).length,
    authorIntentConstraint: '不得把文本推断写成作者真实意图；建议字段命名为 observableCraftDecisionHypothesis。',
  },
};

const audit = {
  schemaVersion: 'remaining99-semantic-coverage-audit-v1',
  generatedWithoutModelOrNetwork: true,
  scope: 'the 99 sources absent from active37 before the catalog-analysis package build',
  candidateReadmeClarification: {
    packageModified: false,
    wording: 'r04 README 中“新增99个来源”只表示新增 sidecar/检索覆盖，不表示本轮新生成99篇 emotion、psychology 或作者决策分析。',
    reasonPackageNotEdited: 'r04 是已验包候选；直接改 README 会破坏 package-manifest 完整性，因此以本独立审计作为语义口径更正。',
  },
  inputBindings: {
    catalog: {path: join(libraryRoot, 'catalog.json'), sha256: hash(catalogBytes)},
    sourceList: {path: sourceListPath, sha256: hash(sourceListBytes)},
    packageRoot,
  },
  definitions: {
    existingAnalysisUsable: 'Pre-existing catalog analysis is current-version bound, checked, semantic-review approved, has units, nonempty emotion and psychology on every unit, and all shared unit evidence is literal in the source.',
    summaryIndexOnly: 'The six-unit summary exists, but pre-existing catalog analysis does not meet the usable definition.',
    missingAnalysis: 'Neither usable pre-existing catalog analysis nor a complete six-unit summary exists.',
    sharedUnitEvidence: 'Evidence is attached to a unit, not explicitly to emotion, psychology, expression, or readerEffectHypothesis.',
    newSemanticAnalysis: 'A new analysis version or new semantic fields generated in this round; indexing, selecting, copying, or re-verifying existing fields does not count.',
  },
  summary,
  sources,
};

const md = [
  '# 剩余99篇语义覆盖审计',
  '',
  '本审计不调用模型、不修改正式库，也不把“可检索”或“六单元摘要”计作新完成的情绪/心理分析。',
  '',
  'r04 README 中“新增99个来源”只表示新增 sidecar/检索覆盖，不表示本轮新生成99篇 emotion、psychology 或作者决策分析。r04 包保持字节不变，以免破坏 package-manifest；本文件是该措辞的独立语义口径更正。',
  '',
  '## 准确口径',
  '',
  `- **既有可用 analysis：${summary.baselineSemanticState.existingAnalysisUsable}/99。** 指本轮之前 catalog 已有当前版本绑定、checked、语义复核 approved、逐字证据通过的单元分析。`,
  `- **仅摘要索引：${summary.baselineSemanticState.summaryIndexOnly}/99。** 该分类只用于没有可用既有 analysis、但有六单元摘要的来源。`,
  `- **缺 analysis：${summary.baselineSemanticState.missingAnalysis}/99。**`,
  `- **本轮新语义分析：${summary.currentRoundContribution.sourcesWithNewSemanticAnalysis}/99。** 99篇本轮新增的都是 sidecar 注册、六单元摘要及既有证据复核，没有创建新的 analysis 版本。`,
  '',
  '## 实际字段与证据',
  '',
  `- 既有 analysis 共 ${summary.preexistingAnalysis.totalUnits} 个单元、${summary.preexistingAnalysis.totalEvidenceRecords} 条单元证据；本审计逐字复核通过 ${summary.preexistingAnalysis.literalEvidenceReverifiedThisAudit} 条。`,
  `- emotion 非空 ${summary.actualFieldCoverage.emotionPopulatedUnits}/${summary.preexistingAnalysis.totalUnits} 单元；有共享单元证据 ${summary.actualFieldCoverage.emotionUnitsWithSharedUnitEvidence}，字段级直接证据 ${summary.actualFieldCoverage.emotionFieldSpecificEvidenceRecords}。`,
  `- psychology 非空 ${summary.actualFieldCoverage.psychologyPopulatedUnits}/${summary.preexistingAnalysis.totalUnits} 单元；有共享单元证据 ${summary.actualFieldCoverage.psychologyUnitsWithSharedUnitEvidence}，字段级直接证据 ${summary.actualFieldCoverage.psychologyFieldSpecificEvidenceRecords}。`,
  `- 显式跨单元 emotionProgression 字段：${summary.actualFieldCoverage.explicitEmotionProgressionUnits} 个单元。逐单元 emotion 不能直接称为完整情绪推进。`,
  `- 显式 authorDecision/authorIntent/creativeDecision 字段：${summary.actualFieldCoverage.explicitAuthorDecisionUnits} 个单元。expression 是表达观察，不能改称作者决策。`,
  '',
  '## 后续模型范围',
  '',
  `- 只为补齐缺失的基础单元 emotion/psychology：${summary.futureModelScope.toFillMissingBaselineUnitAnalysis} 篇。`,
  `- 若要求“本轮新做”而非复用既有 analysis：${summary.futureModelScope.toCreateNewAnalysisBeyondExistingCatalog} 篇。`,
  `- 若要求显式跨单元情绪推进：${summary.futureModelScope.toCreateExplicitCrossUnitEmotionProgression} 篇。`,
  `- 若要求作者决策维度：${summary.futureModelScope.toCreateEvidenceBoundObservableCraftDecisionHypotheses} 篇均缺实际字段；应新增“可观察创作选择假说”，不得声称作者真实意图。`,
  '',
  '## 逐源明细',
  '',
  '| # | 来源 | 既有 analysis / review | 单元 / 证据 | emotion | psychology | 情绪推进 | 作者决策 | 本轮新增 | 分类 | 仍缺 |',
  '|---:|---|---|---:|---:|---:|---:|---:|---|---|---|',
  ...sources.map((source, index) => {
    const a = source.preexistingCatalogAnalysis, c = source.actualSemanticCoverage, added = source.currentRoundContribution;
    const gaps = source.remainingGaps.map(item => item.code).join(', ');
    return `| ${index + 1} | ${markdownEscape(source.title)}<br>\`${source.sourceId}\` | \`${a.version}\`<br>${a.reviewStatus}/${a.literalEvidenceStatus}/approved=${a.semanticReview.approved}/binding=${a.semanticReview.bindingValid} | ${a.unitCount} / ${a.evidenceRecordCount} | ${c.emotion.populatedUnits}/${a.unitCount} shared; direct=${c.emotion.fieldSpecificEvidenceRecords} | ${c.psychology.populatedUnits}/${a.unitCount} shared; direct=${c.psychology.fieldSpecificEvidenceRecords} | explicit=${c.emotionalProgression.explicitUnits} | explicit=${c.authorDecision.explicitUnits} | six=${added.selectedUnitCount}; new semantic=0 | ${source.classification} | ${gaps} |`;
  }),
  '',
  'JSON 文件还逐源保存 contentVersion、parentAnalysisVersion、revisionId、reviewRecordId、复核方法与时间、coverage、全部 catalog limitations、摘要哈希和证据计数。',
  '',
].join('\n');

await writeFile(jsonOutput, `${JSON.stringify(audit, null, 2)}\n`, {flag: 'wx'});
await writeFile(mdOutput, `${md}\n`, {flag: 'wx'});
process.stdout.write(`${JSON.stringify({jsonOutput, mdOutput, summary}, null, 2)}\n`);
