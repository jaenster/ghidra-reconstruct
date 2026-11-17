import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

for (const optimize of [false, true]) it(`preserves branch conversion, call traces and later code-variable lives (${optimize ? 'optimized' : 'unoptimized'})`, { skip: !hasNativeGpp() }, () => {
  const source = `uint32_t f(uint32_t flags, uint32_t code, int32_t version) {
    uint32_t t = code;
    Start(flags, code, version);
    if (flags & 1U) {
      t = 0x20726165;
    } else {
      t = Read(code);
      if (version <= 92 && t == 0x2063656e) t = 0x2067656e;
    }
    uint32_t result = Convert(t);
    After(result);
    t = 0;
    if (!(flags & 2U)) t = Sockets(code);
    return result ^ t;
  }`;
  const ast = parse(source), sites: Vc8FormSite[] = [];
  const after = emit(applyVc8Forms(ast, [{ form: parseVc8Form('dup(uint32_t result = Convert(t))')! }], s => sites.push(s)));
  assert.equal(sites.length, 1);
  assert.ok(sites[0].applied, sites[0].why);
  const prelude = `#include <cstdlib>
    struct Event { uint32_t kind, argument, state; };
    static Event trace[8]; static unsigned count, conversions, checks; static uint32_t state;
    void Log(uint32_t kind,uint32_t argument){if(count==8)std::abort();trace[count++]={kind,argument,state};}
    void Start(uint32_t flags,uint32_t code,int32_t version){state=flags^code^(uint32_t)version;Log(1,flags);}
    uint32_t Read(uint32_t code){state=state*1664525u+1013904223u;Log(2,code);return code;}
    uint32_t Convert(uint32_t code){++conversions;state^=code;Log(3,code);return code+state;}
    void After(uint32_t result){state=state*33u+result;Log(4,result);}
    uint32_t Sockets(uint32_t code){state^=code;Log(5,code);return (code+state)&7u;}
    namespace Before { ${emit(ast)} }
    namespace AfterCode { ${after} }
    void Reset(){count=conversions=0;state=0;std::memset(trace,0,sizeof(trace));}
    bool Check(uint32_t flags,uint32_t code,int32_t version){
      Reset();uint32_t expected=Before::f(flags,code,version);Event events[8];std::memcpy(events,trace,sizeof(trace));
      unsigned expectedCount=count,expectedConversions=conversions;uint32_t expectedState=state;
      Reset();uint32_t actual=AfterCode::f(flags,code,version);
      if(expected!=actual || expectedCount!=count || expectedConversions!=1 || conversions!=1 || expectedState!=state || std::memcmp(events,trace,sizeof(trace)))return false;
      ++checks;return true;
    }
  `;
  const body = `
    for(uint32_t code=0;code<65536;code++)for(uint32_t flags=0;flags<4;flags++)if(!Check(flags,code,92))return 1;
    const uint32_t codes[]={0,0x20726165u,0x2063656eu,0x2067656eu,1,0x7fffffffu,0x80000000u,0xffffffffu};
    const int32_t versions[]={0,91,92,93,INT32_MAX,INT32_MIN};
    for(uint32_t code:codes)for(int32_t version:versions)for(uint32_t flags=0;flags<4;flags++)if(!Check(flags,code,version))return 2;
    std::printf("checks=%u\\n",checks);
  `;
  assert.equal(compileAndRun(prelude, body, { optimize }), 'checks=262336\n');
});
