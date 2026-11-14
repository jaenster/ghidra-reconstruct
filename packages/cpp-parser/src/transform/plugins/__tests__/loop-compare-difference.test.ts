import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { loopCompareDifferencePlugin } from '../builtins/loop-compare-difference.js';

const source = `int f(int a, int b) {
  while (true) {
    a = Left(); b = Right();
    if (a != b) { break; }
    Advance();
  }
  return (unsigned int)(a != b && -1 < a - b) * 2 - 1;
}`;
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const run = (s: string) => flat(emit(loopCompareDifferencePlugin.createTransformer({})(parse(s)) as AnyNode));
const changed = (s: string) => run(s).includes('nComparison = a - b;');

describe('loop-compare-difference', () => {
  it('shares a fresh signed difference between the sole break test and positive result', () => {
    const out = run(source);
    assert.ok(out.includes('int nComparison; while (true)'), out);
    assert.ok(out.includes('nComparison = a - b; if (nComparison != 0)'), out);
    assert.ok(out.includes('(unsigned int)(nComparison > 0) * 2 - 1'), out);
    assert.equal(run(out), out, 'idempotent');
  });

  it('accepts uniquely declared int32 locals and a bare break', () => {
    const s = source.replace('int f(int a, int b)', 'int f()').replace('  while', '  int32_t a; int32_t b;\n  while').replace('{ break; }', 'break;');
    assert.ok(changed(s));
  });

  it('reserves unused parameter and local names', () => {
    const out = run(source.replace('int a, int b)', 'int a, int b, int nComparison, int nComparison2)'));
    assert.ok(out.includes('int nComparison3;'), out);
  });

  it('accepts the same break comparison in reversed operand order', () => {
    assert.ok(changed(source.replace('if (a != b)', 'if (b != a)')));
  });

  const refused: [string, string][] = [
    ['another way to break', source.replace('Advance();', 'if (Stop()) break; Advance();')],
    ['a conditional loop entry', source.replace('while (true)', 'while (Ready())')],
    ['a statement between loop and return', source.replace('  return', '  Observe();\n  return')],
    ['a break nested in another guard', source.replace('if (a != b)', 'if (Ready()) if (a != b)')],
    ['a comparison with an else arm', source.replace('{ break; }', '{ break; } else { Observe(); }')],
    ['a different subtraction', source.replace('a - b)', 'b - a)')],
    ['a non-strict lower bound', source.replace('-1 <', '-1 <=')],
    ['an additional read in the result', source.replace(') * 2 - 1;', ') * 2 - 1 + a;')],
    ['a return expression with a call', source.replace(') * 2 - 1;', ') * Observe() - 1;')],
    ['an unsigned operand', source.replace('int a, int b', 'unsigned int a, int b')],
    ['a narrow operand', source.replace('int a, int b', 'short a, int b')],
    ['a wide operand', source.replace('int a, int b', 'int64_t a, int b')],
    ['a volatile operand', source.replace('int a, int b', 'volatile int a, int b')],
    ['a global operand', source.replace('int a, int b', 'int b')],
    ['a static local', source.replace('int f(int a, int b)', 'int f(int b)').replace('  while', '  static int a;\n  while')],
    ['a shadowed operand', source.replace('Advance();', '{ int a = 0; Use(a); } Advance();')],
    ['an explicit address alias', source.replace('  while', '  int *p = &a;\n  while')],
    ['an implicit reference argument', source.replace('Advance();', 'Use(a); Advance();')],
    ['a reference alias', source.replace('  while', '  int &r = a;\n  while')],
    ['a label entering the body', source.replace('    if (a != b)', '    again: if (a != b)')],
    ['a goto', source.replace('Advance();', 'goto again; again: Advance();')],
    ['an implicit conversion initializer', source.replace('  while', '  Holder holder = a;\n  while')],
  ];
  for (const [name, text] of refused) it('leaves ' + name, () => assert.ok(!changed(text), run(text)));

  const fixture = JSON.parse(readFileSync(new URL('./fixtures/loop-compare-difference.json', import.meta.url), 'utf8'));
  for (const row of fixture.backend) it('reproduces the measured published backend: ' + row.address, () => {
    assert.equal(run(row.baseline), flat(row.candidate));
  });
});
