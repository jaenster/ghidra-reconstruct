/** Shared inputs for native tests and external compiler checks of the actual emitter. */
export function rightNestingFixture(emitSource: (source: string) => string): { prelude: string; body: string } {
  const operators = ['+', '*', '&', '|', '^'];
  const sources = [
    'float Add(float a, float b, float c) { return a + (b + c); }',
    'float Multiply(float a, float b, float c) { return a * (b * c); }',
    'double WideAdd(double a, double b, double c) { return a + (b + c); }',
    'long long MixedAdd(long long ll, unsigned int u1, unsigned int u2) { return ll + (u1 + u2); }',
    'long long MixedOr(long long ll, unsigned int u, int i) { return ll | (u | i); }',
    'int And(int a, int b, int c) { return Touch(a) && (Touch(b) && Touch(c)); }',
    'int Or(int a, int b, int c) { return Touch(a) || (Touch(b) || Touch(c)); }',
    ...operators.flatMap((op, i) => [
      `E Right${i}(E a, E b, E c) { return a ${op} (b ${op} c); }`,
      `E Left${i}(E a, E b, E c) { return (a ${op} b) ${op} c; }`,
    ]),
  ];
  const prelude = [
    'struct E { int value; };',
    'unsigned effectTrace; int Touch(int x) { effectTrace = effectTrace * 4 + (x ? 2 : 1); return x; }',
    ...operators.map(op => `E operator${op}(E a, E b) { return E{a.value * 10 + b.value}; }`),
    `namespace Original { ${sources.join('\n')} }`,
    `namespace Emitted { ${sources.map(emitSource).join('\n')} }`,
  ].join('\n');
  const body = [
    'unsigned failures = 0, mixedFailures = 0, logicalFailures = 0;',
    'volatile float huge = 0x1p100f, negative = -0x1p100f, small = 1.0f;',
    'if (Original::Add(huge,negative,small) != Emitted::Add(huge,negative,small)) ++failures;',
    'volatile float a = 1e30f, b = 1e10f, c = 1e-10f;',
    'if (Original::Multiply(a,b,c) != Emitted::Multiply(a,b,c)) ++failures;',
    'volatile double wide = 0x1p1000, minusWide = -0x1p1000, one = 1.0;',
    'if (Original::WideAdd(wide,minusWide,one) != Emitted::WideAdd(wide,minusWide,one)) ++failures;',
    'if (Original::MixedAdd(0,0xffffffffu,1u) != Emitted::MixedAdd(0,0xffffffffu,1u)) { ++failures; ++mixedFailures; }',
    'if (Original::MixedOr(0,0u,-1) != Emitted::MixedOr(0,0u,-1)) { ++failures; ++mixedFailures; }',
    ...operators.flatMap((_, i) => [
      `if (Original::Right${i}(E{1},E{2},E{3}).value != Emitted::Right${i}(E{1},E{2},E{3}).value) ++failures;`,
      `if (Original::Left${i}(E{1},E{2},E{3}).value != Emitted::Left${i}(E{1},E{2},E{3}).value) ++failures;`,
    ]),
    ...['And', 'Or'].map(name => `for(int a=0;a<2;++a) for(int b=0;b<2;++b) for(int c=0;c<2;++c) { effectTrace=0; int original=Original::${name}(a,b,c); unsigned originalTrace=effectTrace; effectTrace=0; int emitted=Emitted::${name}(a,b,c); if(original!=emitted || originalTrace!=effectTrace) { ++failures; ++logicalFailures; } }`),
    'printf("grouping failures=%u mixed-width failures=%u logical failures=%u\\n", failures, mixedFailures, logicalFailures);',
    'if (failures) return 1;',
  ].join('\n');
  return { prelude, body };
}
