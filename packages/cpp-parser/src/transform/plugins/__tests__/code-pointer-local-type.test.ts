/**
 * `code *` is Ghidra's "function pointer, signature unknown", and it reaches the
 * compiler as `int (*)(...)` — a concrete type that converts to and from nothing.
 * These pin the one case where the body itself supplies the type, and the case
 * where it supplies several and must be left alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { codePointerLocalTypePlugin } from '../builtins/code-pointer-local-type.js';

function run(src: string): string {
  const ast = parse(src);
  const transformed = codePointerLocalTypePlugin.createTransformer()(ast);
  return emit(transformed as AnyNode).replace(/\s+/g, ' ').trim();
}

describe('code-pointer-local-type', () => {
  it('adopts the type of the single function the body assigns', () => {
    const out = run('void f() { code* pfn = GetCurrentThread; }');
    assert.ok(out.includes('auto pfn = GetCurrentThread'), out);
  });

  it('follows a qualified function name', () => {
    const out = run('void f() { code* pfn = Wrappers::CRT_ExceptionFilter2; }');
    assert.ok(out.includes('auto pfn = Wrappers::CRT_ExceptionFilter2'), out);
  });

  it('accepts a later assignment naming the same function', () => {
    const out = run('void f() { code* pfn = GetCurrentThread; while (x) { pfn = GetCurrentThread; } }');
    assert.ok(out.includes('auto pfn = GetCurrentThread'), out);
  });

  it('refuses a slot reused for a second function — there is no one type for it', () => {
    const out = run('void f() { code* pfn = Draw; pfn = Push; }');
    assert.ok(out.includes('code* pfn'), out);
  });

  it('refuses a cast source: the cast is what hides the disagreement', () => {
    const out = run('void f() { code* pfn = Draw; pfn = (code*)Push; }');
    assert.ok(out.includes('code* pfn'), out);
  });

  it('refuses a declaration with no initialiser', () => {
    const out = run('void f() { code* pfn; pfn = Draw; }');
    assert.ok(out.includes('code* pfn'), out);
  });

  it('leaves a `code *` initialised from anything but a name', () => {
    const out = run('void f() { code* pfn = (code*)0x401000; }');
    assert.ok(out.includes('code* pfn'), out);
  });

  it('does not touch a local of any other type', () => {
    const out = run('void f() { int* p = Draw; }');
    assert.ok(out.includes('int* p'), out);
  });
});
