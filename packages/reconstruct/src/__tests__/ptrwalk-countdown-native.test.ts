import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../cpp-parser/src/parser/index.js';
import { emit } from '../../../cpp-parser/src/emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../cpp-parser/src/ast/nodes.js';
import { applyVc8Forms, parseVc8Form } from '../../../cpp-parser/src/transform/plugins/builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../cpp-parser/src/testing/native-cpp.js';
import { countdownImplementation } from './fixtures/ptrwalk-countdown-codegen.js';

it('preserves the complete generated HSL function, float bits, rounding flags and ordered calls', { skip: !hasNativeGpp() }, () => {
  const before = countdownImplementation('none'), after = countdownImplementation('current');
  assert.match(after, /pdHSLEntry \+= 3/);
  const prelude = `#include <cfenv>
    #include <cstdlib>
    typedef unsigned char BYTE;
    struct D2HSLColorStrc { double dHue,dSaturation,dLightness; };
    struct tagRGBQUAD { BYTE rgbBlue,rgbGreen,rgbRed,rgbReserved; };
    struct tagPALETTEENTRY { BYTE peRed,peGreen,peBlue,peFlags; };
    typedef tagPALETTEENTRY* LPPALETTEENTRY;
    struct Trace { unsigned kind,a,b,c,n; };
    static Trace trace[260]; static unsigned nTrace; static LPPALETTEENTRY expectedPalette;
    namespace D2CMP { namespace Draw {
      void DRAW_ConvertPaletteHSLtoRGB(D2HSLColorStrc* in,BYTE* out) {
        unsigned digest=2166136261u;const BYTE* raw=(const BYTE*)in;
        for(unsigned k=0;k<256*sizeof(D2HSLColorStrc);++k)digest=(digest^raw[k])*16777619u;
        trace[nTrace++]={0,digest,0,0,0};
        for(unsigned i=0;i<256;++i){uint64_t bits;std::memcpy(&bits,&in[i].dLightness,8);
          out[i*4]=(BYTE)bits;out[i*4+1]=(BYTE)(bits>>16);out[i*4+2]=(BYTE)(bits>>40);out[i*4+3]=0;}
      }
      BYTE D2GFX_FindNearestPaletteIndex(LPPALETTEENTRY palette,uint32_t size,int32_t red,int32_t green,int32_t blue) {
        if(palette!=expectedPalette || size!=256 || nTrace>=257)std::abort();
        trace[nTrace++]={1,(unsigned)red,(unsigned)green,(unsigned)blue,size};
        return (BYTE)((unsigned)red*13u+(unsigned)green*7u+(unsigned)blue);
      }
    }}
    namespace Before { ${before} }
    namespace After { ${after} }
    static D2HSLColorStrc input[257],a[257],b[257];
    static tagPALETTEENTRY paletteA[3400],paletteB[3400];
    static Trace expected[260];
  `;
  const body = `
    const uint64_t patterns[]={0,0x8000000000000000ULL,1,0x8000000000000001ULL,
      0x3fc99999a0000000ULL,0x3fe9999997ffffffULL,0x3fe9999998000000ULL,
      0x3fefffffffffffffULL,0x3ff0000000000000ULL,0x3ff0000000000001ULL,
      0xbff0000000000000ULL,0x7ff0000000000000ULL,0xfff0000000000000ULL,
      0x7ff8000000000001ULL,0x7ff0000000000001ULL,0xfff8000000001234ULL};
    const int rounding[]={FE_TONEAREST,FE_DOWNWARD,FE_UPWARD,FE_TOWARDZERO};
    unsigned checks=0;
    for(unsigned seed=0;seed<4096;++seed){
      if(std::fesetround(rounding[seed&3]))return 1;
      for(unsigned i=0;i<257;++i)for(unsigned j=0;j<3;++j){
        uint64_t bits=patterns[(seed+i*7+j*11)%16];
        if(seed&16)bits^=(uint64_t)((seed*2654435761u+i*17u+j)&0xffffu);
        std::memcpy((BYTE*)&input[i]+j*8,&bits,8);
      }
      std::memcpy(a,input,sizeof input);std::memcpy(b,input,sizeof input);
      std::memset(paletteA,(int)(seed&255),sizeof paletteA);std::memcpy(paletteB,paletteA,sizeof paletteA);
      nTrace=0;expectedPalette=paletteA;std::feclearexcept(FE_ALL_EXCEPT);
      Before::DRAW_BuildBrightenLightnessTable(a,paletteA);
      int flags=std::fetestexcept(FE_ALL_EXCEPT);unsigned nExpected=nTrace;
      std::memcpy(expected,trace,sizeof expected);nTrace=0;expectedPalette=paletteB;std::feclearexcept(FE_ALL_EXCEPT);
      After::DRAW_BuildBrightenLightnessTable(b,paletteB);
      if(flags!=std::fetestexcept(FE_ALL_EXCEPT)||nExpected!=257||nTrace!=nExpected||
        std::memcmp(a,b,sizeof a)||std::memcmp(paletteA,paletteB,sizeof paletteA)||
        std::memcmp(expected,trace,nTrace*sizeof(Trace)))return 2;
      ++checks;
    }
    std::fesetround(FE_TONEAREST);std::printf("checks=%u\\n",checks);
  `;
  assert.equal(compileAndRun(prelude, body, { optimize: true }), 'checks=4096\n');
});

it('preserves every uint16 value over several record counts and untouched fields', { skip: !hasNativeGpp() }, () => {
  let functions = '';
  for (const n of [1,4,16]) {
    const code = `void f(WordRecord* rows) { int left=${n}; do {
      rows[${n}-left].value ^= (uint16_t)0xa55a; left--;
    } while(left); }`;
    const ast = parse(code) as TranslationUnit; let applied = false;
    const after = emit(applyVc8Forms(ast, [{ form: parseVc8Form('ptrwalk(left,rows,cursor,uint16_t)')! }],
      site => { applied = site.applied; }, {
        aggregateSizes: { WordRecord: 8 },
        structLayouts: { WordRecord: [{ name: 'value', type: 'uint16_t', offset: 2, size: 2 }] },
      }) as AnyNode);
    assert.ok(applied);
    functions += `namespace Before${n} { ${emit(ast as AnyNode)} } namespace After${n} { ${after} }\n`;
  }
  const prelude = `struct WordRecord { uint16_t head,value,tail,padding; };
    static_assert(sizeof(WordRecord)==8,"record stride");${functions}`;
  const body = `
    WordRecord a[17],b[17];unsigned checks=0;
    for(unsigned value=0;value<65536;++value){
      for(unsigned i=0;i<17;++i){a[i]={(uint16_t)(i^0x7777),(uint16_t)(value+i*67),0x1234,0xabcd};b[i]=a[i];}
      Before1::f(a);After1::f(b);if(std::memcmp(a,b,sizeof a))return 1;++checks;
      Before4::f(a);After4::f(b);if(std::memcmp(a,b,sizeof a))return 2;++checks;
      Before16::f(a);After16::f(b);if(std::memcmp(a,b,sizeof a))return 3;++checks;
    }
    std::printf("checks=%u\\n",checks);
  `;
  assert.equal(compileAndRun(prelude, body, { optimize: true }), 'checks=196608\n');
});
