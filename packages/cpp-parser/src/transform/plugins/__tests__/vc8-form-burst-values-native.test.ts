import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormTables } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';
const tables: Vc8FormTables = { typedefTargets: { uint32_t: 'uint', uint16_t: 'ushort', int32_t: 'int' },
  functionParamTypes: { Capture: ['int'] }, structFields: { Payload: { level: 'int' } } };
function transformed(input: string, tag: string) {
  const ast = parse(input); let applied = false;
  const after = emit(applyVc8Forms(ast, [{ form: parseVc8Form(tag)! }], s => { applied = s.applied; }, tables));
  assert.ok(applied); return { before: emit(ast), after };
}
for (const optimize of [false, true]) {
  const level = optimize ? 'O2' : 'O0';
  it(`preserves every low half with boundary high halves and signed/truncated coordinates (${level})`, { skip: !hasNativeGpp() }, () => {
    const pair = transformed('uint32_t Pack(int x,int y) { return (uint32_t)(uint16_t)y << 16 | (uint32_t)(uint16_t)x; }', 'packadd(x,y)');
    const prelude = `#include <climits>
      #include <cstdlib>
      static_assert(sizeof(int)==4 && sizeof(uint16_t)==2 && sizeof(uint32_t)==4,"fixed target integer widths");
      namespace Before { ${pair.before} }
      namespace After { ${pair.after} }
      unsigned checks;
      void Check(int x,int y){uint32_t expected=((uint32_t)(uint16_t)y<<16)|(uint32_t)(uint16_t)x;
        if(Before::Pack(x,y)!=expected||After::Pack(x,y)!=expected)std::abort();checks++;}`;
    const body = `int edge[]={INT_MIN,-65536,-65535,-32769,-32768,-1,0,1,32767,32768,65535,65536,INT_MAX};
      for(int x:edge)for(int y:edge)Check(x,y);
      int high[]={0,1,32767,32768,65535};
      for(unsigned x=0;x<65536;x++)for(int y:high)Check((int)x,y);
      uint32_t state=0x9e3779b9u;
      for(unsigned i=0;i<65536;i++){state=state*1664525u+1013904223u;int x=(int)(state&0x7fffffffu)-0x40000000;
        state=state*1664525u+1013904223u;int y=(int)(state&0x7fffffffu)-0x40000000;Check(x,y);}
      printf("checks=%u\\n",checks);`;
    assert.equal(compileAndRun(prelude, body, { optimize, flags: ['-ftrapv'] }), 'checks=393385\n');
  });
  it(`preserves old-value captures, constant rejection and destructor/call trace (${level})`, { skip: !hasNativeGpp() }, () => {
    const pair = transformed('int Count(int32_t level,uint32_t count) { Capture(level); Payload p; p.level=level; level=count; if((int)count<=0)return 1; Capture(level); return level; }', 'delay(level,(int)count <= 0)');
    const trace = `static int values[4];static unsigned n;
      void Capture(int value){if(n==4)std::abort();values[n++]=value;}
      struct Payload{int level;~Payload(){Capture(level);}};`;
    const prelude = `#include <climits>
      #include <cstdlib>
      static_assert(sizeof(int)==4 && INT_MAX==2147483647,"fixed target signed domain");
      namespace Before { ${trace} ${pair.before} }
      namespace After { ${trace} ${pair.after} }
      unsigned checks;
      void Check(int level,uint32_t count){Before::n=After::n=0;
        int a=Before::Count(level,count),b=After::Count(level,count);
        bool positive=count>0 && count<=(uint32_t)INT_MAX;
        if(a!=b||b!=(positive?(int)count:1)||Before::n!=(positive?3u:2u)||Before::n!=After::n)std::abort();
        for(unsigned i=0;i<Before::n;i++)if(Before::values[i]!=After::values[i])std::abort();
        if(After::values[0]!=level||After::values[After::n-1]!=level||(positive&&After::values[1]!=(int)count))std::abort();checks++;}`;
    const body = `int levels[]={INT_MIN,-65536,-1,0,1,65535,INT_MAX};
      uint32_t counts[]={0u,1u,2u,0x7fffffffu,0x80000000u,0xffffffffu};
      for(int level:levels)for(uint32_t count:counts)Check(level,count);
      uint32_t state=0x12345678u;
      for(unsigned i=0;i<65536;i++){state=state*1664525u+1013904223u;int level=(int)(state&0x7fffffffu)-0x40000000;
        state=state*1664525u+1013904223u;Check(level,state);}
      printf("checks=%u\\n",checks);`;
    assert.equal(compileAndRun(prelude, body, { optimize, flags: ['-ftrapv'] }), 'checks=65578\n');
  });
}
