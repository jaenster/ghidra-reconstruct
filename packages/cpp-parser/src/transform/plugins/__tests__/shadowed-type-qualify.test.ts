import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { shadowedTypeQualifyPlugin } from '../builtins/shadowed-type-qualify.js';

describe('shadowedTypeQualifyPlugin', () => {
  function transformCode(code: string, options: Record<string, unknown> = {}): string {
    const ast = parse(code);
    const transformer = shadowedTypeQualifyPlugin.createTransformer(options);
    return emit(transformer(ast) as AnyNode);
  }

  it('root-qualifies a cast to a type a same-named namespace shadows', () => {
    const out = transformCode(
      'void dummy() { pCursor = (Draw**)pControl; }',
      { shadowedTypeNames: ['Draw'] }
    );
    assert.match(out, /\(::Draw\*\*\)/, out);
  });

  it('root-qualifies a local declaration of a shadowed type', () => {
    const out = transformCode(
      'void dummy() { ButtonWrapper * pThis = p; }',
      { shadowedTypeNames: ['ButtonWrapper'] }
    );
    assert.match(out, /::ButtonWrapper\*/, out);
  });

  it('leaves a type nothing shadows alone', () => {
    const out = transformCode(
      'void dummy() { p = (D2UnitStrc*)q; }',
      { shadowedTypeNames: ['Draw'] }
    );
    assert.ok(!out.includes('::D2UnitStrc'), out);
  });

  it('is inert without a table — no name is qualified by default', () => {
    const out = transformCode('void dummy() { p = (Draw*)q; }');
    assert.ok(!out.includes('::Draw'), out);
  });
});
