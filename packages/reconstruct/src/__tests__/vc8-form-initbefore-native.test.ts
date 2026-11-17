import {it} from 'node:test';
import assert from 'node:assert/strict';
import {compileAndRun,hasNativeGpp} from '../../../cpp-parser/src/testing/native-cpp.js';
import {fixture,generated} from './initbefore-animdata.fixture.js';
const prelude=`
#include <cstdlib>
#define __fastcall
struct D2UnitStrc { int marker; };
struct D2InventoryStrc { int marker; };
struct D2AnimDataRecordStrc { int marker; };
struct D2AnimDataStrc { D2AnimDataRecordStrc pDefaultRecord; };
static D2AnimDataRecordStrc found;
static D2AnimDataStrc data;
static D2UnitStrc *expectedUnit;
static D2InventoryStrc *expectedInventory;
static uint32_t expectedClass,expectedMode,expectedWeapon;
static unsigned scenario,calls;
static void require(bool ok) { if(!ok) std::abort(); }
static unsigned char byteAt(unsigned i) { return i < scenario%9 ? static_cast<unsigned char>(scenario*37+i*53) : 0; }
namespace D2Common { namespace COMPOSIT { namespace Composit {
void COMPOSIT_BuildCofPath(D2UnitStrc *u,uint32_t c,uint32_t m,uint32_t w,D2InventoryStrc *inv,char *out,int32_t *value,int full,uint32_t special) {
  require(calls++==0 && u==expectedUnit && inv==expectedInventory);
  require(c==expectedClass && m==expectedMode && w==expectedWeapon && full==0 && special==1 && *value==0);
  for(unsigned i=0;i<8;i++)require(out[i]==0);
  for(unsigned i=0;i<8;i++)out[i]=static_cast<char>(byteAt(i));
  *value=static_cast<int32_t>(scenario)-2048;
}
}} namespace DATATBLS { namespace AnimTbls {
D2AnimDataRecordStrc *ANIMDATA_GetRecordByNameHash(char *name) {
  require(calls++==1);
  for(unsigned i=0;i<8;i++)require(static_cast<unsigned char>(name[i])==byteAt(i));
  return scenario%3 ? &found : nullptr;
}
} namespace DataTbls {
D2AnimDataStrc *TXT_AnimTbls_Get() {require(calls++==2);return &data;}
}}}
`;
const original=generated().replace(/\bANIMDATA_GetAnimDataForUnit\b/g,'original');
const candidate=generated(fixture.tag).replace(/\bANIMDATA_GetAnimDataForUnit\b/g,'candidate');
for(const optimize of[false,true])it(`preserves actual AnimData buffer/output/call behavior (${optimize?'optimized':'unoptimized'})`,{skip:!hasNativeGpp()},()=>{
  const result=compileAndRun(prelude+'\n'+original+'\n'+candidate,`
    D2UnitStrc unit={7}; D2InventoryStrc inventory={11};
    for(scenario=0;scenario<4096;scenario++) {
      expectedUnit=scenario&1?&unit:nullptr;expectedInventory=scenario&2?&inventory:nullptr;
      expectedClass=0xffffffffu-scenario;expectedMode=scenario*13;expectedWeapon=scenario^0x80000000u;
      calls=0;D2AnimDataRecordStrc *a=original(expectedUnit,expectedClass,expectedMode,expectedWeapon,expectedInventory);
      const unsigned oldCalls=calls;
      calls=0;D2AnimDataRecordStrc *b=candidate(expectedUnit,expectedClass,expectedMode,expectedWeapon,expectedInventory);
      require(a==b && b==(scenario%3?&found:&data.pDefaultRecord));
      require(calls==oldCalls && calls==(scenario%3?2u:3u));
    }
    std::puts("4096 AnimData cases passed");
  `,{optimize});
  assert.equal(result.trim(),'4096 AnimData cases passed');
});
