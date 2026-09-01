/**
 * Regression test: a demangled C++ template instantiation used as an *identifier*
 * must be flattened to a valid C++ identifier before it is emitted.
 *
 * Ghidra demangles the Storm/D2CMP hash-table templates back into their source
 * spelling, so symbol names carry `<`, `>` and `,`:
 *
 *   TSHashTableReuse<struct_CELLIST,class_HASHKEY_NONE,0>::TSHASH_FreePoolNode
 *   TSExportTableSimple<struct_CELLIST,struct_HCELLIST__*,0>::TSEXPORT_SimpleDtor_CelList
 *   TSHashTable<struct_SGAMEDATA,class_HASHKEY_NONE>::vftable
 *
 * Nothing named `TSHashTableReuse` is ever declared in the tree - the templates
 * were never instantiated, only their instantiations exist as flat symbols - so
 * emitting them verbatim is a reference to a type that does not exist (~65 errors).
 * The definition side already flattens: header.ts:934 runs field names through
 * `replace(/[^a-zA-Z0-9_]/g, '_')`, generateStaticLocalDeclaration
 * (globals-header.ts:534) does the same for the variable name, and
 * generateGlobalsImpl/generateColocatedGlobalsImpl skip any namespace matching
 * `/[<>,*]/` outright. Only the reference sites emitted by `emitDataValue` keep
 * the angle brackets.
 *
 * `parseTemplateName` (codegen/namespace.ts:36-80) already splits these into a
 * base name plus parameters, so the pieces needed to build a flat identifier are
 * on hand.
 *
 * Fixture is the verbatim static vtable at recon/diablo-2/_unnamespaced.cpp:9163
 * (the D2CMP cel-list hash table set up by CELDATAHASH_InitHashTable,
 * 1.14d Game.exe 0060aee0).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue,
  generateStaticLocalDeclaration,
} from '../codegen/globals-header.js';
import { parseTemplateName } from '../codegen/namespace.js';
import type { AnalyzedDataSymbol, DataValue } from '../types.js';

/** recon/diablo-2/_unnamespaced.cpp:9163 - `static pointer vftable[4] = { ... }`. */
const CELLIST_VTABLE: DataValue = {
  kind: 'array',
  elements: [
    { kind: 'pointer', value: 'TSHashTableReuse<struct_CELLIST,class_HASHKEY_NONE,0>::TSHASH_FreePoolNode' },
    { kind: 'pointer', value: 'TSHashTableReuse<struct_CELLIST,class_HASHKEY_NONE,0>::TSHASH_AllocAndLinkCelListNode' },
    { kind: 'pointer', value: 'TSExportTableSimple<struct_CELLIST,struct_HCELLIST__*,0>::TSEXPORT_SimpleDtor_CelList' },
    { kind: 'pointer', value: 'TSHashTableReuse<struct_CELLIST,class_HASHKEY_NONE,0>::TSHASH_ClearBuckets' },
  ],
};

const CELLIST_VTABLE_SYMBOL: AnalyzedDataSymbol = {
  name: 'vftable',
  address: '006fd2a0',
  dataType: 'pointer[4]',
  size: 16,
  isInitialized: true,
  xrefCount: 1,
  scope: 'static-local',
  ownerFunction: 'D2CMP::CelDataHash::CELDATAHASH_InitHashTable',
  initializedData: CELLIST_VTABLE,
};

describe('demangled template names are flattened into C++ identifiers', () => {
  it('emitDataValue does not leak < > , into a pointer reference', () => {
    const out = emitDataValue(CELLIST_VTABLE, 0);

    assert.doesNotMatch(out, /[<>]/);
    assert.doesNotMatch(out, /,\s*(?:struct|class)_/);
  });

  it('every emitted reference is a qualified identifier', () => {
    const out = emitDataValue(CELLIST_VTABLE, 0);

    for (const ref of out.match(/&[^\s,{}]+/g) ?? []) {
      assert.match(
        ref.slice(1),
        /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/,
        `not a usable C++ identifier: ${ref}`
      );
    }
  });

  it('the flattened name keeps the base template and its parameters', () => {
    const out = generateStaticLocalDeclaration(CELLIST_VTABLE_SYMBOL);
    assert.ok(out, 'static-local declaration should be emitted');

    assert.doesNotMatch(out!, /[<>]/);
    // Base name and every parameter survive, so the two TS* tables stay distinct.
    assert.match(out!, /TSHashTableReuse\w*_struct_CELLIST\w*::TSHASH_FreePoolNode/);
    assert.match(out!, /TSExportTableSimple\w*_struct_CELLIST\w*::TSEXPORT_SimpleDtor_CelList/);
  });

  it('parseTemplateName already supplies the pieces to build that identifier', () => {
    // This half works today - it is the machinery the emitter fails to use.
    const t = parseTemplateName('TSHashTableReuse<struct_CELLIST,class_HASHKEY_NONE,0>');
    assert.strictEqual(t.isTemplate, true);
    assert.strictEqual(t.baseName, 'TSHashTableReuse');
    assert.deepStrictEqual(t.params, ['struct_CELLIST', 'class_HASHKEY_NONE', '0']);

    const u = parseTemplateName('TSHashTable<struct_SGAMEDATA,class_HASHKEY_NONE>');
    assert.strictEqual(u.baseName, 'TSHashTable');
    assert.deepStrictEqual(u.params, ['struct_SGAMEDATA', 'class_HASHKEY_NONE']);
  });
});
