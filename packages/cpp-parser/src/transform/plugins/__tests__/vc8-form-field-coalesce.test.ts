import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const tables = (): Vc8FormTables => ({
  structFields: { S: { capacity: 'short', count: 'short' } },
  structLayouts: { S: [{ name: 'capacity', type: 'short', offset: 0, size: 2 }, { name: 'count', type: 'short', offset: 2, size: 2 }] },
  functionParamTypes: { Consume: ['S*', 'int'], 'Fog::Memory::ReAllocServerMemory': ['void*', 'void*', 'unsigned int', 'char*', 'int', 'int'] },
});
const source = `int f(S* p) { short value = p->capacity - 4; p->capacity = value; return Consume(p, value * 8); }`;
const tag = 'coalesce(value,p->capacity)';
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
function run(input = source, facts = tables(), formText = tag) {
  const form = parseVc8Form(formText); assert.ok(form);
  const ast = parse(input) as TranslationUnit, sites: Vc8FormSite[] = [];
  const out = applyVc8Forms(ast, [{ form }], s => sites.push(s), facts);
  return { code: emit(out as AnyNode), before: emit(ast as AnyNode), site: sites[0] };
}
function refused(input = source, facts = tables()) {
  const r = run(input, facts);
  assert.equal(r.site.applied, false, input);
  assert.equal(r.code, r.before, r.site.why);
}

describe('vc8-form: coalesce a stored local into a field', () => {
  it('keeps the existing local grammar and accepts one explicit field', () => {
    assert.deepEqual(parseVc8Form(tag), { op: 'coalesce', name: 'value', from: 'p->capacity' });
    assert.deepEqual(parseVc8Form('coalesce(a,b)'), { op: 'coalesce', name: 'a', from: 'b' });
    for (const bad of ['coalesce(value,p->x->capacity)', 'coalesce(value,*p)', 'coalesce(value,p[0])', 'coalesce(value,p->capacity,@1)']) assert.equal(parseVc8Form(bad), undefined);
  });
  it('preserves the short conversion at the field store before a typed call', () => {
    const r = run(); assert.ok(r.site.applied, r.site.why);
    assert.match(flat(r.code), /p->capacity = p->capacity - 4; return Consume\(p, p->capacity \* 8\);/);
    assert.doesNotMatch(r.code, /\bvalue\b/);
  });
  it('handles a root return and a parenthesized root use', () => {
    for (const expr of ['value', '(value)']) {
      const r = run(source.replace('Consume(p, value * 8)', expr)); assert.ok(r.site.applied, r.site.why);
      assert.doesNotMatch(r.code, /\bvalue\b/);
    }
  });
  it('uses the field in the immediate guard without rewriting its later mutations', () => {
    const r = run(source.replace('return Consume(p, value * 8);', 'if (value == 3) return 0; p->capacity++; return p->capacity;'));
    assert.ok(r.site.applied, r.site.why); assert.match(r.code, /if \(p->capacity == 3\)/);
    assert.match(r.code, /p->capacity\+\+/);
  });
  it('supports the allocation macro using its actual Fog parameter types', () => {
    const r = run(source.replace('return Consume(p, value * 8);', 'void* q = (void*)D2_REALLOC_POOL_AT(p, p, value * 8, "file", 4); return q != 0;'));
    assert.ok(r.site.applied, r.site.why); assert.doesNotMatch(r.code, /\bvalue\b/);
  });
  it('does not treat a same-spelled member as a local read', () => {
    const t = tables(); t.structFields!.S.value = 'short'; t.structLayouts!.S = [...t.structLayouts!.S, { name: 'value', type: 'short', offset: 4, size: 2 }];
    const r = run(source.replace('value * 8', 'value * 8 + p->value'), t);
    assert.ok(r.site.applied, r.site.why); assert.match(r.code, /p->capacity \* 8 \+ p->value/);
  });
  for (const [label, input] of [
    ['a changed temporary', source.replace('return Consume', 'value++; return Consume')],
    ['a later read', source.replace('return Consume(p, value * 8);', 'Consume(p, value); return value;')],
    ['an addressed local', source.replace('value * 8', '(int)&value')],
    ['an intervening call', source.replace('return Consume', 'Mutate(p); return Consume')],
    ['another argument call', source.replace('Consume(p, value * 8)', 'Consume(Mutate(p), value * 8)')],
    ['an argument store', source.replace('Consume(p, value * 8)', 'Consume(p = Other(), value * 8)')],
    ['a call initializer', source.replace('p->capacity - 4', 'Load(p)')],
    ['a volatile local', source.replace('short value', 'volatile short value')],
    ['a differently signed local', source.replace('short value', 'unsigned short value')],
    ['a wider local', source.replace('short value', 'int value')],
    ['a shadowed local', source.replace('return Consume', '{ short value = 2; Use(value); } return Consume')],
    ['a shadowed pointer parameter', source.replace('short value', '{ volatile S* p = Other(); short value').replace('value * 8); }', 'value * 8); } }')],
    ['an addressed root', source.replace('short value', 'Escape(&p); short value')],
    ['a conditional arm reading the local again', source.replace('return Consume(p, value * 8);', 'if (value) return value; return 0;')],
    ['a jump target', source.replace('short value', 'label:; short value')],
  ] as const) it(`refuses ${label}`, () => refused(input));
  it('requires exact non-bitfield layout facts', () => {
    const missing = tables(); delete missing.structLayouts; refused(source, missing);
    const bit = tables(); bit.structLayouts!.S = [{ name: 'capacity', type: 'short', offset: 0, size: 2, bitSize: 7 }]; refused(source, bit);
    const vol = tables(); vol.structFields!.S.capacity = 'volatile short'; refused(source, vol);
    const root = source.replace('S* p', 'volatile S* p'); refused(root);
    const alias = tables(); alias.typedefTargets = { SVolatile: 'volatile S' }; refused(source.replace('S* p', 'SVolatile* p'), alias);
    const union = tables(); union.unionNames = ['S']; refused(source, union);
  });
  it('requires typed scalar/pointer call arguments', () => {
    const unknown = tables(); delete unknown.functionParamTypes; refused(source, unknown);
    const conversions = tables(); conversions.functionParamTypes!.Consume = ['S*', 'Wrapper']; refused(source, conversions);
    const references = tables(); references.functionParamTypes!.Consume = ['S*', 'short&']; refused(source, references);
  });
  it('checks all 65536 narrow values with a consumer that mutates the source object', { skip: !hasNativeGpp() }, () => {
    const r = run(); assert.ok(r.site.applied, r.site.why);
    const prelude = `
      struct S { short capacity; short count; };
      int Consume(S* p, int n) { int result = n + p->capacity; p->capacity = 123; return result; }
      namespace Before { ${r.before} }
      namespace After { ${r.code} }
    `;
    const main = `
      for (unsigned i = 0; i != 65536; ++i) {
        S a = { (short)i, 8 }, b = a;
        int x = Before::f(&a), y = After::f(&b);
        if (x != y || a.capacity != b.capacity || a.count != b.count) return 1;
      }
      std::printf("checks=65536\\n");
    `;
    assert.equal(compileAndRun(prelude, main, { optimize: true }), 'checks=65536\n');
  });
});
