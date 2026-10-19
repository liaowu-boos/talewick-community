#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFile, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createNarrativeObservationService, NARRATIVE_OBSERVATION_QUERY_VERSION} from './narrative-observations.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const LEGACY_FIELDS = ['intro_contract', 'chapter_1_change', 'chapter_2_change', 'midpoint_engine', 'ending_mechanism', 'prose_traits'];
const ANALYSIS_FIELDS = ['event', 'psychology', 'emotion', 'expression', 'readerEffectHypothesis'];

async function readReadyFile(path, encoding = undefined) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Not a regular file: ${path}`);
  return readFile(path, encoding);
}

function args(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index], value = values[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new TypeError('Arguments must be --name value pairs');
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

const options = args(process.argv.slice(2));
if (!options['library-root'] || !options['package-root']) throw new TypeError('Required: --library-root PATH --package-root PATH [--output PATH]');
const coverageBytes = await readReadyFile(`${options['package-root']}/catalog-analysis-coverage.json`);
const coverage = JSON.parse(coverageBytes);
const catalog = JSON.parse(await readReadyFile(join(options['library-root'], 'catalog.json'), 'utf8'));
const service = await createNarrativeObservationService({libraryRoot: options['library-root'], sidecarRoot: options['package-root']});
if (service.scope.sourceCount !== 136 || service.scope.catalogSourceCount !== 136) throw new Error('Probe requires complete 136/136 scope');

const neutralSources = [...coverage.repairedSources, ...coverage.addedSources];
const neutralBySourceId = new Map(neutralSources.map(source => [source.sourceId, source]));
const probes = [];
for (const row of catalog.sources) {
  const source = neutralBySourceId.get(row.sourceId);
  const querySource = source ?? {sourceId: row.sourceId, title: row.title, disposition: 'preserved_historical_card_source'};
  const common = {contractVersion: NARRATIVE_OBSERVATION_QUERY_VERSION, query: querySource.title, sourceIds: [querySource.sourceId]};
  const analysisQuery = row.analysis.units.map(unit => unit.title).join(' ').slice(0, 3900);
  const analysis = await service.query({...common, query: analysisQuery, fields: ANALYSIS_FIELDS, maxResults: 50});
  if (analysis.results.length !== row.analysis.units.length || analysis.withheld.length !== 0
    || analysis.results.some(item => item.currentReviewState?.bindingValid !== true)) {
    throw new Error(`Checked analysis probe failed for ${querySource.sourceId}`);
  }
  let functionLabelledObservationCount = null, selectedNeutralUnitCount = null;
  if (source) {
    const functional = await service.query({...common, fields: LEGACY_FIELDS, maxResults: 10});
    const selected = JSON.parse(await readReadyFile(join(options['package-root'], 'unit-observations', `${source.sourceId}.json`), 'utf8'));
    if (functional.results.length !== 0 || functional.withheld.length !== 0) {
      throw new Error(`Neutral source leaked function-labelled observations for ${source.sourceId}`);
    }
    if (selected.selectedUnitCount !== 6 || selected.selectedObservations.length !== 6
      || selected.selectedObservations.some(item => Object.hasOwn(item, 'field') || !item.value?.event || !item.value?.psychology
        || !item.value?.emotion || !item.value?.expression || !item.value?.readerEffectHypothesis)) {
      throw new Error(`Neutral six-unit selection failed for ${source.sourceId}`);
    }
    functionLabelledObservationCount = functional.results.length;
    selectedNeutralUnitCount = selected.selectedUnitCount;
  }
  const quote = analysis.results[0]?.quotes?.[0]?.quote ?? '';
  probes.push({
    sourceId: querySource.sourceId,
    title: querySource.title,
    query: querySource.title,
    analysisQuerySha256: hash(analysisQuery),
    disposition: querySource.disposition,
    neutralProjection: Boolean(source),
    functionLabelledObservationCount,
    selectedNeutralUnitCount,
    checkedAnalysisUnitCount: analysis.results.length,
    withheldCount: 0,
    sampleUnitId: analysis.results[0]?.unitId ?? null,
    sampleEvidenceSha256: quote ? hash(quote) : null,
    currentReviewBindingValid: true,
  });
}

const sourceList = {
  schemaVersion: 'catalog-narrative-observation-source-list-v1',
  catalogSha256: coverage.catalogBinding.sha256,
  activeBaseSourceCount: coverage.basePackageBinding.sourceCount,
  preservedHistoricalCardSourceCount: coverage.counts.preservedHistoricalCardSources,
  repairedPriorFunctionProjectionSourceCount: coverage.counts.repairedPriorFunctionProjectionSources,
  remainingSourceCount: coverage.addedSources.length,
  sources: coverage.addedSources,
};
const report = {
  schemaVersion: 'catalog-narrative-observation-retrieval-probes-v1',
  libraryRoot: options['library-root'],
  packageRoot: options['package-root'],
  packageCoverageSha256: hash(coverageBytes),
  scope: service.scope,
  snapshot: service.snapshot,
  counts: {
    probes: probes.length,
    passed: probes.length,
    catalogSourceAnalysisProbes: catalog.sources.length,
    addedSourceProbes: coverage.addedSources.length,
    repairedSourceProbes: coverage.repairedSources.length,
    preservedHistoricalSourceProbes: coverage.counts.preservedHistoricalCardSources,
    failed: 0,
    functionLabelledObservationsReturnedForNeutralSources: probes.reduce((sum, item) => sum + (item.functionLabelledObservationCount ?? 0), 0),
    selectedNeutralUnitSummariesChecked: probes.reduce((sum, item) => sum + (item.selectedNeutralUnitCount ?? 0), 0),
    checkedAnalysisUnitsReturned: probes.reduce((sum, item) => sum + item.checkedAnalysisUnitCount, 0),
    withheld: 0,
  },
  probes,
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) await writeFile(options.output, output, {flag: 'wx'});
if (options['source-list-output']) await writeFile(options['source-list-output'], `${JSON.stringify(sourceList, null, 2)}\n`, {flag: 'wx'});
process.stdout.write(`${JSON.stringify({scope: report.scope, counts: report.counts, output: options.output ?? null,
  sourceListOutput: options['source-list-output'] ?? null}, null, 2)}\n`);
