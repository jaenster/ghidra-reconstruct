/**
 * Cached generation values equal the values computed without the cache, cold and warm,
 * and a value is never read under another input hash.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { cachedValue, configureStageCache } from '../codegen/stage-cache.js';
import { warningRows } from '../codegen/warning-facts.js';
import { nullGetterDefaults } from '../codegen/null-getters.js';
import { buildWriteEffects } from '../codegen/write-effects-table.js';
import type { ExtractedDataType, ExtractedFunction } from '../types.js';

const fn = (name: string, address: string, decompiled: string) =>
  ({ name, namespace: 'D2Game::Units', address, decompiled } as unknown as ExtractedFunction);

const FUNCTIONS = [
  fn('UNIT_A', '00401000', 'void UNIT_A(void)\n{\n                    /* WARNING: Subroutine does not return */\n  FOG_Halt();\n}\n'),
  fn('UNIT_B', '00402000', 'int UNIT_B(void)\n{\n  /* WARNING: Could not recover jumptable at 0x00402010. Too many branches */\n  return 1;\n}\n'),
  fn('UNIT_C', '00403000', 'int UNIT_C(void)\n{\n  return 2;\n}\n'),
];

let dir: string | undefined;
const freshDir = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-cache-')));
afterEach(() => {
  configureStageCache(null);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('warning rows through the stage cache', () => {
  it('are the uncached rows, cold and warm', () => {
    configureStageCache(null);
    const uncached = warningRows(FUNCTIONS);
    assert.ok(uncached.length >= 2, JSON.stringify(uncached));
    configureStageCache(freshDir());
    const cold = warningRows(FUNCTIONS);
    assert.ok(fs.readdirSync(dir!).some(f => f.startsWith('warning-facts-')), 'the cold run wrote the cache');
    const warm = warningRows(FUNCTIONS);
    assert.deepStrictEqual(cold, uncached);
    assert.deepStrictEqual(warm, uncached);
  });

  it('recompute a body whose text changed', () => {
    configureStageCache(freshDir());
    warningRows(FUNCTIONS);
    const edited = [...FUNCTIONS.slice(0, 2), fn('UNIT_C', '00403000', 'int UNIT_C(void)\n{\n  /* WARNING: Removing unreachable block (ram,0x00403008) */\n  return 2;\n}\n')];
    const warm = warningRows(edited);
    configureStageCache(null);
    assert.deepStrictEqual(warm, warningRows(edited));
  });
});

describe('cachedValue', () => {
  it('reads a value back only under the same input hash', () => {
    configureStageCache(freshDir());
    let computed = 0;
    const get = (input: string) => cachedValue('probe', () => input, () => { computed++; return { input, n: [1, 2, 3] }; });
    assert.deepStrictEqual(get('a'), { input: 'a', n: [1, 2, 3] });
    assert.deepStrictEqual(get('a'), { input: 'a', n: [1, 2, 3] });
    assert.strictEqual(computed, 1);
    assert.deepStrictEqual(get('b'), { input: 'b', n: [1, 2, 3] });
    assert.strictEqual(computed, 2);
  });

  it('round-trips a value through its codec', () => {
    configureStageCache(freshDir());
    const codec = {
      encode: (m: Map<string, number>) => [...m],
      decode: (e: [string, number][]) => new Map(e),
    };
    const make = () => new Map([['x', 1], ['y', 2]]);
    const cold = cachedValue('map', () => 'k', make, codec);
    const warm = cachedValue('map', () => 'k', () => { throw new Error('not recomputed'); }, codec);
    assert.deepStrictEqual(warm, cold);
  });
});

const getter = (name: string, address: string, field: string, dflt: string) => ({
  name, namespace: 'D2Common::Units', address,
  signature: '', returnType: 'int', callingConvention: '__stdcall',
  parameters: [{ name: 'pUnit', dataType: 'D2UnitStrc *', ordinal: 0, storage: 'Stack[0x4]:4' }],
  localVariables: [], isThunk: false, isExternal: false, hasVarArgs: false, size: 0x10,
  decompiled: `int __stdcall ${name}(D2UnitStrc *pUnit)\n{\n  if (pUnit == (D2UnitStrc *)0x0) {\n    return ${dflt};\n  }\n  return pUnit->${field};\n}\n`,
} as unknown as ExtractedFunction);

const GETTERS = [
  getter('UNITS_GetType', '00620000', 'dwType', '6'),
  getter('UNITS_GetMode', '00620100', 'dwAnimMode', 'MODE_NONE'),
  getter('UNITS_GetClass', '00620200', 'dwClassId', '-1'),
];
const MODES = {
  name: 'eMode', kind: 'ENUM', size: 4, values: [{ name: 'MODE_NONE', value: 12 }],
} as unknown as ExtractedDataType;

describe('null-getter defaults through the stage cache', () => {
  it('are the uncached defaults, cold and warm', () => {
    configureStageCache(null);
    const uncached = nullGetterDefaults(GETTERS, [MODES]);
    assert.ok(Object.keys(uncached.table).length === 3, JSON.stringify(uncached));
    configureStageCache(freshDir());
    const cold = nullGetterDefaults(GETTERS, [MODES]);
    assert.ok(fs.readdirSync(dir!).some(f => f.startsWith('null-getter-evidence-')), 'the cold run wrote the cache');
    const warm = nullGetterDefaults(GETTERS, [MODES]);
    assert.deepStrictEqual(cold, uncached);
    assert.deepStrictEqual(warm, uncached);
  });

  it('do not reuse evidence valued under other enumerators', () => {
    configureStageCache(freshDir());
    nullGetterDefaults(GETTERS, [MODES]);
    const renumbered = { ...MODES, values: [{ name: 'MODE_NONE', value: 13 }] } as unknown as ExtractedDataType;
    const warm = nullGetterDefaults(GETTERS, [renumbered]);
    configureStageCache(null);
    assert.deepStrictEqual(warm, nullGetterDefaults(GETTERS, [renumbered]));
  });
});

const body = (name: string, address: string, params: string, text: string) => ({
  name, namespace: 'D2Game::Units', address,
  signature: '', returnType: 'void', callingConvention: '__stdcall',
  parameters: params ? params.split(',').map((p, i) => {
    const [t, n] = p.trim().split(/\s+(?=\w+$)/);
    return { name: n, dataType: t, ordinal: i, storage: `Stack[0x${(4 + 4 * i).toString(16)}]:4` };
  }) : [],
  localVariables: [], isThunk: false, isExternal: false, hasVarArgs: false, size: 0x10,
  decompiled: `void __stdcall ${name}(${params})\n{\n${text}\n}\n`,
} as unknown as ExtractedFunction);

const EFFECT_FUNCTIONS = [
  body('SetSeed', '00630000', 'D2SeedStrc *pSeed', '  pSeed->nLow = 1;\n  gnCount = gnCount + 1;\n  return;'),
  body('Init', '00630100', 'int k', '  gpfnCallback = SetSeed;\n  if (k != 0) {\n    gpfnCallback = 0;\n  }\n  return;'),
  body('Use', '00630200', 'D2UnitStrc *pUnit', '  SetSeed(pUnit->pSeed);\n  (*gpfnCallback)();\n  return;'),
  body('Broken', '00630300', '', '  if (( {\n  return;'),
];
const EFFECT_GLOBAL_TYPES = { gnCount: 'int', gpfnCallback: 'void (*)(void)' };
const EFFECT_AGGREGATES = {
  layouts: {
    D2SeedStrc: [{ name: 'nLow', offset: 0, size: 4, type: 'uint32_t' }, { name: 'nHigh', offset: 4, size: 4, type: 'uint32_t' }],
    D2UnitStrc: [{ name: 'pSeed', offset: 0, size: 4, type: 'D2SeedStrc *' }],
  },
  sizes: { D2SeedStrc: 8, D2UnitStrc: 4 },
};

describe('write effects through the stage cache', () => {
  const build = (types: Record<string, string> = EFFECT_GLOBAL_TYPES) =>
    buildWriteEffects(EFFECT_FUNCTIONS, types, undefined, { aggregates: EFFECT_AGGREGATES });

  it('are the uncached effects, cold and warm', () => {
    configureStageCache(null);
    const uncached = build();
    assert.ok(uncached.SetSeed && uncached.Use && uncached.Broken?.unknown, JSON.stringify(uncached));
    configureStageCache(freshDir());
    const cold = build();
    assert.ok(fs.readdirSync(dir!).some(f => f.startsWith('write-effect-analysis-')), 'the cold run wrote the cache');
    const warm = build();
    assert.deepStrictEqual(cold, uncached);
    assert.deepStrictEqual(warm, uncached);
  });

  it('do not reuse a body read against other global tables', () => {
    configureStageCache(freshDir());
    build();
    const retyped = { ...EFFECT_GLOBAL_TYPES, gnCount: 'int[4]' };
    const warm = build(retyped);
    configureStageCache(null);
    assert.deepStrictEqual(warm, build(retyped));
  });
});
