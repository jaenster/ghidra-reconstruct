/**
 * The contract for how a symbol's namespace is decided and emitted.
 *
 * A symbol has exactly ONE namespace. Ghidra states it once, as a
 * `Module::Folder::File` path; the reconstruction resolves it once, keyed on the
 * symbol's address; and every emission path renders that one resolved entity.
 *
 * The bug this exists to prevent is not a formatting bug. When the declaration
 * side and the definition side each derive a namespace from the same path with
 * slightly different rules, the symbol is declared in one scope and defined in
 * another. No compiler diagnoses that, and no linker can resolve it - it surfaces
 * only as an undefined symbol at link time, thousands of lines from the cause.
 * Both real forms of the disagreement are pinned below: `D2Common::Item::ItemMods`
 * declared under the full path and defined one scope up, and
 * `D2Game::Quests::Quests::A1Q0` the exact reverse.
 *
 * These tests are the specification, not a description of the implementation.
 * A change that makes one of them fail is a change to the contract and needs a
 * reason, not an amended assertion.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  NamespaceResolution,
  buildNamespaceResolution,
  namespaceResolution,
  renderNamespace,
} from '../codegen/namespace-resolution.js';

const here = dirname(fileURLToPath(import.meta.url));
const codegenDir = join(here, '..', 'codegen');

/** Struct/union/enum names that exist in the program under test. */
const TYPE_NAMES = new Set([
  'Direct3D',
  'Item',
  'ItemMods',
  'Forms',
]);

function resolver(typeNames: ReadonlySet<string> = TYPE_NAMES): NamespaceResolution {
  return new NamespaceResolution(typeNames);
}

function render(path: string | null | undefined): string | undefined {
  return renderNamespace(resolver().resolvePath(path));
}

describe('namespace resolution: the segment rule', () => {
  it('collapses a segment identical to the one before it', () => {
    // `Quests.cpp` inside the folder namespace `Quests` is ONE C++ namespace.
    assert.equal(render('D2Game::Quests::Quests'), 'D2Game::Quests');
  });

  it('collapses a repeat at the root as readily as one in the middle', () => {
    assert.equal(render('D2Client::UI::UI'), 'D2Client::UI');
    assert.equal(render('D2Win::D2Win::Text::Draw'), 'D2Win::Text::Draw');
  });

  it('does NOT collapse a repeat that is not adjacent', () => {
    // `A::B::A` is a real nested scope, not a doubled segment.
    assert.equal(render('A::B::A'), 'A::B::A');
  });

  it('drops a trailing segment that names a type', () => {
    // `namespace Direct3D` beside `struct Direct3D` is a redeclaration.
    assert.equal(render('D2gfx::Direct3D'), 'D2gfx');
  });

  it('KEEPS an intermediate segment that names a type', () => {
    // This is the whole point. `Item` is also a struct, but here it names a real
    // enclosing namespace. Dropping it moves the definition to a sibling scope
    // that its own declaration cannot reach - which is exactly how ItemMods
    // became an undefined symbol.
    assert.equal(render('D2Common::Item::ItemMods'), 'D2Common::Item');
  });

  it('never strips a sole segment down to root scope', () => {
    // Emitting this at root scope would collide with every other root symbol.
    assert.equal(render('Direct3D'), 'Direct3D');
  });

  it('applies the collapse before the type-name test, not after', () => {
    // `Forms::Forms` collapses to `Forms`, which names a type - but it is now the
    // sole segment, so it survives. Running the two rules in the other order
    // drops it and emits the symbol at root scope.
    assert.equal(renderNamespace(resolver().resolvePath('Forms::Forms')), 'Forms');
  });

  it('lets both rules fire when a doubled segment also names a type', () => {
    // `D2Win::Forms::Forms` collapses to `D2Win::Forms`, whose last segment names
    // a struct, so it drops again to `D2Win`. Two rules, one pass, in order.
    assert.equal(renderNamespace(resolver().resolvePath('D2Win::Forms::Forms')), 'D2Win');
  });

  it('treats an absent, empty or separator-only path as root scope', () => {
    for (const p of [undefined, null, '', '::', '::::']) {
      assert.equal(render(p), undefined, `expected root scope for ${JSON.stringify(p)}`);
    }
  });

  it('never renders an empty, doubled or dangling separator', () => {
    for (const p of ['A::::B', '::A::B', 'A::B::']) {
      const out = render(p);
      assert.ok(out, `expected a namespace for ${p}`);
      assert.ok(!out!.includes(':::'), `doubled separator in ${out}`);
      assert.ok(!out!.startsWith('::') && !out!.endsWith('::'), `dangling separator in ${out}`);
      assert.ok(!out!.split('::').some(s => s.length === 0), `empty segment in ${out}`);
    }
  });
});

