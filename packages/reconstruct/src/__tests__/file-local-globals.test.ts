/**
 * A global that only one translation unit uses moves into that unit as `static`,
 * but only together with the rest of its data run, and never when hand-written
 * source beside the tree names it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  dataRuns,
  keepDataRunsWhole,
  keepForeignReferencedGlobalsExternal,
  fileLocalGlobalKey,
} from '../codegen/file-local-globals.js';
import { generateGlobalsHeader } from '../codegen/globals-header.js';
import { unitStaticKeys, unitStaticsHold } from '../codegen/index.js';
import type { AnalyzedDataSymbol, ReconstructOptions } from '../types.js';

function sym(name: string, address: string, o: Partial<AnalyzedDataSymbol> = {}): AnalyzedDataSymbol {
  return {
    name, address, dataType: 'int', suggestedType: 'int', size: 4, isInitialized: false,
    xrefCount: 1, scope: 'global', ...o,
  } as AnalyzedDataSymbol;
}
const local = (name: string, address: string, file: string, fns: string[]): AnalyzedDataSymbol =>
  sym(name, address, { scope: 'file-local', ownerFile: file, referencingFunctions: fns });

const implOf = new Map([
  ['a1', 'A.cpp'], ['a2', 'A.cpp'], ['b1', 'B.cpp'],
]);

describe('data runs', () => {
  it('cuts the address order into one run per TU, a homeless symbol joining the run around it', () => {
    const gs = [
      local('x', '00700008', 'A.cpp', ['a1', 'a2']),
      local('w', '00700000', 'A.cpp', ['a1', 'a2']),
      sym('orphanData', '0070000c'),                    // no code users, between two A members
      local('y', '00700010', 'A.cpp', ['a1', 'a2']),
      local('z', '00700020', 'B.cpp', ['b1']),
    ];
    const runs = dataRuns(gs, implOf);
    assert.deepStrictEqual(runs.map(r => [r.unit, r.members.map(m => m.name)]), [
      ['A.cpp', ['w', 'x', 'orphanData', 'y']],
      ['B.cpp', ['z']],
    ]);
  });

  it('moves a run whose every member lives in its TU', () => {
    const gs = [
      local('w', '00700000', 'A.cpp', ['a1', 'a2']),
      sym('fnLocal', '00700004', { scope: 'static-local', ownerFunction: 'a1', referencingFunctions: ['a1'] }),
      local('x', '00700008', 'A.cpp', ['a1', 'a2']),
    ];
    assert.strictEqual(keepDataRunsWhole(gs, implOf), 0);
    assert.deepStrictEqual(gs.map(g => g.scope), ['file-local', 'static-local', 'file-local']);
  });

  it('keeps the whole run external when one member is used by another TU', () => {
    const gs = [
      local('w', '00700000', 'A.cpp', ['a1', 'a2']),
      sym('shared', '00700004', { referencingFunctions: ['a1', 'b1'] }),
      local('x', '00700008', 'A.cpp', ['a1', 'a2']),
      local('z', '00700020', 'B.cpp', ['b1']),
    ];
    assert.strictEqual(keepDataRunsWhole(gs, implOf), 2);
    assert.deepStrictEqual(gs.map(g => g.scope), ['global', 'global', 'global', 'file-local']);
    assert.strictEqual(gs[0].ownerFile, undefined);
  });

  it('keeps the whole run external when a member nothing in code uses sits inside it', () => {
    const gs = [
      local('w', '00700000', 'A.cpp', ['a1', 'a2']),
      sym('dataOnly', '00700004'),
      local('x', '00700008', 'A.cpp', ['a1', 'a2']),
    ];
    assert.strictEqual(keepDataRunsWhole(gs, implOf), 2);
  });

  it('a run boundary is not inside a run: neighbours of another TU do not block', () => {
    const gs = [
      local('w', '00700000', 'A.cpp', ['a1', 'a2']),
      sym('between', '00700004'),                       // A on one side, B on the other
      local('z', '00700008', 'B.cpp', ['b1']),
    ];
    assert.strictEqual(keepDataRunsWhole(gs, implOf), 0);
  });
});

describe('foreign source', () => {
  it('keeps a file-local external when foreign source names it, or an address inside it', () => {
    const named = local('gnNamed', '00700000', 'A.cpp', ['a1', 'a2']);
    const byAddress = sym('gaTable', '00700100', { scope: 'file-local', ownerFile: 'A.cpp', size: 0x40, referencingFunctions: ['a1', 'a2'] });
    const byLabel = local('gnLabelled', '00700200', 'A.cpp', ['a1', 'a2']);
    const untouched = local('gnQuiet', '00700300', 'A.cpp', ['a1', 'a2']);
    const n = keepForeignReferencedGlobalsExternal([named, byAddress, byLabel, untouched], [
      { path: 'support/x.cpp', text: 'extern int gnNamed; void f() { gnNamed = 1; DAT_00700200 = 2; }' },
      { path: 'd2bsng/imports.h', text: 'constexpr int kTable = 0x300110;', addressBase: 0x400000 },
    ]);
    assert.strictEqual(n, 3);
    assert.deepStrictEqual([named, byAddress, byLabel, untouched].map(g => g.scope), ['global', 'global', 'global', 'file-local']);
  });
});

describe('the unit records its file-local globals', () => {
  it('keys them by address', () => {
    assert.strictEqual(fileLocalGlobalKey({ address: '0074d87c' }), 'G:0074d87c');
    assert.strictEqual(fileLocalGlobalKey({ address: 'ram:0x74D87C' }), 'G:0074d87c');
  });
});

describe('globals.h', () => {
  it('declares no fallback extern for a file-local several bodies of its file name', () => {
    const g = local('g_szBuildNumber', '0074d87c', 'Fog/Src/ErrorManager.cpp', ['a1', 'a2']);
    const options = {
      outputDir: '/tmp/test', format: 'cpp', organization: 'namespace', generateCMake: false,
      generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false,
      promoteStaticGlobals: true,
    } as ReconstructOptions;
    const h = generateGlobalsHeader([g, sym('gnOther', '00700000')], options, [], new Map(), new Set(),
      new Map([['g_szBuildNumber', 2], ['gnOther', 2]]));
    assert.match(h, /extern int gnOther;/);
    assert.doesNotMatch(h, /g_szBuildNumber/);
  });
});

describe('a changed file-local set re-emits the unit', () => {
  const fns = [{ address: '00401000' }];
  const none = new Set<string>();
  it('records the file-locals beside the function statics, sorted', () => {
    const keys = unitStaticKeys(fns, none, none, [{ address: '0074d880' }, { address: '0074d87c' }]);
    assert.deepStrictEqual(keys, ['G:0074d87c', 'G:0074d880']);
  });
  it('does not reuse text when another TU starts naming one of them', () => {
    const before = unitStaticKeys(fns, none, none, [{ address: '0074d87c' }, { address: '0074d880' }]);
    const after = unitStaticKeys(fns, none, none, [{ address: '0074d87c' }]);
    assert.strictEqual(unitStaticsHold(before, after), false);
    assert.strictEqual(unitStaticsHold(after, before), false);
    assert.strictEqual(unitStaticsHold(before, [...before]), true);
  });
});
