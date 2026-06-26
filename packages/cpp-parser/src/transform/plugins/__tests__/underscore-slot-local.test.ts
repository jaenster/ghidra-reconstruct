import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { underscoreSlotLocalPlugin } from '../builtins/underscore-slot-local.js';

describe('underscoreSlotLocalPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = underscoreSlotLocalPlugin.createTransformer({});
    return emit(transformer(ast) as AnyNode);
  }

  it('declares `_bResult` even when it only appears in `return _bResult;`', () => {
    // The regex predecessor misparsed `return _bResult;` as a declaration (type
    // `return`, name `_bResult`) and so never synthesized it. The AST sees a
    // ReturnStmt, so this is unambiguous.
    const out = transformCode('uint32_t f() { bool bResult; _bResult = 1; return _bResult; }');
    assert.ok(/\b_bResult\b/.test(out), out);
    assert.ok(/;\s*_bResult\s*;|_bResult;/.test(out.replace(/\n/g, ' ')), `expected a '_bResult;' decl in:\n${out}`);
  });

  it('types the synthesized local from the base local', () => {
    const out = transformCode('void f(uint16_t nSuffixId) { _nSuffixId = nSuffixId; }');
    assert.ok(/uint16_t\s+_nSuffixId\s*;/.test(out), `expected 'uint16_t _nSuffixId;' in:\n${out}`);
  });

  it('does NOT synthesize for `_DAT_*` globals', () => {
    const out = transformCode('void f() { _DAT_001234 = 5; }');
    assert.ok(!/\b\w+\s+_DAT_001234\s*;/.test(out), `must not declare a local for _DAT_001234 in:\n${out}`);
  });

  it('does NOT synthesize when there is no matching declared base', () => {
    const out = transformCode('void f(int nOther) { _mysteryThing = nOther; }');
    assert.ok(!/\b\w+\s+_mysteryThing\s*;/.test(out), `must not declare _mysteryThing in:\n${out}`);
  });
});
