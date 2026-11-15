import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';
import { registerStoreSelectPlugin, type RegisterStoreSelectOptions } from '../builtins/register-store-select.js';

const source = `void f(S* p, int speed) {
  unsigned int value = speed <= 0 ? 0 : speed;
  if ((int)value < 32767) { p->capacity = (short)value; return; }
  p->capacity = 32767;
}`;
const facts = (): RegisterStoreSelectOptions => ({
  registerStores: [{ name: 'capacity', size: 2, value: 32767, register: true }],
  structFields: { S: { capacity: 'short' } },
});
function run(input = source, options = facts()): string {
  return emit(registerStoreSelectPlugin.createTransformer(options)(parse(input)) as AnyNode);
}
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
function kept(input: string, options = facts()) {
  const out = run(input, options);
  assert.match(out, /\(short(?: int)?\)value/, out);
}

describe('register-store-select: proven narrow arm conversions', () => {
  it('drops a same-field cast after joining the clamped short stores', () => {
    const out = run();
    assert.match(flat(out), /p->capacity = \(int\)value < 32767 \? value : 32767;/);
    assert.doesNotMatch(out, /\(short/);
  });
  it('handles an unsigned guard without a signed reinterpretation', () => {
    const out = run(source.replace('unsigned int value = speed <= 0 ? 0 : speed;', 'unsigned int value = speed;').replace('(int)value', 'value'));
    assert.doesNotMatch(out, /\(short/);
  });
  it('keeps a signed reinterpretation of an unrestricted unsigned value', () => {
    kept(source.replace('unsigned int value = speed <= 0 ? 0 : speed;', 'unsigned int value = speed;'));
    kept(source.replace('unsigned int value = speed <= 0 ? 0 : speed;', 'unsigned int value = speed;').replace('(int)value', 'static_cast<int>(value)'));
  });
  it('leaves the input AST unchanged', () => {
    const ast = parse(source), before = emit(ast);
    registerStoreSelectPlugin.createTransformer(facts())(ast);
    assert.equal(emit(ast), before);
  });
  it('keeps a cast when negative values are not excluded', () => {
    kept(source.replace('unsigned int value = speed <= 0 ? 0 : speed;', 'int value = speed;'));
  });
  it('keeps a cast when the bound still admits out-of-range values', () => {
    kept(source.replace(/32767/g, '32768'), { ...facts(), registerStores: [{ name: 'capacity', size: 2, value: 32768, register: true }] });
  });
  it('keeps a cast when the field type is unknown or wider', () => {
    const unknown = facts(); delete unknown.structFields; kept(source, unknown);
    const wider = facts(); wider.structFields!.S.capacity = 'int'; kept(source, wider);
    const aggregate = facts(); aggregate.structFields!.S.capacity = 'Wrapper'; kept(source, aggregate);
  });
  it('resolves scalar and field typedefs', () => {
    const options = facts(); options.typedefTargets = { WORD_SIGNED: 'short', DWORD_UNSIGNED: 'unsigned int' };
    options.structFields!.S.capacity = 'WORD_SIGNED';
    assert.doesNotMatch(run(source.replace('unsigned int', 'DWORD_UNSIGNED').replace('(short)', '(WORD_SIGNED)'), options), /\(WORD_SIGNED\)/);
  });
  it('keeps a volatile local or volatile typedef', () => {
    kept(source.replace('unsigned int value', 'volatile unsigned int value'));
    const options = facts(); options.typedefTargets = { VolatileWord: 'volatile unsigned int' };
    kept(source.replace('unsigned int value', 'VolatileWord value'), options);
  });
  it('keeps a cast when a binding is shadowed or address-escaped', () => {
    kept(source.replace('if ((int)value', '{ int value = -90000; Use(value); } if ((int)value'));
    kept(source.replace('if ((int)value', 'Escape(&value); if ((int)value'));
    kept(source.replace('if ((int)value', '{ Other* p = OtherPointer(); Use(p); } if ((int)value'));
  });
  it('does not widen the other arm through unsigned conditional conversion', () => {
    const options = facts(); options.registerStores = [{ name: 'capacity', size: 2, value: 65535, register: true }];
    kept(source.replace('p->capacity = 32767;', 'p->capacity = -1;'), options);
  });
  it('keeps an effectful intervening write and an alternate entry', () => {
    kept(source.replace('if ((int)value', 'value = speed; if ((int)value'));
    kept(source.replace('if ((int)value', 'label:; if ((int)value'));
  });
  it('preserves the cast when no observed register store permits joining', () => {
    const options = facts(); options.registerStores![0].register = false;
    kept(source, options);
  });
  it('does not alter pre-existing ternary stores', () => {
    const input = source.replace('if ((int)value < 32767) { p->capacity = (short)value; return; }\n  p->capacity = 32767;', 'p->capacity = (int)value < 32767 ? (short)value : 32767;');
    kept(input);
  });
  it('preserves all short patterns, boundary speeds and sampled int32 values', { skip: !hasNativeGpp() }, () => {
    const before = emit(parse(source)), after = run();
    assert.doesNotMatch(after, /\(short/);
    const prelude = `struct S { short capacity; }; namespace Before { ${before} } namespace After { ${after} }
      int check(int speed) { S a = {123}, b = a; Before::f(&a, speed); After::f(&b, speed); return a.capacity != b.capacity; }`;
    const main = `
      const int edges[] = {(-2147483647-1),-2147483647,-65537,-32769,-32768,-1,0,1,127,128,255,256,32766,32767,32768,65535,65536,2147483646,2147483647};
      for (unsigned i=0;i<sizeof(edges)/sizeof(edges[0]);++i) if(check(edges[i])) return 1;
      for (unsigned i=0;i<65536;++i) if(check((short)i)) return 2;
      unsigned seed = 0x12345678;
      for (unsigned i=0;i<1000000;++i) { seed=seed*1664525u+1013904223u; if(check((int)seed)) return 3; }
      std::puts("checks=1065555");`;
    assert.equal(compileAndRun(prelude, main, { optimize: true }), 'checks=1065555\n');
  });
});
