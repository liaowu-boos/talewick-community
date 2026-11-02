// Synthetic protocol fixture. No provider, real manuscript or literary verdict.
import { fixture } from '../../../../creation/runtime/goal-opportunity-fixtures.mjs';
import { runWholeManuscriptQualityRevision } from '../../../../creation/runtime/whole-manuscript-quality.mjs';
import { followupRequest } from './followup-request.mjs';
import { validateRequest } from '../tasks.mjs';
import { productManuscriptRevision } from '../full15-service.mjs';

const dimensions = ['identity_relationship','speaker_actor','intent_completion','transfer_direction','event_round'];
const dependencies = ['actor_presence','speaker_action','action_chain','object_transfer','payment_round','question_answer'];
const ev = (version, chapterId, quote) => ({ version, chapterId, quote, start:null });

export function followupEvidenceFixture({ blockedPlan = false, sceneStatus = 'intact', preserve = false, requestId = 'evidence-fixture' } = {}) {
  const f = fixture({ enabled:false, preserve });
  const body = followupRequest({ requestId });
  const request = validateRequest({ ...body, ...f.request, revisionEvidencePolicy:body.revisionEvidencePolicy,
    writingGoals:body.writingGoals, baseRevision:productManuscriptRevision(f.request.projectTitle,f.chapters) });
  const calls = [];
  const model = { complete: async args => {
    calls.push(args.stage);
    const input = JSON.parse(args.user);
    if (args.stage.endsWith(':format-repair')) return f.model.complete(args);
    if (args.stage.startsWith('whole-quality:plan-facts:')) {
      const assessments = input.assertions.map(item => ({ assertionId:item.id, JSONPointer:item.JSONPointer, textSha256:item.textSha256,
        coverage:'proposal_only', reason:'离线协议控制；不代表实际语义判断。',
        premiseChecks:Object.fromEntries(dimensions.map(key => [key,{disposition:'none',factIds:[],reason:'本控制没有该事实前提。'}])),facts:[] }));
      if (blockedPlan) {
        const row = assessments.find(item => item.JSONPointer === '/summary');
        row.coverage = 'decomposed';
        row.premiseChecks.event_round = { disposition:'identified',factIds:['F1'],reason:'方案声称的行动需要原文核对。' };
        row.facts = [{ id:'F1',claimQuote:'她一直解释。',claimStart:null,dimensions:['event_round'],status:'contradicted',
          attribution:'narrated_fact',support:[],counter:[ev('source',f.chapters[0].id,f.protectedQuote)],reason:'原文保留了没有继续解释的动作。' }];
      }
      return JSON.stringify({ ...input.responseBindings,checkedChapterIds:input.sourceChapters.map(ch => ch.id),assessments });
    }
    if (args.stage === 'whole-quality:plan-correction')
      return JSON.stringify({ ...input.revisionEvidenceCorrection.initialPlan,...input.responseBindings });
    if (args.stage === 'whole-quality:scene-check') {
      if ('plan' in input || 'reread' in input) throw Error('Independent scene input contaminated');
      return JSON.stringify({ ...input.responseBindings,checkedChapterIds:input.sourceChapters.map(ch => ch.id),
        groups:input.changeGroups.map(group => ({ groupId:group.groupId,assessment:sceneStatus,reason:'离线场景门禁控制，不作为质量结论。',
          checks:Object.fromEntries(dependencies.map(key => [key,{status:sceneStatus,reason:'固定协议测试状态。',
            sourceEvidence:[ev('source',f.chapters[0].id,f.targetQuote)],candidateEvidence:[ev('candidate',f.chapters[0].id,f.replacement)],
            counterEvidence:sceneStatus === 'broken' ? [ev('candidate',f.chapters[0].id,f.replacement)] : [] }])) })) });
    }
    const raw = await f.model.complete(args);
    if (blockedPlan && args.stage === 'whole-quality:plan') return JSON.stringify({ ...JSON.parse(raw),summary:'她一直解释。' });
    return raw;
  } };
  const workflow = args => runWholeManuscriptQualityRevision({ ...f.options, ...args });
  return { request, model, calls, artifacts:f.artifacts, workflow,
    run:() => workflow({ request,model,checkpoint:f.options.checkpoint }) };
}
