import test from 'node:test';import assert from 'node:assert/strict';
import {compileReferenceStrategy,strategySelectionInput} from './reference-strategy.mjs';
import {retrievalQuery} from './knowledge.mjs';
const request={kind:'create',idea:'宇航员阿宁修复空间站，后来重新理解搭档的隐瞒。',context:{priorDraft:'旧稿要求父亲洗清冤屈',instruction:'保留失重环境和完整结局。'}};
const choice={status:'selected',mechanism:'reinterpret_past_action',basis:'/idea',quote:'后来重新理解搭档的隐瞒',reason:'原指令明确要求新的理解'};
test('legacy selection keeps its current quoted need instead of collapsing to a generic mechanism',()=>{
 const before=structuredClone(request),out=compileReferenceStrategy(choice,request);
 assert.equal(out.referenceQuestion.includes('宇航员'),false);assert.equal(out.referenceQuestion.includes('隐瞒'),true);
 const req={summary:request.idea,genre:'科幻',setting:'空间站',pointOfView:'第三人称',requiredElements:[request.idea,request.context.instruction],prohibitions:[],assumptions:[],...out};delete req.selection;
 const q=retrievalQuery(request,req,12000);const ctx=JSON.parse(q.context);
 assert.equal(q.query,out.referenceQuestion);assert.deepEqual(ctx.targetUse.requirements.requiredElements,req.requiredElements);assert.deepEqual(request,before);
 assert.deepEqual(strategySelectionInput(request).userInstructions.map(x=>x.path),['/idea','/context/instruction']);
});
test('extra invented constraints, missing mechanism and wrong source quotes are rejected',()=>{
 for(const v of [{...choice,condition:'必须发生在空间站'},{...choice,mechanism:'same_plot'}, {...choice,basis:'/context/priorDraft'}, {...choice,quote:'原谅父亲'}, {status:'unsupported',reason:'需要技术事实'}])assert.throws(()=>compileReferenceStrategy(v,request));
});
test('literal match is not a claim of correct mechanism selection',()=>{
 assert.doesNotThrow(()=>compileReferenceStrategy({...choice,mechanism:'setup_payoff'},request));
 assert.equal(compileReferenceStrategy(choice,request).selection.verification,'literal_quote_only_mechanism_fit_requires_review');
});
test('one-element basis array is normalized to the same persisted string',()=>{
 const out=compileReferenceStrategy({...choice,basis:['/idea']},request);
 assert.equal(out.selection.basis,'/idea');assert.deepEqual(out.referenceIntent.basis,['/idea']);
 assert.deepEqual(out,compileReferenceStrategy(choice,request));
});
test('empty or multi-element basis arrays are type errors and fabricated quotes still fail the literal gate',()=>{
 for(const basis of [[],['/idea','/instruction']])assert.throws(()=>compileReferenceStrategy({...choice,basis},request),TypeError);
 assert.throws(()=>compileReferenceStrategy({...choice,basis:['/idea'],quote:'原指令中不存在的句子'},request),/quote is not current instruction/);
});
// Synthetic saved response: no captured provider data or private manuscript.
test('a saved instruction selection normalizes without another model request',()=>{
 const instruction='让后来的证据改变人物对搭档沉默的理解。';
 const saved={status:'selected',mechanism:'reinterpret_past_action',basis:['/instruction'],quote:instruction,reason:'本次指令要求重新理解旧行动'};
 const out=compileReferenceStrategy(JSON.parse(JSON.stringify(saved)),{...request,instruction});
 assert.equal(out.selection.basis,'/instruction');assert.equal(out.selection.quote,instruction);
});
