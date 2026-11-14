/**
 * The ratchet through a rename batch (the 1167 bench): kept bodies follow renamed globals,
 * enum constants, types, struct fields and parameters, including records captured before
 * their index could bind them, and a real retype still stays unresolved.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { matchParams, paramIds } from './params.js';
import { previousTree, typeRenames } from './previous.js';
import { applyRecords, capture, type ApplyRow } from './ratchet.js';
import { argumentOrder } from './rewrite.js';
import { scanHeader } from './scan.js';
import type { RatchetRecord } from './store.js';
import { GLOBALS_INDEX_FILE, SymbolIndex, memoryTree, type MappedParams } from './symbol-index.js';

function tree(files: Record<string, string>, maps: MappedParams[] = []): SymbolIndex {
  const ix = SymbolIndex.build(memoryTree(new Map(Object.entries(files))));
  ix.addParamStorage(maps);
  return ix;
}

function record(ix: SymbolIndex, address: string): RatchetRecord {
  const c = capture(ix, address, 'match', 'ev0');
  assert.ok(c.record, c.error);
  return c.record!;
}

/** The record as an index that could not bind `kinds` captured it. */
function legacy(rec: RatchetRecord, kinds: string[]): RatchetRecord {
  return {
    ...rec,
    members: rec.members.map(m => {
      const { paramStorage: _drop, ...rest } = m;
      return { ...rest, bindings: m.bindings.filter(([, b]) => !kinds.includes(b.k)) };
    }),
  };
}

function body(ix: SymbolIndex, out: { changed: Map<string, string> }, address: string): string {
  const e = ix.extents.get(address)!;
  const text = out.changed.get(e.file) ?? ix.texts.get(e.file)!;
  const at = text.indexOf(`// 1.14d: ${address}`);
  const next = text.indexOf('// 1.14d: ', at + 10);
  return text.slice(at, next < 0 ? undefined : next).trim();
}

function row(rows: ApplyRow[], address: string): ApplyRow {
  const r = rows.find(x => x.address === address);
  assert.ok(r, `no row for ${address}: ${JSON.stringify(rows)}`);
  return r!;
}

const ENUMS = (c1: string) => `#pragma once
typedef uint8_t eInventoryPage;
namespace eInventoryPage_ns {
constexpr eInventoryPage INVPAGE_INVENTORY = 0;
constexpr eInventoryPage ${c1} = 1;
constexpr eInventoryPage INVPAGE_HIDDEN = 7;
}
using eInventoryPage_ns::INVPAGE_INVENTORY;
using eInventoryPage_ns::${c1};
`;

const GLOBALS = (name: string) => `# address\tqualified name\ttype\n00744308\t${name}\tint\n`;

const HEADER = `#pragma once
#include "d2_enums.h"
namespace Data {
int __stdcall UnloadBin(void * pTxtTable, int nPage); // 1.14d: 006125c0
}
`;

const UNIT = (global: string, page: string, extra = '') => `#include "Data.h"
namespace Data {

// 1.14d: 006125c0
int __stdcall UnloadBin(void * pTxtTable, int nPage) {
    ${extra}if (${global} && nPage == ${page}) {
      return 1;
    }
    return 0;
}

} // namespace Data
`;

const dataTree = (global: string, page: string, extra = '', withGlobals = true) => tree({
  'Source/D2Headers/d2_enums.h': ENUMS(page),
  'Source/Data/Data.h': HEADER,
  'Source/Data/Data.cpp': UNIT(global, page, extra),
  ...(withGlobals ? { [GLOBALS_INDEX_FILE]: GLOBALS(global) } : {}),
});

