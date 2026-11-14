import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

it('preserves wide comparison values and load order across native32bit count boundaries', { skip: !hasNativeGpp() }, () => {
  const input = `int f(uint16_t *a,uint16_t *b,int32_t count) {
    uint16_t y; uint16_t x=*a;
    while(x && (y=*b) && count) {
      a++; b++;
      if(x!=y)return x<y?-1:1;
      x=*a; count--;
    }
    return 0;
  }`;
  const form = parseVc8Form('postdec(count,nRemaining)')!;
  const ast = parse(input) as TranslationUnit;
  let applied = false;
  const after = emit(applyVc8Forms(ast, [{ form }], s => { applied = s.applied; }) as AnyNode);
  assert.ok(applied);
  assert.match(after, /unsigned int nRemaining/);
  const instrument = (text: string) => {
    assert.equal((text.match(/\*a\b/g) ?? []).length, 2);
    assert.equal((text.match(/\*b\b/g) ?? []).length, 1);
    return text.replace(/\*a\b/g, 'LoadA(a)').replace(/\*b\b/g, 'LoadB(b)');
  };
  const prelude = `#include <climits>
    #include <cstdlib>
    struct Read { unsigned stream,index; };
    static Read reads[32]; static unsigned nReads;
    static uint16_t *baseA,*baseB;
    uint16_t Load(uint16_t *p,uint16_t *base,unsigned stream) {
      if(!base || p<base || p>=base+4 || nReads==32)std::abort();
      reads[nReads++]={stream,(unsigned)(p-base)};return *p;
    }
    uint16_t LoadA(uint16_t *p){return Load(p,baseA,0);}
    uint16_t LoadB(uint16_t *p){return Load(p,baseB,1);}
    namespace Before { ${instrument(emit(ast as AnyNode))} }
    namespace After { ${instrument(after)} }
    static unsigned checks;
    bool Check(uint16_t *a,uint16_t *b,int32_t count) {
      baseA=a;baseB=b;nReads=0;
      int before=Before::f(a,b,count); unsigned nBefore=nReads;Read expected[32];
      std::memcpy(expected,reads,nBefore*sizeof(Read));nReads=0;
      int after=After::f(a,b,count);
      if(before!=after || nBefore!=nReads || std::memcmp(expected,reads,nReads*sizeof(Read)))return false;
      ++checks;return true;
    }
    void Word(uint16_t *out,unsigned n) {
      std::memset(out,0,8);unsigned len=0;
      for(unsigned k=1,power=1;k<=3;++k){unsigned block=power*3;if(n<block){len=k;break;}n-=block;power=block;}
      if(n==0 && len==0)return;
      const uint16_t alphabet[]={1,0x8000,0xffff};
      for(unsigned i=0;i<len;++i){out[i]=alphabet[n%3];n/=3;}
    }
  `;
  const body = `
    const int32_t counts[]={INT_MIN,-2,-1,0,1,2,3,INT_MAX-1,INT_MAX};
    uint16_t a[4]={0},b[4]={0};
    // All strings of lengths0..3 over three nonzero code units.
    for(unsigned i=0;i<40;++i)for(unsigned j=0;j<40;++j){
      if(i){Word(a,i-1);}else std::memset(a,0,8);
      if(j){Word(b,j-1);}else std::memset(b,0,8);
      for(int32_t n:counts)if(!Check(a,b,n))return 1;
    }
    const uint16_t pivots[]={0,1,0x7f,0xff,0x100,0x7fff,0x8000,0xd800,0xffff};
    for(unsigned c=0;c<65536;++c)for(uint16_t p:pivots){
      std::memset(a,0,8);std::memset(b,0,8);a[0]=(uint16_t)c;b[0]=p;
      for(int32_t n:counts)if(!Check(a,b,n))return 2;
    }
    a[0]=0;for(int32_t n:counts)if(!Check(a,nullptr,n))return 3;
    std::printf("checks=%u\\n",checks);
  `;
  // The untouched input's signed tail decrement has the target's wrapping
  // semantics for negative-count edges. The candidate's counter is unsigned.
  assert.equal(compileAndRun(prelude, body, { optimize: true, flags: ['-fwrapv'] }), 'checks=5322825\n');
});
