import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectComparisonCitationCoverage as inspect } from '../runtime/comparison-citation-coverage.mjs';
const chapter = (body, title='晚船', id='c') => ({id,title,body});
const ref = (blindId,quote,extra={}) => ({blindId,chapterId:'c',quote,...extra});
function run(before,after,evidence,extras={}) {
  return inspect({baselineChapters:[chapter(before)],candidateChapters:[chapter(after)],rolesByBlindId:{A:'candidate',B:'baseline'},comparisons:[{id:'claim',evidence,...extras}]});
}

test('exact shared citations do not hit a new paragraph despite shifted UTF-16 offsets',()=>{
  const old='汽笛响。\n\n灯灭了。', next='汽笛响。\n\n船长举起红旗。\n\n灯灭了。';
  const r=run(old,next,[ref('A','灯灭了。',{start:next.indexOf('灯灭了。')}),ref('B','灯灭了。')],{counterEvidence:[ref('A','红旗')]});
  assert.equal(r.byChannel.evidence.sharedOnly,2);assert.equal(r.byChannel.evidence.coversChangedParagraph,false);
  assert.equal(r.byChannel.counterEvidence.coversChangedParagraph,true);assert.equal(r.units[r.citations[2].unitIds[0]].kind,'paragraph_inserted');
  assert.equal(r.semanticSupport,'NOT_COMPUTED');assert.equal(r.literaryEffect,'NOT_COMPUTED');assert.equal(r.automaticAdoption,false);
});
test('two independent replacements do not absorb the shared middle; cross-paragraph quotes list all touched units',()=>{
  const r=run('旧伞。\n\n风起。\n\n雨歇。','新伞。\n\n风起。\n\n雨落。',[ref('A','风起。'),ref('A','风起。\n\n雨落。')]);
  assert.deepEqual(r.citations.map(x=>x.coverage),['shared_only','changed']);assert.deepEqual(r.citations[1].unitIds.map(id=>r.units[id].state),['shared','changed']);
});
test('text shared within a changed paragraph counts only at paragraph granularity',()=>{
  const r=run('她抵住门。门外无声。','她推开门。门外无声。',[ref('A','门外无声。')]);
  assert.equal(r.citations[0].coverage,'changed'); assert.equal(r.units[r.citations[0].unitIds[0]].kind,'replacement_region');
});
test('removed paragraph only citable on the old side; dangling supplied offset is never relocated',()=>{
  const r=run('桥边。\n\n木板断了。\n\n天亮。','桥边。\n\n天亮。',[ref('B','木板'),ref('A','木板'),ref('B','木板',{start:0})]);
  assert.deepEqual(r.citations.map(x=>x.location),['exact','inaccurate','inaccurate']);assert.equal(r.units[r.citations[0].unitIds[0]].kind,'paragraph_deleted');
});
test('an accurate offset can still have ambiguous duplicate paragraph alignment',()=>{
  const r=run('脚步停了。\n\n脚步停了。','脚步停了。',[ref('B','脚步'),ref('B','脚步',{start:0}),ref('A','脚步')]);
  assert.deepEqual(r.citations.map(x=>x.location),['ambiguous','exact','exact']);assert(r.citations.every(x=>x.coverage==='unresolved'));assert.equal(r.byChannel.evidence.coversChangedParagraph,null);
});
test('anchors can resolve duplicates with known locations; overlapping substring matches are not uniquely locatable',()=>{
  const old='响。\n\n甲。\n\n响。', next='甲。\n\n响。';
  const r=run(old,next,[ref('B','响。',{start:old.lastIndexOf('响。')}),ref('A','响。')]);assert.equal(r.byChannel.evidence.sharedOnly,2);
  assert.equal(run('哈哈哈','哈哈哈',[ref('A','哈哈')]).citations[0].location,'ambiguous');
});
test('title-only edit stays separate from body; identical literal in wrong field is not inferred as a title',()=>{
  const r=inspect({baselineChapters:[chapter('船靠岸。','归航')],candidateChapters:[chapter('船靠岸。','回港')],rolesByBlindId:{X:'baseline',Y:'candidate'},comparisons:[{evidence:[ref('Y','船靠岸。'),ref('Y','回港',{field:'title',start:0})],counterEvidence:[ref('Y','回港')]}]});
  assert.equal(r.byChannel.evidence.coversChangedTitle,true);assert.equal(r.byChannel.evidence.coversChangedParagraph,false);assert.equal(r.citations[2].reason,'quote_absent');
});
test('missing chapters are scoped by ID and each evidence channel has its own coverage',()=>{
  const r=inspect({baselineChapters:[chapter('门闩松了。','闩','old')],candidateChapters:[chapter('门闩松了。','闩','new')],rolesByBlindId:{A:'baseline',B:'candidate'},comparisons:[{evidence:[],severeHarm:{evidence:[ref('A','门闩',{chapterId:'old'}),ref('B','门闩',{chapterId:'new'})]}}]});
  assert.equal(r.byChannel.evidence.coversChangedParagraph,null);assert.deepEqual(r.citations.map(c=>r.units[c.unitIds[0]].kind),['chapter_deleted','chapter_inserted']);assert.equal(r.byChannel['severeHarm.evidence'].changed,2);
});
test('UTF-16 and line endings use original bytes; changing just a blank-line separator does not change either paragraph',()=>{
  const a='🪶羽落。\r\n\t\r\n灯亮。', b='🪶羽落。\n\n灯亮。';const r=run(a,b,[ref('B','羽',{start:2}),ref('A','羽',{start:1}),ref('A','灯亮。')]);
  assert.deepEqual(r.separatorOnlyChapterIds,['c']);assert.deepEqual(r.citations.map(c=>c.location),['exact','inaccurate','exact']);assert.equal(r.byChannel.evidence.coversChangedParagraph,null);
});
test('moves and oversized competing alignments stay pending; no blanket acceptance of a changed chapter',()=>{
  const moved=run('白。\n\n黑。','黑。\n\n白。',[ref('B','白。')]);assert.equal(moved.byChannel.evidence.coversChangedParagraph,null);
  const a=Array.from({length:1000},(_,i)=>`第${i}扇门。`).join('\n\n');const large=run(a,a+'\n\n尾。',[ref('B','第0扇门。'),ref('A','尾。')]);assert.deepEqual(large.citations.map(r=>r.coverage),['unresolved','changed']);
});
test('unknown scopes and malformed fields preserve uncertainty; duplicate chapter IDs fail before analysis',()=>{
  const r=run('门。','门。',[ref('Z','门。'),ref('A','门。',{field:'other'}),ref('A','门。',{chapterId:'bad'})]);assert.equal(r.byChannel.evidence.exact,0);assert.equal(r.byChannel.evidence.coversChangedParagraph,null);
  assert.throws(()=>inspect({baselineChapters:[chapter('甲'),chapter('乙')],candidateChapters:[],rolesByBlindId:{A:'baseline',B:'candidate'},comparisons:[]}),/unique/);
});

