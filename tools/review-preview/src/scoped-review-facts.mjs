import assert from 'node:assert/strict';
import {sha256} from './evidence-store.mjs';

// Text identity is computed from frozen bodies, never inferred from review prose.
export function compareFrozenBodies(manuscripts) {
  assert(Array.isArray(manuscripts.A) && manuscripts.A.length > 0);
  assert(Array.isArray(manuscripts.B));
  assert.deepEqual(manuscripts.A.map(c => c.id), manuscripts.B.map(c => c.id));
  assert.equal(new Set(manuscripts.A.map(c => c.id)).size, manuscripts.A.length);
  const chapters = manuscripts.A.map((a, i) => {
    const b = manuscripts.B[i];
    assert(typeof a.id === 'string' && typeof a.body === 'string' && typeof b.body === 'string');
    return {chapterId: a.id, bodiesEqual: a.body === b.body,
      ABodySHA256: sha256(a.body), BBodySHA256: sha256(b.body)};
  });
  return {scope: 'provided_chapters_only', manuscriptsSHA256: sha256(JSON.stringify(manuscripts)),
    allBodiesEqual: chapters.every(c => c.bodiesEqual), chapters,
    limitation: '仅比对所提供章节正文；不判断主张语义、标题、文学质量或全稿。'};
}

function originalClaim(record, pointer) {
  assert(typeof pointer === 'string' && pointer.startsWith('/') && !/~(?![01])/u.test(pointer));
  let value = record;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    assert(value !== null && typeof value === 'object' && Object.hasOwn(value, key));
    value = value[key];
  }
  assert(typeof value === 'string' && value.trim());
  return value;
}

// Optional annotations come from an explicit frozen semantic review, not keywords.
export function semanticReviewView({report, rawSHA256, record, textComparison}) {
  if (!report) return {status: 'pending', statusLabel: '语义复核未完成',
    summary: '未导入绑定的语义复核；机器引用合格或无措辞警告均不代表事实正确。', identityClaims: []};
  assert.equal(report.schemaVersion, 'scoped-semantic-review-1');
  assert.equal(report.rawSHA256, rawSHA256);
  assert.equal(report.manuscriptsSHA256, textComparison.manuscriptsSHA256);
  assert(['pending', 'failed', 'reviewed'].includes(report.status));
  assert(typeof report.summary === 'string' && report.summary.trim());
  assert(Array.isArray(report.identityClaims));
  const seen = new Set();
  const identityClaims = report.identityClaims.map(claim => {
    assert.equal(claim.assertion, 'bodies_equal');
    assert(!seen.has(claim.path)); seen.add(claim.path);
    const text = originalClaim(record, claim.path);
    assert.equal(claim.text, text);
    let equal;
    if (claim.scope === 'all_provided_chapters') {
      assert.equal(claim.chapterId, undefined);
      equal = textComparison.allBodiesEqual;
    } else {
      assert.equal(claim.scope, 'chapter');
      const chapter = textComparison.chapters.find(c => c.chapterId === claim.chapterId);
      assert(chapter); equal = chapter.bodiesEqual;
    }
    return {...claim, comparison: equal ? 'matches_frozen_bodies' : 'contradicts_frozen_bodies',
      limitation: '仅检查人工标注的同文范围；不判定同一句中的其他事实或推断。'};
  });
  if (report.status === 'reviewed') assert(!identityClaims.some(c => c.comparison === 'contradicts_frozen_bodies'));
  const labels = {pending: '语义复核未完成', failed: '语义复核未通过', reviewed: '已完成声明范围内的语义复核'};
  return {status: report.status, statusLabel: labels[report.status], summary: report.summary, identityClaims};
}
