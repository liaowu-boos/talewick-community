import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultFull15Input, full15InputFromRequestSpec } from './full15-input.mjs';

test('old manuscripts default to applicable checks without inventing length or corpus coverage',()=>{
 assert.deepEqual(defaultFull15Input(),{requirements:{c05_applicable:false},references:{sources:[]},profile:'no_corpus'});
});

test('new manuscripts translate only saved neutral count fields and explicit C05 choice',()=>{
 assert.deepEqual(full15InputFromRequestSpec({requirements:{targetHanMin:3000,targetHanMax:5000,targetChapterCount:4,usesChapter4Cut:true,summary:'not forwarded'}}),{requirements:{count_basis:'han',c05_applicable:true,min_body_length:3000,max_body_length:5000,min_chapters:4,max_chapters:4},references:{sources:[]},profile:'no_corpus'});
 assert.deepEqual(full15InputFromRequestSpec(null),defaultFull15Input());
});
