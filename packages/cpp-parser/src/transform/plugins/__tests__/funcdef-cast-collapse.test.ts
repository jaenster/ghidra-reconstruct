import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { funcdefCastCollapsePlugin } from '../builtins/funcdef-cast-collapse.js';

describe('funcdefCastCollapsePlugin', () => {
  function transformCode(code: string, funcdefTypedefs: string[]): string {
    const ast = parse(code);
    const transformer = funcdefCastCollapsePlugin.createTransformer({ funcdefTypedefs });
    return emit(transformer(ast) as AnyNode);
  }

  it('collapses (Funcdef*) to (Funcdef) for a known funcdef typedef', () => {
    const out = transformCode('void f() { p->fpFunction = (AI_Main*)x; }', ['AI_Main']);
    assert.ok(/\(\s*AI_Main\s*\)\s*x/.test(out), `expected (AI_Main)x in:\n${out}`);
    assert.ok(!/\(\s*AI_Main\s*\*\s*\)/.test(out), `must not keep (AI_Main*) in:\n${out}`);
  });

  it('leaves (T*) casts to a non-funcdef type alone', () => {
    const out = transformCode('void f() { p = (D2UnitStrc*)x; }', ['AI_Main']);
    assert.ok(/\(\s*D2UnitStrc\s*\*\s*\)/.test(out), `D2UnitStrc* cast must be preserved in:\n${out}`);
  });

  it('leaves a (Funcdef) single cast unchanged', () => {
    const out = transformCode('void f() { p = (AI_Main)x; }', ['AI_Main']);
    assert.ok(/\(\s*AI_Main\s*\)\s*x/.test(out), out);
  });

  it('is a no-op when no funcdef typedef names are supplied', () => {
    const out = transformCode('void f() { p = (AI_Main*)x; }', []);
    assert.ok(/\(\s*AI_Main\s*\*\s*\)/.test(out), `with no names, cast must be untouched in:\n${out}`);
  });
});
