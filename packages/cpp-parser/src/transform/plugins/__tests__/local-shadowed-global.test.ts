import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { localShadowedGlobalPlugin, type ShadowedGlobalFact } from '../builtins/local-shadowed-global.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(lines: string[], facts: [number, ShadowedGlobalFact[]][]): { out: string; sites: number } {
  let sites = 0;
  const t = localShadowedGlobalPlugin.createTransformer({ shadowedGlobals: new Map(facts), onSite: () => sites++ } as never);
  return { out: flat(emit(t(parse(lines.join('\n'))) as AnyNode)), sites };
}

describe('local-shadowed-global', () => {
  it('respells the recorded token of a root global as ::name', () => {
    const { out, sites } = run(
      ['void f(int nScaleFactor) {', '  nScaleFactor = nScaleFactor;', '}'],
      [[2, [{ name: 'nScaleFactor', ord: 0, total: 2, qualifier: [] }]]],
    );
    assert.strictEqual(out, 'void f(int nScaleFactor) { ::nScaleFactor = nScaleFactor; }');
    assert.strictEqual(sites, 1);
  });

  it('spells a namespaced global with its whole path', () => {
    const { out } = run(
      ['void f(Pet* pRosterPet) {', '  g(pRosterPet, pRosterPet);', '}'],
      [[2, [{ name: 'pRosterPet', ord: 1, total: 2, qualifier: ['D2Client', 'GAME', 'RosterPets'] }]]],
    );
    assert.strictEqual(out, 'void f(Pet* pRosterPet) { g(pRosterPet, ::D2Client::GAME::RosterPets::pRosterPet); }');
  });

  it('counts a member name and a qualified spelling, and respells neither', () => {
    // Line 2 prints `n` three times: a member, the qualified global, the parameter.
    const { out, sites } = run(
      ['void f(S* p, int n) {', '  p->n = Ns::n + n;', '}'],
      [[2, [{ name: 'n', ord: 0, total: 3, qualifier: [] }, { name: 'n', ord: 1, total: 3, qualifier: ['Ns'] }]]],
    );
    assert.strictEqual(out, 'void f(S* p, int n) { p->n = Ns::n + n; }');
    assert.strictEqual(sites, 0);
  });

  it('leaves a line alone whose count differs from the markup', () => {
    const { out } = run(
      ['void f(int n) {', '  n = n;', '}'],
      [[2, [{ name: 'n', ord: 0, total: 1, qualifier: [] }]]],
    );
    assert.strictEqual(out, 'void f(int n) { n = n; }');
  });
});
