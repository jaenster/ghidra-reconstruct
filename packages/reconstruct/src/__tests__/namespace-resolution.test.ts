/**
 * One namespace resolution, keyed on address, rendered by every emission path.
 *
 * The bug this replaces: five paths derived an emitted namespace from Ghidra's
 * `Module::Folder::File` string, three different ways, so a symbol could be
 * DECLARED in one namespace and DEFINED in another with nothing to diagnose it.
 * `D2Common::Item::ItemMods` (declared full, defined collapsed) and
 * `D2Game::Quests::Quests::A1Q0` (declared collapsed, defined full) were the two
 * directions of the same fault.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  NamespaceResolution,
  buildNamespaceResolution,
  namespaceResolution,
  renderNamespace,
} from '../codegen/namespace-resolution.js';

describe('the namespace resolution is one rule on segments', () => {
  const types = new Set(['Item', 'Direct3D', 'D2WinImage', 'QServer']);

  it('collapses a Folder::File duplication', () => {
    const r = new NamespaceResolution(types);
    assert.strictEqual(
      renderNamespace(r.resolvePath('D2Game::Quests::Quests::A1Q0')),
      'D2Game::Quests::A1Q0',
    );
  });

  it('collapses only ADJACENT duplicates', () => {
    const r = new NamespaceResolution(types);
    assert.strictEqual(
      renderNamespace(r.resolvePath('D2Common::Path::Room::Path')),
      'D2Common::Path::Room::Path',
    );
  });

  it('drops a LAST segment that names a type', () => {
    const r = new NamespaceResolution(types);
    assert.strictEqual(
      renderNamespace(r.resolvePath('D2Client::Renderer::Direct3D')),
      'D2Client::Renderer',
    );
  });

  it('keeps an INTERMEDIATE segment that names a type', () => {
    // `Item` is a struct and a real folder namespace. Dropping it puts the
    // definition in D2Common::ItemMods, a scope its own header never opens.
    const r = new NamespaceResolution(types);
    assert.strictEqual(
      renderNamespace(r.resolvePath('D2Common::Item::ItemMods')),
      'D2Common::Item::ItemMods',
    );
    assert.strictEqual(
      renderNamespace(r.resolvePath('Fog::QServer::QServerNT')),
      'Fog::QServer::QServerNT',
    );
  });

  it('keeps a SOLE type-named segment — there is nothing left to hold the symbol', () => {
    const r = new NamespaceResolution(types);
    assert.strictEqual(renderNamespace(r.resolvePath('Direct3D')), 'Direct3D');
  });

  it('renders root scope as undefined, not as an empty string', () => {
    const r = new NamespaceResolution(types);
    assert.strictEqual(renderNamespace(r.resolvePath(undefined)), undefined);
    assert.strictEqual(renderNamespace(r.resolvePath('')), undefined);
  });

  it('keeps Ghidra\'s own path for provenance and never re-parses it', () => {
    const r = new NamespaceResolution(types);
    const resolved = r.resolvePath('D2Game::Quests::Quests::A1Q0');
    assert.deepStrictEqual([...resolved.ghidraSegments], ['D2Game', 'Quests', 'Quests', 'A1Q0']);
    assert.deepStrictEqual([...resolved.segments], ['D2Game', 'Quests', 'A1Q0']);
  });

  it('gives the declaration side and the definition side the SAME entity', () => {
    const r = new NamespaceResolution(types);
    const decl = r.claim('0065e620', 'D2Common::Item::ItemMods');
    const def = r.byAddress('0065e620');
    assert.strictEqual(decl, def, 'address identity must return the same object');
    // …and a second holder of the same path gets the same object too, so the two
    // can never drift apart even without an address.
    assert.strictEqual(r.resolvePath('D2Common::Item::ItemMods'), decl);
  });

  it('claims every symbol given to the builder', () => {
    buildNamespaceResolution(types, [
      { address: '00598980', namespace: 'D2Game::Quests::Quests::A2Q1' },
      { address: '007beeac', namespace: 'D2Client::UI::Hireables' },
    ]);
    assert.strictEqual(
      renderNamespace(namespaceResolution().byAddress('00598980')),
      'D2Game::Quests::A2Q1',
    );
    assert.strictEqual(
      namespaceResolution().render({ address: '007beeac' }),
      'D2Client::UI::Hireables',
    );
  });
});
