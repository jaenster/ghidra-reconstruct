import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { tebFieldAccessPlugin, tebFieldExpression } from '../builtins/teb-field-access.js';

const fields = {
  ProcessEnvironmentBlock: { type: 'void *', offset: 0x30 },
  LastErrorValue: { type: 'uint32_t', offset: 0x34 },
  TlsSlots: { type: 'void *', offset: 0xe10, count: 64 },
};

function transformCode(code: string): string {
  const transformer = tebFieldAccessPlugin.createTransformer({ tebFields: fields });
  return emit(transformer(parse(code)) as AnyNode);
}

describe('teb-field-access', () => {
  it('spells a field as the running thread block at its offset, typed as the label', () => {
    assert.strictEqual(tebFieldExpression(fields.ProcessEnvironmentBlock), '(*(void **)((char *)NtCurrentTeb() + 0x30))');
    assert.strictEqual(tebFieldExpression(fields.LastErrorValue), '(*(uint32_t *)((char *)NtCurrentTeb() + 0x34))');
  });

  it('decays an array field to a pointer to its first element', () => {
    assert.strictEqual(tebFieldExpression(fields.TlsSlots), '((void **)((char *)NtCurrentTeb() + 0xe10))');
  });

  // DEBUG_EnumerateModulesViaPEB 00404e60 walks the loader list through ProcessEnvironmentBlock.
  it('rewrites a read and a write of the field', () => {
    const out = transformCode('void f() { int p = *(int *)((int)ProcessEnvironmentBlock + 0xc); LastErrorValue = 0; }');
    assert.ok(out.includes('(int)*(void**)((char*)NtCurrentTeb() + 0x30) + 0xc'), out);
    assert.ok(out.includes('*(uint32_t*)((char*)NtCurrentTeb() + 0x34) = 0;'), out);
    assert.ok(!/\bProcessEnvironmentBlock\b/.test(out), out);
  });

  it('rewrites a root-qualified reference', () => {
    const out = transformCode('void f() { int e = ::LastErrorValue; }');
    assert.ok(out.includes('NtCurrentTeb() + 0x34'), out);
  });

  it('leaves member names, qualified names and same-named locals alone', () => {
    const out = transformCode('void f(TEB *t) { int a = t->LastErrorValue; int b = Ns::LastErrorValue; }');
    assert.ok(out.includes('t->LastErrorValue'), out);
    assert.ok(out.includes('Ns::LastErrorValue'), out);
    assert.ok(!out.includes('NtCurrentTeb'), out);
    const local = transformCode('void f() { int LastErrorValue = 1; g(LastErrorValue); }');
    assert.ok(!local.includes('NtCurrentTeb'), local);
  });

  it('is a no-op without fields', () => {
    const transformer = tebFieldAccessPlugin.createTransformer({});
    const out = emit(transformer(parse('void f() { LastErrorValue = 0; }')) as AnyNode);
    assert.ok(out.includes('LastErrorValue = 0'), out);
  });
});
