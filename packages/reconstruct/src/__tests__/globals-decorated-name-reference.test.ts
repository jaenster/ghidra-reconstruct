/**
 * Regression test: a symbol *reference* emitted by `emitDataValue` must be run
 * through the same identifier sanitizer that the *definition* side uses.
 *
 * Ghidra keeps stdcall/RTTI decoration in symbol names: `_BinkClose@4`,
 * `GLIDEDLL_grLfbLock@24`, `_Wrappers::Unwind@006c9bf0`. Every definition path
 * sanitizes `@` away - `name.replace(/[^A-Za-z0-9_]/g, '_')` in
 * generateStaticLocalDeclaration (globals-header.ts:534), generateStaticLocalsBlock
 * (:588), the file-local block (impl.ts:773) and the function-declaration emitters
 * (header.ts:754, impl.ts:1245) - and function bodies already call the sanitized
 * form, e.g. recon/diablo-2/D2Client/D2Client.cpp:180 `_BinkClose_4(...)`.
 *
 * `emitDataValue`'s 'pointer' case (globals-header.ts ~723) emits `&${sym}`
 * verbatim, so the reference keeps the `@` and gcc reports `stray '@' in program`
 * - ~88 of them. Real instances in the tree:
 *
 *   recon/diablo-2/globals.cpp:3429   .action = &_Wrappers::Unwind@006c9bf0
 *     (inside `UnwindMapEntry UnwindMapEntry_00700a70`, globals.cpp:3427-3430)
 *   recon/diablo-2/globals.cpp:70458  // skipped: GLIDEDLL_grLfbLock@24 (invalid identifier)
 *   recon/diablo-2/globals.cpp:69730  // skipped: PTR__BinkClose@4_006cc5cc (invalid identifier)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue,
  generateGlobalsImpl,
  generateStaticLocalDeclaration,
} from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, DataValue, ReconstructOptions } from '../types.js';

const options = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

/** The exact struct behind recon/diablo-2/globals.cpp:3427. */
const UNWIND_MAP_ENTRY: DataValue = {
  kind: 'struct',
  fields: [
    { name: 'toState', value: { kind: 'scalar', value: '-0x1' } },
    { name: 'action', value: { kind: 'pointer', value: '_Wrappers::Unwind@006c9bf0' } },
  ],
};

const UNWIND_GLOBAL: AnalyzedDataSymbol = {
  name: 'UnwindMapEntry_00700a70',
  address: '00700a70',
  dataType: 'UnwindMapEntry',
  size: 8,
  isInitialized: true,
  xrefCount: 1,
  scope: 'global',
  initializedData: UNWIND_MAP_ENTRY,
};

/**
 * CHANGED: `UnwindMapEntry` is now an MSVC-EH internal type, and
 * `isEmittableGlobal` (globals-header.ts) deliberately drops every global typed
 * as one - no real header declares FuncInfo / UnwindMapEntry / HandlerType /
 * TryBlockMapEntry, so emitting them yields "X does not name a type". So
 * `UnwindMapEntry_00700a70` no longer reaches globals.cpp at all, and asserting
 * that its reference appears there was asserting a symbol that must not be
 * emitted.
 *
 * The sanitizer contract under test is unchanged, so it is now pinned on a
 * global that IS emitted: the same decorated `@` pointer initializer held by a
 * game struct. The EH-drop itself is asserted below rather than dropped, so
 * both behaviours stay covered.
 */
const DECORATED_PTR_GLOBAL: AnalyzedDataSymbol = {
  name: 'ActionTable_00700a70',
  address: '00700a70',
  dataType: 'D2ActionTableStrc',
  size: 8,
  isInitialized: true,
  xrefCount: 1,
  scope: 'global',
  initializedData: UNWIND_MAP_ENTRY,
};

/** globals.cpp:69730 / :70458 - a decorated import thunk stored as a static local. */
const BINK_THUNK: AnalyzedDataSymbol = {
  name: '_BinkClose@4',
  address: '006cc5cc',
  dataType: 'void*',
  size: 4,
  isInitialized: true,
  xrefCount: 1,
  scope: 'static-local',
  ownerFunction: 'D2Client::D2Client::ShutdownVideo',
  initializedData: { kind: 'pointer', value: 'GLIDEDLL_grLfbLock@24' },
};

describe('decorated (@) symbol names are sanitized at reference sites', () => {
  it('emitDataValue does not leak `@` into a pointer reference', () => {
    const out = emitDataValue(UNWIND_MAP_ENTRY, 0);

    // `&_Wrappers::Unwind@006c9bf0` -> "stray '@' in program"
    assert.doesNotMatch(out, /@/);
    assert.match(out, /&_Wrappers::Unwind_006c9bf0\b/);
  });

  it('the same reference is clean once it reaches globals.cpp', () => {
    const out = generateGlobalsImpl([DECORATED_PTR_GLOBAL], options);

    assert.doesNotMatch(out, /Unwind@006c9bf0/);
    assert.match(out, /&_Wrappers::Unwind_006c9bf0/);
  });

  it('an MSVC-EH-typed global is dropped from globals.cpp entirely', () => {
    const out = generateGlobalsImpl([UNWIND_GLOBAL], options);

    assert.doesNotMatch(out, /UnwindMapEntry_00700a70/);
    assert.match(out, /No global definitions to emit/);
  });

  it('reference and definition use the same sanitized spelling', () => {
    const decl = generateStaticLocalDeclaration(BINK_THUNK);
    assert.ok(decl, 'static-local declaration should be emitted');

    // The name is already sanitized (`_BinkClose_4`) - the initializer is not,
    // so the one line contains both conventions at once.
    assert.match(decl!, /\b_BinkClose_4\b/);
    assert.doesNotMatch(decl!, /@/);
    // `GLIDEDLL_grLfbLock_24` is one of the excluded-namespace symbols the
    // emitter declares itself, and it declares it as a FUNCTION. A function
    // address reaches `void*` through a cast or not at all, so the slot takes
    // `(void*)&f` - `&f` alone is "invalid conversion from 'FxBool (*)(...)'".
    assert.match(decl!, /=\s*\(void\*\)&GLIDEDLL_grLfbLock_24;/);
  });
});
