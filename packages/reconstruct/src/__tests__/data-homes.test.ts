/**
 * A global several TUs use is defined in the TU its data run belongs to, with
 * external linkage, and declared in that TU's data header, which only the TUs that
 * name it include. globals.h keeps what has no home.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  assignDataHomes,
  keepDataRunsWhole,
  dataHeaderPathOf,
  homedGlobalKey,
  dataHomeVeto,
} from '../codegen/file-local-globals.js';
import { generateGlobalsHeader, generateDataHeader, generateGlobalsImpl, markGlobalsClaimed } from '../codegen/globals-header.js';
import { answerPlacementLookup, includeBasisHolds, type PlacementLookup } from '../codegen/index.js';
import { buildModuleGraph } from '../modules/builder.js';
import type { AnalyzedDataSymbol, ExtractedFunction, ExtractedStruct, ReconstructOptions } from '../types.js';

function sym(name: string, address: string, o: Partial<AnalyzedDataSymbol> = {}): AnalyzedDataSymbol {
  return {
    name, address, dataType: 'int', suggestedType: 'int', size: 4, isInitialized: false,
    xrefCount: 1, scope: 'global', ...o,
  } as AnalyzedDataSymbol;
}
const local = (name: string, address: string, file: string, fns: string[]): AnalyzedDataSymbol =>
  sym(name, address, { scope: 'file-local', ownerFile: file, referencingFunctions: fns });

const implOf = new Map([
  ['a1', 'A.cpp'], ['a2', 'A.cpp'], ['b1', 'B.cpp'], ['c1', 'C.cpp'],
]);
const inputs = { foreignSources: [], functionQualifiedNames: new Set<string>(), rootTypeNames: new Set<string>() };

const options = {
  outputDir: '/tmp/test', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false,
  promoteStaticGlobals: true,
} as ReconstructOptions;

describe('data homes', () => {
  it('homes a global several TUs use in the TU whose run it sits in, and keeps that run whole', () => {
    const gs = [
      local('w', '00700000', 'A.cpp', ['a1', 'a2']),
      sym('shared', '00700004', { referencingFunctions: ['a1', 'b1'] }),
      local('x', '00700008', 'A.cpp', ['a1', 'a2']),
      local('z', '00700020', 'B.cpp', ['b1']),
    ];
    const r = assignDataHomes(gs, implOf, inputs);
    assert.strictEqual(r.homed, 1);
    assert.strictEqual(keepDataRunsWhole(gs, implOf), 0);
    assert.deepStrictEqual(gs.map(g => g.scope), ['file-local', 'global', 'file-local', 'file-local']);
    assert.strictEqual(gs[1].homeFile, 'A.cpp');
  });

  it('homes by the run, not by the users: a run of A holds a global only B and C read', () => {
    const gs = [
      local('w', '00700000', 'A.cpp', ['a1']),
      sym('table', '00700004', { referencingFunctions: ['b1', 'c1'] }),
      local('x', '00700008', 'A.cpp', ['a2']),
    ];
    assignDataHomes(gs, implOf, inputs);
    keepDataRunsWhole(gs, implOf);
    assert.strictEqual(gs[1].homeFile, 'A.cpp');
  });

  it('keeps a global at a run boundary central', () => {
    const gs = [
      local('w', '00700000', 'A.cpp', ['a1']),
      sym('between', '00700004', { referencingFunctions: ['a1', 'b1'] }),
      local('z', '00700008', 'B.cpp', ['b1']),
    ];
    assignDataHomes(gs, implOf, inputs);
    assert.strictEqual(gs[1].homeFile, undefined);
    assert.strictEqual(dataHomeVeto(gs[1]), 'no-run');
  });

  it('a vetoed member keeps the whole run central: its file-locals and its homed globals', () => {
    const gs = [
      local('w', '00700000', 'A.cpp', ['a1', 'a2']),
      sym('shared', '00700004', { referencingFunctions: ['a1', 'b1'] }),
      sym('dup', '00700008', { referencingFunctions: ['a1', 'b1'] }),
      local('x', '0070000c', 'A.cpp', ['a1', 'a2']),
      sym('dup', '00800000', { referencingFunctions: ['c1'] }),
    ];
    assignDataHomes(gs, implOf, inputs);
    assert.strictEqual(gs[1].homeFile, 'A.cpp');
    assert.strictEqual(gs[2].homeFile, undefined);
    assert.strictEqual(dataHomeVeto(gs[2]), 'shared-name');
    assert.strictEqual(keepDataRunsWhole(gs, implOf), 2);
    assert.deepStrictEqual(gs.slice(0, 4).map(g => [g.scope, g.homeFile]), [
      ['global', undefined], ['global', undefined], ['global', undefined], ['global', undefined],
    ]);
    assert.match(dataHomeVeto(gs[1]), /^run-not-whole:home-veto:shared-name/);
  });

  it('a function-local static of the same spelling is no second name', () => {
    const gs = [
      local('w', '00700000', 'A.cpp', ['a1', 'a2']),
      sym('count', '00700004', { referencingFunctions: ['a1', 'b1'] }),
      local('x', '00700008', 'A.cpp', ['a1', 'a2']),
      sym('count', '00800000', { scope: 'static-local', ownerFunction: 'c1', referencingFunctions: ['c1'] }),
    ];
    assignDataHomes(gs, implOf, inputs);
    assert.strictEqual(gs[1].homeFile, 'A.cpp');
    assert.strictEqual(dataHomeVeto(gs[1]), '');
  });

  it('vetoes a name a function owns, and pins what foreign source names to globals.h', () => {
    const gs = [
      local('w', '00700000', 'A.cpp', ['a1']),
      sym('PlayerMultiplyer', '00700004', { referencingFunctions: ['a1', 'b1'] }),
      sym('gnHooked', '00700008', { referencingFunctions: ['a1', 'b1'] }),
      local('x', '0070000c', 'A.cpp', ['a2']),
    ];
    assignDataHomes(gs, implOf, {
      ...inputs,
      functionQualifiedNames: new Set(['PlayerMultiplyer']),
      foreignSources: [{ path: 'support/x.cpp', text: 'extern int gnHooked; void f() { gnHooked = 1; }' }],
    });
    assert.strictEqual(dataHomeVeto(gs[1]), 'function-name');
    assert.strictEqual(gs[2].homeFile, 'A.cpp');
    assert.strictEqual(gs[2].homeDeclaredCentrally, true);
  });

  it('names the data header beside the TU and keys the home in the unit statics', () => {
    assert.strictEqual(dataHeaderPathOf('D2Common/Items/Items.cpp'), 'D2Common/Items/Items.data.h');
    assert.strictEqual(homedGlobalKey({ address: '0074d87c' }), 'H:0074d87c');
  });
});

describe('declarations', () => {
  const homed = sym('gpItemTable', '00700004', {
    dataType: 'D2ItemTxt *', suggestedType: 'D2ItemTxt *', referencingFunctions: ['a1', 'b1'], homeFile: 'A.cpp',
  });
  const table = sym('gaItemTypes', '00700010', {
    dataType: 'D2ItemTypeStrc[4]', suggestedType: 'D2ItemTypeStrc[4]', size: 16, referencingFunctions: ['a1', 'b1'], homeFile: 'A.cpp',
  });
  const central = sym('gnOther', '00900000', { referencingFunctions: ['a1', 'b1'] });
  const itemType: ExtractedStruct = {
    name: 'D2ItemTypeStrc', category: '/D2', size: 4, kind: 'STRUCTURE',
    fields: [{ name: 'nCode', dataType: 'int', offset: 0, size: 4 }],
  };
  const owners = new Map([['D2ItemTypeStrc', 'D2Common/D2ItemTypeStrc.h']]);

  it('globals.h declares neither the homed globals nor the types only they need', () => {
    const h = generateGlobalsHeader([homed, table, central], options, [itemType], owners, new Set(), new Map());
    assert.match(h, /extern int gnOther;/);
    assert.doesNotMatch(h, /gpItemTable|gaItemTypes/);
    assert.doesNotMatch(h, /D2ItemTypeStrc\.h/);
  });

  it('the data header declares them with their own types: an owner include, a forward declaration', () => {
    const h = generateDataHeader('A.cpp', [table, homed], options, [itemType], owners);
    assert.match(h, /#pragma once/);
    assert.match(h, /#include "D2Common\/D2ItemTypeStrc\.h"/);
    assert.match(h, /struct D2ItemTxt;/);
    assert.match(h, /extern D2ItemTxt \* gpItemTable;/);
    assert.match(h, /extern D2ItemTypeStrc gaItemTypes\[4\];/);
    assert.doesNotMatch(h, /globals\/globals\.h/);
    // Address order: the run's order.
    assert.ok(h.indexOf('gpItemTable') < h.indexOf('gaItemTypes'));
  });

  it('a globals unit does not define a homed global its home claimed', () => {
    markGlobalsClaimed([homed]);
    const unclaimed = sym('gnUnclaimed', '00700020', { referencingFunctions: ['a1', 'b1'], homeFile: 'A.cpp' });
    const cpp = generateGlobalsImpl([homed, central, unclaimed], options);
    assert.doesNotMatch(cpp, /gpItemTable/);
    assert.match(cpp, /int gnOther;/);
    assert.match(cpp, /int gnUnclaimed;/);
  });
});

describe('reuse', () => {
  const placement = (homes: Record<string, string>): PlacementLookup => ({
    typeOwner: () => undefined,
    functionHeaders: () => undefined,
    fieldType: () => undefined,
    templateHeader: undefined,
    constructorFact: () => '-',
    dataHome: n => homes[n] ?? '',
  });

  it('text written under another home of a global it names is not reused', () => {
    const before = placement({ gpItemTable: 'A.data.h' });
    const basis = { graph: [], lookups: [['g:gpItemTable', answerPlacementLookup('g:gpItemTable', before)] as [string, string]] };
    assert.strictEqual(includeBasisHolds(basis, [], before), true);
    assert.strictEqual(includeBasisHolds(basis, [], placement({ gpItemTable: 'B.data.h' })), false);
    // Home lost: globals.h declares it again.
    assert.strictEqual(includeBasisHolds(basis, [], placement({})), false);
  });
});

describe('the module graph', () => {
  it('files a homed global under its home unit, so a retype re-emits the unit that defines it', () => {
    const fn = (name: string, ns: string): ExtractedFunction => ({
      name, address: '00401000', signature: `void ${name}()`, returnType: 'void', parameters: [],
      localVariables: [], callingConvention: '__cdecl', size: 1, isThunk: false, isExternal: false,
      hasVarArgs: false, namespace: ns, calledFunctions: [],
    } as unknown as ExtractedFunction);
    const g = sym('gpItemTable', '00700004', { homeFile: 'M/A.cpp', referencingFunctions: ['a1', 'b1'] });
    const graph = buildModuleGraph({
      organized: new Map([['M::A', [fn('a1', 'M::A')]], ['M::B', [fn('b1', 'M::B')]]]),
      classes: [], dataTypes: [], globals: [g],
      unitHeaderPaths: new Map([['M::A', 'M/A.h'], ['M::B', 'M/B.h']]),
      ownership: { typeOwnerMap: new Map(), structsWithOwnUnit: new Set(), extraHeaderTypes: new Map() },
      options, funcNameToHeaderPath: new Map(), platformHeaders: new Set(),
    });
    assert.deepStrictEqual(graph.getModule('M/A.h')!.globals.map(x => x.address), ['00700004']);
    assert.deepStrictEqual(graph.getModule('M/B.h')!.globals, []);
  });
});

describe('a retype', () => {
  it('rewrites its own data header and neither globals.h nor another data header', () => {
    const at = (type: string) => [
      sym('gnItemCount', '00700004', { dataType: type, suggestedType: type, referencingFunctions: ['a1', 'b1'], homeFile: 'A.cpp' }),
      sym('gnSkillCount', '00700104', { referencingFunctions: ['b1', 'c1'], homeFile: 'B.cpp' }),
      sym('gnOther', '00900000', { referencingFunctions: ['a1', 'b1'] }),
    ];
    const emit = (gs: AnalyzedDataSymbol[]) => ({
      globals: generateGlobalsHeader(gs, options, [], new Map(), new Set(), new Map()),
      a: generateDataHeader('A.cpp', [gs[0]], options, [], new Map()),
      b: generateDataHeader('B.cpp', [gs[1]], options, [], new Map()),
    });
    const before = emit(at('int'));
    const after = emit(at('float'));
    assert.notStrictEqual(after.a, before.a);
    assert.match(after.a, /extern float gnItemCount;/);
    assert.strictEqual(after.b, before.b);
    assert.strictEqual(after.globals, before.globals);
  });

  it('leaves a file whose bytes did not change untouched on disk', async () => {
    const { writeProject } = await import('../codegen/index.js');
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-home-'));
    const project = (content: string) => ({
      name: 't', files: new Map([['A.data.h', { path: 'A.data.h', content, type: 'header', functions: [], includes: [] }]]),
      sourceMaps: new Map(), dataTypes: [], globals: [], classes: [], namespaces: [],
    }) as unknown as Parameters<typeof writeProject>[0];
    await writeProject(project('extern int x;\n'), dir, { ...options, generateCMake: false });
    const file = path.join(dir, 'A.data.h');
    const old = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await fs.utimes(file, old, old);
    await writeProject(project('extern int x;\n'), dir, { ...options, generateCMake: false });
    assert.strictEqual(Math.round((await fs.stat(file)).mtimeMs), old.getTime());
    await writeProject(project('extern float x;\n'), dir, { ...options, generateCMake: false });
    assert.notStrictEqual(Math.round((await fs.stat(file)).mtimeMs), old.getTime());
    await fs.rm(dir, { recursive: true, force: true });
  });
});
