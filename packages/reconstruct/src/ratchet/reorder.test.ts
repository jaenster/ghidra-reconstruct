/**
 * The ratchet through a parameter re-order (Game.exe v2097, deploy 1165): a kept body names
 * each parameter by its identity, never its position, and a kept call passes each argument to
 * the parameter it went to before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EXTERN_ENTRY_SUFFIX as HEADER_SUFFIX } from '../codegen/header.js';
import { parameterStorage } from '../codegen/sourcemap.js';
import { followHandFile } from './follow.js';
import { matchParams, paramIds, type ParamId } from './params.js';
import { applyRecords, capture, type ApplyRow } from './ratchet.js';
import { argumentOrder } from './rewrite.js';
import type { RatchetRecord } from './store.js';
import { EXTERN_ENTRY_SUFFIX, SymbolIndex, memoryTree, type MappedParams } from './symbol-index.js';

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

function body(ix: SymbolIndex, out: { changed: Map<string, string> }, address: string): string {
  const e = ix.extents.get(address)!;
  const text = out.changed.get(e.file) ?? ix.texts.get(e.file)!;
  const at = text.indexOf(`// 1.14d: ${address}`);
  const next = text.indexOf('// 1.14d: ', at + 10);
  return text.slice(at, next < 0 ? undefined : next).trim();
}

function rowsOf(rows: ApplyRow[], address: string): ApplyRow[] {
  return rows.filter(x => x.address === address);
}

// 004a5f10 INPUT_ConfigMouseDown (MATCH) and its static callee 004a4a10, whose two int32_t
// register parameters v2097 swapped (EAX and ECX here; storage unchanged).
const HEADER = `#pragma once
namespace D2Client::UI::ui {
uint32_t __stdcall INPUT_ConfigMouseDown(int32_t nX, int32_t nY); // 1.14d: 004a5f10
}
`;

const CALLEE_V1 = `// 1.14d: 004a4a10
static uint32_t UI_IsControlConfigCellClickable(int32_t nMousePosY, int32_t nMousePosX) {
    return nMousePosY - nMousePosX * 2;
}`;

const CALLER_V1 = `// 1.14d: 004a5f10
uint32_t __stdcall INPUT_ConfigMouseDown(int32_t nX, int32_t nY) {
    return UI_IsControlConfigCellClickable(nY, nX) + 1;
}`;

const unit = (callee: string, caller: string) => `#include "ui.h"
namespace D2Client::UI::ui {

${callee}

${caller}

} // namespace D2Client::UI::ui
`;

const swapSig = (s: string) => s.replace('(int32_t nMousePosY, int32_t nMousePosX)', '(int32_t nMousePosX, int32_t nMousePosY)');
const CALLEE_V2 = swapSig(CALLEE_V1);
const CALLER_V2 = CALLER_V1.replace('UI_IsControlConfigCellClickable(nY, nX)', 'UI_IsControlConfigCellClickable(nX, nY)');

const STORAGE_V1: MappedParams[] = [
  { address: '004a4a10', paramStorage: [['nMousePosY', 'EAX:4'], ['nMousePosX', 'ECX:4']] },
  { address: '004a5f10', paramStorage: [['nX', 'Stack[0x4]:4'], ['nY', 'Stack[0x8]:4']] },
];
const STORAGE_V2: MappedParams[] = [
  { address: '004a4a10', paramStorage: [['nMousePosX', 'ECX:4'], ['nMousePosY', 'EAX:4']] },
  { address: '004a5f10', paramStorage: [['nX', 'Stack[0x4]:4'], ['nY', 'Stack[0x8]:4']] },
];

const files = (callee: string, caller: string) => ({ 'Source/UI/ui.h': HEADER, 'Source/UI/ui.cpp': unit(callee, caller) });

describe('ratchet: a re-ordered parameter list', () => {
  for (const withStorage of [false, true]) {
    const how = withStorage ? 'by storage and name' : 'by name (a record without storage)';

    it(`calls the re-ordered function and its caller equal when only the order moved, ${how}`, () => {
      const rec = record(tree(files(CALLEE_V1, CALLER_V1), withStorage ? STORAGE_V1 : []), '004a5f10');
      assert.deepStrictEqual(rec.members.map(m => m.address), ['004a5f10', '004a4a10']);
      assert.strictEqual(rec.members[1].paramStorage?.join(','), withStorage ? 'EAX:4,ECX:4' : undefined);
      const now = tree(files(CALLEE_V2, CALLER_V2), withStorage ? STORAGE_V2 : []);
      const out = applyRecords(now, [rec]);
      assert.deepStrictEqual(out.rows.map(r => r.status), ['equal', 'equal'], JSON.stringify(out.rows));
      assert.strictEqual(out.changed.size, 0);
    });

    it(`keeps the same-typed parameters of the function itself apart, ${how}`, () => {
      const rec = record(tree(files(CALLEE_V1, CALLER_V1), withStorage ? STORAGE_V1 : []), '004a5f10');
      // The generator also printed the callee another way: the stored body is kept.
      const fresh = CALLEE_V2.replace('return nMousePosY - nMousePosX * 2;', 'int32_t n = nMousePosY;\n    return n - nMousePosX * 2;');
      const now = tree(files(fresh, CALLER_V2), withStorage ? STORAGE_V2 : []);
      const out = applyRecords(now, [rec]);
      assert.strictEqual(rowsOf(out.rows, '004a4a10')[0].status, 'kept');
      const kept = body(now, out, '004a4a10');
      assert.ok(kept.includes('(int32_t nMousePosX, int32_t nMousePosY)'), 'the signature is the fresh one');
      assert.ok(kept.includes('return nMousePosY - nMousePosX * 2;'), kept);
    });

    it(`passes each argument of a kept call to the parameter it went to, ${how}`, () => {
      const rec = record(tree(files(CALLEE_V1, CALLER_V1), withStorage ? STORAGE_V1 : []), '004a5f10');
      const fresh = CALLER_V2.replace('return UI_IsControlConfigCellClickable(nX, nY) + 1;', 'uint32_t r = UI_IsControlConfigCellClickable(nX, nY);\n    return r + 1;');
      const now = tree(files(CALLEE_V2, fresh), withStorage ? STORAGE_V2 : []);
      const out = applyRecords(now, [rec]);
      assert.strictEqual(rowsOf(out.rows, '004a5f10')[0].status, 'kept');
      const kept = body(now, out, '004a5f10');
      assert.ok(kept.includes('return UI_IsControlConfigCellClickable(nX, nY) + 1;'), kept);
    });
  }

  it('reports names that changed storage, and lets the fresh body through', () => {
    // The names now sit on the other register: a re-order or a correction of which name is
    // which value, and nothing tells them apart.
    const rec = record(tree(files(CALLEE_V1, CALLER_V1), STORAGE_V1), '004a5f10');
    const fresh = CALLEE_V2.replace('return nMousePosY - nMousePosX * 2;', 'return nMousePosX - nMousePosY * 2;');
    const now = tree(files(fresh, CALLER_V2), [
      { address: '004a4a10', paramStorage: [['nMousePosX', 'EAX:4'], ['nMousePosY', 'ECX:4']] },
      STORAGE_V2[1],
    ]);
    const out = applyRecords(now, [rec]);
    const r = rowsOf(out.rows, '004a4a10')[0];
    assert.strictEqual(r.status, 'unresolved');
    assert.match(r.detail, /nMousePosY@EAX:4 is ambiguous: its storage is nMousePosX@EAX:4 now, its name nMousePosY@ECX:4/u);
    assert.ok(body(now, out, '004a4a10').includes('return nMousePosX - nMousePosY * 2;'), 'the fresh body stays');
  });

  it('re-orders a same-typed call to a callee outside the record', () => {
    const header = `namespace G {
int __stdcall Sub(int nA, int nB); // 1.14d: 00401000
int __stdcall Use(int n); // 1.14d: 00401100
}
`;
    const u = (sig: string, call: string, extra = '') => `namespace G {
// 1.14d: 00401000
int __stdcall Sub(${sig}) {
    return nA - nB;
}
// 1.14d: 00401100
int __stdcall Use(int n) {
    ${extra}return ${call};
}
}
`;
    const rec = record(tree({ 'Source/G.h': header, 'Source/G.cpp': u('int nA, int nB', 'Sub(n, 7)') }), '00401100');
    const now = tree({ 'Source/G.h': header.replace('Sub(int nA, int nB)', 'Sub(int nB, int nA)'), 'Source/G.cpp': u('int nB, int nA', 'Sub(7, n)', 'n = n;\n    ') });
    const out = applyRecords(now, [rec]);
    assert.strictEqual(rowsOf(out.rows, '00401100')[0].status, 'kept');
    assert.ok(body(now, out, '00401100').includes('return Sub(7, n);'));
  });
});

describe('ratchet: parameter storage from the source maps', () => {
  it('the map carries each declared parameter with its storage, only when all have one', () => {
    const p = (name: string, storage?: string) => ({ name, dataType: 'int32_t', size: 4, ordinal: 0, ...(storage ? { storage } : {}) });
    const f = (params: unknown[]) => ({ address: '004a4a10', name: 'UI_IsControlConfigCellClickable', parameters: params }) as never;
    assert.deepStrictEqual(parameterStorage(f([p('nMousePosX', 'ECX:4'), p('nMousePosY', 'EAX:4')])), [['nMousePosX', 'ECX:4'], ['nMousePosY', 'EAX:4']]);
    assert.strictEqual(parameterStorage(f([p('nMousePosX', 'ECX:4'), p('nMousePosY')])), undefined);
  });

  it('reaches the generator: storage that contradicts the names is reported there', async () => {
    const { applyRatchetToProject } = await import('./generator.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-reorder-'));
    try {
      const { RatchetStore } = await import('./store.js');
      const store = new RatchetStore(path.join(dir, 'store'));
      store.put(record(tree(files(CALLEE_V1, CALLER_V1), STORAGE_V1), '004a5f10'));
      const fresh = files(CALLEE_V2.replace('return nMousePosY - nMousePosX * 2;', 'return nMousePosX - nMousePosY * 2;'), CALLER_V2);
      const project = (storage: MappedParams[]) => ({
        name: 'p', dataTypes: [], classes: [], namespaces: [], globals: [],
        files: new Map(Object.entries(fresh).map(([k, v]) => [k, { path: k, content: v, type: 'implementation' as const, functions: [], includes: [] }])),
        sourceMaps: new Map([['Source/UI/ui.cpp.map', { version: 2, file: 'Source/UI/ui.cpp', functions: storage.map(m => ({ name: '', lines: [], ...m })) }]]),
      });
      const options = { outputDir: dir, projectDir: dir, projectConfig: { ratchet: { store: path.join(dir, 'store') } } } as never;
      const ok = applyRatchetToProject(project(STORAGE_V2) as never, options, '');
      assert.strictEqual(ok.counts?.unresolved, 0);
      assert.strictEqual(ok.counts?.kept, 1, 'the stored callee body, its parameters bound by identity');
      const swapped = applyRatchetToProject(project([{ address: '004a4a10', paramStorage: [['nMousePosX', 'EAX:4'], ['nMousePosY', 'ECX:4']] }, STORAGE_V2[1]]) as never, options, '');
      assert.ok((swapped.counts?.unresolved ?? 0) >= 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The 25 static callees v2097 re-ordered (regcallee/final-spec.json): new position k holds
// the parameter that was at spec[k].
const SPEC_1165: Record<string, number[]> = {
  '0052d0c0': [1, 0], '00537ab0': [1, 0], '00548a50': [0, 1, 3, 2, 4], '0054e190': [0, 2, 1, 3],
  '005573f0': [1, 0, 2], '0056e000': [0, 2, 1], '0058dd30': [0, 2, 1], '006c3da0': [1, 0, 2],
  '0041e250': [3, 1, 2, 0], '00463940': [3, 1, 2, 0], '00465e80': [3, 2, 1, 0], '004a4a10': [1, 0],
  '004c6140': [1, 0, 2, 3], '004e9160': [0, 1, 2, 3, 5, 4], '0057edd0': [2, 1, 0], '0061e4a0': [1, 0],
  '0063add0': [2, 1, 0], '0063c4c0': [2, 1, 0], '006c5a90': [2, 1, 0], '004234f0': [0, 1, 3, 2],
  '00420f80': [3, 0, 2, 1], '00550220': [0, 1, 4, 2, 3], '005502f0': [0, 1, 2, 4, 3], '0064c4c0': [2, 1, 0, 3],
  '0064c580': [2, 1, 0, 3],
};

describe('ratchet: parameter identity (params.ts)', () => {
  const REGS = ['EAX:4', 'ECX:4', 'EDX:4', 'EBX:4', 'ESI:4', 'EDI:4'];
  // The 1165 shape: register parameters re-ordered, a stack parameter stays where it was.
  const before = (n: number): ParamId[] => Array.from({ length: n }, (_, k) => ({ name: `p${k}`, storage: k < 5 ? REGS[k] : `Stack[0x${(4 * (k - 4)).toString(16)}]:4` }));

  for (const [address, perm] of Object.entries(SPEC_1165)) {
    it(`recovers the v2097 order of ${address} from storage, from names, and from both`, () => {
      const b = before(perm.length);
      const a = perm.map(k => b[k]);
      const expect = perm.map((_, k) => perm.indexOf(k));
      const both = matchParams(b, a);
      const names = matchParams(b.map(p => ({ name: p.name })), a.map(p => ({ name: p.name })));
      const storage = matchParams(b.map(p => ({ name: `old_${p.name}`, storage: p.storage })), a.map(p => ({ name: `new_${p.name}`, storage: p.storage })));
      for (const m of [both, names, storage]) assert.deepStrictEqual(m, { map: expect });
      // A kept call passes the argument that was at perm[k] to the new parameter k.
      assert.deepStrictEqual(argumentOrder(b, a, b.map(() => true)), perm);
    });
  }

  it('treats a stack layout change as no re-order', () => {
    // A register parameter moved to the stack shifts every slot after it.
    const m = matchParams(paramIds(['a', 'b'], ['ECX:4', 'Stack[0x4]:4']), paramIds(['a', 'b'], ['Stack[0x4]:4', 'Stack[0x8]:4']));
    assert.deepStrictEqual(m, { map: [0, 1] });
  });

  it('reports stack names swapped over the same layout', () => {
    const m = matchParams(paramIds(['a', 'b'], ['Stack[0x4]:4', 'Stack[0x8]:4']), paramIds(['b', 'a'], ['Stack[0x4]:4', 'Stack[0x8]:4']));
    assert.ok('error' in m && /ambiguous/u.test(m.error), JSON.stringify(m));
  });

  it('keeps a renamed parameter in place unless another claims its position', () => {
    assert.deepStrictEqual(matchParams(paramIds(['a', 'b']), paramIds(['a', 'c'])), { map: [0, 1] });
    const m = matchParams(paramIds(['a', 'b']), paramIds(['c', 'a']));
    assert.ok('error' in m && /kept neither its storage nor its name/u.test(m.error), JSON.stringify(m));
    assert.match(String(argumentOrder(paramIds(['a', 'b']), paramIds(['c', 'a']), [true, true])), /kept neither/u);
  });

  it('refuses an arity change', () => {
    assert.deepStrictEqual(matchParams(paramIds(['a']), paramIds(['a', 'b'])), { error: 'arity changed: 1 -> 2 parameters' });
  });

  it('ignores storage that does not belong to the emitted names', () => {
    const ix = tree({ 'Source/G.cpp': '// 1.14d: 00401000\nint __stdcall F(int nA, int nB) {\n    return nA;\n}\n' },
      [{ address: '00401000', paramStorage: [['param_1', 'Stack[0x4]:4'], ['nB', 'Stack[0x8]:4']] }]);
    assert.strictEqual(ix.fnByAddr.get('00401000')!.storage, undefined);
  });
});

describe('ratchet: hand files call through extern entries', () => {
  assert.strictEqual(EXTERN_ENTRY_SUFFIX, HEADER_SUFFIX);
  // 1165: Redivivus/d2_control.cpp called two extern entries of static callees v2097
  // re-ordered; the merge left the calls as written and the link gate failed (df5778550).
  const modes = (sig: string, name = 'PLRMODES_CanInterruptCurrentMode') => `namespace D2Game::PLAYER::PlayerModes {
// 1.14d: 0057edd0
static BOOL ${name}(${sig}) {
    return 0;
}

// Extern entry for hand-written callers: ${name} itself keeps its unit's linkage.
BOOL ${name}_Extern(${sig}) {
    return ::D2Game::PLAYER::PlayerModes::${name}(${sig.split(', ').map(p => p.split(' ').pop()).join(', ')});
}
}
`;
  const skills = (sig: string) => `namespace D2Client::SKILLS::Skills {
// 1.14d: 004c6140
static int32_t __fastcall SKILLS_CastSkillClient(${sig}) {
    return 0;
}
}
`;
  const V1 = { modes: 'D2UnitStrc * pUnit, ::SGAMEDATA * pGame, uint32_t nNewMode', skills: 'eD2Skills eSkill, D2UnitStrc * pUnit, int32_t nOwnerGUID, uint32_t nSkillLevel' };
  const V2 = { modes: 'uint32_t nNewMode, ::SGAMEDATA * pGame, D2UnitStrc * pUnit', skills: 'D2UnitStrc * pUnit, eD2Skills eSkill, int32_t nOwnerGUID, uint32_t nSkillLevel' };
  const before = tree({ 'Source/PlayerModes.cpp': modes(V1.modes), 'Source/Skills.cpp': skills(V1.skills) });
  const after = tree({ 'Source/PlayerModes.cpp': modes(V2.modes), 'Source/Skills.cpp': skills(V2.skills) });
  const hand = `static void HandleLine(char* line) {
        int nCanInt = (int)D2Game::PLAYER::PlayerModes::PLRMODES_CanInterruptCurrentMode_Extern(pSrv, pGame, (uint32_t)nMode);
            int nCast  = (int)D2Client::SKILLS::Skills::SKILLS_CastSkillClient_Extern(
                                  (eD2Skills)msg.nSkillId, pPl, (int32_t)msg.nItemId, msg.nSkillLvl);
}
`;

  it('re-orders the arguments of a call through an extern entry', () => {
    const r = followHandFile(hand, before, after);
    assert.deepStrictEqual(r.errors, []);
    assert.ok(r.text.includes('PLRMODES_CanInterruptCurrentMode_Extern((uint32_t)nMode, pGame, pSrv);'), r.text);
    // As df5778550 wrote it by hand: the line break stays where it was.
    assert.ok(r.text.includes('SKILLS_CastSkillClient_Extern(\n                                  pPl, (eD2Skills)msg.nSkillId, (int32_t)msg.nItemId, msg.nSkillLvl);'), r.text);
  });

  it('renames an extern entry with its function', () => {
    const renamed = tree({ 'Source/PlayerModes.cpp': modes(V1.modes, 'PLRMODES_CanInterrupt'), 'Source/Skills.cpp': skills(V1.skills) });
    const r = followHandFile(hand, before, renamed);
    assert.ok(r.text.includes('D2Game::PLAYER::PlayerModes::PLRMODES_CanInterrupt_Extern(pSrv, pGame, (uint32_t)nMode)'), r.text);
  });

  it('reports a call it cannot delimit and leaves it as written', () => {
    const odd = hand.replace('(pSrv, pGame, (uint32_t)nMode)', '(pSrv,\n#if 1\n pGame,\n#endif\n (uint32_t)nMode)')
      .replace('(int32_t)msg.nItemId, msg.nSkillLvl', 'a < b, c > d');
    const r = followHandFile(odd, before, after);
    assert.strictEqual(r.errors.length, 2, r.errors.join('\n'));
    assert.ok(r.errors.every(e => /cannot be delimited/u.test(e)), r.errors.join('\n'));
    assert.ok(r.text.includes('(pSrv,\n#if 1\n pGame,\n#endif\n (uint32_t)nMode)'), 'left as written');
    assert.ok(r.text.includes('_Extern(\n                                  (eD2Skills)msg.nSkillId, pPl, a < b, c > d);'), 'left as written');
  });

  it('reports a re-ordered function whose address is taken', () => {
    const r = followHandFile('static void* p = (void*)&D2Game::PLAYER::PlayerModes::PLRMODES_CanInterruptCurrentMode_Extern;\n', before, after);
    assert.strictEqual(r.errors.length, 1);
    assert.match(r.errors[0], /is named but not called/u);
    assert.strictEqual(r.changed, false);
  });
});
