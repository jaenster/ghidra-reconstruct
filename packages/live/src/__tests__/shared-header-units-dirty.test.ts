/**
 * The template header is shared by one member unit per instantiation and module
 * (`D2CMP/SRC/CelCmp/stpl_CELLIST.cpp`, `D2Client/GAME/stpl_SGAMEDATA.cpp`, ...), and
 * the module graph keys a module by its header. Only the first unit used to be
 * recorded, so a retyped member of any other unit dirtied no unit of its own: the
 * daemon reused stpl_CELLIST.cpp from v1977 while 006041b0 had been retyped at v1992.
 *
 * These go through the real graph builder and serializer, so the buildinfo the
 * selection reads is the one a generation writes.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { buildModuleGraph } from '@ghidra-mcp/reconstruct/modules/builder';
import { selectDirtyUnits, computeHashCache } from '../dirty-units.js';
import { predictUnits } from '../proposal.js';
import type { ExtractedFunction, ReconstructOptions } from '@ghidra-mcp/reconstruct';

const fn = (address: string, name: string, namespace: string, local = 'int'): ExtractedFunction =>
  ({
    address, name, namespace, signature: `void ${name}(void)`, returnType: 'void', parameters: [],
    localVariables: [{ name: 'pOldBlock', dataType: local }],
    decompiled: `void ${name}(void) {}`, calledFunctions: [],
  } as unknown as ExtractedFunction);

const HEADER = 'Storm/H/stpl.h';
const units = {
  'D2Client::GAME::stpl_SGAMEDATA': 'Source/D2Client/GAME/stpl_SGAMEDATA.cpp',
  'D2CMP::SRC::CelCmp::stpl_CELLIST': 'Source/D2CMP/SRC/CelCmp/stpl_CELLIST.cpp',
  'D2Common::Drlg::stpl_StringEntryNode': 'Source/D2Common/Drlg/stpl_StringEntryNode.cpp',
};

function buildInfoFor(functions: ExtractedFunction[]) {
  const organized = new Map<string, ExtractedFunction[]>([
    ['D2Client::GAME::stpl_SGAMEDATA', [functions[0]]],
    ['D2CMP::SRC::CelCmp::stpl_CELLIST', [functions[1]]],
    ['D2Common::Drlg::stpl_StringEntryNode', [functions[2]]],
    ['D2CMP::SRC::CelCmp::CelCmp', [functions[3]]],
  ]);
  const unitHeaderPaths = new Map<string, string>([
    ...Object.keys(units).map(u => [u, HEADER] as [string, string]),
    ['D2CMP::SRC::CelCmp::CelCmp', 'Source/D2CMP/SRC/CelCmp/CelCmp.h'],
  ]);
  const graph = buildModuleGraph({
    organized,
    classes: [],
    dataTypes: [],
    globals: [],
    unitHeaderPaths,
    ownership: { typeOwnerMap: new Map(), structsWithOwnUnit: new Set(), extraHeaderTypes: new Map() } as never,
    options: { format: 'cpp' } as ReconstructOptions,
    funcNameToHeaderPath: new Map(),
    platformHeaders: new Set(),
    unitImplPaths: new Map(Object.entries(units)),
  });
  return graph.serialize(graph.resolve(), {}, 'test') as unknown as Parameters<typeof selectDirtyUnits>[0]['buildInfo'];
}

const before = [
  fn('00450420', 'ReallocData', 'TSGrowableArray<SGAMEDATA>'),
  fn('006041b0', 'ReallocData', 'TSGrowableArray<CELLIST>'),
  fn('0060e370', 'UnlinkAll', 'TSList<StringEntryNode,TSGetLink<StringEntryNode>>'),
  fn('00604900', 'CELCMP_Open', 'D2CMP::SRC::CelCmp'),
];

test('a retyped member of a template unit after the first re-emits that unit', () => {
  const after = [...before];
  after[1] = fn('006041b0', 'ReallocData', 'TSGrowableArray<CELLIST>', 'CELLIST *');
  const sel = selectDirtyUnits({
    buildInfo: buildInfoFor(before),
    previous: computeHashCache({ functions: before, dataTypes: [], globals: [] }),
    identCacheEmpty: false,
    functions: after,
    dataTypes: [],
    globals: [],
  });
  assert.ok(sel.units?.includes('D2CMP::SRC::CelCmp::stpl_CELLIST'), JSON.stringify(sel));
  assert.ok(!sel.units?.includes('D2Common::Drlg::stpl_StringEntryNode'), JSON.stringify(sel));
  assert.ok(!sel.units?.includes('D2CMP::SRC::CelCmp::CelCmp'), JSON.stringify(sel));
});

test('a member of the last template unit is found too', () => {
  const after = [...before];
  after[2] = fn('0060e370', 'UnlinkAll', 'TSList<StringEntryNode,TSGetLink<StringEntryNode>>', 'StringEntryNode *');
  const sel = selectDirtyUnits({
    buildInfo: buildInfoFor(before),
    previous: computeHashCache({ functions: before, dataTypes: [], globals: [] }),
    identCacheEmpty: false,
    functions: after,
    dataTypes: [],
    globals: [],
  });
  assert.deepStrictEqual(sel.units, ['D2Common::Drlg::stpl_StringEntryNode']);
});

test('the forecast names the template unit and its file', () => {
  const p = predictUnits(buildInfoFor(before) as never, ['UnlinkAll'], [], []);
  assert.deepStrictEqual(p.units, ['D2Common::Drlg::stpl_StringEntryNode']);
  assert.deepStrictEqual(p.files, ['Source/D2Common/Drlg/stpl_StringEntryNode.cpp']);
});

test('a header with one unit serializes no unit list', () => {
  const info = buildInfoFor(before) as unknown as { modules: Array<{ id: string; units?: unknown[] }> };
  assert.strictEqual(info.modules.find(m => m.id === 'Source/D2CMP/SRC/CelCmp/CelCmp.h')?.units, undefined);
  assert.strictEqual(info.modules.find(m => m.id === HEADER)?.units?.length, 3);
});
