import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const tag = 'lift(a.pOwner,a.nFlags)';

function run(source: string, t = tag): { out: string; site: Vc8FormSite } {
  const form = parseVc8Form(t);
  assert.ok(form, `parses ${t}`);
  const sites: Vc8FormSite[] = [];
  const tu = applyVc8Forms(parse(source) as TranslationUnit, [{ form, tag: t }], s => sites.push(s));
  return { out: flat(emit(tu as AnyNode)), site: sites[0]! };
}

function refuses(source: string, t = tag): void {
  const { out, site } = run(source, t);
  assert.strictEqual(site.applied, false, out);
  assert.strictEqual(out, flat(emit(parse(source) as AnyNode)));
}

// Live Win Ghidra 004e14d0 SKILLSMON_CreateMissileWithSeed (Redivivus #536): the owner is
// stored to [EBP-0x58] at 004e1506, before the seed write-back and the flag test.
const seed = 'Unit *f(Unit *u, int m) { Arg a; memset(&a, 0, 92); Seed s = next(u->seed); a.nFlags = 37; u->seed.hi = s.hi; u->seed.lo = s.lo; if (s.lo & 3) { a.nFlags = 16421; } int t = u->type; a.pOwner = u; a.nMissile = m; return Make(&a); }';

describe('vc8-form lift', () => {
  it('parses two members of one spelling', () => {
    assert.deepStrictEqual(parseVc8Form(tag), { op: 'lift', target: 'a.pOwner', after: 'a.nFlags' });
    for (const t of ['lift(a.pOwner)', 'lift(a.f,a.f)', 'lift(p->f,a.g)', 'lift(v,a.g)', 'lift(a.f,a.g,@1)']) assert.strictEqual(parseVc8Form(t), undefined, t);
  });

  it('moves the owner store up past the seed write-back, the flag test and a declaration', () => {
    const { out, site } = run(seed);
    assert.ok(site.applied, site.why);
    assert.match(out, /a\.nFlags = 37; a\.pOwner = u; u->seed\.hi = s\.hi;/);
    assert.match(out, /int t = u->type; a\.nMissile = m;/);
  });

  it('refuses an escaped struct, a passed statement naming the field, or storing the value', () => {
    refuses(seed.replace('memset(&a, 0, 92);', 'memset(&a, 0, 92); Keep(&a);'));
    refuses(seed.replace('a.nFlags = 16421;', 'a.pOwner = 0;'));
    refuses(seed.replace('int t = u->type;', 'int t = u->type; u = Other();'));
    refuses(seed.replace('int t = u->type;', 'Use(a);'));
  });

  it('refuses a passed statement that can leave, or a value that is not plain', () => {
    refuses(seed.replace('a.nFlags = 16421; }', 'a.nFlags = 16421; return 0; }'));
    refuses(seed.replace('a.pOwner = u;', 'a.pOwner = Find(u);'));
    refuses(seed.replace('a.pOwner = u;', 'a.pOwner = u->next;'));
  });

  it('refuses a missing or repeated anchor', () => {
    refuses(seed, 'lift(a.pOwner,a.nOther)');
    refuses(seed.replace('a.nFlags = 37;', 'a.nFlags = 37; a.nFlags = 38;'));
  });
});
