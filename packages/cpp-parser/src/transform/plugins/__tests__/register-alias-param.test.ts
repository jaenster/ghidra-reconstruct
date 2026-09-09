/**
 * Ghidra assumes every call kills EAX/ECX/EDX. When the callee does not touch
 * them, the caller's parameter is still declared dead and a fresh local appears
 * in the same register - declared, never assigned, then passed to a callee that
 * dereferences it. These pin that the local folds back onto its parameter, and
 * that a local the body actually writes is never folded.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { registerAliasParamPlugin } from '../builtins/register-alias-param.js';

function run(src: string, aliases: Record<string, { param: string; type: string }>): string {
  const t = registerAliasParamPlugin.createTransformer({ aliases } as never);
  return emit(t(parse(src)) as AnyNode).replace(/\s+/g, ' ').trim();
}

describe('register-alias-param', () => {
  it('seeds a never-assigned register local from its parameter', () => {
    const out = run(
      'void f() { D2UnitStrc* pUnitUnused; g(pUnitUnused, 1); }',
      { pUnitUnused: { param: 'pUnit', type: 'D2UnitStrc*' } });
    assert.ok(/pUnitUnused\s*=\s*pUnit/.test(out), out);
    assert.ok(out.includes('g(pUnitUnused, 1)'), out);
  });

  /**
   * Renaming uses and deleting the declaration was the first design. This
   * transformer has no removal protocol, so the declaration survived with the
   * parameter's name on it and several locals sharing one register emitted
   * several `int pGfxData;` - 921 compile errors across 87 files. Seeding keeps
   * exactly one declaration per local.
   */
  it('leaves exactly one declaration, never a second one named after the param', () => {
    const out = run(
      'void f() { int a; int b; g(a, b); }',
      { a: { param: 'pGfxData', type: 'int' }, b: { param: 'pGfxData', type: 'int' } });
    assert.strictEqual((out.match(/int pGfxData/g) ?? []).length, 0, out);
    assert.ok(/a\s*=\s*pGfxData/.test(out), out);
    assert.ok(/b\s*=\s*pGfxData/.test(out), out);
  });

  it('never touches a local that already has an initialiser', () => {
    const out = run(
      'void f() { D2SkillStrc* pSkillUnused = h(); g(pSkillUnused); }',
      { pSkillUnused: { param: 'pSkill', type: 'D2SkillStrc*' } });
    assert.ok(out.includes('= h()'), out);
    assert.ok(!/pSkillUnused\s*=\s*pSkill/.test(out), out);
  });

  /** The storage says they share a register; a write says it is a real local. */
  it('refuses to seed a local the body assigns', () => {
    const out = run(
      'void f() { D2UnitStrc* pLocal; pLocal = h(); g(pLocal); }',
      { pLocal: { param: 'pUnit', type: 'D2UnitStrc*' } });
    assert.ok(!/pLocal\s*=\s*pUnit\s*;/.test(out), out);
  });

  it('refuses to seed a local whose address escapes', () => {
    const out = run(
      'void f() { int nLocal; h(&nLocal); g(nLocal); }',
      { nLocal: { param: 'nParam', type: 'int' } });
    assert.ok(!/nLocal\s*=\s*nParam/.test(out), out);
  });

  it('refuses a local that is incremented', () => {
    const out = run(
      'void f() { int nLocal; nLocal++; g(nLocal); }',
      { nLocal: { param: 'nParam', type: 'int' } });
    assert.ok(!/nLocal\s*=\s*nParam/.test(out), out);
  });

  /**
   * A struct seeded from a pointer failed Draw.cpp and took six drawing symbols
   * undefined at link. The seed has to typecheck against the declaration the
   * compiler will actually see.
   */
  it('declines when the declared type does not match the parameter type', () => {
    const out = run(
      'void f() { D2GfxLightStrc sLight; g(sLight); }',
      { sLight: { param: 'pGameView', type: 'D2GameViewStrc*' } });
    assert.ok(!/sLight\s*=\s*pGameView/.test(out), out);
  });

  it('leaves everything alone when there are no aliases', () => {
    const out = run('void f() { D2UnitStrc* p; g(p); }', {});
    assert.ok(out.includes('D2UnitStrc* p'), out);
  });

  it('seeds several aliases in one function', () => {
    const out = run(
      'void f() { D2UnitStrc* pUnitUnused; D2SkillStrc* pSkillUnused;'
      + ' g(pUnitUnused, &c, &d, pSkillUnused); }',
      { pUnitUnused: { param: 'pUnit', type: 'D2UnitStrc*' },
        pSkillUnused: { param: 'pSkill', type: 'D2SkillStrc*' } });
    assert.ok(/pUnitUnused\s*=\s*pUnit/.test(out), out);
    assert.ok(/pSkillUnused\s*=\s*pSkill/.test(out), out);
  });
});
