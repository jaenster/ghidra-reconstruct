import { describe, it } from 'node:test';
import assert from 'node:assert';

import { applyRecords, capture, type ApplyRow } from './ratchet.js';
import { carryStaticLocals, staticBlock } from './static-locals.js';
import { SymbolIndex, memoryTree } from './symbol-index.js';

function tree(header: string, unit: string): SymbolIndex {
  return SymbolIndex.build(memoryTree(new Map([
    ['Source/G/Unit.h', header],
    ['Source/G/Unit.cpp', unit],
  ])));
}

function row(rows: ApplyRow[], address: string): ApplyRow {
  const r = rows.find(x => x.address === address);
  assert.ok(r, `no row for ${address}`);
  return r!;
}

function body(ix: SymbolIndex, out: { changed: Map<string, string> }, address: string): string {
  const e = ix.extents.get(address)!;
  const text = out.changed.get(e.file) ?? ix.texts.get(e.file)!;
  const at = text.indexOf(`// 1.14d: ${address}`);
  const next = text.indexOf('// 1.14d: ', at + 10);
  return text.slice(at, next < 0 ? undefined : next).trim();
}

const HEADER = `#pragma once
namespace Game::Items {
int __stdcall Apply(int nCode); // 1.14d: 0065fd70
}
`;

describe('ratchet: function-local statics of a kept body', () => {
  it('reads the static block at the top of a body', () => {
    const text = `{
    // Static local variables (originally global data)
    static int gnCount = 0x25; D2_STATIC_GUARD(gnCount, "Game::F::gnCount");
    static int (*gpfnTable[2])(int) = {
        nullptr,
        nullptr
    }; D2_STATIC_GUARD(gpfnTable, "Game::F::gpfnTable");

    int x = static_cast<int>(gnCount);
    return x;
}`;
    const b = staticBlock(text, 0)!;
    assert.deepStrictEqual(b.names, ['gnCount', 'gpfnTable']);
    assert.ok(text.slice(b.start, b.end).startsWith('// Static local variables'));
    assert.ok(text.slice(b.start, b.end).endsWith('"Game::F::gpfnTable");'));
    assert.strictEqual(staticBlock('{\n    int x = 0;\n    return x;\n}', 0), undefined);
  });

  // ITEMMOD_ApplyPropertyToUnitStatsExpansion 0065fd70 at Game.exe v2110: the record was
  // captured while PROPERTIESFUNCTIONS was a file-scope global; the function owns it now.
  it('carries a static the function owns now that the stored body names', () => {
    const v1 = `#include "Unit.h"
int gaTable[2] = { 1, 2 };
namespace Game::Items {

// 1.14d: 0065fd70
int __stdcall Apply(int nCode) {
    // Static local variables (originally global data)
    static int gnCount = 0x25; D2_STATIC_GUARD(gnCount, "Game::Items::Apply::gnCount");

    if (nCode >= gnCount) {
      return 0;
    }
    return gaTable[nCode];
}

} // namespace Game::Items
`;
    const rec = capture(tree(HEADER, v1), '0065fd70', 'match', 'ev0').record!;
    const v2 = `#include "Unit.h"
namespace Game::Items {

// 1.14d: 0065fd70
int __stdcall Apply(int nCode) {
    // Static local variables (originally global data)
    static int gnCount = 0x25; D2_STATIC_GUARD(gnCount, "Game::Items::Apply::gnCount");
    static int gaTable[2] = {
        1,
        2
    }; D2_STATIC_GUARD(gaTable, "Game::Items::Apply::gaTable");

    return nCode < gnCount ? gaTable[nCode] : 0;
}

} // namespace Game::Items
`;
    const now = tree(HEADER, v2);
    const out = applyRecords(now, [rec]);
    assert.strictEqual(row(out.rows, '0065fd70').status, 'kept');
    const kept = body(now, out, '0065fd70');
    assert.ok(kept.includes('static int gaTable[2] = {'), kept);
    assert.ok(kept.includes('if (nCode >= gnCount) {'), kept);
    assert.strictEqual(kept.match(/static int gnCount/gu)?.length, 1, kept);
  });

  it('refuses a stored body declaring a static the function no longer owns', () => {
    const kept = '{\n    // Static local variables (originally global data)\n    static int gnCount = 1; D2_STATIC_GUARD(gnCount, "F::gnCount");\n\n    return gnCount;\n}';
    const fresh = 'int F() {\n    return gnCount + 0;\n}';
    const r = carryStaticLocals(kept, fresh, fresh.indexOf('{'));
    assert.strictEqual(r.text, undefined);
    assert.match(r.error!, /declares static gnCount/u);
  });

  it('places a block in a stored body that had none', () => {
    const kept = '{\n    return gaTable[0];\n}';
    const fresh = 'int F() {\n    // Static local variables (originally global data)\n    static int gaTable[1] = { 7 }; D2_STATIC_GUARD(gaTable, "F::gaTable");\n\n    return gaTable[0] + 0;\n}';
    const r = carryStaticLocals(kept, fresh, fresh.indexOf('{'));
    assert.strictEqual(r.text, '{\n    // Static local variables (originally global data)\n    static int gaTable[1] = { 7 }; D2_STATIC_GUARD(gaTable, "F::gaTable");\n\n    return gaTable[0];\n}');
  });

  // GFX_GetGfxMemory 0046f980: gnGfxCofCacheFlags renamed gnGfxMemory since the capture.
  it('follows a static renamed since the capture', () => {
    const kept = '{\n    // Static local variables (originally global data)\n    static int gnOld; D2_STATIC_GUARD_BSS(gnOld, "NS::F::gnOld");\n\n    return gnOld + p->gnOld;\n}';
    const fresh = 'int F() {\n    // Static local variables (originally global data)\n    static int gnNew; D2_STATIC_GUARD_BSS(gnNew, "NS::F::gnNew");\n\n    return gnNew + p->gnOld + 0;\n}';
    const r = carryStaticLocals(kept, fresh, fresh.indexOf('{'));
    assert.strictEqual(r.text, '{\n    // Static local variables (originally global data)\n    static int gnNew; D2_STATIC_GUARD_BSS(gnNew, "NS::F::gnNew");\n\n    return gnNew + p->gnOld;\n}');
  });

  it('does not take a differently declared static for a rename', () => {
    const kept = '{\n    static int gnOld; D2_STATIC_GUARD_BSS(gnOld, "NS::F::gnOld");\n    return gnOld;\n}';
    const fresh = 'int F() {\n    static short gnNew; D2_STATIC_GUARD_BSS(gnNew, "NS::F::gnNew");\n    return gnNew;\n}';
    assert.match(carryStaticLocals(kept, fresh, fresh.indexOf('{')).error!, /declares static gnOld/u);
  });

  it('leaves a body alone when the fresh static is one it does not name', () => {
    const kept = '{\n    return 1;\n}';
    const fresh = 'int F() {\n    static int gnUnused = 1; D2_STATIC_GUARD(gnUnused, "F::gnUnused");\n    return gnUnused;\n}';
    assert.strictEqual(carryStaticLocals(kept, fresh, fresh.indexOf('{')).text, kept);
  });
});

