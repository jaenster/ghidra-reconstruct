/**
 * Regression test: globals.h and globals.cpp must agree on which globals exist.
 *
 * `generateGlobalsHeader` drops any global whose type is an MSVC C++
 * exception-handling internal (FuncInfo, UnwindMapEntry, HandlerType,
 * TryBlockMapEntry, …) — nothing declares those types, so an `extern` of one
 * cannot compile. The DEFINITION side never applied the same filter, so
 * globals.cpp kept emitting them:
 *
 *   recon/diablo-2/globals.cpp:3425  UnwindMapEntry UnwindMapEntry_00700a70 = { … };
 *   recon/diablo-2/globals.h         (no matching extern at all)
 *
 * -> "'UnwindMapEntry' does not name a type", 78 errors in globals.cpp
 * (UnwindMapEntry 65, FuncInfo 6, HandlerType 4, TryBlockMapEntry 3).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  generateGlobalsHeader,
  generateGlobalsImpl,
  generateColocatedGlobalsImpl,
} from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, ReconstructOptions } from '../types.js';

const options = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

/** globals.cpp:3425 — real 1.14d Game.exe EH metadata blob. */
const UNWIND: AnalyzedDataSymbol = {
  name: 'UnwindMapEntry_00700a70',
  address: '00700a70',
  dataType: 'UnwindMapEntry',
  size: 8,
  isInitialized: true,
  xrefCount: 2,
  scope: 'global',
  initializedData: {
    kind: 'struct',
    fields: [
      { name: 'toState', value: { kind: 'scalar', value: '0xffffffff' } },
      { name: 'action', value: { kind: 'scalar', value: '0x0' } },
    ],
  },
};

/** globals.cpp:3440 — same class, different EH type. */
const FUNCINFO: AnalyzedDataSymbol = {
  name: 'FuncInfo_00700ad0',
  address: '00700ad0',
  dataType: 'FuncInfo',
  size: 0x24,
  isInitialized: false,
  xrefCount: 1,
  scope: 'global',
};

/** A real game global that must survive the filter untouched. */
const KEEP: AnalyzedDataSymbol = {
  name: 'gnGameSeed',
  address: '006fc100',
  dataType: 'uint32_t',
  size: 4,
  isInitialized: false,
  xrefCount: 7,
  scope: 'global',
};

describe('EH-internal globals are dropped by the definition side too', () => {
  it('globals.h declares none of them (the behaviour being matched)', () => {
    const h = generateGlobalsHeader([UNWIND, FUNCINFO, KEEP], options);
    assert.doesNotMatch(h, /UnwindMapEntry/);
    assert.doesNotMatch(h, /FuncInfo/);
    assert.match(h, /extern uint32_t gnGameSeed;/);
  });

  it('globals.cpp defines none of them either', () => {
    const cpp = generateGlobalsImpl([UNWIND, FUNCINFO, KEEP], options);
    assert.doesNotMatch(cpp, /UnwindMapEntry/);
    assert.doesNotMatch(cpp, /FuncInfo/);
    // The real global still gets its definition.
    assert.match(cpp, /^uint32_t gnGameSeed;$/m);
  });

  it('the co-located block drops them as well', () => {
    const colocated = generateColocatedGlobalsImpl([UNWIND, FUNCINFO], options);
    assert.strictEqual(colocated, '', 'an all-EH co-located block must emit nothing');
  });
});
