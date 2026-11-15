import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { createArrayMaskClearTransformer, type ArrayMaskClearOptions } from '../builtins/array-mask-clear.js';
import { subpieceAccessPlugin } from '../builtins/subpiece-access.js';
import { typeNormalizePlugin } from '../builtins/type-normalize.js';

const store = '*(uint32_t*)((char*)&words + 60) &= 0xffff;';
const source = `void f() { uint16_t words[32]; ${store} Observe(words); }`;
function run(s = source, options: ArrayMaskClearOptions = {littleEndian:true}) {
  const sites: Array<{function:string;name:string;index:number}> = [], ast = parse(s), before = emit(ast);
  const out = emit(createArrayMaskClearTransformer({...options,onArrayMaskClear:s=>sites.push(s)})(ast) as never);
  assert.equal(emit(ast),before,'the input AST stays unchanged');
  return {before,out,sites};
}
function refuse(s = source, options?: ArrayMaskClearOptions) {
  const r=run(s,options);assert.equal(r.out,r.before);assert.deepEqual(r.sites,[]);
}
describe('typed array masked-word clear',()=>{
  it('writes only the upper word of the named in-bounds dword',()=>{
    const r=run();assert.match(r.out,/words\[31\] = 0;/);assert.doesNotMatch(r.out,/uint32_t\*/);
    assert.deepEqual(r.sites,[{function:'f',name:'words',index:31}]);
  });
  it('handles an explicit assignment from the same masked slice',()=>{
    const r=run(source.replace(store,'*(uint32_t*)((char*)&words + 60) = *(uint32_t*)((char*)&words + 60) & 65535;'));
    assert.match(r.out,/words\[31\] = 0;/);assert.equal(r.sites.length,1);
  });
  it('handles an offset-zero slice without address arithmetic',()=>{
    const r=run(source.replace('(char*)&words + 60','(char*)&words'));
    assert.match(r.out,/words\[1\] = 0;/);
  });
  it('keeps surrounding calls in their original order',()=>{
    const r=run(source.replace(store,`Before(words); /* terminator */ ${store} /* done */ After(words);`));
    assert.match(r.out,/Before\(words\);\s*words\[31\] = 0;\s*After\(words\);/);
  });
  it('lowers the actual raw SUBPIECE after canonical WCHAR normalization',()=>{
    const ast=parse('void f() { WCHAR words[32]; words._60_4_ = words._60_4_ & 0xffff; Use(words); }');
    const normalized=typeNormalizePlugin.createTransformer({})(ast);
    const after=emit(subpieceAccessPlugin.createTransformer({littleEndian:true})(normalized) as never);
    assert.match(after,/uint16_t words\[32\]/);assert.match(after,/words\[31\] = 0/);
  });
  it('keeps the existing SUBPIECE fallback without an endian fact',()=>{
    const ast=parse('void f() { uint16_t words[32]; words._60_4_ &= 0xffff; }');
    const after=emit(subpieceAccessPlugin.createTransformer({})(ast) as never);
    assert.match(after,/uint32_t\*/);assert.doesNotMatch(after,/words\[31\] = 0/);
  });
  for(const options of [{},{littleEndian:false}])it(`refuses endian options ${JSON.stringify(options)}`,()=>refuse(source,options));
  for(const type of ['volatile uint16_t','const uint16_t','int16_t','uint32_t','uint8_t','Word','Other::uint16_t'])it(`refuses element type ${type}`,()=>refuse(source.replace('uint16_t words',`${type} words`)));
  for(const size of ['31','1','0','COUNT','sizeof(data)'])it(`refuses unproven/out-of-range bound ${size}`,()=>refuse(source.replace('words[32]',`words[${size}]`)));
  for(const offset of ['59','62','64','-2','offset','NextOffset()'])it(`refuses offset ${offset}`,()=>refuse(source.replace('+ 60',`+ ${offset}`)));
  for(const mask of ['0','0xff','0xff00','0xffff0000','0xffffffff','Mask()','MASK','(uint16_t)0xffff'])it(`refuses mask ${mask}`,()=>refuse(source.replace('0xffff',mask)));
  for(const type of ['volatile uint32_t*','uint16_t*','int32_t*','Other::uint32_t*'])it(`refuses access type ${type}`,()=>refuse(source.replace('(uint32_t*)',`(${type})`)));
  for(const spec of ['static','extern'])it(`refuses ${spec} storage`,()=>refuse(source.replace('uint16_t words',`${spec} uint16_t words`)));
  it('refuses a parameter array whose actual extent is unknown',()=>refuse(`void f(uint16_t words[32]) { ${store} }`));
  it('refuses a global or pointer base',()=>{
    refuse(`void f() { ${store} }`);
    refuse(source.replace('uint16_t words[32]','uint16_t* words'));
  });
  it('supports a nested array only inside its declared scope',()=>{
    assert.match(run(`void f() { { uint16_t words[32]; ${store} } }`).out,/words\[31\] = 0/);
    refuse(`uint32_t words[16]; void f() { { uint16_t words[32]; Observe(words); } ${store} }`);
  });
  it('refuses a global reference preceding a later local declaration',()=>{
    refuse(`uint32_t words[16]; void f() { ${store} uint16_t words[32]; Observe(words); }`);
  });
  it('refuses shadowed array bindings',()=>{
    refuse(source.replace('Observe(words);','{ uint16_t words[32]; Observe(words); }'));
  });
  it('refuses local type definitions that could hide a canonical type',()=>refuse(source.replace('uint16_t words[32];','typedef Other uint16_t; uint16_t words[32];')));
  it('refuses a local enum hiding the canonical 16-bit type',()=>refuse(source.replace('uint16_t words[32];','enum uint16_t { ZERO }; uint16_t words[32];')));
  it('refuses side-effecting or nonlocal address expressions',()=>{
    refuse(source.replace('&words','&Next()->words'));
    refuse(source.replace('&words','&object.words'));
    refuse(source.replace('(char*)&words','(char*)words'));
  });
  it('refuses a value-consuming assignment in a call, return or declaration',()=>{
    const expression=store.slice(0,-1);
    refuse(source.replace(store,`Use(${expression});`));
    refuse(source.replace(store,`return (${expression});`));
    refuse(source.replace(store,`uint32_t result = (${expression});`));
  });
  it('refuses mismatched explicit reads and other compound operators',()=>{
    refuse(source.replace(store,'*(uint32_t*)((char*)&words + 60) = *(uint32_t*)((char*)&words + 56) & 0xffff;'));
    refuse(source.replace('&=','|='));
  });
  it('handles two independent clears without changing declarations',()=>{
    const r=run(source.replace(store,store+' *(uint32_t*)(char*)&words &= 0xffff;'));
    assert.equal(r.sites.length,2);assert.match(r.out,/words\[31\] = 0/);assert.match(r.out,/words\[1\] = 0/);
    assert.equal((r.out.match(/uint16_t words\[32\]/g)??[]).length,1);
  });
});
