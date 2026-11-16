import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

for (const optimize of [false, true]) it(`preserves signed-add boundaries and the complete call-value trace (${optimize ? 'O2' : 'O0'})`, { skip: !hasNativeGpp() }, () => {
  const before: string[] = [], after: string[] = [];
  for (const [name, delta] of [['Plus', '3'], ['Minus', '-3']]) {
    const ast = parse(`void ${name}(int start) { int value = start; Capture(value); value += ${delta}; Capture(value); Capture(value); Capture(value); Capture(value); }`);
    const form = parseVc8Form('split(value,int,nFinal,add)')!; let applied = false;
    before.push(emit(ast));
    after.push(emit(applyVc8Forms(ast, [{ form }], s => { applied = s.applied; }, { functionParamTypes: { Capture: ['int'] } })));
    assert.ok(applied);
  }
  const recorder = 'static int trace[8]; static unsigned count; void Capture(int value) { if(count==8)std::abort(); trace[count++]=value; }';
  const prelude = `#include <climits>
    #include <cstdlib>
    static_assert(sizeof(int)==4,"target signed int width");
    namespace Before { ${recorder} ${before.join('\n')} }
    namespace After { ${recorder} ${after.join('\n')} }
    static unsigned checks;
    void Check(int value,int delta) {
      if((delta==3 && value>INT_MAX-3)||(delta==-3 && value<INT_MIN+3))return;
      Before::count=After::count=0;
      if(delta==3){Before::Plus(value);After::Plus(value);}else{Before::Minus(value);After::Minus(value);}
      if(Before::count!=5||After::count!=5)std::abort();
      for(unsigned i=0;i<5;i++)if(Before::trace[i]!=After::trace[i]||After::trace[i]!=(i?value+delta:value))std::abort();
      checks++;
    }`;
  const body = `int boundaries[]={INT_MIN,INT_MIN+1,INT_MIN+2,-10,-3,0,3,10,INT_MAX-3,INT_MAX-2,INT_MAX-1,INT_MAX};
    for(unsigned i=0;i<sizeof(boundaries)/sizeof(boundaries[0]);i++){Check(boundaries[i],3);Check(boundaries[i],-3);}
    uint32_t state=0x12345678u;
    for(unsigned i=0;i<65536;i++){state=state*1664525u+1013904223u;int value=(int)(state&0x7fffffffu)-0x40000000;Check(value,3);Check(value,-3);}
    printf("checks=%u\\n",checks);`;
  assert.equal(compileAndRun(prelude, body, { optimize, flags: ['-ftrapv'] }), 'checks=131090\n');
});
