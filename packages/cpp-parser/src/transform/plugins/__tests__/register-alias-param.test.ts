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

function run(src: string, aliases: Record<string, string>): string {
  const t = registerAliasParamPlugin.createTransformer({ aliases } as never);
  return emit(t(parse(src)) as AnyNode).replace(/\s+/g, ' ').trim();
}

describe('register-alias-param', () => {
  it('folds a never-assigned register local onto its parameter', () => {
    const out = run(
      'void f() { D2UnitStrc* pUnitUnused; g(pUnitUnused, 1); }',
      { pUnitUnused: 'pUnit' });
    assert.ok(out.includes('g(pUnit, 1)'), out);
    assert.ok(!out.includes('pUnitUnused'), out);
  });

  it('drops the dead declaration too', () => {
    const out = run(
      'void f() { D2SkillStrc* pSkillUnused; g(pSkillUnused); }',
      { pSkillUnused: 'pSkill' });
    assert.ok(!out.includes('D2SkillStrc* pSkillUnused'), out);
    assert.ok(!out.includes('pSkillUnused'), out);
  });

  /** The storage says they share a register; a write says it is a real local. */
  it('refuses to fold a local the body assigns', () => {
    const out = run(
      'void f() { D2UnitStrc* pLocal; pLocal = h(); g(pLocal); }',
      { pLocal: 'pUnit' });
    assert.ok(out.includes('pLocal'), out);
    assert.ok(!out.includes('g(pUnit)'), out);
  });

  it('refuses to fold a local whose address escapes', () => {
    const out = run(
      'void f() { int nLocal; h(&nLocal); g(nLocal); }',
      { nLocal: 'nParam' });
    assert.ok(out.includes('nLocal'), out);
  });

  it('refuses a local that is incremented', () => {
    const out = run(
      'void f() { int nLocal; nLocal++; g(nLocal); }',
      { nLocal: 'nParam' });
    assert.ok(out.includes('nLocal'), out);
  });

  it('leaves everything alone when there are no aliases', () => {
    const out = run('void f() { D2UnitStrc* p; g(p); }', {});
    assert.ok(out.includes('D2UnitStrc* p'), out);
  });

  it('folds several aliases in one function', () => {
    const out = run(
      'void f() { D2UnitStrc* pUnitUnused; D2SkillStrc* pSkillUnused;'
      + ' g(pUnitUnused, &a, &b, pSkillUnused); }',
      { pUnitUnused: 'pUnit', pSkillUnused: 'pSkill' });
    assert.ok(out.includes('g(pUnit, &a, &b, pSkill)'), out);
  });
});
