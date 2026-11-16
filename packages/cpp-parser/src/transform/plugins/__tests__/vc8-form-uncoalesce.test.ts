import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(source: string, tag = 'uncoalesce(n,nLeft)'): { out: string; site: Vc8FormSite } {
  const form = parseVc8Form(tag);
  assert.ok(form, `parses ${tag}`);
  const sites: Vc8FormSite[] = [];
  const tu = applyVc8Forms(parse(source) as TranslationUnit, [{ form, tag }], s => sites.push(s));
  return { out: flat(emit(tu as AnyNode)), site: sites[0]! };
}

function refuses(source: string, tag?: string): void {
  const { out, site } = run(source, tag);
  assert.strictEqual(site.applied, false, out);
  assert.strictEqual(out, flat(emit(parse(source) as AnyNode)));
}

// Live Win Ghidra 0054e1e0 MONSTER_SetMinionsForBoss (Redivivus #536): the count is
// tested in one register, then copied to [EBP-4] for the do-while after the JLE.
const minions = 'void f(int g) { int32_t n = roll() % 3 + 1; if (n <= 0) { return; } do { spawn(g); n--; } while (n); }';

describe('vc8-form uncoalesce', () => {
  it('parses two distinct names', () => {
    assert.deepStrictEqual(parseVc8Form('uncoalesce(nMinionCount,nLeft)'), { op: 'uncoalesce', name: 'nMinionCount', rename: 'nLeft' });
    for (const tag of ['uncoalesce(n)', 'uncoalesce(n,n)', 'uncoalesce(n,int)', 'uncoalesce(n,m,@1)']) assert.strictEqual(parseVc8Form(tag), undefined, tag);
  });

  it('gives the countdown its own local after the guard', () => {
    const { out, site } = run(minions);
    assert.ok(site.applied, site.why);
    assert.strictEqual(out, 'void f(int g) { int32_t n = roll() % 3 + 1; if (n <= 0) { return; } int32_t nLeft = n; do { spawn(g); nLeft--; } while (nLeft); }');
  });

  it('renames reads after the loop in the same block', () => {
    const { out, site } = run('int f() { int n = get(); while (n > 3) n -= 2; return n; }');
    assert.ok(site.applied, site.why);
    assert.strictEqual(out, 'int f() { int n = get(); int nLeft = n; while (nLeft > 3) nLeft -= 2; return nLeft; }');
  });

  it('refuses a parameter, an escaped local, a taken name, or no loop', () => {
    refuses('void f(int n) { do { n--; } while (n); }');
    refuses('void f() { int n = get(); keep(&n); do { n--; } while (n); }');
    refuses('void f() { int n = get(); int nLeft = 0; do { n--; } while (n); }');
    refuses('void f() { int n = get(); if (n) use(n); }');
  });

  it('refuses a local declared in a nested statement, shadowed, or a jump', () => {
    refuses('void f() { for (int n = get(); n; n--) use(n); }');
    refuses('void f() { int n = get(); { int n = 2; use(n); } do { n--; } while (n); }');
    refuses('void f() { int n = get(); do { if (n == 2) goto L; n--; } while (n); L: return; }');
  });
});
