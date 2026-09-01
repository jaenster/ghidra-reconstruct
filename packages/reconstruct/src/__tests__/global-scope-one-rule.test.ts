/**
 * Four emission paths used to answer "what namespace is this global in?" and
 * "is this global `static`?" differently. Each divergence produced a symbol that
 * was declared in one place and defined in another — invisible to the compiler,
 * fatal at link.
 *
 * 1. A global's scope came from Ghidra's XREF count at its exact start address,
 *    while globals.h's fallback extern came from how many function BODIES name
 *    it. 1788 globals were emitted `static` in one .cpp with an `extern` for them
 *    in globals.h; six names were emitted `static` in more than one .cpp, so the
 *    same table existed as several objects and only one of them held the data.
 * 2. globals.h collapsed `D2Game::Quests::Quests::A1Q0` to
 *    `D2Game::Quests::A1Q0`; globals.cpp did not collapse at all.
 * 3. `buildNamespaceCollisionRewriter` rewrote the file's own
 *    `namespace D2Common::Item::ItemMods {` line — its "penultimate only" guard
 *    looks for a following `::`, and a namespace DECLARATION is followed by ` {`.
 * 4. A struct-header co-located global was declared at ROOT scope and defined
 *    inside its namespace (`gpHireablesList`).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { generateImplementation } from '../codegen/impl.js';
import { generateHeader } from '../codegen/header.js';
import {
  generateGlobalsHeader,
  generateGlobalsImpl,
  generateColocatedGlobalsImpl,
  setMultidimArrayGlobals,
  setGlobalInitializerTypes,
} from '../codegen/globals-header.js';
import {
  reconcileStaticScopeWithBodyReferences,
  buildGlobalAddressExtentTables,
  ghidraStringLabelName,
} from '../codegen/index.js';
import { setNamespaceCollisionTypes } from '../codegen/namespace.js';
import type {
  AnalyzedDataSymbol,
  ExtractedDataType,
  ExtractedFunction,
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
  promoteStaticGlobals: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

function makeFunc(o: Partial<ExtractedFunction> & Pick<ExtractedFunction, 'name'>): ExtractedFunction {
  return {
    address: '00400000',
    signature: `void ${o.name}()`,
    returnType: 'void',
    parameters: [],
    localVariables: [],
    callingConvention: '__cdecl',
    size: 64,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    decompiled: `void ${o.name}() {\n  return;\n}`,
    ...o,
  } as ExtractedFunction;
}

describe('one rule decides whether a global is `static`', () => {
  it('a global with initialised data that several bodies name is never a local static', () => {
    // gnPaladinSkillIndexTable @006daea8: xrefCount 1, so Ghidra scoped it
    // static-local — but eleven bodies name it, because the array is longer than
    // the real table and swallows the __FILE__ strings the allocator calls pass.
    const table: AnalyzedDataSymbol = {
      name: 'gnPaladinSkillIndexTable', address: '006daea8', dataType: 'int[24]',
      suggestedType: 'int[24]', size: 96, isInitialized: true, value: null,
      xrefCount: 1, scope: 'static-local', ownerFunction: 'Zeal',
      initializedData: { kind: 'array', elements: [] },
    } as unknown as AnalyzedDataSymbol;

    const funcs = [
      makeFunc({ name: 'Zeal', decompiled: 'void Zeal(){ int x = gnPaladinSkillIndexTable[0]; }' }),
      makeFunc({ name: 'Snd', decompiled: 'void Snd(){ Alloc((char*)(gnPaladinSkillIndexTable + 0xe)); }' }),
    ];
    const funcToImpl = new Map([['Zeal', 'D2Common/Skills/SkillsPal.cpp'], ['Snd', 'D2Common/Unit/UnitSnd.cpp']]);

    const r = reconcileStaticScopeWithBodyReferences([table], funcs, funcToImpl, new Set());
    assert.strictEqual(r.promotedToGlobal, 1);
    assert.strictEqual(table.scope, 'global');
    assert.strictEqual(table.ownerFunction, undefined);
  });

  it('promotes even when every naming body is in ONE file — globals.h still externs it', () => {
    const g: AnalyzedDataSymbol = {
      name: 'gaColorDistanceLookup', address: '008e9430', dataType: 'undefined4',
      suggestedType: 'uint32_t', size: 4, isInitialized: true, value: '0',
      xrefCount: 4, scope: 'static-local', ownerFunction: 'A',
    } as unknown as AnalyzedDataSymbol;
    const funcs = [
      makeFunc({ name: 'A', decompiled: 'void A(){ gaColorDistanceLookup = 1; }' }),
      makeFunc({ name: 'B', decompiled: 'void B(){ int v = gaColorDistanceLookup; }' }),
    ];
    reconcileStaticScopeWithBodyReferences(
      [g], funcs, new Map([['A', 'D2Client/Draw.cpp'], ['B', 'D2Client/Draw.cpp']]), new Set(),
    );
    assert.strictEqual(g.scope, 'global');
  });

  it('leaves a single-body static alone', () => {
    const g: AnalyzedDataSymbol = {
      name: 'gLocalOnly', address: '00700000', dataType: 'int', suggestedType: 'int',
      size: 4, isInitialized: true, value: '0', xrefCount: 1, scope: 'static-local',
      ownerFunction: 'A',
    } as unknown as AnalyzedDataSymbol;
    reconcileStaticScopeWithBodyReferences(
      [g], [makeFunc({ name: 'A', decompiled: 'void A(){ gLocalOnly = 1; }' })],
      new Map([['A', 'X.cpp']]), new Set(),
    );
    assert.strictEqual(g.scope, 'static-local');
  });

  it('counts a folded address literal in another function of the SAME file', () => {
    // cSCompCompressMethod @00724a80: Ghidra records the `cmp esi, offset` operand
    // as a SCALAR, so the xref count is 1 and no body names the symbol. It was
    // emitted `static int cSCompCompressMethod = 0x40;` inside one function of
    // SSComp.cpp while two others compared against its address, which
    // `global-address-literal` renders as `&cSCompCompressMethod`.
    const g: AnalyzedDataSymbol = {
      name: 'cSCompCompressMethod', address: '00724a80', dataType: 'int',
      suggestedType: 'int', size: 4, isInitialized: true, value: '0x40',
      xrefCount: 1, scope: 'static-local', ownerFunction: 'SCompCompress',
    } as unknown as AnalyzedDataSymbol;
    const funcs = [
      makeFunc({ name: 'SCompCompress', decompiled: 'void SCompCompress(){ cSCompCompressMethod = 0x40; }' }),
      makeFunc({ name: 'SCompDecompress', decompiled: 'void SCompDecompress(){ do { pSrc++; } while ((int)pSrc < 0x724a80); }' }),
    ];
    const r = reconcileStaticScopeWithBodyReferences(
      [g], funcs,
      new Map([['SCompCompress', 'Storm/Source/SSComp.cpp'], ['SCompDecompress', 'Storm/Source/SSComp.cpp']]),
      new Set(),
    );
    assert.strictEqual(r.promotedToGlobal, 1);
    assert.strictEqual(g.scope, 'global');
    assert.strictEqual(g.ownerFunction, undefined);
  });

  it('counts a folded address literal in another TRANSLATION UNIT', () => {
    // gnOutJungPresetOffsetByLevel: `static` in a function of OutJung.cpp,
    // address taken from OutPlace/Act5.cpp. Sound as neither a function-local
    // nor a file-scope static.
    const g: AnalyzedDataSymbol = {
      name: 'gnOutJungPresetOffsetByLevel', address: '006e3120', dataType: 'int',
      suggestedType: 'int', size: 4, isInitialized: true, value: '0',
      xrefCount: 1, scope: 'file-local', ownerFile: 'D2Common/Drlg/OutJung.cpp',
    } as unknown as AnalyzedDataSymbol;
    const funcs = [
      makeFunc({ name: 'DRLGOUTJUNG_Build', decompiled: 'void DRLGOUTJUNG_Build(){ gnOutJungPresetOffsetByLevel = 0; }' }),
      makeFunc({ name: 'DRLGACT5_Place', decompiled: 'void DRLGACT5_Place(){ if (p == 0x6e3120) return; }' }),
    ];
    reconcileStaticScopeWithBodyReferences(
      [g], funcs,
      new Map([['DRLGOUTJUNG_Build', 'D2Common/Drlg/OutJung.cpp'], ['DRLGACT5_Place', 'D2Common/Drlg/OutPlace/Act5.cpp']]),
      new Set(),
    );
    assert.strictEqual(g.scope, 'global');
    assert.strictEqual(g.ownerFile, undefined);
  });

  it('counts a literal that lands INSIDE the extent, not only on its base', () => {
    // `(char*)&cSCompCompressMethod + 3` — the emitted form for 00724a83.
    const g: AnalyzedDataSymbol = {
      name: 'cSCompCompressMethod', address: '00724a80', dataType: 'int',
      suggestedType: 'int', size: 4, isInitialized: true, value: '0x40',
      xrefCount: 1, scope: 'static-local', ownerFunction: 'A',
    } as unknown as AnalyzedDataSymbol;
    reconcileStaticScopeWithBodyReferences(
      [g],
      [makeFunc({ name: 'A', decompiled: 'void A(){ cSCompCompressMethod = 0x40; }' }),
       makeFunc({ name: 'B', decompiled: 'void B(){ while (0x724a83 < (int)pp) pp--; }' })],
      new Map([['A', 'X.cpp'], ['B', 'Y.cpp']]), new Set(),
    );
    assert.strictEqual(g.scope, 'global');
  });

  it('counts the complement form the decompiler folds into one negative literal', () => {
    // -7373669 is 0xFF8F7C9B is ~0x00708364 — four bytes into the queue head.
    const g: AnalyzedDataSymbol = {
      name: 'gSFileAsyncReqQueue', address: '00708360', dataType: 'undefined8',
      suggestedType: 'uint64_t', size: 8, isInitialized: true, value: '0',
      xrefCount: 1, scope: 'static-local', ownerFunction: 'A',
    } as unknown as AnalyzedDataSymbol;
    reconcileStaticScopeWithBodyReferences(
      [g],
      [makeFunc({ name: 'A', decompiled: 'void A(){ gSFileAsyncReqQueue = 0; }' }),
       makeFunc({ name: 'B', decompiled: 'void B(){ q->pHead = (void *)-7373669; }' })],
      new Map([['A', 'X.cpp'], ['B', 'Y.cpp']]), new Set(),
    );
    assert.strictEqual(g.scope, 'global');
  });

  it('resolves a literal through an interior LABEL to the array that owns it', () => {
    // Ghidra carries a label for element 1 of the array at 00724a80, named after
    // it: `gaLanguageNames_00724a80[1]` @00724a84, scope global. The bracket
    // disqualifies it from the address table, so 00724a84 belongs to the array —
    // which is what the emitted tree says too:
    // `(uintptr_t)((char*)&gaLanguageNames_00724a80 + 4)`.
    //
    // Counting it as a symbol of its own instead left the array `static` inside
    // INPUT_StatScreenMouseDown while two other functions took its address, and
    // it was the last undefined symbol in the 509-TU link.
    const array: AnalyzedDataSymbol = {
      name: 'gaLanguageNames_00724a80', address: '00724a80', dataType: 'char *[15]',
      suggestedType: 'char *[15]', size: 60, isInitialized: true, value: null,
      xrefCount: 1, scope: 'static-local', ownerFunction: 'INPUT_StatScreenMouseDown',
    } as unknown as AnalyzedDataSymbol;
    const interiorLabel: AnalyzedDataSymbol = {
      name: 'gaLanguageNames_00724a80[1]', address: '00724a84', dataType: 'char *[15]',
      suggestedType: 'char *[15]', size: 60, isInitialized: true, value: null,
      xrefCount: 2, scope: 'global',
    } as unknown as AnalyzedDataSymbol;
    // Neither body NAMES the symbol — both reference it only by folded address.
    const funcs = [
      makeFunc({ name: 'INPUT_StatScreenMouseDown', decompiled: 'void INPUT_StatScreenMouseDown(){ do { pBtnEntry++; } while ((int)pBtnEntry < 0x724a80); }' }),
      makeFunc({ name: 'INPUT_StatScreenMouseUp', decompiled: 'void INPUT_StatScreenMouseUp(){ do { pBtnEntry++; } while ((int)pBtnEntry < 0x724a84); }' }),
    ];
    reconcileStaticScopeWithBodyReferences(
      [array, interiorLabel], funcs,
      new Map([['INPUT_StatScreenMouseDown', 'D2Client/UI/ui.cpp'], ['INPUT_StatScreenMouseUp', 'D2Client/UI/ui.cpp']]),
      new Set(), '00400000',
    );
    assert.strictEqual(array.scope, 'global');
    assert.strictEqual(array.ownerFunction, undefined);
  });

  it('leaves a static alone when the literals in other bodies are not its address', () => {
    const g: AnalyzedDataSymbol = {
      name: 'gLocalOnly', address: '00700000', dataType: 'int', suggestedType: 'int',
      size: 4, isInitialized: true, value: '0', xrefCount: 1, scope: 'static-local',
      ownerFunction: 'A',
    } as unknown as AnalyzedDataSymbol;
    reconcileStaticScopeWithBodyReferences(
      [g],
      [makeFunc({ name: 'A', decompiled: 'void A(){ gLocalOnly = 1; }' }),
       makeFunc({ name: 'B', decompiled: 'void B(){ memset(buf, 0, 0x700004); n = 0x6fffff; }' })],
      new Map([['A', 'X.cpp'], ['B', 'Y.cpp']]), new Set(),
    );
    assert.strictEqual(g.scope, 'static-local');
  });

  it('does not read the address digits out of a symbol NAME', () => {
    // `DAT_00724a80` names the symbol; the digits inside it are not a literal.
    const g: AnalyzedDataSymbol = {
      name: 'gaLanguageNames', address: '00724a80', dataType: 'int',
      suggestedType: 'int', size: 4, isInitialized: true, value: '0',
      xrefCount: 1, scope: 'static-local', ownerFunction: 'A',
    } as unknown as AnalyzedDataSymbol;
    reconcileStaticScopeWithBodyReferences(
      [g],
      [makeFunc({ name: 'A', decompiled: 'void A(){ gaLanguageNames = 1; }' }),
       makeFunc({ name: 'B', decompiled: 'void B(){ int v = DAT_00724a80; }' })],
      new Map([['A', 'X.cpp'], ['B', 'Y.cpp']]), new Set(),
    );
    assert.strictEqual(g.scope, 'static-local');
  });

  it('holds the candidate floor at the image base, so a byte count is not an address', () => {
    // Ghidra manufactures `DAT_00030000` where nothing is mapped; the `0x30000`
    // in `memcpy(dst, src, 0x30000)` is a size, and admitting it would demote
    // every static whose "address" collides with a common constant.
    const placeholder: AnalyzedDataSymbol = {
      name: 'DAT_00030000', address: '00030000', dataType: 'int', suggestedType: 'int',
      size: 4, isInitialized: false, value: null, xrefCount: 1, scope: 'static-local',
      ownerFunction: 'A',
    } as unknown as AnalyzedDataSymbol;
    reconcileStaticScopeWithBodyReferences(
      [placeholder],
      [makeFunc({ name: 'A', decompiled: 'void A(){ DAT_00030000 = 1; }' }),
       makeFunc({ name: 'B', decompiled: 'void B(){ memcpy(dst, src, 0x30000); }' })],
      new Map([['A', 'X.cpp'], ['B', 'Y.cpp']]), new Set(), '00400000',
    );
    assert.strictEqual(placeholder.scope, 'static-local');
  });

  it('does not promote a symbol whose name is also a type name', () => {
    // `enum eD2ApplicationMode; eD2ApplicationMode eD2ApplicationMode;` is not
    // declarable, and body text naming it may be naming the type.
    const g: AnalyzedDataSymbol = {
      name: 'eD2ApplicationMode', address: '00700004', dataType: 'eD2ApplicationMode',
      suggestedType: 'eD2ApplicationMode', size: 4, isInitialized: true, value: '0',
      xrefCount: 1, scope: 'static-local', ownerFunction: 'A',
    } as unknown as AnalyzedDataSymbol;
    reconcileStaticScopeWithBodyReferences(
      [g],
      [makeFunc({ name: 'A', decompiled: 'void A(){ eD2ApplicationMode = 1; }' }),
       makeFunc({ name: 'B', decompiled: 'void B(){ eD2ApplicationMode m; }' })],
      new Map([['A', 'X.cpp'], ['B', 'Y.cpp']]),
      new Set(['eD2ApplicationMode']),
    );
    assert.strictEqual(g.scope, 'static-local');
  });

  it('does not promote into a name a scope-global symbol already owns', () => {
    // gaPlayerInitStats is `uint[4]` @006e1520 AND `D2PlayerInitStatsStrc[7]`
    // @00711e00 — a Ghidra collision. globals.h can declare only one.
    const owned: AnalyzedDataSymbol = {
      name: 'gaPlayerInitStats', address: '006e1520', dataType: 'uint[4]',
      suggestedType: 'uint[4]', size: 16, isInitialized: true, xrefCount: 2, scope: 'global',
    } as unknown as AnalyzedDataSymbol;
    const local: AnalyzedDataSymbol = {
      name: 'gaPlayerInitStats', address: '00711e00', dataType: 'D2PlayerInitStatsStrc[7]',
      suggestedType: 'D2PlayerInitStatsStrc[7]', size: 84, isInitialized: true,
      xrefCount: 2, scope: 'static-local', ownerFunction: 'A',
    } as unknown as AnalyzedDataSymbol;
    reconcileStaticScopeWithBodyReferences(
      [owned, local],
      [makeFunc({ name: 'A', decompiled: 'void A(){ gaPlayerInitStats[0]; }' }),
       makeFunc({ name: 'B', decompiled: 'void B(){ gaPlayerInitStats[1]; }' })],
      new Map([['A', 'X.cpp'], ['B', 'Y.cpp']]), new Set(),
    );
    assert.strictEqual(local.scope, 'static-local');
  });
});

describe('one rule decides a global\'s emitted namespace', () => {
  beforeEach(() => {
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
    setNamespaceCollisionTypes(new Set());
  });

  const gossip: AnalyzedDataSymbol = {
    name: 'aNpcGossipData', address: '006f0000', dataType: 'D2NPCMessageTableStrc',
    suggestedType: 'D2NPCMessageTableStrc', size: 4, isInitialized: true, value: '0',
    xrefCount: 3, scope: 'global', namespace: 'D2Game::Quests::Quests::A1Q0',
  } as unknown as AnalyzedDataSymbol;

  it('globals.cpp opens the namespace globals.h declared, not Ghidra\'s raw path', () => {
    const header = generateGlobalsHeader([gossip], options);
    const impl = generateGlobalsImpl([gossip], options);
    assert.match(header, /^namespace D2Game::Quests::A1Q0 \{$/m);
    assert.match(impl, /^namespace D2Game::Quests::A1Q0 \{$/m);
    assert.doesNotMatch(impl, /namespace D2Game::Quests::Quests::A1Q0/);
  });

  it('defines a name claimed by two Ghidra symbols exactly once, and says so', () => {
    const a = { ...gossip, name: 'gLightRoomGreen', address: '007a7430', namespace: undefined } as AnalyzedDataSymbol;
    const b = { ...a, address: '007a7435', dataType: 'uint8_t', suggestedType: 'uint8_t' } as AnalyzedDataSymbol;
    const impl = generateGlobalsImpl([a, b], options);
    const defs = impl.split('\n').filter(l => /^\S.*\bgLightRoomGreen\b\s*=/.test(l));
    assert.strictEqual(defs.length, 1, `expected one definition, got:\n${defs.join('\n')}`);
    assert.match(impl, /also at 007a7435/);
  });
});

describe('the definition and its declaration open the same namespace', () => {
  it('keeps D2Common::Item::ItemMods on BOTH sides when Item is also a struct', () => {
    setNamespaceCollisionTypes(new Set(['Item']));
    const fn = makeFunc({
      name: 'ITEMMOD_CanApplyAffix',
      address: '0065e710',
      namespace: 'D2Common::Item::ItemMods',
      decompiled: 'void ITEMMOD_CanApplyAffix() {\n  return;\n}',
    });
    const impl = generateImplementation(
      'D2Common::Item::ItemMods', [fn], undefined, 'D2Common/Item/ItemMods.h',
      options, {}, undefined, new Set<string>(), undefined,
      new Set(['Item']),
    );
    const header = generateHeader(
      'D2Common::Item::ItemMods', [fn], undefined, [], [], options,
      undefined, undefined, new Set(), undefined, undefined, undefined,
      'D2Common/Item/ItemMods.h',
    );
    assert.match(impl, /^namespace D2Common::Item::ItemMods \{$/m);
    assert.doesNotMatch(impl, /^namespace D2Common::ItemMods \{$/m);
    assert.match(impl, /^\} \/\/ namespace D2Common::Item::ItemMods$/m);
    assert.match(header, /^namespace D2Common::Item::ItemMods \{$/m);
  });

  it('a global in that namespace is declared and defined in it too', () => {
    setNamespaceCollisionTypes(new Set(['Item']));
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
    const g: AnalyzedDataSymbol = {
      name: 'gaItemModTable', address: '0065f000', dataType: 'uint32_t',
      suggestedType: 'uint32_t', size: 4, isInitialized: true, value: '0',
      xrefCount: 3, scope: 'global', namespace: 'D2Common::Item::ItemMods',
    } as unknown as AnalyzedDataSymbol;
    const header = generateGlobalsHeader([g], options);
    const impl = generateGlobalsImpl([g], options);
    assert.match(header, /^namespace D2Common::Item::ItemMods \{$/m);
    assert.match(impl, /^namespace D2Common::Item::ItemMods \{$/m);
  });
});

describe('the process entry point is reachable from the linker', () => {
  it('emits an extern "C" root-scope forwarder for a namespaced WinMain', () => {
    setNamespaceCollisionTypes(new Set());
    const winMain = makeFunc({
      name: 'WinMain',
      namespace: 'D2Client::Engine::Application',
      returnType: 'int32_t',
      signature: 'int32_t WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int32_t nShowCmd, char * szText)',
      parameters: [
        { name: 'hInstance', dataType: 'HINSTANCE', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' },
        { name: 'hPrevInstance', dataType: 'HINSTANCE', size: 4, ordinal: 1, storage: 'Stack[0x8]:4' },
        { name: 'lpCmdLine', dataType: 'LPSTR', size: 4, ordinal: 2, storage: 'Stack[0xc]:4' },
        { name: 'nShowCmd', dataType: 'int32_t', size: 4, ordinal: 3, storage: 'Stack[0x10]:4' },
        { name: 'szText', dataType: 'char *', size: 4, ordinal: 4, storage: 'EBP:4' },
      ],
      decompiled: 'int32_t WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int32_t nShowCmd, char * szText) {\n  return 0;\n}',
    });
    const impl = generateImplementation(
      'D2Client::Engine::Application', [winMain], undefined,
      'D2Client/Engine/Application.h', options, {}, undefined, new Set<string>(),
    );
    // Register-storage parameters are not part of the entry contract.
    assert.match(
      impl,
      /extern "C" int32_t __stdcall WinMain\(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int32_t nShowCmd\) \{/,
    );
    assert.match(impl, /return D2Client::Engine::Application::WinMain\(hInstance, hPrevInstance, lpCmdLine, nShowCmd, 0\);/);
  });
});

describe('a co-located global is declared where it is defined', () => {
  it('wraps the struct-header extern in the same namespace as the definition', () => {
    setNamespaceCollisionTypes(new Set());
    const g: AnalyzedDataSymbol = {
      name: 'gpHireablesList', address: '007beeac', dataType: 'D2HireablesListStrc *',
      suggestedType: 'D2HireablesListStrc *', size: 4, isInitialized: true, value: '0',
      xrefCount: 6, scope: 'struct-colocated', namespace: 'D2Client::UI::Hireables',
      ownerStructHeader: 'D2Client/UI/Hireables.h', ownerStructType: 'D2HireablesListStrc',
    } as unknown as AnalyzedDataSymbol;
    const dataTypes = [
      { name: 'D2HireablesListStrc', kind: 'STRUCTURE', category: '/D2Client', size: 20, fields: [] },
    ] as unknown as ExtractedDataType[];

    const header = generateHeader(
      'D2Client::UI::Hireables',
      [makeFunc({ name: 'LoadClassIcons', namespace: 'D2Client::UI::Hireables' })],
      undefined, dataTypes, [g], options, undefined, undefined,
      new Set(['D2HireablesListStrc']), undefined, undefined, undefined,
      'D2Client/UI/Hireables.h',
    );
    const impl = generateColocatedGlobalsImpl([g], options);

    assert.match(header, /namespace D2Client::UI::Hireables \{[\s\S]*extern[^;]*gpHireablesList;/);
    assert.match(impl, /^namespace D2Client::UI::Hireables \{$/m);
  });
});

describe('the address table admits the same symbols on both sides', () => {
  it('excludes an interior label, so its address belongs to the object it points into', () => {
    // `global-address-literal` and the scope analysis read ONE table. A symbol
    // whose Ghidra name is not a legal identifier is not a candidate for either:
    // sanitizing first would turn `gaLanguageNames_00724a80[1]` into
    // `gaLanguageNames_00724a80_1_` and readmit it, and then 00724a84 resolves
    // to a symbol in one place and to `&array + 4` in the other.
    const globals = [
      { name: 'gaLanguageNames_00724a80', address: '00724a80', size: 60 },
      { name: 'gaLanguageNames_00724a80[1]', address: '00724a84', size: 60 },
    ] as unknown as AnalyzedDataSymbol[];

    const { globalAddresses, globalSizes } = buildGlobalAddressExtentTables(globals);
    assert.deepStrictEqual(Object.keys(globalAddresses), ['gaLanguageNames_00724a80']);
    assert.strictEqual(globalAddresses['gaLanguageNames_00724a80'], 0x724a80);
    assert.strictEqual(globalSizes['gaLanguageNames_00724a80'], 60);
    assert.strictEqual(globalAddresses['gaLanguageNames_00724a80_1_'], undefined);
  });

  it('admits a string constant, sized to the object the closure defines', () => {
    // A string datum is not a global — `analyzeDataSymbols` drops its `string`
    // type — so it enters the ONE table here or an address literal pointing at
    // it resolves to nothing. `modstate0` is 9 bytes; the object the closure
    // emits is `char[10]`, terminator included.
    const { globalAddresses, globalSizes, stringConstantNames } =
      buildGlobalAddressExtentTables([], [
        { address: '006cc928', value: 'modstate0', length: 9, encoding: 'string', xrefCount: 1 },
      ] as never);
    assert.strictEqual(globalAddresses['s_modstate0_006cc928'], 0x6cc928);
    assert.strictEqual(globalSizes['s_modstate0_006cc928'], 10);
    assert.deepStrictEqual(stringConstantNames, ['s_modstate0_006cc928']);
  });

  it('refuses a string the closure could not define', () => {
    // A `unicode` datum has no honest `char[]`, and a value whose bytes
    // disagree with Ghidra's length lost content in transit. Either one
    // admitted would resolve a literal to a name nothing ever defines — an
    // undefined symbol at link, strictly worse than the literal it replaced.
    const { globalAddresses, stringConstantNames } = buildGlobalAddressExtentTables([], [
      { address: '006e1750', value: 'Wide', length: 4, encoding: 'unicode', xrefCount: 1 },
      { address: '006e1740', value: 'block!', length: 20, encoding: 'string', xrefCount: 1 },
    ] as never);
    assert.deepStrictEqual(stringConstantNames, []);
    assert.deepStrictEqual(Object.keys(globalAddresses), []);
  });

  it('lets a global keep a name a string label would otherwise take', () => {
    const globals = [
      { name: 's_modstate0_006cc928', address: '00700000', size: 4 },
    ] as unknown as AnalyzedDataSymbol[];
    const { globalAddresses, stringConstantNames } = buildGlobalAddressExtentTables(globals, [
      { address: '006cc928', value: 'modstate0', length: 9, encoding: 'string', xrefCount: 1 },
    ] as never);
    assert.strictEqual(globalAddresses['s_modstate0_006cc928'], 0x700000);
    assert.deepStrictEqual(stringConstantNames, []);
  });

  it('reproduces Ghidra\'s label convention', () => {
    // 1:1 replacement of every character that is not identifier-legal, cut at
    // 33 — both read off the labels already in the tree.
    assert.strictEqual(ghidraStringLabelName(0x6ebefc, 'Skill1'), 's_Skill1_006ebefc');
    assert.strictEqual(ghidraStringLabelName(0x70f130, '207.82.87.133'), 's_207_82_87_133_0070f130');
    assert.strictEqual(
      ghidraStringLabelName(0x72daa8, 'Error 1:\nDiablo II is unable to proceed'),
      's_Error_1__Diablo_II_is_unable_to_p_0072daa8',
    );
  });

  it('drops a name reported at two addresses rather than picking one', () => {
    const globals = [
      { name: 'gLightRoomGreen', address: '007a7430', size: 4 },
      { name: 'gLightRoomGreen', address: '007a7435', size: 1 },
      { name: 'gKept', address: '00700000', size: 4 },
    ] as unknown as AnalyzedDataSymbol[];
    const { globalAddresses, globalSizes } = buildGlobalAddressExtentTables(globals);
    assert.strictEqual(globalAddresses['gLightRoomGreen'], undefined);
    assert.strictEqual(globalSizes['gLightRoomGreen'], undefined);
    assert.strictEqual(globalAddresses['gKept'], 0x700000);
  });
});
