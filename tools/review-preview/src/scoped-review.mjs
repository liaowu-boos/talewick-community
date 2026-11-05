import assert from 'node:assert/strict';
import {sha256} from './evidence-store.mjs';

// Consumes frozen, trusted evidence-store entries; never modifies a response.
export function scopedReaders({manifest, get, ref, manuscripts, planned}) {
  const json = id => JSON.parse(get(id).bytes);
  const execution = manifest.executionId ? json(manifest.executionId) : null;
  if (execution) {
    assert.equal(execution.schemaVersion, 'continuous-review-execution-inspection-1');
    assert.equal(execution.fullManuscriptAccepted, false);
    if (execution.valid === true) assert.deepEqual(execution.errors, []);
  }
  const permitted = ['A', 'B', 'no_clear_preference', 'tradeoff'];
  return (manifest.readers ?? []).map((item, i) => {
    assert.equal(item.id, `reader-${i + 1}`);
    assert.equal(item.id, planned[i].readerId);
    assert.deepEqual(item.order, planned[i].order);
    const row = {
      id: item.id, label: `读者 ${i + 1}`, order: item.order.join(' → '),
      state: 'unknown', statusLabel: '返回未知',
      reason: '截至本次冻结快照，尚未导入该路原回包。',
      rawPreference: null, effectivePreference: null,
      assessment: null, counterReading: null, scopeLimit: null,
      rawText: null, inspection: null, references: [],
    };
    if (!item.rawId) return row;

    const raw = get(item.rawId);
    assert.equal(sha256(raw.bytes), raw.entry.sha256);
    row.rawText = raw.bytes.toString();
    row.references.push(ref(item.rawId));
    let record;
    try { record = JSON.parse(raw.bytes); } catch { /* Preserve malformed originals. */ }
    if (permitted.includes(record?.overall?.preference)) row.rawPreference = record.overall.preference;
    for (const [target, value] of [
      ['assessment', record?.overall?.assessment],
      ['counterReading', record?.counterReading?.assessment],
      ['scopeLimit', record?.scopeLimit],
    ]) if (typeof value === 'string') row[target] = value;
    row.statusLabel = '原回包已保存，校验结果未知';
    row.reason = '已有原件，尚无可确认的完整证据契约结果。';

    const receipt = item.receiptId ? json(item.receiptId) : null;
    if (receipt) {
      assert(typeof receipt.contextId === 'string' && receipt.contextId.trim());
      assert(typeof receipt.invocationId === 'string' && receipt.invocationId.trim());
      row.references.push(ref(item.receiptId));
    }
    let bound = null;
    if (execution?.valid === true && receipt) {
      const matches = execution.records.filter(value => value.readerId === item.id);
      assert.equal(matches.length, 1);
      [bound] = matches;
      assert.equal(bound.rawSHA256, raw.entry.sha256);
      assert.equal(bound.messagesSHA256, planned[i].messagesSHA256);
      assert.equal(bound.contextId, receipt.contextId);
      assert.equal(bound.invocationId, receipt.invocationId);
      row.references.push(ref(manifest.executionId));
    }
    if (!item.inspectionId) return row;

    const check = json(item.inspectionId);
    assert.equal(check.schemaVersion, 'continuous-review-reading-inspection-1');
    assert.equal(check.protocolVersion, 'continuous-review-1');
    assert.equal(check.rawSHA256, raw.entry.sha256);
    assert.equal(check.rawByteLength, raw.bytes.length);
    assert.equal(check.manuscriptsSHA256, sha256(JSON.stringify(manuscripts)));
    assert.equal(check.fullManuscriptAccepted, false);
    assert.equal(check.factJudgment, 'requires_human_review');
    assert.equal(check.literaryJudgment, 'requires_human_review');
    let exact = 0;
    for (const reference of check.references) {
      if (!reference.exactUnique) continue;
      const body = manuscripts[reference.version].find(chapter => chapter.id === reference.chapterId).body;
      assert.equal(body.slice(reference.start, reference.end), reference.quote);
      assert.equal(body.indexOf(reference.quote), reference.start);
      assert.equal(body.indexOf(reference.quote, reference.start + 1), -1);
      exact++;
    }
    const units = check.changeCoverage?.units ?? [];
    for (const unit of units) {
      const body = manuscripts[unit.version].find(chapter => chapter.id === unit.chapterId).body;
      assert.equal(sha256(body.slice(unit.start, unit.end)), unit.paragraphSHA256);
    }
    row.references.push(ref(item.inspectionId));
    row.inspection = {
      schemaValid: check.schemaValid, citationsExact: check.citationsExact,
      evidenceContractValid: check.evidenceContractValid, valid: check.valid,
      errors: check.errors, exact, total: check.references.length,
      changedUnits: units.length, uncovered: check.changeCoverage?.uncoveredUnitCount ?? null,
      warnings: check.factualWarnings ?? [],
    };
    if (check.valid === false) {
      assert.equal(check.preference, null);
      row.state = 'returned_invalid';
      row.statusLabel = check.citationsExact === false ? '原回包已保存，引用校验失败'
        : check.schemaValid === false ? '原回包已保存，格式校验失败' : '原回包已保存，证据契约失败';
      row.reason = '原始意见与自报偏好保留。该回包没有核验有效的偏好。';
    } else if (check.valid === true) {
      for (const field of ['schemaValid', 'citationsExact', 'evidenceContractValid']) assert.equal(check[field], true);
      assert.deepEqual(check.errors, []);
      assert.equal(exact, check.references.length);
      assert(permitted.includes(check.preference));
      assert.equal(check.preference, row.rawPreference);
      if (bound) {
        row.state = 'validated';
        row.statusLabel = '原回包已保存，证据契约核验通过';
        row.reason = '偏好仅为本次限定范围的阅读意见，事实与文学判断另行复核。';
        row.effectivePreference = check.preference;
      }
    }
    return row;
  });
}
