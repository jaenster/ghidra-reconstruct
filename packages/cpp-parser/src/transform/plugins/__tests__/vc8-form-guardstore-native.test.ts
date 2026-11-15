import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

for (const optimize of [false, true]) it(`preserves aliased storage, callbacks and unwind observations (${optimize ? 'optimized' : 'unoptimized'})`, { skip: !hasNativeGpp() }, () => {
  const definitions: string[] = [];
  for (const [name, type] of [['Unsigned', 'uint32_t'], ['Signed', 'int32_t']]) {
    const source = `${type} f(Game *game, ${type} nSize, uint32_t code) {
      Remember(game, &nSize);
      Watch watcher = MakeWatch(game);
      nSize = Check(game, code);
      if (nSize != OK) return (${type})Observe(game, &nSize);
      Place(game, &nSize);
      return nSize;
    }`;
    const sites: Vc8FormSite[] = [], before = emit(parse(source));
    const after = emit(applyVc8Forms(parse(source), [{ form: parseVc8Form('guardstore(nSize,status)')! }], s => sites.push(s), {
      enumTypes: ['Status'], enumValues: { OK: 0 }, functionReturnTypes: { Check: 'Status' }, functionParamTypes: { Check: ['Game *', 'uint32_t'] },
    }));
    assert.equal(sites.length, 1); assert.ok(sites[0].applied, sites[0].why);
    definitions.push(`namespace Before${name} { ${before} } namespace After${name} { ${after} }`);
  }
  const prelude = `#include <cstdlib>
    enum Status { OK=0, HIGH=0x80000000u, LAST=0xffffffffu };
    struct Event { uint32_t kind,value,state; };
    static Event trace[16]; static uint32_t count,state,checks;
    struct Game { void *slot; uint32_t flags; };
    void Log(uint32_t kind,uint32_t value){if(count==16)std::abort();trace[count++]={kind,value,state};state=state*33u+value+kind;}
    uint32_t Read(Game *g){uint32_t n;std::memcpy(&n,g->slot,4);return n;}
    void Write(Game *g,uint32_t value){std::memcpy(g->slot,&value,4);}
    template<class T> void Remember(Game *g,T *p){g->slot=p;Log(1,Read(g));}
    struct Watch { Game *game; ~Watch(){Log(6,Read(game));} };
    Watch MakeWatch(Game *g){Log(2,Read(g));return Watch{g};}
    Status Check(Game *g,uint32_t code){Log(3,Read(g));if(g->flags&1u){Write(g,code^state);Log(4,Read(g));}if(g->flags&4u)throw 7;return (Status)code;}
    template<class T> uint32_t Observe(Game *g,T *p){if(g->slot!=p)std::abort();Log(5,Read(g));return Read(g);}
    template<class T> void Place(Game *g,T *p){if(g->slot!=p || Read(g)!=0)std::abort();Log(7,Read(g));Write(g,(g->flags&2u)?0xffffffffu:0x80000000u);Log(8,Read(g));}
    ${definitions.join('\n')}
    void Reset(){count=0;state=0x31415926u;std::memset(trace,0,sizeof(trace));}
    template<class T> bool Test(T (*before)(Game*,T,uint32_t),T (*after)(Game*,T,uint32_t),uint32_t initial,uint32_t code,uint32_t flags){
      Reset();Game a={nullptr,flags};T expected=0;bool expectedThrow=false;try{expected=before(&a,(T)initial,code);}catch(int n){if(n!=7)return false;expectedThrow=true;}
      Event events[16];std::memcpy(events,trace,sizeof(trace));uint32_t expectedCount=count,expectedState=state;
      Reset();Game b={nullptr,flags};T actual=0;bool actualThrow=false;try{actual=after(&b,(T)initial,code);}catch(int n){if(n!=7)return false;actualThrow=true;}
      if(expectedThrow!=actualThrow || expected!=actual || expectedCount!=count || expectedState!=state || std::memcmp(events,trace,sizeof(trace)))return false;
      ++checks;return true;
    }
    bool Both(uint32_t initial,uint32_t code,uint32_t flags){return Test(BeforeUnsigned::f,AfterUnsigned::f,initial,code,flags)&&Test(BeforeSigned::f,AfterSigned::f,initial,code,flags);}
  `;
  const body = `
    // Exhaust normal paths; unwind checks use the 32-bit boundary corpus below.
    for(uint32_t code=0;code<65536;code++)for(uint32_t flags=0;flags<4;flags++)for(uint32_t initial=9;initial<=10;initial++)if(!Both(initial,code,flags))return 1;
    const uint32_t edges[]={0,1,0x7fffffffu,0x80000000u,0xfffffffeu,0xffffffffu,0x55555555u,0xaaaaaaaau};
    for(uint32_t code:edges)for(uint32_t flags=0;flags<8;flags++)for(uint32_t initial:edges)if(!Both(initial,code,flags))return 2;
    std::printf("checks=%u\\n",checks);
  `;
  assert.equal(compileAndRun(prelude, body, { optimize }), 'checks=1049600\n');
});
