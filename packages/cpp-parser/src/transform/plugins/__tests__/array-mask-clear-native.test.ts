import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { createArrayMaskClearTransformer } from '../builtins/array-mask-clear.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

for (const optimize of [false,true]) it(`preserves the whole array against a memcpy byte reference (${optimize?'optimized':'unoptimized'})`, {skip:!hasNativeGpp()},()=>{
  const functions=[0,28,60].map(offset=>{
    const source=`void Clear${offset}(uint16_t low,uint16_t high,uint16_t* output) { uint16_t words[32]; Fill(words,low,high); *(uint32_t*)((char*)&words + ${offset}) &= 0xffff; Copy(output,words); }`;
    const sites:unknown[]=[],after=emit(createArrayMaskClearTransformer({littleEndian:true,onArrayMaskClear:s=>sites.push(s)})(parse(source)) as never);
    assert.equal(sites.length,1);assert.doesNotMatch(after,/uint32_t\*/);return after;
  }).join('\n');
  const prelude=`#include <cstdlib>
    static const uint16_t* lastArray; static uint32_t calls,checks;
    void Fill(uint16_t* p,uint16_t low,uint16_t high){if(calls!=0)std::abort();lastArray=p;++calls;for(unsigned i=0;i<32;i++)p[i]=(uint16_t)((i&1?high:low)^(uint16_t)(i*0x9e37u));}
    void Copy(uint16_t* out,const uint16_t* p){if(calls!=1||p!=lastArray)std::abort();++calls;std::memcpy(out,p,64);}
    ${functions}
    void Reference(uint16_t low,uint16_t high,uint16_t* output,unsigned offset){uint16_t words[32];Fill(words,low,high);uint32_t value;std::memcpy(&value,(char*)words+offset,4);value&=0xffffu;std::memcpy((char*)words+offset,&value,4);Copy(output,words);}
    bool Check(void(*fn)(uint16_t,uint16_t,uint16_t*),unsigned offset,uint16_t low,uint16_t high){
      uint16_t expected[32],actual[32];calls=0;Reference(low,high,expected,offset);if(calls!=2)return false;
      calls=0;fn(low,high,actual);if(calls!=2||std::memcmp(expected,actual,64))return false;++checks;return true;
    }
    bool All(uint16_t low,uint16_t high){return Check(Clear0,0,low,high)&&Check(Clear28,28,low,high)&&Check(Clear60,60,low,high);}
  `;
  const body=`
    for(uint32_t word=0;word<65536;word++)if(!All((uint16_t)word,0xffffu)||!All(0xffffu,(uint16_t)word))return 1;
    const uint16_t edge[]={0,1,0x7fff,0x8000,0xfffe,0xffff};for(uint16_t low:edge)for(uint16_t high:edge)if(!All(low,high))return 2;
    std::printf("checks=%u\\n",checks);
  `;
  assert.equal(compileAndRun(prelude,body,{optimize}),'checks=393324\n');
});
