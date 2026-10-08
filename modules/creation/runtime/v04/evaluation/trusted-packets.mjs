// Only independently audited, fixed packets belong here. A caller-supplied
// reviewRecordId or self-computed digest is not an authenticity anchor.
// run-01 and run-02 (2026-09-10) did NOT pass review. Neither is eligible.
// Future entries: id -> { sha256: canonical packet digest, evidence: [local audit paths] }.
export const TRUSTED_PACKETS = Object.freeze({});
