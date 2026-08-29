/**
 * Regression test: the forward-declaration block in globals.h must be ordered by
 * dependency, not by the text of the emitted line.
 *
 * Real 1.14d Game.exe case. `/DbgHelp` holds `pfnStackWalk`, whose signature
 * names two other funcdefs in the same block:
 *
 *   typedef BOOL  (*pfnStackWalk)(..., pfnSymFunctionTableAccess FunctionTableAccessRoutine,
 *                                      pfnSymGetModuleBase GetModuleBaseRoutine, ...);
 *   typedef DWORD (*pfnSymGetModuleBase)(HANDLE hProcess, DWORD dwAddr);
 *   typedef void *(*pfnSymFunctionTableAccess)(HANDLE hProcess, DWORD AddrBase);
 *
 * Sorted on the emitted text, `BOOL` precedes both `DWORD` and `void`, so the
 * user of the two typedefs was emitted before either of them and every
 * translation unit that includes globals.h died with "'pfnSymGetModuleBase' has
 * not been declared" — two errors times 483 files.
 *
 * The ordering must also be stable: declarations no edge constrains keep the key
 * order they had, so the header stays diffable between runs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateGlobalsHeader } from '../codegen/globals-header.js';
import type {
  AnalyzedDataSymbol,
  ExtractedDataType,
  ExtractedFunctionDefinition,
  ReconstructOptions,
} from '../types.js';

const options = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

const pfnSymGetModuleBase: ExtractedFunctionDefinition = {
  name: 'pfnSymGetModuleBase',
  category: '/DbgHelp',
  size: 4,
  kind: 'FUNCTION_DEFINITION',
  returnType: 'DWORD',
  parameters: [
    { name: 'hProcess', dataType: 'HANDLE', ordinal: 0 },
    { name: 'dwAddr', dataType: 'DWORD', ordinal: 1 },
  ],
};

const pfnSymFunctionTableAccess: ExtractedFunctionDefinition = {
  name: 'pfnSymFunctionTableAccess',
  category: '/DbgHelp',
  size: 4,
  kind: 'FUNCTION_DEFINITION',
  returnType: 'void *',
  parameters: [
    { name: 'hProcess', dataType: 'HANDLE', ordinal: 0 },
    { name: 'AddrBase', dataType: 'DWORD', ordinal: 1 },
  ],
};

const pfnStackWalk: ExtractedFunctionDefinition = {
  name: 'pfnStackWalk',
  category: '/DbgHelp',
  size: 4,
  kind: 'FUNCTION_DEFINITION',
  returnType: 'BOOL',
  parameters: [
    { name: 'MachineType', dataType: 'DWORD', ordinal: 0 },
    { name: 'FunctionTableAccessRoutine', dataType: 'pfnSymFunctionTableAccess', ordinal: 1 },
    { name: 'GetModuleBaseRoutine', dataType: 'pfnSymGetModuleBase', ordinal: 2 },
  ],
};

const dataTypes: ExtractedDataType[] = [
  pfnStackWalk,
  pfnSymGetModuleBase,
  pfnSymFunctionTableAccess,
];

/** One slot per typedef, so each is reached only through a pointer. */
const globals: AnalyzedDataSymbol[] = [
  {
    name: 'pStackWalk',
    address: '006fdc78',
    dataType: 'pfnStackWalk *',
    size: 4,
    isInitialized: false,
    xrefCount: 1,
    scope: 'global',
  },
  {
    name: 'pSymGetModuleBase',
    address: '006fdc7c',
    dataType: 'pfnSymGetModuleBase *',
    size: 4,
    isInitialized: false,
    xrefCount: 1,
    scope: 'global',
  },
  {
    name: 'pSymFunctionTableAccess',
    address: '006fdc80',
    dataType: 'pfnSymFunctionTableAccess *',
    size: 4,
    isInitialized: false,
    xrefCount: 1,
    scope: 'global',
  },
];

/** The lines of the "// Forward declarations" block, in emitted order. */
function forwardDeclBlock(header: string): string[] {
  const lines = header.split('\n');
  const start = lines.indexOf('// Forward declarations');
  if (start < 0) return [];
  const block: string[] = [];
  for (let i = start + 1; i < lines.length && lines[i].trim() !== ''; i++) block.push(lines[i]);
  return block;
}

