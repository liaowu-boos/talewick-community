// Opt-in host policy; none of these diagnostics authorize adoption or manuscript edits.
export const DEEP_REFERENCE_AVAILABILITY_POLICY_VERSION = 'whole-quality-deep-reference-availability-policy-1';
export const DEEP_REFERENCE_FAILURE_DIAGNOSTIC_VERSION = 'creation-deep-reference-failure-1';
export const DEEP_REFERENCE_ATTEMPT_VERSION = 'whole-quality-reference-attempt-1';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(new Error(message), { code: 'WHOLE_QUALITY_REFERENCE_POLICY' }); };
const callbackCodes = new Set(['INPUT_DATALESS', 'INPUT_EMPTY_OR_DATALESS', 'INPUT_NOT_FILE', 'IO',
  'DEEP_REF_QUERY_INSTALLATION', 'DEEP_REF_QUERY_TAMPER', 'DEEP_REF_QUERY_PROBLEM', 'DEEP_REF_QUERY_DIMENSIONS',
  'DEEP_REF_QUERY_LIMITS', 'DEEP_REF_QUERY_SOURCES', 'DEEP_REF_QUERY_EVIDENCE', 'DEEP_REF_QUERY_REVIEW',
  'DEEP_REF_QUERY_STRING', 'DEEP_REF_JSON', 'DEEP_REF_STALE_INSTALL', 'CALLBACK_ERROR']);
const ioCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'EMFILE', 'ENFILE', 'EBUSY', 'ETIMEDOUT']);

export function validateDeepReferenceAvailabilityPolicy(value) {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).length !== 2
    || value.schemaVersion !== DEEP_REFERENCE_AVAILABILITY_POLICY_VERSION || value.mode !== 'require_available')
    fail('必需深层参考策略字段或版本无效。');
  return structuredClone(value);
}

export function safeDeepReferenceFailure(error, phase) {
  const causeCode = phase === 'response_validation' ? 'DATA_CONTRACT_INVALID'
    : ioCodes.has(error?.code) ? 'IO' : callbackCodes.has(error?.code) ? error.code : 'CALLBACK_ERROR';
  return validateDeepReferenceFailure({ schemaVersion: DEEP_REFERENCE_FAILURE_DIAGNOSTIC_VERSION, phase, causeCode });
}

export function validateDeepReferenceFailure(value) {
  if (!object(value) || Object.keys(value).length !== 3
    || value.schemaVersion !== DEEP_REFERENCE_FAILURE_DIAGNOSTIC_VERSION
    || !(value.phase === 'callback' && callbackCodes.has(value.causeCode)
      || value.phase === 'response_validation' && value.causeCode === 'DATA_CONTRACT_INVALID'))
    fail('深层参考安全错误诊断无效。');
  return structuredClone(value);
}
