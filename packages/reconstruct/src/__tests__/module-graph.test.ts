/**
 * Tests for ModuleGraph: module creation, symbol registration,
 * dependency tracking, cycle detection, resolution.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ModuleGraph } from '../modules/graph.js';
import type { ResolvedModule } from '../modules/module.js';

function createTestGraph() {
  const g = new ModuleGraph();
  return g;
}

function makeModule(g: ModuleGraph, id: string, unitName: string) {
  return g.createModule({
    id,
    implPath: id.replace(/\.h$/, '.cpp'),
    unitName,
  });
}

describe('ModuleGraph', () => {
  describe('module creation', () => {
    it('creates a module with correct fields', () => {
      const g = createTestGraph();
      const mod = g.createModule({
        id: 'Util/Graph/Graph.h',
        implPath: 'Util/Graph/Graph.cpp',
        unitName: 'Util::Graph',
        namespace: 'Util::Graph',
        namespaceParts: ['Util', 'Graph'],
      });

      assert.strictEqual(mod.id, 'Util/Graph/Graph.h');
      assert.strictEqual(mod.implPath, 'Util/Graph/Graph.cpp');
      assert.strictEqual(mod.unitName, 'Util::Graph');
      assert.strictEqual(mod.namespace, 'Util::Graph');
      assert.deepStrictEqual(mod.namespaceParts, ['Util', 'Graph']);
      assert.deepStrictEqual(mod.exports, []);
      assert.deepStrictEqual(mod.deps, []);
    });

    it('returns existing module if id already exists', () => {
      const g = createTestGraph();
      const mod1 = makeModule(g, 'A.h', 'A');
      const mod2 = g.createModule({ id: 'A.h', implPath: 'A.cpp', unitName: 'A' });
      assert.strictEqual(mod1, mod2);
    });

    it('tracks module count', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      makeModule(g, 'B.h', 'B');
      assert.strictEqual(g.getModuleCount(), 2);
    });

    it('derives namespace parts from namespace when not provided', () => {
      const g = createTestGraph();
      const mod = g.createModule({
        id: 'test.h',
        implPath: 'test.cpp',
        unitName: 'Foo::Bar::Baz',
        namespace: 'Foo::Bar::Baz',
      });
      assert.deepStrictEqual(mod.namespaceParts, ['Foo', 'Bar', 'Baz']);
    });
  });

  describe('symbol registration', () => {
    it('registers and finds exported symbols', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      g.exportSymbol('A.h', 'GraphNodeT', 'struct');

      assert.strictEqual(g.findOwner('GraphNodeT'), 'A.h');
    });

    it('first exporter wins symbol ownership', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      makeModule(g, 'B.h', 'B');
      g.exportSymbol('A.h', 'SharedType', 'struct');
      g.exportSymbol('B.h', 'SharedType', 'struct');

      assert.strictEqual(g.findOwner('SharedType'), 'A.h');
    });

    it('internal symbols are not indexed', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      g.exportSymbol('A.h', 'InternalHelper', 'function', 'internal');

      assert.strictEqual(g.findOwner('InternalHelper'), undefined);
    });

    it('throws on unknown module', () => {
      const g = createTestGraph();
      assert.throws(
        () => g.exportSymbol('missing.h', 'Foo', 'struct'),
        /Module missing.h not found/,
      );
    });

    it('stores ifdef on symbol', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      g.exportSymbol('A.h', 'AltFunc', 'function', 'export', 'PLATFORM_ALT');

      const mod = g.getModule('A.h')!;
      assert.strictEqual(mod.exports[0].ifdef, 'PLATFORM_ALT');
    });
  });

  describe('dependency tracking', () => {
    it('records dependencies on a module', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      makeModule(g, 'B.h', 'B');
      g.exportSymbol('B.h', 'SomeStrc', 'struct');
      g.addDependency('A.h', 'SomeStrc', 'by-value');

      const mod = g.getModule('A.h')!;
      assert.strictEqual(mod.deps.length, 1);
      assert.strictEqual(mod.deps[0].symbol, 'SomeStrc');
      assert.strictEqual(mod.deps[0].strength, 'by-value');
    });

    it('throws on dep from unknown module', () => {
      const g = createTestGraph();
      assert.throws(
        () => g.addDependency('missing.h', 'Foo', 'call'),
        /Module missing.h not found/,
      );
    });
  });

  describe('implicit modules', () => {
    it('implicit modules are stripped from includes', () => {
      const g = createTestGraph();
      makeModule(g, 'platform.h', '_platform');
      makeModule(g, 'A.h', 'A');
      g.exportSymbol('platform.h', 'BOOL', 'typedef');
      g.markImplicit('platform.h');
      g.addDependency('A.h', 'BOOL', 'by-value');

      const resolved = g.resolve();
      const a = resolved.get('A.h')!;
      assert.strictEqual(a.headerIncludes.length, 0);
      assert.strictEqual(a.implIncludes.length, 0);
    });

    it('registerGlobalSymbol populates index without export', () => {
      const g = createTestGraph();
      makeModule(g, 'enums.h', '_enums');
      g.markImplicit('enums.h');
      g.registerGlobalSymbol('UNIT_PLAYER', 'enums.h');

      assert.strictEqual(g.findOwner('UNIT_PLAYER'), 'enums.h');
      const mod = g.getModule('enums.h')!;
      assert.strictEqual(mod.exports.length, 0);
    });
  });

  describe('resolve()', () => {
    it('by-value deps go to headerIncludes', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      makeModule(g, 'B.h', 'B');
      g.exportSymbol('B.h', 'TypeB', 'struct');
      g.addDependency('A.h', 'TypeB', 'by-value');

      const resolved = g.resolve();
      const a = resolved.get('A.h')!;
      assert.deepStrictEqual(a.headerIncludes, ['B.h']);
      assert.deepStrictEqual(a.implIncludes, []);
    });

    /**
     * CHANGED: this used to assert `by-pointer` -> headerIncludes. It does not,
     * and must not: a `TypeB *` field or parameter needs only `struct TypeB;`,
     * which the header emitter emits itself (collectForwardDeclarations,
     * header.ts:157 - every generated header carries a `// Forward declarations`
     * block). Promoting by-pointer deps to full header includes was measured on
     * the real tree via `run.ts --codegen-only`: 20051 -> 28563 mingw
     * -fsyntax-only errors over the same 400 .cpp, because the extra includes
     * drag in transitively conflicting definitions. So by-pointer belongs in
     * implIncludes and the expectation, not the code, was wrong.
     */
    it('by-pointer deps go to implIncludes, not headerIncludes', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      makeModule(g, 'B.h', 'B');
      g.exportSymbol('B.h', 'TypeB', 'struct');
      g.addDependency('A.h', 'TypeB', 'by-pointer');

      const resolved = g.resolve();
      const a = resolved.get('A.h')!;
      assert.deepStrictEqual(a.headerIncludes, []);
      assert.deepStrictEqual(a.implIncludes, ['B.h']);
    });

    it('call deps go to implIncludes', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      makeModule(g, 'B.h', 'B');
      g.exportSymbol('B.h', 'SomeFunc', 'function');
      g.addDependency('A.h', 'SomeFunc', 'call');

      const resolved = g.resolve();
      const a = resolved.get('A.h')!;
      assert.deepStrictEqual(a.implIncludes, ['B.h']);
    });

    it('self-deps are excluded', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      g.exportSymbol('A.h', 'TypeA', 'struct');
      g.addDependency('A.h', 'TypeA', 'by-value');

      const resolved = g.resolve();
      const a = resolved.get('A.h')!;
      assert.deepStrictEqual(a.headerIncludes, []);
    });

    it('unknown symbol deps are ignored', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      g.addDependency('A.h', 'UnknownType', 'by-value');

      const resolved = g.resolve();
      const a = resolved.get('A.h')!;
      assert.deepStrictEqual(a.headerIncludes, []);
    });

    it('header includes subsume impl includes', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      makeModule(g, 'B.h', 'B');
      g.exportSymbol('B.h', 'TypeB', 'struct');
      g.exportSymbol('B.h', 'FuncB', 'function');
      // Both by-value and call dep on B
      g.addDependency('A.h', 'TypeB', 'by-value');
      g.addDependency('A.h', 'FuncB', 'call');

      const resolved = g.resolve();
      const a = resolved.get('A.h')!;
      assert.deepStrictEqual(a.headerIncludes, ['B.h']);
      assert.deepStrictEqual(a.implIncludes, []);
    });

    it('includes are sorted', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      makeModule(g, 'Z.h', 'Z');
      makeModule(g, 'M.h', 'M');
      g.exportSymbol('Z.h', 'TypeZ', 'struct');
      g.exportSymbol('M.h', 'TypeM', 'struct');
      g.addDependency('A.h', 'TypeZ', 'by-value');
      g.addDependency('A.h', 'TypeM', 'by-value');

      const resolved = g.resolve();
      const a = resolved.get('A.h')!;
      assert.deepStrictEqual(a.headerIncludes, ['M.h', 'Z.h']);
    });
  });

  describe('cycle detection', () => {
    it('no cycles in acyclic graph', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      makeModule(g, 'B.h', 'B');
      g.exportSymbol('B.h', 'TypeB', 'struct');
      g.addDependency('A.h', 'TypeB', 'by-value');

      const cycles = g.findCycles();
      assert.strictEqual(cycles.length, 0);
    });

    it('detects simple cycle A→B→A', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      makeModule(g, 'B.h', 'B');
      g.exportSymbol('A.h', 'TypeA', 'struct');
      g.exportSymbol('B.h', 'TypeB', 'struct');
      g.addDependency('A.h', 'TypeB', 'by-value');
      g.addDependency('B.h', 'TypeA', 'by-value');

      const cycles = g.findCycles();
      assert.strictEqual(cycles.length, 1);
      assert.strictEqual(cycles[0].length, 2);
    });

    it('resolve() breaks cycles with forward decls', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      makeModule(g, 'B.h', 'B');
      g.exportSymbol('A.h', 'TypeA', 'struct');
      g.exportSymbol('B.h', 'TypeB', 'struct');
      g.addDependency('A.h', 'TypeB', 'by-value');
      g.addDependency('B.h', 'TypeA', 'by-value');

      const resolved = g.resolve();
      // One of them should have a forward decl instead of header include
      const a = resolved.get('A.h')!;
      const b = resolved.get('B.h')!;

      // At least one should have forward decls
      const totalForwardDecls = a.forwardDecls.length + b.forwardDecls.length;
      assert.ok(totalForwardDecls > 0, 'Expected at least one forward declaration to break cycle');

      // The broken edge should move from headerIncludes to implIncludes
      const totalHeaderIncludes = a.headerIncludes.length + b.headerIncludes.length;
      assert.ok(totalHeaderIncludes < 2, 'Expected cycle to be broken — should have < 2 mutual header includes');
    });

    /**
     * CHANGED: this used to assert that mutual by-pointer deps form a cycle
     * resolve() has to break. They do not - that only followed from the
     * (wrong, see above) premise that by-pointer deps are header-level. Because
     * pointer deps stay out of the header, mutual pointer references need no
     * cycle-breaking at all: each header forward-declares the other's type and
     * includes it only from the .cpp. Asserting a cycle here was asserting that
     * the graph manufactures a problem it then has to undo.
     */
    it('mutual pointer deps form no header cycle to break', () => {
      const g = createTestGraph();
      makeModule(g, 'A.h', 'A');
      makeModule(g, 'B.h', 'B');
      g.exportSymbol('A.h', 'TypeA', 'struct');
      g.exportSymbol('B.h', 'TypeB', 'struct');
      g.addDependency('A.h', 'TypeB', 'by-pointer');
      g.addDependency('B.h', 'TypeA', 'by-pointer');

      assert.deepStrictEqual(g.findCycles(), []);

      const resolved = g.resolve();
      const a = resolved.get('A.h')!;
      const b = resolved.get('B.h')!;
      assert.deepStrictEqual(a.headerIncludes, []);
      assert.deepStrictEqual(b.headerIncludes, []);
      assert.deepStrictEqual(a.implIncludes, ['B.h']);
      assert.deepStrictEqual(b.implIncludes, ['A.h']);
      // Nothing to break, so nothing is broken.
      assert.deepStrictEqual(a.forwardDecls, []);
      assert.deepStrictEqual(b.forwardDecls, []);
    });
  });

  describe('platform headers', () => {
    it('non-platform module skips platform-only includes', () => {
      const g = createTestGraph();
      const macMod = g.createModule({
        id: 'Alt/Foo.h',
        implPath: 'Mac/Foo.cpp',
        unitName: 'Mac::Foo',
        isPlatformOnly: true,
      });
      makeModule(g, 'Win/Bar.h', 'Win::Bar');
      g.exportSymbol('Alt/Foo.h', 'AltFunc', 'function', 'export', 'PLATFORM_ALT');

      // Win::Bar calling AltFunc — should still resolve the dep
      g.addDependency('Win/Bar.h', 'AltFunc', 'call');

      const resolved = g.resolve();
      const bar = resolved.get('Win/Bar.h')!;
      assert.deepStrictEqual(bar.implIncludes, ['Alt/Foo.h']);
    });
  });
});
