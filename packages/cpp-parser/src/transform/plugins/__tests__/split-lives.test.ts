/**
 * split-lives: values VC8 kept in one slot, which the decompiler merged into one
 * variable, each get a local of their own when reaching definitions prove they never meet.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { splitLivesPlugin, type SplitLivesOptions } from '../builtins/split-lives.js';
import { compileAndRun, hasNativeGpp, testToolchain } from '../../../testing/native-cpp.js';

// A pointer kept in an int is the 32-bit target's habit: the check needs the target's word size.
const native = { skip: !hasNativeGpp() || testToolchain()?.name !== 'mingw' };

const STR = 'D2Lang::StrTable::strtable::GetLocaleString';
const O: SplitLivesOptions = {
  slots: [],
  functionReturnTypes: { [STR]: 'ushort *', GetLocaleString: 'ushort *', 'Units::GetRoom': 'D2RoomStrc *', GetRoom: 'D2RoomStrc *' },
};

const run = (code: string, o: SplitLivesOptions = O) =>
  emit(splitLivesPlugin.createTransformer(o)(parse(code)) as AnyNode).trim();
const flat = (s: string) => s.replace(/\s+/g, ' ');
/** Spacing-blind: the emitter spells `T*`, the tests `T *`. */
const norm = (s: string) => flat(s).replace(/\s*\*\s*/g, '*').replace(/\(\s+/g, '(');
const has = (out: string, snippet: string) => assert.ok(norm(out).includes(norm(snippet)), `${snippet}\n${out}`);

describe('split-lives', () => {
  it('ItemStatCost_DescFunc_DGrpFunc @004e4d80: a string in two integer parameters\' slots, one local each', () => {
    const out = run(`int f(int nStatId, int nStatValue, int nMode, ushort *wszOut) {
      g(nStatId, nStatValue);
      nStatId = (int)${STR}(3);
      nStatValue = (int)${STR}(0xf9b);
      switch (nMode) {
      case 1:
        Copy(wszOut, (ushort *)nStatId);
        Append(wszOut, (ushort *)nStatValue);
        break;
      case 2:
        Append(wszOut, (ushort *)nStatValue);
        Copy(wszOut, (ushort *)nStatId);
        break;
      }
      return 0;
    }`);
    has(out, 'ushort *pStatId;');
    has(out, 'ushort *pStatValue;');
    has(out, `pStatId = ${STR}(3);`);
    has(out, 'Copy(wszOut, pStatId);');
    has(out, 'Append(wszOut, pStatValue);');
    has(out, 'g(nStatId, nStatValue);');
  });

  it('gives every later life its own local and keeps the merged local out of the way', () => {
    const out = run(`int f(D2UnitStrc *p) {
      int nSkillId;
      nSkillId = (int)Units::GetRoom(p);
      h((D2RoomStrc *)nSkillId);
      nSkillId = (int)p->pNext;
      k((D2UnitStrc *)nSkillId);
      k((D2UnitStrc *)nSkillId);
      return 0;
    }`);
    has(out, 'D2RoomStrc *pRoom;');
    has(out, 'D2UnitStrc *pUnit;');
    assert.ok(!/int nSkillId;/.test(out), 'the variable no read is left on goes: ' + out);
    has(out, 'pUnit = (D2UnitStrc *)(int)p->pNext;');
  });

  it('keeps a join: a read reached by stores of two types is one variable', () => {
    const src = `int f(D2UnitStrc *p, int c) {
      int nX;
      if (c) nX = (int)Units::GetRoom(p);
      else nX = (int)${STR}(1);
      return h((D2RoomStrc *)nX);
    }`;
    const lines: string[] = [];
    const out = run(src, { ...O, onReport: (_f, l) => lines.push(l) });
    assert.strictEqual(flat(out), flat(run(src, {})));
    assert.ok(lines.length === 0 || !lines.some(l => /split/.test(l)), lines.join('\n'));
  });

  it('leaves a loop around the store (the entry value meets the stored one)', () => {
    const src = `void f(D2UnitStrc *pOwner, int nStatId) {
      while (g(nStatId)) {
        nStatId = (int)Units::GetRoom(pOwner);
        h((D2RoomStrc *)nStatId);
      }
    }`;
    assert.strictEqual(flat(run(src)), flat(run(src, {})));
  });

  it('leaves a variable whose address is taken, or in a frame whose slot address escapes', () => {
    const own = `void f(D2UnitStrc *p, int nStatId) { g(&nStatId); nStatId = (int)Units::GetRoom(p); h((D2RoomStrc *)nStatId); h((D2RoomStrc *)nStatId); }`;
    assert.strictEqual(flat(run(own)), flat(run(own, {})));
    // A local above a slot whose address leaves the frame may become a frame-object member.
    const frame = `void f(D2UnitStrc *p) { int a; int nX; g(&a); nX = 5; k(nX); nX = (int)Units::GetRoom(p); h((D2RoomStrc *)nX); h((D2RoomStrc *)nX); }`;
    const above = { ...O, slots: [{ name: 'a', offset: -0x10, size: 4 }, { name: 'nX', offset: -0xc, size: 4 }] };
    assert.strictEqual(flat(run(frame, above)), flat(run(frame, {})));
    // Below it, or when g is known to touch only the word it is handed, it cannot.
    const below = { ...O, slots: [{ name: 'a', offset: -0x10, size: 4 }, { name: 'nX', offset: -0x14, size: 4 }] };
    assert.ok(/pRoom/.test(run(frame, below)));
    assert.ok(/pRoom/.test(run(frame, { ...above, argReach: () => ({ lo: 0, hi: 4 }) as never })));
    assert.ok(!/pRoom/.test(run(frame, { ...above, argReach: () => ({ lo: 0, hi: 8 }) as never })));
  });

  it('AITHINK_Fn1_Vulture @005f3170: a pointer that only holds a slot\'s address bounds its escape by its own uses', () => {
    const frame = `void f(D2UnitStrc *p) { int a; int nX; int *pA; pA = &a; g(pA); nX = 5; k(nX); nX = (int)Units::GetRoom(p); h((D2RoomStrc *)nX); h((D2RoomStrc *)nX); }`;
    const above = { ...O, slots: [{ name: 'a', offset: -0x10, size: 4 }, { name: 'nX', offset: -0xc, size: 4 }] };
    const seen: string[] = [];
    const reach = (hi: number) => (_b: unknown, name: string, type: string, opts: { include: (u: never) => boolean }) => {
      seen.push(`${name}:${type}:${typeof opts.include}`);
      return { lo: 0, hi };
    };
    assert.ok(/pRoom/.test(run(frame, { ...above, bodyReach: reach(4) as never })));
    assert.deepStrictEqual(seen, ['pA:int*:function']);
    assert.ok(!/pRoom/.test(run(frame, { ...above, bodyReach: reach(8) as never })));
    assert.ok(!/pRoom/.test(run(frame, { ...above, bodyReach: (() => null) as never })));
    // Any other store into the pointer, or one at its declaration, leaves the escape unknown.
    const other = frame.replace('g(pA);', 'g(pA); pA = pA + 1;');
    assert.ok(!/pRoom/.test(run(other, { ...above, bodyReach: reach(4) as never })));
    const init = frame.replace('int *pA; pA = &a;', 'int *pA = &a;');
    assert.ok(!/pRoom/.test(run(init, { ...above, bodyReach: reach(4) as never })));
  });

  it('SFileOpenFileEx @004192f0: the /GS cookie seed names the frame but reaches nothing', () => {
    const frame = (seed: string) => `void f(D2UnitStrc *p) { uint dwCookie; int nX; int a; ${seed} a = 1; k(a); nX = 5; k(nX); nX = (int)Units::GetRoom(p); h((D2RoomStrc *)nX); h((D2RoomStrc *)nX); }`;
    // Ghidra's frame does not carry the cookie's slot: `&stack0xfffffffc` is a frame base.
    const slots = { ...O, slots: [{ name: 'nX', offset: -0x10, size: 4 }, { name: 'a', offset: -0xc, size: 4 }] };
    assert.ok(/pRoom/.test(run(frame('dwCookie = DEFAULT_SECURITY_COOKIE ^ (uint)&stack0xfffffffc;'), slots)));
    // A cookie local read anywhere else keeps the seed, and the frame base with it.
    assert.ok(!/pRoom/.test(run(frame('dwCookie = DEFAULT_SECURITY_COOKIE ^ (uint)&stack0xfffffffc; k(dwCookie);'), slots)));
    // Any other frame base reaches the lowest local.
    assert.ok(!/pRoom/.test(run(frame('k((int)&stack0xfffffff0);'), slots)));
  });

  it('004e4d80: a value whose address a call is handed stays, a later one moves, when the callee keeps only the word', () => {
    const src = `int f(int nStatValue, ushort *wszOut) {
      nStatValue = 1;
      MinMax(3, &nStatValue);
      if (nStatValue == 0) return 0;
      nStatValue = (int)${STR}(0xf9b);
      Append(wszOut, (ushort *)nStatValue);
      Append(wszOut, (ushort *)nStatValue);
      return 1;
    }`;
    const word = run(src, { ...O, argReach: () => ({ lo: 0, hi: 4 }) as never });
    has(word, 'MinMax(3, &nStatValue);');
    has(word, 'if (nStatValue == 0)');
    has(word, `pStatValue = ${STR}(0xf9b);`);
    has(word, 'Append(wszOut, pStatValue);');
    // A callee that may keep the address, or reach past the word: the variable stays one.
    assert.strictEqual(flat(run(src)), flat(run(src, {})));
    assert.strictEqual(flat(run(src, { ...O, argReach: () => null })), flat(run(src, {})));
    assert.strictEqual(flat(run(src, { ...O, argReach: () => ({ lo: 0, hi: 8 }) as never })), flat(run(src, {})));
  });

  it('Fog::Memory::Alloc @0040a080: an out-parameter call starts a new value in a dead parameter\'s slot', () => {
    const src = `void *f(D2PoolStrc *pPool, int32_t Line) {
      g(Line);
      FindBlock((D2PoolBlockStrc **)&Line, pPool);
      if (Line == 0) return 0;
      *(int *)(Line + 8) = *(int *)(Line + 8) + 1;
      return *(D2PoolBlockStrc **)(Line + 0x10);
    }`;
    const both = { ...O, argReach: () => ({ lo: 0, hi: 4 }) as never, outParamWidth: () => 4 };
    const out = run(src, both);
    has(out, 'D2PoolBlockStrc *pPoolBlock;');
    has(out, 'FindBlock((D2PoolBlockStrc **)&pPoolBlock, pPool);');
    has(out, 'g(Line);');
    has(out, '*(int *)((int32_t)pPoolBlock + 8)');
    // Not an out-parameter: the call may read the parameter, which stays one variable.
    assert.strictEqual(flat(run(src, { ...both, outParamWidth: () => null })), flat(run(src, {})));
  });

  it('AUTOMAP_DrawXMarker: an index added to a table\'s address is not an address itself', () => {
    const src = `void f(int nX) {
      uint nOffset;
      g(nX);
      nOffset = 0;
      do {
        h(*(int *)((int)&gaPolyline[0].x + nOffset), *(int *)((int)&gaPolyline[1].y + nOffset));
        nOffset = nOffset + 8;
      } while (nOffset < 0x60);
    }`;
    assert.strictEqual(flat(run(src)), flat(run(src, {})));
  });

  it('WapperSaveGameAllGameTypes @0052e9e0: a GUID in a dead item pointer, its literal stored as the number', () => {
    const out = run(`int f(D2UnitStrc *pSourceItem, D2UnitStrc *pItem) {
      g(pSourceItem);
      if (pItem == 0) {
        pSourceItem = (D2UnitStrc *)-1;
      } else {
        pSourceItem = (D2UnitStrc *)pItem->nUnitGUID;
      }
      return Place((int32_t)pSourceItem, 1);
    }`, { ...O, structFields: { D2UnitStrc: { nUnitGUID: 'int' } } });
    has(out, 'nSourceItem = -1;');
    has(out, 'nSourceItem = pItem->nUnitGUID;');
    has(out, 'Place(nSourceItem, 1)');
  });

  it('leaves a local with a single value that is read: that is a mistyped variable, not a shared slot', () => {
    const src = `int f(D2QuestDataStrc *pQuestData) {
      D2QuestDataA1Q5Strc *pDVar1;
      pDVar1 = pQuestData->pA1Q5;
      g((int)pDVar1);
      return (int)pDVar1;
    }`;
    assert.strictEqual(flat(run(src)), flat(run(src, {})));
  });

  it('a store inside a condition moves; a zero test reads the pointer as it read the integer', () => {
    const out = run(`int f(D2UnitStrc *p, int nStatId) { g(nStatId); if ((nStatId = (int)Units::GetRoom(p)) != 0) h((D2RoomStrc *)nStatId); return 0; }`);
    has(out, 'if ((pRoom = Units::GetRoom(p)) != 0) h(pRoom);');
  });

  it('a store whose value the expression uses as a number keeps the declared type there', () => {
    const out = run(`int f(D2UnitStrc *p, int nStatId) { g(nStatId); k((nStatId = (int)Units::GetRoom(p)) + 4); h((D2RoomStrc *)nStatId); h((D2RoomStrc *)nStatId); return 0; }`);
    has(out, 'k((int)(pRoom = Units::GetRoom(p)) + 4);');
  });

  it('a store under && reaches the paths that evaluate it: the true branch sees only it', () => {
    const out = run(`int f(D2UnitStrc *p, int nStatId, int c) { g(nStatId); if (c && (nStatId = (int)Units::GetRoom(p)) != 0) h((D2RoomStrc *)nStatId); return 0; }`);
    has(out, 'if (c && (pRoom = Units::GetRoom(p)) != 0) h(pRoom);');
    has(out, 'g(nStatId);');
  });

  it('DGrpFunc @004e4d80: a store in the right of || with a comma reaches the false path whole', () => {
    const out = run(`int f(D2UnitStrc *p, int nStatId, int c) { g(nStatId); if (c == 0 || (nStatId = (int)Units::GetRoom(p), (D2RoomStrc *)nStatId == 0)) return 0; h((D2RoomStrc *)nStatId); return 1; }`);
    has(out, 'if (c == 0 || (pRoom = Units::GetRoom(p) , pRoom == 0)) return 0;');
    has(out, 'h(pRoom);');
  });

  it('a read some paths reach without the store in the condition stays joined with the entry value', () => {
    const maybe = `int f(D2UnitStrc *p, int nStatId, int c) { if (c && (nStatId = (int)Units::GetRoom(p)) != 0) k(); h((D2RoomStrc *)nStatId); return 0; }`;
    assert.strictEqual(flat(run(maybe)), flat(run(maybe, {})));
    const either = `int f(D2UnitStrc *p, int nStatId, int c) { g(nStatId); if (c != 0 || (nStatId = (int)Units::GetRoom(p)) != 0) h((D2RoomStrc *)nStatId); return 0; }`;
    assert.strictEqual(flat(run(either)), flat(run(either, {})));
  });

  it('leaves a store beside a read of the variable in one operand', () => {
    const beside = `int f(D2UnitStrc *p, int nStatId) { g(nStatId); if ((nStatId = (int)Units::GetRoom(p)) != nStatId) h((D2RoomStrc *)nStatId); return 0; }`;
    assert.strictEqual(flat(run(beside)), flat(run(beside, {})));
  });

  it('leaves a life that would need more casts than it saves', () => {
    const ints = `int f(D2UnitStrc *p, int nStatId) { g(nStatId); nStatId = (int)Units::GetRoom(p); return nStatId + nStatId * 2 + (int)(D2RoomStrc *)nStatId; }`;
    assert.ok(!/pRoom/.test(run(ints)), run(ints));
  });

  it('TILECMP_DeserializeAndFixup @0060a0f0: a life that stores a pointer never becomes an integer local', () => {
    const code = `void f(D2UnitStrc *p, void **ppOut, int n) {
      void *nErrAddress;
      nErrAddress = (void *)n;
      g((int)nErrAddress);
      nErrAddress = Units::GetRoom(p);
      *ppOut = nErrAddress;
      h((intptr_t)nErrAddress - 4, (intptr_t)nErrAddress + 8, (intptr_t)nErrAddress);
    }`;
    const out = run(code);
    // The integer life may have a local of its own; the address stays in the pointer.
    assert.ok(!/\(int\)Units::GetRoom/.test(flat(out)), out);
    has(out, 'nErrAddress = Units::GetRoom(p);');
    has(out, '*ppOut = nErrAddress;');
  });

  it('COLLISION distance in a unit pointer: an integer store moves without the pointer cast', () => {
    const out = run(`int f(D2UnitStrc *pUnit, int nX, int nY) {
      g(pUnit);
      pUnit = (D2UnitStrc *)(nX - nY);
      if ((intptr_t)pUnit < 0) {
        pUnit = (D2UnitStrc *)-(intptr_t)pUnit;
      }
      if ((intptr_t)pUnit < 8) return 1;
      return (intptr_t)pUnit - nY;
    }`);
    has(out, '= nX - nY;');
    has(out, '= -n');
    assert.ok(!/\(int\)\s*\(D2UnitStrc/.test(flat(out)), out);
  });

  it('moves an update with its life, through the declared type', () => {
    const out = run(`int f(int nAlpha, int n) {
      g(nAlpha);
      nAlpha = (int)Units::GetRoom(0);
      do {
        *(float *)(nAlpha + 4) = 1.0;
        *(float *)nAlpha = 2.0;
        h((D2RoomStrc *)nAlpha);
        nAlpha = nAlpha + 0x120;
        n = n - 1;
      } while (n != 0);
      return 0;
    }`);
    has(out, 'D2RoomStrc *pRoom;');
    has(out, '*(float *)((int)pRoom + 4) = 1.0;');
    has(out, '*(float *)pRoom = 2.0;');
    has(out, 'pRoom = (D2RoomStrc *)((int)pRoom + 0x120);');
  });

  it('computes what the merged variable computed', native, () => {
    const prelude = `
      #include <stdint.h>
      struct D2RoomStrc { int a; float f[4]; D2RoomStrc *pNext; };
      static D2RoomStrc gRooms[3];
      namespace Units { static D2RoomStrc *GetRoom(int i) { return &gRooms[i]; } }
      static int g(int x) { return x * 3; }
      static int h(D2RoomStrc *r) { return r->a; }`;
    const fn = `int f(int nAlpha, int n) {
        int nSum;
        int nSkillId;
        nSum = g(nAlpha);
        nAlpha = (int)(intptr_t)Units::GetRoom(1);
        do {
          *(float *)(nAlpha + 4) = 1.5f;
          nSum = nSum + h((D2RoomStrc *)nAlpha) + (int)*(float *)(nAlpha + 4);
          nAlpha = nAlpha + 0x18;
          n = n - 1;
        } while (n != 0);
        nSkillId = (int)(intptr_t)Units::GetRoom(0);
        nSkillId++;
        nSkillId = nSkillId + 3;
        return nSum + h((D2RoomStrc *)(intptr_t)nAlpha) + (int)(nSkillId & 0xff);
      }`;
    const out = run(fn);
    const call = 'gRooms[0].a = 5; gRooms[1].a = 7; gRooms[2].a = 9; printf("%d\\n", f(4, 2));';
    assert.strictEqual(compileAndRun(prelude + out, call), compileAndRun(prelude + fn, call));
  });

  it('a store under || and && computes what the merged variable computed, on every path', native, () => {
    const prelude = `
      #include <stdint.h>
      struct D2RoomStrc { int a; };
      static D2RoomStrc gRooms[3];
      static int gCalls;
      namespace Units { static D2RoomStrc *GetRoom(int i) { gCalls++; return i < 0 ? 0 : &gRooms[i]; } }
      static int g(int x) { return x * 3; }
      static int h(D2RoomStrc *r) { return r->a; }`;
    const fn = `int f(int nStatId, int c, int i) {
        int nSum;
        nSum = g(nStatId);
        if (c == 0 || (nStatId = (int)Units::GetRoom(i), (D2RoomStrc *)nStatId == 0)) return nSum - 1;
        nSum = nSum + h((D2RoomStrc *)nStatId);
        if (c > 1 && (nStatId = (int)Units::GetRoom(i - 1)) != 0) nSum = nSum + h((D2RoomStrc *)nStatId);
        return nSum;
      }`;
    const out = run(fn);
    has(out, 'if (c == 0 || (pRoom2 = Units::GetRoom(i) , pRoom2 == 0))');
    has(out, 'if (c > 1 && (pRoom = Units::GetRoom(i - 1)) != 0)');
    const call = 'gRooms[0].a = 5; gRooms[1].a = 7; gRooms[2].a = 9;'
      + ' for (int c = 0; c < 3; c++) for (int i = -1; i < 3; i++) printf("%d %d,", f(4, c, i), gCalls); printf("\\n");';
    assert.strictEqual(compileAndRun(prelude + out, call), compileAndRun(prelude + fn, call));
  });

  it('GAMBLE_GenerateGambleInventory: int and int32_t reads are one integer type', () => {
    const out = run(`int f(D2UnitStrc *pPlayerUnit, int nLevel) {
      g(pPlayerUnit);
      pPlayerUnit = (D2UnitStrc *)(nLevel - 5);
      if ((intptr_t)pPlayerUnit > 5) h((int32_t)pPlayerUnit);
      return (int)pPlayerUnit;
    }`);
    has(out, 'nPlayerUnit = nLevel - 5;');
    has(out, 'if (nPlayerUnit > 5) h(nPlayerUnit);');
  });

  it('an uncast read passed to a pointer parameter types the life', () => {
    const out = run(`int f(D2UnitStrc *p, int nStatId) {
      g(nStatId);
      nStatId = (int)Units::GetRoom(p);
      Use(nStatId);
      Use(nStatId);
      return 0;
    }`, { ...O, functionParamTypes: { Use: ['D2RoomStrc *'] } });
    has(out, 'pRoom = Units::GetRoom(p);');
    has(out, 'Use(pRoom); Use(pRoom);');
  });

  it('SKILLDESC_DrawSkillDmgAura: a life a call updates through its address moves with the call', () => {
    const src = `int f(D2UnitStrc *nMinDamage, int a) {
      g(nMinDamage);
      nMinDamage = (D2UnitStrc *)(a + 1);
      Adjust((int *)&nMinDamage);
      Draw((int32_t)nMinDamage);
      return (int32_t)nMinDamage;
    }`;
    const out = run(src, { ...O, argReach: () => ({ lo: 0, hi: 4 }) as never });
    has(out, 'nMinDamage2 = a + 1;');
    has(out, 'Adjust((int*)&nMinDamage2);');
    has(out, 'Draw(nMinDamage2);');
    has(out, 'g(nMinDamage);');
  });

  it('a truth test and a comparison with a constant read either type', () => {
    const out = run(`int f(D2UnitStrc *pBuffer, int a) {
      g(pBuffer);
      pBuffer = (D2UnitStrc *)(a * 2);
      if (!pBuffer) return 0;
      if (pBuffer != (D2UnitStrc *)0x202) h((int)pBuffer);
      return (int)pBuffer + (int)pBuffer;
    }`);
    has(out, 'if (!nBuffer) return 0;');
    has(out, 'if (nBuffer != 0x202) h(nBuffer);');
  });

  it('SFILE_AudioStreamListDeleteNode: a value loaded through the pointer is a pointer store', () => {
    const src = `int f(TSLink *pPrev) {
      g(pPrev);
      pPrev = pPrev->pNext;
      return (intptr_t)pPrev <= 0 ? 0 : (uint32_t)pPrev;
    }`;
    const out = run(src, { ...O, structFields: { TSLink: { pNext: 'TSLink *' } } });
    assert.ok(!/int nPrev/.test(out), out);
  });

  it('LoadMerc: an integer sum with an address is an address, so it stays a pointer', () => {
    const src = `int f(D2MercSaveDataStrc *pSave, D2MercSaveDataStrc *pData, int nMax) {
      g(pSave);
      pSave = (D2MercSaveDataStrc *)((intptr_t)&pData->dwFlags + 1);
      if ((intptr_t)pSave > nMax) return (int32_t)pSave;
      return (int32_t)pSave;
    }`;
    assert.ok(!/nSave/.test(run(src)), run(src));
  });

  it('a self step through an address cast stays an integer step', () => {
    const out = run(`int f(void *pCallbackData, D2RoomStrc **pp, int n) {
      g(pCallbackData);
      pCallbackData = (void *)0x0;
      do {
        h(pp[(int)pCallbackData]);
        h(pp[(int)pCallbackData]);
        pCallbackData = (void *)((int)pCallbackData + 1);
      } while ((int)pCallbackData < n);
      return 0;
    }`);
    has(out, 'h(pp[nCallbackData]);');
  });

  it('DrawGroundTile @006b9170: a documented out-parameter of a method pointer starts a pointer value', () => {
    const out = run(`int f(int a, uint32_t nAlpha) {
      D3DVB_Lock *pVBLockFn;
      char c;
      c = (char)nAlpha;
      pVBLockFn = gpVB->lpVtbl->Lock;
      (*pVBLockFn)(gpVB, 0x21, (void **)&nAlpha, nullptr);
      *(float *)nAlpha = 1.0;
      *(uint32_t *)(nAlpha + 0x10) = 5;
      *(float *)(nAlpha + 4) = 2.0;
      return c;
    }`);
    has(out, '(*pVBLockFn)(gpVB, 0x21, (void**)&pAlpha, nullptr);');
    has(out, '*pAlpha = 1.0;');
    has(out, 'c = (char)nAlpha;');
  });
});
