/**
 * One library per original module: the graph, the header gates, the public /
 * private split of declarations and globals, the DAG lint and the build file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ModuleGraph, validateModuleLibraries, type ModuleLibrariesConfig } from '../modules/module-libraries.js';
import {
  applyModuleBoundaries, splitDefinitions, splitHeaderDeclarations, insertHeaderGate, bracketRootIncludes,
} from '../codegen/module-boundary.js';
import { generateModuleLibrariesCMake } from '../codegen/cmake.js';
import { pruneIncludes } from '../codegen/include-pruning.js';
import {
  DECLS_BEGIN_MARKER, DECLS_END_MARKER, DECL_MARKER, DECL_END_MARKER, TYPE_MARKER, TYPE_END_MARKER, GLOBAL_MARKER, GLOBAL_END_MARKER,
  INLINE_MARKER, INLINE_END_MARKER,
} from '../codegen/header.js';
import type { AnalyzedDataSymbol, ExtractedFunction, ReconstructedProject, ReconstructOptions, SourceFile } from '../types.js';

const config: ModuleLibrariesConfig = {
  enabled: true,
  linkOrder: ['Fog', 'Game', 'Storm', 'D2gfx', 'D2Gdi', 'D2Common', 'D2Hell'],
  modules: {
    Storm: {},
    Fog: { imports: ['Storm'] },
    D2gfx: { imports: ['Storm', 'Fog'], loads: ['D2Gdi'] },
    D2Gdi: { imports: ['Storm', 'Fog', 'D2gfx'] },
    D2Common: { imports: ['Fog'] },
    D2Hell: { imports: ['Storm', 'Fog'], embedded: true },
    Game: { imports: ['D2Common'], loads: ['D2gfx'] },
  },
};

describe('ModuleGraph', () => {
  const g = new ModuleGraph(config);

  it('follows static imports transitively', () => {
    assert.ok(g.mayUse('D2Common', 'Storm'));
    assert.ok(g.mayUse('Game', 'Storm'));
    assert.ok(!g.mayUse('Storm', 'Fog'));
  });

  it('follows a LoadLibrary edge one step only', () => {
    assert.ok(g.mayUse('Game', 'D2gfx'));
    assert.ok(g.mayUse('D2gfx', 'D2Gdi'));
    assert.ok(!g.mayUse('Game', 'D2Gdi'), 'Game loads D2gfx, it does not see what D2gfx loads');
  });

  it('lets every module see an embedded module', () => {
    assert.ok(g.mayUse('Storm', 'D2Hell'));
    assert.ok(!g.mayUse('D2Hell', 'D2Common'));
  });

  it('places a globals unit in the module it is named after', () => {
    assert.strictEqual(g.libraryOfPath('globals/D2Common.cpp'), 'D2Common');
    assert.strictEqual(g.libraryOfPath('globals/globals.cpp'), undefined);
    assert.strictEqual(g.libraryOfPath('Fog/Src/ErrorManager.cpp'), 'Fog');
  });
});

describe('validateModuleLibraries', () => {
  it('accepts the graph above', () => {
    assert.deepStrictEqual(validateModuleLibraries(config), []);
  });

  it('rejects an import cycle and an unknown module', () => {
    const bad: ModuleLibrariesConfig = {
      linkOrder: [],
      modules: { A: { imports: ['B'] }, B: { imports: ['A', 'C'] } },
    };
    const problems = validateModuleLibraries(bad);
    assert.ok(problems.some(p => p.includes('cycle')), problems.join('\n'));
    assert.ok(problems.some(p => p.includes('unknown module "C"')), problems.join('\n'));
  });

  it('wants a reason on every exception', () => {
    const problems = validateModuleLibraries({ ...config, exceptions: [{ from: 'Fog', to: 'D2Common', reason: '' }] });
    assert.ok(problems.some(p => p.includes('needs a reason')));
  });
});

describe('header split', () => {
  const header = [
    '#pragma once',
    'namespace Fog {',
    '// Function declarations',
    DECLS_BEGIN_MARKER,
    `${DECL_MARKER}00401000`,
    'void __stdcall Used();',
    DECL_END_MARKER,
    `${DECL_MARKER}00401010`,
    'void __stdcall Internal();',
    DECL_END_MARKER,
    DECLS_END_MARKER,
    '} // namespace Fog',
  ].join('\n');

  it('keeps a referenced declaration and gates the rest to the module', () => {
    const r = splitHeaderDeclarations(header, 'Fog', a => a === '00401000');
    assert.strictEqual(r.publicCount, 1);
    assert.strictEqual(r.privateCount, 1);
    const lines = r.content.split('\n');
    const used = lines.indexOf('void __stdcall Used();');
    const open = lines.indexOf('#if !defined(D2_MODULE_LIBRARIES) || defined(D2_MODULE_Fog)');
    const internal = lines.indexOf('void __stdcall Internal();');
    assert.ok(used >= 0 && open > used && internal > open, r.content);
    assert.ok(!r.content.includes('//@@'), 'no marker survives');
  });

  it('only strips the markers of a header outside every module', () => {
    const r = splitHeaderDeclarations(header, undefined, () => false);
    assert.ok(!r.content.includes('//@@'));
    assert.ok(!r.content.includes('D2_MODULE_'));
    assert.ok(r.content.includes('void __stdcall Internal();'));
  });

  it('gates the header right after #pragma once', () => {
    const gated = insertHeaderGate(header, 'Fog').split('\n');
    assert.strictEqual(gated[0], '#pragma once');
    // An error only in a strict module, and never while globals.h (the shared root) includes.
    assert.strictEqual(gated[1], '#if defined(D2_MODULE_LIBRARIES) && defined(D2_MODULE_STRICT) && !defined(D2_GATE_FROM_ROOT) && !defined(D2_SEES_Fog)');
    assert.ok(gated[2].startsWith('#error'));
  });

  it('turns the gates off while globals.h includes', () => {
    const root = bracketRootIncludes('// banner\n#pragma once\n#include "Fog/Fog.h"\n\n');
    assert.strictEqual(root, '// banner\n#pragma once\n#define D2_GATE_FROM_ROOT\n#include "Fog/Fog.h"\n#undef D2_GATE_FROM_ROOT\n');
  });
});

describe('splitDefinitions', () => {
  it('cuts a .cpp at the definition lines', () => {
    const parts = splitDefinitions('#include "a.h"\n// 1.14d: 00401000\nvoid A() {}\n// 1.14d: 00401010\nvoid B() {}');
    assert.deepStrictEqual(parts.map(p => p[0]), ['data', '00401000', '00401010']);
  });
});

function fn(name: string, namespace: string, address: string): ExtractedFunction {
  return { name, namespace, address } as unknown as ExtractedFunction;
}
function file(path: string, content: string, type: SourceFile['type']): SourceFile {
  return { path, content, type, functions: [], includes: [] };
}

describe('applyModuleBoundaries', () => {
  const run = () => {
    const files = new Map<string, SourceFile>();
    files.set('Fog/Fog.h', file('Fog/Fog.h', [
      '#pragma once', 'namespace Fog {', DECLS_BEGIN_MARKER,
      `${DECL_MARKER}00401000`, 'void FOG_Used();', DECL_END_MARKER,
      `${DECL_MARKER}00401010`, 'void FOG_Internal();', DECL_END_MARKER,
      DECLS_END_MARKER, '}',
    ].join('\n'), 'header'));
    files.set('Fog/Types.h', file('Fog/Types.h', [
      '#pragma once',
      `${TYPE_MARKER}FogPoolStrc`, 'struct FogPoolStrc { FogBlockStrc block; };', TYPE_END_MARKER,
      `${TYPE_MARKER}FogBlockStrc`, 'struct FogBlockStrc { int n; };', TYPE_END_MARKER,
      `${TYPE_MARKER}FogScratchStrc`, 'struct FogScratchStrc { int n; };', TYPE_END_MARKER,
      'namespace Fog {', DECLS_BEGIN_MARKER,
      `${DECL_MARKER}00401020`, 'FogPoolStrc * FOG_GetPool();', DECL_END_MARKER,
      DECLS_END_MARKER, '}',
    ].join('\n'), 'header'));
    files.set('D2Common/Units.cpp', file('D2Common/Units.cpp', [
      '#include "globals/globals.h"',
      '// 1.14d: 00601000', 'void UNITS_Do() { Fog::FOG_Used(); gnFogCounter++; Fog::FOG_GetPool(); }',
    ].join('\n'), 'implementation'));
    files.set('d2_platform.h', file('d2_platform.h', '#define FOG_FREE(p) Fog::FOG_Internal(p)', 'header'));
    files.set('Storm/SMem.cpp', file('Storm/SMem.cpp', [
      '// 1.14d: 00411000', 'void SMemAlloc() { UNITS_Do(); }',
    ].join('\n'), 'implementation'));
    const fogCounter = { name: 'gnFogCounter', namespace: 'Fog', scope: 'global', dataType: 'int' } as unknown as AnalyzedDataSymbol;
    const graph = new ModuleGraph(config);
    const result = applyModuleBoundaries({
      graph,
      files,
      functions: [
        fn('FOG_Used', 'Fog', '00401000'),
        fn('FOG_Internal', 'Fog', '00401010'),
        fn('FOG_GetPool', 'Fog', '00401020'),
        fn('UNITS_Do', 'D2Common::Units', '00601000'),
        fn('SMemAlloc', 'Storm', '00411000'),
      ],
      globals: [fogCounter],
      typeOwnerMap: new Map(),
      globalsPath: 'globals/globals.h',
      globalOwner: g => graph.moduleOfNamespace(g.namespace),
      moduleExterns: new Map([['Fog', [{ namespace: 'Fog', decl: 'extern int gnFogCounter;', name: 'gnFogCounter', global: fogCounter }]]]),
      rootProvides: new Set(),
      typePrelude: () => [],
    });
    return { files, result };
  };

  it('lints a reference the import graph does not allow, and only that one', () => {
    const { result } = run();
    const violations = result.references.filter(r => r.verdict === 'violation');
    assert.deepStrictEqual(violations.map(v => `${v.userModule}->${v.owner} ${v.kind} ${v.source}`), ['Storm->D2Common call 00411000']);
    assert.ok(result.references.some(r => r.verdict === 'allowed' && r.symbol === 'Fog::FOG_Used'));
    assert.ok(result.reports.get('module-dag.tsv')!.includes('Storm->D2Common\tcall\tviolation'));
  });

  it('declares only what another module uses outside the private block', () => {
    const { files } = run();
    const h = files.get('Fog/Types.h')!.content;
    assert.ok(h.includes('FogPoolStrc * FOG_GetPool();'));
    assert.ok(!h.split('\n')[h.split('\n').indexOf('FogPoolStrc * FOG_GetPool();') - 1].startsWith('#if'));
  });

  it('keeps public what a root header names - a macro in d2_platform.h expands in every module', () => {
    const { files } = run();
    const h = files.get('Fog/Fog.h')!.content;
    assert.ok(!h.includes('|| defined(D2_MODULE_Fog)'), 'FOG_Internal is named by d2_platform.h, FOG_Used by D2Common');
  });

  it('gates every module header on the modules that may see it', () => {
    const { files } = run();
    const h = files.get('Fog/Fog.h')!.content;
    assert.ok(h.includes('!defined(D2_SEES_Fog)'));
  });

  it('keeps a type a public declaration needs public, by value through its fields, and gates the rest', () => {
    const { files } = run();
    const h = files.get('Fog/Types.h')!.content.split('\n');
    const gateBefore = (line: string) => h[h.indexOf(line) - 1].startsWith('#if !defined(D2_MODULE_LIBRARIES)');
    assert.ok(!gateBefore('struct FogPoolStrc { FogBlockStrc block; };'), 'named by a public declaration');
    assert.ok(!gateBefore('struct FogBlockStrc { int n; };'), 'held by value in a public type');
    assert.ok(gateBefore('struct FogScratchStrc { int n; };'), 'nothing outside Fog needs it');
  });

  it('moves a module global out of globals.h into its module data header', () => {
    const { files } = run();
    const data = files.get('Fog/Fog.globals.h')!.content;
    assert.ok(data.includes('extern int gnFogCounter;'));
    const units = files.get('D2Common/Units.cpp')!.content;
    assert.ok(units.includes('#include "Fog/Fog.globals.h"'), units);
    assert.ok(!units.includes('globals/globals.h'), 'nothing it names is left in globals.h');
  });

  it('writes the public header: the declarations, globals and types other modules use, nothing else', () => {
    const { files } = run();
    const pub = files.get('Fog/Fog.public.h')!.content;
    assert.ok(pub.includes('void FOG_Used();'), pub);
    assert.ok(pub.includes('FogPoolStrc * FOG_GetPool();'), pub);
    assert.ok(pub.includes('extern int gnFogCounter;'), pub);
    assert.ok(pub.includes('struct FogPoolStrc { FogBlockStrc block; };'), pub);
    assert.ok(pub.includes('struct FogBlockStrc { int n; };'), 'held by value in a public type');
    assert.ok(!pub.includes('FogScratchStrc'), 'nothing outside Fog needs it');
    assert.ok(pub.includes('void FOG_Internal();'), 'named by d2_platform.h, which every module includes');
    assert.ok(!pub.includes('#include "Fog/'), 'it holds the declarations; it includes none of its own module\'s headers');
    assert.ok(pub.indexOf('struct FogBlockStrc') < pub.indexOf('struct FogPoolStrc'), 'a type follows what it holds by value');
    assert.ok(pub.includes('namespace Fog {'));
    assert.strictEqual(files.get('Fog/Fog.public.h')!.reexport, undefined, 'it has content: the include pass reads it like any header');
  });

  it('guards a published type in its own header too, so a unit reaching both defines it once', () => {
    const { files } = run();
    const h = files.get('Fog/Types.h')!.content.split('\n');
    const at = h.indexOf('struct FogPoolStrc { FogBlockStrc block; };');
    assert.deepStrictEqual(h.slice(at - 2, at), ['#ifndef D2_DEFINED_FogPoolStrc', '#define D2_DEFINED_FogPoolStrc']);
    assert.ok(!h.includes('#ifndef D2_DEFINED_FogScratchStrc'));
    assert.ok(files.get('Fog/Fog.public.h')!.content.includes('#ifndef D2_DEFINED_FogPoolStrc'));
  });

  it('gates an internal header against every other module, the public header only on the import graph', () => {
    const { files } = run();
    const internal = files.get('Fog/Types.h')!.content;
    assert.ok(internal.includes('defined(D2_MODULE_STRICT) && !defined(D2_GATE_FROM_ROOT) && !defined(D2_MODULE_Fog)'), internal);
    const pub = files.get('Fog/Fog.public.h')!.content;
    assert.ok(pub.includes('!defined(D2_SEES_Fog)'));
    assert.ok(!pub.includes('!defined(D2_MODULE_Fog)'));
  });

  it('makes a module that imports Fog include its public header before the internal one', () => {
    const { files } = run();
    const lines = files.get('D2Common/Units.cpp')!.content.split('\n');
    const pub = lines.indexOf('#include "Fog/Fog.public.h"');
    assert.ok(pub >= 0, lines.join('\n'));
    assert.ok(pub < lines.indexOf('#include "Fog/Fog.globals.h"'));
  });

  it('lets the include pass drop the internal header the public one replaces', () => {
    const { files } = run();
    pruneIncludes(files, { providerRank: (from, c) => (c.endsWith('.public.h') && !from.startsWith('Fog/') ? 0 : 1) });
    const units = files.get('D2Common/Units.cpp')!.content;
    assert.ok(units.includes('#include "Fog/Fog.public.h"'), units);
    assert.ok(!units.includes('#include "Fog/Fog.globals.h"'), units);
  });
});

describe('public header', () => {
  it('withholds a type that needs one from a module the owner may not import, and forward-declares a pointer', () => {
    const files = new Map<string, SourceFile>();
    files.set('Fog/Types.h', file('Fog/Types.h', [
      '#pragma once',
      `${TYPE_MARKER}FogHoldsStrc`, 'struct FogHoldsStrc { GameCoordStrc where; };', TYPE_END_MARKER,
      `${TYPE_MARKER}FogPointsStrc`, 'struct FogPointsStrc { GameCoordStrc * where; };', TYPE_END_MARKER,
    ].join('\n'), 'header'));
    files.set('D2Common/Coord.h', file('D2Common/Coord.h', [
      '#pragma once', `${TYPE_MARKER}GameCoordStrc`, 'struct GameCoordStrc { int x; int y; };', TYPE_END_MARKER,
    ].join('\n'), 'header'));
    files.set('D2Common/Units.cpp', file('D2Common/Units.cpp', [
      '#include "Fog/Types.h"', '// 1.14d: 00601000', 'void UNITS_Do(FogHoldsStrc * a, FogPointsStrc * b) { a->where.x = b->where->y; }',
    ].join('\n'), 'implementation'));
    const graph = new ModuleGraph(config);
    const r = applyModuleBoundaries({
      graph, files,
      functions: [fn('UNITS_Do', 'D2Common::Units', '00601000')],
      globals: [],
      typeOwnerMap: new Map([['FogHoldsStrc', 'Fog/Types.h'], ['FogPointsStrc', 'Fog/Types.h'], ['GameCoordStrc', 'D2Common/Coord.h']]),
      globalsPath: 'globals/globals.h',
      globalOwner: () => undefined, moduleExterns: new Map(), rootProvides: new Set(), typePrelude: () => [],
    });
    const pub = files.get('Fog/Fog.public.h')!.content;
    assert.ok(pub.includes('struct FogPointsStrc { GameCoordStrc * where; };'), pub);
    assert.ok(pub.includes('struct GameCoordStrc;'), 'a pointer needs only a declaration');
    assert.ok(!pub.includes('struct FogHoldsStrc {'), 'Fog may not import D2Common, whose type it holds by value');
    assert.ok(!pub.includes('#include "D2Common/'), 'never an include against the import graph');
    assert.ok(r.reports.get('module-public-withheld.tsv')!.includes('Fog\ttype\tFogHoldsStrc\tGameCoordStrc'));
    // The user keeps the internal header for the withheld type.
    pruneIncludes(files, { providerRank: (from, c) => (c.endsWith('.public.h') && !from.startsWith('Fog/') ? 0 : 1) });
    const units = files.get('D2Common/Units.cpp')!.content;
    assert.ok(units.includes('#include "Fog/Types.h"'), units);
  });

  it('never lets an embedded module and one it imports include each other: the public headers stay acyclic', () => {
    const g = new ModuleGraph(config);
    assert.ok(g.publicIncludeAllowed('D2Common', 'D2Hell'), 'D2Hell is embedded and does not import D2Common');
    assert.ok(!g.publicIncludeAllowed('Storm', 'D2Hell'), 'D2Hell imports Storm');
    assert.ok(g.publicIncludeAllowed('D2Hell', 'Storm'));
    assert.ok(!g.publicIncludeAllowed('D2gfx', 'D2Gdi'), 'a LoadLibrary edge is never an include');
    assert.ok(g.importsFrom('Storm', 'D2Hell'), 'Storm still sees D2Hell');
  });

  it('publishes a global of a unit data header that another module names, and strips its markers', () => {
    const files = new Map<string, SourceFile>();
    files.set('Fog/Src/Error.data.h', file('Fog/Src/Error.data.h', [
      '#pragma once', 'namespace Fog::Src {',
      `${GLOBAL_MARKER}gnErrorCount`, 'extern int gnErrorCount;', GLOBAL_END_MARKER,
      `${GLOBAL_MARKER}gnErrorScratch`, 'extern int gnErrorScratch;', GLOBAL_END_MARKER,
      '} // namespace Fog::Src',
    ].join('\n'), 'header'));
    files.set('D2Common/Units.cpp', file('D2Common/Units.cpp', [
      '#include "Fog/Src/Error.data.h"', '// 1.14d: 00601000', 'void UNITS_Do() { Fog::Src::gnErrorCount++; }',
    ].join('\n'), 'implementation'));
    const graph = new ModuleGraph(config);
    const r = applyModuleBoundaries({
      graph, files, functions: [fn('UNITS_Do', 'D2Common::Units', '00601000')], globals: [],
      typeOwnerMap: new Map(), globalsPath: 'globals/globals.h',
      globalOwner: () => undefined, moduleExterns: new Map(), rootProvides: new Set(), typePrelude: () => [],
    });
    const pub = files.get('Fog/Fog.public.h')!.content;
    assert.ok(pub.includes('namespace Fog::Src {\nextern int gnErrorCount;'), pub);
    assert.ok(!pub.includes('gnErrorScratch'));
    assert.ok(!files.get('Fog/Src/Error.data.h')!.content.includes('//@@'), 'no marker reaches the tree');
    assert.ok(r.references.some(x => x.kind === 'global' && x.owner === 'Fog' && x.symbol === 'gnErrorCount'));
  });

  it('a host keeps the loaded module\'s own header: a public header would bring that module\'s imports along', () => {
    const files = new Map<string, SourceFile>();
    files.set('D2gfx/Render.h', file('D2gfx/Render.h', [
      '#pragma once', 'namespace D2gfx {', DECLS_BEGIN_MARKER, `${DECL_MARKER}00402000`, 'void GFX_Draw();', DECL_END_MARKER,
      DECLS_END_MARKER, '} // namespace D2gfx',
    ].join('\n'), 'header'));
    files.set('D2Gdi/Gdi.h', file('D2Gdi/Gdi.h', [
      '#pragma once', 'namespace D2Gdi {', DECLS_BEGIN_MARKER, `${DECL_MARKER}00403000`, 'void GDI_Blit();', DECL_END_MARKER,
      DECLS_END_MARKER, '} // namespace D2Gdi',
    ].join('\n'), 'header'));
    files.set('Game/Main.cpp', file('Game/Main.cpp', [
      '#include "D2gfx/Render.h"', '// 1.14d: 00401000', 'void Main() { D2gfx::GFX_Draw(); }',
    ].join('\n'), 'implementation'));
    files.set('D2gfx/Render.cpp', file('D2gfx/Render.cpp', [
      '#include "D2gfx/Render.h"', '#include "D2Gdi/Gdi.h"', '// 1.14d: 00402000', 'void GFX_Draw() { D2Gdi::GDI_Blit(); }',
    ].join('\n'), 'implementation'));
    const graph = new ModuleGraph(config);
    applyModuleBoundaries({
      graph, files,
      functions: [fn('Main', 'Game', '00401000'), fn('GFX_Draw', 'D2gfx', '00402000'), fn('GDI_Blit', 'D2Gdi', '00403000')],
      globals: [], typeOwnerMap: new Map(), globalsPath: 'globals/globals.h',
      globalOwner: () => undefined, moduleExterns: new Map(), rootProvides: new Set(), typePrelude: () => [],
    });
    assert.ok(!files.get('Game/Main.cpp')!.content.includes('D2gfx.public.h'), 'Game loads D2gfx; it sees the interface, not D2gfx\'s imports');
    assert.ok(files.get('D2gfx/Render.h')!.content.includes('!defined(D2_LOADS_D2gfx)'), 'the internal gate lets a loading module through');
    assert.ok(files.get('D2Gdi/D2Gdi.public.h')!.content.includes('void GDI_Blit();'));
    assert.ok(!files.get('D2gfx/Render.cpp')!.content.includes('D2Gdi.public.h'), 'D2Gdi imports D2gfx: the load edge never becomes an include');
  });

  it('publishes a header inline another module calls, body and all, guarded in both places', () => {
    const files = new Map<string, SourceFile>();
    files.set('Storm/SMem.h', file('Storm/SMem.h', [
      '#pragma once', 'namespace Storm {', DECLS_BEGIN_MARKER,
      `${DECL_MARKER}00405000`, 'void SMemFree(void * p);', DECL_END_MARKER,
      `${DECL_MARKER}004053f0`, '__attribute__((noinline)) inline void FreeShim(void * p);', DECL_END_MARKER,
      DECLS_END_MARKER, '} // namespace Storm',
    ].join('\n'), 'header'));
    files.set('Storm/SMem.inline.h', file('Storm/SMem.inline.h', [
      '#pragma once', '#include "Storm/SMem.h"', 'namespace Storm {',
      `${INLINE_MARKER}004053f0`, '// 1.14d: 004053f0', '__attribute__((noinline)) inline void FreeShim(void * p) {', '    SMemFree(p);', '}',
      INLINE_END_MARKER, '} // namespace Storm',
    ].join('\n'), 'header'));
    files.set('Fog/Use.cpp', file('Fog/Use.cpp', [
      '#include "Storm/SMem.inline.h"', '// 1.14d: 00401000', 'void FOG_Use(void * p) { Storm::FreeShim(p); }',
    ].join('\n'), 'implementation'));
    const graph = new ModuleGraph(config);
    applyModuleBoundaries({
      graph, files,
      functions: [fn('SMemFree', 'Storm', '00405000'), fn('FreeShim', 'Storm', '004053f0'), fn('FOG_Use', 'Fog', '00401000')],
      globals: [], typeOwnerMap: new Map(), globalsPath: 'globals/globals.h',
      globalOwner: () => undefined, moduleExterns: new Map(), rootProvides: new Set(), typePrelude: () => [],
    });
    const pub = files.get('Storm/Storm.public.h')!.content;
    assert.ok(pub.includes('void SMemFree(void * p);'), 'the body calls it: it is declared');
    assert.ok(pub.includes('#ifndef D2_DEFINED_INLINE_004053f0\n#define D2_DEFINED_INLINE_004053f0\n// 1.14d: 004053f0'), pub);
    const inl = files.get('Storm/SMem.inline.h')!.content;
    assert.ok(inl.includes('#ifndef D2_DEFINED_INLINE_004053f0'), inl);
    assert.ok(!inl.includes('//@@'));
    pruneIncludes(files, { providerRank: (from, c) => (c.endsWith('.public.h') && !from.startsWith('Storm/') ? 0 : 1) });
    assert.deepStrictEqual(files.get('Fog/Use.cpp')!.content.split('\n').filter(l => l.startsWith('#include')), ['#include "Storm/Storm.public.h"']);
  });

  it('an inline body naming another module\'s data includes that module\'s public header, or is withheld', () => {
    const files = new Map<string, SourceFile>();
    files.set('D2Common/Bits.h', file('D2Common/Bits.h', [
      '#pragma once', 'namespace D2Common {', DECLS_BEGIN_MARKER,
      `${DECL_MARKER}00601000`, '__attribute__((noinline)) inline int GetBit(int n);', DECL_END_MARKER,
      `${DECL_MARKER}00601010`, '__attribute__((noinline)) inline int GetGame(int n);', DECL_END_MARKER,
      DECLS_END_MARKER, '} // namespace D2Common',
    ].join('\n'), 'header'));
    files.set('D2Common/Bits.inline.h', file('D2Common/Bits.inline.h', [
      '#pragma once', '#include "D2Common/Bits.h"', 'namespace D2Common {',
      `${INLINE_MARKER}00601000`, '// 1.14d: 00601000', '__attribute__((noinline)) inline int GetBit(int n) {', '    return Fog::gadwMasks[n];', '}', INLINE_END_MARKER,
      `${INLINE_MARKER}00601010`, '// 1.14d: 00601010', '__attribute__((noinline)) inline int GetGame(int n) {', '    return Game::gnGameCounter + n;', '}', INLINE_END_MARKER,
      '} // namespace D2Common',
    ].join('\n'), 'header'));
    files.set('Game/Main.cpp', file('Game/Main.cpp', [
      '#include "D2Common/Bits.inline.h"', '// 1.14d: 00401000', 'int Main() { return D2Common::GetBit(1) + D2Common::GetGame(2); }',
    ].join('\n'), 'implementation'));
    files.set('Fog/Use.cpp', file('Fog/Use.cpp', ['// 1.14d: 00402000', 'int FOG_Use() { return Fog::gadwMasks[0]; }'].join('\n'), 'implementation'));
    const masks = { name: 'gadwMasks', namespace: 'Fog', scope: 'global', dataType: 'int' } as unknown as AnalyzedDataSymbol;
    const counter = { name: 'gnGameCounter', namespace: 'Game', scope: 'global', dataType: 'int' } as unknown as AnalyzedDataSymbol;
    const graph = new ModuleGraph(config);
    applyModuleBoundaries({
      graph, files,
      functions: [fn('GetBit', 'D2Common', '00601000'), fn('GetGame', 'D2Common', '00601010'), fn('Main', 'Game', '00401000'), fn('FOG_Use', 'Fog', '00402000')],
      globals: [masks, counter], typeOwnerMap: new Map(), globalsPath: 'globals/globals.h',
      globalOwner: g => graph.moduleOfNamespace(g.namespace),
      moduleExterns: new Map([
        ['Fog', [{ namespace: 'Fog', decl: 'extern int gadwMasks[32];', name: 'gadwMasks', global: masks }]],
        ['Game', [{ namespace: 'Game', decl: 'extern int gnGameCounter;', name: 'gnGameCounter', global: counter }]],
      ]),
      rootProvides: new Set(), typePrelude: () => [],
    });
    const pub = files.get('D2Common/D2Common.public.h')!.content;
    assert.ok(pub.includes('#include "Fog/Fog.public.h"'), pub);
    assert.ok(pub.includes('return Fog::gadwMasks[n];'));
    assert.ok(!pub.includes('Game::gnGameCounter'), 'D2Common may not import Game: that body is withheld');
  });

  it('includes the public header of an imported module for a type it holds by value', () => {
    const files = new Map<string, SourceFile>();
    files.set('Storm/Types.h', file('Storm/Types.h', [
      '#pragma once', `${TYPE_MARKER}StormRectStrc`, 'struct StormRectStrc { int l; int t; };', TYPE_END_MARKER,
    ].join('\n'), 'header'));
    files.set('Fog/Types.h', file('Fog/Types.h', [
      '#pragma once', '#include "Storm/Types.h"',
      `${TYPE_MARKER}FogAreaStrc`, 'struct FogAreaStrc { StormRectStrc rect; };', TYPE_END_MARKER,
    ].join('\n'), 'header'));
    files.set('D2Common/Units.cpp', file('D2Common/Units.cpp', [
      '#include "Fog/Types.h"', '// 1.14d: 00601000', 'void UNITS_Do(FogAreaStrc * a) { }',
    ].join('\n'), 'implementation'));
    const graph = new ModuleGraph(config);
    applyModuleBoundaries({
      graph, files,
      functions: [fn('UNITS_Do', 'D2Common::Units', '00601000')],
      globals: [],
      typeOwnerMap: new Map([['FogAreaStrc', 'Fog/Types.h'], ['StormRectStrc', 'Storm/Types.h']]),
      globalsPath: 'globals/globals.h',
      globalOwner: () => undefined, moduleExterns: new Map(), rootProvides: new Set(), typePrelude: () => [],
    });
    const fogPub = files.get('Fog/Fog.public.h')!.content;
    assert.ok(fogPub.includes('#include "Storm/Storm.public.h"'), fogPub);
    assert.ok(fogPub.includes('struct FogAreaStrc { StormRectStrc rect; };'));
    assert.ok(!fogPub.includes('struct StormRectStrc;'), 'a forward declaration would let the include pass drop the include');
    assert.ok(files.get('Storm/Storm.public.h')!.content.includes('struct StormRectStrc { int l; int t; };'));
    const fogTypes = files.get('Fog/Types.h')!.content.split('\n');
    assert.ok(fogTypes.indexOf('#include "Storm/Storm.public.h"') < fogTypes.indexOf('#include "Storm/Types.h"'),
      'Fog imports Storm: its header includes Storm\'s public one first');
    pruneIncludes(files);
    assert.ok(files.get('Fog/Fog.public.h')!.content.includes('#include "Storm/Storm.public.h"'), 'the include pass keeps it');
  });
});

describe('generateModuleLibrariesCMake', () => {
  it('gives each module its macros and links in the configured order', () => {
    const files = new Map<string, SourceFile>();
    for (const p of ['Storm/SMem.cpp', 'Fog/Fog.cpp', 'D2Common/Units.cpp', 'Game/Main.cpp', 'globals/D2Common.cpp', 'globals/globals.cpp']) {
      files.set(p, file(p, '', 'implementation'));
    }
    const project = { name: 'x', files } as unknown as ReconstructedProject;
    const text = generateModuleLibrariesCMake(project, new ModuleGraph(config), { projectName: 'x' } as ReconstructOptions);
    assert.ok(/add_library\(D2Common STATIC\n {4}D2Common\/Units\.cpp\n {4}globals\/D2Common\.cpp\n\)/.test(text), text);
    const common = text.slice(text.indexOf('add_library(D2Common'));
    assert.ok(common.includes('D2_SEES_Fog') && common.includes('D2_SEES_Storm') && !common.slice(0, common.indexOf('target_link')).includes('D2_SEES_Game'));
    assert.ok(text.includes('target_link_libraries(D2Common PUBLIC d2_flags Fog)'));
    assert.ok(text.includes('add_library(d2_root STATIC\n    globals/globals.cpp\n)'));
    const order = [...text.matchAll(/WHOLE_ARCHIVE,(\w+)>/g)].map(m => m[1]);
    assert.deepStrictEqual(order, ['Fog', 'Game', 'Storm', 'D2Common', 'd2_root']);
  });
});

describe('definedTypeName', () => {
  it('reads the name past a packed attribute, so every packed type gets its own guard', async () => {
    const { definedTypeName } = await import('../codegen/globals-header.js');
    assert.strictEqual(definedTypeName('struct __attribute__((packed)) D2GameListEntryStrc {\n};'), 'D2GameListEntryStrc');
    assert.strictEqual(definedTypeName('struct D2CoordStrc {\n};'), 'D2CoordStrc');
    assert.strictEqual(definedTypeName('typedef void (__stdcall *fnCallback)(int);'), 'fnCallback');
  });
});

describe('macro references', () => {
  it('counts a function a #define in a module file names as a reference', () => {
    const files = new Map<string, SourceFile>();
    files.set('Fog/Memory.h', file('Fog/Memory.h', [
      '#pragma once', 'namespace Fog::Memory {', DECLS_BEGIN_MARKER,
      `${DECL_MARKER}0040b3c0`, 'BOOL FreeClientMemory(void * p);', DECL_END_MARKER,
      DECLS_END_MARKER, '}',
    ].join('\n'), 'header'));
    files.set('D2Common/Items.cpp', file('D2Common/Items.cpp',
      '#define D2_FREE(p) Fog::Memory::FreeClientMemory((p))\n// 1.14d: 00601000\nvoid ITEMS_Free(void * p) { D2_FREE(p); }', 'implementation'));
    const graph = new ModuleGraph(config);
    const r = applyModuleBoundaries({
      graph, files,
      functions: [fn('FreeClientMemory', 'Fog::Memory', '0040b3c0'), fn('ITEMS_Free', 'D2Common::Items', '00601000')],
      globals: [], typeOwnerMap: new Map(), globalsPath: 'globals/globals.h',
      globalOwner: () => undefined, moduleExterns: new Map(), rootProvides: new Set(), typePrelude: () => [],
    });
    assert.ok(r.references.some(x => x.source === 'macro' && x.symbol === 'Fog::Memory::FreeClientMemory'));
    assert.ok(!files.get('Fog/Memory.h')!.content.includes('|| defined(D2_MODULE_Fog)'));
  });
});

describe('qualified references', () => {
  it('a qualifier naming another module wins over the user module\'s same-named function', () => {
    const files = new Map<string, SourceFile>();
    files.set('D2Client/Skills.cpp', file('D2Client/Skills.cpp',
      '// 1.14d: 00470000\nvoid SKILLS_Draw(D2SkillStrc * p) { D2Common::Skills::Skills::GetSkillId(p); }', 'implementation'));
    const graph = new ModuleGraph({ ...config, modules: { ...config.modules, D2Client: { imports: ['D2Common'] } } });
    const r = applyModuleBoundaries({
      graph, files,
      functions: [
        fn('GetSkillId', 'D2Client::GAME::RosterPets', '00479180'),
        fn('GetSkillId', 'D2Common::Skills::Skills', '00643ce0'),
        fn('GetSkillId', 'D2Common::Units::Missile', '0064a280'),
        fn('SKILLS_Draw', 'D2Client::Skills', '00470000'),
      ],
      globals: [], typeOwnerMap: new Map(), globalsPath: 'globals/globals.h',
      globalOwner: () => undefined, moduleExterns: new Map(), rootProvides: new Set(), typePrelude: () => [],
    });
    assert.ok(r.references.some(x => x.owner === 'D2Common' && x.symbol.endsWith('::GetSkillId')), JSON.stringify(r.references));
    assert.ok(r.reports.get('module-public-api.tsv')!.includes('D2Common\tfunction\t00643ce0'));
  });
});

describe('one name, several qualified owners', () => {
  it('a table naming every renderer\'s function makes each of them public', () => {
    const files = new Map<string, SourceFile>();
    files.set('D2gfx/Tables.cpp', file('D2gfx/Tables.cpp',
      'void * gaTables[] = { (void *)&D2Gdi::Renderer::UpdateScaleFactor, (void *)&D2Glide::Renderer::UpdateScaleFactor };', 'implementation'));
    const graph = new ModuleGraph({
      ...config,
      modules: { ...config.modules, D2Glide: { imports: ['Fog'] }, D2gfx: { imports: ['Storm', 'Fog'], loads: ['D2Gdi', 'D2Glide'] } },
    });
    const r = applyModuleBoundaries({
      graph, files,
      functions: [fn('UpdateScaleFactor', 'D2Gdi::Renderer', '006c8000'), fn('UpdateScaleFactor', 'D2Glide::Renderer', '00509000')],
      globals: [], typeOwnerMap: new Map(), globalsPath: 'globals/globals.h',
      globalOwner: () => undefined, moduleExterns: new Map(), rootProvides: new Set(), typePrelude: () => [],
    });
    const api = r.reports.get('module-public-api.tsv')!;
    assert.ok(api.includes('D2Gdi\tfunction\t006c8000') && api.includes('D2Glide\tfunction\t00509000'), api);
    assert.deepStrictEqual(r.references.map(x => x.owner).sort(), ['D2Gdi', 'D2Glide']);
  });
});
