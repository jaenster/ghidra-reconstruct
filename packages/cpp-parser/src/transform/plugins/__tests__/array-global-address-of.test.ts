import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { arrayGlobalAddressOfPlugin } from '../builtins/array-global-address-of.js';

describe('arrayGlobalAddressOfPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = arrayGlobalAddressOfPlugin.createTransformer({});
    return emit(transformer(ast) as AnyNode);
  }

  it('drops the spurious & on a Ghidra _ARRAY_ global', () => {
    const out = transformCode('void f() { g(&eD2Sounds_ARRAY_00728cc8); }');
    assert.ok(/g\(eD2Sounds_ARRAY_00728cc8\)/.test(out), out);
    assert.ok(!/&\s*eD2Sounds/.test(out), out);
  });

  it('keeps the & on an ELEMENT address', () => {
    const out = transformCode('void f() { g(&D2MonSeqMonsterTbls_ARRAY_007481f0[14]); }');
    assert.ok(/g\(&D2MonSeqMonsterTbls_ARRAY_007481f0\[14\]\)/.test(out), out);
  });

  it('keeps the & when the subscript is a whole expression, not a literal', () => {
    // The predecessor's `(?!\s*\[)` lookahead was re-implementing "is the next
    // thing a subscript"; the parse answers it whatever the index looks like.
    const out = transformCode('void f() { g(&eD2Sounds_ARRAY_00728cc8[nIndex + 1]); }');
    assert.ok(/&eD2Sounds_ARRAY_00728cc8\[/.test(out), out);
  });

  it('leaves a non-array global alone', () => {
    const out = transformCode('void f() { g(&gpBufferSystem); }');
    assert.ok(/g\(&gpBufferSystem\)/.test(out), out);
  });

  it('leaves the same characters inside a string literal alone', () => {
    const out = transformCode('void f() { Log("&eD2Sounds_ARRAY_00728cc8"); }');
    assert.ok(out.includes('"&eD2Sounds_ARRAY_00728cc8"'), out);
  });
});
