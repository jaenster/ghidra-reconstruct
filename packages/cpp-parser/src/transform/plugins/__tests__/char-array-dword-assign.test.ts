import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { charArrayDwordAssignPlugin } from '../builtins/char-array-dword-assign.js';

describe('charArrayDwordAssignPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = charArrayDwordAssignPlugin.createTransformer({});
    return emit(transformer(ast) as AnyNode);
  }

  it('rewrites `charArray = scalar` to `*(uint32_t*)charArray = scalar`', () => {
    const out = transformCode('void f() { char acCode[4]; acCode = readDword(); }');
    assert.ok(/\*\s*\(\s*uint32_t\s*\*\s*\)\s*acCode\s*=\s*readDword\(\)/.test(out.replace(/\n/g, ' ')),
      `expected *(uint32_t*)acCode = readDword() in:\n${out}`);
  });

  it('leaves a string-literal initializer alone', () => {
    const out = transformCode('void f() { char acCode[4]; acCode = "abc"; }');
    assert.ok(!/uint32_t\s*\*\s*\)\s*acCode/.test(out), `must not rewrite a string assign in:\n${out}`);
  });

  it('leaves a non-char-array local alone', () => {
    const out = transformCode('void f() { int n; n = readDword(); }');
    assert.ok(!/uint32_t\s*\*\s*\)\s*n\b/.test(out), `must not touch scalar n in:\n${out}`);
  });
});