describe('namespace resolution: one entity, so the two sides cannot drift', () => {
  it('returns the SAME object for the same path, not an equal copy', () => {
    const r = resolver();
    const declaration = r.resolvePath('D2Common::Item::ItemMods');
    const definition = r.resolvePath('D2Common::Item::ItemMods');
    assert.strictEqual(declaration, definition);
  });

  it('gives two symbols sharing a Ghidra path the same entity', () => {
    const r = resolver();
    const fn = r.claim('0x6fdd1234', 'D2Game::Quests::Quests');
    const global = r.claim('0x6fdd5678', 'D2Game::Quests::Quests');
    assert.strictEqual(fn, global);
  });

  it('resolves a symbol by address, not by re-deriving its path', () => {
    const r = resolver();
    r.claim('0x6fdd1234', 'D2Common::Item::ItemMods');
    // A caller holding a stale spelling of the path still lands on the entity
    // claimed for that address. Address identity is the tiebreak, always.
    const viaStalePath = r.of({ address: '0x6fdd1234', namespace: 'D2Common::ItemMods' });
    assert.equal(renderNamespace(viaStalePath), 'D2Common::Item');
  });

  it('falls back to the path when a symbol arrives with no address', () => {
    const r = resolver();
    r.claim('0x6fdd1234', 'D2Game::Quests::Quests');
    // Not ideal - an addressless symbol is a defect elsewhere - but it must land
    // on the same entity rather than inventing a second one.
    const viaPath = r.of({ namespace: 'D2Game::Quests::Quests' });
    assert.strictEqual(viaPath, r.byAddress('0x6fdd1234'));
  });

  it('keeps Ghidra\'s original path for provenance after resolving', () => {
    const resolved = resolver().resolvePath('D2Common::Item::ItemMods');
    assert.deepEqual([...resolved.ghidraSegments], ['D2Common', 'Item', 'ItemMods']);
    assert.deepEqual([...resolved.segments], ['D2Common', 'Item']);
  });
});

describe('namespace resolution: the run-wide resolution', () => {
  it('claims every symbol handed to it, function and global alike', () => {
    const r = buildNamespaceResolution(TYPE_NAMES, [
      { address: '0x6fdd0001', namespace: 'D2Common::Item::ItemMods' },
      { address: '0x6fdd0002', namespace: 'D2Game::Quests::Quests' },
      { address: '0x6fdd0003', namespace: null },
    ]);
    assert.equal(r.render({ address: '0x6fdd0001' }), 'D2Common::Item');
    assert.equal(r.render({ address: '0x6fdd0002' }), 'D2Game::Quests');
    assert.equal(r.render({ address: '0x6fdd0003' }), undefined);
  });

  it('installs itself as the resolution the emitters reach for', () => {
    const built = buildNamespaceResolution(TYPE_NAMES, [
      { address: '0x6fdd0001', namespace: 'D2Client::UI::UI' },
    ]);
    assert.strictEqual(namespaceResolution(), built);
    assert.equal(namespaceResolution().render({ address: '0x6fdd0001' }), 'D2Client::UI');
  });
});

describe('namespace resolution: the regressions that produced undefined symbols', () => {
  // Each row is a symbol that was declared in one scope and defined in another.
  // The emitted namespace is the contract; both sides render this string.
  const cases: Array<{ symbol: string; ghidra: string; emitted: string | undefined }> = [
    { symbol: 'ITEMMODS_GetModParam', ghidra: 'D2Common::Item::ItemMods', emitted: 'D2Common::Item' },
    { symbol: 'aNpcGossipData_A1Q0', ghidra: 'D2Game::Quests::Quests', emitted: 'D2Game::Quests' },
    { symbol: 'UI_GetUIFlag', ghidra: 'D2Client::UI::UI', emitted: 'D2Client::UI' },
    { symbol: 'D3D_Present', ghidra: 'D2gfx::Direct3D', emitted: 'D2gfx' },
  ];

  for (const { symbol, ghidra, emitted } of cases) {
    it(`${symbol} resolves ${ghidra} to ${emitted ?? '(root)'}`, () => {
      const r = resolver();
      const declarationSide = r.render({ address: '0x6fdd9999', namespace: ghidra });
      const definitionSide = r.render({ address: '0x6fdd9999', namespace: ghidra });
      assert.equal(declarationSide, emitted);
      assert.equal(definitionSide, emitted);
    });
  }
});

describe('namespace resolution: no emission path may re-derive a namespace', () => {
  // Source-level guards. The contract is architectural: if a second place learns
  // to compute a namespace, the two will drift again, and the failure will show
  // up as an unresolved symbol rather than as a test failure here.
  const emitters = [
    'impl.ts',
    'header.ts',
    'globals-header.ts',
    'namespace.ts',
  ];

  function source(file: string): string {
    return readFileSync(join(codegenDir, file), 'utf8');
  }

  for (const file of emitters) {
    it(`${file} does not split a namespace path into segments itself`, () => {
      const text = source(file);
      const offenders = text
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => /\bnamespace\w*\.split\(\s*['"]::['"]/.test(line))
        .filter(([, line]) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'));
      assert.deepEqual(
        offenders,
        [],
        `${file} splits a namespace path; resolution owns the only split:\n` +
          offenders.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n')
      );
    });
  }

  it('the only split of a Ghidra namespace path lives in namespace-resolution.ts', () => {
    const text = readFileSync(join(codegenDir, 'namespace-resolution.ts'), 'utf8');
    const splits = text.split('\n').filter(l => /\.split\(\s*['"]::['"]/.test(l));
    assert.equal(splits.length, 1, 'expected exactly one split of the Ghidra path');
  });
});

describe('namespace rendering: segments become text exactly once', () => {
  it('renders root scope as absent rather than as an empty string', () => {
    // An empty string here would emit `namespace  { }` somewhere downstream.
    assert.equal(renderNamespace({ ghidraSegments: [], segments: [] }), undefined);
    assert.equal(renderNamespace(undefined), undefined);
  });

  it('joins segments without touching them', () => {
    assert.equal(
      renderNamespace({ ghidraSegments: ['A', 'B'], segments: ['A', 'B'] }),
      'A::B'
    );
  });
});
