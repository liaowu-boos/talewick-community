import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bindRevisionScope, applyBoundedRevision, automaticRevisionScope } from './bounded-revision.mjs';
import { normalizeReadingObservations } from './v04/psychology.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
const chapter = { id: 'ch-2', title: '再来', body: '她早已看过拒收的回执。\n\n他再次递钱。她又把手缩回袖口；这回，他看见袖口已经磨破。\n\n她第一次知道信已退回。\n\n她没有答应。风把窗纸吹得响了一下。' };
const locate = quote => ({ start: chapter.body.indexOf(quote), end: chapter.body.indexOf(quote)+quote.length, quote });
const target = locate('她第一次知道信已退回。');
const kept = locate('他再次递钱。她又把手缩回袖口；这回，他看见袖口已经磨破。');
const issues = [{ chapterId: chapter.id, quote: target.quote, explanation: '前文同一人物早已读到回执，此处无记忆偏差却写成初知。' }];
const scope = { bodySha256: hash(chapter.body), ranges: [target], preserve: [kept] };
const response = replacement => ({ replacements: [{ ...target, replacement }] });

test('bounded correction of a knowledge reset preserves meaningful repeated action and restraint exactly', () => {
 const before=structuredClone(chapter),next=applyBoundedRevision(chapter,issues,scope,response('她又想到那封退回的信，仍没有问。'));
 assert.equal(next.body,chapter.body.slice(0,target.start)+'她又想到那封退回的信，仍没有问。'+chapter.body.slice(target.end));
 assert.ok(next.body.includes(kept.quote));assert.ok(next.body.endsWith('她没有答应。风把窗纸吹得响了一下。'));assert.deepEqual(chapter,before);
});
test('a stalled scene hypothesis never authorizes editing even with cross-chapter exact evidence', () => {
 const chapters=[{id:'ch-1',body:'他递钱，她拒收。之后两人仍按原约定关店。'},{id:'ch-2',body:'他又递钱，她又拒收。叙述仍只重复原约定。'}];
 const [observation]=normalizeReadingObservations([{category:'scene_function',observation:'两场是否只重申同一约定尚需判断；相同动作本身不能定罪。',evidence:chapters.map(c=>({chapterId:c.id,quote:c.body})),revisionScope:{chapterIds:['ch-2'],action:'考虑压缩重申',reason:'需结合前后作用',preserve:['拒收背后的未决态度']},limitations:['假设，未完成人类阅读']}],chapters);
 assert.equal(observation.evidenceVerified,true);assert.equal(observation.crossScene,true);assert.equal(observation.automaticRevisionAuthorized,false);assert.equal(observation.interpretationStatus,'model_hypothesis');
 assert.throws(()=>bindRevisionScope(chapter,[observation],scope),/获准问题/);
});
test('unlocated comparison remains needs_evidence; meaningful recurrence may be recorded without issues', () => {
 const [x]=normalizeReadingObservations([{observation:'同样缩手因磨破袖口使读者重新理解拒收，保留反复。',evidence:[{chapterId:'ch-2',quote:kept.quote},{chapterId:'missing',quote:'更早的场景尚未提供'}],revisionScope:{chapterIds:['ch-2'],preserve:[kept.quote]}}],[chapter]);
 assert.equal(x.status,'needs_evidence');assert.equal(x.automaticRevisionAuthorized,false);assert.deepEqual(x.revisionScope.preserve,[kept.quote]);
});
test('reject stale versions, wrong indices, protected overlap, ungrounded or whole chapter scope', () => {
 for(const invalid of [{...scope,bodySha256:'0'.repeat(64)}, {...scope,ranges:[{...target,start:target.start-1}]},{...scope,preserve:[target]},{...scope,ranges:[kept]},{...scope,ranges:[target,target]},{...scope,ranges:[{start:0,end:chapter.body.length,quote:chapter.body}],preserve:[]}])assert.throws(()=>bindRevisionScope(chapter,issues,invalid),/局部修订范围无效/);
 assert.throws(()=>bindRevisionScope({...chapter,body:chapter.body+'后来'},issues,scope),/版本/);
});
test('reject out-of-range additions and duplicate edits; model cannot change chapter identity or expand scope', () => {
 for(const invalid of [{...response('修订'),title:'新标题'},{replacements:[{...target,replacement:'修订',chapterId:'ch-1'}]},{replacements:[{...kept,replacement:'删去反复'}]},{replacements:[{...target,replacement:'修订'},{...target,replacement:'再修'}]},{replacements:[]}])assert.throws(()=>applyBoundedRevision(chapter,issues,scope,invalid),/局部修订响应无效/);
});
test('explicit UTF-16 offsets disambiguate a repeated quote without changing its earlier occurrence', () => {
 const c={id:'ch-1',body:'🌧️他答应了。\n后来，他答应了。\n结尾未兑现。'},q='后来，他答应了。',start=c.body.lastIndexOf(q),r={start,end:start+q.length,quote:q},i=[{chapterId:c.id,quote:q}];
 const next=applyBoundedRevision(c,i,{bodySha256:hash(c.body),ranges:[r]}, {replacements:[{...r,replacement:'后来，他仍没寄出钱。'}]});
 assert.equal(next.body,'🌧️他答应了。\n后来，他仍没寄出钱。\n结尾未兑现。');
});