/** Line index of the typedef that declares `name`, or -1. */
function typedefLine(header: string, name: string): number {
  return header.split('\n').findIndex(l => l.includes(`(*${name})(`));
}

describe('globals.h emits typedefs in dependency order', () => {
  it('emits a typedef after every typedef its signature names', () => {
    const out = generateGlobalsHeader(globals, options, dataTypes);

    const user = typedefLine(out, 'pfnStackWalk');
    const tableAccess = typedefLine(out, 'pfnSymFunctionTableAccess');
    const moduleBase = typedefLine(out, 'pfnSymGetModuleBase');

    assert.ok(user >= 0, 'pfnStackWalk is not emitted');
    assert.ok(tableAccess >= 0, 'pfnSymFunctionTableAccess is not emitted');
    assert.ok(moduleBase >= 0, 'pfnSymGetModuleBase is not emitted');

    assert.ok(
      tableAccess < user,
      'pfnSymFunctionTableAccess is emitted after the typedef that uses it'
    );
    assert.ok(
      moduleBase < user,
      'pfnSymGetModuleBase is emitted after the typedef that uses it'
    );
  });

  it('orders transitively, not just one level deep', () => {
    const outermost: ExtractedFunctionDefinition = {
      name: 'AAA_Outermost',
      category: '/DbgHelp',
      size: 4,
      kind: 'FUNCTION_DEFINITION',
      returnType: 'BOOL',
      parameters: [{ name: 'walk', dataType: 'pfnStackWalk', ordinal: 0 }],
    };
    const outermostSlot: AnalyzedDataSymbol = {
      name: 'pOutermost',
      address: '006fdc84',
      dataType: 'AAA_Outermost *',
      size: 4,
      isInitialized: false,
      xrefCount: 1,
      scope: 'global',
    };

    const out = generateGlobalsHeader(
      [...globals, outermostSlot],
      options,
      [outermost, ...dataTypes]
    );

    const outer = typedefLine(out, 'AAA_Outermost');
    assert.ok(outer >= 0, 'AAA_Outermost is not emitted');
    assert.ok(typedefLine(out, 'pfnStackWalk') < outer, 'pfnStackWalk follows its user');
    assert.ok(
      typedefLine(out, 'pfnSymGetModuleBase') < outer,
      'pfnSymGetModuleBase follows its transitive user'
    );
  });

  it('is deterministic across runs and independent of input order', () => {
    const a = forwardDeclBlock(generateGlobalsHeader(globals, options, dataTypes));
    const b = forwardDeclBlock(generateGlobalsHeader(globals, options, dataTypes));
    assert.deepStrictEqual(a, b, 'two runs of the same input disagree');

    const shuffled = forwardDeclBlock(
      generateGlobalsHeader([...globals].reverse(), options, [...dataTypes].reverse())
    );
    assert.deepStrictEqual(shuffled, a, 'input order leaks into the forward-declaration block');
  });

  it('leaves unconstrained declarations in key order', () => {
    // Nothing here references anything else, so the block must come out in the
    // same order the plain text sort gave it.
    const loose: ExtractedFunctionDefinition[] = [
      { ...pfnSymGetModuleBase, name: 'pfnAlpha' },
      { ...pfnSymGetModuleBase, name: 'pfnBravo' },
      { ...pfnSymGetModuleBase, name: 'pfnCharlie' },
    ];
    const slots: AnalyzedDataSymbol[] = loose.map((fd, i) => ({
      name: `p${fd.name}`,
      address: `006fdd0${i}`,
      dataType: `${fd.name} *`,
      size: 4,
      isInitialized: false,
      xrefCount: 1,
      scope: 'global',
    }));

    const out = generateGlobalsHeader(slots, options, loose);
    const order = ['pfnAlpha', 'pfnBravo', 'pfnCharlie'].map(n => typedefLine(out, n));
    assert.deepStrictEqual(
      [...order].sort((x, y) => x - y),
      order,
      'unconstrained typedefs did not keep their key order'
    );
  });
});
