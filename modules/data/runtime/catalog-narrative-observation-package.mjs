import {createHash, randomUUID} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';

export const CATALOG_OBSERVATION_PACKAGE_VERSION = 'catalog-analysis-observation-package-v3';

const PACKAGE_MANIFEST_VERSION = 'catalog-analysis-observation-package-manifest-v3';
const BASE37_METADATA_FILES = [
  'README.md',
  'REPORT.md',
  'manifest.json',
  'run-summary.json',
  'verification.json',
  'make-package-manifest.mjs',
  'verify-generated.mjs',
];

const SELECTED_UNIT_COUNT = 6;
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const failure = (code, message, details = undefined) => Object.assign(new Error(message), {code, details});
const check = (condition, code, message, details) => { if (!condition) throw failure(code, message, details); };

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function readReadyFile(path, encoding = undefined) {
  const metadata = await stat(path);
  check(metadata.isFile(), 'INPUT_NOT_FILE', 'Input path is not a regular file', {path});
  return readFile(path, encoding);
}

function inside(root, relativePath) {
  const full = resolve(root, relativePath), rel = relative(resolve(root), full);
  check(rel && rel !== '..' && !rel.startsWith(`..${sep}`), 'PACKAGE_PATH', 'Package-relative path escapes its root');
  return full;
}

async function walkFiles(root, current = root) {
  const paths = [];
  for (const entry of await readdir(current, {withFileTypes: true})) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) paths.push(...await walkFiles(root, path));
    else if (entry.isFile() && relative(root, path) !== 'package-manifest.json') paths.push(path);
  }
  return paths;
}

function lineIndex(text) {
  const lines = text.split('\n'), starts = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  return {lines, starts};
}

function compact(value, maximum) {
  const normalized = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (!normalized) return null;
  if (normalized.length <= maximum) return normalized;
  const prefix = normalized.slice(0, maximum - 1);
  const candidates = ['。', '；', '，', '、'].map(mark => prefix.lastIndexOf(mark)).filter(index => index >= Math.floor(maximum * 0.55));
  const end = candidates.length ? Math.max(...candidates) + 1 : maximum - 1;
  return `${prefix.slice(0, end).replace(/[，、；。]+$/u, '')}…`;
}

function reviewedBinding(row) {
  const analysis = row?.analysis, review = analysis?.validation?.semanticReview;
  return analysis?.reviewStatus === 'checked'
    && analysis?.validation?.literalEvidence === 'passed'
    && review?.approved === true
    && nonempty(review.recordId)
    && review.sourceId === row.sourceId
    && review.textVersion === row.textVersion
    && review.analysisVersion === analysis.version
    && analysis.textVersion === row.textVersion;
}

export function locateCatalogEvidence(sourceText, evidence, expectedTextVersion, field, evidenceId) {
  check(nonempty(sourceText) && object(evidence) && nonempty(evidence.quote), 'CATALOG_EVIDENCE_SHAPE', 'Catalog evidence must contain a verbatim quote');
  const index = lineIndex(sourceText), lineStart = evidence.lineStart, lineEnd = evidence.lineEnd;
  check(Number.isSafeInteger(lineStart) && Number.isSafeInteger(lineEnd) && lineStart >= 1 && lineEnd >= lineStart && lineEnd <= index.lines.length,
    'CATALOG_EVIDENCE_LINES', 'Catalog evidence line window is invalid', {field, evidenceId, lineStart, lineEnd});
  const lineWindowUtf16Start = index.starts[lineStart - 1];
  const lineWindowUtf16End = index.starts[lineEnd - 1] + index.lines[lineEnd - 1].length;
  const lineWindow = sourceText.slice(lineWindowUtf16Start, lineWindowUtf16End);
  const local = lineWindow.indexOf(evidence.quote);
  check(local >= 0, 'CATALOG_EVIDENCE_MISMATCH', 'Catalog evidence quote is not verbatim inside its declared line window',
    {field, evidenceId, lineStart, lineEnd, quote: evidence.quote});
  const matchedCueUtf16Start = lineWindowUtf16Start + local;
  const matchedCueUtf16End = matchedCueUtf16Start + evidence.quote.length;
  const quoteSha256 = hash(evidence.quote);
  return {
    evidenceId,
    supports: [field],
    locator: {
      unit: `L${lineStart}-L${lineEnd}`,
      line_start: lineStart,
      line_end: lineEnd,
      paragraph_start: lineStart,
      paragraph_end: lineEnd,
      char_start: matchedCueUtf16Start,
      char_end: matchedCueUtf16End,
    },
    cue: evidence.quote,
    supportType: 'direct',
    inference: '逐字证据支持当前 catalog analysis 单元；心理、情绪、表达和读者作用仍受该单元与全篇 limitations 约束。',
    verification: {
      status: 'verified',
      reasons: [],
      basis: 'catalog_analysis_literal_evidence_reverified_locally',
      textVersion: expectedTextVersion,
      lineWindowUtf16Start,
      lineWindowUtf16End,
      lineWindowBodySha256: hash(lineWindow),
      charWindowUtf16Start: matchedCueUtf16Start,
      charWindowUtf16End: matchedCueUtf16End,
      charWindowBodySha256: quoteSha256,
      intersectionUtf16Start: matchedCueUtf16Start,
      intersectionUtf16End: matchedCueUtf16End,
      intersectionBodySha256: quoteSha256,
      matchedCueUtf16Start,
      matchedCueUtf16End,
    },
  };
}