test('ambiguous short issue evidence cannot silently select one repeated occurrence', () => {
 const c={id:'ch-1',body:'他答应了。后来，他答应了。'},q='他答应了。',start=c.body.lastIndexOf(q),r={start,end:start+q.length,quote:q};
 assert.throws(()=>bindRevisionScope(c,[{chapterId:c.id,quote:q}],{bodySha256:hash(c.body),ranges:[r]}),/多处匹配/);
});

test('automatic scope merges evidence in one paragraph without swallowing neighboring paragraphs', () => {
 const c={id:'ch-1',body:'应保留的开头。\n\n错误甲。错误乙。\n\n应保留的留白。'},issues=[{chapterId:'ch-1',quote:'错误甲。'},{chapterId:'ch-1',quote:'错误乙。'}];
 const scope=automaticRevisionScope(c,issues);assert.equal(scope.ranges.length,1);assert.equal(scope.ranges[0].quote,'错误甲。错误乙。');
});
test('single-paragraph scope falls back to exact evidence while ambiguous evidence is rejected', () => {
 assert.equal(automaticRevisionScope({id:'ch-1',body:'开头。错误甲。结尾。'},[{chapterId:'ch-1',quote:'错误甲。'}]).ranges[0].quote,'错误甲。');
 assert.throws(()=>automaticRevisionScope({id:'ch-1',body:'错误甲。\n\n错误甲。\n\n结尾。'},[{chapterId:'ch-1',quote:'错误甲。'}]),/唯一定位/);
});

test('LF and CRLF single line breaks delimit evidence paragraphs; same and cross paragraph issues stay bounded', () => {
 for(const nl of ['\n','\r\n','\n\n','\r\n \r\n']){
  const c={id:'ch-1',body:['开头。','此前事实。','这里有错句。还有错句。','收束。'].join(nl)};
  const one=automaticRevisionScope(c,[{chapterId:c.id,quote:'这里有错句'}]);assert.equal(one.ranges[0].quote,'这里有错句。还有错句。');
  const same=automaticRevisionScope(c,[{chapterId:c.id,quote:'这里有错句'},{chapterId:c.id,quote:'还有错句'}]);assert.equal(same.ranges.length,1);
  const cross=automaticRevisionScope(c,[{chapterId:c.id,quote:'此前事实'},{chapterId:c.id,quote:'这里有错句'}]);assert.deepEqual(cross.ranges.map(r=>r.quote),['此前事实。','这里有错句。还有错句。']);
 }
});
test('explicit almost-whole-chapter scope cannot swallow paragraphs without approved evidence', () => {
 const c={id:'ch-1',body:'开头。\n此前事实。\n这里有错句。\n收束。'},issues=[{chapterId:c.id,quote:'这里有错句'}];
 assert.throws(()=>bindRevisionScope(c,issues,{bodySha256:hash(c.body),ranges:[{start:0,end:c.body.length-1,quote:c.body.slice(0,-1)}]}),/超出服务端证据/);
 const single={id:'ch-1',body:'开头。这里有错句。收束。'};assert.throws(()=>bindRevisionScope(single,issues,{bodySha256:hash(single.body),ranges:[{start:0,end:single.body.length-1,quote:single.body.slice(0,-1)}]}),/超出服务端证据/);
});
test('automatic issues in all paragraphs cannot leave only whitespace as the supposed protected text', () => {
 const c={id:'ch-1',body:'错误甲。\n\n错误乙。'},issues=[{chapterId:c.id,quote:'错误甲'},{chapterId:c.id,quote:'错误乙'}];
 assert.throws(()=>automaticRevisionScope(c,issues),error=>error.code==='BOUNDED_REVISION_SCOPE_REJECTED'&&error.revisionDispatched===false&&/全部实质正文/.test(error.message));
});
