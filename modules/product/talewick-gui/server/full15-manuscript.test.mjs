import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { manuscriptText } from './full15-service.mjs';

const sourceMapPath = fileURLToPath(new URL('../../../creation/novel-review/source_map.py', import.meta.url));
const python = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('full15_source_map', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
text = sys.stdin.read()
mapped = module.build_source_map(text, 'product-regression', 'fixture')
body = ''.join(text[item['start_char']:item['end_char']] for item in mapped['body_ranges'])
print(json.dumps({
  'body': body,
  'body_han_count': mapped['body_han_count'],
  'explicit_chapter_count': mapped['explicit_chapter_count'],
  'issues': mapped['chapter_boundary_issues'],
  'numbers': [item['number'] for item in mapped['chapters']],
}, ensure_ascii=False))
`;

const compact = value => value.replace(/\s/gu, '');
const hanCount = value => [...value].filter(character => character === '〇' || /\p{Unified_Ideograph}/u.test(character)).length;

// Synthetic regression manuscripts cover numbered headings without private story fixtures.
for (const style of ['arabic', 'chinese']) {
  test(`${style} headings preserve the GUI body and ten explicit chapters`, () => {
    const numerals = ['一','二','三','四','五','六','七','八','九','十'];
    const fixture = { title: '合成章号回归', chapters: numerals.map((number, index) => ({
      id: `ch-${index + 1}`,
      title: `第${style === 'arabic' ? index + 1 : number}章：标题`,
      body: `记录 ${index + 1}：甲把钥匙放在桌上。\n乙关好门。`,
    })) };
    const expectedHan = 140;
    const text = manuscriptText(fixture.title, fixture.chapters);
    assert.ok(text.startsWith(`书名：${fixture.title}\n\n`));
    assert.equal((text.match(/^第\d+章(?:：.*)?$/gmu) || []).length, 10);
    assert.doesNotMatch(text, /^第\d+章：第\s*[0-9０-９零〇一二两三四五六七八九十百千]+\s*章/gmu);

    let cursor = 0;
    for (const chapter of fixture.chapters) {
      const start = text.indexOf(chapter.body, cursor);
      assert.ok(start >= cursor, `body for ${chapter.id} is present in GUI order`);
      assert.equal(text.slice(start, start + chapter.body.length), chapter.body);
      cursor = start + chapter.body.length;
    }

    const mapped = JSON.parse(execFileSync('python3', ['-B', '-c', python, sourceMapPath], {
      input: text,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }));
    const guiBody = fixture.chapters.map(chapter => chapter.body).join('');
    assert.equal(mapped.explicit_chapter_count, 10);
    assert.deepEqual(mapped.numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(mapped.issues, []);
    assert.equal(mapped.body_han_count, expectedHan);
    assert.equal(hanCount(guiBody), expectedHan);
    assert.equal(compact(mapped.body), compact(guiBody));
  });
}

test('serialization adds one stable number to plain and already-numbered chapter titles', () => {
  const text = manuscriptText('测试书', [
    { id: 'one', title: '归位', body: '第一段。' },
    { id: 'two', title: '第二章 已有章号', body: '第二段。' },
    { id: 'three', title: '第3章：现有冒号', body: '第三段。' },
  ]);
  assert.equal(text, '书名：测试书\n\n第1章：归位\n第一段。\n\n第2章：已有章号\n第二段。\n\n第3章：现有冒号\n第三段。\n');
});
