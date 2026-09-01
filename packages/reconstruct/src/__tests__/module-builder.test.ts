/**
 * Tests for ModuleGraph builder and resolution integration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildModuleGraph } from '../modules/builder.js';
import { computeTypeOwnership } from '../modules/type-ownership.js';
import type {
  ExtractedFunction,
  ExtractedDataType,
  ExtractedStruct,
  AnalyzedDataSymbol,
  DetectedClass,
  ReconstructOptions,
} from '../types.js';

const defaultOptions: ReconstructOptions = {
  outputDir: './out',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'quick',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

function makeFunc(name: string, ns?: string, params?: { name: string; dataType: string }[]): ExtractedFunction {
  return {
    name,
    address: `0x${Math.random().toString(16).slice(2, 10)}`,
    signature: `void ${name}()`,
    returnType: 'void',
    parameters: (params ?? []).map((p, i) => ({ ...p, size: 4, ordinal: i, storage: 'register' })),
    localVariables: [],
    callingConvention: '__cdecl',
    size: 100,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    namespace: ns,
    calledFunctions: [],
  };
}

function makeStruct(name: string, fields: { name: string; dataType: string; offset: number }[]): ExtractedStruct {
  return {
    name,
    category: '/test',
    size: fields.length * 4,
    kind: 'STRUCTURE',
    fields: fields.map(f => ({ ...f, size: 4 })),
  };
}

describe('buildModuleGraph', () => {
  it('creates modules for each organized unit', () => {
    const organized = new Map<string, ExtractedFunction[]>();
    organized.set('Util::Graph', [makeFunc('Graph_Init', 'Util::Graph')]);
    organized.set('Util::Edge', [makeFunc('Edge_Create', 'Util::Edge')]);

    const unitHeaderPaths = new Map<string, string>();
    unitHeaderPaths.set('Util::Graph', 'Util/Graph/Graph.h');
    unitHeaderPaths.set('Util::Edge', 'Util/Edge/Edge.h');

    const graph = buildModuleGraph({
      organized,
      classes: [],
      dataTypes: [],
      globals: [],
      unitHeaderPaths,
      ownership: { typeOwnerMap: new Map(), structsWithOwnUnit: new Set(), extraHeaderTypes: new Map() },
      options: defaultOptions,
      funcNameToHeaderPath: new Map(),
      platformHeaders: new Set(),
    });

    assert.ok(graph.getModule('Util/Graph/Graph.h'));
    assert.ok(graph.getModule('Util/Edge/Edge.h'));
    assert.strictEqual(graph.findOwner('Graph_Init'), 'Util/Graph/Graph.h');
    assert.strictEqual(graph.findOwner('Edge_Create'), 'Util/Edge/Edge.h');
  });

  it('registers type exports and tracks deps from struct fields', () => {
    const drlgStruct = makeStruct('GraphNodeT', [
      { name: 'pUnit', dataType: 'EdgeT *', offset: 0 },
      { name: 'nLevel', dataType: 'int', offset: 4 },
    ]);
    const unitStruct = makeStruct('EdgeT', [
      { name: 'nType', dataType: 'int', offset: 0 },
    ]);

    const organized = new Map<string, ExtractedFunction[]>();
    organized.set('Util::Graph', [makeFunc('Graph_Init', 'Util::Graph')]);
    organized.set('Util::Edge', [makeFunc('Edge_Create', 'Util::Edge')]);

    const unitHeaderPaths = new Map<string, string>();
    unitHeaderPaths.set('Util::Graph', 'Util/Graph/Graph.h');
    unitHeaderPaths.set('Util::Edge', 'Util/Edge/Edge.h');

    const typeOwnerMap = new Map<string, string>();
    typeOwnerMap.set('GraphNodeT', 'Util/Graph/Graph.h');
    typeOwnerMap.set('EdgeT', 'Util/Edge/Edge.h');

    const graph = buildModuleGraph({
      organized,
      classes: [],
      dataTypes: [drlgStruct, unitStruct],
      globals: [],
      unitHeaderPaths,
      ownership: { typeOwnerMap, structsWithOwnUnit: new Set(), extraHeaderTypes: new Map() },
      options: defaultOptions,
      funcNameToHeaderPath: new Map(),
      platformHeaders: new Set(),
    });

    assert.strictEqual(graph.findOwner('GraphNodeT'), 'Util/Graph/Graph.h');
    assert.strictEqual(graph.findOwner('EdgeT'), 'Util/Edge/Edge.h');

    // GraphNodeT holds `EdgeT *`, which needs only `struct EdgeT;` in the header.
    //
    // CHANGED: this used to assert the dep landed in headerIncludes. It lands in
    // implIncludes, and should: the header emitter forward-declares pointer-only
    // types itself, and promoting by-pointer deps to header includes was measured
    // on the real tree (run.ts --codegen-only) at 20051 -> 28563 mingw
    // -fsyntax-only errors over the same 400 .cpp. See the matching note in
    // module-graph.test.ts.
    const resolved = graph.resolve();
    const drlgModule = resolved.get('Util/Graph/Graph.h')!;
    assert.ok(
      !drlgModule.headerIncludes.includes('Util/Edge/Edge.h'),
      'A pointer-only dep must not force a header include',
    );
    assert.ok(
      drlgModule.implIncludes.includes('Util/Edge/Edge.h'),
      'Expected EdgeT pointer dep in implIncludes',
    );
  });

  it('by-value struct field deps go to headerIncludes', () => {
    const innerStruct = makeStruct('InnerStrc', [
      { name: 'x', dataType: 'int', offset: 0 },
    ]);
    const outerStruct = makeStruct('OuterStrc', [
      { name: 'inner', dataType: 'InnerStrc', offset: 0 },  // by value!
    ]);

    const organized = new Map<string, ExtractedFunction[]>();
    organized.set('Outer', [makeFunc('Outer_Init', 'Outer')]);
    organized.set('Inner', [makeFunc('Inner_Init', 'Inner')]);

    const unitHeaderPaths = new Map<string, string>();
    unitHeaderPaths.set('Outer', 'Outer/Outer.h');
    unitHeaderPaths.set('Inner', 'Inner/Inner.h');

    const typeOwnerMap = new Map<string, string>();
    typeOwnerMap.set('OuterStrc', 'Outer/Outer.h');
    typeOwnerMap.set('InnerStrc', 'Inner/Inner.h');

    const graph = buildModuleGraph({
      organized,
      classes: [],
      dataTypes: [innerStruct, outerStruct],
      globals: [],
      unitHeaderPaths,
      ownership: { typeOwnerMap, structsWithOwnUnit: new Set(), extraHeaderTypes: new Map() },
      options: defaultOptions,
      funcNameToHeaderPath: new Map(),
      platformHeaders: new Set(),
    });

    const resolved = graph.resolve();
    const outerModule = resolved.get('Outer/Outer.h')!;
    assert.ok(
      outerModule.headerIncludes.includes('Inner/Inner.h'),
      'Expected by-value dep in headerIncludes',
    );
  });

  it('function call deps go to implIncludes', () => {
    const funcA = makeFunc('FuncA', 'ModA');
    funcA.calledFunctions = ['FuncB'];
    const funcB = makeFunc('FuncB', 'ModB');

    const organized = new Map<string, ExtractedFunction[]>();
    organized.set('ModA', [funcA]);
    organized.set('ModB', [funcB]);

    const unitHeaderPaths = new Map<string, string>();
    unitHeaderPaths.set('ModA', 'A.h');
    unitHeaderPaths.set('ModB', 'B.h');

    const funcNameToHeaderPath = new Map<string, string>();
    funcNameToHeaderPath.set('FuncA', 'A.h');
    funcNameToHeaderPath.set('FuncB', 'B.h');

    const graph = buildModuleGraph({
      organized,
      classes: [],
      dataTypes: [],
      globals: [],
      unitHeaderPaths,
      ownership: { typeOwnerMap: new Map(), structsWithOwnUnit: new Set(), extraHeaderTypes: new Map() },
      options: defaultOptions,
      funcNameToHeaderPath,
      platformHeaders: new Set(),
    });

    const resolved = graph.resolve();
    const modA = resolved.get('A.h')!;
    assert.ok(modA.implIncludes.includes('B.h'), 'Expected call dep in implIncludes');
  });

  it('implicit modules are excluded from includes', () => {
    const funcA = makeFunc('FuncA', 'ModA', [{ name: 'type', dataType: 'MyEnum' }]);

    const organized = new Map<string, ExtractedFunction[]>();
    organized.set('ModA', [funcA]);

    const unitHeaderPaths = new Map<string, string>();
    unitHeaderPaths.set('ModA', 'A.h');

    const graph = buildModuleGraph({
      organized,
      classes: [],
      dataTypes: [],
      globals: [],
      unitHeaderPaths,
      ownership: { typeOwnerMap: new Map(), structsWithOwnUnit: new Set(), extraHeaderTypes: new Map() },
      options: defaultOptions,
      funcNameToHeaderPath: new Map(),
      platformHeaders: new Set(),
      sharedEnumTypes: new Set(['MyEnum']),
    });

    const resolved = graph.resolve();
    const modA = resolved.get('A.h')!;
    assert.strictEqual(modA.headerIncludes.length, 0);
    assert.strictEqual(modA.implIncludes.length, 0);
  });

  it('type-only headers are created for extra types', () => {
    const typeOnlyStruct = makeStruct('OrphanStrc', [
      { name: 'val', dataType: 'int', offset: 0 },
    ]);

    const organized = new Map<string, ExtractedFunction[]>();
    organized.set('ModA', [makeFunc('FuncA', 'ModA')]);

    const unitHeaderPaths = new Map<string, string>();
    unitHeaderPaths.set('ModA', 'A.h');

    const typeOwnerMap = new Map<string, string>();
    typeOwnerMap.set('OrphanStrc', 'orphan/OrphanStrc.h');

    const extraHeaderTypes = new Map<string, Set<string>>();
    extraHeaderTypes.set('orphan/OrphanStrc.h', new Set(['OrphanStrc']));

    const graph = buildModuleGraph({
      organized,
      classes: [],
      dataTypes: [typeOnlyStruct],
      globals: [],
      unitHeaderPaths,
      ownership: { typeOwnerMap, structsWithOwnUnit: new Set(), extraHeaderTypes },
      options: defaultOptions,
      funcNameToHeaderPath: new Map(),
      platformHeaders: new Set(),
    });

    assert.ok(graph.getModule('orphan/OrphanStrc.h'));
    assert.strictEqual(graph.findOwner('OrphanStrc'), 'orphan/OrphanStrc.h');
  });
});
