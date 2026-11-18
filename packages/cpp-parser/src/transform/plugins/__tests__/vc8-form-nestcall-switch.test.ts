import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(src: string, form: string): { out: string; site: Vc8FormSite } {
  const sites: Vc8FormSite[] = [];
  const tu = applyVc8Forms(parse(src) as TranslationUnit, [{ form: parseVc8Form(form)!, tag: form }], s => sites.push(s));
  return { out: flat(emit(tu as AnyNode)), site: sites[0] };
}

// OBJMODE_CreateRedPortal (00581410) as the generator holds it when the form runs: the
// store's value is dead after the next statement, and what follows is a switch whose cases
// and breaks all stay inside it.
const RED_PORTAL = `void f(Game * pGame, Unit * pUnit) {
  Room* pRoom = GetRoom(pUnit);
  int nLevelId2 = GetLevelId(pRoom);
  int eLevel = 127;
  switch (nLevelId2) {
    case 111: { eLevel = 125; break; }
    case 112: { eLevel = 126; break; }
  }
  Unit* pPortalUnit = LinkPortal(pGame, nullptr, pUnit, eLevel, nLevelId2);
  if (pPortalUnit) { SetFlags(pPortalUnit, GetFlags(pPortalUnit) | 3); }
  Toggle(GetRoom(pUnit), 0);
  Toggle(GetRoom(pPortalUnit), 0);
}`;

describe('nestcall past a statement whose jumps stay inside it', () => {
  it('nests across a switch with its own cases and breaks', () => {
    const { out, site } = run(RED_PORTAL, 'nestcall(pRoom)');
    assert.strictEqual(site.applied, true, site.why);
    assert.match(out, /int nLevelId2 = GetLevelId\(GetRoom\(pUnit\)\);/);
    assert.doesNotMatch(out, /pRoom/);
  });

  it('nests across a loop whose break and continue stay inside it', () => {
    const src = `int f(Unit * u, int n) {
  Room* r = GetRoom(u);
  int a = Use(r);
  for (int i = 0; i < n; i++) { if (i == 3) continue; if (i == 7) break; a += i; }
  return a;
}`;
    const { out, site } = run(src, 'nestcall(r)');
    assert.strictEqual(site.applied, true, site.why);
    assert.match(out, /int a = Use\(GetRoom\(u\)\);/);
  });

  it('refuses when a break leaves for an enclosing loop that reads the value again', () => {
    const src = `void f(Unit * u, int n) {
  Room* r = 0;
  while (n--) {
    Use(r);
    r = GetRoom(u);
    Use(r);
    if (n == 2) { switch (n) { case 1: break; } break; }
    r = 0;
  }
}`;
    const { site } = run(src, 'nestcall(r)');
    assert.strictEqual(site.applied, false);
  });

  it('still ends the proof at a case label of an outer switch', () => {
    const src = `void f(Unit * u, int k) {
  switch (k) {
    case 0: {
      Room* r = GetRoom(u);
      Use(r);
      if (k) { case 1: Other(); }
    }
  }
}`;
    const { site } = run(src, 'nestcall(r)');
    assert.strictEqual(site.applied, false);
  });
});
