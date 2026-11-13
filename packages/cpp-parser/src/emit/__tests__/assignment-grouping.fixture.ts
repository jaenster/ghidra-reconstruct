/** Shared inputs for native tests and external compiler checks of emitted assignments. */
export function assignmentGroupingFixture(emitSource: (source: string) => string): { prelude: string; body: string } {
  const cases = [
    ['ConditionalAssign', '(flag ? a : b) = c;'],
    ['ConditionalAdd', '(flag ? a : b) += c;'],
    ['LeftAssign', '(a = b) = c;'],
    ['RightComma', 'a = (b += 1, c);'],
  ];
  const sources = cases.map(([name, operation]) =>
    `void ${name}(bool flag, int &a, int &b, int c) { ${operation} }`);
  const prelude = [
    `namespace Original { ${sources.join('\n')} }`,
    `namespace Emitted { ${sources.map(emitSource).join('\n')} }`,
  ].join('\n');
  const body = [
    'unsigned failures = 0, checks = 0;',
    'for (int flag = 0; flag < 2; ++flag) for (int a = -2; a <= 2; ++a)',
    'for (int b = -2; b <= 2; ++b) for (int c = -2; c <= 2; ++c) {',
    ...cases.map(([name]) => `{
      int originalA = a, originalB = b, emittedA = a, emittedB = b;
      Original::${name}(flag != 0, originalA, originalB, c);
      Emitted::${name}(flag != 0, emittedA, emittedB, c);
      if (originalA != emittedA || originalB != emittedB) ++failures;
      ++checks;
    }`),
    '}',
    'printf("assignment checks=%u failures=%u\\n", checks, failures);',
    'if (failures) return 1;',
  ].join('\n');
  return { prelude, body };
}
