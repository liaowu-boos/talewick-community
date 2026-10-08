import {createHash} from 'node:crypto';
export const INDEX_VERSION = 'library-index-3.3';
export const RETRIEVAL_LIMITS = Object.freeze({maxCandidates:20,maxUnits:6,maxChars:12000,coreChars:700,contextChars:280,contextLines:6,maxRangeChars:2400,maxSourceChars:4800,maxSourceMaterials:3});
const fields=['title','event','psychology','emotion','expression','readerEffectHypothesis'];
const hash=s=>createHash('sha256').update(s).digest('hex');
const split=s=>s.split(/\r\n|\r|\n/);
// General interrogative/connective fragments; no corpus, query-ID or answer-specific vocabulary.
const weak=new Set(['什么','为什么','为何','怎么','怎样','如何','是否','多少','具体','这个','那个','一个','一种','哪些','哪种','其中','以及','通过','进行','所有','不是','没有','已经','的','了','吗']);
// Standalone grammar words end unknown-compound runs; never synthesize "从我" etc.
const boundaries=new Set(['我','你','他','她','它','人','让','把','被','给','从','向','在','将','某','曾','后','前','就','又','才','所','以','为','而','能','要','会','到']);
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
export function queryTerms(query){
 const terms=new Map();
 // Keep ICU word boundaries; join runs of single Han characters for unknown compounds.
 const words=[];let singles='';
 const flush=()=>{if(singles)words.push(singles);singles='';};
 for(const {segment,isWordLike} of segmenter.segment(query.toLowerCase())){
  if(isWordLike&&/^[\p{Script=Han}]$/u.test(segment)&&!weak.has(segment)&&!boundaries.has(segment)){singles+=segment;continue;}
  flush();if(isWordLike)words.push(segment);
 }
 flush();
 for(const word of words){
  if(/^[a-z0-9]/.test(word)){if(!weak.has(word))terms.set(word,2);continue;}
  for(const n of [2,3,4])for(let i=0;i+n<=word.length;i++){const term=word.slice(i,i+n);if(!/^[的是么]|的$/.test(term)&&!weak.has(term)&&![...weak].some(w=>w.length>1&&term.includes(w)))terms.set(term,n-1);}
 }
 return [...terms].slice(0,256).map(([term,weight])=>({term,weight}));
}
export function mergeRanges(parts){const sorted=parts.map(p=>({...p,unitIds:[...p.unitIds]})).sort((a,b)=>a.lineStart-b.lineStart);const merged=[];for(const part of sorted){const prev=merged.at(-1);if(prev&&part.lineStart<=prev.lineEnd+1){prev.lineEnd=Math.max(prev.lineEnd,part.lineEnd);prev.unitIds=[...new Set([...prev.unitIds,...part.unitIds])];}else merged.push(part);}return merged;}
function reviewBound(row){const r=row.analysis?.validation?.semanticReview;return row.analysis?.reviewStatus==='checked'&&r?.approved===true&&!!r.recordId&&r.sourceId===row.sourceId&&r.textVersion===row.textVersion&&r.analysisVersion===row.analysis.version;}
export function buildRetrievalIndex(row,text){
 const lines=split(text),entries=[];
 for(let start=0;start<lines.length;){let end=start+1,chars=lines[start].length;while(end<lines.length&&chars+lines[end].length+1<=RETRIEVAL_LIMITS.coreChars)chars+=lines[end++].length+1;
 const raw=lines.slice(start,end).join('\n');if(raw.trim())entries.push({id:`${row.sourceId}:raw:${start+1}-${end}`,use:'raw_reference',lineStart:start+1,lineEnd:end,raw,unitIds:[]});start=end;}
 if(reviewBound(row))for(const unit of row.analysis.units){
  const units=[...new Set([unit.id,...unit.relatedUnitIds])].map(id=>row.analysis.units.find(u=>u.id===id)).filter(Boolean);
  const parts=mergeRanges(units.map(u=>({...u.locator,unitIds:[u.id]})));
  const focusAnalysis=`单元 ${unit.id}：${fields.map(k=>`${k}: ${unit[k]}`).join('\n')}`;
  const focusSearchText=focusAnalysis+'\n'+lines.slice(unit.locator.lineStart-1,unit.locator.lineEnd).join('\n');
  const originals=parts.map(p=>lines.slice(p.lineStart-1,p.lineEnd).join('\n'));
  // Search exactly the focus analysis and originals already carried by this candidate.
  // Linked analysis and text outside the approved one-hop ranges remain excluded.
  const searchText=focusAnalysis+'\n'+originals.join('\n\n');
  const raw=focusAnalysis+'\n'+parts.map((p,i)=>`原文（${p.lineStart}–${p.lineEnd}）：\n${originals[i]}`).join('\n\n');
  entries.push({id:`${row.sourceId}:analysis:${unit.id}`,use:'reviewed_analysis',focusUnitId:unit.id,focusSearchText,searchText,parts,raw,unitIds:units.map(u=>u.id),reviewRecordId:row.analysis.validation.semanticReview.recordId});
 }
 return {indexVersion:INDEX_VERSION,textVersion:row.textVersion,analysisVersion:row.analysis.version,entries};
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const validRange = value => object(value) && Number.isSafeInteger(value.lineStart) && Number.isSafeInteger(value.lineEnd) && value.lineStart >= 1 && value.lineEnd >= value.lineStart;
const validIds = value => Array.isArray(value) && value.every(nonempty) && new Set(value).size === value.length;
// Validate the search projection against complete packaged ranges, excluding locator labels.
// This is still a shape check, not a replacement for the trusted catalog digest.
function compatibleSearchText(entry, prefix, focus) {
  if (!entry.raw.startsWith(prefix)) return false;
  const lines=split(entry.raw.slice(prefix.length)),originals=[];let at=0,focusOriginal;
  for (const [i,part] of entry.parts.entries()) {
    if (i && lines[at++] !== '') return false;
    if (lines[at++] !== `原文（${part.lineStart}–${part.lineEnd}）：`) return false;
    const count=part.lineEnd-part.lineStart+1;
    if(part.unitIds.includes(focus.id))focusOriginal=lines.slice(at+focus.locator.lineStart-part.lineStart,at+focus.locator.lineEnd-part.lineStart+1).join('\n');
    originals.push(lines.slice(at,at+count).join('\n'));at+=count;
  }
  return at===lines.length && entry.searchText===prefix+originals.join('\n\n') && entry.focusSearchText===prefix+focusOriginal;
}
/** Shape/version check only. Persisted indexes also require the trusted catalog digest in library.inspectIndex before ranking. */
export function compatibleIndex(index, row) {
  if (!object(index) || index.indexVersion !== INDEX_VERSION || index.textVersion !== row.textVersion || index.analysisVersion !== row.analysis?.version || !Array.isArray(index.entries) || !index.entries.length) return false;
  const ids = new Set();
  return index.entries.every(entry => {
    if (!object(entry) || !nonempty(entry.id) || ids.has(entry.id) || !nonempty(entry.raw) || !validIds(entry.unitIds)) return false;
    ids.add(entry.id);
    if (entry.use === 'raw_reference') return validRange(entry) && split(entry.raw).length === entry.lineEnd - entry.lineStart + 1 && entry.unitIds.length === 0 && entry.parts === undefined;
    if (entry.use !== 'reviewed_analysis' || !reviewBound(row) || entry.reviewRecordId !== row.analysis.validation.semanticReview.recordId || !entry.unitIds.length || !Array.isArray(entry.parts) || !entry.parts.length) return false;
    const focus = row.analysis.units.find(unit => unit.id === entry.focusUnitId);
    if (!focus || entry.id !== `${row.sourceId}:analysis:${focus.id}` || !nonempty(entry.searchText) || JSON.stringify(entry.unitIds) !== JSON.stringify([...new Set([focus.id,...focus.relatedUnitIds])])) return false;
    const prefix=`单元 ${focus.id}：${fields.map(k=>`${k}: ${focus[k]}`).join('\n')}\n`;
    const expectedParts=mergeRanges(entry.unitIds.map(id=>row.analysis.units.find(u=>u.id===id)).filter(Boolean).map(u=>({...u.locator,unitIds:[u.id]})));
    if (JSON.stringify(entry.parts) !== JSON.stringify(expectedParts)) return false;
    const known = new Set(row.analysis.units.map(unit => unit.id));
    if (!entry.unitIds.every(id => known.has(id))) return false;
    const partIds = new Set(); let end = 0;
    for (const part of entry.parts) {
      if (!validRange(part) || part.lineStart <= end || !validIds(part.unitIds) || !part.unitIds.length || !part.unitIds.every(id => entry.unitIds.includes(id))) return false;
      for (const id of part.unitIds) {
        const unit = row.analysis.units.find(u => u.id === id);
        if (partIds.has(id) || unit.locator.lineStart < part.lineStart || unit.locator.lineEnd > part.lineEnd) return false;
        partIds.add(id);
      }
      end = part.lineEnd;
    }
    return partIds.size === entry.unitIds.length && compatibleSearchText(entry,prefix,focus);
  });
}
function candidateCap(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid retrieval budget');
  return Math.min(RETRIEVAL_LIMITS.maxCandidates,value);
}
// The two IDF populations have incomparable scores. Merge by within-use rank,
// reviewed first on each turn; an exhausted route gives its slots to the other.
// This protects candidate supply only, and makes no semantic relevance claim.
function interleaveUses(ranked, cap) {
  const routes=['reviewed_analysis','raw_reference'].map(use=>ranked.filter(e=>e.use===use));
  const merged=[];
  for(let rank=0;merged.length<cap&&routes.some(route=>rank<route.length);rank++)
    for(const route of routes)if(route[rank]&&merged.length<cap)merged.push(route[rank]);
  return merged;
}
export function rankCandidates(entries, query, maxCandidates = 20) {
  const cap=candidateCap(maxCandidates);
  if (!cap) return [];
  const terms = queryTerms(query);
  // Separate focus and linked projections keep the existing focus DF/ranking stable.
  // A linked-only match is supplemental: it cannot boost a matching focus candidate.
  // Two fixed projections keep O(E*T); reviewed entries cannot alter raw scores.
  const groups = new Map();
  const projections=entry=>entry.use==='reviewed_analysis'
    ? [['focus',entry.focusSearchText??entry.searchText],['linked_original',entry.searchText]]
    : [['raw',entry.raw]];
  for (const entry of entries) {
   for(const [projection,value] of projections(entry)) {
    let group = groups.get(projection);
    if (!group) { group = { count: 0, df: new Map() }; groups.set(projection, group); }
    group.count++;
    const text = value.toLowerCase();
    for (const { term } of terms) if (text.includes(term)) group.df.set(term, (group.df.get(term) ?? 0) + 1);
   }
  }
  const ranked = [];
  for (const entry of entries) {
   for(const [projection,value] of projections(entry)) {
    const group = groups.get(projection), text = value.toLowerCase(), hits = [];
    let score = 0;
    for (const { term, weight } of terms) if (text.includes(term)) {
      hits.push(term); score += weight * (1 + Math.log((group.count + 1) / (group.df.get(term) + 1)));
    }
    if (score > 0) {ranked.push({ ...entry, score, hits,...(entry.use==='reviewed_analysis'?{matchScope:projection}:{}) });break;}
   }
  }
  return interleaveUses(ranked.sort((a,b) => Number(a.matchScope==='linked_original')-Number(b.matchScope==='linked_original') || b.score-a.score || a.row.sourceId.localeCompare(b.row.sourceId) || (a.lineStart ?? a.parts[0].lineStart)-(b.lineStart ?? b.parts[0].lineStart) || a.id.localeCompare(b.id)),cap);
}
/** Normalize only the optional recall object; never infer focus from a question. */
export function normalizeRecall(value) {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(k => !['focus', 'queries'].includes(k)) || !['scene', 'ending', 'echo'].includes(value.focus) || !Array.isArray(value.queries) || value.queries.length > 3 || value.queries.some(q => typeof q !== 'string' || !q || q !== q.trim() || q.length > 120) || new Set(value.queries).size !== value.queries.length) throw new TypeError('Invalid recall hint');
  return { focus: value.focus, queries: [...value.queries] };
}
const uniqueOrigins = origins => [...new Map(origins.map(o => [JSON.stringify(o), o])).values()];
export function recallReason(origins) {
  return origins.map(o => o.kind === 'physical'
    ? `提供文本物理${o.position === 'tail' ? '尾部' : '开头'}窗口${o.coreCount === 2 ? '（含相邻片段）' : ''}（${o.focus}提示）；不证明剧情呼应或全文完整`
    : o.kind === 'variant' ? `补充查询${o.variantIndex + 1}「${o.query}」词法命中；补充词不是已复核分析`
    : '原查询词法命中').join('；');
}
/** A large reviewed star stays intact. At most two additional raw windows may
 * join a focus locator to an already-linked, physically adjacent locator.
 * No distant gaps, sentence clipping, linked analysis, or implicit new approval.
 */
