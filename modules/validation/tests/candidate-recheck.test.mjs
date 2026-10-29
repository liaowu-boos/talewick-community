import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDIDATE_RECHECK_VERSION,
  prepareCandidateRecheck,
  runCandidateRecheck,
  validateCandidateRecheckResult,
  checkCandidateRecheckAdoption,
  candidateRecheckStatusFor,
  candidateRecheckSelectionForStatus,
} from '../runtime/candidate-recheck.mjs';
import { CROSS_CHAPTER_STAGES } from '../runtime/cross-chapter-review.mjs';

const counterchecks = () => Object.fromEntries(['lying', 'misremembering', 'normalChange', 'differentRounds', 'intentionalOmission', 'differentEntity'].map(name => [name, {
  assessment: name === 'normalChange' ? 'supported' : 'unknown',
  rationale: name === 'normalChange' ? '维修记录支持状态变化。' : `${name} 缺乏证据。`,
  evidence: name === 'normalChange' ? [{ claimId: 'claim-3', role: 'counter' }] : [],
}]));

function sample(genre) {
  const prefix = genre === 'family' ? '照相馆关门前，' : '夜班交接前，';
  const candidateChapters = [
    { id: 'c1', title: '开始', body: `${prefix}灯亮。铃响三声。钥匙交给警员。灯亮。灯亮。` },
    { id: 'c2', title: '后来', body: `${prefix}后来灯灭。日志写同一轮铃响两声。` },
    { id: 'c3', title: '反证', body: `${prefix}维修记录说明有人先切断电源。走廊记录显示无人靠近。第二轮铃响一声。` },
  ];
  return { sourceTaskId: `${genre}-task-r01`, candidateChapters, priorFailureIds: [`${genre}-old-failure`] };
}

function modelFor(chapters) {
  const calls = [];
  return {
    calls,
    async complete(request) {
      calls.push(request.stage);
      request.onReceipt({ provider: 'fixture', invocationId: `fixture-${calls.length}` });
      if (request.stage === CROSS_CHAPTER_STAGES.extract) return JSON.stringify({
        schemaVersion: 'cross-chapter-extraction-compact-1',
        chapterCoverage: chapters.map(chapter => ({ chapterId: chapter.id, extractionNote: '已核对时点、施事、轮次和物件状态。' })),
        comparisons: [{ dimension: 'object_state', subject: '设备灯', aspect: '同轮状态', rationale: '核对状态变化。', claims: [
          { chapterId: 'c1', quote: '灯亮', occurrence: 1, value: '亮', timeScope: '开始', eventRound: '同一轮', epistemic: 'narrated_fact' },
          { chapterId: 'c2', quote: '后来灯灭', value: '灭', timeScope: '后来', eventRound: '同一轮', epistemic: 'narrated_fact' },
        ] }],
        unpaired: [{ dimension: 'actor', subject: '维修员', aspect: '断电操作',
          claim: { chapterId: 'c3', quote: '维修记录说明有人先切断电源', value: '先切断电源', timeScope: '状态变化前', eventRound: '同一轮', epistemic: 'narrated_fact' },
          reason: 'no_comparable_claim', rationale: '留作组外反证。' }],
      });
      if (request.stage === CROSS_CHAPTER_STAGES.adjudicate) return JSON.stringify({
        schemaVersion: 'cross-chapter-adjudication-compact-1', checkedChapterIds: chapters.map(chapter => chapter.id),
        findings: [{ groupId: 'group-1', status: 'resolved', summary: '维修记录解释状态变化。',
          sameEventDecision: 'same', resolutionReason: 'normal_change',
          evidence: [{ claimId: 'claim-1', role: 'support' }, { claimId: 'claim-2', role: 'counter' }], counterchecks: counterchecks() }],
      });
      throw new Error(`unexpected ${request.stage}`);
    },
  };
}

