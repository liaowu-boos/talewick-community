import {isDeepStrictEqual} from 'node:util';
import {sourceOriginalSpans} from './relevance-evidence-selections.mjs';
export const BOUNDED_EVIDENCE_VIEW_VERSION='source-evidence-compact-2';
const MARK='␞',escape=text=>text.replaceAll(MARK,MARK+MARK);
const need=(ok,code)=>{if(!ok)throw Object.assign(new TypeError(code),{code});};

/** Continuous source-only fragments have a program-enforced maximum. Selecting
 * four can never exceed the existing 480-character quote budget. No source text
 * is dropped from the transport; unselectable notes/whitespace remain visible.
 */
export function sourceEvidenceFragments(candidate){
 need(candidate?.evidenceText===undefined&&candidate?.evidenceParts===undefined,'EVIDENCE_EXPECTED_RAW_CANDIDATE');
 const fragments=[];
 for(const span of sourceOriginalSpans(candidate)){
  let start=span.start;
  while(start<span.end){
   let end=Math.min(start+120,span.end);
   if(end<span.end){
    const unit=candidate.content.charCodeAt(end-1);if(unit>=0xD800&&unit<=0xDBFF)end--;
    const prefix=candidate.content.slice(start,end),boundary=[...prefix.matchAll(/[\n。！？!?]/gu)].at(-1)?.index;
    if(boundary!==undefined&&boundary>=59)end=start+boundary+1;
   }
   const text=candidate.content.slice(start,end);
   if(text.trim().length>=2)fragments.push({id:String(fragments.length+1),start,end,block:span.block,text});
   start=end;
  }
 }
 return fragments;
}
export function buildBoundedEvidenceView(candidate){
 const fragments=sourceEvidenceFragments(candidate),events=[],last=new Map();
 for(const f of fragments){events.push({at:f.start,text:MARK+f.id+':'});last.set(f.block,f.end);}
 for(const at of last.values())events.push({at,text:MARK+';'});
 events.sort((a,b)=>a.at-b.at);let at=0,evidenceText='';
 for(const e of events){evidenceText+=escape(candidate.content.slice(at,e.at))+e.text;at=e.at;}
 evidenceText+=escape(candidate.content.slice(at));const {content,...metadata}=structuredClone(candidate);return {...metadata,evidenceText};
}
export function expandBoundedEvidenceView(candidate){
 need(candidate&&typeof candidate==='object'&&!Array.isArray(candidate)&&candidate.content===undefined&&candidate.evidenceParts===undefined&&typeof candidate.evidenceText==='string','EVIDENCE_COMPACT_VIEW_INVALID');
 const encoded=candidate.evidenceText;let content='';
 for(let i=0;i<encoded.length;){
  if(encoded[i]!==MARK){content+=encoded[i++];continue;}
  if(encoded[i+1]===MARK){content+=MARK;i+=2;continue;}
  const token=/^(?:[1-9][0-9]*:|;)/u.exec(encoded.slice(i+1));need(token,'EVIDENCE_COMPACT_TOKEN_INVALID');i+=1+token[0].length;
 }
 const {evidenceText,...metadata}=structuredClone(candidate),raw={...metadata,content};
 need(isDeepStrictEqual(buildBoundedEvidenceView(raw),candidate),'EVIDENCE_COMPACT_VIEW_NOT_CANONICAL');return raw;
}
export function resolveEvidenceIds(ids,candidate){
 need(Array.isArray(ids)&&ids.length>=1&&ids.length<=4,'EVIDENCE_ID_COUNT');
 need(ids.every(id=>typeof id==='string'&&/^[1-9][0-9]{0,3}$/u.test(id))&&new Set(ids).size===ids.length,'EVIDENCE_ID_SHAPE');
 const options=new Map(sourceEvidenceFragments(candidate).map(f=>[f.id,f]));
 const quotes=ids.map(id=>{const f=options.get(id);need(f,'EVIDENCE_ID_UNKNOWN');return candidate.content.slice(f.start,f.end);});
 // Repeated original text in two different locations need not appear twice in
 // the canonical quote list. This removes exact duplicates, never edits text.
 return [...new Set(quotes)];
}
