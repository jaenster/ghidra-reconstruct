import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { advance, readAudit } from './advance.js';
import { followHandFile } from './follow.js';
import { applyRecords, capture, type ApplyRow } from './ratchet.js';
import { RatchetStore, type RatchetRecord } from './store.js';
import { GLOBALS_INDEX_FILE, SymbolIndex, memoryTree } from './symbol-index.js';

/** A two-file tree: a header with declarations and structs, a unit with definitions. */
function tree(header: string, unit: string, globals = ''): SymbolIndex {
  return SymbolIndex.build(memoryTree(new Map([
    ['Source/G/Unit.h', header],
    ['Source/G/Unit.cpp', unit],
    ...(globals ? [[GLOBALS_INDEX_FILE, globals] as [string, string]] : []),
  ])));
}

function record(ix: SymbolIndex, address: string, kind: 'match' | 'pin' = 'match'): RatchetRecord {
  const c = capture(ix, address, kind, 'ev0');
  assert.ok(c.record, c.error);
  return c.record!;
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
  assert.ok(r, `no row for ${address}`);
  return r!;
}

const HEADER_V1 = `#pragma once
struct D2UnitStrc {
    /* 0x00 */ int nType;
    /* 0x04 */ int nClassId;
    /* 0x08 */ struct D2UnitStrc * pNext;
};
namespace Game::Unit {
int __stdcall GetLevel(struct D2UnitStrc * pUnit, int nStat); // 1.14d: 00401000
void __fastcall Award(struct D2UnitStrc * pUnit, int nXp); // 1.14d: 00401100
}
`;

const UNIT_V1 = `#include "Unit.h"
namespace Game::Unit {

// 1.14d: 00401000
int __stdcall GetLevel(struct D2UnitStrc * pUnit, int nStat) {
    return pUnit->nClassId + nStat;
}

// 1.14d: 00401100
void __fastcall Award(struct D2UnitStrc * pUnit, int nXp) {
    int nLevel = GetLevel(pUnit, 12);
    if (pUnit->pNext->nType == 1) {
      return;
    }
    gnTotal = gnTotal + nXp + nLevel;
}

} // namespace Game::Unit
`;

const GLOBALS = `# address\tqualified name\ttype\n00700000\tGame::Unit::gnTotal\tint\n`;

