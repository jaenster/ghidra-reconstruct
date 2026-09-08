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

  it('keeps a qualifier when the bare leaf name is ambiguous', () => {
    // D2Common::Drlg::RoomTile::InitGridCells calls D2Common::Drlg::InitGridCells, a
    // DIFFERENT function (0066ee66 JMP 0x0067d2d0). Stripped to bare, C++ inner-scope
    // lookup binds it to the function being defined: unbounded recursion, and the
    // process dies with STATUS_STACK_OVERFLOW on the Act 1 path.
    // One segment is enough and is what the pass keeps: from inside
    // D2Common::Drlg::RoomTile, `Drlg` resolves to D2Common::Drlg, so
    // `Drlg::InitGridCells` names the intended function. What must NOT survive is the
    // bare leaf.
    const out = run('void f() { D2Common::Drlg::InitGridCells(p); }', {
      enclosingSegments: ['D2Common', 'Drlg', 'RoomTile'],
      ambiguousLeafNames: ['InitGridCells'],
    });
    assert.ok(/Drlg::InitGridCells\(p\)/.test(out), out);
    assert.ok(!/(?<!:)\bInitGridCells\(p\)/.test(out), out);
  });

  it('still strips an unambiguous leaf name', () => {
    const out = run('void f() { D2Common::Drlg::OnlyOne(p); }', {
      enclosingSegments: ['D2Common', 'Drlg', 'RoomTile'],
      ambiguousLeafNames: ['InitGridCells'],
    });
    assert.ok(/\bOnlyOne\(p\)/.test(out), out);
    assert.ok(!/D2Common::Drlg::OnlyOne/.test(out), out);
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

describe('ambiguous data symbols', () => {
  function run(code: string, options: Record<string, unknown>): string {
    const ast = parse(code);
    const transformer = enclosingNamespaceStripPlugin.createTransformer(options);
    return emit(transformer(ast) as AnyNode).trim();
  }

  it('keeps the qualifier on a global name owned by more than one namespace', () => {
    // `vftable` exists under several classes. Stripped bare it binds by inner-scope
    // lookup to whichever one is nearest - a different table of a different type. The
    // ListBox deleting destructor assigned UIWidget's table and no longer compiled.
    const out = run('void f(void) { p = D2Client::UIWidget::vftable; }', {
      enclosingSegments: ['D2Client', 'ListBoxImplementation'],
      knownNamespaces: ['D2Client', 'D2Client::UIWidget', 'D2Client::ListBoxImplementation'],
      ambiguousLeafNames: ['vftable'],
    });
    assert.ok(out.includes('UIWidget::vftable'), `qualifier must survive, got: ${out}`);
  });

  it('still strips a global whose leaf name is unique', () => {
    const out = run('void f(void) { x = D2Client::UIWidget::gnOnlyOne; }', {
      enclosingSegments: ['D2Client', 'UIWidget'],
      knownNamespaces: ['D2Client', 'D2Client::UIWidget'],
      ambiguousLeafNames: ['vftable'],
    });
    assert.ok(!out.includes('UIWidget::gnOnlyOne'), `should strip, got: ${out}`);
  });
});