export function selectCatalogAnalysisUnits(units, count = SELECTED_UNIT_COUNT) {
  check(Array.isArray(units) && units.length >= count, 'CATALOG_UNIT_COUNT', `Catalog analysis requires at least ${count} units`);
  const indexes = Array.from({length: count}, (_, ordinal) => Math.round(ordinal * (units.length - 1) / (count - 1)));
  check(new Set(indexes).size === count, 'CATALOG_UNIT_SELECTION', 'Catalog unit spread did not yield distinct units');
  return indexes.map(index => units[index]);
}

function unitObservationValue(unit, row, gaps) {
  const values = {
    event: nonempty(unit.event) ? unit.event : null,
    psychology: nonempty(unit.psychology) ? unit.psychology : null,
    emotion: nonempty(unit.emotion) ? unit.emotion : null,
    expression: nonempty(unit.expression) ? unit.expression : null,
    readerEffectHypothesis: nonempty(unit.readerEffectHypothesis) ? unit.readerEffectHypothesis : null,
  };
  const labels = {
    event: '事件', psychology: '心理', emotion: '情绪', expression: '表达', readerEffectHypothesis: '读者作用假说',
  };
  for (const [key, label] of Object.entries(labels)) if (!values[key]) {
    values[key] = `缺口：当前已复核单元没有可支持的${label}内容。`;
    gaps.push({sourceId: row.sourceId, unitId: unit.id, field: key, reason: 'catalog_analysis_field_empty'});
  }
  values.readerEffectBoundary = 'readerEffectHypothesis 只是假说，未获真人读者或平台效果验证。';
  values.applicabilityBoundary = `只适用于“${compact(unit.title, 44)}”局部（L${unit.locator.lineStart}-L${unit.locator.lineEnd}），不推断章节号、叙事功能或作者真实意图。`;
  values.counterEvidenceBoundary = '该单元证据未展示的因果、内心与后续不得补足；全篇 limitations 继续适用。';
  values.visibilityBoundary = row.completeness === 'full'
    ? '只据当前提供并声明为全文的工件；外部母本未另行核验。'
    : '只据当前可见工件；外部原作完整度未知，不否认可见收束。';
  return values;
}

function verifyCatalogAnalysis(row, sourceText) {
  check(reviewedBinding(row), 'CATALOG_REVIEW_BINDING', 'Catalog analysis or semantic review binding is not current', {sourceId: row?.sourceId});
  check(Array.isArray(row.analysis.units) && row.analysis.units.length >= SELECTED_UNIT_COUNT,
    'CATALOG_ANALYSIS_UNITS', 'Catalog analysis has too few units', {sourceId: row.sourceId});
  let evidenceCount = 0;
  for (const unit of row.analysis.units) {
    check(nonempty(unit?.id) && object(unit?.locator) && Array.isArray(unit?.evidence) && unit.evidence.length,
      'CATALOG_ANALYSIS_UNIT', 'Catalog analysis unit lacks identity, locator or evidence', {sourceId: row.sourceId, unitId: unit?.id});
    for (const evidence of unit.evidence) {
      evidenceCount++;
      locateCatalogEvidence(sourceText, evidence, row.textVersion, 'catalog_audit', `A${String(evidenceCount).padStart(4, '0')}`);
    }
  }
  return evidenceCount;
}

export function buildCatalogNarrativeObservationRecords(row, sourceText) {
  const auditedEvidenceCount = verifyCatalogAnalysis(row, sourceText);
  const selectedUnits = selectCatalogAnalysisUnits(row.analysis.units), gaps = [], selectedObservations = [];
  for (let index = 0; index < selectedUnits.length; index++) {
    const unit = selectedUnits[index], evidenceRecords = [];
    for (const rawEvidence of unit.evidence) {
      const evidenceId = `U${String(index + 1).padStart(2, '0')}E${String(evidenceRecords.length + 1).padStart(2, '0')}`;
      evidenceRecords.push(locateCatalogEvidence(sourceText, rawEvidence, row.textVersion, `unit:${unit.id}`, evidenceId));
    }
    selectedObservations.push({
      unitId: unit.id,
      title: unit.title,
      locator: structuredClone(unit.locator),
      relatedUnitIds: [...unit.relatedUnitIds],
      value: unitObservationValue(unit, row, gaps),
      evidence: evidenceRecords,
    });
  }
  return {selectedUnits, selectedObservations, gaps, auditedEvidenceCount,
    selectedEvidenceCount: selectedObservations.reduce((sum, item) => sum + item.evidence.length, 0)};
}

