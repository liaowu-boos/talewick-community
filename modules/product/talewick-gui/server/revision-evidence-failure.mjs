import { isDeepStrictEqual } from 'node:util';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const dimensions = ['identity_relationship','speaker_actor','intent_completion','transfer_direction','event_round'];
function atPointer(value, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw Error('invalid assertion pointer');
  return pointer.slice(1).split('/').map(key => key.replaceAll('~1','/').replaceAll('~0','~')).reduce((current,key) => {
    if (!current || !Object.hasOwn(current,key)) throw Error('missing original assertion');
    return current[key];
  },value);
}
function publicCheck(check, plan, binding) {
  if (check?.schemaVersion !== 'revision-plan-fact-result-1' || !['blocked','incomplete'].includes(check.status)
    || check.clearForExecution !== false || check.semanticAccuracyEstablished !== false || check.automaticAdoption !== false
    || check.literaryPass !== 'NOT_ASSESSED' || !Array.isArray(check.assessments) || !check.assessments.length
    || check.bindings?.sourceTaskId !== `whole-quality:${binding.requestInputFingerprint}`
    || check.bindings?.sourceManuscriptSha256 !== binding.sourceManuscriptSha256) throw Error('invalid failed check');
  const evidence = items => items.map(item => ({ version:item.version, chapterId:item.chapterId, quote:item.quote, start:item.start, end:item.end }));
  return { schemaVersion:check.schemaVersion, status:check.status, clearForExecution:false,
    semanticAccuracyEstablished:false, automaticAdoption:false, literaryPass:'NOT_ASSESSED',
    assessments:check.assessments.map(item => {
      const statement = atPointer(plan,item.JSONPointer);
      if (typeof statement !== 'string' || !statement.length) throw Error('invalid original assertion');
      return { assertionId:item.assertionId, JSONPointer:item.JSONPointer, JSONPointers:structuredClone(item.JSONPointers), statement,
        coverage:item.coverage, reason:item.reason,
        premiseChecks:Object.fromEntries(dimensions.map(key => [key, { disposition:item.premiseChecks[key].disposition,
          factIds:[...item.premiseChecks[key].factIds], reason:item.premiseChecks[key].reason }])),
        facts:item.facts.map(fact => ({ id:fact.id, claimQuote:fact.claimQuote, claimStart:fact.claimStart, dimensions:[...fact.dimensions],
          status:fact.status, attribution:fact.attribution, support:evidence(fact.support), counter:evidence(fact.counter), reason:fact.reason })),
      };
    }),
  };
}

/** No I/O, mutation, prompts or configuration; the CREATION inspector owns strict saved-stage replay. */
export async function projectRevisionEvidenceFailure(task, request, artifacts, inspect) {
  if (task?.status !== 'failed' || task.result || task.kind !== 'revise' || task.revisionMode !== 'whole-manuscript-v2'
    || task.failure?.recoverable !== false || request?.revisionEvidencePolicy === undefined
    || request.projectId !== task.projectId || request.requestId !== task.requestId || request.baseRevision !== task.baseRevision
    || request.kind !== task.kind || request.revisionMode !== task.revisionMode || typeof inspect !== 'function'
    || !object(artifacts?.['whole-quality:plan-facts:blocked'])) return undefined;
  try {
    const proof = await inspect({request:structuredClone(request),artifacts:structuredClone(artifacts)});
    if (proof?.schemaVersion !== 'whole-quality-plan-facts-failure-view-1' || proof.status !== 'verified_failure'
      || proof.artifactKey !== 'whole-quality:plan-facts:blocked' || proof.correctionAttempted !== true
      || !['blocked','incomplete'].includes(proof.checkStatus) || proof.revisionDispatched !== false
      || proof.automaticAdoption !== false || proof.semanticAccuracyEstablished !== false || proof.literaryPass !== 'NOT_ASSESSED'
      || !sha(proof.requestInputFingerprint) || !sha(proof.sourceManuscriptSha256)
      || !sha(proof.historySha256)
      || artifacts.requestSpec?.inputFingerprint !== proof.requestInputFingerprint
      || artifacts.requestSpec?.sourceManuscriptSha256 !== proof.sourceManuscriptSha256) return undefined;
    // CREATION replay verified this exact blocked history. Only the assertion text
    // and canonical check details are projected; inputs, raw and receipts stay private.
    const history = artifacts[proof.artifactKey].history;
    if (!isDeepStrictEqual(history?.initialCheck,proof.initialCheck)
      || !isDeepStrictEqual(history?.correction?.check,proof.finalCheck)) return undefined;
    const initialCheck = publicCheck(proof.initialCheck,history.initialPlan,proof);
    const finalCheck = publicCheck(proof.finalCheck,history.correction.plan,proof);
    if (finalCheck.status !== proof.checkStatus) return undefined;
    return { schemaVersion:'whole-quality-plan-facts-failure-1', sourceTaskId:task.id, requestId:task.requestId,
      requestInputFingerprint:proof.requestInputFingerprint, sourceManuscriptSha256:proof.sourceManuscriptSha256,
      status:proof.checkStatus, revisionDispatched:false, automaticAdoption:false,
      planFacts:finalCheck, planHistory:{initialCheck,correction:{check:finalCheck}},
    };
  } catch { return undefined; }
}
