import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { enclosingNamespaceStripPlugin } from '../builtins/enclosing-namespace-strip.js';

describe('enclosingNamespaceStripPlugin', () => {
  function run(code: string, options: Record<string, unknown>): string {
    const ast = parse(code);
    return emit(enclosingNamespaceStripPlugin.createTransformer(options)(ast) as AnyNode);
  }

  it('drops the whole enclosing prefix for a same-scope reference', () => {
    const out = run('void f() { A::B::C::sym(); }', { enclosingSegments: ['A', 'B', 'C'] });
    assert.ok(/\bsym\(\)/.test(out), out);
    assert.ok(!/A::B::C::sym/.test(out), out);
  });

  it('drops only the shared prefix for a cousin reference', () => {
    const out = run('void f() { A::B::C::sym(); }', { enclosingSegments: ['A', 'Bx'] });
    assert.ok(/\bB::C::sym\(\)/.test(out), out);
  });

  it('refuses a strip a sibling namespace would intercept', () => {
    // Inside D2Common::Unit::Monster, `Path::DynamicPath::GetYPos` binds `Path`
    // to D2Common::Unit::Path, which has no DynamicPath.
    const out = run('void f() { D2Common::Path::DynamicPath::GetYPos(p); }', {
      enclosingSegments: ['D2Common', 'Unit', 'Monster'],
      knownNamespaces: ['D2Common::Unit::Path', 'D2Common::Path', 'D2Common::Path::DynamicPath'],
    });
    assert.ok(/D2Common::Path::DynamicPath::GetYPos/.test(out), out);
  });

  it('leaves a root-qualified reference alone', () => {
    // `::Game::Launcher::f` is explicit; shortening it re-opens the shadowing
    // that put the `::` there.
    const out = run('void f() { ::A::B::sym(); }', { enclosingSegments: ['A', 'B'] });
    assert.ok(/::A::B::sym\(\)/.test(out), out);
  });

  it('leaves an unrelated reference alone', () => {
    const out = run('void f() { X::Y::sym(); }', { enclosingSegments: ['A', 'B'] });
    assert.ok(/X::Y::sym\(\)/.test(out), out);
  });

  it('cannot reach the same characters in a string literal', () => {
    const out = run('void f() { Log("A::B::sym failed"); }', { enclosingSegments: ['A', 'B'] });
    assert.ok(/"A::B::sym failed"/.test(out), out);
  });

  it('does nothing at root scope', () => {
    const out = run('void f() { A::B::sym(); }', { enclosingSegments: [] });
    assert.ok(/A::B::sym\(\)/.test(out), out);
  });
});
