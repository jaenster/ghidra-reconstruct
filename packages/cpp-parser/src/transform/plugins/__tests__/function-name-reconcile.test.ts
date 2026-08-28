import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { functionNameReconcilePlugin } from '../builtins/function-name-reconcile.js';

describe('functionNameReconcilePlugin', () => {
  function transformCode(code: string, aliases: Record<string, string>): string {
    const ast = parse(code);
    const transformer = functionNameReconcilePlugin.createTransformer({ aliases });
    return emit(transformer(ast) as AnyNode);
  }

  it('respells a renamed callee with the name the declaration uses', () => {
    const out = transformCode(
      'void f() { Storm::Source::SBig::BigBuffer_Div(a, b, c); }',
      { 'Storm::Source::SBig::BigBuffer_Div': 'Storm::Source::SBig::SBIG_DivMod' }
    );
    assert.ok(/Storm::Source::SBig::SBIG_DivMod\(a, b, c\)/.test(out), out);
    assert.ok(!/BigBuffer_Div/.test(out), out);
  });

  it('respells the qualifier too when the function moved namespace', () => {
    const out = transformCode(
      'void f() { D2Client::WindowHandle::SHA1_Init(pCtx); }',
      { 'D2Client::WindowHandle::SHA1_Init': 'Storm::Source::SSignature::SHA1_Init' }
    );
    assert.ok(/Storm::Source::SSignature::SHA1_Init\(pCtx\)/.test(out), out);
    assert.ok(!/WindowHandle/.test(out), out);
  });

  it('promotes a bare reference to the declaration namespace', () => {
    const out = transformCode(
      'void f() { OldName(x); }',
      { OldName: 'Storm::Source::SBig::NewName' }
    );
    assert.ok(/Storm::Source::SBig::NewName\(x\)/.test(out), out);
  });

  it('demotes a qualified reference whose declaration is at root scope', () => {
    const out = transformCode(
      'void f() { Some::Where::OldName(x); }',
      { 'Some::Where::OldName': 'NewName' }
    );
    assert.ok(/\bNewName\(x\)/.test(out), out);
    assert.ok(!/Some::Where/.test(out), out);
  });

  it('leaves names that are not in the alias table alone', () => {
    const src = 'void f() { A::B::Untouched(x); Bare(y); }';
    const out = transformCode(src, { 'A::B::Other': 'A::B::Renamed' });
    assert.ok(/A::B::Untouched\(x\)/.test(out), out);
    assert.ok(/\bBare\(y\)/.test(out), out);
  });

  it('is idempotent — a respelled reference is not an alias key', () => {
    const aliases = { 'A::B::Old': 'A::B::New' };
    const once = transformCode('void f() { A::B::Old(x); }', aliases);
    const twice = transformCode(once, aliases);
    assert.strictEqual(twice.trim(), once.trim());
  });

  it('does nothing at all with an empty table', () => {
    const src = 'void f() { A::B::Old(x); }';
    assert.ok(/A::B::Old\(x\)/.test(transformCode(src, {})), src);
  });
});
