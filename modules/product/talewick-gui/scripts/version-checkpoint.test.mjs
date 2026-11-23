import assert from 'node:assert/strict';
import test from 'node:test';
import {createInitialState, createProject} from '../src/model/seed.ts';
import {prepareCheckpoint, canApplyCheckpoint, applyCheckpoint} from '../src/model/version-checkpoint.ts';
import {saveState, loadState} from '../src/model/store.ts';

const copy=value=>structuredClone(value);
function fixture() {
  const p=createProject('合成检查点','auto');
  p.title='合成当前作品';
  p.chapters=[{id:'a',title:'纸船',body:'纸船停在浅水里。\n\n风吹开一角。'}, {id:'b',title:'桥下',body:''}];
  p.versions=[{id:'old',title:'旧题名',label:'旧存稿',date:'2026-01-01',chapters:[{id:'a',title:'纸船',body:'旧稿正文。'}]}];
  p.pendingEdits=[{id:'edit',chapterId:'a',before:'纸船',after:'木船',reason:'合成建议',status:'pending'}];
  p.docMode='edit'; p.editorBaseline=copy(p.versions[0].chapters);
  p.runtime={task:{id:'synthetic-task'}};
  p.runtimeHistory=[{id:'synthetic-old-task'}];
  return p;
}

test('preparation detaches the saved manuscript and rejects invalid chapter identities or content',()=>{
  const p=fixture(), before=copy(p), plan=prepareCheckpoint(p);
  assert.deepEqual(plan.chapters,p.chapters);
  plan.chapters[0].body='changed preview';
  assert.deepEqual(p,before);
  assert.equal(canApplyCheckpoint(p,plan),false);
  for(const mutate of [p=>p.chapters=[],p=>p.chapters=null,p=>p.chapters.push(copy(p.chapters[0])),
    p=>p.chapters[0]=null,p=>p.chapters[0].id='',p=>p.chapters[0].body=3,p=>p.chapters[0].title=null,p=>p.title=null]) {
    const invalid=fixture(); mutate(invalid); const before=copy(invalid);
    assert.equal(prepareCheckpoint(invalid),null); assert.deepEqual(invalid,before);
  }
});

test('changed book, chapter content, order, identity or project blocks an old checkpoint with zero writes',()=>{
  for(const mutate of [p=>p.id+='x',p=>p.title+='改',p=>p.chapters.reverse(),p=>p.chapters[0].title+='改',
    p=>p.chapters[0].body+='改',p=>p.chapters[0].id+='改',p=>p.chapters.pop(),p=>p.chapters=[]]) {
    const p=fixture(), plan=prepareCheckpoint(p); mutate(p); const before=copy(p);
    assert.equal(canApplyCheckpoint(p,plan),false); assert.equal(applyCheckpoint(p,plan,'测试'),false);
    assert.deepEqual(p,before);
  }
});

test('empty names, destination collision and double confirmation never append another version',()=>{
  const p=fixture(), plan=prepareCheckpoint(p), before=copy(p);
  for(const name of ['', ' \n\t　'])assert.equal(applyCheckpoint(p,plan,name),false);
  assert.deepEqual(p,before);
  const collision={...plan,versionId:'old'};
  assert.equal(applyCheckpoint(p,collision,'冲突'),false); assert.deepEqual(p,before);
  assert.equal(applyCheckpoint(p,plan,'  交给试读前  '),true);
  const saved=copy(p);
  assert.equal(applyCheckpoint(p,plan,'重复'),false); assert.deepEqual(p,saved);
  assert.equal(p.versions.at(-1).label,'交给试读前');
});

test('checkpoint captures saved text only and preserves opinions, editor baseline, existing reports and history',()=>{
  const p=fixture(), plan=prepareCheckpoint(p);
  p.pendingEdits[0].after='新建议';
  p.versions[0].label='旧存稿新名称';
  const before=copy(p);
  assert.equal(applyCheckpoint(p,plan,'检查点'),true);
  const last=p.versions.at(-1);
  assert.equal(last.title,before.title); assert.deepEqual(last.chapters,before.chapters);
  assert.ok(Number.isFinite(Date.parse(last.date)));
  assert.equal(last.id,plan.versionId);
  const {versions,updatedAt,...rest}=p;
  const {versions:oldVersions,updatedAt:oldDate,...oldRest}=before;
  assert.deepEqual(rest,oldRest); assert.deepEqual(versions.slice(0,-1),oldVersions);
  assert.equal(updatedAt,last.date);
  p.chapters[0].body='后续正文'; plan.chapters[1].body='篡改预览';
  assert.deepEqual(last.chapters,before.chapters);
});

test('separate checkpoints of unchanged text remain distinct and survive local persistence',()=>{
  const p=fixture(); delete p.runtime; p.runtimeHistory=[];
  const state=createInitialState(); state.projects=[p]; state.activeProjectId=p.id;
  const one=prepareCheckpoint(p); assert.equal(applyCheckpoint(p,one,'同名存稿'),true);
  const two=prepareCheckpoint(p); assert.equal(applyCheckpoint(p,two,'同名存稿'),true);
  assert.notEqual(one.versionId,two.versionId);
  const data=new Map(), storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
  assert.deepEqual(saveState(state,storage),{ok:true});
  const loaded=loadState(storage).projects.find(item=>item.id===p.id);
  assert.deepEqual(loaded.versions,p.versions);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.pendingEdits)),p.pendingEdits);
  assert.deepEqual(loaded.editorBaseline,p.editorBaseline);
});