describe('ratchet: the generator\'s enum form', () => {
  it('reads `namespace E_ns { constexpr E C = v; }` and the names a `using` exports', () => {
    const h = scanHeader(ENUMS('INVPAGE_CORPSE'))!;
    assert.strictEqual(h.enums.length, 1);
    assert.deepStrictEqual(h.enums[0].consts.map(c => `${c.name}=${c.value}`), ['INVPAGE_INVENTORY=0', 'INVPAGE_CORPSE=1', 'INVPAGE_HIDDEN=7']);
    const ix = dataTree('gpaMiscTxtTables', 'INVPAGE_CORPSE');
    assert.deepStrictEqual(ix.resolve(['INVPAGE_CORPSE'], false, ['Data']), { k: 'en', e: 'eInventoryPage', v: '1' });
    // Not exported: visible qualified only.
    assert.strictEqual(ix.resolve(['INVPAGE_HIDDEN'], false, []), undefined);
    assert.deepStrictEqual(ix.resolve(['eInventoryPage_ns', 'INVPAGE_HIDDEN'], false, []), { k: 'en', e: 'eInventoryPage', v: '7' });
  });

  it('binds an enum constant at capture and follows its rename', () => {
    const rec = record(dataTree('gpaMiscTxtTables', 'INVPAGE_CORPSE'), '006125c0');
    assert.ok(rec.members[0].bindings.some(([, b]) => b.k === 'en'));
    const now = dataTree('gpaMiscTxtTables', 'INVPAGE_TRADEGRID1', 'nPage = nPage;\n    ');
    const out = applyRecords(now, [rec]);
    assert.strictEqual(row(out.rows, '006125c0').status, 'kept');
    assert.ok(body(now, out, '006125c0').includes('nPage == INVPAGE_TRADEGRID1'), body(now, out, '006125c0'));
  });
});

describe('ratchet: records captured before their index could bind them', () => {
  it('binds a global and an enum constant of an older record under the tree it replaces', () => {
    // Seeded without a globals index and without the enum form: neither site is bound.
    const was = dataTree('gpaMiscTxtTables', 'INVPAGE_CORPSE');
    const rec = legacy(record(was, '006125c0'), ['gl', 'en']);
    assert.ok(!rec.members[0].bindings.some(([, b]) => b.k === 'gl' || b.k === 'en'));
    const now = dataTree('gbTxtAllocCountHeader', 'INVPAGE_TRADEGRID1', 'nPage = nPage;\n    ');
    // Without the old tree the old spellings survive: the failure the bench measured.
    const blind = applyRecords(now, [rec]);
    assert.ok(body(now, blind, '006125c0').includes('gpaMiscTxtTables'));
    const out = applyRecords(now, [rec], { previous: previousTree(was, now) });
    assert.strictEqual(row(out.rows, '006125c0').status, 'kept');
    const kept = body(now, out, '006125c0');
    assert.ok(kept.includes('if (gbTxtAllocCountHeader && nPage == INVPAGE_TRADEGRID1)'), kept);
  });

  it('calls an older record equal when only renamed globals differ', () => {
    const was = dataTree('gpaMiscTxtTables', 'INVPAGE_CORPSE');
    const rec = legacy(record(was, '006125c0'), ['gl', 'en']);
    const now = dataTree('gbTxtAllocCountHeader', 'INVPAGE_TRADEGRID1');
    const out = applyRecords(now, [rec], { previous: previousTree(was, now) });
    assert.deepStrictEqual(out.rows.map(r => r.status), ['equal']);
    assert.strictEqual(out.changed.size, 0);
  });

  it('still refuses a global retyped since', () => {
    const was = dataTree('gpaMiscTxtTables', 'INVPAGE_CORPSE');
    const rec = legacy(record(was, '006125c0'), ['gl']);
    const files = {
      'Source/D2Headers/d2_enums.h': ENUMS('INVPAGE_CORPSE'),
      'Source/Data/Data.h': HEADER,
      'Source/Data/Data.cpp': UNIT('gbTxtAllocCountHeader', 'INVPAGE_CORPSE', 'nPage = nPage;\n    '),
      [GLOBALS_INDEX_FILE]: '# address\tqualified name\ttype\n00744308\tgbTxtAllocCountHeader\tshort\n',
    };
    const now = tree(files);
    const out = applyRecords(now, [rec], { previous: previousTree(was, now) });
    assert.strictEqual(row(out.rows, '006125c0').status, 'unresolved');
    assert.match(row(out.rows, '006125c0').detail, /retyped: int -> short/u);
  });
});

