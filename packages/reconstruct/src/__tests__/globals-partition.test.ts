/**
 * Which globals translation unit a definition lands in.
 *
 * `globals.cpp` was one unit for the whole binary, and its initializers name
 * every module's functions, so linking one data symbol linked the entire
 * program. The split gives each module its own unit; the contract these tests
 * hold is that it can only ever MOVE a definition:
 *
 *   - a global two modules read, or one whose table points at another module's
 *     function, or one whose reader cannot be placed, stays shared;
 *   - every input global comes out in exactly one partition or in `shared`.
 *
 * That last one is the property duplicate definitions would violate, and a
 * duplicate definition is a link error the syntax-only sweep never shows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  partitionGlobalsByModule, buildFunctionModuleMap,
} from '../codegen/globals-partition.js';
import type { AnalyzedDataSymbol, ExtractedFunction } from '../types.js';

const fn = (namespace: string, name: string): ExtractedFunction =>
  ({ name, namespace, address: '0', signature: '', returnType: 'void', parameters: [] }) as unknown as ExtractedFunction;

const g = (name: string, extra: Partial<AnalyzedDataSymbol> = {}): AnalyzedDataSymbol =>
  ({ name, address: '0', dataType: 'int', size: 4, scope: 'global', ...extra }) as unknown as AnalyzedDataSymbol;

const FUNCTIONS = [
  fn('D2Common::Drlg::Drlg', 'DRLG_Generate'),
  fn('D2Common::Drlg::Drlg', 'DRLG_Free'),
  fn('D2Game::MISSILES', 'MISSILE_Fire'),
  fn('D2Client::UI', 'UI_Draw'),
];
const MODULES = buildFunctionModuleMap(FUNCTIONS);

const placed = (r: ReturnType<typeof partitionGlobalsByModule>, name: string) =>
  r.partitions.find(p => p.members.some(m => m.name === name))?.module;

describe('partitionGlobalsByModule', () => {
  it('places a global every reader of which is in one module', () => {
    const r = partitionGlobalsByModule(
      [g('gDrlgSeed', { referencingFunctions: ['D2Common::Drlg::Drlg::DRLG_Generate', 'D2Common::Drlg::Drlg::DRLG_Free'] })],
      MODULES);
    assert.strictEqual(placed(r, 'gDrlgSeed'), 'D2Common');
    assert.strictEqual(r.shared.length, 0);
  });

  it('leaves a global two modules read in the shared unit', () => {
    const r = partitionGlobalsByModule(
      [g('gUnitTable', { referencingFunctions: ['D2Common::Drlg::Drlg::DRLG_Generate', 'D2Game::MISSILES::MISSILE_Fire'] })],
      MODULES);
    assert.deepStrictEqual(r.partitions, []);
    assert.strictEqual(r.shared.length, 1);
  });

  // The whole point: a table filed under D2Common that names a D2Game function
  // would make D2Common's unit drag D2Game, which is the disease being cured.
  it('leaves a global whose table points outside its readers module shared', () => {
    const r = partitionGlobalsByModule(
      [g('gDispatch', {
        referencingFunctions: ['D2Common::Drlg::Drlg::DRLG_Generate'],
        initializedData: {
          kind: 'array', value: null, fields: null,
          elements: [{ kind: 'pointer', value: 'D2Game::MISSILES::MISSILE_Fire', elements: null, fields: null }],
        },
      } as Partial<AnalyzedDataSymbol>)],
      MODULES);
    assert.deepStrictEqual(r.partitions, []);
    assert.strictEqual(r.shared.length, 1);
  });

  // A vtable reached only through another table has no reader at all; its own
  // pointer targets are then the only evidence there is.
  it('places a reader-less global by its pointer targets alone', () => {
    const r = partitionGlobalsByModule(
      [g('gVtable', {
        referencingFunctions: [],
        initializedData: {
          kind: 'array', value: null, fields: null,
          elements: [{ kind: 'pointer', value: 'D2Client::UI::UI_Draw', elements: null, fields: null }],
        },
      } as Partial<AnalyzedDataSymbol>)],
      MODULES);
    assert.strictEqual(placed(r, 'gVtable'), 'D2Client');
  });

  it('leaves a global with no evidence at all shared', () => {
    const r = partitionGlobalsByModule([g('gLonely', { referencingFunctions: [] })], MODULES);
    assert.strictEqual(r.shared.length, 1);
  });

  // An excluded-namespace caller (compiler::, VisualStudio::) is not in the map.
  // Guessing past it would file the global under the module that happens to be
  // its other reader.
  it('leaves a global with an unplaceable reader shared', () => {
    const r = partitionGlobalsByModule(
      [g('gCrt', { referencingFunctions: ['D2Common::Drlg::Drlg::DRLG_Generate', 'compiler::_initterm'] })],
      MODULES);
    assert.strictEqual(r.shared.length, 1);
  });

  // A pointer target that is a label or another datum says nothing about the
  // module; treating it as a disqualification would empty every partition.
  it('ignores a pointer target that is not a function', () => {
    const r = partitionGlobalsByModule(
      [g('gJump', {
        referencingFunctions: ['D2Common::Drlg::Drlg::DRLG_Generate'],
        initializedData: {
          kind: 'array', value: null, fields: null,
          elements: [{ kind: 'pointer', value: 'LAB_0057ee08', elements: null, fields: null }],
        },
      } as Partial<AnalyzedDataSymbol>)],
      MODULES);
    assert.strictEqual(placed(r, 'gJump'), 'D2Common');
  });

  it('puts every input in exactly one place', () => {
    const input = [
      g('a', { referencingFunctions: ['D2Common::Drlg::Drlg::DRLG_Generate'] }),
      g('b', { referencingFunctions: ['D2Game::MISSILES::MISSILE_Fire'] }),
      g('c', { referencingFunctions: ['D2Common::Drlg::Drlg::DRLG_Generate', 'D2Client::UI::UI_Draw'] }),
      g('d', { referencingFunctions: [] }),
    ];
    const r = partitionGlobalsByModule(input, MODULES);
    const seen = [...r.partitions.flatMap(p => p.members), ...r.shared].map(x => x.name).sort();
    assert.deepStrictEqual(seen, ['a', 'b', 'c', 'd']);
  });
});

describe('buildFunctionModuleMap', () => {
  it('keys a function by both its qualified and its bare name', () => {
    assert.strictEqual(MODULES.get('D2Common::Drlg::Drlg::DRLG_Generate'), 'D2Common');
    assert.strictEqual(MODULES.get('DRLG_Generate'), 'D2Common');
  });

  // A bare name two modules both declare cannot place anything, and guessing
  // would file a global under whichever module was extracted first.
  it('drops a bare name two modules both declare, keeping the qualified ones', () => {
    const m = buildFunctionModuleMap([fn('D2Common::X', 'Init'), fn('D2Game::Y', 'Init')]);
    assert.strictEqual(m.get('Init'), undefined);
    assert.strictEqual(m.get('D2Common::X::Init'), 'D2Common');
    assert.strictEqual(m.get('D2Game::Y::Init'), 'D2Game');
  });

  it('ignores a function with no namespace', () => {
    const m = buildFunctionModuleMap([fn('', 'Bare')]);
    assert.strictEqual(m.get('Bare'), undefined);
  });
});
