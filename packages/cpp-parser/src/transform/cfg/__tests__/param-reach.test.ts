import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import type { FunctionDecl } from '../../../ast/nodes.js';
import { paramReaches, countedSinkReach, type Reach, type ParamReachContext, type ReachField } from '../param-reach.js';

const SIZES: Record<string, number> = {
  char: 1, undefined1: 1, short: 2, int: 4, uint: 4, undefined4: 4, DWORD: 4, POINT: 8, RECT: 16, Pair: 8,
};
const FIELDS: Record<string, Record<string, ReachField>> = {
  RECT: { left: { offset: 0, type: 'int' }, top: { offset: 4, type: 'int' }, right: { offset: 8, type: 'int' }, bottom: { offset: 12, type: 'int' } },
  Pair: { a: { offset: 0, type: 'int' }, b: { offset: 4, type: 'int' } },
  Box: { name: { offset: 4, type: 'char[16]' } },
};

function reach(code: string, params: { name: string; type: string }[], callee: (n: string, i: number, c: number) => Reach = () => null): Reach[] {
  const tu = parse(code) as unknown as { declarations: FunctionDecl[] };
  const f = tu.declarations.find(d => d.kind === NodeKind.FunctionDecl)!;
  const ctx: ParamReachContext = {
    typeSize: s => (s.endsWith('*') ? 4 : SIZES[s] ?? null),
    field: (a, m) => FIELDS[a]?.[m] ?? null,
    calleeReach: callee,
  };
  return paramReaches(f.body!, params, ctx);
}

describe('paramReaches', () => {
  it('one store through each pointer reaches one element', () => {
    const r = reach('void f(int *a, int *b) { *a = 1; b[0] = 2; }',
      [{ name: 'a', type: 'int *' }, { name: 'b', type: 'int *' }]);
    assert.deepStrictEqual(r, [{ lo: 0, hi: 4 }, { lo: 0, hi: 4 }]);
  });

  it('an index past the declared pointee reaches past it', () => {
    const r = reach('void f(int *p) { int x = p[1]; }', [{ name: 'p', type: 'int *' }]);
    assert.deepStrictEqual(r, [{ lo: 4, hi: 8 }]);
  });

  it('a byte offset through casts is followed', () => {
    const r = reach('void f(int *p) { *(undefined4 *)((int)p + 0xc) = 0; }', [{ name: 'p', type: 'int *' }]);
    assert.deepStrictEqual(r, [{ lo: 12, hi: 16 }]);
  });

  it('a field reaches its own offset and size', () => {
    const r = reach('void f(RECT *r) { r->bottom = 3; }', [{ name: 'r', type: 'RECT *' }]);
    assert.deepStrictEqual(r, [{ lo: 12, hi: 16 }]);
  });

  it('an array field indexed by a variable reaches the whole field', () => {
    const r = reach('void f(Box *b, int i) { b->name[i] = 0; }', [{ name: 'b', type: 'Box *' }]);
    assert.deepStrictEqual(r, [{ lo: 4, hi: 20 }]);
  });

  it('a literal memset count is the reach', () => {
    const r = reach('void f(int *p) { memset(p, 0, 0x10); }', [{ name: 'p', type: 'int *' }]);
    assert.deepStrictEqual(r, [{ lo: 0, hi: 16 }]);
  });

  it('a variable memset count is unknown', () => {
    const r = reach('void f(int *p, int n) { memset(p, 0, n); }', [{ name: 'p', type: 'int *' }]);
    assert.deepStrictEqual(r, [null]);
  });

  it('a pass-through takes the callee reach, shifted', () => {
    const r = reach('void f(int *p) { g(p + 1); }', [{ name: 'p', type: 'int *' }],
      (n, i) => (n === 'g' && i === 0 ? { lo: 0, hi: 4 } : null));
    assert.deepStrictEqual(r, [{ lo: 4, hi: 8 }]);
  });

  it('an unknown callee is unknown', () => {
    const r = reach('void f(int *p) { g(p); }', [{ name: 'p', type: 'int *' }]);
    assert.deepStrictEqual(r, [null]);
  });

  it('a pointer passed to a computed callee is unknown', () => {
    const r = reach('void f(int *p, code *fn) { (*fn)(p); }', [{ name: 'p', type: 'int *' }]);
    assert.deepStrictEqual(r, [null]);
  });

  it('a variable index, a store of the pointer, a reassignment are unknown', () => {
    assert.deepStrictEqual(reach('void f(int *p, int i) { p[i] = 0; }', [{ name: 'p', type: 'int *' }]), [null]);
    assert.deepStrictEqual(reach('void f(int *p) { gp = p; }', [{ name: 'p', type: 'int *' }]), [null]);
    assert.deepStrictEqual(reach('void f(int *p) { p = p + 1; *p = 0; }', [{ name: 'p', type: 'int *' }]), [null]);
    assert.deepStrictEqual(reach('void f(int *p) { int *q = p; *q = 0; }', [{ name: 'p', type: 'int *' }]), [null]);
    assert.deepStrictEqual(reach('int *f(int *p) { return p; }', [{ name: 'p', type: 'int *' }]), [null]);
  });

  it('comparisons and tests touch nothing', () => {
    const r = reach('void f(int *p) { if (p != 0) { if (!p) return; } }', [{ name: 'p', type: 'int *' }]);
    assert.deepStrictEqual(r, [{ lo: 0, hi: 0 }]);
  });

  it('an unused parameter touches nothing', () => {
    const r = reach('void f(int *p) { gx = 1; }', [{ name: 'p', type: 'int *' }]);
    assert.deepStrictEqual(r, [{ lo: 0, hi: 0 }]);
  });

  it('`this` is matched as the keyword', () => {
    const r = reach('void f() { this->b = 1; }', [{ name: 'this', type: 'Pair *' }]);
    assert.deepStrictEqual(r, [{ lo: 4, hi: 8 }]);
  });

  it('a member name spelled like the parameter is not a use', () => {
    const r = reach('void f(int *p, Pair *q) { q->a = 0; }', [{ name: 'a', type: 'int *' }]);
    assert.deepStrictEqual(r, [{ lo: 0, hi: 0 }]);
  });
});

