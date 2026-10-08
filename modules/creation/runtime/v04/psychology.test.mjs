import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePsychology, normalizeReadingObservations } from './psychology.mjs';
const chapters = [{ id: 'a', body: '她把钥匙留在桌上，门没有关。' }, { id: 'b', body: '她回来取走钥匙，轻轻合上门。' }];
const observation = { observation: '结尾的合门回应前面的犹豫，但变化依据还需要核对', category: 'emotion',
  suspectedCause: '中间的认知变化可能不足', evidence: [{ chapterId: 'a', quote: '门没有关' }, { chapterId: 'b', quote: '轻轻合上门' }],
  revisionScope: { chapterIds: ['a', 'b'], action: '核对认知变化', reason: '保持前后回应成立', preserve: ['留钥匙与合门的克制表达'] } };

test('cross-scene diagnosis binds literal evidence but remains an unresolved hypothesis without revision authority', () => {
  const before = structuredClone(chapters);
  const [result] = normalizeReadingObservations([observation], chapters);
  assert.equal(result.crossScene, true);
  assert.equal(result.evidenceVerified, true);
  assert.equal(result.status, 'proposed');
  assert.equal(result.interpretationStatus, 'model_hypothesis');
  assert.equal(result.automaticRevisionAuthorized, false);
  assert.equal(result.unresolved, true);
  assert.deepEqual(result.revisionScope.preserve, observation.revisionScope.preserve);
  assert.deepEqual(chapters, before);
});

test('unsupported quotes, absent evidence, or out-of-scope chapter IDs remain explicit gaps', () => {
  for (const item of [
    { ...observation, evidence: [{ chapterId: 'a', quote: '不存在的句子' }] },
    { ...observation, evidence: [] },
    { ...observation, revisionScope: { ...observation.revisionScope, chapterIds: ['unknown'] } },
  ]) {
    const [result] = normalizeReadingObservations([item], chapters);
    assert.equal(result.status, 'needs_evidence');
    assert.equal(result.automaticRevisionAuthorized, false);
  }
  assert.deepEqual(normalizeReadingObservations([], chapters), []);
  assert.throws(() => normalizeReadingObservations(undefined, chapters), /readingObservations/);
});

test('psychology planning requires experience/cognition/action/expression and binds chapter order', () => {
  const input = { characterArcs: [{ character: '她', experience: '失去信任', belief: '决定由自己承担', desire: '独立', fear: '再次失去', change: '犹豫到行动', expression: '钥匙和门' }],
    emotionalScenes: chapters.map(() => ({ experience: '回到门前', cognition: '愿意承担', action: '取走钥匙', expression: '合门', development: '展开动作，省略重复解释', echo: '回应第一次离开' })),
    materialDecisions: [], psychologyLimitations: ['正文是否落实待核对'] };
  const plan = normalizePsychology(input, chapters);
  assert.deepEqual(plan.emotionalScenes.map(scene => scene.chapterId), ['a', 'b']);
  assert.equal(plan.creationPolicyVersion, 'v04-creation-1');
  assert.throws(() => normalizePsychology({ ...input, emotionalScenes: [] }, chapters), /逐章/);
  assert.throws(() => normalizePsychology({ ...input, characterArcs: [{}] }, chapters), error => error.code === 'PLANNING_REQUIRED_FIELDS' && error.details.some(item => item.path === 'characterArcs[0].experience'));
});
