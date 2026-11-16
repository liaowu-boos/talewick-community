import assert from 'node:assert/strict';
import test from 'node:test';
import {diffVersionText} from './version-text-diff.ts';

function check(before: string, after: string) {
  const parts = diffVersionText(before, after);
  assert.equal(parts.filter(p => p.kind !== 'insert').map(p => p.text).join(''), before);
  assert.equal(parts.filter(p => p.kind !== 'delete').map(p => p.text).join(''), after);
  for (const [i, p] of parts.entries()) {
    assert.ok(p.text.length);
    assert.notEqual(parts[i - 1]?.kind, p.kind);
  }
  return parts;
}

test('separate Chinese edits leave the passage between them unchanged', () => {
  const middle = '风从门里钻出来。'.repeat(80);
  const parts = check('晴。' + middle + '冷。', '阴。' + middle + '暖。');
  assert.deepEqual(parts.filter(p => p.kind !== 'equal').map(p => p.text), ['晴', '阴', '冷', '暖']);
  assert.ok(parts.some(p => p.kind === 'equal' && p.text.includes(middle)));
});

test('punctuation, repeated lines and original line endings survive a round trip', () => {
  check('等？\r\n\r\n等？\n再等。\n', '等。\r\n\r\n先等？\n再等。');
  check('', '');
  check('原段', '');
  check('', '新段');
  check('同文', '同文');
});

test('a joined emoji, accent or supplementary character stays whole', () => {
  for (const [before, after] of [['👩🏽‍🚀', '👩🏻‍🚀'], ['e\u0301', 'e'], ['𠀀', '𠀁']]) {
    const parts = check('左' + before + '右', '左' + after + '右');
    assert.deepEqual(parts.filter(p => p.kind !== 'equal').map(p => p.text), [before, after]);
  }
});

test('large replacements on both sides retain unchanged paragraphs', () => {
  const anchor = '\r\n不变的整段。\r\n';
  const parts = check('甲'.repeat(8000) + anchor + '乙'.repeat(9000), '丙'.repeat(8500) + anchor + '丁'.repeat(9100));
  assert.ok(parts.some(p => p.kind === 'equal' && p.text.includes('不变的整段。')));
});

test('repeated characters, ambiguous alignments and blank lines round-trip in both directions', () => {
  let seed = 121;
  const alphabet = ['a', 'b', '，', '\n', '\r\n', '🌕'];
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const sample = () => Array.from({length: next() % 90}, () => alphabet[next() % alphabet.length]).join('');
  for (let i = 0; i < 350; i++) {
    const a = sample(), b = sample();
    check(a, b);
    check(b, a);
  }
});
