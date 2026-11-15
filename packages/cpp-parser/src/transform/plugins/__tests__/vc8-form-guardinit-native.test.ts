import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

for (const optimize of [false, true]) it(`preserves private copies, previous pointer lifetime and mutable packet counts (${optimize ? 'optimized' : 'unoptimized'})`, { skip: !hasNativeGpp() }, () => {
  const definitions: string[] = [];
  function add(name: string, source: string, tables: Vc8FormTables = {}) {
    const sites: Vc8FormSite[] = [], before = emit(parse(source));
    const after = emit(applyVc8Forms(parse(source), [{ form: parseVc8Form('guardinit(value)')! }], s => sites.push(s), tables));
    assert.equal(sites.length, 1); assert.ok(sites[0].applied, sites[0].why);
    definitions.push(`namespace Before${name} { ${before} } namespace After${name} { ${after} }`);
  }
  for (const [name, guard] of [['Flag','flag'], ['Truth','value'], ['Not','!value'], ['Mixed','(value & 7) == flag']]) add(name, `uint32_t f(uint32_t src, uint32_t flag) { uint32_t result = 0x31415926u; uint32_t value = src; if (${guard}) { result = value; value += flag; result ^= value; } return result; }`);
  add('Pointer', `uint32_t f(Packet *packet, uint32_t *src) {
    uint32_t result = 0;
    uint32_t *value = src;
    for (int j=0; j<3; j++) { result = result * 33u + *value; value++; }
    value = src;
    if ((uint16_t)packet->count > 0) {
      int i = 0;
      do { result = result * 33u + *value; value++; i++; Tick(packet, i); } while (i < (int)(uint16_t)packet->count);
    }
    return result;
  }`, { structFields: { Packet: { count: 'uint16_t' } } });
  add('PointerGuard', 'uint32_t f(uint32_t *src, uint32_t *end) { uint32_t result=5; uint32_t *value=src; if (value != end) result = *value; return result; }');
  const prelude = `struct Packet { uint16_t count; uint32_t mode,ticks,state; };
    void Tick(Packet *p,int i) { p->ticks++; p->state=p->state*33u+(uint32_t)i+p->count; if(i==1)p->count=(uint16_t)(p->mode+1); }
    ${definitions.join('\n')}
    uint32_t checks=0;
    bool Scalars(uint32_t src,uint32_t flag) { ${['Flag','Truth','Not','Mixed'].map(n=>`if(Before${n}::f(src,flag)!=After${n}::f(src,flag))return false; ++checks;`).join(' ')} return true; }
  `;
  const body = `const uint32_t edges[]={0,1,0x7fffffffu,0x80000000u,0xfffffffeu,0xffffffffu,0x55555555u,0xaaaaaaaau};
    for(uint32_t flag=0;flag<65536;flag++)for(uint32_t src:edges)if(!Scalars(src,flag))return 1;
    for(uint32_t flag:edges)for(uint32_t src:edges)if(!Scalars(src,flag))return 2;
    uint32_t data[]={0,1,0x80000000u,0xffffffffu,17,29,41,53};
    for(uint32_t count=0;count<65536;count++)for(uint32_t mode=0;mode<4;mode++){
      Packet a={(uint16_t)count,mode,0,7},b=a;
      if(BeforePointer::f(&a,data)!=AfterPointer::f(&b,data)||a.count!=b.count||a.ticks!=b.ticks||a.state!=b.state)return 3;
      ++checks;
    }
    for(uint32_t i=0;i<8;i++)for(uint32_t j=0;j<8;j++){if(BeforePointerGuard::f(data+i,data+j)!=AfterPointerGuard::f(data+i,data+j))return 4;++checks;}
    std::printf("checks=%u\\n",checks);
  `;
  assert.equal(compileAndRun(prelude, body, { optimize }), 'checks=2359616\n');
});
