/**
 * A global several TUs use is defined in its home TU (the TU its data run belongs
 * to) and declared in that TU's data header, which only the TUs naming it include.
 * A retype re-emits the home, which defines it; the data header is rewritten with
 * the aggregates, and only when its bytes change (data-homes.test.ts), so the build
 * recompiles exactly its includers. A reader is re-emitted only when its own text
 * moved - the daemon re-decompiles every reader of a changed datum. No other unit
 * is touched. The selection reads the home from the module graph the generator
 * serializes, so the graph here is built by the generator's own builder.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { selectDirtyUnits, computeHashCache } from '../dirty-units.js';
import { buildModuleGraph } from '@ghidra-mcp/reconstruct/modules/builder';
import type { AnalyzedDataSymbol, ExtractedFunction, ReconstructOptions } from '@ghidra-mcp/reconstruct';

const fn = (address: string, name: string, namespace: string, body: string): ExtractedFunction =>
  ({
    address, name, namespace, signature: `void ${name}(void)`, returnType: 'void', parameters: [],
    localVariables: [], callingConvention: '__cdecl', size: 1, isThunk: false, isExternal: false,
    hasVarArgs: false, calledFunctions: [], decompiled: body,
  } as unknown as ExtractedFunction);

const functions = [
  fn('00500000', 'ITEMS_Init', 'D2Common::Items', 'void ITEMS_Init(void) { gnItemCount = 0; }'),
  fn('00500100', 'INV_Draw', 'D2Client::Inv', 'void INV_Draw(void) { Draw(gnItemCount); }'),
  fn('00500200', 'SKILLS_Run', 'D2Game::Skills', 'void SKILLS_Run(void) { Run(); }'),
];

const homed = (dataType: string): AnalyzedDataSymbol => ({
  name: 'gnItemCount', address: '0074d87c', dataType, suggestedType: dataType, size: 4,
  isInitialized: false, scope: 'global', homeFile: 'D2Common/Items.cpp',
  referencingFunctions: ['ITEMS_Init', 'INV_Draw'],
} as unknown as AnalyzedDataSymbol);

const options = {
  outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'quick', includeAddressComments: false,
  promoteStaticGlobals: true,
} as ReconstructOptions;

function buildInfoFor(global: AnalyzedDataSymbol) {
  const graph = buildModuleGraph({
    organized: new Map([
      ['D2Common::Items', [functions[0]]],
      ['D2Client::Inv', [functions[1]]],
      ['D2Game::Skills', [functions[2]]],
    ]),
    classes: [], dataTypes: [], globals: [global],
    unitHeaderPaths: new Map([
      ['D2Common::Items', 'D2Common/Items.h'],
      ['D2Client::Inv', 'D2Client/Inv.h'],
      ['D2Game::Skills', 'D2Game/Skills.h'],
    ]),
    ownership: { typeOwnerMap: new Map(), structsWithOwnUnit: new Set(), extraHeaderTypes: new Map() },
    options, funcNameToHeaderPath: new Map(), platformHeaders: new Set(),
  });
  return graph.serialize(graph.resolve(), { x: 'x' }, 'test');
}

test('a retyped homed global re-emits its home, nothing else', () => {
  const before = homed('int');
  const buildInfo = buildInfoFor(before);
  const previous = computeHashCache({ functions, dataTypes: [], globals: [before] });
  const r = selectDirtyUnits({
    buildInfo, previous, identCacheEmpty: false, functions, dataTypes: [], globals: [homed('float')],
  });
  assert.deepStrictEqual(r.units, ['D2Common::Items']);
});

test('a reader whose re-decompiled text moved with the retype is re-emitted too, and no third unit', () => {
  const before = homed('int');
  const buildInfo = buildInfoFor(before);
  const previous = computeHashCache({ functions, dataTypes: [], globals: [before] });
  const now = functions.map(f => f.name === 'INV_Draw'
    ? { ...f, decompiled: 'void INV_Draw(void) { Draw((int)gnItemCount); }' } as ExtractedFunction : f);
  const r = selectDirtyUnits({
    buildInfo, previous, identCacheEmpty: false, functions: now, dataTypes: [], globals: [homed('float')],
  });
  assert.deepStrictEqual(r.units, ['D2Client::Inv', 'D2Common::Items']);
});

test('an unchanged homed global re-emits nothing', () => {
  const g = homed('int');
  const previous = computeHashCache({ functions, dataTypes: [], globals: [g] });
  const r = selectDirtyUnits({
    buildInfo: buildInfoFor(g), previous, identCacheEmpty: false, functions, dataTypes: [], globals: [homed('int')],
  });
  assert.deepStrictEqual(r.units, []);
});
