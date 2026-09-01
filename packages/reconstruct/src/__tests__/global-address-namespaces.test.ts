/**
 * The namespace table `global-address-literal` resolves a folded address through.
 *
 * A literal image address is folded into a body anywhere — `Merc.cpp` in
 * `D2Client::UI::NpcMenu` carries the address of `bInteractingWithNpc`, which
 * `globals.h` defines in `D2Client::_Interaction`. Resolved to a BARE name the
 * reference does not compile ("was not declared in this scope; did you mean
 * 'D2Client::_Interaction::bInteractingWithNpc'?"), which is the same fault
 * `func-ptr-literal` already carries `namespaceSegments` to avoid for a function.
 *
 * The table is deliberately narrower than the address table it sits beside:
 * only symbols `globals.h` itself emits, and never one whose leading segment a
 * root-scope entity of the same name can block, because the header folds such a
 * segment away and has not been asked to yet when this is built.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildFuncPtrArgCastTables } from '../codegen/index.js';
import { buildNamespaceResolution } from '../codegen/namespace-resolution.js';
import { setUnopenableRootNames } from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, ExtractedDataType } from '../types.js';

function g(over: Partial<AnalyzedDataSymbol> & { name: string; address: string }): AnalyzedDataSymbol {
  return {
    dataType: 'int',
    size: 4,
    scope: 'global',
    ...over,
  } as AnalyzedDataSymbol;
}

function tables(globals: AnalyzedDataSymbol[], dataTypes: ExtractedDataType[] = []) {
  setUnopenableRootNames(new Set());
  buildNamespaceResolution(
    new Set(dataTypes.filter(d => d.kind === 'STRUCTURE').map(d => d.name)),
    globals,
  );
  return buildFuncPtrArgCastTables([], globals, [], dataTypes);
}

describe('globalNamespaces', () => {
  it('carries the namespace a global is defined in', () => {
    const t = tables([
      g({ name: 'bInteractingWithNpc', address: '006fb1a4', namespace: 'D2Client::_Interaction' }),
    ]);
    assert.deepStrictEqual(t.globalNamespaces?.bInteractingWithNpc, ['D2Client', '_Interaction']);
  });

  it('records root scope as an empty segment list', () => {
    const t = tables([g({ name: 'gnCurrentTimestamp', address: '00989680' })]);
    assert.deepStrictEqual(t.globalNamespaces?.gnCurrentTimestamp, []);
  });

  it('applies the resolution rule, not Ghidra’s raw path', () => {
    // `Quests::Quests` is one namespace: the file inside the folder of the same
    // name. The reference has to spell what the header actually opened.
    const t = tables([
      g({ name: 'gnA1Q0State', address: '0070a000', namespace: 'D2Game::Quests::Quests::A1Q0' }),
    ]);
    assert.deepStrictEqual(t.globalNamespaces?.gnA1Q0State, ['D2Game', 'Quests', 'A1Q0']);
  });

  it('skips a symbol globals.h does not emit', () => {
    // A file-local static is written into its own .cpp by another emitter, in
    // whatever scope that emitter opens. Nothing to say here, so nothing is said.
    const t = tables([
      g({
        name: 'gnLightmapInterpDirX', address: '006f9000',
        namespace: 'D2Client::Draw::LightMap', scope: 'file-local',
      }),
    ]);
    assert.strictEqual(t.globalNamespaces?.gnLightmapInterpDirX, undefined);
  });

  it('skips a leading segment a root-scope struct of the same name can block', () => {
    const t = tables(
      [g({ name: 'gnWardenState', address: '0070b000', namespace: 'WardenClient::Session' })],
      [{ kind: 'STRUCTURE', name: 'WardenClient' } as ExtractedDataType],
    );
    assert.strictEqual(t.globalNamespaces?.gnWardenState, undefined);
  });

  it('drops a name recorded in two different namespaces', () => {
    const t = tables([
      g({ name: 'gnShared', address: '0070c000', namespace: 'D2Client::A' }),
      g({ name: 'gnShared', address: '0070c004', namespace: 'D2Game::B' }),
    ]);
    assert.strictEqual(t.globalNamespaces?.gnShared, undefined);
  });
});
