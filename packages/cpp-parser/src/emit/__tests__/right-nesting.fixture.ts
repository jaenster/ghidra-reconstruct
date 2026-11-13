/** Shared inputs for native tests and external compiler checks of the actual emitter. */
export function rightNestingFixture(emitSource: (source: string) => string): { prelude: string; body: string } {
  const operators = ['+', '*', '&&', '||', '&', '|', '^'];
  const sources = [
    'float Add(float a, float b, float c) { return a + (b + c); }',
    'float Multiply(float a, float b, float c) { return a * (b * c); }',
    'double WideAdd(double a, double b, double c) { return a + (b + c); }',
    ...operators.flatMap((op, i) => [
      `E Right${i}(E a, E b, E c) { return a ${op} (b ${op} c); }`,
      `E Left${i}(E a, E b, E c) { return (a ${op} b) ${op} c; }`,
    ]),
  ];
  const prelude = [
    'struct E { int value; };',
    ...operators.map(op => `E operator${op}(E a, E b) { return E{a.value * 10 + b.value}; }`),
    `namespace Original { ${sources.join('\n')} }`,
    `namespace Emitted { ${sources.map(emitSource).join('\n')} }`,
  ].join('\n');
  const body = [
    'unsigned failures = 0;',
    'volatile float huge = 0x1p100f, negative = -0x1p100f, small = 1.0f;',
    'if (Original::Add(huge,negative,small) != Emitted::Add(huge,negative,small)) ++failures;',
    'volatile float a = 1e30f, b = 1e10f, c = 1e-10f;',
    'if (Original::Multiply(a,b,c) != Emitted::Multiply(a,b,c)) ++failures;',
    'volatile double wide = 0x1p1000, minusWide = -0x1p1000, one = 1.0;',
    'if (Original::WideAdd(wide,minusWide,one) != Emitted::WideAdd(wide,minusWide,one)) ++failures;',
    ...operators.flatMap((_, i) => [
      `if (Original::Right${i}(E{1},E{2},E{3}).value != Emitted::Right${i}(E{1},E{2},E{3}).value) ++failures;`,
      `if (Original::Left${i}(E{1},E{2},E{3}).value != Emitted::Left${i}(E{1},E{2},E{3}).value) ++failures;`,
    ]),
    'printf("grouping failures=%u\\n", failures);',
    'if (failures) return 1;',
  ].join('\n');
  return { prelude, body };
}
