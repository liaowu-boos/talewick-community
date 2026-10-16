import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadNarrativeObservationProjection, NARRATIVE_OBSERVATION_RUNTIME_VERSION} from './narrative-observation-runtime.mjs';

test('missing observation runtime is explicit and keeps the projector disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'talewick-observation-missing-'));
  try {
    const result = await loadNarrativeObservationProjection({
      libraryRoot: join(root, 'library'),
      resolverModuleURL: pathToFileURL(join(root, 'missing-resolver.mjs')),
      serviceModuleURL: pathToFileURL(join(root, 'missing-service.mjs')),
    });
    assert.equal(result.projector, undefined);
    assert.equal(result.query, undefined);
    assert.deepEqual(result.status, {available: false, reason: 'not_installed', contractVersion: NARRATIVE_OBSERVATION_RUNTIME_VERSION});
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('active package resolution produces a bound read-only projector and public status', async () => {
  const calls = [];
  const result = await loadNarrativeObservationProjection({
    libraryRoot: '/fixture/library',
    readActivePointer: async () => ({schemaVersion: 'narrative-observation-active-v1', sourceCount: 37}),
    resolveActivePackage: async input => {
      calls.push(['resolve', input]);
      return {packageRoot: '/fixture/package', pointer: {packageId: 'package-37', sourceCount: 37}};
    },
    createService: async input => {
      calls.push(['service', input]);
      return {projectMaterials: async value => ({...value, projected: true}), query: async value => ({...value, queried: true})};
    },
  });
  assert.deepEqual(calls, [
    ['resolve', {libraryRoot: '/fixture/library', expectedSourceCount: 37}],
    ['service', {libraryRoot: '/fixture/library', sidecarRoot: '/fixture/package'}],
  ]);
  assert.deepEqual(result.status, {available: true, reason: null, contractVersion: NARRATIVE_OBSERVATION_RUNTIME_VERSION, packageId: 'package-37', sourceCount: 37});
  assert.deepEqual(await result.projector({query: '门', materials: []}), {query: '门', materials: [], projected: true});
  assert.deepEqual(await result.query({query: '门'}), {query: '门', queried: true});
});

test('invalid active package is withheld without exposing its internal error', async () => {
  const result = await loadNarrativeObservationProjection({
    libraryRoot: '/fixture/library',
    readActivePointer: async () => ({schemaVersion: 'narrative-observation-active-v1', sourceCount: 37}),
    resolveActivePackage: async () => { throw Object.assign(new Error('private path and digest'), {code: 'ACTIVE_POINTER'}); },
    createService: async () => assert.fail('invalid package must not open the service'),
  });
  assert.equal(result.projector, undefined);
  assert.equal(result.status.available, false);
  assert.equal(result.status.reason, 'invalid_active_package');
  assert.doesNotMatch(JSON.stringify(result.status), /private path|digest/);
});

test('service interface errors fail startup instead of silently disabling a valid package', async () => {
  await assert.rejects(loadNarrativeObservationProjection({
    libraryRoot: '/fixture/library',
    readActivePointer: async () => ({schemaVersion: 'narrative-observation-active-v1', sourceCount: 37}),
    resolveActivePackage: async () => ({packageRoot: '/fixture/package', pointer: {packageId: 'x', sourceCount: 37}}),
    createService: async () => ({}),
  }), /missing projectMaterials or query/);
});

test('pointer count is validated before resolver import and is not a permanent 37-source limit', async () => {
  const seen = [];
  const result = await loadNarrativeObservationProjection({
    libraryRoot: '/fixture/library',
    readActivePointer: async () => ({schemaVersion: 'narrative-observation-active-v1', sourceCount: 52}),
    resolveActivePackage: async input => {
      seen.push(input.expectedSourceCount);
      return {packageRoot: '/fixture/package', pointer: {packageId: 'package-52', sourceCount: 52}};
    },
    createService: async () => ({projectMaterials: async value => value, query: async value => value}),
  });
  assert.deepEqual(seen, [52]);
  assert.equal(result.status.sourceCount, 52);
  const invalid = await loadNarrativeObservationProjection({
    libraryRoot: '/fixture/library',
    readActivePointer: async () => ({schemaVersion: 'narrative-observation-active-v1', sourceCount: 0}),
    resolveActivePackage: async () => assert.fail('invalid pointer must not reach resolver'),
    createService: async () => assert.fail('invalid pointer must not reach service'),
  });
  assert.equal(invalid.status.reason, 'invalid_active_package');
});
