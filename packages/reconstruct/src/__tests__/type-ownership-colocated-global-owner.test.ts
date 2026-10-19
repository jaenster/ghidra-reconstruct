/**
 * A struct-colocated global's extern is emitted into `ownerStructHeader`, so that
 * header must be the one that finally owns the global's TYPE.
 *
 * Real 1.14d case (v1096): `D2Game::Quests::QUESTS::A1Q4::aNpcGossipData` is a
 * `D2NPCMessageTableStrc`. Reference scoring gave the type to A1Q4.h, the global
 * was co-located there, and only THEN did single-use co-location move the type
 * into D2QuestDataStrc.h (its only container, `pNpcMessages`). A1Q4.h kept
 * `extern D2NPCMessageTableStrc aNpcGossipData;` with neither the definition
 * nor a forward declaration: 531 "does not name a type" errors, one per TU.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { computeTypeOwnership } from '../modules/type-ownership.js';
import type { AnalyzedDataSymbol, ExtractedFunction, ExtractedStruct } from '../types.js';

function func(name: string, ns: string, params: { name: string; dataType: string }[]): ExtractedFunction {
  return {
    name,
    address: '0x401000',
    signature: `void ${name}()`,
    returnType: 'void',
    parameters: params.map((p, i) => ({ ...p, size: 4, ordinal: i, storage: 'stack' })),
    localVariables: [],
    callingConvention: '__cdecl',
    size: 16,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    namespace: ns,
    calledFunctions: [],
  } as ExtractedFunction;
}

function struct(name: string, fields: { name: string; dataType: string }[]): ExtractedStruct {
  return {
    name,
    category: '/test',
    size: Math.max(4, fields.length * 4),
    kind: 'STRUCTURE',
    fields: fields.map((f, i) => ({ ...f, offset: i * 4, size: 4 })),
  } as ExtractedStruct;
}

describe('computeTypeOwnership: struct-colocated globals', () => {
  it('co-locates a global with the FINAL owner of its type, not an intermediate one', () => {
    const A1Q4 = 'D2Game::Quests::QUESTS::A1Q4';
    const organized = new Map<string, ExtractedFunction[]>([
      [A1Q4, [func('Q04_Callback', A1Q4, [{ name: 'pTable', dataType: 'D2NPCMessageTableStrc *' }])]],
    ]);
    const unitHeaderPaths = new Map([[A1Q4, 'D2Game/Quests/QUESTS/A1Q4.h']]);
    const dataTypes = [
      struct('D2NPCMessageTableStrc', [{ name: 'nCount', dataType: 'int' }]),
      struct('D2QuestDataStrc', [{ name: 'pNpcMessages', dataType: 'D2NPCMessageTableStrc *' }]),
    ];
    const global = {
      name: 'aNpcGossipData',
      address: '0x6f0000',
      dataType: 'D2NPCMessageTableStrc',
      size: 4,
      namespace: A1Q4,
      scope: 'global',
      referencingFunctions: ['Q04_Callback'],
    } as unknown as AnalyzedDataSymbol;

    const { typeOwnerMap } = computeTypeOwnership({
      organized,
      classes: [],
      dataTypes,
      globals: [global],
      unitHeaderPaths,
      // The container is placed by an override, after the containment pass.
      typeOwnershipOverrides: new Map([['D2QuestDataStrc', 'D2Game/D2QuestDataStrc.h']]),
    });

    const typeOwner = typeOwnerMap.get('D2NPCMessageTableStrc');
    assert.strictEqual(typeOwner, 'D2Game/D2QuestDataStrc.h', 'single-use co-location moved the type');
    if (global.scope === 'struct-colocated') {
      assert.strictEqual(global.ownerStructHeader, typeOwner,
        'the extern would land in a header that does not define its type');
    } else {
      assert.strictEqual(global.scope, 'global');
      assert.strictEqual(global.ownerStructHeader, undefined);
    }
  });
});
