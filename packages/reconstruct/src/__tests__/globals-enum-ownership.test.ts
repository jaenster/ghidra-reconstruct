/**
 * Regression tests for two faults that each lived in globals.h — the one header
 * every translation unit includes, so each was multiplied by the whole tree.
 *
 * 1. **An ENUM defined twice.** `d2_enums.h` holds EVERY ENUM datatype and
 *    `d2_platform.h` includes it unconditionally, so by the time globals.h has
 *    its own body the type is already complete. globals.h defined it a second
 *    time anyway, which re-defines each enumerator's `constexpr` inside
 *    `<name>_ns`. On 1.14d that was `eOogCurrentCharSelectionMode` with four
 *    enumerators: 2,192 errors, four in every one of the 548 files.
 *
 * 2. **A global that has taken its own type's name.** Ghidra calls the app-mode
 *    variable at 0x1146ec `eD2ApplicationMode`, exactly the enum it is typed
 *    with. `extern eD2ApplicationMode eD2ApplicationMode;` is ill-formed and
 *    has no legal spelling: a typedef-name may neither be redeclared as a
 *    variable in its scope nor be hidden by one. It is Ghidra's to settle — the
 *    label at 0x0074c704 needs a name of its own — so the emitter reports it
 *    rather than renaming a symbol the decompiled bodies still refer to.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  generateGlobalsHeader,
  setGlobalInitializerTypes,
  setMultidimArrayGlobals,
  reportGlobalsTakingATypeName,
} from '../codegen/globals-header.js';
import type {
  AnalyzedDataSymbol,
  ExtractedDataType,
  ExtractedEnum,
  ReconstructOptions,
} from '../types.js';

const options = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

/** d2_enums.h:8624 — the real 1.14d enum, values verbatim. */
const CHAR_SELECTION_MODE: ExtractedEnum = {
  name: 'eOogCurrentCharSelectionMode',
  category: '/Diablo2',
  kind: 'ENUM',
  size: 4,
  values: [
    { name: 'CHAR_SELECTION_SP', value: 0 },
    { name: 'CHAR_SELECTION_BNET', value: 1 },
    { name: 'CHAR_SELECTION_TCP_IP', value: 2 },
    { name: 'CHAR_SELECTION_BNET_OPEN_Unsure', value: 3 },
  ],
} as unknown as ExtractedEnum;

/** d2_enums.h:1356 — the enum the app-mode global shares its name with. */
const APPLICATION_MODE: ExtractedEnum = {
  name: 'eD2ApplicationMode',
  category: '/Diablo2',
  kind: 'ENUM',
  size: 4,
  values: [
    { name: 'APPMODE_mode0', value: 0 },
    { name: 'APPMODE_client', value: 1 },
    { name: 'APPMODE_server', value: 2 },
  ],
} as unknown as ExtractedEnum;

/** A by-value global of the enum type, under a name of its own. */
const CHAR_SELECTION_GLOBAL: AnalyzedDataSymbol = {
  name: 'gnOogCurrentCharSelectionMode',
  address: '006fbf88',
  dataType: 'eOogCurrentCharSelectionMode',
  size: 4,
  isInitialized: false,
  xrefCount: 9,
  scope: 'global',
};

/** Fog/Engine/Application.cpp:2198 — the variable Ghidra named after its type. */
const APP_MODE_GLOBAL: AnalyzedDataSymbol = {
  name: 'eD2ApplicationMode',
  address: '001146ec',
  dataType: 'eD2ApplicationMode',
  size: 4,
  isInitialized: false,
  xrefCount: 23,
  scope: 'global',
};

function register(dataTypes: ExtractedDataType[], globals: AnalyzedDataSymbol[]): void {
  setGlobalInitializerTypes(dataTypes);
  setMultidimArrayGlobals(globals);
}

describe('globals.h leaves every ENUM to d2_enums.h', () => {
  it('does not re-define an enum the shared header already defines', () => {
    register([CHAR_SELECTION_MODE], [CHAR_SELECTION_GLOBAL]);
    const header = generateGlobalsHeader(
      [CHAR_SELECTION_GLOBAL], options, [CHAR_SELECTION_MODE]
    );

    // The definition — the `_ns` namespace and its constexpr enumerators — is
    // the part that redefines. None of it may appear here.
    assert.doesNotMatch(header, /namespace eOogCurrentCharSelectionMode_ns/);
    assert.doesNotMatch(header, /constexpr\s+eOogCurrentCharSelectionMode\s+CHAR_SELECTION_SP/);
    assert.doesNotMatch(header, /using namespace eOogCurrentCharSelectionMode_ns/);
  });

  it('never contradicts the shared typedef with a struct forward declaration', () => {
    // An enum whose name breaks the `eXxx` convention used to fall through the
    // safety net to `struct X;`, which clashes with `typedef int X;`.
    const oddlyNamed = { ...CHAR_SELECTION_MODE, name: 'define_TRUE' } as ExtractedEnum;
    const user: AnalyzedDataSymbol = {
      ...CHAR_SELECTION_GLOBAL, name: 'gbTrue', dataType: 'define_TRUE',
    };
    register([oddlyNamed], [user]);
    const header = generateGlobalsHeader([user], options, [oddlyNamed]);
    assert.doesNotMatch(header, /struct define_TRUE/);
  });

  it('still declares the global that uses the enum', () => {
    register([CHAR_SELECTION_MODE], [CHAR_SELECTION_GLOBAL]);
    const header = generateGlobalsHeader(
      [CHAR_SELECTION_GLOBAL], options, [CHAR_SELECTION_MODE]
    );
    assert.match(
      header,
      /extern eOogCurrentCharSelectionMode gnOogCurrentCharSelectionMode;/
    );
  });
});

describe('a global that has taken its own enum type name', () => {
  it('is left exactly as Ghidra has it, and reported', () => {
    // Nothing the emitter can spell makes this legal — see
    // `reportGlobalsTakingATypeName`. What it must NOT do is quietly rename the
    // symbol or widen the type, because the bodies that use it are not spelled
    // here and would then name something that does not exist.
    register([APPLICATION_MODE], [APP_MODE_GLOBAL]);
    const header = generateGlobalsHeader([APP_MODE_GLOBAL], options, [APPLICATION_MODE]);
    assert.match(header, /extern eD2ApplicationMode eD2ApplicationMode;/);

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
    try { reportGlobalsTakingATypeName(); } finally { console.warn = realWarn; }
    assert.ok(
      warnings.some(w => w.includes('eD2ApplicationMode')),
      'the collision must be reported, not silently emitted'
    );
  });

  it('says nothing about an enum-typed global whose name differs', () => {
    const named = { ...APP_MODE_GLOBAL, name: 'geAppMode' };
    register([APPLICATION_MODE], [named]);
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
    try { reportGlobalsTakingATypeName(); } finally { console.warn = realWarn; }
    assert.deepEqual(warnings, []);
  });
});