const TYPES = (name: string, field: string, extra = '') => `#pragma once
struct D2UnitStrc {
    /* 0x00 */ int nType;
};
struct ${name} {
    /* 0x00 */ int nUnitMode;
    /* 0x04 */ struct D2UnitStrc * ${field};
};
${extra}namespace Mode {
int __stdcall StartDead(struct D2UnitStrc * pUnit, struct ${name} * pMode); // 1.14d: 005a7390
}
`;

const MODE = (name: string, field: string, extra = '') => `#include "Mode.h"
namespace Mode {

// 1.14d: 005a7390
int __stdcall StartDead(struct D2UnitStrc * pUnit, struct ${name} * pMode) {
    ${extra}${name} * p = (${name} *)pMode;
    return p->${field}->nType + pUnit->nType;
}

} // namespace Mode
`;

const modeTree = (name: string, field: string, extra = '', headerExtra = '') => tree({
  'Source/Mode/Mode.h': TYPES(name, field, headerExtra),
  'Source/Mode/Mode.cpp': MODE(name, field, extra),
});

describe('ratchet: a renamed type', () => {
  it('pairs a type that went with one that appeared at the same places with the same layout', () => {
    const was = modeTree('D2MonsterKillStrc', 'pVictim');
    const now = modeTree('D2ModeChangeStrc', 'pUnit');
    assert.deepStrictEqual([...typeRenames(was, now)], [['D2MonsterKillStrc', 'D2ModeChangeStrc']]);
  });

  it('prints a kept body under the new type and field names', () => {
    const was = modeTree('D2MonsterKillStrc', 'pVictim');
    const rec = record(was, '005a7390');
    const now = modeTree('D2ModeChangeStrc', 'pUnit', 'pUnit = pUnit;\n    ');
    const blind = applyRecords(now, [rec]);
    assert.strictEqual(row(blind.rows, '005a7390').status, 'unresolved', 'without the old tree a renamed type is a type gone');
    const out = applyRecords(now, [rec], { previous: previousTree(was, now) });
    assert.strictEqual(row(out.rows, '005a7390').status, 'kept', JSON.stringify(out.rows));
    const kept = body(now, out, '005a7390');
    assert.ok(kept.includes('D2ModeChangeStrc * p = (D2ModeChangeStrc *)pMode;'), kept);
    assert.ok(kept.includes('return p->pUnit->nType + pUnit->nType;'), kept);
    assert.ok(!kept.includes('D2MonsterKillStrc'), kept);
  });

  it('calls the body equal when only the type and field names differ', () => {
    const was = modeTree('D2MonsterKillStrc', 'pVictim');
    const rec = record(was, '005a7390');
    const now = modeTree('D2ModeChangeStrc', 'pUnit');
    const out = applyRecords(now, [rec], { previous: previousTree(was, now) });
    assert.deepStrictEqual(out.rows.map(r => r.status), ['equal'], JSON.stringify(out.rows));
  });

  it('is no rename when the layout differs', () => {
    const was = modeTree('D2MonsterKillStrc', 'pVictim');
    const now = tree({
      'Source/Mode/Mode.h': TYPES('D2ModeChangeStrc', 'pUnit').replace('/* 0x04 */ struct D2UnitStrc * pUnit;', '/* 0x08 */ struct D2UnitStrc * pUnit;'),
      'Source/Mode/Mode.cpp': MODE('D2ModeChangeStrc', 'pUnit', 'pUnit = pUnit;\n    '),
    });
    assert.strictEqual(typeRenames(was, now).size, 0);
    const out = applyRecords(now, [record(was, '005a7390')], { previous: previousTree(was, now) });
    assert.strictEqual(row(out.rows, '005a7390').status, 'unresolved');
  });

  it('is no rename when the parameter now names a type that existed before (a retype)', () => {
    const extra = 'struct D2PetStrc {\n    /* 0x00 */ int nUnitMode;\n    /* 0x04 */ struct D2UnitStrc * pOwner;\n};\n';
    const was = modeTree('D2MonsterKillStrc', 'pVictim', '', extra);
    const now = tree({
      'Source/Mode/Mode.h': TYPES('D2MonsterKillStrc', 'pVictim', extra).replace('struct D2MonsterKillStrc * pMode); //', 'struct D2PetStrc * pMode); //'),
      'Source/Mode/Mode.cpp': MODE('D2PetStrc', 'pOwner', 'pUnit = pUnit;\n    '),
    });
    assert.strictEqual(typeRenames(was, now).size, 0);
    const out = applyRecords(now, [record(was, '005a7390')], { previous: previousTree(was, now) });
    assert.strictEqual(row(out.rows, '005a7390').status, 'unresolved');
    assert.match(row(out.rows, '005a7390').detail, /retyped: D2MonsterKillStrc \* -> D2PetStrc \*/u);
  });

  it('is no rename when two types that went pair with the one that appeared', () => {
    const header = (a: string, b: string, fa: string, fb: string) => `#pragma once
struct ${a} {
    /* 0x00 */ int nX;
};
struct ${b} {
    /* 0x00 */ int nY;
};
namespace P {
int __stdcall F(struct ${fa} * p); // 1.14d: 00401000
int __stdcall G(struct ${fb} * p); // 1.14d: 00401100
}
`;
    const was = tree({ 'Source/P.h': header('PktA', 'PktB', 'PktA', 'PktB') });
    const now = tree({ 'Source/P.h': header('PktC', 'PktD', 'PktC', 'PktC') });
    assert.ok(!typeRenames(was, now).has('PktA'), [...typeRenames(was, now)].join(';'));
    assert.ok(!typeRenames(was, now).has('PktB'));
  });
});