test('a positive hit is deduplicated by unit, and no comparison or raw citation is rewritten',()=>{
  const input={baselineChapters:[chapter('铃声。旧墙。')],candidateChapters:[chapter('铃声。新墙。')],rolesByBlindId:{A:'candidate',B:'baseline'},comparisons:[{evidence:[ref('A','铃声。'),ref('A','铃声。')]}]};
  const frozen=JSON.stringify(input), report=inspect(input);assert.equal(report.byChannel.evidence.changed,2);assert.equal(report.byChannel.evidence.changedUnitIds.length,1);
  assert.equal(report.citations[0].sameQuoteInCounterpartField,true);assert.equal(JSON.stringify(input),frozen);
});
test('all short binary paragraph sequences agree with exhaustive order-preserving match enumeration',()=>{
  function words(n){return n?words(n-1).flatMap(x=>[x+'甲',x+'乙']):[''];}
  const seq=[0,1,2,3].flatMap(words);
  for(const a of seq)for(const b of seq){
    const matches=[];
    function walk(i,j,pairs){matches.push(pairs);for(let x=i;x<a.length;x++)for(let y=j;y<b.length;y++)if(a[x]===b[y])walk(x+1,y+1,[...pairs,[x,y]]);}
    walk(0,0,[]);const max=Math.max(...matches.map(x=>x.length)), optimal=matches.filter(x=>x.length===max);
    const result=run([...a].join('\n\n'),[...b].join('\n\n'),[]);
    for(const u of result.units.filter(x=>x.field==='body')){
      const s=u.side==='baseline'?0:1, i=u.ordinal-1, v=[a,b][s][i];
      const mates=new Set(optimal.map(p=>p.find(pair=>pair[s]===i)?.[1-s]));
      const expected=![b,a][s].includes(v)?'changed':mates.size===1&&!mates.has(undefined)?'shared':'unresolved';
      assert.equal(u.state,expected,`${a}/${b} ${u.side} ${i}`);
    }
  }
});


test('shared title references are excluded from counts of shared body paragraphs',()=>{
  const report=run('旧。','新。',[ref('A','晚船',{field:'title'})]);
  assert.equal(report.byChannel.evidence.sharedOnly,1);assert.equal(report.byChannel.evidence.sharedParagraphOnly,0);
  assert.equal(report.byChannel.evidence.coversChangedTitle,false);assert.equal(report.byChannel.evidence.coversChangedParagraph,false);
});