describe('ratchet: re-spelling a kept body', () => {
  it('keeps a MATCH body through a callee move and a field rename', () => {
    const old = tree(HEADER_V1, UNIT_V1, GLOBALS);
    const rec = record(old, '00401100');
    // v2: GetLevel moved to Game::Stats, nClassId renamed nClass, and the generator now
    // spells Award's body differently (the shape the ratchet must not let through).
    const header2 = HEADER_V1.replace('/* 0x04 */ int nClassId;', '/* 0x04 */ int nClass;')
      .replace('namespace Game::Unit {\nint __stdcall GetLevel(struct D2UnitStrc * pUnit, int nStat); // 1.14d: 00401000\n',
        'namespace Game::Stats {\nint __stdcall GetLevel(struct D2UnitStrc * pUnit, int nStat); // 1.14d: 00401000\n}\nnamespace Game::Unit {\n');
    const unit2 = `#include "Unit.h"
namespace Game::Stats {

// 1.14d: 00401000
int __stdcall GetLevel(struct D2UnitStrc * pUnit, int nStat) {
    return pUnit->nClass + nStat;
}

} // namespace Game::Stats
namespace Game::Unit {

// 1.14d: 00401100
void __fastcall Award(struct D2UnitStrc * pUnit, int nXp) {
    if (pUnit->pNext->nType != 1) {
      gnTotal += nXp + Stats::GetLevel(pUnit, 12);
    }
}

} // namespace Game::Unit
`;
    const now = tree(header2, unit2, GLOBALS);
    const out = applyRecords(now, [rec]);
    assert.strictEqual(row(out.rows, '00401100').status, 'kept');
    const kept = body(now, out, '00401100');
    assert.ok(kept.includes('int nLevel = Stats::GetLevel(pUnit, 12);'), kept);
    assert.ok(kept.includes('gnTotal = gnTotal + nXp + nLevel;'), kept);
  });

  it('renames a field by (struct, offset)', () => {
    const header = HEADER_V1;
    const unit = UNIT_V1.replace('return pUnit->nClassId + nStat;', 'return pUnit->nClassId + nStat + pUnit->nType;');
    const old = tree(header, unit);
    const rec = record(old, '00401000');
    const now = tree(header.replace('int nClassId;', 'int nClassIndex;'),
      unit.replace('return pUnit->nClassId + nStat + pUnit->nType;', 'return nStat + pUnit->nClassIndex + pUnit->nType;'));
    const out = applyRecords(now, [rec]);
    assert.strictEqual(row(out.rows, '00401000').status, 'kept');
    assert.ok(body(now, out, '00401000').includes('return pUnit->nClassIndex + nStat + pUnit->nType;'));
  });

  it('calls the equivalent fresh body equal, renames and all', () => {
    const old = tree(HEADER_V1, UNIT_V1, GLOBALS);
    const rec = record(old, '00401100');
    const now = tree(HEADER_V1.replace(/GetLevel/gu, 'UNIT_GetLevel'), UNIT_V1.replace(/GetLevel/gu, 'UNIT_GetLevel'), GLOBALS);
    const out = applyRecords(now, [rec]);
    assert.strictEqual(row(out.rows, '00401100').status, 'equal');
    assert.strictEqual(out.changed.size, 0);
  });

  it('re-orders a call when the callee parameters were re-ordered', () => {
    const old = tree(HEADER_V1, UNIT_V1, GLOBALS);
    const rec = record(old, '00401100');
    const swap = (s: string) => s.replace(/GetLevel\(struct D2UnitStrc \* pUnit, int nStat\)/gu, 'GetLevel(int nStat, struct D2UnitStrc * pUnit)');
    const unit2 = swap(UNIT_V1).replace('int nLevel = GetLevel(pUnit, 12);\n    if', 'int nLevel = GetLevel(12, pUnit);\n    nXp = nXp;\n    if');
    const now = tree(swap(HEADER_V1), unit2, GLOBALS);
    const out = applyRecords(now, [rec]);
    assert.strictEqual(row(out.rows, '00401100').status, 'kept');
    assert.ok(body(now, out, '00401100').includes('GetLevel(12, pUnit)'));
  });

  it('reports an unresolvable body, keeps it under #if 0, and lets the fresh one through', () => {
    const old = tree(HEADER_V1, UNIT_V1, GLOBALS);
    const rec = record(old, '00401100');
    const unit2 = UNIT_V1.replace('nXp + nLevel', 'nXp + nLevel + 1');
    // The parameter's type changed: the stored body was written against another prototype.
    const now = tree(HEADER_V1.replace('Award(struct D2UnitStrc * pUnit, int nXp)', 'Award(struct D2UnitStrc * pUnit, unsigned int nXp)'),
      unit2.replace('Award(struct D2UnitStrc * pUnit, int nXp)', 'Award(struct D2UnitStrc * pUnit, unsigned int nXp)'), GLOBALS);
    const out = applyRecords(now, [rec]);
    const r = row(out.rows, '00401100');
    assert.strictEqual(r.status, 'unresolved');
    assert.match(r.detail, /parameter 1 retyped: int -> unsigned int/u);
    const text = out.changed.get('Source/G/Unit.cpp')!;
    assert.ok(text.includes('#if 0 // ratchet: the match body of 00401100'));
    assert.ok(text.includes('nXp + nLevel + 1'), 'the fresh body stays');
  });

  it('reports a callee that vanished', () => {
    const old = tree(HEADER_V1, UNIT_V1, GLOBALS);
    const rec = record(old, '00401100');
    const header2 = HEADER_V1.replace('int __stdcall GetLevel(struct D2UnitStrc * pUnit, int nStat); // 1.14d: 00401000\n', '');
    const from = UNIT_V1.indexOf('// 1.14d: 00401000');
    const to = UNIT_V1.indexOf('// 1.14d: 00401100');
    const unit2 = (UNIT_V1.slice(0, from) + UNIT_V1.slice(to)).replace('int nLevel = GetLevel(pUnit, 12);', 'int nLevel = 0;');
    const out = applyRecords(tree(header2, unit2, GLOBALS), [rec]);
    assert.strictEqual(row(out.rows, '00401100').status, 'unresolved');
    assert.match(row(out.rows, '00401100').detail, /function 00401000 \(GetLevel\) gone/u);
  });

  it('lets a released body through', () => {
    const old = tree(HEADER_V1, UNIT_V1, GLOBALS);
    const rec = record(old, '00401100');
    const now = tree(HEADER_V1, UNIT_V1.replace('nXp + nLevel', 'nLevel + nXp'), GLOBALS);
    const out = applyRecords(now, [rec], { releases: new Set(['00401100']) });
    assert.strictEqual(row(out.rows, '00401100').status, 'released');
    assert.strictEqual(out.changed.size, 0);
  });

  it('keeps a static callee whose shape the caller depends on', () => {
    const unit = UNIT_V1.replace('int __stdcall GetLevel(struct D2UnitStrc * pUnit, int nStat) {', 'static int __stdcall GetLevel(struct D2UnitStrc * pUnit, int nStat) {');
    const old = tree(HEADER_V1, unit, GLOBALS);
    const rec = record(old, '00401100');
    assert.deepStrictEqual(rec.members.map(m => m.address), ['00401100', '00401000']);
    const now = tree(HEADER_V1, unit.replace('return pUnit->nClassId + nStat;', 'int n = nStat;\n    return pUnit->nClassId + n;'), GLOBALS);
    const out = applyRecords(now, [rec]);
    assert.strictEqual(row(out.rows, '00401000').status, 'kept');
    assert.ok(body(now, out, '00401000').includes('return pUnit->nClassId + nStat;'));
    // Released, the callee's fresh body goes through.
    const rel = applyRecords(now, [rec], { releases: new Set(['00401000']) });
    assert.strictEqual(rel.changed.size, 0);
  });

  it('re-spells a moved function body and the labels derived from its name', () => {
    const unit = UNIT_V1.replace('    gnTotal = gnTotal + nXp + nLevel;', '    static int s_n = 0; D2_STATIC_GUARD(s_n, "Game::Unit::Award::s_n");\n    gnTotal = gnTotal + nXp + nLevel;');
    const rec = record(tree(HEADER_V1, unit, GLOBALS), '00401100', 'pin');
    // Award moved to Game::Xp and was renamed; GetLevel stayed in Game::Unit.
    const header2 = HEADER_V1.replace('void __fastcall Award(struct D2UnitStrc * pUnit, int nXp); // 1.14d: 00401100\n}', '}\nnamespace Game::Xp {\nvoid __fastcall XP_Award(struct D2UnitStrc * pUnit, int nXp); // 1.14d: 00401100\n}');
    const unit2 = UNIT_V1.replace('// 1.14d: 00401100\nvoid __fastcall Award(', '} // namespace Game::Unit\nnamespace Game::Xp {\n// 1.14d: 00401100\nvoid __fastcall XP_Award(')
      .replace('GetLevel(pUnit, 12)', 'Unit::GetLevel(pUnit, 12)').replace('gnTotal = gnTotal', 'Unit::gnTotal = Unit::gnTotal');
    const now = tree(header2, unit2, GLOBALS);
    const out = applyRecords(now, [rec]);
    assert.strictEqual(row(out.rows, '00401100').status, 'pinned');
    const b = body(now, out, '00401100');
    assert.ok(b.includes('int nLevel = Unit::GetLevel(pUnit, 12);'), b);
    assert.ok(b.includes('Unit::gnTotal = Unit::gnTotal + nXp + nLevel;'), b);
    assert.ok(b.includes('"Game::Xp::XP_Award::s_n"'), b);
  });

  it('applies a pin whatever the generator says', () => {
    const edited = UNIT_V1.replace('    gnTotal = gnTotal + nXp + nLevel;', '    TRACE_Award(nXp);\n    gnTotal = gnTotal + nXp + nLevel;');
    const pin = record(tree(HEADER_V1, edited, GLOBALS), '00401100', 'pin');
    const out = applyRecords(tree(HEADER_V1, UNIT_V1, GLOBALS), [pin]);
    assert.strictEqual(row(out.rows, '00401100').status, 'pinned');
    assert.ok(out.changed.get('Source/G/Unit.cpp')!.includes('TRACE_Award(nXp);'));
  });
});

