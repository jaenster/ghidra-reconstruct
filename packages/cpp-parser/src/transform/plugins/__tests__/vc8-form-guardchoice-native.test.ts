import {it} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../../../parser/index.js';
import {emit} from '../../../emit/index.js';
import {applyVc8Forms,parseVc8Form,type Vc8FormSite} from '../builtins/vc8-form.js';
import {compileAndRun,hasNativeGpp} from '../../../testing/native-cpp.js';

for(const optimize of [false,true])it(`preserves selected calls, slot identity, shared-tail entries and unwind traces (${optimize?'optimized':'unoptimized'})`,{skip:!hasNativeGpp()},()=>{
  const source=`unsigned int f(Context *ctx,int whole,int fraction){
    Remember(ctx,&whole,&fraction);
    Watch watcher=MakeWatch(ctx,&whole,&fraction);
    if(ctx->skip)goto tail;
    if(!whole){if(!fraction)return Reject(ctx,&whole,&fraction);}
    else if(!fraction){Step(ctx,0,&whole,&fraction);goto tail;}
    Step(ctx,1,&whole,&fraction);
    tail:Tail(ctx,&whole,&fraction);
    return Finish(ctx,whole,fraction);
  }`;
  const sites:Vc8FormSite[]=[],before=emit(parse(source)),after=emit(applyVc8Forms(parse(source),[{form:parseVc8Form('guardchoice(whole,fraction)')!}],s=>sites.push(s),{functionReturnTypes:{Step:'void'},functionParamTypes:{Step:['Context *','int','int *','int *']}}));assert.equal(sites.length,1);assert.ok(sites[0].applied,sites[0].why);
  const prelude=`#include <cstdlib>
    struct Event{uint32_t kind,a,b,state;};static Event events[16];static uint32_t count,checks;
    struct Context{uint32_t flags,state;bool skip;int *a,*b;};
    void Log(Context *c,uint32_t kind,int a,int b){if(count==16)std::abort();events[count++]={kind,(uint32_t)a,(uint32_t)b,c->state};c->state=c->state*33u+kind+(uint32_t)a*17u+(uint32_t)b;}
    void Identity(Context *c,int *a,int *b){if(c->a!=a||c->b!=b)std::abort();}
    void Remember(Context *c,int *a,int *b){c->a=a;c->b=b;Log(c,1,*a,*b);}
    struct Watch{Context *c;int *a,*b;~Watch(){Identity(c,a,b);Log(c,7,*a,*b);}};
    Watch MakeWatch(Context *c,int *a,int *b){Log(c,2,*a,*b);return Watch{c,a,b};}
    unsigned int Reject(Context *c,int *a,int *b){Identity(c,a,b);Log(c,3,*a,*b);if(c->flags&2u)throw 9;return c->state;}
    void Step(Context *c,int kind,int *a,int *b){Identity(c,a,b);Log(c,4u+(uint32_t)kind,*a,*b);if(c->flags&1u){*a^=0x12345678;*b^=0x10203040;}if(c->flags&2u)throw 7;}
    void Tail(Context *c,int *a,int *b){Identity(c,a,b);Log(c,6,*a,*b);}
    unsigned int Finish(Context *c,int a,int b){Log(c,8,a,b);return c->state;}
    namespace Before{${before}}namespace After{${after}}
    void Reset(){count=0;std::memset(events,0,sizeof(events));}
    bool Test(int whole,int fraction,uint32_t flags){
      Reset();Context a={flags,0x31415926u,(flags&4u)!=0,nullptr,nullptr};unsigned int expected=0;int expectedThrow=0;try{expected=Before::f(&a,whole,fraction);}catch(int n){expectedThrow=n;}
      Event saved[16];std::memcpy(saved,events,sizeof(events));uint32_t expectedCount=count,expectedState=a.state;
      Reset();Context b={flags,0x31415926u,(flags&4u)!=0,nullptr,nullptr};unsigned int actual=0;int actualThrow=0;try{actual=After::f(&b,whole,fraction);}catch(int n){actualThrow=n;}
      ++checks;return expected==actual&&expectedThrow==actualThrow&&expectedCount==count&&expectedState==b.state&&!std::memcmp(saved,events,sizeof(events));
    }
  `;
  const body=`for(int whole=0;whole<65536;whole++)for(int fraction=-9;fraction<=9;fraction++)for(uint32_t flags=0;flags<2;flags++)if(!Test(whole,fraction,flags))return 1;
    const int edges[]={(-2147483647-1),-2147483647,-1,0,1,2,2147483646,2147483647};for(int whole:edges)for(int fraction:edges)for(uint32_t flags=0;flags<8;flags++)if(!Test(whole,fraction,flags))return 2;
    std::printf("checks=%u\\n",checks);
  `;
  assert.equal(compileAndRun(prelude,body,{optimize}),'checks=2490880\n');
});