// 00678b80 and its caller 00678cb0 (issue #293): the callee's parameters renamed so the
// names permute over unchanged storage.
const PATH_HEADER = (sig: string) => `#pragma once
namespace Path {
int __fastcall GetDirection(int nY2, int nX2, int nY1, int nX1); // 1.14d: 00678cb0
}
static int __fastcall GetDirectionIndex(${sig}); // decl
`;
const PATH_UNIT = (sig: string, body: string, call: string, extra = '') => `#include "Path.h"
namespace Path {

// 1.14d: 00678b80
static int __fastcall GetDirectionIndex(${sig}) {
    return ${body};
}

// 1.14d: 00678cb0
int __fastcall GetDirection(int nY2, int nX2, int nY1, int nX1) {
    ${extra}return ${call};
}

} // namespace Path
`;
const SIG_V1 = 'int nY2, int nY1, int nX2, int nX1';
const SIG_V2 = 'int nY2, int nX1, int nY1, int nX2';
const STORAGE = ['ECX:4', 'EDX:4', 'Stack[0x4]:4', 'Stack[0x8]:4'];
const maps = (sig: string): MappedParams[] => [
  { address: '00678b80', paramStorage: sig.split(', ').map((p, k) => [p.split(' ')[1], STORAGE[k]] as [string, string]) },
  { address: '00678cb0', paramStorage: ['nY2', 'nX2', 'nY1', 'nX1'].map((n, k) => [n, STORAGE[k]] as [string, string]) },
];
const pathTree = (sig: string, body: string, call: string, extra = '', withMaps = true) => tree({
  'Source/Path/Path.h': PATH_HEADER(sig),
  'Source/Path/Path.cpp': PATH_UNIT(sig, body, call, extra),
}, withMaps ? maps(sig) : []);

