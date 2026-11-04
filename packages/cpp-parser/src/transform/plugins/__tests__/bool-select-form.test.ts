import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { boolSelectFormPlugin } from '../builtins/bool-select-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string, rows: string[], decompile?: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = boolSelectFormPlugin.createTransformer({
    compareSites: rows.join('\n'),
    decompile,
    onSite: (e: { kind: string }) => sites.push(e.kind),
  } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

const row = (op: string, fp0: string, fp1: string, um: string) =>
  ['0', op, 'INT_X', '4', '1', '0', fp0, fp1, '00400000', um === '-' ? '-' : '00400004', um, '-', '-', '0', '-', '-', '-', '0'].join('\t');

describe('bool-select-form', () => {
  it('writes a setcc-read bool return as a select (DEBUG_IsValidDebugDirectorySize)', () => {
    const { out, sites } = run('bool f(unsigned n) { return n >= 0x1c; }', [row('<', 'c:1b', 'v:n', 'SETNC')]);
    assert.deepStrictEqual(sites, ['bool-return']);
    assert.ok(out.includes('return n >= 0x1c ? true : false;'), out);
  });

  it('writes a setcc-read negation as a select (Q35_ActiveFilter)', () => {
    const { out } = run('bool f(int b) { return !b; }', [row('==', 'v:b', 'c:0', 'SETZ')]);
    assert.ok(out.includes('return !b ? true : false;'), out);
  });

  it('leaves a bool return the original computed with sbb', () => {
    const { sites } = run('bool f(unsigned n) { return n >= 0x1c; }', [row('<', 'c:1b', 'v:n', '-')]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a non-bool function', () => {
    const { sites } = run('int f(unsigned n) { return n >= 0x1c; }', [row('<', 'c:1b', 'v:n', 'SETNC')]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a site whose rows disagree', () => {
    const { sites } = run('bool f(int b) { if (b == 0) return false; return !b; }',
      [row('==', 'v:b', 'c:0', 'JNZ'), row('==', 'v:b', 'c:0', 'SETZ')]);
    assert.deepStrictEqual(sites, []);
  });

  it('splits an sbb-computed constant select into base plus mask (deflateBound)', () => {
    const { out, sites } = run('struct S { int strstart; }; int f(S *s) { int n; n = s->strstart ? 0xa : 0x6; return n; }',
      [], '  nHeaderLen = (-(uint)(pDeflateState->strstart != 0) & 4) + 6;');
    assert.deepStrictEqual(sites, ['sbb-select']);
    assert.ok(out.includes('n = 6 + (s->strstart ? 4 : 0);'), out);
  });

  it('keeps the value for a decreasing select', () => {
    const { out } = run('int f(int c) { return c != 3 ? 2 : 6; }', [], 'return (-(uint)(c != 3) & 0xfffffffc) + 6;');
    assert.ok(out.includes('return 6 + (c != 3 ? -4 : 0);'), out);
  });

  it('leaves a sign select (BigBuffer_Compare_Ui)', () => {
    const { sites } = run('int f(unsigned a, unsigned b) { return a < b ? 1 : -1; }', [], 'return (-(uint)(a < b) & 2) - 1;');
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a setcc-computed constant select', () => {
    const { sites } = run('int f(int c) { return c != 3 ? 10 : 6; }', [], 'return (uint)(c != 3) * 4 + 6;');
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a select whose difference LEA cannot scale', () => {
    const { sites } = run('int f(int c) { return c != 3 ? 16 : 6; }', [], 'return (-(uint)(c != 3) & 10) + 6;');
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a select whose values are not the decompile select (PARTYSCREEN 0xa/1)', () => {
    const { sites } = run('int f(int c) { return c ? 1 : 0xa; }', [], 'return (-(uint)(c != 0) & 4) + 6;');
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a memory test against a zeroed register (IsOpen)', () => {
    const r = ['0', '!=', 'INT_NOTEQUAL', '4', '1', '0', 'e', 'c:0', '00401212', '00401215', 'SETNZ', '00401212', 'CMP', '4', 'm', 'z', '0', '1'].join('\t');
    const { sites } = run('struct R { int f; }; bool g(R *p) { return p->f != 0; }', [r]);
    assert.deepStrictEqual(sites, []);
  });

  it('hoists an sbb-computed negated argument into a BOOL local (CMD_AutomapToggleParty)', () => {
    const { out, sites } = run('typedef int BOOL; BOOL Get(); void Set(unsigned); void f() { BOOL BVar1 = Get(); Set((unsigned)!BVar1); }',
      [row('==', 'v:BVar1', 'c:0', '-')]);
    assert.deepStrictEqual(sites, ['not-arg-local']);
    assert.ok(out.includes('BOOL BVar1 = Get(); BOOL bNotBVar1 = !BVar1; Set(bNotBVar1);'), out);
  });

  it('leaves a negated argument the original tested with setcc', () => {
    const { sites } = run('typedef int BOOL; BOOL Get(); void Set(unsigned); void f() { BOOL b = Get(); Set(!b); }',
      [row('==', 'v:b', 'c:0', 'SETZ')]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a negated argument whose operand has its address taken', () => {
    const { sites } = run('typedef int BOOL; void Get(BOOL *); void Set(unsigned); void f() { BOOL b; Get(&b); Set(!b); }',
      [row('==', 'v:b', 'c:0', '-')]);
    assert.deepStrictEqual(sites, []);
  });

  it('does nothing without facts', () => {
    const { sites } = run('bool f(unsigned n) { return n >= 0x1c; }', []);
    assert.deepStrictEqual(sites, []);
  });
});
