import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { qualifiedNameCleanupPlugin } from '../builtins/qualified-name-cleanup.js';

describe('qualifiedNameCleanupPlugin', () => {
  function transformCode(code: string, options: Record<string, unknown> = {}): string {
    const ast = parse(code);
    const transformer = qualifiedNameCleanupPlugin.createTransformer(options);
    return emit(transformer(ast) as AnyNode);
  }

  it('collapses a namespace segment repeated back-to-back', () => {
    const out = transformCode(
      'void f() { D2Common::Drlg::Drlg::RollSeed(pLevel); }'
    );
    assert.ok(/D2Common::Drlg::RollSeed\(/.test(out), out);
    assert.ok(!/Drlg::Drlg/.test(out), out);
  });

  it('collapses only ADJACENT duplicates, leaving A::B::A alone', () => {
    const out = transformCode('void f() { Path::Room::Path::GetYPos(p); }');
    assert.ok(/Path::Room::Path::GetYPos/.test(out), out);
  });

  it('drops the VisualStudio / compiler CRT namespaces', () => {
    const out = transformCode(
      'void f() { VisualStudio::sprintf(szBuf, szFmt); compiler::memcpy(a, b, n); }'
    );
    assert.ok(/\bsprintf\(szBuf, szFmt\)/.test(out), out);
    assert.ok(/\bmemcpy\(a, b, n\)/.test(out), out);
    assert.ok(!/VisualStudio/.test(out), out);
    assert.ok(!/compiler::/.test(out), out);
  });

  it('strips the _exref import-thunk suffix', () => {
    const out = transformCode('void f() { Fog_10021_exref(nMode); }');
    assert.ok(/\bFog_10021\(nMode\)/.test(out), out);
    assert.ok(!/_exref/.test(out), out);
  });

  it('leaves the same characters inside a string literal alone', () => {
    // The predecessor regexes ran over the emitted TEXT, so a message string that
    // happens to name a CRT namespace, a repeated qualifier or an _exref symbol
    // was rewritten mid-string. A StringLiteral is not a name node.
    const out = transformCode(
      'void f() { Log("VisualStudio::sprintf failed in Drlg::Drlg::RollSeed via Fog_10021_exref"); }'
    );
    assert.ok(
      out.includes('"VisualStudio::sprintf failed in Drlg::Drlg::RollSeed via Fog_10021_exref"'),
      out
    );
  });
});
