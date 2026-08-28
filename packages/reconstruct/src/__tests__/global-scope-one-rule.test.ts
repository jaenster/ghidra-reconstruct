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
import { reconcileStaticScopeWithBodyReferences } from '../codegen/index.js';
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