describe('ratchet: hand files follow a regen', () => {
  // Deploy 1163: GetMinimapRect lost its EBX argument, UNITS_FindClientSideUnit moved from
  // Player to CUnit (another header), and Redivivus/d2_control.cpp needed both by hand.
  const before = SymbolIndex.build(memoryTree(new Map([
    ['Source/D2Common/Dungeon.h', `namespace D2Common::DUNGEON::Dungeon {
void __stdcall DRLGROOM_GetMinimapRect(uint32_t nLine, struct D2RoomStrc * pRoom, int32_t * pRect); // 1.14d: 00619c40
}
`],
    ['Source/D2Client/UNIT/Player.h', `namespace D2Client::UNIT::Player {
struct D2UnitStrc * __fastcall UNITS_FindClientSideUnit(int32_t nUnitGUID, eD2UnitType eUnitType); // 1.14d: 00463990
}
`],
  ])));
  const after = SymbolIndex.build(memoryTree(new Map([
    ['Source/D2Common/Dungeon.h', `namespace D2Common::DUNGEON::Dungeon {
void __stdcall DRLGROOM_GetMinimapRect(struct D2RoomStrc * pRoom, int32_t * pRect); // 1.14d: 00619c40
}
`],
    ['Source/D2Client/UNIT/CUnit.h', `namespace D2Client::UNIT::CUnit {
struct D2UnitStrc * __fastcall UNITS_FindClientSideUnit(int32_t nUnitGUID, eD2UnitType eUnitType); // 1.14d: 00463990
}
`],
  ])));
  const hand = `#include "Source/D2Client/UNIT/Player.h"
#include "Source/D2Common/Dungeon.h"
static LONG CALLBACK Handler(EXCEPTION_POINTERS* pEx) { return 0; }
static void HandleLine(char* line) {
    D2Wall2DrawContextStrc ctx;
    int mm[4] = { 0, 0, 0, 0 };
    D2Common::DUNGEON::Dungeon::DRLGROOM_GetMinimapRect((uint32_t)(uintptr_t)&ctx,
                                                        pR, mm);
}
extern "C" void D2CONTROL_Pump(void) {
    D2UnitStrc* pNpc = D2Client::UNIT::Player::UNITS_FindClientSideUnit(
        D2Client::_Interaction::nCurrentInteractedNpcGUID, UNIT_MONSTER);
}
`;

  it('drops the vanished argument, re-qualifies the moved function and includes its header', () => {
    const r = followHandFile(hand, before, after);
    assert.deepStrictEqual(r.errors, []);
    assert.ok(r.text.includes('D2Common::DUNGEON::Dungeon::DRLGROOM_GetMinimapRect(pR, mm);'), r.text);
    assert.ok(r.text.includes('D2Client::UNIT::CUnit::UNITS_FindClientSideUnit('), r.text);
    assert.ok(r.text.includes('#include "Source/D2Client/UNIT/Player.h"\n#include "Source/D2Client/UNIT/CUnit.h"\n'), r.text);
    assert.ok(r.text.includes('static LONG CALLBACK Handler'), 'everything else as written');
  });

  it('refuses to drop an argument with a side effect', () => {
    const r = followHandFile(hand.replace('(uint32_t)(uintptr_t)&ctx', 'Next(&ctx)'), before, after);
    assert.strictEqual(r.errors.length, 1);
    assert.match(r.errors[0], /dropped but has a side effect/u);
    assert.ok(r.text.includes('D2Client::UNIT::CUnit::UNITS_FindClientSideUnit('), 'the rest still follows');
  });
});

