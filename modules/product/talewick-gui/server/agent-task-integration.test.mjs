import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from './index.mjs';
import {validateRequest, CREATE_STATE_REVIEW_MODE, PLANNING_FOLLOWUP_DECISION_MODE} from './tasks.mjs';
import {configFor, makeAgentModels, originalBodies, revisedBody, requestFor, until} from '../scripts/agent-runtime-smoke.mjs';

// Exercise the real service, task persistence, workflow and SDK with synthetic
// providers. No HTTP listener is opened; transport has its own regression suite.
for (const [name, options, changes] of [
  ['keeps the draft after a no-change decision', {reviewDecision:'finish'}, false],
  ['revises confirmed evidence and rereads the candidate', {reviewDecision:'revise'}, true],
  ['refuses revision of a rejected issue', {reviewDecision:'revise', adjudicationDecision:'reject'}, false],
  ['refuses revision of an uncertain issue', {reviewDecision:'revise', adjudicationDecision:'uncertain'}, false],
]) test(`current Agent task ${name}`, async t => {
  const runsDir = await mkdtemp(join(tmpdir(), 'talewick-current-agent-task-'));
  const models = makeAgentModels(options);
  const runtime = await createRuntime({config:configFor(runsDir), model:models.model,
    agentModel:models.agentModel, full15Adapter:null});
  t.after(async () => {await runtime.close(); await rm(runsDir, {recursive:true, force:true});});
  const submitted = await runtime.tasks.create(validateRequest(requestFor()));
  const task = await until(() => {
    const current = runtime.tasks.get(submitted.id);
    assert.ok(['queued','running','completed'].includes(current.status), current.error);
    return current.status === 'completed' && !runtime.tasks.busy ? current : false;
  }, 'Current Agent task did not finish');
  assert.deepEqual(task.result.chapters.map(chapter => chapter.body), changes ? [originalBodies[0], revisedBody] : originalBodies);
  assert.equal(task.result.reviewAdjudicationBinding.status, 'bound');
  assert.equal(task.result.review.continuityChain.schemaVersion, 'continuity-chain-review-3');
  assert.equal(task.result.qualityCheckStatus, undefined);
  assert.ok(models.stageCalls.some(call => call.stage === 'continuity-chain-review'));
  const artifacts = JSON.parse(await readFile(join(runsDir, task.id, 'artifacts.json'), 'utf8'));
  assert.equal(artifacts.requestSpec.createStateReviewMode, CREATE_STATE_REVIEW_MODE);
  assert.equal(artifacts.requestSpec.planningFollowupDecisionMode, PLANNING_FOLLOWUP_DECISION_MODE);
  if (changes) assert.ok(models.stageCalls.some(call => call.stage === 'agent:reviewManuscript'));
  else assert.equal(models.stageCalls.some(call => call.stage.startsWith('agent:reviseChapter:')), false);
});
