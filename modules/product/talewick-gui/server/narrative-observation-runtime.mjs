import {access, readFile} from 'node:fs/promises';
import {join} from 'node:path';

export const NARRATIVE_OBSERVATION_RUNTIME_VERSION = 'narrative-observation-runtime-1';

const unavailable = reason => Object.freeze({
  projector: undefined,
  query: undefined,
  status: Object.freeze({
    available: false,
    reason,
    contractVersion: NARRATIVE_OBSERVATION_RUNTIME_VERSION,
  }),
});

function reasonFor(error) {
  if (error?.code === 'ENOENT' || error?.code === 'ERR_MODULE_NOT_FOUND') return 'not_installed';
  if (error?.name === 'SyntaxError') return 'invalid_active_package';
  if (typeof error?.code === 'string' && /^(ACTIVE_POINTER|PACKAGE_)/.test(error.code)) return 'invalid_active_package';
  return null;
}

/**
 * Opens the immutable active narrative-observation package read-only. A missing
 * or invalid package never disables the legacy library; it only withholds the
 * optional projector and reports a bounded public status.
 */
export async function loadNarrativeObservationProjection({
  libraryRoot,
  resolverModuleURL = new URL('../../../data/runtime/narrative-observation-batch.mjs', import.meta.url),
  serviceModuleURL = new URL('../../../data/runtime/narrative-observations.mjs', import.meta.url),
  resolveActivePackage,
  createService,
  readActivePointer = async root => JSON.parse(await readFile(join(root, 'narrative-observations', 'active.json'), 'utf8')),
} = {}) {
  if (typeof libraryRoot !== 'string' || !libraryRoot.trim()) throw new TypeError('Narrative observation libraryRoot is required');
  let declaredPointer;
  try {
    declaredPointer = await readActivePointer(libraryRoot);
    if (declaredPointer?.schemaVersion !== 'narrative-observation-active-v1'
      || !Number.isSafeInteger(declaredPointer.sourceCount) || declaredPointer.sourceCount <= 0 || declaredPointer.sourceCount > 10000) {
      throw Object.assign(new Error('Invalid active narrative observation count'), {code: 'ACTIVE_POINTER'});
    }
  } catch (error) {
    const reason = reasonFor(error);
    if (reason) return unavailable(reason);
    throw error;
  }
  const expectedSourceCount = declaredPointer.sourceCount;
  let resolvePackage = resolveActivePackage;
  let openService = createService;
  if (!resolvePackage) {
    try { await access(resolverModuleURL); }
    catch (error) { if (error?.code === 'ENOENT') return unavailable('not_installed'); throw error; }
    resolvePackage = (await import(resolverModuleURL.href || resolverModuleURL)).resolveActiveNarrativeObservationPackage;
  }
  if (!openService) {
    try { await access(serviceModuleURL); }
    catch (error) { if (error?.code === 'ENOENT') return unavailable('not_installed'); throw error; }
    openService = (await import(serviceModuleURL.href || serviceModuleURL)).createNarrativeObservationService;
  }
  if (typeof resolvePackage !== 'function') throw new TypeError('Narrative observation resolver is unavailable');
  if (typeof openService !== 'function') throw new TypeError('Narrative observation service is unavailable');
  try {
    const active = await resolvePackage({libraryRoot, expectedSourceCount});
    const service = await openService({libraryRoot, sidecarRoot: active.packageRoot});
    if (typeof service?.projectMaterials !== 'function' || typeof service?.query !== 'function') throw new TypeError('Narrative observation service missing projectMaterials or query');
    return Object.freeze({
      projector: service.projectMaterials.bind(service),
      query: service.query.bind(service),
      status: Object.freeze({
        available: true,
        reason: null,
        contractVersion: NARRATIVE_OBSERVATION_RUNTIME_VERSION,
        packageId: active.pointer?.packageId ?? null,
        sourceCount: active.pointer?.sourceCount ?? expectedSourceCount,
      }),
    });
  } catch (error) {
    if (error instanceof TypeError && /missing projectMaterials or query/.test(error.message)) throw error;
    return unavailable(reasonFor(error) ?? 'invalid_active_package');
  }
}

export function unavailableNarrativeObservationProjection(reason = 'library_unavailable') {
  return unavailable(reason);
}
