// CREATION owns the exact version/validator; this browser bridge never backfills a saved request.
import { DEEP_REFERENCE_AVAILABILITY_POLICY_VERSION, validateDeepReferenceAvailabilityPolicy }
  from '../../../../creation/runtime/deep-reference-availability.mjs';

export function makeDeepReferenceAvailabilityPolicy() {
  return validateDeepReferenceAvailabilityPolicy({ schemaVersion: DEEP_REFERENCE_AVAILABILITY_POLICY_VERSION, mode: 'require_available' });
}

export function readDeepReferenceAvailabilityPolicy(value) {
  try { return validateDeepReferenceAvailabilityPolicy(value); }
  catch { return undefined; }
}
