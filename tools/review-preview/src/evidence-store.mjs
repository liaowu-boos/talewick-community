import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile, lstat, realpath, open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
export const isId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(value);
export function binding(value, expected) {
  for (const key of ['caseId', 'baselineSHA256', 'candidateSHA256']) assert.equal(value[key], expected[key], `Binding mismatch: ${key}`);
}
export function validBinding(value) {
  assert(isId(value.caseId), 'Invalid case id');
  for (const key of ['baselineSHA256', 'candidateSHA256']) assert(HASH.test(value[key]), `Invalid ${key}`);
}
// Root is a trusted local directory. Every child segment must be real, with no traversal,
// symbolic links or aliases. The last file is opened O_NOFOLLOW and bytes are hash-checked.
export async function readContained(root, relative) {
  assert(typeof relative === 'string' && !path.isAbsolute(relative) && !relative.includes('\\'), 'Relative path required');
  const parts = relative.split('/');
  assert(parts.every(p => p && p !== '.' && p !== '..' && !p.includes('\0')), 'Unsafe path');
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const st = await lstat(current);
    assert(!st.isSymbolicLink(), 'Symlink refused');
    assert(i === parts.length - 1 ? st.isFile() : st.isDirectory(), 'Regular file/directory required');
  }
  assert.equal(await realpath(current), current, 'Path alias refused');
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    assert(st.isFile(), 'Regular file required');
    assert(st.size <= 32 * 1024 * 1024, 'Evidence too large');
    return await handle.readFile();
  } finally { await handle.close(); }
}
export async function openEvidenceStore(root, manifestSHA256) {
  assert(HASH.test(manifestSHA256), 'A trusted manifest hash must be supplied out of band');
  const raw = await readContained(root, 'manifest.json');
  assert.equal(sha256(raw), manifestSHA256, 'Manifest hash mismatch');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.schemaVersion, 'review-evidence-manifest-1');
  validBinding(manifest);
  assert(Array.isArray(manifest.entries));
  const entries = new Map(), paths = new Set(), bytes = new Map();
  for (const entry of manifest.entries) {
    assert(isId(entry.id) && !entries.has(entry.id), 'Duplicate/invalid evidence id');
    assert(isId(entry.sourceId), 'Invalid source id');
    assert(['manuscript', 'source-report', 'conclusion', 'evidence'].includes(entry.kind), 'Unknown evidence kind');
    assert(HASH.test(entry.sha256), 'Evidence SHA256 required');
    binding(entry, manifest);
    assert(!paths.has(entry.path), 'Duplicate evidence path'); paths.add(entry.path);
    assert(['.json', '.txt', '.md'].includes(path.extname(entry.path)), 'Text evidence only');
    entries.set(entry.id, entry);
    const data = await readContained(root, entry.path);
    assert.equal(sha256(data), entry.sha256, `Evidence hash mismatch: ${entry.id}`);
    bytes.set(entry.id, data);
  }
  function get(id, sourceId, kind) {
    assert(isId(id) && entries.has(id), 'Evidence id is not allowlisted');
    const entry = entries.get(id);
    if (sourceId !== undefined) assert.equal(entry.sourceId, sourceId, 'Evidence source mismatch');
    if (kind !== undefined) assert.equal(entry.kind, kind, 'Evidence kind mismatch');
    return {entry: structuredClone(entry), bytes: Buffer.from(bytes.get(id))};
  }
  function ref(id, sourceId) {
    const {entry} = get(id, sourceId);
    return {id, sourceId: entry.sourceId, sha256: entry.sha256, url: `/evidence/${id}/${entry.sha256}`, label: entry.label ?? id};
  }
  for (const [field, hash] of [['baselineId', manifest.baselineSHA256], ['candidateId', manifest.candidateSHA256]]) {
    const {entry} = get(manifest[field], 'manuscript', 'manuscript');
    assert.equal(entry.sha256, hash, 'Manuscript hash mismatch');
  }
  return {manifest: structuredClone(manifest), manifestSHA256, get, ref};
}
