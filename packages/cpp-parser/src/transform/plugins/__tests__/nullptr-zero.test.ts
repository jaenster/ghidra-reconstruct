import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { nullptrCleanupPlugin } from '../builtins/nullptr-cleanup.js';

describe('nullptrCleanupPlugin — nullptr where an integer is meant', () => {
  function transformCode(code: string, options: Record<string, unknown> = {}): string {
    const ast = parse(code);
    const transformer = nullptrCleanupPlugin.createTransformer(options);
    return emit(transformer(ast) as AnyNode);
  }

  it('rewrites an assigned nullptr to 0', () => {
    const out = transformCode('void f() { nResult = nullptr; }', {
      zeroForAssignedNullptr: true,
    });
    assert.ok(/nResult = 0;/.test(out), out);
  });

  it('rewrites an initializer nullptr to 0', () => {
    const out = transformCode('void f() { uint32_t dwFlags = nullptr; }', {
      zeroForAssignedNullptr: true,
    });
    assert.ok(/dwFlags = 0;/.test(out), out);
  });

  it('rewrites a compared nullptr to 0', () => {
    const out = transformCode('void f() { if (nResult == nullptr) { g(); } }', {
      zeroForAssignedNullptr: true,
    });
    assert.ok(/nResult == 0/.test(out), out);
  });

  it('rewrites `return nullptr` only when told the return type is not a pointer', () => {
    const asPointer = transformCode('void f() { return nullptr; }', {
      zeroForAssignedNullptr: true,
    });
    assert.ok(/return nullptr;/.test(asPointer), asPointer);

    const asInt = transformCode('void f() { return nullptr; }', {
      zeroForAssignedNullptr: true,
      zeroForReturnedNullptr: true,
    });
    assert.ok(/return 0;/.test(asInt), asInt);
  });

  it('also zeroes a nullptr this pass itself produced from a pointer cast', () => {
    const out = transformCode('void f() { return (D2UnitStrc *)0x0; }', {
      zeroForReturnedNullptr: true,
    });
    assert.ok(/return 0;/.test(out), out);
  });

  it('leaves `= nullptr` inside a string literal alone', () => {
    // `body.replace(/=\s*nullptr\b/g, '= 0')` had no way to tell code from a
    // message string.
    const out = transformCode('void f() { Log("pUnit = nullptr"); }', {
      zeroForAssignedNullptr: true,
    });
    assert.ok(out.includes('"pUnit = nullptr"'), out);
  });

  it('is a no-op on all of it unless asked', () => {
    const out = transformCode('void f() { x = nullptr; return nullptr; }');
    assert.ok(/x = nullptr;/.test(out), out);
    assert.ok(/return nullptr;/.test(out), out);
  });
});
