import {createHash} from 'node:crypto';
export const TRANSITION_HINT_VERSION='state-transition-locations-1';
const patterns=[['first_claim',/第一次|首次|头一回|头一次|这才|才知道|才明白|才意识到|才发现|才懂/g],['known_claim',/早已|早就|早知道|早明白|已经知道|已经明白|早先知道|原来就知道/g],['recurrence_claim',/再一次|又一次|再次|重新|仍然|还是|不再/g]];
/** Lexical locations only. No identities, conflicts, issue severity or candidate answers. */
export function stateTransitionHints(chapters,locations){
 const groups=patterns.map(([kind,pattern])=>chapters.map(chapter=>{
  const fragments=locations.modelInput.chapters.find(c=>c.id===chapter.id).fragments;
  return [...chapter.body.matchAll(pattern)].map(match=>{
   const matchStart=match.index,matchEnd=matchStart+match[0].length;
   const fs=fragments.filter(f=>f.end>matchStart&&f.start<matchEnd);const start=fs[0].start,end=fs.at(-1).end;
   return {kind,matched:match[0],chapterId:chapter.id,matchStart,matchEnd,start,end,quote:chapter.body.slice(start,end),fragmentStart:fs[0].id,fragmentEnd:fs.at(-1).id,bodySha256:createHash('sha256').update(chapter.body).digest('hex')};
  });
 }));
 const totalMatches=groups.flat(2).length,selected=[];
 // Prioritize explicit transition claims; round-robin chapters within each kind.
 for(const group of groups){for(let i=0;group.some(xs=>xs[i]);i++){for(const xs of group){if(xs[i]&&selected.length<24)selected.push(xs[i]);}}}
 return {version:TRANSITION_HINT_VERSION,totalMatches,selectedCount:selected.length,omittedCount:totalMatches-selected.length,semanticAssessment:false,hints:selected.map((h,i)=>({id:`hint-${i+1}`,...h}))};
}