describe('paramReaches options', () => {
  const body = (code: string) => {
    const tu = parse(code) as unknown as { declarations: FunctionDecl[] };
    return tu.declarations.find(d => d.kind === NodeKind.FunctionDecl)!.body!;
  };
  const ctx: ParamReachContext = {
    typeSize: s => (s.endsWith('*') ? 4 : SIZES[s] ?? null),
    field: (a, m) => FIELDS[a]?.[m] ?? null,
    calleeReach: () => null,
  };

  it('partial skips an unfollowable use instead of answering unknown, and reports each use', () => {
    const b = body('void f(int *p) { p[2] = 1; g(p); gx = (int)p; p += 3; }');
    assert.deepStrictEqual(paramReaches(b, [{ name: 'p', type: 'int *' }], ctx), [null]);
    const seen: Reach[] = [];
    const r = paramReaches(b, [{ name: 'p', type: 'int *' }], ctx, { partial: true, onUse: (_u, x) => seen.push(x) });
    assert.deepStrictEqual(r, [{ lo: 8, hi: 12 }]);
    assert.deepStrictEqual(seen, [{ lo: 8, hi: 12 }, null, null, null]);
  });

  it('include leaves the excluded mentions out entirely', () => {
    const b = body('void f(int *p) { p = 0; p[1] = 1; }');
    let n = 0;
    const r = paramReaches(b, [{ name: 'p', type: 'int *' }], ctx, {
      include: u => (n++ > 0),
    });
    assert.deepStrictEqual(r, [{ lo: 4, hi: 8 }]);
  });
});

describe('countedSinkReach', () => {
  it('reads the literal count and ignores other positions', () => {
    const tu = parse('void f() { memcpy(a, b, 8); fread(a, 4, 3, h); }') as unknown as { declarations: FunctionDecl[] };
    const calls: { arguments: never[] }[] = [];
    const body = (tu.declarations[0] as FunctionDecl).body as unknown as { statements: { expression: { arguments: never[] } }[] };
    for (const s of body.statements) calls.push(s.expression);
    assert.deepStrictEqual(countedSinkReach('memcpy', 1, calls[0].arguments), { lo: 0, hi: 8 });
    assert.strictEqual(countedSinkReach('memcpy', 2, calls[0].arguments), undefined);
    assert.deepStrictEqual(countedSinkReach('_fread', 0, calls[1].arguments), { lo: 0, hi: 12 });
    assert.strictEqual(countedSinkReach('GetCursorPos', 0, calls[1].arguments), undefined);
  });
});
