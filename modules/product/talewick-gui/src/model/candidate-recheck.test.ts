import test from 'node:test';
import assert from 'node:assert/strict';
import { CANDIDATE_RECHECK_VERSION, canOfferCandidateSelection, type CandidateRecheckTask } from './candidate-recheck.ts';

const task: CandidateRecheckTask = {
  id: 'check-1', projectId: 'project-1', sourceTaskId: 'source-1', candidateSha256: 'a'.repeat(64),
  checkerVersion: CANDIDATE_RECHECK_VERSION, createdAt: '', updatedAt: '', stage: 'complete',
  status: 'reviewed_no_reported_conflict', gate: { eligible: true, reason: 'replay_required_on_selection' },
  report: null, error: null,
};

test('candidate selection control is hidden for stale checker, source, project or doubtful fact result', () => {
  assert.equal(canOfferCandidateSelection(task, 'project-1', 'source-1'), true);
  assert.equal(canOfferCandidateSelection(task, 'other-project', 'source-1'), false);
  assert.equal(canOfferCandidateSelection(task, 'project-1', 'other-source'), false);
  for (const wrong of [
    { checkerVersion: 'old-checker' }, { status: 'needs_attention' as const }, { status: 'failed' as const },
    { candidateSha256: 'bad' }, { gate: { eligible: false, reason: 'stale_candidate' } },
  ]) assert.equal(canOfferCandidateSelection({ ...task, ...wrong }, 'project-1', 'source-1'), false);
});