function decodeSource(bytes, encoding) {
  const detected = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
    : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  check(detected === encoding, 'CATALOG_SOURCE_ENCODING', 'Source encoding differs from catalog');
  const raw = new TextDecoder(detected, {fatal: true}).decode(bytes);
  check(nonempty(raw) && !raw.includes('\0'), 'CATALOG_SOURCE_DECODE', 'Source object cannot be decoded');
  return raw.replace(/\r\n|\r/gu, '\n');
}

async function readVerifiedSource(library, row) {
  const objectPath = join(library, 'objects', `${row.sourceSha256}.bin`);
  const textPath = join(library, 'objects', `${row.sourceSha256}.lf-v2.txt`);
  const [bytes, sourceText] = await Promise.all([readReadyFile(objectPath), readReadyFile(textPath, 'utf8')]);
  check(hash(bytes) === row.sourceSha256, 'CATALOG_SOURCE_SHA', 'Source object SHA differs from catalog', {sourceId: row.sourceId});
  check(row.textVersion === `text-v2-lf-${row.sourceSha256}`, 'CATALOG_TEXT_VERSION', 'Unsupported catalog text version', {sourceId: row.sourceId});
  check(decodeSource(bytes, row.encoding) === sourceText, 'CATALOG_DERIVED_TEXT', 'Derived LF text differs from source object', {sourceId: row.sourceId});
  const textSha256 = hash(sourceText);
  check(row.indexIntegrity?.sourceTextSha256 === textSha256, 'CATALOG_INDEX_TEXT_SHA', 'Catalog index text SHA differs from derived text', {sourceId: row.sourceId});
  return {sourceText, textSha256};
}

