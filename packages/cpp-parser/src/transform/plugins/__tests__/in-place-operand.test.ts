import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { inPlaceOperandPlugin } from '../builtins/in-place-operand.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(src: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = inPlaceOperandPlugin.createTransformer({ onSite: (e: { variable: string; form: string }) => sites.push(`${e.variable}:${e.form}`) });
  return { out: flat(emit(t(parse(src)) as AnyNode)), sites };
}

describe('in-place-operand', () => {
  // CHARSEL_ScrollCharList 00439e60.
  it('works on a call result in place before its one use', () => {
    const r = run('void f(int nDelta) { int nPos = Refresh(gp); SetPos(gp, nPos + nDelta); }');
    assert.deepStrictEqual(r.sites, ['nPos:operand']);
    assert.ok(r.out.includes('int nPos = Refresh(gp); nPos += nDelta; SetPos(gp, nPos);'), r.out);
  });

  // LinkPortal 0056cf40: a byte of flags or-ed with a constant that fits it.
  it('or-s a narrow unsigned value with a constant that fits it', () => {
    const r = run('void f(Unit *p) { uint8_t nFlags; nFlags = GetFlags(p); SetFlags(p, nFlags | 3); }');
    assert.ok(r.out.includes('nFlags = GetFlags(p); nFlags |= 3; SetFlags(p, nFlags);'), r.out);
    assert.deepStrictEqual(run('void f(Unit *p) { uint8_t nFlags; nFlags = GetFlags(p); SetFlags(p, nFlags + 3); }').sites, []);
    assert.deepStrictEqual(run('void f(Unit *p) { uint8_t nFlags; nFlags = GetFlags(p); SetFlags(p, nFlags | 0x100); }').sites, []);
  });

  // Missiles_SrvDmgFunc_SynergyCappedPoisonLength 005ad530.
  it('computes a second variable from the first in the second', () => {
    const r = run('int f(Unit *p, Game *pGame) { int nExpire; int nDelta; nExpire = GetTargetX(p); nDelta = nExpire - pGame->dwFrame; return nDelta; }');
    assert.deepStrictEqual(r.sites, ['nDelta:result']);
    assert.ok(r.out.includes('nDelta = GetTargetX(p); nDelta -= pGame->dwFrame; return nDelta;'), r.out);
  });

  it('leaves a value read again, one of another signedness, and arguments that call', () => {
    assert.deepStrictEqual(run('void f(int d) { int n = R(); S(n + d); T(n); }').sites, []);
    assert.deepStrictEqual(run('void f(unsigned int d) { int n = R(); S(n + d); }').sites, []);
    assert.deepStrictEqual(run('void f(int d) { int n = R(); S(Q(), n + d); }').sites, []);
    assert.deepStrictEqual(run('void f(int d) { int n = R(); int *p = &n; S(n + d); }').sites, []);
  });

  // SKILLS_ApplySkillToHitAndDamage 0056c600 matches as printed.
  it('leaves a sum with a computed local, and a value that is no call result', () => {
    assert.deepStrictEqual(run('void f(Unit *p) { int nToHit = Get(p); int nBonus = Bonus(p); Set(p, nBonus + nToHit, 0); }').sites, []);
    assert.deepStrictEqual(run('void f(int d) { int n = 0x11a; S(n + d); }').sites, []);
  });
});
