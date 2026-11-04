import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { sharedTailJoinPlugin } from '../builtins/shared-tail-join.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(src: string): { out: string; sites: number[] } {
  const sites: number[] = [];
  const t = sharedTailJoinPlugin.createTransformer({ onSite: (e: { statements: number }) => sites.push(e.statements) });
  return { out: flat(emit(t(parse(src)) as AnyNode)), sites };
}

describe('shared-tail-join', () => {
  it('writes an arm ending in the return after it as an if/else (GFX_FreeGfxInfoEntry 0046e610)', () => {
    const r = run('int f(P *p, P *q, int c) { if (c) { g(p); return 1; } q->n = p; return 1; }');
    assert.deepStrictEqual(r.sites, [1]);
    assert.ok(r.out.includes('if (c) { g(p); } else { q->n = p; } return 1; }'), r.out);
  });

  it('joins the stores ahead of the end of a void function (SOUNDHDR_FreeSoundBuffer 004823e0)', () => {
    const r = run('void f(S *s) { if (s->a) { g(s->a); s->a = 0; s->b = 0; s->n = 0; return; } h(s->b); s->b = 0; s->n = 0; }');
    assert.deepStrictEqual(r.sites, [2]);
    assert.ok(r.out.includes('if (s->a) { g(s->a); s->a = 0; } else { h(s->b); } s->b = 0; s->n = 0; }'), r.out);
  });

  it('folds an else-if chain from its last arm outwards', () => {
    const r = run('void f(S *s, int t) { if (!t) { a(s); s->n = 0; return; } if (t == 0xd) { b(s); s->n = 0; return; } c(s); s->n = 0; }');
    assert.deepStrictEqual(r.sites, [1, 1]);
    assert.ok(r.out.includes('if (!t) { a(s); } else { if (t == 0xd) { b(s); } else { c(s); } } s->n = 0; }'), r.out);
  });

  it('leaves a return the function writes more than twice (Q31_StatusFilter 00586ce0)', () => {
    assert.deepStrictEqual(run('int f(S *s, char *p) { if (s->a) { *p = 1; return 1; } if (s->b) { *p = 2; return 1; } *p = 3; return 1; }').sites, []);
  });

  it('leaves an exit inside the code after the if, and a tail that only returns a local', () => {
    // Joined, these lost matches (Q02_SequenceFilter 005910f0, CheckCollision_Vector 0064d800).
    assert.deepStrictEqual(run('int f(S *s) { if (s->a) { g(s); return 1; } if (!s->b) { return 0; } h(s); return 1; }').sites, []);
    assert.deepStrictEqual(run('int f(int c) { int r; if (c) { r = g(); return r; } r = h(); return r; }').sites, []);
  });

  it('leaves an arm with nothing between the if and the shared exit, and a shared bare return only', () => {
    // Joined, these lost matches (SKILLS_GetTotalSkillLevel 00644aa0, MONMODE_DispatchDeathDrop 005a7ba0).
    assert.deepStrictEqual(run('int f(U *u) { if (u) { u->f |= 4; return 1; } return 1; }').sites, []);
    assert.deepStrictEqual(run('void f(U *u) { if (!u) { g(u); return; } h(u); return; }').sites, []);
  });

  it('leaves a guard, a tail without a way out, and a tail naming an arm declaration', () => {
    assert.deepStrictEqual(run('int f(int c) { if (c) { return 1; } g(); return 1; }').sites, []);
    assert.deepStrictEqual(run('void f(int c) { while (c) { if (c) { g(); h(); } k(); h(); } }').sites, []);
    assert.deepStrictEqual(run('int f(int c) { int x = 0; if (c) { int x = 2; g(); return x; } k(); return x; }').sites, []);
  });
});