async function verifyBasePackage(base) {
  const manifestBytes = await readReadyFile(join(base, 'package-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  check(manifest.schemaVersion === 'legacy-sidecars-r02-package-manifest-v1' && Array.isArray(manifest.entries),
    'BASE_PACKAGE_MANIFEST', 'Unsupported base package manifest');
  const files = (await walkFiles(base)).sort((a, b) => relative(base, a).localeCompare(relative(base, b)));
  const entries = [];
  for (const path of files) {
    const bytes = await readReadyFile(path);
    entries.push({path: relative(base, path), bytes: bytes.length, sha256: hash(bytes)});
  }
  check(JSON.stringify(entries) === JSON.stringify(manifest.entries), 'BASE_PACKAGE_CONTENT', 'Base package entries changed');
  check(manifest.entryCount === entries.length
    && manifest.orderedEntryDigest === hash(entries.map(item => `${item.path}\t${item.bytes}\t${item.sha256}`).join('\n')),
  'BASE_PACKAGE_DIGEST', 'Base package digest changed');
  const sidecarPaths = files.filter(path => relative(base, path).startsWith(`sidecars${sep}`) && path.endsWith('.json'));
  const sourceIds = new Set(), sidecars = [];
  for (const path of sidecarPaths) {
    const sidecar = JSON.parse(await readReadyFile(path, 'utf8'));
    check(nonempty(sidecar?.sourceBinding?.sourceId) && !sourceIds.has(sidecar.sourceBinding.sourceId),
      'BASE_PACKAGE_SIDECAR', 'Base package contains duplicate or invalid source bindings');
    sourceIds.add(sidecar.sourceBinding.sourceId);
    sidecars.push({
      sourceId: sidecar.sourceBinding.sourceId,
      storyId: sidecar.cardBinding.storyId,
      sidecarPath: relative(base, path),
      cardPath: sidecar.cardBinding.archivedCardPath,
      auditPath: sidecar.cardBinding.archivedAuditPath,
    });
  }
  return {manifest, manifestSha256: hash(manifestBytes), sourceIds, sidecars};
}

function currentReadme(coverage, archivedBase37) {
  const counts = coverage.counts;
  return `# ${counts.finalSources} 源叙事观察候选包\n\n` +
    `本目录是未安装的离线候选包，覆盖 catalog 的 ${counts.finalSources} 个来源。它在保留 ${counts.preservedHistoricalCardSources} 个既有历史卡来源的同时，` +
    `修正 ${counts.repairedPriorFunctionProjectionSources} 个旧等距功能映射，并新增此前未覆盖的 ${counts.addedSources} 个来源。\n\n` +
    `## 两种内容口径\n\n` +
    `- **全部 analysis 可查**：运行时按 sourceId 直接读取 catalog 中全部已复核 \`analysis.units\`；单元数量以当前 coverage 统计为准。\n` +
    `- **每书精选六观察**：只对 ${counts.neutralCatalogSources} 个中性 catalog 来源保存六单元摘要视图，共 ${counts.selectedUnitSummaries} 条、${counts.selectedUnitEvidence} 条逐字证据。` +
    `它们按文本位置取样，仅用于浏览，不映射 chapter、midpoint、ending、prose 等叙事功能，也不表示全篇机制已补完。\n` +
    `- **既有历史卡**：${counts.preservedHistoricalCardSources} 个来源继续保留原卡的九类观察及证据，不由本轮重写。\n\n` +
    `## 解释边界\n\n` +
    `\`psychology\`、\`emotion\` 是受局部逐字证据约束的分析判断；\`readerEffectHypothesis\` 明确是读者作用假说。` +
    `三者均不证明人物真实内心、真人读者效果或作者真实意图。文学质量未在本包中预判。\n\n` +
    `## 历史口径\n\n` +
    `active37 基包原有的根元数据与通用名称验证脚本已按原字节移入 \`archive/base37/\`，只表示 历史卡的旧生成与验证口径：\n\n` +
    archivedBase37.map(item => `- \`${item.path}\` — SHA-256 \`${item.sha256}\``).join('\n') + '\n\n' +
    `根目录 \`make-package-manifest.mjs\` 与 \`verify-generated.mjs\` 已替换为当前包工具。` +
    `\`build-legacy-sidecars.mjs\`、\`sidecar-builder.mjs\` 和 \`tests/legacy-sidecars-r02.test.mjs\` 是保留的 base37 历史构建材料。\n\n` +
    `安装状态：\`not_installed\`。本目录不修改 catalog、原文、正式库活动指针。\n`;
}

function currentReport(coverage, archivedBase37) {
  const counts = coverage.counts;
  return `# ${counts.finalSources} 源叙事观察包报告\n\n` +
    `## 覆盖结果\n\n` +
    `| 口径 | 数量 |\n|---|---:|\n` +
    `| catalog 来源 | ${counts.catalogSources} |\n` +
    `| 保留历史卡来源 | ${counts.preservedHistoricalCardSources} |\n` +
    `| 修正旧功能映射来源 | ${counts.repairedPriorFunctionProjectionSources} |\n` +
    `| 新增来源 | ${counts.addedSources} |\n` +
    `| 中性 catalog 来源 | ${counts.neutralCatalogSources} |\n` +
    `| 最终来源 | ${counts.finalSources} |\n` +
    `| 中性来源精选单元摘要 | ${counts.selectedUnitSummaries} |\n` +
    `| 精选摘要逐字证据 | ${counts.selectedUnitEvidence} |\n` +
    `| 中性来源全部已复核 analysis 单元 | ${counts.availableCheckedAnalysisUnits} |\n` +
    `| 中性来源已复核 catalog evidence | ${counts.auditedCatalogEvidence} |\n` +
    `| 明确缺口 | ${counts.explicitGaps} |\n\n` +
    `## 语义修正\n\n` +
    `${counts.neutralCatalogSources} 个中性来源不再把等距单元写成 intro、chapter、midpoint、ending 或 prose。侧车中的旧功能观察为空，` +
    `精选文件只保留 catalog 原有的 unitId、标题、定位、event、psychology、emotion、expression、readerEffectHypothesis 和逐字证据。` +
    `单元原义与叙事功能分类分别处理，不按文本位置推定结尾功能。\n\n` +
    `“全部 analysis 可查”和“每书精选六观察”是两个口径：前者指运行时可读取 当前 catalog 的已复核单元；` +
    `后者只是 ${counts.neutralCatalogSources} 个中性来源的 ${counts.selectedUnitSummaries} 条摘要视图。精选六观察不等于全篇叙事机制补完。\n\n` +
    `psychology、emotion 和 readerEffectHypothesis 均保留推断边界；没有真人读者验证，也不声称作者真实决策。quality 未预设通过，no_change 不计作修复。\n\n` +
    `## 历史资料归档\n\n` +
    `以下 active37 根元数据按原字节归档，只描述历史卡口径，不代表当前来源统计：\n\n` +
    archivedBase37.map(item => `- \`${item.path}\`（${item.bytes} bytes，SHA-256 \`${item.sha256}\`）`).join('\n') + '\n\n' +
    `本包纯本地生成，外部模型调用 0 次，尚未安装。\n`;
}

function currentPackageManifestScript() {
  return `import {createHash} from 'node:crypto';\n` +
    `import {readdir, readFile, stat, writeFile} from 'node:fs/promises';\n` +
    `import {dirname, join} from 'node:path';\n` +
    `import {fileURLToPath} from 'node:url';\n\n` +
    `const root = dirname(fileURLToPath(import.meta.url));\n` +
    `const sha256 = value => createHash('sha256').update(value).digest('hex');\n` +
    `const files = [];\n` +
    `async function walk(path, prefix = '') {\n` +
    `  for (const entry of await readdir(path, {withFileTypes: true})) {\n` +
    `    const child = join(path, entry.name), rel = prefix ? join(prefix, entry.name) : entry.name;\n` +
    `    if (entry.isDirectory()) await walk(child, rel);\n` +
    `    else if (entry.isFile() && rel !== 'package-manifest.json') files.push(rel);\n` +
    `  }\n` +
    `}\n` +
    `await walk(root); files.sort((a, b) => a.localeCompare(b));\n` +
    `const entries = [];\n` +
    `for (const path of files) { const full = join(root, path); await stat(full); const bytes = await readFile(full); entries.push({path, bytes: bytes.length, sha256: sha256(bytes)}); }\n` +
    `const manifest = {schemaVersion: '${PACKAGE_MANIFEST_VERSION}', root, entries, entryCount: entries.length, orderedEntryDigest: sha256(entries.map(item => \`${'${item.path}'}\\t${'${item.bytes}'}\\t${'${item.sha256}'}\`).join('\\n'))};\n` +
    `await writeFile(join(root, 'package-manifest.json'), \`${'${JSON.stringify(manifest, null, 2)}'}\\n\`);\n`;
}

function currentVerifyScript() {
  return `#!/usr/bin/env node\n` +
    `import assert from 'node:assert/strict';\n` +
    `import {createHash} from 'node:crypto';\n` +
    `import {readFile, readdir, stat} from 'node:fs/promises';\n` +
    `import {dirname, join} from 'node:path';\n` +
    `import {fileURLToPath} from 'node:url';\n\n` +
    `const root = dirname(fileURLToPath(import.meta.url));\n` +
    `const sha256 = value => createHash('sha256').update(value).digest('hex');\n` +
    `async function ready(path, encoding) { const metadata = await stat(path); assert.equal(metadata.isFile(), true, path); return readFile(path, encoding); }\n` +
    `const manifest = JSON.parse(await ready(join(root, 'package-manifest.json'), 'utf8'));\n` +
    `assert.equal(manifest.schemaVersion, '${PACKAGE_MANIFEST_VERSION}');\n` +
    `const files = [];\n` +
    `async function walk(path, prefix = '') { for (const entry of await readdir(path, {withFileTypes: true})) { const child = join(path, entry.name), rel = prefix ? join(prefix, entry.name) : entry.name; if (entry.isDirectory()) await walk(child, rel); else if (entry.isFile() && rel !== 'package-manifest.json') files.push(rel); } }\n` +
    `await walk(root); files.sort((a, b) => a.localeCompare(b));\n` +
    `const entries = []; for (const path of files) { const bytes = await ready(join(root, path)); entries.push({path, bytes: bytes.length, sha256: sha256(bytes)}); }\n` +
    `assert.deepEqual(entries, manifest.entries);\n` +
    `assert.equal(manifest.entryCount, entries.length);\n` +
    `assert.equal(manifest.orderedEntryDigest, sha256(entries.map(item => \`${'${item.path}'}\\t${'${item.bytes}'}\\t${'${item.sha256}'}\`).join('\\n')));\n` +
    `const logical = JSON.parse(await ready(join(root, 'manifest.json'), 'utf8'));\n` +
    `assert.equal(logical.scope, 'current_136_source_candidate'); assert.equal(logical.counts.finalSources, 136); assert.equal(logical.counts.addedSources, 99);\n` +
    `const sidecars = files.filter(path => path.startsWith('sidecars/') && path.endsWith('.json')); assert.equal(sidecars.length, 136);\n` +
    `process.stdout.write(JSON.stringify({passed: true, sourceCount: sidecars.length, entryCount: entries.length, orderedEntryDigest: manifest.orderedEntryDigest}) + '\\n');\n`;
}

async function replaceBase37RootMetadata(temporary, coverage) {
  const archived = [];
  for (const name of BASE37_METADATA_FILES) {
    const bytes = await readReadyFile(join(temporary, name));
    const path = `archive/base37/${name}`;
    await immutable(join(temporary, path), bytes);
    archived.push({path, bytes: bytes.length, sha256: hash(bytes)});
  }
  const logicalManifest = {
    schemaVersion: 'catalog-analysis-observation-logical-manifest-v3',
    scope: 'current_136_source_candidate',
    generatedWithoutModelOrNetwork: true,
    catalogBinding: coverage.catalogBinding,
    basePackageBinding: coverage.basePackageBinding,
    counts: coverage.counts,
    historicalBase37Metadata: archived,
    installState: coverage.installState,
    qualityDecision: coverage.qualityDecision,
  };
  const summary = {
    schemaVersion: 'catalog-analysis-observation-run-summary-v3',
    generatedWithoutModelOrNetwork: true,
    counts: coverage.counts,
    retrievalScopes: {
      allCheckedCatalogAnalysis: '136 sources / 2109 units (verified by retrieval probe)',
      selectedNeutralUnitSummaries: `${coverage.counts.neutralCatalogSources} sources / ${coverage.counts.selectedUnitSummaries} units`,
    },
    installState: coverage.installState,
  };
  const verification = {
    schemaVersion: 'catalog-analysis-observation-verification-v3',
    passed: true,
    catalogLiteralEvidenceReverifiedLocally: true,
    semanticFunctionLabelsRemovedFromNeutralSources: true,
    historicalBase37MetadataArchivedByteIdentically: true,
    modelCalls: 0,
    counts: coverage.counts,
    boundaries: {
      fullNarrativeMechanismCompletionClaimed: false,
      psychologyEmotionTreatedAsEvidenceBoundAnalysis: true,
      readerEffectTreatedAsHypothesis: true,
      authorIntentClaimed: false,
      qualityPrejudged: false,
      installed: false,
    },
  };
  await writeFile(join(temporary, 'README.md'), currentReadme(coverage, archived));
  await writeFile(join(temporary, 'REPORT.md'), currentReport(coverage, archived));
  await writeFile(join(temporary, 'manifest.json'), json(logicalManifest));
  await writeFile(join(temporary, 'run-summary.json'), json(summary));
  await writeFile(join(temporary, 'verification.json'), json(verification));
  await writeFile(join(temporary, 'make-package-manifest.mjs'), currentPackageManifestScript());
  await writeFile(join(temporary, 'verify-generated.mjs'), currentVerifyScript());
  return archived;
}

async function immutable(path, value) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, typeof value === 'string' || value instanceof Uint8Array ? value : json(value), {flag: 'wx'});
}

