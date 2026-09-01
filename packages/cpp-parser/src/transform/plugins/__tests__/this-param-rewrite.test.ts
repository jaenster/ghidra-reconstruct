import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { thisParamRewritePlugin } from '../builtins/this-param-rewrite.js';

describe('thisParamRewritePlugin', () => {
  function transformCode(code: string, options: Record<string, unknown> = {}): string {
    const ast = parse(code);
    const transformer = thisParamRewritePlugin.createTransformer(options);
    return emit(transformer(ast) as AnyNode);
  }

  it('rewrites the `this` expression to the declared parameter name', () => {
    const out = transformCode(
      'void dummy() { *(int *)(this + 4) = 1; nResult = *(int *)(this + 0x10); }',
      { thisName: 'pThis' }
    );
    assert.ok(!/\bthis\b/.test(out), out);
    assert.ok(/pThis \+ 4/.test(out), out);
    assert.ok(/pThis \+ 0x10/.test(out), out);
  });

  it('uses whatever name the caller supplies (first param of a free function)', () => {
    const out = transformCode('void dummy() { g(this); }', { thisName: 'pUnit' });
    assert.ok(/g\(pUnit\)/.test(out), out);
  });

  it('binds `this` to the LOCAL of that name, not to the parameter', () => {
    // Ghidra's `BigBuffer *this;` reaches the parser as `BigBuffer *self;`
    // (`preprocessGhidraCode` legalizes the declaration; the bare uses keep the
    // keyword). Both spellings are one variable, and it is not the hidden
    // argument: `BigBuffer_Rand` declared an unused `BigBuffer* self` and read
    // every field of it off `uint *pnResult` instead.
    const out = transformCode(
      'void dummy() { BigBuffer *self; this = (BigBuffer *)a; n = this->nStartWord; }',
      { thisName: 'pnResult' }
    );
    assert.ok(!/pnResult/.test(out), out);
    assert.ok(/self = \(BigBuffer\s*\*\)a/.test(out), out);
    assert.ok(/self->nStartWord/.test(out), out);
  });

  it('leaves `this` inside a string literal alone', () => {
    // `body.replace(/\bthis\b/g, 'pThis')` had no way to see that these
    // characters are inside a literal, so it corrupted the message.
    const out = transformCode(
      'void dummy() { Log("this unit is dead"); }',
      { thisName: 'pThis' }
    );
    assert.ok(out.includes('"this unit is dead"'), out);
  });

  it('leaves `this` inside a comment alone', () => {
    const out = transformCode(
      'void dummy() {\n  // this is the ECX argument\n  g(this);\n}',
      { thisName: 'pThis' }
    );
    assert.ok(out.includes('// this is the ECX argument'), out);
    assert.ok(/g\(pThis\)/.test(out), out);
  });

  it('is a no-op without a name to use', () => {
    const out = transformCode('void dummy() { g(this); }');
    assert.ok(/g\(this\)/.test(out), out);
  });
});
