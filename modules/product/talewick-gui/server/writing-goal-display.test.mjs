import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {validateWritingGoals} from '../../../creation/runtime/writing-goals.mjs';

const bundled=await build({stdin:{contents:`export {WritingGoalDetails} from './src/features/ManuscriptPanel.tsx';
export {makeWritingGoalInput} from './src/model/writing-goal-input.ts';
export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';`,
  resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'tsx'},bundle:true,platform:'node',format:'esm',write:false,
  banner:{js:`import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(fileURLToPath(import.meta.url))});`}});
const ui=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const render=value=>ui.renderToStaticMarkup(ui.createElement(ui.WritingGoalDetails,{value}));

test('user-entered goals retain exact intent and boundaries and pass the production request contract',()=>{
  for(const dimension of ['emotion','psychology','choice']){
    const statement='让被忽视的劳动得到承认，但仍由人物决定是否接纳补偿。';
    const input=ui.makeWritingGoalInput(dimension,statement,'按期关店，保留没有彻底和解的结尾。');
    assert.deepEqual(validateWritingGoals(input,[]),input);
    assert.equal(input.goals[0].problem.statement,statement);
    assert.ok(input.goals[0].preservationBoundaries.includes('按期关店，保留没有彻底和解的结尾。'));
    assert.ok(input.goals[0].problem.searchTerms.includes('劳动'));
  }
  assert.throws(()=>ui.makeWritingGoalInput('emotion','   '));
  assert.throws(()=>ui.makeWritingGoalInput('emotion','字'.repeat(2001)));
  assert.throws(()=>ui.makeWritingGoalInput('unknown','目标'));
});

test('synthetic display fixtures distinguish hits and rejection, remain collapsed and are not rewritten',async()=>{
  const fixture={cases:[1,3].map(count=>({expectedReturnedCount:count,report:{schemaVersion:'whole-quality-writing-goals-report-1',goals:[{goal:{id:'synthetic-goal',dimension:'emotion',problem:{statement:'用可见行动表现有限信任。'}},deepMaterialOutcome:'supplied_all_declined',deepQuery:{returnedCandidateCount:count,suppliedMaterialCount:1},disposition:{decision:'preserve',reason:'合成参考与场景条件不符。'},materials:[{status:'unused',reason:'缺少必要前提。'}]}]}}))};
  for(const {expectedReturnedCount:count,report:value} of fixture.cases){
    const before=structuredClone(value),html=render(value);
    assert.ok(html.includes('命中后未采用'));
    assert.ok(html.includes(`查询命中 ${count} 份`));
    assert.ok(!html.includes('未找到匹配参考'));
    assert.ok(!html.includes('<details open'));
    assert.ok(html.includes('采用记录不代表写作质量已经通过'));
    assert.deepEqual(value,before);
  }
  assert.equal(render(undefined),'');
  assert.equal(render({schemaVersion:'unknown',goals:[]}),'');
});
