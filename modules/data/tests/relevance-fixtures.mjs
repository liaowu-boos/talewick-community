import {sourceEvidenceFragments} from '../runtime/relevance-evidence-ids.mjs';
import {expandRelevanceInput} from '../runtime/relevance-payload.mjs';

// Synthetic protocol quotes only. They make no claim to support a real mechanism.
export function fixtureDecision(candidate,relevance='usable'){
 const decision={candidateId:candidate.candidateId,relevance,reason:'固定协议替身，不代表语义判断'};
 if(relevance==='usable'){
  const original=candidate.content.split(/原文（\d+–\d+）：\n/u).at(-1).replace(/^【原文参考；不作为已发布分析】\n/u,'').trim();
  if(original.length<3)throw Error('fixture needs at least three source characters');
  decision.evidenceQuotes=[original.slice(0,2),original.slice(0,3)];
 }
 return decision;
}
export function fixtureResponse(user,relevance='usable'){
 const {inputHash,...wire}=JSON.parse(user),input=expandRelevanceInput(wire);
 return JSON.stringify({inputHash,decisions:input.candidates.map(c=>fixtureSelectionDecision(c,relevance))});
}

// Wire-format stub. Canonical quote fixtures above remain for strict historical/binder tests.
export function fixtureSelectionDecision(candidate,relevance='usable'){
 const {evidenceQuotes,...decision}=fixtureDecision(candidate,relevance);
 if(relevance==='usable'){
  const part=sourceEvidenceFragments(candidate)[0];
  if(!part)throw Error('fixture needs a selectable short source segment');
  decision.evidenceIds=[part.id];
 }
 return decision;
}
