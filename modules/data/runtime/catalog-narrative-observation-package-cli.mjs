#!/usr/bin/env node
import {buildCatalogNarrativeObservationPackage, verifyCatalogNarrativeObservationPackage} from './catalog-narrative-observation-package.mjs';

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
if (!options['library-root'] || !options['base-package-root'] || !options['output-root']) {
  throw new TypeError('Required: --library-root PATH --base-package-root PATH --output-root PATH');
}

const result = await buildCatalogNarrativeObservationPackage({
  libraryRoot: options['library-root'],
  basePackageRoot: options['base-package-root'],
  outputRoot: options['output-root'],
});
const verified = await verifyCatalogNarrativeObservationPackage({packageRoot: result.outputRoot});
process.stdout.write(`${JSON.stringify({
  outputRoot: result.outputRoot,
  sourceCount: verified.sourceCount,
  manifestSha256: verified.manifestSha256,
  orderedEntryDigest: verified.manifest.orderedEntryDigest,
  counts: result.coverage.counts,
}, null, 2)}\n`);
