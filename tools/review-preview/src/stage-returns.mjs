import assert from 'node:assert/strict';
import { sha256 } from './evidence-store.mjs';

const labels = {
  sealed: '阶段已封存', returned_invalid: '原回包已保存，校验失败',
  unknown: '返回未知', not_dispatched: '未派发',
};
const citationErrors = new Set(['PARAGRAPH_REFERENCE_UNKNOWN', 'PARAGRAPH_REFERENCE_FIELDS', 'PARAGRAPH_REFERENCE_SCOPE', 'QUOTE_NOT_IN_ANCHOR', 'QUOTE_AMBIGUOUS_WITHIN_ANCHOR', 'QUOTE_LOCATION', 'QUOTE_NOT_FOUND', 'QUOTE_POSITION_FAILED', 'QUOTE_POSITION_NOT_UNIQUE', 'QUOTE_BLIND_ID']);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const preference = record => typeof record?.preference === 'string' && record.preference.trim() ? record.preference : null;

// FULL15 classifies the events. The preview binds its snapshot and the optional
// preference artifacts; it never infers delivery from an overall task status.
export function stageReturns(store, source) {
  const spec = source.stageDiagnostics;
  if (!spec?.diagnosticId || !spec?.journalId || !spec?.requestHash || !spec?.taskMetadataSHA256) return [];
  const get = id => store.get(id, source.id, 'evidence');
  const link = id => store.ref(id, source.id);
  const diagnosis = JSON.parse(get(spec.diagnosticId).bytes);
  const journal = get(spec.journalId);
  assert.equal(diagnosis.schemaVersion, 'independent-review-stage-diagnostics-1');
  assert.match(spec.taskMetadataSHA256,/^[a-f0-9]{64}$/);
  assert.equal(diagnosis.taskMetadataSHA256,spec.taskMetadataSHA256,'Diagnostic task metadata mismatch');
  assert.equal(diagnosis.requestHash, spec.requestHash, 'Diagnostic request mismatch');
  assert.equal(diagnosis.eventsSHA256, journal.entry.sha256, 'Diagnostic journal mismatch');
  const events = journal.bytes.toString().trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0]?.type, 'created');
  assert.equal(events[0].requestHash, spec.requestHash, 'Journal request mismatch');
  assert(Array.isArray(diagnosis.stages));
  const attachments = new Map();
  for (const item of spec.attachments ?? []) {
    const key = JSON.stringify([item.stageId,item.attemptId]);
    assert(!attachments.has(key),'Duplicate attempt attachment');
    attachments.set(key,item);
  }
  assert.equal(events[0].totalStages,diagnosis.stages.length,'Diagnostic stage plan mismatch');
  const rows = [];
  for (const stage of diagnosis.stages) {
    assert(Array.isArray(stage.attempts));
    if (stage.attempts.length > 1) {
      const state = Object.hasOwn(labels,stage.state) ? stage.state : 'unknown';
      rows.push({id:JSON.stringify([stage.stageId,'summary']),label:`${stage.stageId}（阶段汇总）`,
        state,statusLabel:labels[state],reason:null,rawPreference:null,sealedPreference:null,references:[link(spec.diagnosticId)]});
    }
    for (const attempt of stage.attempts.length ? stage.attempts : [null]) {
      const key = JSON.stringify([stage.stageId,attempt?.attemptId ?? null]);
      const attachment = attachments.get(key); attachments.delete(key);
      const refs = [link(spec.diagnosticId),link(spec.journalId)];
      let state = attempt?.state ?? stage.state;
      let reason = null, rawPreference = null, sealedPreference = null;
      if (!Object.hasOwn(labels,state) || !Object.hasOwn(labels,stage.state) || (stage.attempts.length <= 1 && stage.state === 'unknown')) state = 'unknown';
      if (state === 'not_dispatched' && !['explicit_non_dispatch','no_attempt_in_snapshot'].includes(attempt?.reason ?? stage.reason)) state = 'unknown';
      if (state === 'returned_invalid' || state === 'sealed') {
        const history = events.filter(e => e.stageId === stage.stageId && e.attemptId === attempt?.attemptId);
        const returned = history.find(e => e.type === 'provider_returned' && e.inputHash === attempt.inputHash);
        if (!returned || !attachment?.rawId || !attempt?.rawResponse || attempt.providerReturnEvents !== 1 || !/^[a-f0-9]{64}$/.test(attempt.inputHash ?? '')) state = 'unknown';
        else {
          const raw = get(attachment.rawId);
          assert.equal(raw.entry.sha256,attempt.rawResponse.sha256,'Attempt raw digest mismatch');
          assert.equal(raw.bytes.length,attempt.rawResponse.byteLength,'Attempt raw length mismatch');
          refs.push(link(attachment.rawId));
          if (state === 'returned_invalid') {
            reason = attempt.failureCode ?? null;
            let record;
            try { record = JSON.parse(raw.bytes); } catch { /* Invalid JSON may be the original rejection. */ }
            const rejection = history.at(-1);
            if (rejection?.type !== 'stage_needs_attention' || (reason && rejection.code !== reason)) {
              state = 'unknown'; reason = null;
            } else if (returned.stage === 'blind_pair') rawPreference = preference(record);
          } else if (stage.state === 'sealed' && attachment.sealId) {
            const seal = JSON.parse(get(attachment.sealId).bytes);
            const event = events.find(e => e.type === 'stage_sealed' && e.stageId === stage.stageId && e.attemptId === attempt.attemptId);
            assert(event && seal.stageId === event.stageId && seal.attemptId === event.attemptId,'Seal attempt mismatch');
            assert.equal(seal.recordSha256,event.recordSha256,'Seal journal mismatch');
            assert.equal(sha256(JSON.stringify(canonical(seal.record))),event.recordSha256,'Seal record digest mismatch');
            refs.push(link(attachment.sealId));
            if (attachment.validationId && seal.stage === 'blind_pair') {
              const validation = get(attachment.validationId);
              const bound = seal.paragraphReferences?.files?.['validation.json'];
              if (bound) assert.equal(validation.entry.sha256,bound,'Sealed validation digest mismatch');
              const accepted = JSON.parse(validation.bytes);
              assert(accepted.ok === true && accepted.stage === seal.stage && accepted.readerId === seal.record.readerId && accepted.recordSha256 === seal.recordSha256,'Invalid preference validation');
              refs.push(link(attachment.validationId));
              sealedPreference = preference(seal.record);
            }
          }
        }
      }
      const statusLabel = state === 'returned_invalid' && citationErrors.has(reason) ? '原回包已保存，引用校验失败' : labels[state];
      rows.push({id:key,label:stage.attempts.length > 1 ? `${stage.stageId} · ${attempt.attemptId}` : stage.stageId,state,statusLabel,
        reason:reason ? `原错误码：${reason}` : state === 'not_dispatched' ?
          (attempt ? '存在明确未派发记录。' : '本次静止快照中没有该阶段的尝试。') :
          state === 'unknown' ? '现有凭据不足以确认该尝试的返回结果。' : null, rawPreference, sealedPreference, references:refs});
    }
  }
  assert.equal(attachments.size,0,'Attachment belongs to another stage or attempt');
  return rows;
}