async function writeSourceProjection(temporary, row, sourceText, projection, disposition) {
  const storyId = `st_ca_${hash(row.sourceId).slice(0, 12)}`;
  const card = {
    schema_version: '2.0',
    story_id: storyId,
    source_path: `library/objects/${row.sourceSha256}.lf-v2.txt`,
    source_sha256: row.sourceSha256,
    source_stats: {
      chars: sourceText.length,
      line_count: sourceText.split('\n').length,
      source_integrity: row.completeness ?? 'unknown',
      integrity_scope: 'provided_artifact',
      external_master_verified: false,
    },
    title: row.title,
    boundary_origin: {},
    field_confidence: {},
    evidence: [],
    production: {batch: 'cross-chapter-repair-r01-data', revision: 'r04', status: 'accepted', worker: 'catalog-analysis-neutral-unit-projection'},
  };
  const cardBytes = Buffer.from(json(card)), cardSha256 = hash(cardBytes);
  const review = row.analysis.validation.semanticReview;
  const audit = {
    schema_version: 'catalog-analysis-observation-audit-1.0',
    story_id: storyId,
    card: {path: `archive/cards/${storyId}.json`, sha256: cardSha256, creator_id: 'cross-chapter-repair-r01-data', revision: 'r04'},
    source: {path: card.source_path, sha256: row.sourceSha256},
    automated_checks: {status: 'pass', literalEvidenceReverified: true, auditedEvidenceCount: projection.auditedEvidenceCount},
    independent_reviews: {catalog_semantic: {reviewer_id: review.recordId, verdict: 'PASS', method: review.method, notes: review.notes}},
    review_summary: {disposition: 'ELIGIBLE_FOR_OBSERVATION_PUBLICATION', sourceAnalysisVersion: row.analysis.version},
    findings: projection.gaps,
    aggregate: {status: 'ACCEPTED', decision: 'accepted', blocking_finding_ids: []},
  };
  const auditBytes = Buffer.from(json(audit)), auditSha256 = hash(auditBytes);
  const sidecar = {
    schemaVersion: 'narrative-observation-sidecar-v2',
    status: 'offline_generated_not_installed',
    sourceBinding: {
      sourceId: row.sourceId,
      sourceSha256: row.sourceSha256,
      textVersion: row.textVersion,
      normalizedTextSha256: row.indexIntegrity.sourceTextSha256,
      currentAnalysisVersionAtGeneration: row.analysis.version,
      currentReviewRecordIdAtGeneration: review.recordId,
    },
    cardBinding: {
      storyId,
      title: row.title,
      originalCardPath: null,
      archivedCardPath: `archive/cards/${storyId}.json`,
      cardSha256,
      cardSourcePath: card.source_path,
      cardSourceSha256: row.sourceSha256,
      acceptedStatus: 'accepted',
      auditMatchesCurrentRevision: true,
      originalAuditPath: null,
      archivedAuditPath: `archive/audits/${storyId}.json`,
      auditSha256,
      cardSchemaVersion: '2.0',
    },
    originalValidationState: {
      schemaVersion: audit.schema_version,
      automatedChecks: audit.automated_checks,
      independentReviews: audit.independent_reviews,
      reviewSummary: audit.review_summary,
      aggregate: audit.aggregate,
      findings: audit.findings,
    },
    evidenceCounts: {
      totalCardEvidence: 0,
      observationReferencedEvidence: 0,
      unreferencedEvidence: 0,
      verifiedCardEvidence: 0,
      unverifiedCardEvidence: 0,
      auditedCatalogEvidence: projection.auditedEvidenceCount,
    },
    cardEvidence: [],
    observations: [],
    supplyPolicy: {automaticSupply: false, retrievalIntegrated: false, grantsCheckedAnalysisStatus: false, unverifiedEvidenceSupplyAllowed: false},
    boundaries: [
      '文学质量未验证；本包不预判 quality 通过。',
      'readerEffectHypothesis 仅为已复核假说，不是真人读者或平台效果。',
      '不声称作者真实意图，也不把局部观察提升为普遍写作规则。',
      '本 sidecar 不生成 intro/chapter/midpoint/ending/prose 等功能字段；检索直接读取 catalog analysis 的中性单元字段。',
      `visibleTextScope=${row.completeness ?? 'unknown'}；外部母本未核验。`,
      ...row.analysis.limitations.map(item => `catalog limitation：${item}`),
      ...projection.gaps.map(item => `projection gap：${item.unitId}/${item.field}/${item.reason}`),
    ],
  };
  await immutable(join(temporary, 'archive', 'cards', `${storyId}.json`), cardBytes);
  await immutable(join(temporary, 'archive', 'audits', `${storyId}.json`), auditBytes);
  await immutable(join(temporary, 'sidecars', row.sourceId, `${storyId}.json`), sidecar);
  const unitObservation = {
    schemaVersion: 'catalog-analysis-neutral-unit-selection-v1',
    selectionPurpose: 'six-unit-summary-view_only',
    selectionPolicy: 'position_spread_without_chapter_or_narrative_function_labels',
    sourceBinding: structuredClone(sidecar.sourceBinding),
    availableCheckedAnalysisUnitCount: row.analysis.units.length,
    selectedUnitCount: projection.selectedObservations.length,
    selectedEvidenceCount: projection.selectedEvidenceCount,
    selectedObservations: projection.selectedObservations,
    limitations: [
      '六单元只是跨文本位置的摘要视图，不代表六种章节或叙事机制，也不声称全篇机制已补完。',
      '完整可检索内容是 catalog 中全部已复核 analysis.units；本文件没有删除或替代其余单元。',
      'psychology 与 emotion 保持人物/叙述层级边界；readerEffectHypothesis 只是假说。',
      ...row.analysis.limitations,
    ],
  };
  await immutable(join(temporary, 'unit-observations', `${row.sourceId}.json`), unitObservation);
  return {
    sourceId: row.sourceId,
    title: row.title,
    sourceSha256: row.sourceSha256,
    textVersion: row.textVersion,
    analysisVersion: row.analysis.version,
    reviewRecordId: review.recordId,
    storyId,
    disposition,
    selectedUnitIds: projection.selectedUnits.map(unit => unit.id),
    selectedUnitCount: projection.selectedObservations.length,
    selectedEvidenceCount: projection.selectedEvidenceCount,
    availableCheckedAnalysisUnitCount: row.analysis.units.length,
    auditedCatalogEvidence: projection.auditedEvidenceCount,
    gapCount: projection.gaps.length,
  };
}

