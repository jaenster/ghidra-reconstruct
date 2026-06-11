import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { declInitMergePlugin } from '../builtins/decl-init-merge.js';

describe('declInitMergePlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = declInitMergePlugin.createTransformer({});
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  it('should merge basic decl + assign', () => {
    const output = transformCode('void f() { int x; x = 5; use(x); }');
    assert.strictEqual(output, 'void f() {\n  int x = 5;\n  use(x);\n}');
  });

  it('should sink the declaration to the assignment site (not hoist the init up)', () => {
    // The merged decl lands where the assignment was, AFTER the intermediate
    // statement — never hoisted above it.
    const output = transformCode('void f() { int x; y = 1; x = 5; }');
    assert.strictEqual(output, 'void f() {\n  y = 1;\n  int x = 5;\n}');
  });

  it('must not hoist an initializer above guard clauses (use-before-check bug)', () => {
    const output = transformCode(`X* f(U* pGame) {
  M* pMon;
  C* pCur;
  if (!pGame) return nullptr;
  pMon = pGame->data;
  if (!pMon) return nullptr;
  pCur = pMon->list;
  if (!pCur) return nullptr;
  return pCur;
}`);
    assert.strictEqual(output, `X* f(U* pGame) {
  if (!pGame)
    return nullptr;
  M* pMon = pGame->data;
  if (!pMon)
    return nullptr;
  C* pCur = pMon->list;
  if (!pCur)
    return nullptr;
  return pCur;
}`);
  });

  it('should not merge when variable is read before assignment', () => {
    const output = transformCode('void f() { int x; foo(x); x = 5; }');
    assert.ok(output.includes('int x;'), 'should keep bare declaration');
    assert.ok(output.includes('x = 5;'), 'should keep separate assignment');
  });

  it('should not merge static variables', () => {
    const output = transformCode('void f() { static int x; x = 5; }');
    assert.ok(output.includes('static int x;'), 'should keep static declaration');
    assert.ok(output.includes('x = 5;'), 'should keep separate assignment');
  });

  it('should not merge compound assignments', () => {
    const output = transformCode('void f() { int x; x += 5; }');
    assert.ok(output.includes('int x;'), 'should keep bare declaration');
    assert.ok(output.includes('x += 5;'), 'should keep compound assignment');
  });

  it('should merge pointer type declarations', () => {
    const output = transformCode('void f() { int* p; p = &val; }');
    assert.strictEqual(output, 'void f() {\n  int* p = &val;\n}');
  });

  it('should not merge when assignment is nested in a scope', () => {
    const output = transformCode('void f() { int x; if (c) { x = 5; } }');
    assert.ok(output.includes('int x;'), 'should keep bare declaration at outer level');
  });

  it('should not merge when RHS references the variable (self-reference)', () => {
    const output = transformCode('void f() { int x; x = x + 1; }');
    assert.ok(output.includes('int x;'), 'should keep bare declaration');
    assert.ok(output.includes('x = x + 1;'), 'should keep self-referencing assignment');
  });

  it('should merge multiple declarations in one pass (real-world pattern)', () => {
    const input = `void DRLG_MapWorldToScreenCoords(int32_t* pX, int32_t* pY) {
  int x;
  int y;
  x = *pX;
  y = *pY;
  *pX = x - y >> 1;
  *pY = y + x >> 2;
}`;
    const output = transformCode(input);
    assert.ok(output.includes('int x = *pX;'), 'x should be merged');
    assert.ok(output.includes('int y = *pY;'), 'y should be merged');
    assert.ok(!output.includes('int x;\n'), 'no bare x declaration');
    assert.ok(!output.includes('int y;\n'), 'no bare y declaration');
  });

  it('should have correct metadata', () => {
    assert.strictEqual(declInitMergePlugin.id, 'decl-init-merge');
    assert.strictEqual(declInitMergePlugin.priority, 60);
    assert.strictEqual(declInitMergePlugin.defaultEnabled, true);
    assert.ok(declInitMergePlugin.tags?.includes('cleanup'));
  });
});
