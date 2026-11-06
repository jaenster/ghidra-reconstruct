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
import { DECLS_BEGIN_MARKER, DECLS_END_MARKER, DECL_MARKER, DECL_END_MARKER, TYPE_MARKER, TYPE_END_MARKER } from '../codegen/header.js';
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
    assert.ok(!h.includes('defined(D2_MODULE_Fog)'), 'FOG_Internal is named by d2_platform.h, FOG_Used by D2Common');
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

  it('writes the public umbrella header', () => {
    const { files } = run();
    const pub = files.get('Fog/Fog.public.h')!.content;
    assert.ok(pub.includes('#include "Fog/Fog.h"'));
    assert.ok(pub.includes('#include "Fog/Fog.globals.h"'));
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
    assert.ok(!files.get('Fog/Memory.h')!.content.includes('defined(D2_MODULE_Fog)'));
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