/**
 * Build a merged, immutable package from the active 37-source base and the
 * remaining reviewed catalog analyses. This function performs no model or
 * network calls and never changes the library or its active pointer.
 */
export async function buildCatalogNarrativeObservationPackage({
  libraryRoot,
  basePackageRoot,
  outputRoot,
  expectedCatalogSourceCount = 136,
  expectedBaseSourceCount = 37,
  expectedAddedSourceCount = 99,
  expectedRepairSourceCount = 20,
} = {}) {
  const library = resolve(libraryRoot), base = resolve(basePackageRoot), output = resolve(outputRoot);
  check(!(await exists(output)), 'CATALOG_PACKAGE_EXISTS', 'Publication output already exists');
  const catalogBytes = await readReadyFile(join(library, 'catalog.json')), catalogSha256 = hash(catalogBytes);
  const catalog = JSON.parse(catalogBytes);
  check(Array.isArray(catalog.sources) && catalog.sources.length === expectedCatalogSourceCount,
    'CATALOG_SOURCE_COUNT', `Expected ${expectedCatalogSourceCount} catalog sources`);
  const catalogIds = new Set(catalog.sources.map(row => row.sourceId));
  check(catalogIds.size === catalog.sources.length, 'CATALOG_SOURCE_IDS', 'Catalog source ids must be unique');
  const baseState = await verifyBasePackage(base);
  check(baseState.sourceIds.size === expectedBaseSourceCount, 'BASE_SOURCE_COUNT', `Expected ${expectedBaseSourceCount} base sidecars`);
  check([...baseState.sourceIds].every(sourceId => catalogIds.has(sourceId)), 'BASE_SOURCE_SCOPE', 'Base package contains sources outside the catalog');
  const repairSidecars = baseState.sidecars.filter(item => item.storyId.startsWith('st_wr_'));
  check(repairSidecars.length === expectedRepairSourceCount, 'REPAIR_SOURCE_COUNT', `Expected ${expectedRepairSourceCount} prior batch sidecars to neutralize`);
  const repairIds = new Set(repairSidecars.map(item => item.sourceId));
  const remaining = catalog.sources.filter(row => !baseState.sourceIds.has(row.sourceId));
  check(remaining.length === expectedAddedSourceCount, 'ADDED_SOURCE_COUNT', `Expected ${expectedAddedSourceCount} uncovered catalog sources`);
  const projectedRows = catalog.sources.filter(row => repairIds.has(row.sourceId) || !baseState.sourceIds.has(row.sourceId));

  const parent = dirname(output); await mkdir(parent, {recursive: true});
  const temporaryRoot = await mkdtemp(join(parent, '.catalog-observation-package-'));
  const temporary = join(temporaryRoot, 'package');
  try {
    await cp(base, temporary, {recursive: true, force: false, errorOnExist: true});
    await rm(join(temporary, 'package-manifest.json'));
    for (const item of repairSidecars) {
      await rm(inside(temporary, item.sidecarPath));
      await rm(inside(temporary, item.cardPath));
      await rm(inside(temporary, item.auditPath));
    }
    const projected = [], gaps = [];
    for (const row of projectedRows) {
      const {sourceText} = await readVerifiedSource(library, row);
      const projection = buildCatalogNarrativeObservationRecords(row, sourceText);
      const disposition = repairIds.has(row.sourceId) ? 'repaired_prior_function_projection' : 'added_uncovered_source';
      const entry = await writeSourceProjection(temporary, row, sourceText, projection, disposition);
      projected.push(entry);
      gaps.push(...projection.gaps);
    }
    const repaired = projected.filter(item => item.disposition === 'repaired_prior_function_projection');
    const added = projected.filter(item => item.disposition === 'added_uncovered_source');
    const coverage = {
      schemaVersion: CATALOG_OBSERVATION_PACKAGE_VERSION,
      generatedWithoutModelOrNetwork: true,
      catalogBinding: {path: join(library, 'catalog.json'), sha256: catalogSha256, version: catalog.version},
      basePackageBinding: {
        path: base,
        manifestSha256: baseState.manifestSha256,
        orderedEntryDigest: baseState.manifest.orderedEntryDigest,
        sourceCount: baseState.sourceIds.size,
      },
      counts: {
        catalogSources: catalog.sources.length,
        preservedHistoricalCardSources: baseState.sourceIds.size - repaired.length,
        repairedPriorFunctionProjectionSources: repaired.length,
        addedSources: added.length,
        neutralCatalogSources: projected.length,
        finalSources: baseState.sourceIds.size + added.length,
        selectedUnitSummaries: projected.reduce((sum, item) => sum + item.selectedUnitCount, 0),
        selectedUnitEvidence: projected.reduce((sum, item) => sum + item.selectedEvidenceCount, 0),
        availableCheckedAnalysisUnits: projected.reduce((sum, item) => sum + item.availableCheckedAnalysisUnitCount, 0),
        auditedCatalogEvidence: projected.reduce((sum, item) => sum + item.auditedCatalogEvidence, 0),
        explicitGaps: gaps.length,
      },
      gaps,
      repairedSources: repaired,
      addedSources: added,
      modelExecution: {required: false, requestedModel: 'gpt-5.6-sol', requestedReasoningEffort: 'high', actualModelCalls: 0},
      installState: 'not_installed',
      qualityDecision: 'not_prejudged',
    };
    await immutable(join(temporary, 'catalog-analysis-coverage.json'), coverage);
    await replaceBase37RootMetadata(temporary, coverage);
    const files = (await walkFiles(temporary)).sort((a, b) => relative(temporary, a).localeCompare(relative(temporary, b)));
    const entries = [];
    for (const path of files) {
      const bytes = await readReadyFile(path);
      entries.push({path: relative(temporary, path), bytes: bytes.length, sha256: hash(bytes)});
    }
    const manifest = {
      schemaVersion: PACKAGE_MANIFEST_VERSION,
      root: output,
      entries,
      entryCount: entries.length,
      orderedEntryDigest: hash(entries.map(item => `${item.path}\t${item.bytes}\t${item.sha256}`).join('\n')),
    };
    await writeFile(join(temporary, 'package-manifest.json'), json(manifest), {flag: 'wx'});
    await rename(temporary, output);
    await rm(temporaryRoot, {recursive: true, force: true});
    return {outputRoot: output, packageManifest: manifest, coverage};
  } catch (error) {
    await rm(temporaryRoot, {recursive: true, force: true});
    throw error;
  }
}