for (const genre of ['family', 'workplace']) {
  test(`${genre}: async full manuscript recheck binds source and preserves history`, async () => {
    const source = sample(genre), prepared = prepareCandidateRecheck(source), model = modelFor(source.candidateChapters);
    const checkpoints = [], artifacts = { store: {}, checkpoint: async (key) => { checkpoints.push(key); } };
    const result = await runCandidateRecheck({ prepared, model, artifacts });
    assert.deepEqual(model.calls, [CROSS_CHAPTER_STAGES.extract, CROSS_CHAPTER_STAGES.adjudicate]);
    assert.equal(result.status, 'reviewed_no_reported_conflict');
    assert.equal(result.binding.sourceTaskId, source.sourceTaskId);
    assert.equal(result.binding.checkerVersion, CANDIDATE_RECHECK_VERSION);
    assert.deepEqual(result.priorFailureIds, source.priorFailureIds);
    assert.equal(result.automaticAdoption, false);
    assert.equal(result.literaryPass, 'NOT_COMPUTED');
    assert.equal(result.readerPreference, 'NOT_RECHECKED');
    assert.equal(result.crossChapterResult.checkedChapterIds.length, 3);
    assert.ok(checkpoints.includes('candidate-recheck:request'));
    assert.ok(checkpoints.includes('candidate-recheck:result'));
    assert.equal((await validateCandidateRecheckResult({ result, prepared, artifacts })).resultSHA, result.resultSHA);
    const choice = { result, prepared, artifacts, sourceTaskId: source.sourceTaskId,
      candidateChapters: source.candidateChapters, checkerVersion: CANDIDATE_RECHECK_VERSION };
    assert.deepEqual(await checkCandidateRecheckAdoption(choice), { eligible: true, reason: 'explicit_selection_available' });
    assert.deepEqual(await checkCandidateRecheckAdoption({ ...choice, sourceTaskId: 'other-task' }), { eligible: false, reason: 'wrong_task' });
    assert.deepEqual(await checkCandidateRecheckAdoption({ ...choice, checkerVersion: 'old-version' }), { eligible: false, reason: 'checker_version_mismatch' });
    const stale = source.candidateChapters.map((chapter, index) => index ? chapter : { ...chapter, body: `${chapter.body}后来又改。` });
    assert.deepEqual(await checkCandidateRecheckAdoption({ ...choice, candidateChapters: stale }), { eligible: false, reason: 'stale_candidate' });
    assert.deepEqual(await checkCandidateRecheckAdoption({ ...choice, result: { ...result, resultSHA: '0'.repeat(64) } }), { eligible: false, reason: 'invalid_result' });
    const replayModel = { async complete() { throw new Error('replay must not call provider'); } };
    await runCandidateRecheck({ prepared, model: replayModel, artifacts });
  });
}

test('conflict and doubt cannot yield selection', () => {
  assert.equal(candidateRecheckStatusFor({ findings: [{ status: 'confirmed_conflict' }], comparisonGroups: [{}] }), 'failed');
  assert.equal(candidateRecheckStatusFor({ findings: [{ status: 'ambiguous' }], comparisonGroups: [{}] }), 'needs_attention');
  assert.deepEqual(candidateRecheckSelectionForStatus('failed'), { eligible: false, reason: 'fact_conflict' });
  assert.deepEqual(candidateRecheckSelectionForStatus('needs_attention'), { eligible: false, reason: 'fact_doubt' });
});

test('uncertain dispatch is not silently sent a second time', async () => {
  const source = sample('workplace'), prepared = prepareCandidateRecheck(source);
  const store = {};
  let calls = 0;
  const artifacts = { store, async checkpoint(key) {
    if (key.endsWith(':completed')) throw new Error('storage interrupted after provider return');
  } };
  await assert.rejects(() => runCandidateRecheck({ prepared, artifacts, model: {
    async complete() { calls += 1; return '{}'; },
  } }), /storage interrupted/);
  assert.equal(calls, 1);
  await assert.rejects(() => runCandidateRecheck({ prepared, artifacts, model: {
    async complete() { calls += 1; return '{}'; },
  } }), { code: 'PROVIDER_OUTCOME_UNKNOWN' });
  assert.equal(calls, 1);
});

test('read-only validation rejects a missing seal without rebuilding caller checkpoints', async () => {
  const source = sample('family'), prepared = prepareCandidateRecheck(source);
  let checkpointCalls = 0;
  const artifacts = { store: {}, async checkpoint() { checkpointCalls += 1; } };
  const result = await runCandidateRecheck({ prepared, model: modelFor(source.candidateChapters), artifacts });
  delete artifacts.store[`${CROSS_CHAPTER_STAGES.adjudicate}:result`];
  const before = structuredClone(artifacts.store), beforeCalls = checkpointCalls;
  await assert.rejects(() => validateCandidateRecheckResult({ result, prepared, artifacts }),
    { code: 'RECHECK_CHECKPOINT_INCOMPLETE' });
  assert.deepEqual(artifacts.store, before);
  assert.equal(checkpointCalls, beforeCalls);
  assert.equal(Object.hasOwn(artifacts.store, `${CROSS_CHAPTER_STAGES.adjudicate}:result`), false);
});
