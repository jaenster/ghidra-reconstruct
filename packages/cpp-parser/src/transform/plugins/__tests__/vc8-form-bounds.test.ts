import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';

const form = 'bounds(a,b,c,d)';
const body = 'void f(int x,int y) { a=x-24; b=y-24; c=x+24; d=y+24; }';
const proof = (): Vc8FormTables => ({
  globalTypes: { a: 'int', b: 'int', c: 'int', d: 'int' },
  globalAddresses: { a: 4096, b: 4100, c: 4104, d: 4108 },
  globalSizes: { a: 4, b: 4, c: 4, d: 4 },
  targetLanguageId: 'x86:LE:32:default', targetPointerSize: 4,
});
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
function run(source = body, tables: Vc8FormTables | undefined = proof(), tag = form) {
  const parsed = parseVc8Form(tag); assert(parsed);
  const input = parse(source), sites: Vc8FormSite[] = [], before = emit(input);
  const result = applyVc8Forms(input, [{ form: parsed }], s => sites.push(s), tables);
  assert.equal(emit(input), before, 'the original tree is preserved');
  return { out: flat(emit(result)), before: flat(before), sites };
}
function refused(source = body, tables: Vc8FormTables | undefined = proof(), tag = form) {
  const r = run(source, tables, tag);
  assert.deepEqual(r.sites.map(s => s.applied), [false]);
  assert.equal(r.out, r.before, 'refusal is atomic');
}

describe('vc8-form: bounds', () => {
  it('reuses the stored minima while preserving their order and later calls', () => {
    const r = run(body.replace('d=y+24;', 'd=y+24; draw(a,b,c,d);'));
    assert.deepEqual(r.sites.map(s => s.applied), [true]);
    assert.match(r.out, /a = x - 24; b = y - 24; c = a \+ 48; d = b \+ 48; draw\(a, b, c, d\);/);
  });
  it('handles independent extents, parentheses, and a different valid store order', () => {
    const r = run('void f(signed int x,int y) { b=(y-0x13); a=x-0x18; d=y+19; c=x+24; }');
    assert.deepEqual(r.sites.map(s => s.applied), [true]);
    assert.match(r.out, /d = b \+ 38; c = a \+ 48;/);
  });
  it('preserves qualified storage spellings in the new reads', () => {
    const r = run('void f(int x,int y) { N::a=x-24; N::b=y-24; N::c=x+24; N::d=y+24; }');
    assert.deepEqual(r.sites.map(s => s.applied), [true]);
    assert.match(r.out, /N::c = N::a \+ 48; N::d = N::b \+ 48;/);
  });
  it('accepts an explicit x64 model with the same four-byte scalar objects', () => {
    const p = proof(); p.targetPointerSize = 8; p.targetLanguageId = 'x86:LE:64:default';
    assert.equal(run(body, p).sites[0].applied, true);
  });
  it('allows the largest positive extent whose double is a signed int', () => {
    const r = run(body.replace(/24/g, '1073741823'));
    assert.equal(r.sites[0].applied, true); assert.match(r.out, /c = a \+ 2147483646/);
  });
  it('requires explicit architecture, types, addresses and four-byte sizes', () => {
    for (const key of ['targetLanguageId', 'targetPointerSize', 'globalTypes', 'globalAddresses', 'globalSizes'] as const) {
      const p = proof(); delete p[key]; refused(body, p);
    }
    for (const size of [0, 2, 8]) { const p = proof(); p.globalSizes!.a = size; refused(body, p); }
    const p = proof(); p.targetLanguageId = 'unknown'; refused(body, p);
  });
  it('refuses aliases, partial overlaps, invalid addresses and missing ranges', () => {
    for (const address of [4096, 4097, 4099, 4101, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
      const p = proof(); p.globalAddresses!.c = address; refused(body, p);
    }
    const p = proof(); delete p.globalAddresses!.d; refused(body, p);
  });
  it('refuses qualifiers, unknown aliases, narrowing, pointers, floats and unsigned objects', () => {
    for (const type of ['volatile int', 'const int', '_Atomic int', 'unsigned int', 'short', 'long long', 'float', 'int *', 'int &', 'int32_t', 'Unknown']) {
      const p = proof(); p.globalTypes!.c = type; refused(body, p);
    }
    for (const type of ['volatile int', 'unsigned int', 'short', 'long long', 'float', 'int &', 'int32_t'])
      refused(body.replace('int x', type + ' x'));
  });
  it('refuses unknown input provenance and local/global shadowing', () => {
    refused(body.replace('int x,int y', 'int y'));
    refused(body.replace('{', '{ int a=0;'));
    refused(body.replace('{', '{ { int x=0; }'));
    refused(body.replace('int x,int y', 'int y').replace('{', '{ static int x=1;'));
    refused(body.replace('int x,int y', 'int y').replace('{', '{ extern int x;'));
  });
  it('refuses effects, pointer/field inputs, casts and nonmatching expressions', () => {
    for (const input of ['next()', '*p', 'p->x', '(int)x', 'x++', '(x+1)'])
      refused(body.replace('x-24', input + '-24').replace('x+24', input + '+24'));
    refused(body.replace('c=x+24', 'c=y+24'));
    refused(body.replace('c=x+24', 'c=x+25'));
    refused(body.replace('a=x-24', 'a=x+24'));
  });
  it('refuses zero, negative, suffixed, octal and overflowing extent literals', () => {
    for (const extent of ['0', '(-1)', '24u', '24L', '030', '1073741824', '2147483648'])
      refused(body.replace(/24/g, extent));
  });
  it('refuses intervening effects, premature maximum reads and multiple matching runs', () => {
    refused(body.replace('b=y-24;', 'b=y-24; mutate();'));
    refused('void f(int x,int y) { c=x+24; b=y-24; a=x-24; d=y+24; }');
    refused('void f(int x,int y) { a=x-24; b=y-24; c=x+24; d=y+24; use(); a=x-24; b=y-24; c=x+24; d=y+24; }');
  });
  it('rejects malformed or repeated targets during parsing', () => {
    for (const tag of ['bounds(a,b,c)', 'bounds(a,b,c,d,e)', 'bounds(a,b,a,d)', 'bounds(a,b,c,d,@2)', 'bounds(a.x,b,c,d)', 'bounds(*a,b,c,d)'])
      assert.equal(parseVc8Form(tag), undefined, tag);
  });
});
