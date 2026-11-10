import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(lines: string[], ...forms: string[]): { out: string; sites: Vc8FormSite[] } {
  const sites: Vc8FormSite[] = [];
  const parsed = forms.map(f => {
    const form = parseVc8Form(f);
    assert.ok(form, `parses: ${f}`);
    return { form: form!, tag: f };
  });
  const tu = applyVc8Forms(parse(lines.join('\n')) as TranslationUnit, parsed, s => sites.push(s));
  return { out: flat(emit(tu as AnyNode)), sites };
}

function refused(lines: string[], form: string): void {
  const { out, sites } = run(lines, form);
  assert.strictEqual(sites[0].applied, false, `${form} should refuse`);
  assert.strictEqual(out, flat(emit(parse(lines.join('\n')) as AnyNode)));
}

describe('vc8-form shapes: parsing', () => {
  it('reads the new ops', () => {
    assert.deepStrictEqual(parseVc8Form('nest(a != 1)'), { op: 'nest', cond: 'a != 1', index: 1 });
    assert.deepStrictEqual(parseVc8Form('merge-tail(!p,2)'), { op: 'merge-tail', cond: '!p', index: 2 });
    assert.deepStrictEqual(parseVc8Form('cmp(-1 < n,mirror-lit)'), { op: 'cmp', cond: '-1 < n', how: 'mirror-lit', index: 0 });
    assert.deepStrictEqual(parseVc8Form('seq(a,b,@2)'), { op: 'seq', targets: ['a', 'b'], index: 2 });
    assert.deepStrictEqual(parseVc8Form('dup(g(a, b))'), { op: 'dup', stmt: 'g(a, b)' });
    assert.deepStrictEqual(parseVc8Form('split(v,int,v2)'), { op: 'split', name: 'v', type: 'int', rename: 'v2' });
    assert.strictEqual(parseVc8Form('cmp(a < b,flip)'), undefined);
    assert.strictEqual(parseVc8Form('nest()'), undefined);
  });
});

