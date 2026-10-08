import test from 'node:test';import assert from 'node:assert/strict';
import {renderFact} from '../src/model/publication-feedback.ts';
test('actual assessment objects render readable Chinese, unknown differs from zero, IDs stay out of summary',()=>{
 const moderation=renderFact({kind:'moderation',observationId:'private-evidence-id',status:'rejected',reason:'',category:'unknown'});
 assert.equal(moderation,'平台审核：已拒绝；理由：未提供；理由类别：未知。');
 const metrics=renderFact({kind:'metrics',observationId:'private-evidence-id',observedAt:'2026-09-30T00:00:00Z',windowHours:null,metrics:{impressions:null,reads:0,completions:null,likes:0,comments:null,favorites:null,follows:null}});
 assert.match(metrics,/窗口：未提供/);assert.match(metrics,/曝光：未提供/);assert.match(metrics,/阅读：0/);assert.match(metrics,/点赞：0/);assert.match(metrics,/读完：未提供/);assert(!metrics.includes('private-evidence-id'));assert(!metrics.includes('{'));
 assert.equal(renderFact('缺少 impressions / reads / completions'),'缺少 曝光 / 阅读 / 读完');
 assert.match(renderFact({kind:'metrics',observedAt:null,windowHours:24,metrics:{}}),/窗口：24 小时/);
});
