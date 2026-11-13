import {it} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../../../parser/index.js';
import {emit} from '../../../emit/index.js';
import type {AnyNode,TranslationUnit} from '../../../ast/nodes.js';
import {applyVc8Forms,parseVc8Form,type Vc8FormSite,type Vc8FormTables} from '../builtins/vc8-form.js';

const tables:Vc8FormTables={
  structFields:{Record:{size:'unsigned int',data:'unsigned char*',byte:'unsigned char'}},
  structLayouts:{Record:[{name:'size',offset:0,size:4,type:'unsigned int'},
    {name:'data',offset:4,size:4,type:'unsigned char*'},{name:'byte',offset:8,size:1,type:'unsigned char'}]},
};
const code=`void f(Record* initial,int n) {
  Record* p = initial;
  unsigned int* size;
  for (; n; n -= 8 + *size) {
    p->data = (unsigned char*)&p->byte;
    consume(p->byte);
    size = &p->size;
    p = (Record*)(&p->byte + *size);
  }
}`;
function run(source=code,tag='recordwalk(p)',options=tables){
  const form=parseVc8Form(tag);assert.ok(form,tag);
  const sites:Vc8FormSite[]=[];
  const input=parse(source) as TranslationUnit;
  const result=applyVc8Forms(input,[{form,tag}],s=>sites.push(s),options);
  return {text:emit(result as AnyNode),before:emit(input as AnyNode),site:sites[0],result};
}
it('parses a pointer and optional one-based site',()=>{
  assert.deepEqual(parseVc8Form('recordwalk(p)'),{op:'recordwalk',name:'p',index:0});
  assert.deepEqual(parseVc8Form('recordwalk(p,2)'),{op:'recordwalk',name:'p',index:2});
  for(const text of ['recordwalk()','recordwalk(p.x)','recordwalk(p,-1)','recordwalk(p,@2)','recordwalk(p,1,2)'])assert.equal(parseVc8Form(text),undefined);
});
it('carries the byte cursor and binds the typed view at each loop entry',()=>{
  const out=run();assert.ok(out.site.applied,out.site.why);
  assert.match(out.text,/unsigned char\* pRecordCursor;/);
  assert.match(out.text,/pRecordCursor = \(unsigned char\*\)p;/);
  assert.match(out.text,/p = \(Record\*\)pRecordCursor;/);
  assert.match(out.text,/pRecordCursor = \(unsigned char\*\)&p->byte;/);
  assert.match(out.text,/p->data = pRecordCursor;/);
  assert.match(out.text,/size = &p->size;\s*pRecordCursor \+= \*size;/);
  assert.doesNotMatch(out.text,/p = \(Record\*\)\(&p->byte/);
  assert.equal(out.before,emit(parse(code) as AnyNode),'input AST remains untouched');
});
it('refuses a second application without changing the first result',()=>{
  const once=run();assert.ok(once.site.applied);
  const twice=run(once.text);assert.equal(twice.site.applied,false);assert.equal(twice.text,once.text);
});
it('uses a fresh cursor name',()=>{
  const out=run(code.replace('unsigned int* size;','unsigned int* size; int pRecordCursor;'));
  assert.ok(out.site.applied,out.site.why);assert.match(out.text,/unsigned char\* pRecordCursor2;/);
});
it('allows an existing jump past the loop without adding a skipped initializer',()=>{
  const source=code.replace('  for (;','  if (n == 0) goto done;\n  for (;').replace('\n}', '\ndone: return;\n}');
  const out=run(source);assert.ok(out.site.applied,out.site.why);
  assert.match(out.text,/unsigned char\* pRecordCursor;\s*pRecordCursor =/);
});
it('accepts a known pointer passed by value',()=>{
  const out=run(code.replace('consume(p->byte)','consume(p)'),undefined,{...tables,functionParamTypes:{consume:['Record*']}});
  assert.ok(out.site.applied,out.site.why);
});
it('accepts the emitted unnamed byte alias only with the header member set',()=>{
  const options:Vc8FormTables={...tables,
    structLayouts:{Record:tables.structLayouts!.Record.map(f=>f.name==='byte'?{...f,name:'',type:'undefined'}:f)},
    aggregateMembers:{Record:['size','data','field_0x8']}};
  const source=code.replace(/->byte/g,'->field_0x8');
  assert.ok(run(source,undefined,options).site.applied);
  assert.equal(run(source,undefined,{...options,aggregateMembers:{Record:[]}}).site.applied,false);
});


const refusalCases: Array<[string, string, Vc8FormTables?]> = [
  ['unknown layout', code, {}],
  ['union record', code, {...tables, unionNames:['Record']}],
  ['indeterminate incoming pointer on a zero-trip loop', code.replace('p = initial','p'), tables],
  ['conditionally initialized pointer', code.replace('Record* p = initial;', 'Record* p; if (n) p = initial;'), tables],
  ['advanced pointer returned', code.replace('void f(', 'Record* f(').replace(/\n}$/, '\nreturn p;\n}'), tables],
  ['advanced pointer used in a later branch', code.replace(/\n}$/, '\nif (n) consume(p);\n}'), {...tables,functionParamTypes:{consume:['Record*']}}],
  ['loop condition reads the pointer', code.replace('for (; n;', 'for (; p;'), tables],
  ['loop increment reads the pointer', code.replace('n -= 8 + *size','n -= p->size'), tables],
  ['loop initializer writes the pointer', code.replace('for (; n;', 'for (p = initial; n;'), tables],
  ['static pointer', code.replace('Record* p = initial','static Record* p = initial'), tables],
  ['shadowed pointer', code.replace('consume(p->byte);','{ Record* p = initial; consume(p->byte); }'), tables],
  ['const pointee', code.replace('Record* p = initial','const Record* p = initial'), tables],
  ['volatile typedef pointee', code.replace('Record* p = initial','VolatileRecord* p = initial'), {...tables,typedefTargets:{VolatileRecord:'volatile Record'}}],
  ['volatile byte field', code, {...tables,structFields:{Record:{...tables.structFields!.Record,byte:'volatile unsigned char'}}}],
  ['const pointer member', code, {...tables,structFields:{Record:{...tables.structFields!.Record,data:'unsigned char* const'}}}],
  ['wide address cast', code.replace(/\(unsigned char\*\)&p->byte/g,'(unsigned int*)&p->byte'), tables],
  ['wide payload field', code, {...tables,structLayouts:{Record:tables.structLayouts!.Record.map(f=>f.name==='byte'?{...f,size:4,type:'unsigned int'}:f)}}],
  ['bitfield address', code, {...tables,structLayouts:{Record:tables.structLayouts!.Record.map(f=>f.name==='byte'?{...f,bitSize:1}:f)}}],
  ['array payload field', code, {...tables,structLayouts:{Record:tables.structLayouts!.Record.map(f=>f.name==='byte'?{...f,type:'unsigned char[1]'}:f)}}],
  ['different stored interior address', code.replace('p->data = (unsigned char*)&p->byte','p->data = (unsigned char*)&p->size'), tables],
  ['no matching member store', code.replace('p->data = (unsigned char*)&p->byte;', ''), tables],
  ['duplicate matching store', code.replace('consume(p->byte);','p->data = (unsigned char*)&p->byte;'), tables],
  ['unknown integer step', code.replace('&p->byte + *size','&p->byte + unknown(size)'), tables],
  ['extra pointer store', code.replace('consume(p->byte);','p = initial;'), tables],
  ['extra pointer increment', code.replace('consume(p->byte);','p++;'), tables],
  ['explicit address escape', code.replace('consume(p->byte);','escape(&p);'), tables],
  ['implicit reference call', code.replace('consume(p->byte);','consume(p);'), {...tables,functionParamTypes:{consume:['Record*&']}}],
  ['typedef reference call', code.replace('consume(p->byte);','consume(p);'), {...tables,functionParamTypes:{consume:['Alias']},typedefTargets:{Alias:'Record*&'}}],
  ['assignment lvalue reference captured before loop', code.replace('unsigned int* size;', 'unsigned int* size; capture(p = initial);'), {...tables,functionParamTypes:{capture:['Record*&']}}],
  ['prefix lvalue reference captured before loop', code.replace('unsigned int* size;', 'unsigned int* size; capture(++p);'), {...tables,functionParamTypes:{capture:['Record*&']}}],
  ['unknown pointer call', code.replace('consume(p->byte);','consume(p);'), tables],
  ['class conversion call', code.replace('consume(p->byte);','consume(p);'), {...tables,functionParamTypes:{consume:['RefHolder']}}],
  ['aggregate reference initializer', code.replace('consume(p->byte);','RefHolder holder = {p};'), tables],
  ['overloaded assignment may bind pointer reference', code.replace('consume(p->byte);','RefHolder holder; holder = p;'), tables],
  ['reference alias outside the loop', code.replace('unsigned int* size;', 'unsigned int* size; Record*& ref = p;'), tables],
  ['nested loop', code.replace('consume(p->byte);','while(n) consume(p->byte);'), tables],
  ['continue', code.replace('consume(p->byte);','if(n) continue;'), tables],
  ['break', code.replace('consume(p->byte);','if(n) break;'), tables],
  ['goto out of body', code.replace('consume(p->byte);','if(n) goto done;').replace(/\n}$/, '\ndone: return;\n}'), tables],
  ['alternate label entry', code.replace('consume(p->byte);','entered: consume(p->byte);'), tables],
];
for (const [name,source,options] of refusalCases) it(`refuses atomically: ${name}`,()=>{
  const out=run(source,'recordwalk(p)',options);
  assert.equal(out.site.applied,false,name);
  assert.ok(out.site.why,name);
  assert.equal(out.text,out.before,'refused form leaves the entire emitted tree unchanged');
});
it('accepts an incoming parameter and a commuted byte advance',()=>{
  const source=code.replace('Record* initial','Record* p').replace('  Record* p = initial;\n','').replace('&p->byte + *size','*size + &p->byte');
  const out=run(source);assert.ok(out.site.applied,out.site.why);
});
it('accepts a dead advanced pointer followed by an unconditional reset',()=>{
  const source=code.replace(/\n}$/, '\np = initial;\nconsume(p);\n}');
  assert.ok(run(source,undefined,{...tables,functionParamTypes:{consume:['Record*']}}).site.applied);
});
it('indexes multiple loops and refuses an ambiguous default or missing index',()=>{
  const loop=code.slice(code.indexOf('  for ('),code.lastIndexOf('\n}'));
  const source=code.replace(/\n}$/, '\np = initial;\n'+loop+'\n}');
  assert.equal(run(source).site.applied,false);
  for(const i of [1,2])assert.ok(run(source,`recordwalk(p,${i})`).site.applied,`site ${i}`);
  assert.equal(run(source,'recordwalk(p,3)').site.applied,false);
});
it('depends on names and layout facts rather than the motivating function',()=>{
  const source=code.replace(/\bRecord\b/g,'Chunk').replace(/\bp\b/g,'entry').replace(/\bbyte\b/g,'start').replace(/\bdata\b/g,'payload').replace(/\bsize\b/g,'length');
  const options:Vc8FormTables={structFields:{Chunk:{length:'unsigned int',payload:'unsigned char*',start:'unsigned char'}},
    structLayouts:{Chunk:tables.structLayouts!.Record.map(f=>({...f,offset:f.offset+64,name:({size:'length',data:'payload',byte:'start'} as Record<string,string>)[f.name]}))}};
  const out=run(source,'recordwalk(entry)',options);assert.ok(out.site.applied,out.site.why);
  assert.match(out.text,/entry = \(Chunk\*\)pRecordCursor/);assert.match(out.text,/pRecordCursor = \(unsigned char\*\)&entry->start/);
  assert.doesNotMatch(out.text,/\+ 24/);
});
