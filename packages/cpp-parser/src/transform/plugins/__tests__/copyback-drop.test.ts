import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { copybackDropPlugin } from '../builtins/copyback-drop.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = copybackDropPlugin.createTransformer({ onSite: (e: { from: string; to: string }) => sites.push(`${e.from}->${e.to}`) } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}
const same = (code: string) => {
  const { out, sites } = run(code);
  assert.deepEqual(sites, [], code);
  assert.equal(out, flat(emit(parse(code) as AnyNode)));
};

// COMPOSIT_GetWeaponClassWithTransform 0064f380, as the generator prints it.
const COMPOSIT = `uint32_t __stdcall f(D2UnitStrc* pUnit, int32_t nMode, int32_t bIgnoreTransform) {
  D2UnitStrc* pOrigUnit = pUnit;
  if (nMode == -1) {
    nMode = GetAnimOrSeqMode(pOrigUnit);
  }
  int32_t nAnimMode = nMode;
  nMode = nAnimMode;
  if (FlagBit(pOrigUnit)) {
    GetStateTransformGfx(pOrigUnit, &nMode);
    if (!bIgnoreTransform) {
      nMode = nAnimMode;
    }
  }
  return Resolve(pOrigUnit, nMode);
}`;

describe('copyback-drop', () => {
  it('drops the copy back after a declaration, even with the address of B taken (0064f380)', () => {
    const { out, sites } = run(COMPOSIT);
    assert.deepEqual(sites, ['nAnimMode->nMode']);
    assert.ok(out.includes('int32_t nAnimMode = nMode; if (FlagBit(pOrigUnit))'), out);
    assert.ok(out.includes('nMode = nAnimMode; } }'), 'the arm\'s restore stays');
  });

  it('drops the copy back after a plain store', () => {
    const { out, sites } = run('int f(int a) { int b; b = a; a = b; return a + b; }');
    assert.deepEqual(sites, ['b->a']);
    assert.equal(out, flat(emit(parse('int f(int a) { int b; b = a; return a + b; }') as AnyNode)));
  });

  it('keeps it when anything sits between', () => {
    same('int f(int a) { int b; b = a; g(); a = b; return a + b; }');
    same('int f(int a) { int b; b = a; ; a = b; return a + b; }');
  });

  it('keeps it across blocks', () => {
    same('int f(int a, int c) { int b; b = a; if (c) { a = b; } return a + b; }');
  });

  it('keeps a conversion: different types', () => {
    same('int f(int a) { short b; b = a; a = b; return a + b; }');
    same('int f(unsigned a) { int b; b = a; a = b; return a + b; }');
  });

  it('keeps volatile, static, references and globals', () => {
    same('int f(int a) { volatile int b; b = a; a = b; return a + b; }');
    same('int f(int a) { static int b; b = a; a = b; return a + b; }');
    same('int f(int a) { int& b = a; a = b; return a + b; }');
    same('int f(int a) { gB = a; a = gB; return a; }');
  });

  it('keeps a name declared twice', () => {
    same('int f(int a, int c) { int b; b = a; a = b; if (c) { int b = 2; return b; } return a; }');
  });

  it('keeps a compound store or a member', () => {
    same('int f(int a) { int b; b = a; a += b; return a; }');
    same('int f(S s, S t) { s.x = t.x; t.x = s.x; return t.x; }');
  });

  it('keeps a self copy and the other direction', () => {
    same('int f(int a) { int b; b = a; b = a; return b; }');
  });

  it('keeps a copy back that carries a comment', () => {
    same('int f(int a) { int b; b = a;\n  // restore\n  a = b; return a + b; }');
  });
});
