import {it} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../../../parser/index.js';
import {emit} from '../../../emit/index.js';
import type {FunctionDecl} from '../../../ast/nodes.js';
import {canSplitScalarParameter,type SplitLivesOptions} from '../builtins/split-lives.js';

const options:SplitLivesOptions={slots:[{name:'p',offset:4,size:4,isParameter:true}],
 functionReturnTypes:{Count:'int32_t'},functionParamTypes:{Use:['Item*'],Consume:['int32_t']}};
const source='void f(Item* p) { Use(p); p=(Item*)Count(); Consume((int)p); }';
function prove(code=source,given=options){
 const ast=parse(code),before=emit(ast);
 const result=canSplitScalarParameter(ast.declarations[0] as FunctionDecl,'p',given);
 assert.equal(emit(ast),before,'a proof must not mutate the actual function');return result;
}
it('permits deferral when the real later pass produces an integer local',()=>assert.equal(prove(),true));
it('refuses missing frame-slot evidence',()=>assert.equal(prove(source,{...options,slots:[]}),false));
it('refuses an untouched parameter even when another scalar lifetime splits',()=>{
 assert.equal(prove('void f(Item* p, Item* q) { Use(p); Use(q); q=(Item*)Count(); Consume((int)q); }',
  {...options,slots:[...options.slots!,{name:'q',offset:8,size:4,isParameter:true}]}),false);
});
it('refuses a parameter whose address escapes',()=>assert.equal(prove(source.replace('Use(p);','Use(p); Save(&p);')),false));
it('refuses a pointer life as evidence of an integer split',()=>{
 assert.equal(prove('void f(Item* p) { Use(p); p=(Item*)GetText(); ConsumeText((char*)p); }',
  {...options,functionReturnTypes:{GetText:'char*'},functionParamTypes:{Use:['Item*'],ConsumeText:['char*']}}),false);
});
