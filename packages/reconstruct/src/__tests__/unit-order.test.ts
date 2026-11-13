/**
 * The order of a module's units in its library: the 1.14d link's, by each unit's
 * first function in the module's runs, and its copy in Source/modules.cmake.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { ModuleConfig } from '../config/schema.js';
import type { SourceFile, SourceMap } from '../types.js';
import { ModuleLayout, validateModules } from '../modules/module-model.js';
import { orderUnits, runCounts, unitAddresses } from '../modules/unit-order.js';
import { moduleUnitOrders, modulesCMake } from '../codegen/module-layout.js';

const map = (file: string, ...fns: Array<string | [string, string]>): SourceMap => ({
  version: 2,
  file,
  functions: fns.map(f => (typeof f === 'string'
    ? { name: `f_${f}`, address: f, lines: [] }
    : { name: `f_${f[0]}`, address: f[0], definedIn: f[1], lines: [] })),
});

const run = (module: string, start: string, end: string) => ({ module, start, end });

describe('unit order', () => {
  const maps = [
    map('Source/Fog/B.cpp', '00401000', '00401100', '00403000'),
    map('Source/Fog/A.cpp', '00402000', '00402100'),
    map('Source/Fog/C.cpp', '00500000', '00401200'),
    map('Source/Fog/Empty.cpp'),
    map('Source/Fog/Inline.cpp', ['00400800', 'Source/Fog/Inline.inline.h'], '00404000'),
  ];
  const addresses = unitAddresses(maps);

  it('reads each unit\'s addresses, sorted, leaving out bodies defined in a header', () => {
    assert.deepStrictEqual(addresses.get('Source/Fog/C.cpp'), [0x401200, 0x500000]);
    assert.deepStrictEqual(addresses.get('Source/Fog/Inline.cpp'), [0x404000]);
  });

  it('counts the runs a unit\'s functions form among every unit\'s', () => {
    const counts = runCounts(addresses);
    assert.strictEqual(counts.get('Source/Fog/B.cpp'), 2, 'B: 401000-401100, then 403000 after A');
    assert.strictEqual(counts.get('Source/Fog/A.cpp'), 1);
    assert.strictEqual(counts.get('Source/Fog/C.cpp'), 2);
    assert.strictEqual(counts.get('Source/Fog/Empty.cpp'), undefined);
  });

  it('places a unit by its first function in the module\'s runs, a unit with none last', () => {
    const units = ['Source/Fog/A.cpp', 'Source/Fog/Empty.cpp', 'Source/Fog/C.cpp', 'Source/Fog/B.cpp', 'Source/Fog/Inline.cpp'];
    const placed = orderUnits(units, addresses, [run('Fog', '00401000', '00410000')]);
    assert.deepStrictEqual(placed.map(u => u.path), [
      'Source/Fog/B.cpp', 'Source/Fog/C.cpp', 'Source/Fog/A.cpp', 'Source/Fog/Inline.cpp', 'Source/Fog/Empty.cpp',
    ]);
    assert.strictEqual(placed[1].first, 0x401200);
    assert.strictEqual(placed[1].outside, false);
    assert.strictEqual(placed[4].first, undefined);
  });

  it('a stray function far outside the runs does not drag its unit forward', () => {
    const stray = unitAddresses([map('Source/Fog/S.cpp', '00300000', '00405000'), map('Source/Fog/T.cpp', '00402000')]);
    const placed = orderUnits(['Source/Fog/S.cpp', 'Source/Fog/T.cpp'], stray, [run('Fog', '00401000', '00410000')]);
    assert.deepStrictEqual(placed.map(u => u.path), ['Source/Fog/T.cpp', 'Source/Fog/S.cpp']);
  });

  it('with no function inside the runs, the unit\'s first function at all places it', () => {
    const placed = orderUnits(['Source/Fog/A.cpp', 'Source/Fog/C.cpp'], addresses, [run('Fog', '00600000', '00610000')]);
    assert.deepStrictEqual(placed.map(u => [u.path, u.first, u.outside]), [
      ['Source/Fog/C.cpp', 0x401200, true], ['Source/Fog/A.cpp', 0x402000, true],
    ]);
  });
});

describe('unitOrder in the module table', () => {
  const table = (unitOrder?: string): Record<string, ModuleConfig> => ({
    Fog: { kind: 'dll-module', namespaces: ['Fog'], dir: 'Source/Fog', linkOrder: 1, dependencies: [], unitOrder: unitOrder as ModuleConfig['unitOrder'] },
    Storm: { kind: '3rdparty', namespaces: ['Storm'], dir: '3rdparty/Storm', linkOrder: 2, dependencies: [] },
  });

  it('is original-address or path', () => {
    assert.deepStrictEqual(validateModules(table('original-address')), []);
    assert.deepStrictEqual(validateModules(table('path')), []);
    assert.deepStrictEqual(validateModules(table('address')), ['modules.Fog.unitOrder must be one of original-address, path']);
  });

  const files = new Map<string, SourceFile>();
  const unit = (path: string): void => { files.set(path, { path, content: '', type: 'implementation', functions: [], includes: [] }); };
  unit('Source/Fog/B.cpp');
  unit('Source/Fog/A.cpp');
  unit('3rdparty/Storm/S.cpp');
  files.set('Source/Fog/A.h', { path: 'Source/Fog/A.h', content: '', type: 'header', functions: [], includes: [] });
  const maps = [map('Source/Fog/B.cpp', '00401000'), map('Source/Fog/A.cpp', '00400800', '00402000'), map('3rdparty/Storm/S.cpp', '00411000')];

  it('orders the units of a module that asks for it, matching its runs case-blind', () => {
    const t = table('original-address');
    const units = moduleUnitOrders(t, new ModuleLayout(t), files, maps, [run('FOG', '00401000', '00410000')]);
    assert.deepStrictEqual([...units.keys()], ['Fog']);
    assert.deepStrictEqual(units.get('Fog')!.map(u => u.path), ['Source/Fog/B.cpp', 'Source/Fog/A.cpp']);
  });

  it('writes the order and the rule to modules.cmake', () => {
    const t = table('original-address');
    const units = moduleUnitOrders(t, new ModuleLayout(t), files, maps, [run('Fog', '00401000', '00410000')]);
    const text = modulesCMake(t, new Map(), new Map(), units);
    assert.match(text, /^set\(D2_MODULE_Fog_UNIT_ORDER "original-address"\)$/m);
    assert.match(text, /^set\(D2_MODULE_Fog_UNITS\n {4}Source\/Fog\/B\.cpp {2}# 00401000, 1 run\n {4}Source\/Fog\/A\.cpp {2}# 00402000, 2 runs\n\)$/m);
    assert.match(text, /^set\(D2_MODULE_Storm_UNIT_ORDER "path"\)$/m);
    assert.match(text, /^set\(D2_MODULE_Storm_UNITS \)$/m);
  });

  it('without the rule, every module is in path order', () => {
    const t = table();
    assert.strictEqual(moduleUnitOrders(t, new ModuleLayout(t), files, maps, []).size, 0);
    assert.match(modulesCMake(t, new Map()), /^set\(D2_MODULE_Fog_UNIT_ORDER "path"\)$/m);
  });
});