describe('vc8-form shapes: nest', () => {
  // MONSTER_IsMonsterUnit 005a4ee0.
  it('nests the rest under the negated guard', () => {
    const { out, sites } = run(['int f(U* p) {', '  if (p->t != 1) {', '    return 0;', '  }', '  g();', '  return 1;', '}'], 'nest(p->t != 1)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'int f(U* p) { if (p->t == 1) { g(); return 1; } else { return 0; } }');
  });
  // SKILLMONST_SrvDoFunc092_MeleeHitThenMissile 005cbf90: the tag was measured before
  // sgptDataTable moved to D2Common::ITEMS::Items (Game.exe v1969); same site.
  it('finds a site whose global is now namespace-qualified', () => {
    const { out, sites } = run(['int f(int n) {', '  if (n >= Items::sgptDataTable->nSize) {', '    return 0;', '  }', '  g();', '  return 1;', '}'], 'nest(n >= sgptDataTable->nSize)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'int f(int n) { if (n < Items::sgptDataTable->nSize) { g(); return 1; } else { return 0; } }');
  });
  // TXT_LvlWarp_Setup 0061f310: the arm ends in a halt, exit() never returns.
  it('takes an arm that ends in exit() as leaving', () => {
    const { out, sites } = run(['int f(U* p) {', '  if (p) {', '    { g(); exit(-1); }', '  }', '  h();', '  exit(-1);', '}'], 'nest(p)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'int f(U* p) { if (!p) { h(); exit(-1); } else { { g(); exit(-1); } } }');
  });
  it('refuses a guard that can fall through', () => {
    refused(['int f(U* p) {', '  if (p) {', '    g();', '  }', '  return 1;', '}'], 'nest(p)');
  });
  it('refuses to move a case label', () => {
    refused(['int f(int n) {', '  switch (n) {', '  case 1:', '    if (n) return 0;', '    g();', '  case 2:', '    return 2;', '  }', '  return 1;', '}'], 'nest(n)');
  });
});

describe('vc8-form shapes: merge-tail', () => {
  // SKILLS_CalculateManaCostShifted 006459f0.
  it('merges a guard into the block\'s return', () => {
    const { out, sites } = run(['int f(int n) {', '  if (n >= 0) {', '    return n;', '  }', '  n = 0;', '  return n;', '}'], 'merge-tail(n >= 0)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'int f(int n) { if (n < 0) { n = 0; } return n; }');
  });
  // DRAW_WORLD_IsUnitInLineOfSight 004dc710: the arm's copy goes.
  it('drops an arm\'s return that falls through to the same return', () => {
    const { out, sites } = run(['int f(U* p) {', '  if (p) {', '    g();', '    return 1;', '  }', '  return 1;', '}'], 'merge-tail(p)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'int f(U* p) { if (p) { g(); } return 1; }');
  });
  // a tail after the if becomes the else arm (OBJECTS_AppendGfxInfo-style, 0046e610).
  it('moves the statements before the return into an else', () => {
    const { out, sites } = run(['int f(U* p, U* q) {', '  if (!p) {', '    g();', '    return 1;', '  }', '  p->n = q;', '  return 1;', '}'], 'merge-tail(!p)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'int f(U* p, U* q) { if (!p) { g(); } else { p->n = q; } return 1; }');
  });
  it('refuses different returns', () => {
    refused(['int f(int n) {', '  if (n) {', '    return 0;', '  }', '  g();', '  return 1;', '}'], 'merge-tail(n)');
  });
});

describe('vc8-form shapes: continue', () => {
  // RosterPets UpdateLifeAndArea 00479010.
  it('ends a loop body in a continue', () => {
    const { out, sites } = run(['void f(P* p) {', '  while (1) {', '    p = p->n;', '    if (!p) {', '      return;', '    }', '  }', '}'], 'continue(!p)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(P* p) { while (1) { p = p->n; if (p) { continue; } return; } }');
  });
  it('refuses outside a loop body', () => {
    refused(['void f(P* p) {', '  if (!p) {', '    return;', '  }', '}'], 'continue(!p)');
  });
});

describe('vc8-form shapes: dup', () => {
  // OBJECT_ClientFn_TimedSpecial1Or2_23to33s 004bd900.
  it('writes the statement after an if/else into both arms', () => {
    const { out, sites } = run(['void f(U* u, int c) {', '  int n;', '  if (c) {', '    n = 3;', '  } else {', '    n = 4;', '  }', '  g(u, n);', '  h();', '}'], 'dup(g(u, n))');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(U* u, int c) { int n; if (c) { n = 3; g(u, n); } else { n = 4; g(u, n); } h(); }');
  });
  it('refuses without a final else', () => {
    refused(['void f(int c) {', '  if (c) {', '    a();', '  }', '  g();', '}'], 'dup(g())');
  });
  it('refuses an arm that would capture a name', () => {
    refused(['void f(int c, int n) {', '  if (c) {', '    int n = 2;', '    a(n);', '  } else {', '    b();', '  }', '  g(n);', '}'], 'dup(g(n))');
  });
  it('refuses an arm ending in a jump', () => {
    refused(['void f(int c) {', '  if (c) {', '    return;', '  } else {', '    b();', '  }', '  g();', '}'], 'dup(g())');
  });
});

describe('vc8-form shapes: expressions', () => {
  it('tarms swaps a conditional\'s arms', () => {
    const { out, sites } = run(['int f(int n) {', '  return g(n > 0x4e ? 0x4e : -1);', '}'], 'tarms(n > 0x4e)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'int f(int n) { return g(n <= 0x4e ? -1 : 0x4e); }');
  });
  it('zero writes !E as E == 0', () => {
    const { out, sites } = run(['int f(int a, int b) {', '  if (!(a && b)) {', '    return 0;', '  }', '  return 1;', '}'], 'zero(a && b)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'int f(int a, int b) { if ((a && b) == 0) { return 0; } return 1; }');
  });
  it('nonzero writes a truth test as E != 0', () => {
    const { out, sites } = run(['int f(int a, int b) {', '  if (a && b) {', '    return 0;', '  }', '  return 1;', '}'], 'nonzero(a && b)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'int f(int a, int b) { if ((a && b) != 0) { return 0; } return 1; }');
  });
  // SpinnerImplementation::OnMouseWheel 004bc050.
  it('cmp mirror-lit writes -1 < n as n >= 0 for a signed n', () => {
    const { out, sites } = run(['int f(int n) {', '  if (-1 < n) {', '    return 1;', '  }', '  return 0;', '}'], 'cmp(-1 < n,mirror-lit)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'int f(int n) { if (n >= 0) { return 1; } return 0; }');
  });
  it('cmp lit moves a literal across the bound', () => {
    const { out, sites } = run(['int f(int n) {', '  return n >= 4;', '}'], 'cmp(n >= 4,lit)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'int f(int n) { return n > 3; }');
  });
  it('cmp lit refuses to cross zero on an unsigned side', () => {
    refused(['int f(uint32_t n) {', '  return n > -1;', '}'], 'cmp(n > -1,lit)');
  });
  it('cmp lit refuses a floating compare', () => {
    refused(['int f(double d) {', '  return d < 4;', '}'], 'cmp(d < 4,lit)');
  });
  it('swap writes b op a', () => {
    const { out, sites } = run(['int f(int a, int b) {', '  return a + b < 3;', '}'], 'swap(a + b)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'int f(int a, int b) { return b + a < 3; }');
  });
  it('swap refuses two operands with effects', () => {
    refused(['int f() {', '  return g() + h();', '}'], 'swap(g() + h())');
  });
});

describe('vc8-form shapes: selects and declarations', () => {
  // SOUND volume 00515f50.
  it('ifsel writes a select into a variable as if/else', () => {
    const { out, sites } = run(['void f(int c) {', '  uint32_t v = c ? gV : 0;', '  g(v);', '}'], 'ifsel(v)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(int c) { uint32_t v; if (c) { v = gV; } else { v = 0; } g(v); }');
  });
  // SOUND_CalculateAngle2 004b9370.
  it('select writes a guard and the last return as one select', () => {
    const { out, sites } = run(['float f(float a, float b) {', '  if (a < b) {', '    return a;', '  }', '  return b;', '}'], 'select(a < b)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'float f(float a, float b) { return a < b ? a : b; }');
  });
  it('unselect writes a returned select as a guard', () => {
    const { out, sites } = run(['char f(int n) {', '  return n == 0xb ? 0x72 : 0x6c;', '}'], 'unselect(n == 0xb)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'char f(int n) { if (n == 0xb) { return 0x72; } return 0x6c; }');
  });
  it('decl moves a bare declaration before another', () => {
    const { out, sites } = run(['void f() {', '  int a;', '  int b;', '  P c;', '  g(&c, a, b);', '}'], 'decl(c,a)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f() { P c; int a; int b; g(&c, a, b); }');
  });
  it('decl refuses an initialized declaration', () => {
    refused(['void f() {', '  int a;', '  int c = 1;', '  g(a, c);', '}'], 'decl(c,a)');
  });
  // SkillDesc AdjustDamageByType 004e8d90.
  it('split gives a dead-ended life its own variable', () => {
    const { out, sites } = run(['void f(int* p) {', '  int v;', '  v = g(1);', '  *p = v;', '  v = g(2);', '  *p += v;', '}'], 'split(v,int,v2)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(int* p) { int v; v = g(1); *p = v; int v2 = g(2); *p += v2; }');
  });
  // Skills_CltDoFunc_DualMissileWithZ 004f1d80: `nCalcA = nAuraRange2 * nCalcA;`.
  it('split begins a life at a store that reads the old value', () => {
    const { out, sites } = run(['void f(int* p, int a) {', '  int v = a;', '  *p = v;', '  v = v * 3;', '  g(v);', '  *p = v;', '}'], 'split(v,int,v2)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(int* p, int a) { int v = a; *p = v; int v2 = v * 3; g(v2); *p = v2; }');
  });
  it('split refuses a life that reads the old value when the value lives on', () => {
    refused(['void f(int* p, int a) {', '  int v = a;', '  v = v * 3;', '  g(v);', '  v += 1;', '  *p = v;', '}'], 'split(v,int,v2)');
  });
  it('split refuses inside a loop', () => {
    refused(['void f(int* p) {', '  int v;', '  while (*p) {', '    v = g(1);', '    *p = v;', '  }', '}'], 'split(v,int,v2)');
  });
});

describe('vc8-form shapes: seq and fold extensions', () => {
  // SOUNDHDR 004823e0: the second of two runs.
  it('seq @k picks one of several runs', () => {
    const { out, sites } = run(['void f(S* s) {', '  s->a = 0;', '  s->b = 0;', '  g();', '  s->a = 0;', '  s->b = 0;', '}'], 'seq(s->b,s->a,@2)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(S* s) { s->a = 0; s->b = 0; g(); s->b = 0; s->a = 0; }');
  });
  it('seq moves ++ and compound stores', () => {
    const { out, sites } = run(['void f(int* p, int* q) {', '  p++;', '  q += 3;', '}'], 'seq(q,p)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(int* p, int* q) { q += 3; p++; }');
  });
  it('seq reads a member by its whole name', () => {
    const { out, sites } = run(['void f(S* s) {', '  s->eOwnerType = 1;', '  s->eOwnerTypeEx = 2;', '  s->nGUID = -1;', '}'], 'seq(s->nGUID,s->eOwnerType,s->eOwnerTypeEx)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(S* s) { s->nGUID = -1; s->eOwnerType = 1; s->eOwnerTypeEx = 2; }');
  });
  it('seq ignores a dependency whose order the move keeps', () => {
    const { out, sites } = run(['void f(A a, int* p) {', '  a.o = *p;', '  a.f = 1;', '  a.m = a.o;', '}'], 'seq(a.f,a.o,a.m)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(A a, int* p) { a.f = 1; a.o = *p; a.m = a.o; }');
  });
  // TXT sounds 004baa50: the temporary is stored in a loop body; nothing reads it on the next pass first.
  it('fold takes a temporary stored inside a loop body', () => {
    const { out, sites } = run(['void f(N* p) {', '  int n;', '  for (; p; p = p->x) {', '    n = p->id;', '    g(n);', '  }', '}'], 'fold(n)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(N* p) { for (; p; p = p->x) { g(p->id); } }');
  });
  it('fold refuses a value the next pass reads first', () => {
    refused(['void f(N* p) {', '  int n = 0;', '  for (; p; p = p->x) {', '    h(n);', '    n = p->id;', '    g(n);', '  }', '}'], 'fold(n)');
  });
  // SERVER_PlayerUpdateExperience 0057e510: in-place-operand's `V = E; V -= 1;`.
  it('fold takes a compound store right after the store as part of the value', () => {
    const { out, sites } = run(['void f(int c) {', '  int v = g(c);', '  v -= 1;', '  h(c, v * 2);', '}'], 'fold(v)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(int c) { h(c, (g(c) - 1) * 2); }');
  });
  // SummonOrSpawnMode 0063ea70: one temporary reused in sibling blocks, each storing first.
  it('fold takes a temporary reused across sibling blocks that each store before reading', () => {
    const { out, sites } = run([
      'void f(U* u, int* px, int* py) {', '  int n;',
      '  if (px) {', '    n = gx(u);', '    *px = n + 1;', '  }',
      '  if (py) {', '    n = gy(u);', '    *py = n + 2;', '  }', '}'], 'fold(n)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(U* u, int* px, int* py) { if (px) { *px = gx(u) + 1; } if (py) { *py = gy(u) + 2; } }');
  });
  it('fold refuses a temporary a later sibling may read before storing', () => {
    // Only one arm stores: the other path reads the value of the first block.
    refused([
      'void f(U* u, int* px, int* py) {', '  int n;',
      '  if (px) {', '    n = gx(u);', '    *px = n + 1;', '  }',
      '  if (py) {', '    n = gy(u);', '    *py = n;', '  }', '  h(n);', '}'], 'fold(n)');
    // A jump between the block and the store: its paths are not followed.
    refused([
      'void f(U* u, int* px, int c) {', '  int n;',
      '  while (c) {', '    if (px) {', '      n = gx(u);', '      *px = n + 1;', '    }',
      '    if (c > 2) break;', '    n = 0;', '    h(n);', '  }', '  h(n);', '}'], 'fold(n)');
  });
  it('fold refuses a compound store whose operand calls', () => {
    refused(['void f(int c) {', '  int v = g(c);', '  v -= k(c);', '  h(c, v);', '}'], 'fold(v)');
  });
});

describe('vc8-form shapes: hoist', () => {
  // D2WINTIMER_GetElapsed 004fd8f0: the callback argument is stored above the test.
  const timer = ['int f(T* t) {', '  M m;', '  P p;', '  p = t->c.fp;', '  if (p) {', '    m.pControl = &t->c;', '    (*p)(&m);', '  }', '  return 1;', '}'];
  it('parses', () => {
    assert.deepStrictEqual(parseVc8Form('hoist(m.pControl = &t->c)'), { op: 'hoist', stmt: 'm.pControl = &t->c', index: 0 });
    assert.deepStrictEqual(parseVc8Form('hoist(x = 1,2)'), { op: 'hoist', stmt: 'x = 1', index: 2 });
    assert.strictEqual(parseVc8Form('hoist()'), undefined);
  });
  it('writes the first store of the arm before the if', () => {
    const { out, sites } = run(timer, 'hoist(m.pControl = &t->c;)');
    assert.strictEqual(sites[0].applied, true, sites[0].why);
    assert.strictEqual(out, flat('int f(T* t) { M m; P p; p = t->c.fp; m.pControl = &t->c; if (p) { (*p)(&m); } return 1; }'));
  });
  it('picks the i-th of several', () => {
    const { out, sites } = run(['void f(int a, int b) {', '  int x;', '  int y;', '  if (a) {', '    x = 1;', '    g(x);', '  }', '  if (b) {', '    y = 1;', '    g(y);', '  }', '}'], 'hoist(y = 1,1)');
    assert.strictEqual(sites[0].applied, true, sites[0].why);
    assert.ok(out.includes('y = 1; if (b) { g(y); }'), out);
  });
  it('refuses when the local is read outside the arm', () => {
    refused(['void f(int a) {', '  int x;', '  x = 0;', '  if (a) {', '    x = 1;', '    g(x);', '  }', '  g(x);', '}'], 'hoist(x = 1)');
  });
  it('refuses a value that loads through a pointer', () => {
    refused(['void f(S* p) {', '  int x;', '  if (p) {', '    x = p->n;', '    g(x);', '  }', '}'], 'hoist(x = p->n)');
    refused(['void f(S* p) {', '  int* x;', '  if (p) {', '    x = &p->q->n;', '    g(x);', '  }', '}'], 'hoist(x = &p->q->n)');
  });
  it('refuses a division, a call or a store through memory', () => {
    refused(['void f(int a, int d) {', '  int x;', '  if (a) {', '    x = a / d;', '    g(x);', '  }', '}'], 'hoist(x = a / d)');
    refused(['void f(int a) {', '  int x;', '  if (a) {', '    x = h();', '    g(x);', '  }', '}'], 'hoist(x = h())');
    refused(['void f(int a, S* p) {', '  if (a) {', '    p->n = 1;', '    g();', '  }', '}'], 'hoist(p->n = 1)');
  });
  it('refuses when the test calls, the if has an else, or the store is the whole arm', () => {
    refused(['void f(int a) {', '  int x;', '  if (h(a)) {', '    x = a;', '    g(x);', '  }', '}'], 'hoist(x = a)');
    refused(['void f(int a) {', '  int x;', '  if (a) {', '    x = a;', '    g(x);', '  } else {', '    g(0);', '  }', '}'], 'hoist(x = a)');
    refused(['void f(int a) {', '  int x;', '  if (a) {', '    x = a;', '  }', '}'], 'hoist(x = a)');
  });
  it('refuses a parameter or a local declared with a value', () => {
    refused(['void f(int a, int x) {', '  if (a) {', '    x = a;', '    g(x);', '  }', '}'], 'hoist(x = a)');
    refused(['void f(int a) {', '  int x = 2;', '  if (a) {', '    x = a;', '    g(x);', '  }', '}'], 'hoist(x = a)');
  });
});
