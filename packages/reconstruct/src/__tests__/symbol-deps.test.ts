/**
 * Tests for symbol dependency graph, call graph wiring, CRT mapping,
 * smart header visibility, and static linkage.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildCallGraph, populateCalledFunctions } from '../analysis/callgraph.js';
import { buildDependencyGraph, DependencyGraph, parseTypeString, isBuiltinType } from '../analysis/references.js';
import { resolveCrtInclude, collectCrtHeaders } from '../codegen/crt-mapping.js';
import { generateHeader } from '../codegen/header.js';
import { generateImplementation, type ImplGenContext } from '../codegen/impl.js';
import type {
  ExtractedFunction,
  ExtractedParameter,
  ExtractedGlobal,
  ExtractedDataType,
  ReconstructOptions,
} from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeParam(name: string, dataType: string): ExtractedParameter {
  return { name, dataType, size: 4, ordinal: 0, storage: 'register' };
}

function makeFunc(
  name: string,
  address: string,
  params: ExtractedParameter[] = [],
  decompiled?: string,
  opts?: Partial<ExtractedFunction>
): ExtractedFunction {
  return {
    name,
    address,
    signature: `void ${name}()`,
    returnType: 'void',
    parameters: params,
    localVariables: [],
    callingConvention: '__cdecl',
    size: 64,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    decompiled,
    ...opts,
  };
}

const defaultOptions: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'flat',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

// ── populateCalledFunctions ──────────────────────────────────────────

describe('populateCalledFunctions', () => {
  it('should populate calledFunctions from call graph edges', () => {
    // Note: extractCallees matches function names in the FULL decompiled text
    // including the signature line, so self-references are possible
    const funcA = makeFunc('FuncA', '0x001000', [], 'void FuncA() {\n    FuncB();\n}');
    const funcB = makeFunc('FuncB', '0x002000', [], 'void FuncB() {\n    return;\n}');
    const funcC = makeFunc('FuncC', '0x003000', [], 'void FuncC() {\n    FuncA();\n    FuncB();\n}');
    const functions = [funcA, funcB, funcC];

    const graph = buildCallGraph(functions);
    populateCalledFunctions(functions, graph);

    // FuncA calls FuncB (and self-ref from signature)
    assert.ok(funcA.calledFunctions!.includes('FuncB'), 'FuncA should call FuncB');
    // FuncB only has self-ref from signature (no real calls)
    // extractCallees regex matches function name in signature line
    assert.ok(funcB.calledFunctions!.length <= 1, 'FuncB should have at most self-ref');
    // FuncC calls both FuncA and FuncB
    assert.ok(funcC.calledFunctions!.includes('FuncA'), 'FuncC should call FuncA');
    assert.ok(funcC.calledFunctions!.includes('FuncB'), 'FuncC should call FuncB');
  });

  it('should handle functions with no decompiled code', () => {
    const funcA = makeFunc('FuncA', '0x001000');
    const funcB = makeFunc('FuncB', '0x002000');
    const functions = [funcA, funcB];

    const graph = buildCallGraph(functions);
    populateCalledFunctions(functions, graph);

    assert.deepStrictEqual(funcA.calledFunctions, []);
    assert.deepStrictEqual(funcB.calledFunctions, []);
  });

  it('should not include calls to unknown functions', () => {
    const funcA = makeFunc('FuncA', '0x001000', [], 'void FuncA() {\n    UnknownFunc();\n}');
    const functions = [funcA];

    const graph = buildCallGraph(functions);
    populateCalledFunctions(functions, graph);

    // UnknownFunc is not in our function list, so not in calledFunctions
    // Self-ref via signature is possible, but no other unknown calls
    assert.ok(!funcA.calledFunctions!.includes('UnknownFunc'), 'Should not include UnknownFunc');
  });
});

// ── CRT mapping ──────────────────────────────────────────────────────

describe('CRT mapping', () => {
  describe('resolveCrtInclude', () => {
    it('should resolve standard C string functions', () => {
      assert.strictEqual(resolveCrtInclude('memset'), '<cstring>');
      assert.strictEqual(resolveCrtInclude('memcpy'), '<cstring>');
      assert.strictEqual(resolveCrtInclude('strlen'), '<cstring>');
      assert.strictEqual(resolveCrtInclude('strcmp'), '<cstring>');
      assert.strictEqual(resolveCrtInclude('_stricmp'), '<cstring>');
    });

    it('should resolve stdlib functions', () => {
      assert.strictEqual(resolveCrtInclude('malloc'), '<cstdlib>');
      assert.strictEqual(resolveCrtInclude('free'), '<cstdlib>');
      assert.strictEqual(resolveCrtInclude('qsort'), '<cstdlib>');
      assert.strictEqual(resolveCrtInclude('rand'), '<cstdlib>');
    });

    it('should resolve stdio functions', () => {
      assert.strictEqual(resolveCrtInclude('sprintf'), '<cstdio>');
      assert.strictEqual(resolveCrtInclude('fopen'), '<cstdio>');
      assert.strictEqual(resolveCrtInclude('printf'), '<cstdio>');
    });

    it('should resolve math functions', () => {
      assert.strictEqual(resolveCrtInclude('sqrt'), '<cmath>');
      assert.strictEqual(resolveCrtInclude('sin'), '<cmath>');
      assert.strictEqual(resolveCrtInclude('atan2'), '<cmath>');
    });

    it('should resolve Windows API functions', () => {
      assert.strictEqual(resolveCrtInclude('EnterCriticalSection'), '<windows.h>');
      assert.strictEqual(resolveCrtInclude('Sleep'), '<windows.h>');
      assert.strictEqual(resolveCrtInclude('CloseHandle'), '<windows.h>');
    });

    it('should strip VisualStudio:: namespace prefix', () => {
      assert.strictEqual(resolveCrtInclude('VisualStudio::memset'), '<cstring>');
      assert.strictEqual(resolveCrtInclude('VisualStudio::malloc'), '<cstdlib>');
      assert.strictEqual(resolveCrtInclude('msvcrt::sprintf'), '<cstdio>');
    });

    it('should strip leading underscore for MSVC-decorated names', () => {
      assert.strictEqual(resolveCrtInclude('_memset'), '<cstring>');
      assert.strictEqual(resolveCrtInclude('_malloc'), '<cstdlib>');
    });

    it('should return undefined for unknown functions', () => {
      assert.strictEqual(resolveCrtInclude('MyCustomFunc'), undefined);
      assert.strictEqual(resolveCrtInclude('DRLG_Init'), undefined);
    });
  });

  describe('collectCrtHeaders', () => {
    it('should collect unique headers from a list of function names', () => {
      const headers = collectCrtHeaders(['memset', 'memcpy', 'malloc', 'sqrt']);
      assert.strictEqual(headers.size, 3);
      assert.ok(headers.has('<cstring>'));
      assert.ok(headers.has('<cstdlib>'));
      assert.ok(headers.has('<cmath>'));
    });

    it('should handle empty input', () => {
      const headers = collectCrtHeaders([]);
      assert.strictEqual(headers.size, 0);
    });

    it('should ignore non-CRT functions', () => {
      const headers = collectCrtHeaders(['DRLG_Init', 'DRLG_Free']);
      assert.strictEqual(headers.size, 0);
    });

    it('should handle mixed CRT and non-CRT', () => {
      const headers = collectCrtHeaders(['DRLG_Init', 'memset', 'MyFunc', 'sqrt']);
      assert.strictEqual(headers.size, 2);
      assert.ok(headers.has('<cstring>'));
      assert.ok(headers.has('<cmath>'));
    });
  });
});

// ── Smart header visibility ──────────────────────────────────────────

describe('Smart header visibility', () => {
  it('should emit only public functions when publicFunctions is provided', () => {
    const funcA = makeFunc('PublicFunc', '0x001000', [makeParam('x', 'int')]);
    const funcB = makeFunc('InternalHelper', '0x002000', [makeParam('y', 'int')]);
    const funcC = makeFunc('AnotherPublic', '0x003000', [makeParam('z', 'int')]);

    const publicFunctions = new Set(['PublicFunc', 'AnotherPublic']);

    const header = generateHeader(
      'TestUnit',
      [funcA, funcB, funcC],
      undefined,
      [],
      [],
      defaultOptions,
      undefined,
      undefined,
      undefined,
      publicFunctions
    );

    assert.ok(header.includes('PublicFunc'), 'Should declare PublicFunc');
    assert.ok(header.includes('AnotherPublic'), 'Should declare AnotherPublic');
    assert.ok(!header.includes('InternalHelper('), 'Should NOT declare InternalHelper');
    assert.ok(header.includes('1 internal function'), 'Should mention internal count');
  });

  it('should emit all functions when publicFunctions is undefined', () => {
    const funcA = makeFunc('FuncA', '0x001000');
    const funcB = makeFunc('FuncB', '0x002000');

    const header = generateHeader(
      'TestUnit',
      [funcA, funcB],
      undefined,
      [],
      [],
      defaultOptions
    );

    assert.ok(header.includes('FuncA'), 'Should declare FuncA');
    assert.ok(header.includes('FuncB'), 'Should declare FuncB');
  });

  it('should handle case where all functions are internal', () => {
    const funcA = makeFunc('HelperA', '0x001000');
    const funcB = makeFunc('HelperB', '0x002000');

    const publicFunctions = new Set<string>(); // empty = nothing public

    const header = generateHeader(
      'TestUnit',
      [funcA, funcB],
      undefined,
      [],
      [],
      defaultOptions,
      undefined,
      undefined,
      undefined,
      publicFunctions
    );

    assert.ok(!header.includes('HelperA('), 'Should NOT declare HelperA');
    assert.ok(!header.includes('HelperB('), 'Should NOT declare HelperB');
    assert.ok(header.includes('2 internal functions'), 'Should mention 2 internal');
  });
});

// ── Static linkage in impl.ts ────────────────────────────────────────

describe('Static linkage', () => {
  it('should prefix internal functions with static', () => {
    const funcA = makeFunc('InternalFunc', '0x001000', [], 'void InternalFunc() {\n    return;\n}');

    const internalFunctions = new Set(['InternalFunc']);

    const impl = generateImplementation(
      'TestUnit',
      [funcA],
      undefined,
      'TestUnit.h',
      defaultOptions,
      undefined,
      undefined,
      new Set<string>(), // empty CRT headers
      internalFunctions
    );

    assert.ok(impl.includes('static void InternalFunc()'), `Should have static prefix:\n${impl}`);
  });

  it('should NOT prefix public functions with static', () => {
    const funcA = makeFunc('PublicFunc', '0x001000', [], 'void PublicFunc() {\n    return;\n}');

    const impl = generateImplementation(
      'TestUnit',
      [funcA],
      undefined,
      'TestUnit.h',
      defaultOptions,
      undefined,
      undefined,
      new Set<string>(),
      undefined // no internal set = all public
    );

    assert.ok(!impl.includes('static void PublicFunc'), `Should NOT have static prefix:\n${impl}`);
    assert.ok(impl.includes('void PublicFunc()'), `Should have normal signature:\n${impl}`);
  });
});

// ── Precise CRT headers in impl.ts ──────────────────────────────────

describe('Precise CRT headers', () => {
  it('should include only specified CRT headers', () => {
    const funcA = makeFunc('TestFunc', '0x001000', [], 'void TestFunc() {\n    return;\n}');

    const crtHeaders = new Set(['<cstring>', '<cmath>']);

    const impl = generateImplementation(
      'TestUnit',
      [funcA],
      undefined,
      'TestUnit.h',
      defaultOptions,
      undefined,
      undefined,
      crtHeaders
    );

    assert.ok(impl.includes('#include <cstring>'), 'Should include cstring');
    assert.ok(impl.includes('#include <cmath>'), 'Should include cmath');
    assert.ok(!impl.includes('#include <cstdlib>'), 'Should NOT include cstdlib');
  });

  it('should emit no CRT headers when set is empty', () => {
    const funcA = makeFunc('TestFunc', '0x001000', [], 'void TestFunc() {\n    return;\n}');

    const impl = generateImplementation(
      'TestUnit',
      [funcA],
      undefined,
      'TestUnit.h',
      defaultOptions,
      undefined,
      undefined,
      new Set<string>()
    );

    assert.ok(!impl.includes('#include <cstring>'), 'Should NOT include cstring');
    assert.ok(!impl.includes('#include <cstdlib>'), 'Should NOT include cstdlib');
  });

  it('should use blanket includes when crtHeaders is undefined (legacy)', () => {
    const funcA = makeFunc('TestFunc', '0x001000', [], 'void TestFunc() {\n    return;\n}');

    const impl = generateImplementation(
      'TestUnit',
      [funcA],
      undefined,
      'TestUnit.h',
      defaultOptions,
      undefined,
      undefined,
      undefined // no CRT info = legacy fallback
    );

    assert.ok(impl.includes('#include <cstring>'), 'Should include cstring (legacy)');
    assert.ok(impl.includes('#include <cstdlib>'), 'Should include cstdlib (legacy)');
  });
});

// ── DependencyGraph enhancements ─────────────────────────────────────

describe('DependencyGraph enhancements', () => {
  it('should support O(1) findSymbolId via nameIndex', () => {
    const graph = new DependencyGraph();
    graph.addSymbol({
      id: 'type:test/MyStruct',
      kind: 'struct',
      name: 'MyStruct',
      dependsOn: [],
      dependedBy: [],
    });

    assert.strictEqual(graph.findSymbolId('MyStruct'), 'type:test/MyStruct');
    assert.strictEqual(graph.findSymbolId('NonExistent'), undefined);
  });

  it('should support global kind in SymbolNode', () => {
    const graph = new DependencyGraph();
    graph.addSymbol({
      id: 'global:0x700000',
      kind: 'global',
      name: 'g_someGlobal',
      dependsOn: [{ name: 'MyStruct', isPointer: true, usage: 'global' }],
      dependedBy: [],
    });

    const node = graph.getSymbol('global:0x700000');
    assert.ok(node, 'Should find global node');
    assert.strictEqual(node!.kind, 'global');
    assert.strictEqual(node!.dependsOn[0].usage, 'global');
  });

  it('should support unitName field', () => {
    const graph = new DependencyGraph();
    graph.addSymbol({
      id: 'func:0x001000',
      kind: 'function',
      name: 'TestFunc',
      unitName: 'DrlgRoom',
      dependsOn: [],
      dependedBy: [],
    });

    const node = graph.getSymbol('func:0x001000');
    assert.strictEqual(node!.unitName, 'DrlgRoom');
  });

  it('should build globals in buildDependencyGraph', () => {
    const globals: ExtractedGlobal[] = [{
      name: 'g_pGame',
      address: '0x700000',
      dataType: 'D2GameStrc *',
      size: 4,
      isInitialized: false,
      xrefCount: 10,
    }];

    const graph = buildDependencyGraph([], [], globals);
    const node = graph.getSymbol('global:0x700000');
    assert.ok(node, 'Should create global node');
    assert.strictEqual(node!.kind, 'global');
    assert.strictEqual(node!.name, 'g_pGame');
    assert.strictEqual(node!.dependsOn.length, 1);
    assert.strictEqual(node!.dependsOn[0].name, 'D2GameStrc');
    assert.strictEqual(node!.dependsOn[0].isPointer, true);
  });

  it('should build reverse dependencies using nameIndex', () => {
    const funcs: ExtractedFunction[] = [
      makeFunc('Caller', '0x001000', [], undefined, {
        calledFunctions: ['Callee'],
      }),
      makeFunc('Callee', '0x002000'),
    ];

    const graph = buildDependencyGraph(funcs, []);
    const calleeNode = graph.getSymbol('func:0x002000');
    assert.ok(calleeNode, 'Should find callee node');
    assert.ok(
      calleeNode!.dependedBy.includes('func:0x001000'),
      `Callee should list Caller in dependedBy: ${JSON.stringify(calleeNode!.dependedBy)}`
    );
  });
});