describe('ratchet: advancing on a measurement', () => {
  it('captures new MATCH bodies, reports phase noise and loss, retires a release', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-test-'));
    try {
      const store = new RatchetStore(dir);
      const ix = tree(HEADER_V1, UNIT_V1, GLOBALS);
      const audit = (a: string, b: string) => readAudit(`start\tend\tname\ttu\tmethod\tref_insns\tour_insns\tbyte_diffs\tsimilarity\tstatus\n00401000\t0\tGetLevel\tt\tm\t1\t1\t0\t1\t${a}\n00401100\t0\tAward\tt\tm\t1\t1\t0\t1\t${b}\n`);
      let rows = advance(ix, store, audit('MATCH', 'MATCH'), 'ev1');
      assert.deepStrictEqual(rows.map(r => r.status).sort(), ['new', 'new']);
      // Same tree, Award no longer matches: the tree carries the stored body -> phase noise.
      rows = advance(ix, store, audit('MATCH', 'INSN_MATCH'), 'ev2');
      assert.strictEqual(rows.find(r => r.address === '00401100')!.status, 'phase-noise');
      assert.ok(store.get('00401100'), 'phase noise keeps the record');
      // Another body in the tree: lost.
      const ix2 = tree(HEADER_V1, UNIT_V1.replace('nXp + nLevel', 'nLevel'), GLOBALS);
      rows = advance(ix2, store, audit('MATCH', 'OUR-1'), 'ev3');
      assert.strictEqual(rows.find(r => r.address === '00401100')!.status, 'lost');
      // Released and still not MATCH: the record and the release go.
      store.writeReleases([{ address: '00401100', reason: 'behaviour fix' }]);
      rows = advance(ix2, store, audit('MATCH', 'OUR-1'), 'ev4');
      assert.strictEqual(rows.find(r => r.address === '00401100')!.status, 'retired');
      assert.strictEqual(store.get('00401100'), undefined);
      assert.deepStrictEqual(store.releases(), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ratchet: in the generator', () => {
  it('keeps match records, ignores pins, and honours the ratchet:release tag', async () => {
    const { applyRatchetToProject } = await import('./generator.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-gen-'));
    try {
      const store = new RatchetStore(path.join(dir, 'store'));
      const old = tree(HEADER_V1, UNIT_V1, GLOBALS);
      store.put(record(old, '00401100'));
      store.put(record(tree(HEADER_V1, UNIT_V1.replace('return pUnit->nClassId + nStat;', 'TRACE(); return pUnit->nClassId + nStat;'), GLOBALS), '00401000', 'pin'));
      const fresh = UNIT_V1.replace('nXp + nLevel', 'nLevel + nXp');
      const project = (tags: boolean) => ({
        name: 'p', dataTypes: [], classes: [], namespaces: [],
        globals: [{ address: '00700000', name: 'gnTotal', namespace: 'Game::Unit', dataType: 'int', size: 4, isInitialized: false, xrefCount: 1 }],
        files: new Map([
          ['Source/G/Unit.h', { path: 'Source/G/Unit.h', content: HEADER_V1, type: 'header' as const, functions: [], includes: [] }],
          ['Source/G/Unit.cpp', { path: 'Source/G/Unit.cpp', content: fresh, type: 'implementation' as const, functions: [], includes: [] }],
        ]),
        sourceMaps: new Map([['Source/G/Unit.cpp.map', { version: 2, file: 'Source/G/Unit.cpp', functions: [
          { name: 'Award', address: '00401100', lines: [], ...(tags ? { ratchet: 'release' as const } : {}) },
        ] }]]),
      });
      const options = { outputDir: dir, projectDir: dir, projectConfig: { ratchet: { store: path.join(dir, 'store') } } } as never;
      const p1 = project(false);
      const r1 = applyRatchetToProject(p1 as never, options, `# h\n00700000\tGame::Unit::gnTotal\tint\n`);
      assert.strictEqual(r1.counts?.kept, 1);
      const text = p1.files.get('Source/G/Unit.cpp')!.content;
      assert.ok(text.includes('nXp + nLevel'), 'the MATCH body is kept');
      assert.ok(!text.includes('TRACE();'), 'a pin never enters source/regen');
      const p2 = project(true);
      const r2 = applyRatchetToProject(p2 as never, options, `# h\n00700000\tGame::Unit::gnTotal\tint\n`);
      assert.strictEqual(r2.counts?.released, 1);
      assert.ok(p2.files.get('Source/G/Unit.cpp')!.content.includes('nLevel + nXp'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
