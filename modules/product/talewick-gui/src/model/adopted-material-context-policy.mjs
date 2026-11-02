// Browser-only shape guard. CREATION's module also imports node:crypto and DATA,
// so the host validator stays server-side. Parity tests bind this exact two-key
// representation to validateAdoptedMaterialContextPolicy; no material payload is accepted.
export const ADOPTED_MATERIAL_CONTEXT_POLICY_VERSION = 'whole-quality-adopted-material-context-policy-1';

export function makeAdoptedMaterialContextPolicy() {
  return { schemaVersion: ADOPTED_MATERIAL_CONTEXT_POLICY_VERSION, mode: 'selected_complete_materials' };
}

export function readAdoptedMaterialContextPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || value.schemaVersion !== ADOPTED_MATERIAL_CONTEXT_POLICY_VERSION || value.mode !== 'selected_complete_materials') return undefined;
  return structuredClone(value);
}