describe('ratchet: parameters renamed over unchanged storage', () => {
  it('keeps every argument in place when names permute over the same storage', () => {
    const was = pathTree(SIG_V1, 'nY2 - nY1 + nX2 * nX1', 'GetDirectionIndex(nY2, nY1, nX2, nX1)');
    const rec = record(was, '00678cb0');
    const now = pathTree(SIG_V2, 'nY2 - nX1 + nY1 * nX2', 'GetDirectionIndex(nY2, nY1, nX2, nX1)', 'nY2 = nY2;\n    ');
    const out = applyRecords(now, [rec]);
    assert.strictEqual(row(out.rows, '00678cb0').status, 'kept', JSON.stringify(out.rows));
    assert.ok(body(now, out, '00678cb0').includes('return GetDirectionIndex(nY2, nY1, nX2, nX1);'), body(now, out, '00678cb0'));
    assert.ok(!out.rows.some(r => /-> \(/u.test(r.detail)), JSON.stringify(out.rows));
  });

  it('takes the storage of an older record from the tree it replaces', () => {
    const was = pathTree(SIG_V1, 'nY2 - nY1 + nX2 * nX1', 'GetDirectionIndex(nY2, nY1, nX2, nX1)');
    const rec = legacy(record(pathTree(SIG_V1, 'nY2 - nY1 + nX2 * nX1', 'GetDirectionIndex(nY2, nY1, nX2, nX1)', '', false), '00678cb0'), []);
    assert.ok(rec.members.every(m => !m.paramStorage));
    const now = pathTree(SIG_V2, 'nY2 - nX1 + nY1 * nX2', 'GetDirectionIndex(nY2, nY1, nX2, nX1)', 'nY2 = nY2;\n    ');
    // Without it the names alone cannot tell a rename from a re-order: refused, not guessed.
    const blind = applyRecords(now, [rec]);
    assert.strictEqual(row(blind.rows, '00678cb0').status, 'unresolved');
    assert.match(row(blind.rows, '00678cb0').detail, /storage before is unknown/u);
    const out = applyRecords(now, [rec], { previous: previousTree(was, now) });
    assert.deepStrictEqual(out.rows.map(r => r.status), ['kept', 'equal'], JSON.stringify(out.rows));
    assert.ok(body(now, out, '00678cb0').includes('return GetDirectionIndex(nY2, nY1, nX2, nX1);'));
  });

  it('re-spells a function\'s own parameters by storage when their names permute', () => {
    const was = pathTree(SIG_V1, 'nY2 - nY1 + nX2 * nX1', 'GetDirectionIndex(nY2, nY1, nX2, nX1)');
    const rec = legacy(record(pathTree(SIG_V1, 'nY2 - nY1 + nX2 * nX1', 'GetDirectionIndex(nY2, nY1, nX2, nX1)', '', false), '00678cb0'), []);
    const now = pathTree(SIG_V2, 'nY2 - nX1 + (nY1 * nX2)', 'GetDirectionIndex(nY2, nY1, nX2, nX1)');
    const out = applyRecords(now, [rec], { previous: previousTree(was, now) });
    assert.strictEqual(row(out.rows, '00678b80').status, 'kept', JSON.stringify(out.rows));
    // The value in EDX was nY1 and is nX1 now.
    assert.ok(body(now, out, '00678b80').includes('return nY2 - nX1 + nY1 * nX2;'), body(now, out, '00678b80'));
  });

  it('still re-orders the arguments when the parameters moved with their storage', () => {
    const b = paramIds(['nA', 'nB'], ['ECX:4', 'EDX:4']);
    const a = paramIds(['nB', 'nA'], ['EDX:4', 'ECX:4']);
    assert.deepStrictEqual(matchParams(b, a), { map: [1, 0] });
    assert.deepStrictEqual(argumentOrder(b, a, [true, true]), [1, 0]);
  });

  it('keeps arguments in place for a rename permutation over the same storage', () => {
    const b = paramIds(['nY2', 'nY1', 'nX2', 'nX1'], STORAGE);
    const a = paramIds(['nY2', 'nX1', 'nY1', 'nX2'], STORAGE);
    assert.deepStrictEqual(matchParams(b, a), { map: [0, 1, 2, 3] });
    assert.strictEqual(argumentOrder(b, a, [true, true, true, true]), undefined);
  });

  it('refuses names that moved when only the storage now is known', () => {
    const m = matchParams(paramIds(['nY2', 'nY1']), paramIds(['nY1', 'nY2'], ['ECX:4', 'EDX:4']));
    assert.ok('error' in m && /storage before is unknown/u.test(m.error), JSON.stringify(m));
    // Names that stayed in place need no storage.
    assert.deepStrictEqual(matchParams(paramIds(['nY2', 'nY1']), paramIds(['nY2', 'nY1'], ['ECX:4', 'EDX:4'])), { map: [0, 1] });
  });
});
