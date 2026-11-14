import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isStaticAt, paramKinds, reorderFunction, storageOrders } from './reorder.js';

describe('paramKinds', () => {
  it('tells custom registers from the convention\'s own and from the stack', () => {
    assert.deepEqual(paramKinds('__fastcall', ['ECX:4', 'EDX:4', 'ESI:4']), ['F', 'F', 'R']);
    assert.deepEqual(paramKinds('__fastcall', ['EAX:4', 'ECX:4']), ['R', 'R']);
    assert.deepEqual(paramKinds('__stdcall', ['ECX:4', 'Stack[0x4]:4', 'Stack[0x8]:4', 'ESI:4']), ['R', 'S', 'S', 'R']);
    assert.deepEqual(paramKinds('__thiscall', ['CL:1', 'EDI:4']), ['F', 'R']);
    assert.equal(paramKinds('__cdecl', ['EDX:4,EAX:4', 'Stack[0x4]:4']), undefined);
  });
});

describe('storageOrders', () => {
  it('keeps stack parameters in order and F parameters in place', () => {
    const orders = storageOrders(['R', 'S', 'S', 'R']);
    assert.deepEqual(orders[0], [0, 1, 2, 3]);
    assert.equal(orders.length, 12);
    for (const p of orders) {
      const stack = p.filter(i => i === 1 || i === 2);
      assert.deepEqual(stack, [1, 2]);
    }
    assert.ok(orders.some(p => p.join() === '3,1,2,0'));
    for (const p of storageOrders(['F', 'R', 'R'])) assert.equal(p[0], 0);
    assert.equal(storageOrders(['F', 'R', 'R']).length, 2);
  });

  it('falls back to register-only orders, then to the heuristic few', () => {
    // 2 registers over 6 free positions is 30 placements: over the cap, so 2 orders.
    assert.equal(storageOrders(['R', 'S', 'S', 'S', 'S', 'R']).length, 2);
    const five = storageOrders(['R', 'R', 'R', 'R', 'R'], 24, ['ESI:4', 'EDI:4', 'EBX:4', 'EAX:4', 'EDX:4']);
    assert.ok(five.length > 1 && five.length <= 7);
    assert.deepEqual(five[1], [2, 1, 0, 3, 4]);
  });
});

describe('reorderFunction', () => {
  const tu = [
    'static int f(int a, char *b, int c);',
    '// 1.14d: 00401000',
    'static int f(int a, char *b, int c) { return a + c; }',
    'int g(int *p) { return NS::f(p[0], (char *)g(p, 1), h(1, 2)) + s.f(1) + q->f(2); }',
    '',
  ].join('\n');

  it('re-orders the declaration, the definition and every call, nothing else', () => {
    const r = reorderFunction(tu, 'f', [2, 1, 0]);
    assert.deepEqual(r.errors, []);
    assert.equal(r.sites, 3);
    assert.equal(r.text, [
      'static int f(int c, char *b, int a);',
      '// 1.14d: 00401000',
      'static int f(int c, char *b, int a) { return a + c; }',
      'int g(int *p) { return NS::f(h(1, 2), (char *)g(p, 1), p[0]) + s.f(1) + q->f(2); }',
      '',
    ].join('\n'));
  });

  it('refuses an address-taken function, another arity and a template argument', () => {
    assert.match(reorderFunction(tu + 'void *t = (void *)f;\n', 'f', [1, 0, 2]).errors[0], /other than called/);
    assert.match(reorderFunction(tu + 'int u = f(1, 2);\n', 'f', [1, 0, 2]).errors[0], /2 items for 3/);
    assert.match(reorderFunction(tu + 'int v = f(a < b, c, d > e);\n', 'f', [1, 0, 2]).errors[0], /top-level </);
    assert.equal(reorderFunction(tu + 'void *t = (void *)f;\n', 'f', [1, 0, 2]).sites, 0);
  });

  it('tells a static definition from an extern one', () => {
    const at = tu.indexOf('// 1.14d');
    assert.equal(isStaticAt(tu, at, 'f'), true);
    assert.equal(isStaticAt('// 1.14d: 1\nint __fastcall f(int a, int b) { return 0; }', 0, 'f'), false);
  });
});