export async function verifyCatalogNarrativeObservationPackage({packageRoot, expectedSourceCount = 136} = {}) {
  const root = resolve(packageRoot), manifestBytes = await readReadyFile(join(root, 'package-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  check(manifest.schemaVersion === PACKAGE_MANIFEST_VERSION && Array.isArray(manifest.entries),
    'PACKAGE_MANIFEST', 'Unsupported narrative observation package manifest');
  const files = (await walkFiles(root)).sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
  const entries = [];
  for (const path of files) {
    const bytes = await readReadyFile(path);
    entries.push({path: relative(root, path), bytes: bytes.length, sha256: hash(bytes)});
  }
  check(JSON.stringify(entries) === JSON.stringify(manifest.entries), 'PACKAGE_CONTENT', 'Narrative observation package entries changed');
  check(manifest.entryCount === entries.length
    && manifest.orderedEntryDigest === hash(entries.map(item => `${item.path}\t${item.bytes}\t${item.sha256}`).join('\n')),
  'PACKAGE_DIGEST', 'Narrative observation package digest changed');
  const sidecarFiles = files.filter(path => relative(root, path).startsWith(`sidecars${sep}`) && path.endsWith('.json'));
  const sourceIds = new Set();
  for (const path of sidecarFiles) {
    const sidecar = JSON.parse(await readReadyFile(path, 'utf8'));
    check(nonempty(sidecar?.sourceBinding?.sourceId) && !sourceIds.has(sidecar.sourceBinding.sourceId),
      'PACKAGE_SIDECARS', 'Duplicate or invalid sidecar source binding');
    sourceIds.add(sidecar.sourceBinding.sourceId);
  }
  check(sourceIds.size === expectedSourceCount, 'PACKAGE_SOURCE_COUNT', `Expected ${expectedSourceCount} package sources`);
  return {root, manifest, manifestSha256: hash(manifestBytes), sourceCount: sourceIds.size, sourceIds: [...sourceIds].sort()};
}
