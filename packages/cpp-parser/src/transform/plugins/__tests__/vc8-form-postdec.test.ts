import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const source = `int f(uint16_t *a, uint16_t *b, int32_t count) {
  uint16_t y;
  uint16_t x = *a;
  while (x && (y = *b) && count) {
    a++; b++;
    if (x != y) return x < y ? -1 : 1;
    x = *a;
    count--;
  }
  return 0;
}`;
function run(text: string, tag = 'postdec(count,nRemaining)') {
  const form = parseVc8Form(tag); assert.ok(form, tag);
  const sites: Vc8FormSite[] = [];
  const ast = parse(text) as TranslationUnit, before = emit(ast as AnyNode);
  const result = applyVc8Forms(ast, [{ form }], s => sites.push(s));
  assert.equal(emit(ast as AnyNode), before, 'input remains immutable');
  return { out: flat(emit(result as AnyNode)), site: sites[0] };
}

describe('vc8-form: postdec', () => {
  it('parses only a counter and a distinct fresh identifier', () => {
    assert.deepEqual(parseVc8Form('postdec(count,nRemaining)'), { op: 'postdec', counter: 'count', name: 'nRemaining' });
    for (const text of ['postdec(count)', 'postdec(count,count)', 'postdec(count,a.b)', 'postdec(count,n,@a)', 'postdec(a + b,n)', 'postdec(count,int)', 'postdec(while,n)']) assert.equal(parseVc8Form(text), undefined);
  });

  it('uses an unsigned postdecrement inside the first-guard arm', () => {
    const r = run(source); assert.ok(r.site.applied, r.site.why);
    assert.ok(r.out.includes('if (x) { unsigned int nRemaining = (unsigned int)count; do {'), r.out);
    assert.ok(r.out.includes('!nRemaining--'), r.out);
    assert.ok(r.out.includes('} while (x);'), r.out);
    assert.ok(!r.out.includes('count--;'), r.out);
  });

  it('accepts a proven initialized local and explicit nonzero tests', () => {
    const s = source.replace('int32_t count)', 'int32_t limit)').replace('  uint16_t y;', '  int32_t count = limit; uint16_t y;')
      .replace('while (x && (y = *b) && count)', 'while (x != 0 && (y = *b) && count != 0)');
    const r = run(s); assert.ok(r.site.applied, r.site.why);
  });

  it('remains unchanged without an explicit form', () => {
    const ast = parse(source) as TranslationUnit;
    assert.equal(emit(applyVc8Forms(ast, []) as AnyNode), emit(ast as AnyNode));
  });

  for (const tail of ['--count;', 'count -= 1;', 'count += -1;', 'count = count - 1;', 'count = count + -1;']) it('accepts the tail spelling ' + tail, () => {
    const r = run(source.replace('count--;', tail)); assert.ok(r.site.applied, r.site.why);
  });

  it('preserves the order of additional short-circuit operands', () => {
    const r = run(source.replace('(y = *b)', 'Ready() && (y = *b)'));
    assert.ok(r.site.applied, r.site.why);
    assert.ok(r.out.includes('Ready() && (y = *b)'), r.out);
  });

  const cases: [string, string][] = [
    ['an uninitialized local', source.replace('int32_t count)', 'int32_t unused)').replace('  uint16_t y;', '  int32_t count; uint16_t y;')],
    ['a conditionally initialized local', source.replace('int32_t count)', 'int32_t limit)').replace('  uint16_t y;', '  int32_t count; if (limit) count = limit; uint16_t y;')],
    ['a narrow counter', source.replace('int32_t count', 'uint16_t count')],
    ['a wide counter', source.replace('int32_t count', 'int64_t count')],
    ['a volatile counter', source.replace('int32_t count', 'volatile int32_t count')],
    ['a volatile first guard', source.replace('uint16_t x =', 'volatile uint16_t x =')],
    ['a global first guard', source.replace('  uint16_t x = *a;', '')],
    ['a first guard that calls', source.replace('while (x &&', 'while (Ready() &&')],
    ['an ordered counter test', source.replace('&& count)', '&& count > 0)')],
    ['a zero counter test', source.replace('&& count)', '&& count == 0)')],
    ['a disjunction', source.replace('(y = *b) && count', '(y = *b) || count')],
    ['a decrement by two', source.replace('count--;', 'count -= 2;')],
    ['a nonfinal decrement', source.replace('count--;', 'count--; Observe();')],
    ['a body read of the counter', source.replace('a++; b++;', 'Use(count); a++; b++;')],
    ['a later read of the counter', source.replace('return 0;', 'return count;')],
    ['an explicit address alias', source.replace('  uint16_t y;', '  int32_t *alias = &count; uint16_t y;')],
    ['an implicit reference argument before the loop', source.replace('  uint16_t y;', '  Keep(count); uint16_t y;')],
    ['a conversion initializer', source.replace('  uint16_t y;', '  Holder alias = count; uint16_t y;')],
    ['a shadowed counter', source.replace('a++; b++;', '{ int count = 0; } a++; b++;')],
    ['another counter read in the condition', source.replace('(y = *b)', '(y = *b) && count < 9')],
    ['a counter that is also the first guard', source.replace('while (x &&', 'while (count &&')],
    ['a static local counter', source.replace('int32_t count)', 'int32_t unused)').replace('  uint16_t y;', '  static int32_t count = 2; uint16_t y;')],
    ['a continue', source.replace('a++; b++;', 'if (Skip()) continue; a++; b++;')],
    ['a label', source.replace('    a++;', '    again: a++;')],
    ['a fresh-name collision with an unused parameter', source.replace('int32_t count)', 'int32_t count, int nRemaining)')],
    ['a switch entry inside the loop', source.replace('  while', '  switch (Mode()) { case 0: while').replace('    a++;', '    case 1: a++;').replace('  return 0;', '  } return 0;')],
  ];
  for (const [name, text] of cases) it('refuses ' + name + ' without a partial edit', () => {
    const r = run(text); assert.ok(!r.site.applied, r.out);
    assert.equal(r.out, flat(emit(parse(text) as AnyNode)));
  });
});
