import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormTables } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const tables: Vc8FormTables = {
  globalTypes: { a: 'int', b: 'int', c: 'int', d: 'int' },
  globalAddresses: { a: 4096, b: 4100, c: 4104, d: 4108 }, globalSizes: { a: 4, b: 4, c: 4, d: 4 },
  targetPointerSize: 4, targetLanguageId: 'x86:LE:32:default',
};
for (const optimize of [false, true]) {
  it(`preserves bound values and the following observer over the joint signed domain (${optimize ? 'O2' : 'O0'})`, { skip: !hasNativeGpp() }, () => {
    const extents = [[24, 24], [24, 19], [1, 1073741823], [1073741823, 1], [1073741823, 1073741823]];
    const scopes = extents.map(([kx, ky], index) => {
      const ast = parse(`void Bounds(int x,int y) { a=x-${kx}; b=y-${ky}; c=x+${kx}; d=y+${ky}; Observe(); }`);
      let applied = false;
      const transformed = emit(applyVc8Forms(ast, [{ form: parseVc8Form('bounds(a,b,c,d)')! }], s => { applied = s.applied; }, tables));
      assert(applied);
      const globals = 'int a,b,c,d; unsigned calls; int seen[4]; void Observe(){calls++;seen[0]=a;seen[1]=b;seen[2]=c;seen[3]=d;}';
      return `namespace Case${index} {
        namespace Before { ${globals} ${emit(ast)} }
        namespace After { ${globals} ${transformed} }
        void Check(int x,int y) {
          Before::calls=After::calls=0; Before::Bounds(x,y); After::Bounds(x,y);
          int64_t expected[]={(int64_t)x-${kx},(int64_t)y-${ky},(int64_t)x+${kx},(int64_t)y+${ky}};
          int values[]={After::a,After::b,After::c,After::d};
          if(Before::calls!=1 || After::calls!=1)std::abort();
          for(unsigned i=0;i<4;i++) if(expected[i]!=values[i] || Before::seen[i]!=values[i] || After::seen[i]!=values[i])std::abort();
          ::checks++;
        }
        int Draw(uint32_t &state,int extent){state=state*1664525u+1013904223u;
          int64_t low=(int64_t)INT_MIN+extent,high=(int64_t)INT_MAX-extent;
          return (int)(low+(state%(uint64_t)(high-low+1)));}
        void Run(){
          int xs[]={INT_MIN+${kx},INT_MIN+${kx}+1,-1,0,1,INT_MAX-${kx}-1,INT_MAX-${kx}};
          int ys[]={INT_MIN+${ky},INT_MIN+${ky}+1,-1,0,1,INT_MAX-${ky}-1,INT_MAX-${ky}};
          for(int x:xs)for(int y:ys)Check(x,y);
          uint32_t state=0x9e3779b9u;
          for(unsigned i=0;i<65536;i++){int x=Draw(state,${kx}),y=Draw(state,${ky});Check(x,y);}
        }
      }`;
    });
    const prelude = `#include <climits>
      #include <cstdlib>
      static_assert(sizeof(int)==4 && INT_MAX==2147483647,"bounds requires 32-bit int");
      unsigned checks;
      ${scopes.join('\n')}`;
    const body = extents.map((_, i) => `Case${i}::Run();`).join('\n') + '\nprintf("checks=%u\\n",checks);';
    assert.equal(compileAndRun(prelude, body, { optimize, flags: ['-ftrapv'] }), 'checks=327925\n');
  });
}