function adjacentRawSupplements(entries, ranked, query, cap) {
  const terms=queryTerms(query.query), generated=new Map(), rawBySource=new Map();
  const limit=Math.min(RETRIEVAL_LIMITS.maxRangeChars,query.budget?.maxChars??RETRIEVAL_LIMITS.maxChars);
  const tooLarge=c=>c.use==='reviewed_analysis'&&(c.raw.length+'【经语义复核的分析及原文；文学效果未验证】\n'.length>Math.min(RETRIEVAL_LIMITS.maxSourceChars,query.budget?.maxChars??RETRIEVAL_LIMITS.maxChars)||c.unitIds.length>Math.min(RETRIEVAL_LIMITS.maxUnits,query.budget?.maxUnits??RETRIEVAL_LIMITS.maxUnits));
  for(const c of ranked.filter(tooLarge)) {
    if(generated.size>=2)break;
    const focus=c.row.analysis.units.find(u=>u.id===c.focusUnitId);
    if(!focus||!reviewBound(c.row))continue;
    if(!rawBySource.has(c.row.sourceId)) {
      const lines=new Map();
      for(const r of entries.filter(e=>e.use==='raw_reference'&&e.row.sourceId===c.row.sourceId))split(r.raw).forEach((line,i)=>lines.set(r.lineStart+i,line));
      rawBySource.set(c.row.sourceId,lines);
    }
    const lines=rawBySource.get(c.row.sourceId);
    const pairs=focus.relatedUnitIds.map(id=>c.row.analysis.units.find(u=>u.id===id)).filter(Boolean)
      .filter(u=>Math.max(u.locator.lineStart,focus.locator.lineStart)-Math.min(u.locator.lineEnd,focus.locator.lineEnd)<=RETRIEVAL_LIMITS.contextLines+1)
      .map(u=>({lineStart:Math.min(u.locator.lineStart,focus.locator.lineStart),lineEnd:Math.max(u.locator.lineEnd,focus.locator.lineEnd),unitIds:[focus.id,u.id]}));
    for(const p of pairs) {
      if(generated.size>=2)break;
      const original=[];for(let n=p.lineStart;n<=p.lineEnd;n++){if(!lines.has(n))break;original.push(lines.get(n));}
      if(original.length!==p.lineEnd-p.lineStart+1)continue;
      const raw=original.join('\n'),hits=terms.filter(t=>raw.toLowerCase().includes(t.term)).map(t=>t.term);
      if(!hits.length||raw.length+'【原文参考；不作为已发布分析】\n'.length>limit)continue;
      const id=`${c.row.sourceId}:raw:${p.lineStart}-${p.lineEnd}`;
      if(ranked.some(r=>r.id===id)||generated.has(id))continue;
      generated.set(id,{id,use:'raw_reference',lineStart:p.lineStart,lineEnd:p.lineEnd,raw,unitIds:[],row:c.row,score:0,hits,
        contextOrigin:{kind:'adjacent_linked_locators',parentCandidateId:c.id,unitIds:p.unitIds},boundedLocatorWindow:true});
    }
  }
  const out=[];
  for(const c of ranked){out.push(c);for(const g of generated.values())if(g.contextOrigin.parentCandidateId===c.id)out.push(g);}
  return out.slice(0,cap);
}
export function rankWithRecall(entries, query, maxCandidates = 20, { explicitSourceIds } = {}) {
  if (query.recall === undefined) {const cap=candidateCap(maxCandidates);return adjacentRawSupplements(entries,rankCandidates(entries,query.query,cap),query,cap);}
  const recall = normalizeRecall(query.recall), cap = candidateCap(maxCandidates);
  if (!cap || query.evidenceType === 'performance') return [];
  const routes = [query.query, ...recall.queries];
  const merged = new Map();
  let originalTopId;
  routes.forEach((text, route) => rankCandidates(entries, text, 20).forEach((entry, rank) => {
    if (route === 0 && rank === 0) originalTopId = entry.id;
    let item = merged.get(entry.id);
    if (!item) { item = { ...entry, score: 0, recallOrigins: [] }; merged.set(entry.id, item); }
    item.score += 1 / (60 + rank + 1); // comparable bounded reciprocal rank across routes
    item.recallOrigins.push(route === 0 ? { kind: 'lexical', query: text } : { kind: 'variant', variantIndex: route - 1, query: text });
  }));
  const lexical = interleaveUses([...merged.values()].sort((a,b) => b.score-a.score || a.id.localeCompare(b.id)),merged.size);
  // Keep the original query’s best hit ahead of all supplemental routes.
  const prioritizeOriginal = candidates => {
    const original = merged.get(originalTopId);
    return (original ? [original, ...candidates.filter(e => e.id !== originalTopId)] : candidates).slice(0, cap);
  };
  // Scene variants must keep the same bounded adjacent-context opportunity as
  // the plain route. These remain raw candidates and still require relevance review.
  if (recall.focus === 'scene') return adjacentRawSupplements(entries,prioritizeOriginal(lexical),query,cap);
  // At most two lexically established sources. Zero lexical hits require exactly one usable explicit source.
  const lexicalSources = [...new Set(lexical.map(e => e.row.sourceId))];
  const usableExplicit = explicitSourceIds === undefined ? [] : [...new Set(explicitSourceIds)].filter(id => entries.some(e => e.row.sourceId === id && e.use === 'raw_reference'));
  const established = lexicalSources.length ? lexicalSources.slice(0, 2) : usableExplicit.length === 1 ? usableExplicit : [];
  const physical = [];
  for (const sourceId of established) {
    const raw = entries.filter(e => e.row.sourceId === sourceId && e.use === 'raw_reference').sort((a,b) => a.lineStart-b.lineStart);
    if (!raw.length) continue;
    const physicalWindow = position => {
      const edge = position === 'head' ? raw.slice(0, 2) : raw.slice(-2);
      if (edge.length === 2 && edge[0].lineEnd + 1 === edge[1].lineStart && edge[0].raw.length + edge[1].raw.length + 1 <= Math.min(RETRIEVAL_LIMITS.maxRangeChars, RETRIEVAL_LIMITS.coreChars * 2 + 1, Math.max(0, (query.budget?.maxChars ?? RETRIEVAL_LIMITS.maxChars) / (established.length * (recall.focus === 'echo' ? 2 : 1)) - '【原文参考；不作为已发布分析】\n'.length))) {
        return { ...edge[0], id: `${sourceId}:raw:${edge[0].lineStart}-${edge[1].lineEnd}`, lineEnd: edge[1].lineEnd, raw: edge[0].raw + '\n' + edge[1].raw, physicalCoreCount: 2 };
      }
      return position === 'head' ? raw[0] : raw.at(-1);
    };
    for (const position of recall.focus === 'ending' ? ['tail'] : ['head', 'tail']) {
      const entry = physicalWindow(position);
      let item = merged.get(entry.id);
      if (!item) { item = { ...entry, score: 0, hits: [], recallOrigins: [] }; merged.set(entry.id, item); }
      item.recallOrigins.push({ kind: 'physical', focus: recall.focus, position, coreCount: entry.physicalCoreCount ?? 1 });
      if (!physical.some(e => e.id === item.id)) physical.push(item);
    }
  }
  // Physical supplements follow the reserved original hit and share the same final budget.
  return prioritizeOriginal([...physical, ...lexical.filter(e => !physical.some(p => p.id === e.id))]);
}
const overlap=(a,b)=>a.lineStart<=b.lineEnd&&a.lineEnd>=b.lineStart;
function expand(range,lines){let start=range.lineStart-1,end=range.lineEnd;for(const direction of [-1,1]){let chars=0;for(let i=0;i<RETRIEVAL_LIMITS.contextLines;i++){const at=direction<0?start-1:end;if(at<0||at>=lines.length||chars+lines[at].length+1>RETRIEVAL_LIMITS.contextChars)break;chars+=lines[at].length+1;if(direction<0)start--;else end++;}}return {lineStart:start+1,lineEnd:end};}
const unitCost=m=>Math.max(1,new Set(m.references.flatMap(r=>r.unitIds)).size);
function analysisLimitations(row) {
 const provenance=`${reviewBound(row)?'已复核':'未复核'}来源分析 ${row.analysis.version}`;
 // Bind each complete, ordered array once instead of repeating an 80-character
 // version prefix on every note. JSON preserves duplicates, whitespace and boundaries.
 // This is metadata serialization, never summarization, evidence, or a raw-use upgrade.
 return [['限制',row.analysis.limitations??[]],['覆盖说明',row.analysis.coverage.notes??[]]]
  .filter(([,notes])=>notes.length).map(([kind,notes])=>`${provenance}的${kind}（逐条完整保留）：\n${JSON.stringify(notes)}`);
}
/** Organize only bounded ranked candidates. readText is lazy (at most maxCandidates sources). */
export async function organizeMaterials(candidates,budget,readText,{signal}={}){
 budget=Object.fromEntries(['maxCandidates','maxUnits','maxChars'].map(k=>{const n=budget?.[k]??RETRIEVAL_LIMITS[k];if(!Number.isSafeInteger(n)||n<0)throw new TypeError('Invalid retrieval budget');return [k,Math.min(n,RETRIEVAL_LIMITS[k])];}));
 const bounded=candidates.slice(0,budget.maxCandidates),cache=new Map();
 const initial=await packRankedMaterials(bounded,budget,readText,cache,signal);
 if(initial.materials.some(m=>m.use==='reviewed_analysis'))return initial;
 // Repair route starvation only. The caller's relevance gate remains authoritative:
 // never introduce a candidate outside this bounded, already-selected list, never
 // rank by size/ROI, and leave a package with any analysis completely unchanged.
 for(const c of bounded.filter(c=>c.use==='reviewed_analysis')){
  signal?.throwIfAborted();
  const single=await packRankedMaterials([c],budget,readText,cache,signal);
  if(!single.materials.length)continue;
  const repaired=await packRankedMaterials([c,...bounded.filter(other=>other!==c)],budget,readText,cache,signal);
  const retained=new Set(repaired.materials.map(m=>m.id));
  const displaced=initial.materials.filter(m=>!retained.has(m.id)).map(m=>m.id);
  repaired.limits.push(`原顺序未供应分析；完整保留原排名最先可独立装入预算的分析 ${c.id}，其余候选顺序不变。未保留的原包材料：${displaced.join('；')||'无'}。不代表文学质量排序或新增适用性批准。`);
  return repaired;
 }
 return initial;
}
async function packRankedMaterials(candidates,budget,readText,cache,signal){
 const materials=[],limits=[];let usedChars=0;
 const baseRef=c=>({sourceId:c.row.sourceId,textVersion:c.row.textVersion,analysisVersion:c.row.analysis.version,sourceSha256:c.row.sourceSha256});
 const key=m=>JSON.stringify([m.references[0].sourceSha256,m.references[0].textVersion]);
 const fits=next=>next.length<=budget.maxUnits&&next.reduce((n,m)=>n+unitCost(m),0)<=budget.maxUnits&&next.reduce((n,m)=>n+m.content.length,0)<=budget.maxChars&&[...new Set(next.map(key))].every(k=>{const same=next.filter(m=>key(m)===k);return same.length<=RETRIEVAL_LIMITS.maxSourceMaterials&&same.reduce((n,m)=>n+m.content.length,0)<=RETRIEVAL_LIMITS.maxSourceChars;});
 for(const c of candidates){
  signal?.throwIfAborted();const sourceKey=JSON.stringify([c.row.sourceSha256,c.row.textVersion]);
  let range,raw=c.raw,parts=c.parts,merged=[],separate=[];
  if(c.use==='raw_reference'){
   if(!cache.has(sourceKey))cache.set(sourceKey,split(await readText(c.row)));
   signal?.throwIfAborted();const lines=cache.get(sourceKey);range=c.boundedLocatorWindow?{lineStart:c.lineStart,lineEnd:c.lineEnd}:expand(c,lines);
   const independentRange={...range};
   if(materials.some(m=>m.use==='raw_reference'&&key(m)===sourceKey&&m.references[0].lineStart<=range.lineStart&&m.references[0].lineEnd>=range.lineEnd)){limits.push('候选完整窗口已被供应，已跳过重复。');continue;}
   // Merge only actual overlap/adjacency; never bridge a missing scene as continuous text.
   let changed=true;while(changed){changed=false;for(let i=0;i<materials.length;i++){const m=materials[i];if(merged.includes(i)||m.use!=='raw_reference'||key(m)!==sourceKey)continue;const r=m.references[0];if(r.lineStart<=range.lineEnd+1&&r.lineEnd>=range.lineStart-1){range={lineStart:Math.min(range.lineStart,r.lineStart),lineEnd:Math.max(range.lineEnd,r.lineEnd)};merged.push(i);changed=true;}}}
   raw=lines.slice(range.lineStart-1,range.lineEnd).join('\n');
   if(raw.length>RETRIEVAL_LIMITS.maxRangeChars){
    // A union that cannot fit must not discard an independently complete window.
    separate=merged;merged=[];range=independentRange;raw=lines.slice(range.lineStart-1,range.lineEnd).join('\n');
    if(raw.length>RETRIEVAL_LIMITS.maxRangeChars){limits.push('完整原文窗口超过单段上限，已跳过；未截断。');continue;}
   }
   parts=[{...range,unitIds:[]}];
  }
  if(materials.some((m,i)=>!merged.includes(i)&&!separate.includes(i)&&key(m)===sourceKey&&m.references.some(r=>parts.some(p=>overlap(r,p))))){limits.push('候选与已选版本范围重复，已跳过。');continue;}
  const content=`${c.use==='reviewed_analysis'?'【经语义复核的分析及原文；文学效果未验证】':'【原文参考；不作为已发布分析】'}\n${raw}`;
  const material={id:c.use==='raw_reference'?`${c.row.sourceId}:raw:${range.lineStart}-${range.lineEnd}`:c.id,title:c.row.title,content,kind:'retrieved',use:c.use,sha256:hash(content),references:parts.map(p=>({...baseRef(c),...p,...(c.use==='reviewed_analysis'?{reviewRecordId:c.reviewRecordId}:{})})),selectionReason:c.recallOrigins ? recallReason(uniqueOrigins([...c.recallOrigins,...merged.flatMap(i=>materials[i].recallOrigins??[])])) : `自身${c.use==='raw_reference'?'原文':'焦点分析或所携关联原文'}匹配词项；词法排序未验证心理机制适用。`,...(c.recallOrigins ? {recallOrigins:uniqueOrigins([...c.recallOrigins,...merged.flatMap(i=>materials[i].recallOrigins??[])])} : {}),limitations:[...(c.use==='reviewed_analysis'?[`仅含焦点单元 ${c.focusUnitId} 的分析；关联单元仅提供可词法检索的原文上下文，引用保留全部单元与版本。`]:[]),`用户声明范围：${c.row.completeness}；程序分析范围：${c.row.analysis.coverage.scope}`,'只取有界局部上下文，不保证全篇问题证据充分。']};
  material.limitations=[...new Set([...material.limitations,...analysisLimitations(c.row),...merged.flatMap(i=>materials[i].limitations)])];
  if(c.contextOrigin){material.selectionReason='完整分析上下文过大；以已有相邻关联单元定位有界原文，原文自身有词法命中；未认证所问关系。';material.limitations.push('本窗口仅为相邻定位范围的原文参考，不供应被省去的分析和远处关联；不得把缺失上下文当作已知，也不沿用其语义批准。');}
  const next=materials.filter((_,i)=>!merged.includes(i));next.push(material);
  if(!fits(next)){limits.push('材料或同书上下文超过预算，跳过完整候选，未裁句。');continue;}
  if(separate.length)limits.push(`相邻或重叠原文合并超过单段上限，分别保留完整窗口：${[...separate.map(i=>materials[i].id),material.id].join('；')}。重叠内容按各条重复计入预算，不表示新增连续上下文。`);
  materials.splice(0,materials.length,...next);usedChars=materials.reduce((n,m)=>n+m.content.length,0);
 }
 return {materials,usedChars,limits:[...new Set(limits)]};
}
