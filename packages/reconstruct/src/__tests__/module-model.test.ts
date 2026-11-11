/**
 * project.json `modules` as the one module table: validation, the graph it
 * yields, where files go, and the build's copy of it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { ModuleConfig } from '../config/schema.js';
import {
  ModuleLayout, isModuleModel, libraryConfigFromModules, reachability, validateModules,
} from '../modules/module-model.js';
import { ModuleGraph } from '../modules/module-libraries.js';
import { modulesCMake } from '../codegen/module-layout.js';

const imp = (module: string) => ({ module, via: 'import' as const, evidence: '1.13d import table' });
const load = (module: string) => ({ module, via: 'load' as const, evidence: 'LoadLibrary' });

function table(): Record<string, ModuleConfig> {
  return {
    crashy: { kind: '3rdparty', namespaces: ['Fog::_3rdparty::crashy'], dir: '3rdparty/crashy', linkOrder: 0, dependencies: [imp('Fog'), imp('Storm')] },
    Storm: { kind: '3rdparty', namespaces: ['Storm'], dir: '3rdparty/Storm', linkOrder: 3, dependencies: [] },
    Fog: {
      kind: 'dll-module', namespaces: ['Fog'], dir: 'Source/Fog', linkOrder: 1, dependencies: [imp('Storm')],
      exceptions: [{ to: 'D2Lang', symbol: 'MISC_GetLanguageCode', reason: '1.14-only' }],
    },
    D2Lang: { kind: 'dll-module', namespaces: ['D2Lang'], dir: 'Source/D2Lang', linkOrder: 4, dependencies: [imp('Storm'), imp('Fog')] },
    D2gfx: { kind: 'dll-module', namespaces: ['D2gfx'], dir: 'Source/D2gfx', linkOrder: 5, dependencies: [imp('Fog'), load('D2Gdi')] },
    D2Gdi: { kind: 'dll-module', namespaces: ['D2Gdi'], dir: 'Source/D2Gdi', linkOrder: 6, dependencies: [imp('D2gfx')] },
    Game: { kind: 'exe', namespaces: ['Game'], dir: 'Source/Game', linkOrder: 2, dependencies: [imp('Fog'), load('D2gfx')], strict: true },
    D2Headers: { kind: 'headers-only', namespaces: [], files: ['d2_platform.h'], dir: 'Source/D2Headers', linkOrder: 7, description: 'Shared headers.' },
    Redivivus: { kind: 'ours', namespaces: [], dir: 'Redivivus', linkOrder: 8 },
    D2OpenGL: { kind: 'dll-module', target: 'mac', namespaces: ['D2OpenGL'], dir: 'Source/D2OpenGL', dependencies: [imp('Fog')] },
  };
}

describe('module table', () => {
  it('is the full model only when every entry has a dir', () => {
    assert.ok(isModuleModel(table()));
    assert.ok(!isModuleModel({ D2Common: { namespaces: ['D2Common'], dependencies: [] } }));
  });

  it('accepts a sound table; a load edge may close a loop', () => {
    assert.deepStrictEqual(validateModules(table()), []);
  });

  it('refuses an import cycle', () => {
    const t = table();
    t.Storm.dependencies = [imp('Fog')];
    assert.ok(validateModules(t).some(p => p.includes('import cycle')));
  });

  it('refuses a namespace two modules claim', () => {
    const t = table();
    t.D2Lang.namespaces = ['D2Lang', 'Fog'];
    assert.ok(validateModules(t).some(p => p.includes('namespace Fog maps to both')));
  });

  it('refuses an exception the graph already allows, or without a reason', () => {
    const t = table();
    t.D2Lang.exceptions = [{ to: 'Storm', reason: 'x' }, { to: 'Game', reason: '' }];
    const problems = validateModules(t);
    assert.ok(problems.some(p => p.includes('may already use Storm')));
    assert.ok(problems.some(p => p.includes('needs a reason')));
  });

  it('refuses an edge without evidence and an unknown kind', () => {
    const t = table();
    t.D2Lang.dependencies = [{ module: 'Fog', via: 'import', evidence: ' ' }];
    (t.D2Lang as { kind: string }).kind = 'library';
    const problems = validateModules(t);
    assert.ok(problems.some(p => p.includes('needs its evidence')));
    assert.ok(problems.some(p => p.includes('kind must be one of')));
  });

  it('reach: imports transitively, loads one step, shared modules for all', () => {
    const r = reachability(table());
    assert.ok(r.get('crashy')!.has('Storm'));
    assert.ok(r.get('Game')!.has('D2gfx'));
    assert.ok(!r.get('Game')!.has('D2Gdi'), 'a load is one step: the host does not see what the provider loads');
    assert.ok(r.get('Storm')!.has('D2Headers'));
    assert.ok(r.get('Storm')!.has('Redivivus'));
    assert.ok(r.get('Redivivus')!.has('D2Gdi'));
    assert.ok(!r.get('Fog')!.has('D2Lang'), 'an exception is not reach');
  });
});

describe('module graph from the table', () => {
  const graph = new ModuleGraph(libraryConfigFromModules(table()));

  it('holds the generated Windows modules in link order', () => {
    assert.deepStrictEqual(graph.linkOrder(), ['crashy', 'Fog', 'Game', 'Storm', 'D2Lang', 'D2gfx', 'D2Gdi']);
  });

  it('gives a nested namespace to its own module', () => {
    assert.strictEqual(graph.moduleOfNamespace('Fog::_3rdparty::crashy::Report'), 'crashy');
    assert.strictEqual(graph.moduleOfNamespace('Fog::Src::ErrorManager'), 'Fog');
    assert.strictEqual(graph.moduleOfPath('Fog/3rdparty/crashy/Report.cpp'), 'crashy');
    assert.strictEqual(graph.moduleOfPath('Fog/3rdparty/crashy.h'), 'crashy');
    assert.strictEqual(graph.moduleOfPath('Fog/Src/ErrorManager.h'), 'Fog');
    assert.strictEqual(graph.moduleOfPath('d2_platform.h'), undefined, 'the shared headers stay the root');
    assert.strictEqual(graph.publicHeaderOf('crashy'), 'Fog/3rdparty/crashy/crashy.public.h');
  });

  it('keeps the exceptions', () => {
    assert.ok(graph.excepted('Fog', 'D2Lang', 'D2Lang::StrTable::MISC_GetLanguageCode'));
    assert.ok(!graph.excepted('Fog', 'D2Lang', 'D2Lang::StrTable::Other'));
  });
});

describe('module layout', () => {
  const layout = new ModuleLayout(table());

  it('moves each file under its module dir', () => {
    assert.strictEqual(layout.pathOf('Fog/Src/ErrorManager.cpp'), 'Source/Fog/Src/ErrorManager.cpp');
    assert.strictEqual(layout.pathOf('Storm/H/stpl/TSList/TSList.h'), '3rdparty/Storm/H/stpl/TSList/TSList.h');
    assert.strictEqual(layout.pathOf('Fog/3rdparty/crashy/Report.cpp.map'), '3rdparty/crashy/Report.cpp.map');
    assert.strictEqual(layout.pathOf('Fog/3rdparty/crashy.cpp'), '3rdparty/crashy/crashyRoot.cpp');
    assert.strictEqual(layout.pathOf('d2_platform.h'), 'Source/D2Headers/d2_platform.h');
    assert.strictEqual(layout.pathOf('globals/globals.h'), 'Source/globals/globals.h', 'the shared root goes under Source/');
    assert.strictEqual(layout.pathOf('Fogger/x.h'), 'Source/Fogger/x.h');
  });

  it('names the public header after the module and moves the namespace\'s own unit aside', () => {
    assert.strictEqual(layout.pathOf('Fog/Fog.public.h'), 'Source/Fog/Fog.h');
    assert.strictEqual(layout.pathOf('Fog/Fog.h'), 'Source/Fog/FogRoot.h');
    assert.strictEqual(layout.pathOf('Fog/Fog.cpp'), 'Source/Fog/FogRoot.cpp');
    assert.strictEqual(layout.pathOf('Fog/Fog.cpp.map'), 'Source/Fog/FogRoot.cpp.map');
    assert.strictEqual(layout.pathOf('Fog/Fog.globals.h'), 'Source/Fog/Fog.globals.h', 'the module data header keeps its name');
    assert.strictEqual(layout.pathOf('Fog/3rdparty/crashy.h'), '3rdparty/crashy/crashyRoot.h');
    assert.strictEqual(layout.pathOf('Fog/3rdparty/crashy/crashy.public.h'), '3rdparty/crashy/crashy.h');
    assert.strictEqual(layout.pathOf('Storm/Storm.public.h'), '3rdparty/Storm/Storm.h');
    assert.strictEqual(layout.publicHeaderPath('Storm'), '3rdparty/Storm/Storm.h');
    assert.strictEqual(layout.moduleOfPath('3rdparty/crashy/Report.cpp'), 'crashy');
  });

  it('takes both names from the module table', () => {
    const t = table();
    t.Fog.publicHeader = '{module}Api.h';
    t.Fog.rootUnit = '{module}Unit';
    const custom = new ModuleLayout(t);
    assert.strictEqual(custom.pathOf('Fog/Fog.public.h'), 'Source/Fog/FogApi.h');
    assert.strictEqual(custom.pathOf('Fog/Fog.cpp'), 'Source/Fog/FogUnit.cpp');
    t.Fog.publicHeader = 'sub/Fog.h';
    assert.ok(validateModules(t).some(p => p.includes('publicHeader must be a file name')));
  });

  it('rewrites the includes of generated files only', () => {
    const generated = new Set(['Fog/Src/ErrorManager.h', 'd2_platform.h', 'globals/globals.h']);
    const text = [
      '#include "Fog/Src/ErrorManager.h"',
      '  #include "d2_platform.h" // forced',
      '#include "globals/globals.h"',
      '#include "Redivivus/d2_trace.h"',
      '#include <windows.h>',
      'const char* s = "#include \\"Fog/Src/ErrorManager.h\\"";',
    ].join('\n');
    assert.strictEqual(layout.rewriteIncludes(text, generated), [
      '#include "Source/Fog/Src/ErrorManager.h"',
      '  #include "Source/D2Headers/d2_platform.h" // forced',
      '#include "Source/globals/globals.h"',
      '#include "Redivivus/d2_trace.h"',
      '#include <windows.h>',
      'const char* s = "#include \\"Fog/Src/ErrorManager.h\\"";',
    ].join('\n'));
  });
});

describe('Source/modules.cmake', () => {
  const text = modulesCMake(table(), new Map([['Fog', 'Source/globals/Fog.cpp']]));

  it('says on its first line where the table is edited', () => {
    assert.match(text.split('\n')[0], /^# Generated from project.json "modules"/);
  });

  it('lists the Windows modules in link order, the Mac ones not at all', () => {
    assert.match(text, /^set\(D2_MODULES crashy Fog Game Storm D2Lang D2gfx D2Gdi D2Headers Redivivus\)$/m);
    assert.doesNotMatch(text, /D2OpenGL/);
  });

  it('writes the static imports and the public header', () => {
    const withPublic = modulesCMake(table(), new Map(), new Map([['Fog', 'Source/Fog/Fog.h']]));
    assert.match(withPublic, /^set\(D2_MODULE_D2gfx_IMPORTS Fog\)$/m, 'a load edge is no import');
    assert.match(withPublic, /^set\(D2_MODULE_D2gfx_DEPENDS Fog D2Gdi\)$/m);
    assert.match(withPublic, /^set\(D2_MODULE_D2gfx_LOADS D2Gdi\)$/m);
    assert.match(withPublic, /^set\(D2_MODULE_Fog_PUBLIC "Source\/Fog\/Fog.h"\)$/m);
    assert.match(withPublic, /^set\(D2_MODULE_Storm_PUBLIC ""\)$/m);
  });

  it('writes reach, exceptions, strictness and the data unit', () => {
    assert.match(text, /^set\(D2_MODULE_Fog_SEES Fog Storm D2Lang D2Headers Redivivus\)$/m);
    assert.match(text, /^set\(D2_MODULE_Fog_EXCEPTIONS D2Lang\)$/m);
    assert.match(text, /^set\(D2_MODULE_Fog_DATA "Source\/globals\/Fog.cpp"\)$/m);
    assert.match(text, /^set\(D2_MODULE_Game_STRICT ON\)$/m);
    assert.match(text, /^set\(D2_MODULE_Game_SEES Fog Game Storm D2gfx D2Headers Redivivus\)$/m);
    assert.match(text, /^set\(D2_MODULE_Redivivus_GENERATED OFF\)$/m);
  });
});
