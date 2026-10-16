import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinalTextMaterialEvidence } from './final-text-material-evidence.mjs';

const sha = 'a'.repeat(64), sourceSha = 'b'.repeat(64);
const chapters = [{ id: 'ch-1', title: '渡口', body: '阿澄把最后一只救生圈留在船上，自己沿堤岸往回走。' }];
const decisions = [{ materialId: 'm-1', decision: 'adopt', sourceMaterialSha256: sha,
  mechanism: '先让选择改变资源分配，再写人物对代价的理解', target: { chapterNumber: 1, sceneNumber: 2 },
  status: 'author_declared_not_text_verified' }, { materialId: 'm-2', decision: 'decline' }];
const claim = { materialId: 'm-1', sourceMaterialSha256: sha,
  sourceBindings: [{ sourceId: 'source-1', sourceSha256: sourceSha, textVersion: 'text-v3', lineStart: 8, lineEnd: 9 }],
  manuscriptEvidence: [{ chapterId: 'ch-1', start: chapters[0].body.indexOf('把最后一只救生圈留在船上'),
    quote: '把最后一只救生圈留在船上', purpose: '定位资源选择进入最终正文' }],
  limitations: ['逐字落点存在，是否形成预期读者效果仍须独立评阅。'] };

test('final text evidence binds DATA identity, author declaration, body hash and exact UTF-16 quote', () => {
  const bundle = buildFinalTextMaterialEvidence({ chapters, materialDecisions: decisions, claims: [claim] });
  assert.equal(bundle.items.length, 1);
  assert.equal(bundle.items[0].authorDeclaration.mechanism, decisions[0].mechanism);
  assert.equal(bundle.items[0].verificationStatus, 'literal_text_located_not_literary_effect_verified');
  assert.match(bundle.items[0].manuscriptEvidence[0].bodySha256, /^[a-f0-9]{64}$/);
  assert.match(bundle.evidenceBundleSha256, /^[a-f0-9]{64}$/);
  assert.match(bundle.boundary, /不证明/);
});

test('author declaration alone, a wrong source hash, or a shifted quote cannot become final evidence', () => {
  assert.throws(() => buildFinalTextMaterialEvidence({ chapters, materialDecisions: decisions, claims: [] }), /每份采用材料/);
  assert.throws(() => buildFinalTextMaterialEvidence({ chapters, materialDecisions: decisions,
    claims: [{ ...claim, sourceMaterialSha256: sourceSha }] }), /来源哈希不一致/);
  assert.throws(() => buildFinalTextMaterialEvidence({ chapters, materialDecisions: decisions,
    claims: [{ ...claim, manuscriptEvidence: [{ ...claim.manuscriptEvidence[0], start: 0 }] }] }), /UTF-16位置不符/);
  assert.throws(() => buildFinalTextMaterialEvidence({ chapters, materialDecisions: decisions,
    claims: [{ ...claim, materialId: 'm-2' }] }), /采用声明/);
});