describe('ratchet: a parameter renamed onto a stored local', () => {
  // Unreferenced_0055db80 at Game.exe v2111: param_1 was named pUnit, the name the stored
  // body gave the local holding the owner; the kept body declared pUnit twice.
  it('does not keep the body, and says why', () => {
    const header = `#pragma once
namespace Game::Items {
int __fastcall Owner(int param_1); // 1.14d: 00401000
int __fastcall Client(int param_1); // 1.14d: 0055db80
}
`;
    const v1 = `#include "Unit.h"
namespace Game::Items {

// 1.14d: 0055db80
int __fastcall Client(int param_1) {
    if (param_1 == 1) {
      return 1;
    }

    int pUnit = Owner(param_1);
    return pUnit;
}

} // namespace Game::Items
`;
    const rec = capture(tree(header, v1), '0055db80', 'match', 'ev0').record!;
    const header2 = header.replace('Client(int param_1)', 'Client(int pUnit)');
    const v2 = `#include "Unit.h"
namespace Game::Items {

// 1.14d: 0055db80
int __fastcall Client(int pUnit) {
    if (pUnit == 1) {
      return 1;
    }
    int pOwner = Owner(pUnit);
    return pOwner;
}

} // namespace Game::Items
`;
    const now = tree(header2, v2);
    const out = applyRecords(now, [rec]);
    const r = row(out.rows, '0055db80');
    assert.strictEqual(r.status, 'unresolved');
    assert.match(r.detail, /param_1 is pUnit now, a name the stored body declares for a local/u);
    const emitted = body(now, out, '0055db80');
    assert.ok(emitted.includes('int pOwner = Owner(pUnit);'), emitted);
  });
});
