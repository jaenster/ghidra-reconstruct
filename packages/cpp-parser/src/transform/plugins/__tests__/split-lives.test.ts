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
import { frameGroupLocalsPlugin } from '../builtins/frame-group-locals.js';

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
    has(out, '*(int *)((char *)pPoolBlock + 8)');
    // Not an out-parameter: the call may read the parameter, which stays one variable.
    assert.strictEqual(flat(run(src, { ...both, outParamWidth: () => null })), flat(run(src, {})));
  });

  const AIPARAM = { D2AiParamStrc: { nDistanceToTarget: 'int', bEngagedInCombat: 'int' } };
  it('AITHINK_Fn1_TownRogue @005e7d60: the store an out-parameter call is handed moves with its value', () => {
    const src = `void f(D2UnitStrc *pUnit, D2AiParamStrc *pAiParam) {
      int nDistToTarget;
      nDistToTarget = pAiParam->bEngagedInCombat;
      pAiParam = (D2AiParamStrc *)pAiParam->nDistanceToTarget;
      pTarget = Find(pUnit, (uint32_t *)&pAiParam, (bool *)&nDistToTarget);
      if (pTarget != 0 && (int)pAiParam < 0x19) {
        Change(pUnit, pTarget);
      }
    }`;
    const both = { ...O, argReach: () => ({ lo: 0, hi: 4 }) as never, outParamWidth: () => 4, structFields: AIPARAM };
    const out = run(src, both);
    // The local the call fills starts with the field the original stores into the slot.
    has(out, 'int nAiParam;');
    has(out, 'nAiParam = pAiParam->nDistanceToTarget;');
    has(out, 'Find(pUnit, (uint32_t *)&nAiParam, (bool *)&nDistToTarget);');
    has(out, 'nAiParam < 0x19');
    assert.ok(!/pAiParam = /.test(flat(out)), out);
    // A callee that may keep the address: the variable stays one.
    assert.strictEqual(flat(run(src, { ...both, argReach: () => null })), flat(run(src, {})));
  });

  it('a store a read also sees stays its own life beside the out-parameter call\'s', () => {
    const src = `void f(D2UnitStrc *pUnit, D2AiParamStrc *pAiParam) {
      pAiParam = (D2AiParamStrc *)pAiParam->nDistanceToTarget;
      g((int)pAiParam);
      pTarget = Find(pUnit, (uint32_t *)&pAiParam);
      h((int)pAiParam);
    }`;
    const both = { ...O, argReach: () => ({ lo: 0, hi: 4 }) as never, outParamWidth: () => 4, structFields: AIPARAM };
    const out = run(src, both);
    // The stored value is read by g: its own life, not the call's in-value.
    has(out, 'nAiParam2 = pAiParam->nDistanceToTarget; g(nAiParam2);');
    has(out, 'Find(pUnit, (uint32_t *)&nAiParam); h(nAiParam);');
  });

  it('AI_Fn1_EvilHole @005fb410: a store of the parameter\'s own type does not pull the out-parameter life back', () => {
    const src = `void f(D2UnitStrc *pUnit, D2AiParamStrc *pAiParam) {
      D2AiParamStrc *pDVar1;
      pDVar1 = (D2AiParamStrc *)pAiParam->nDistanceToTarget;
      g(pAiParam->pMonStats);
      pAiParam = pDVar1;
      Find(pUnit, (uint32_t *)&pAiParam);
      h((int)pAiParam);
    }`;
    const both = { ...O, argReach: () => ({ lo: 0, hi: 4 }) as never, outParamWidth: () => 4, structFields: AIPARAM };
    const out = run(src, both);
    has(out, 'Find(pUnit, (uint32_t *)&nAiParam);');
    has(out, 'h(nAiParam);');
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
    const ints = `int f(D2UnitStrc *p, int nStatId) { g(nStatId); nStatId = (int)Units::GetRoom(p); return nStatId + nStatId * 2 + nStatId * 3 + (int)(D2RoomStrc *)nStatId; }`;
    assert.ok(!/pRoom/.test(run(ints)), run(ints));
  });

  it('a tie is taken where every store proves the life\'s type', () => {
    // Two casts removed (the store's, the read's), two needed (the integer reads).
    const ints = `int f(D2UnitStrc *p, int nStatId) { g(nStatId); nStatId = (int)Units::GetRoom(p); return nStatId + nStatId * 2 + (int)(D2RoomStrc *)nStatId; }`;
    has(run(ints), 'pRoom = Units::GetRoom(p);');
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

  it('moves an update with its life, stepping the address in bytes', () => {
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
    has(out, '*(float *)((char *)pRoom + 4) = 1.0;');
    has(out, '*(float *)pRoom = 2.0;');
    has(out, 'pRoom = (D2RoomStrc *)((char *)pRoom + 0x120);');
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

  it('MAINMENU_ShowCinematicsMenu @00431600: a narrower integer read of an integer life casts it once', () => {
    const out = run(`int f(D2ControlStrc *nFlags, char *sz) { g(nFlags); nFlags = (D2ControlStrc *)0x22; sscanf(sz, "%ld", (long *)&nFlags); if ((uint)nFlags & 1) return 7; if ((char)nFlags < 0) return 6; return (uint)nFlags & 4; }`,
      { ...O, argReach: () => null });
    has(out, 'if ((char)nFlags2 < 0)');
    has(out, 'return nFlags2 & 4;');
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

  const OUT1 = `int f(D2UnitStrc *pUnit) {
      int nTargetId;
      if (pUnit == (D2UnitStrc *)0x0) return 0;
      GetTargetInfo(pUnit->pPath, (int *)&pUnit, &nTargetId);
      return (int)pUnit + nTargetId;
    }`;
  const outBoth = { ...O, argReach: () => ({ lo: 0, hi: 4 }) as never, outParamWidth: () => 4 };

  it('GetTargetTypeFromDynamicUnit @00620c70: the out-parameter call\'s own argument reads the value before it', () => {
    const out = run(OUT1, outBoth);
    has(out, 'GetTargetInfo(pUnit->pPath, (int *)&nUnit, &nTargetId);');
    has(out, 'return nUnit + nTargetId;');
    has(out, 'if (pUnit == (D2UnitStrc *)0x0)');
    // Not an out-parameter: the call may read the word, which stays one variable.
    assert.strictEqual(flat(run(OUT1, { ...outBoth, outParamWidth: () => null })), flat(run(OUT1, {})));
  });

  it('a read of the variable outside the call\'s arguments keeps the call a touch', () => {
    const src = `int f(D2UnitStrc *pUnit) {
      int nTargetId;
      nTargetId = (int)pUnit + GetTargetInfo(pUnit->pPath, (int *)&pUnit, &nTargetId);
      return (int)pUnit + nTargetId;
    }`;
    assert.ok(!/nUnit/.test(run(src, outBoth)), run(src, outBoth));
  });

  const CHAIN = `int f(int a) {
      D2UnitStrc *pSlotItem;
      D2UnitStrc *pLArm;
      pSlotItem = Units::GetRoom(a);
      h(pSlotItem);
      pLArm = Units::GetRoom(0);
      h(pLArm);
      pLArm = (D2UnitStrc *)GetMouseY();
      pSlotItem = pLArm;
      g((int)pLArm);
      return k((int)pSlotItem);
    }`;
  const chainO = { ...O, functionReturnTypes: { ...O.functionReturnTypes, 'Units::GetRoom': 'D2UnitStrc *', GetRoom: 'D2UnitStrc *', GetMouseY: 'int' } };

  it('DRAW_UI_Inventory @0048edf0: a copy of a life split earlier is split in the next round', () => {
    const out = run(CHAIN, chainO);
    has(out, 'g(nLArm);');
    has(out, 'return k(nSlotItem);');
    has(out, 'h(pSlotItem);');
  });

  it('the out-parameter split and the next round compute what the merged variables computed', native, () => {
    const prelude = `
      #include <stdint.h>
      #include <stdio.h>
      struct D2UnitStrc { int pPath; int a; };
      static D2UnitStrc gUnits[3];
      static int GetTargetInfo(int path, int *pOut, int *pId) { *pOut = path * 7; *pId = path + 1; return 0; }
      namespace Units { static D2UnitStrc *GetRoom(int i) { return &gUnits[i]; } }
      static int gY = 5;
      static int GetMouseY() { return gY++; }
      static int gSeen;
      static void h(D2UnitStrc *p) { gSeen += p->a; }
      static void g(int x) { gSeen += x * 3; }
      static int k(int x) { return x + gSeen; }`;
    const src = OUT1 + CHAIN.replace('int f(', 'int f2(');
    const out = run(src, { ...outBoth, ...chainO });
    has(out, '&nUnit');
    has(out, 'g(nLArm);');
    const call = 'gUnits[0].pPath = 3; gUnits[1].pPath = 4; gUnits[1].a = 9; printf("%d %d %d %d\\n", f(&gUnits[0]), f(0), f2(1), f2(2));';
    assert.strictEqual(compileAndRun(prelude + out, call), compileAndRun(prelude + src, call));
  });

  it('CUBE_ParseOutputItem: a narrower integer read of an out-parameter\'s integer no longer truncates a pointer', () => {
    const src = `int f(char *pszCode, char *psz) {
      g(psz);
      ConvertCode(pszCode, (int *)&psz);
      return (int)(ushort)psz;
    }`;
    const out = run(src, outBoth);
    has(out, 'ConvertCode(pszCode, (int *)&nPsz);');
    has(out, 'return (int)(ushort)nPsz;');
  });

  // A store through a pointer (`p[0x50] = 0`) is a read of p: it does not end p's value.
  const STORE = `int f(int *pnHigh, int nDist) {
      g(pnHigh[0x46]);
      pnHigh[0x50] = 0;
      pnHigh = (int *)GetMouseY();
      k((int)pnHigh);
      return (int)pnHigh + nDist;
    }`;
  const storeO = { ...O, functionReturnTypes: { ...O.functionReturnTypes, GetMouseY: 'int' } };

  it('SFileSetFilePointer @SFile: a store through the pointer is a read, the variable splits', () => {
    const out = run(STORE, storeO);
    has(out, 'int nPnHigh;');
    has(out, 'pnHigh[0x50] = 0;');
    has(out, 'nPnHigh = GetMouseY();');
    has(out, 'k(nPnHigh);');
  });

  it('a subscript store into a local array is still a write of the array', () => {
    const src = `int f(int n) {
      int aBuf[4];
      aBuf[1] = n;
      return aBuf[1];
    }`;
    assert.strictEqual(flat(run(src)), flat(emit(parse(src) as AnyNode).trim()));
  });

  it('MONSTER_GetMissileForAnimEvent: a pointer in an enum-typed variable is a pointer in a word', () => {
    const out = run(`int f(eD2MonsterAnimMode eAnimMode) {
      g(eAnimMode);
      eAnimMode = (eD2MonsterAnimMode)Units::GetRoom(3);
      h((D2RoomStrc *)eAnimMode);
      return ((D2RoomStrc *)eAnimMode)->a;
    }`);
    has(out, 'D2RoomStrc *pRoom;');
    has(out, 'pRoom = Units::GetRoom(3);');
    has(out, 'h(pRoom);');
    has(out, 'g(eAnimMode);');
  });

  const ENUM_STEP = `int f(D2UnitStrc *pUnit, eD2Skills eSkill, D2SkillsTxt *pSkillTxt) {
      int nSum = 0;
      g(eSkill);
      eSkill = (eD2Skills)GetStats(pSkillTxt);
      do {
        eSkill += 2;
        if (*(short int *)eSkill >= 0) nSum += (int)*(short int *)eSkill;
      } while (*(short int *)eSkill != 0);
      return nSum;
    }`;
  const enumO = { ...O, functionReturnTypes: { ...O.functionReturnTypes, GetStats: 'short *' } };

  it('Skills_SrvDoFunc_047_CloakOfShadows: an enum variable stepping a pointer steps it by elements', () => {
    const out = run(ENUM_STEP, enumO);
    has(out, 'short int *pSkill;');
    has(out, 'pSkill += 1;');
    has(out, 'if (*pSkill >= 0)');
  });

  it('the same step written as an assignment steps it by elements too', () => {
    const out = run(ENUM_STEP.replace('eSkill += 2;', 'eSkill = eSkill + 2;'), enumO);
    has(out, 'pSkill += 1;');
  });

  it('SFileGetFileSize: an SDK pointer typedef is a pointer word', () => {
    const out = run(`int f(LPDWORD pdwHigh, int n) {
      g(pdwHigh);
      pdwHigh = (LPDWORD)GetMouseY();
      k((int)pdwHigh);
      return (int)pdwHigh + n;
    }`, { ...O, functionReturnTypes: { ...O.functionReturnTypes, GetMouseY: 'int' } });
    has(out, 'int nPdwHigh;');
    has(out, 'nPdwHigh = GetMouseY();');
    has(out, 'k(nPdwHigh);');
  });

  // ItemStatCost_DescFunc_DGrpFunc @SkillDesc: a parameter's slot reused for an integer an
  // out-parameter call stores.
  const TIE = `int f(D2UnitStrc *pUnit, int nGroup) {
      g(pUnit);
      pUnit = 0;
      GetPeriod(nGroup, (int32_t *)&pUnit);
      return CalcRepair(nGroup, (int32_t)pUnit);
    }`;
  const tieO = { ...O, outParamWidth: () => 4, outParamWidthNonNull: () => 4, argReach: () => ({ bytes: 4 }) as never,
    functionParamTypes: { CalcRepair: ['int', 'int32_t'], GetPeriod: ['int', 'int32_t *'] } };

  it('ItemStatCost_DescFunc_DGrpFunc: a parameter slot an out-parameter call fills with an integer splits', () => {
    const out = run(TIE, tieO);
    has(out, 'int32_t nUnit;');
    has(out, 'GetPeriod(nGroup, (int32_t *)&nUnit);');
    has(out, 'return CalcRepair(nGroup, nUnit);');
  });

  it('a tie that would make a local pointer an integer keeps it', () => {
    const src = `int f(D2UnitStrc *pUnit) {
      D2NetDataStrc *pSock;
      pSock = (D2NetDataStrc *)InterlockedCompareExchange((LONG *)&gSock, 0, 0);
      while (pSock) {
        Poll(pSock);
        pSock = (D2NetDataStrc *)InterlockedCompareExchange((LONG *)&gSock, 0, 0);
      }
      return 0;
    }`;
    const o = { ...O, functionReturnTypes: { ...O.functionReturnTypes, InterlockedCompareExchange: 'LONG' }, functionParamTypes: { Poll: ['D2NetDataStrc *'] } };
    assert.strictEqual(flat(run(src, o)), flat(emit(parse(src) as AnyNode).trim()));
  });

  it('a store through the pointer, an enum word, a tie and a reused parameter slot compute what the merged variables computed', native, () => {
    const prelude = `
      #include <stdint.h>
      #include <stdio.h>
      enum eD2MonsterAnimMode { MODE_A = 0, MODE_B = 1 };
      struct D2RoomStrc { int a; int b[3]; };
      static D2RoomStrc gRooms[3];
      static int gSeen;
      namespace Units { static D2RoomStrc *GetRoom(int i) { return &gRooms[i]; } }
      static void g(int x) { gSeen += x; }
      static void k(int x) { gSeen += x * 11; }
      static int gY = 5;
      static int GetMouseY() { return gY++; }
      static void h(D2RoomStrc *r) { gSeen += r->a * 3; }
      struct D2UnitStrc { int a; };
      static D2UnitStrc gUnit = { 2 };
      static void GetPeriod(int n, int32_t *pOut) { *pOut = n * 5; }
      static int CalcRepair(int n, int32_t v) { return n + v * 7; }
      static void g(D2UnitStrc *p) { gSeen += p->a; }
      // The tree spells an enum as a 32-bit integer typedef with its constants.
      typedef int eD2Skills;
      static const eD2Skills SKILL_A = 0;
      struct D2SkillsTxt { short aStats[6]; };
      static D2SkillsTxt gSkill = { { 9, 4, 7, -3, 5, 0 } };
      static short *GetStats(D2SkillsTxt *p) { return p->aStats; }`;
    const src = STORE.replace('int f(', 'int f1(').replace('g(pnHigh[0x46]);', 'k(pnHigh[1]);').replace('pnHigh[0x50] = 0;', 'pnHigh[2] = 0;')
      + `int f2(eD2MonsterAnimMode eAnimMode) {
          g(eAnimMode);
          eAnimMode = (eD2MonsterAnimMode)(intptr_t)Units::GetRoom(2);
          h((D2RoomStrc *)eAnimMode);
          return ((D2RoomStrc *)eAnimMode)->a;
        }`
      + ENUM_STEP.replace('int f(', 'int f5(')
      + ENUM_STEP.replace('int f(', 'int f6(').replace('eSkill += 2;', 'eSkill = eSkill + 2;')
      + TIE.replace('int f(', 'int f3(')
      + `int f4(int i, int nStatId) {
          g(nStatId);
          nStatId = (int)Units::GetRoom(i);
          return (nStatId - (int)&gRooms[0]) * 3 + (nStatId - (int)&gRooms[1]) + ((D2RoomStrc *)nStatId)->a;
        }`;
    const out = run(src, { ...tieO, ...storeO, functionReturnTypes: { ...storeO.functionReturnTypes, GetStats: 'short *' }, functionParamTypes: tieO.functionParamTypes });
    has(out, 'pSkill += 1;');
    has(out, 'nPnHigh = GetMouseY();');
    has(out, 'GetPeriod(nGroup, (int32_t *)&nUnit);');
    has(out, 'pRoom = Units::GetRoom(i);');
    const call = `int buf[4] = { 1, 2, 3, 4 }; gRooms[1].a = 4; gRooms[2].a = 6;
      printf("%d ", f1(buf, 1)); printf("%d ", f2(MODE_B)); printf("%d %d %d\\n", f3(&gUnit, 3), buf[2], gSeen); printf("%d %d\\n", f4(2, 1), gSeen); printf("%d %d %d\\n", f5(&gUnit, SKILL_A, &gSkill), f6(&gUnit, SKILL_A, &gSkill), gSeen);`;
    assert.strictEqual(compileAndRun(prelude + out, call), compileAndRun(prelude + src, call));
  });

  // SKILLDESC_DrawSkillDmgFist @004eb830: a pointer parameter's slot reused for a number,
  // reset with a null store and stepped by a byte pointer's arithmetic.
  const STEPS = `int f(D2SkillsTxt *pSkillsTxt, char *pBytes, int nShift) {
      g2(pSkillsTxt);
      pSkillsTxt = (D2SkillsTxt *)0x0;
      if (nShift) pSkillsTxt = (D2SkillsTxt *)GetMouseY();
      k((int)pSkillsTxt);
      g2(pBytes);
      pBytes = (char *)GetMouseY();
      pBytes = pBytes + 3;
      pBytes++;
      k((int)pBytes + (int)pSkillsTxt);
      nShift = (int)&gRooms[1];
      nShift = nShift + 4;
      h((D2RoomStrc *)nShift);
      return (int)pBytes * 2;
    }`;
  const stepsO = { ...O, functionReturnTypes: { ...O.functionReturnTypes, GetMouseY: 'int' }, functionParamTypes: { k: ['int'], h: ['D2RoomStrc *'] } };

  it('a constant store into a moved life costs nothing; a byte pointer\'s step is the number\'s', () => {
    const lines: string[] = [];
    const out = run(STEPS, { ...stepsO, onReport: (_f, l) => lines.push(l) });
    has(out, 'nSkillsTxt = 0x0;');
    has(out, 'nSkillsTxt = GetMouseY();');
    has(out, 'nBytes += 3;');
    has(out, 'nBytes += 1;');
    has(out, 'k(nBytes + nSkillsTxt);');
    assert.ok(lines.some(l => /pSkillsTxt: split/.test(l)), lines.join('\n'));
  });

  it('an address stored through the integer type is a pointer store; its step moves in bytes', () => {
    const out = run(STEPS, stepsO);
    has(out, 'D2RoomStrc *pRoom;');
    has(out, 'pRoom = (D2RoomStrc *)&gRooms[1];');
    has(out, 'pRoom = (D2RoomStrc *)((char *)pRoom + 4);');
    has(out, 'h(pRoom);');
  });

  it('the steps, constant stores and address stores compute what the merged variables computed', native, () => {
    const prelude = `
      #include <stdint.h>
      #include <stdio.h>
      struct D2RoomStrc { int a; int b; };
      static D2RoomStrc gRooms[3];
      struct D2SkillsTxt { int x; };
      static D2SkillsTxt gTxt = { 3 };
      static int gSeen, gY = 40;
      static int GetMouseY() { return gY++; }
      static void g2(void *p) { gSeen += p ? 1 : 0; }
      static void k(int x) { gSeen += x; }
      static void h(D2RoomStrc *r) { gSeen += r->a * 5; }`;
    const fn = STEPS.replace(/\(int\)&gRooms\[1\]/, '(int)(intptr_t)&gRooms[1]');
    const out = run(fn, stepsO);
    const call = 'gRooms[1].a = 2; gRooms[1].b = 9; int r = f(&gTxt, (char *)0, 1); printf("%d %d\\n", r, gSeen);';
    assert.strictEqual(compileAndRun(prelude + out, call), compileAndRun(prelude + fn, call));
  });

  // MONSTER_UpdateStatesFlags @ Units: a unit pointer's slot reused for a counter Ghidra steps
  // through a member's address, read back through its byte array and compared as a pointer.
  const LAYOUTS = {
    D2UnitStrc: [{ name: 'eUnitType', offset: 0, size: 4, type: 'int' }, { name: 'nClassId', offset: 4, size: 4, type: 'int' },
      { name: 'unk0x19', offset: 0x19, size: 3, type: 'byte[3]' }],
    D2DifficultyLevelsTxt: [{ name: 'nResist', offset: 0, size: 4, type: 'int' }, { name: 'nOdds', offset: 4, size: 4, type: 'int' }],
  };
  const INTERIOR = `int f(D2UnitStrc *pUnit, int n, D2DifficultyLevelsTxt *pDiff) {
      int nSum;
      g2(pUnit);
      g2(pDiff);
      pUnit = (D2UnitStrc *)0x0;
      nSum = 0;
      do {
        nSum = nSum + gTable[(int)(pUnit->unk0x19 + n * 2 - 0x19)];
        pUnit = (D2UnitStrc *)((int)&pUnit->eUnitType + 1);
      } while ((int)pUnit < 3);
      pDiff = (D2DifficultyLevelsTxt *)GetMouseY();
      if (pDiff != (D2DifficultyLevelsTxt *)gnLimit) nSum = nSum + 1;
      return nSum + ((int)&pDiff[1].nOdds + n);
    }`;
  const interiorO = { ...O, structLayouts: LAYOUTS, aggregateSizes: { D2UnitStrc: 0xf4, D2DifficultyLevelsTxt: 8 },
    functionReturnTypes: { ...O.functionReturnTypes, GetMouseY: 'int' }, globalTypes: { gnLimit: 'int' } };

  it('a counter in a unit pointer reads its member addresses as the counter plus their offsets', () => {
    const out = run(INTERIOR, interiorO);
    has(out, 'int nUnit;');
    has(out, 'nUnit = 0x0;');
    has(out, 'gTable[(int)(nUnit + 0x19 + n * 2 - 0x19)]');
    has(out, 'nUnit = nUnit + 1;');
    has(out, 'while (nUnit < 3);');
  });

  it('a number in a pointer compares with another number without converting either; &p[1].f is p plus the bytes', () => {
    const out = run(INTERIOR, interiorO);
    has(out, 'if (nDiff != gnLimit)');
    has(out, 'return nSum + nDiff + 0xc + n;');
  });

  it('an element address through a pointer does not take the pointer\'s own address', () => {
    const lines: string[] = [];
    run(`int f(D2DifficultyLevelsTxt *pDiff, int n) {
      g2(pDiff);
      pDiff = (D2DifficultyLevelsTxt *)GetMouseY();
      return n + (int)&pDiff[1].nOdds;
    }`, { ...interiorO, onReport: (_f, l) => lines.push(l) });
    assert.ok(!lines.some(l => /pDiff: other: escaped/.test(l)), lines.join('\n'));
    assert.ok(lines.some(l => /pDiff: split/.test(l)), lines.join('\n'));
  });

  it('member addresses and number comparisons compute what the merged variables computed', native, () => {
    const prelude = `
      #include <stdint.h>
      #include <stdio.h>
      #include <stddef.h>
      struct D2UnitStrc { int eUnitType; int nClassId; char pad[0x11]; unsigned char unk0x19[3]; char rest[0xf4 - 0x1c]; };
      struct D2DifficultyLevelsTxt { int nResist; int nOdds; };
      static_assert(offsetof(D2UnitStrc, unk0x19) == 0x19, "layout");
      static int gTable[16] = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 };
      static int gnLimit = 41, gY = 40, gSeen;
      static int GetMouseY() { return gY++; }
      static void g2(void *p) { gSeen += p ? 1 : 0; }`;
    const fn = INTERIOR.replace('(int)&pUnit->eUnitType', '(int)(intptr_t)&pUnit->eUnitType').replace('(int)(pUnit->unk0x19', '(int)(intptr_t)(pUnit->unk0x19')
      .replace('(int)&pDiff[1].nOdds', '(int)(intptr_t)&pDiff[1].nOdds').replace('(int)pUnit < 3', '(int)(intptr_t)pUnit < 3')
      .replace('(D2DifficultyLevelsTxt *)gnLimit', '(D2DifficultyLevelsTxt *)(intptr_t)gnLimit').replace('(D2DifficultyLevelsTxt *)GetMouseY()', '(D2DifficultyLevelsTxt *)(intptr_t)GetMouseY()');
    const out = run(INTERIOR, interiorO);
    const call = 'D2UnitStrc u; D2DifficultyLevelsTxt d; printf("%d ", f(&u, 1, &d)); gY = 41; printf("%d ", f(&u, 2, &d)); printf("%d\\n", gSeen);';
    assert.strictEqual(compileAndRun(prelude + out, call), compileAndRun(prelude + fn, call));
  });

  // SCMD_0x02_WalkToEntity @00549890: the packet pointer's dead slot receives the unit type
  // an out-parameter call stores, read back as the enum.
  const WALK = `int f(SGAMEDATA *pGame, D2UnitStrc *pUnit, D2GSPacketClt0x02 *pPacket, uint32_t nSize) {
      int nStatus = AnyPacketClickOnMap(pGame, nSize, (eD2UnitType *)&pPacket, &nSize, pUnit, &pPacket->nCmd);
      if (nStatus == 0) {
        StartModeID(pGame, pUnit, 2, (eD2UnitType)pPacket, nSize);
      }
      return nStatus;
    }`;
  const walkO = { ...O, outParamWidth: () => 4, outParamWidthNonNull: () => 4, argReach: () => ({ lo: 0, hi: 4 }) as never };

  it('SCMD_0x02_WalkToEntity: an enum an out-parameter call stores in a pointer slot gets an enum local', () => {
    const lines: string[] = [];
    const out = run(WALK, { ...walkO, onReport: (_f, l) => lines.push(l) });
    assert.ok(lines.some(l => /pPacket: split: \w+ eD2UnitType/.test(l)), lines.join('\n'));
    has(out, 'eD2UnitType ');
    has(out, '(eD2UnitType *)&');
    assert.ok(!/\(eD2UnitType\)pPacket/.test(out), out);
  });

  it('the enum out-parameter split computes what the merged variable computed', native, () => {
    const prelude = `
      #include <stdint.h>
      #include <stdio.h>
      typedef uint32_t eD2UnitType;
      struct SGAMEDATA { int a; };
      struct D2UnitStrc { int a; };
      struct D2GSPacketClt0x02 { uint8_t nCmd; uint32_t nType; uint32_t nGuid; };
      static int gSeen;
      static int AnyPacketClickOnMap(SGAMEDATA *, uint32_t n, eD2UnitType *pType, uint32_t *pSize, D2UnitStrc *, uint8_t *p) {
        *pType = (eD2UnitType)(p[0] + 1); *pSize = n * 3; return n == 9 ? 0 : 1; }
      static void StartModeID(SGAMEDATA *, D2UnitStrc *, int m, eD2UnitType t, uint32_t n) { gSeen += m + (int)t * 10 + (int)n * 100; }`;
    const out = run(WALK, walkO);
    const call = 'SGAMEDATA g; D2UnitStrc u; D2GSPacketClt0x02 pk = { 4, 0, 0 }; printf("%d ", f(&g, &u, &pk, 9)); printf("%d ", f(&g, &u, &pk, 7)); printf("%d\\n", gSeen);';
    assert.strictEqual(compileAndRun(prelude + out, call), compileAndRun(prelude + WALK, call));
  });

  describe('a local a frame object may hold: its lives as members of a union in its slot', () => {
    const slots = [{ name: 'a', offset: -0x10, size: 4 }, { name: 'nX', offset: -0xc, size: 4 }];
    const src = `int f(int nSel) {
        int a;
        int nX;
        int s;
        a = nSel;
        g(&a);
        s = k(nX + 1);
        nX = (int)Units::GetRoom(nSel & 1);
        s = s + h((D2RoomStrc *)nX);
        s = s + h((D2RoomStrc *)nX);
        g(&a);
        nX = nX + 2;
        return s + k(nX);
      }`;
    const withUnions = { ...O, slots, slotUnions: true };

    it('CUnit/AI frame members: a pointer life becomes a union member, the slot keeps its name', () => {
      const lines: string[] = [];
      const out = run(src, { ...withUnions, onReport: (_f, l) => lines.push(l) });
      has(out, 'union nX_u {');
      has(out, 'int nX2;');
      has(out, 'D2RoomStrc *pRoom;');
      has(out, 'nX_u nX;');
      has(out, 'nX.pRoom = Units::GetRoom(nSel & 1);');
      has(out, 'h(nX.pRoom)');
      has(out, 'k(nX.nX2 + 1)');
      has(out, 'sizeof(nX_u) == 4');
      assert.ok(!/\(D2RoomStrc \*\)/.test(out), out);
      assert.ok(lines.some(l => /^nX: slot union: pRoom D2RoomStrc\*/.test(l)), lines.join('\n'));
      // Without the option the local is refused, and says why.
      const refused: string[] = [];
      assert.strictEqual(flat(run(src, { ...O, slots, onReport: (_f, l) => refused.push(l) })), flat(run(src, {})));
      assert.ok(refused.some(l => /^nX: refused: a frame object may hold its slot/.test(l)), refused.join('\n'));
    });

    it('a slot that is not one 4-byte word is refused with the reason', () => {
      const lines: string[] = [];
      const wide = [{ name: 'a', offset: -0x10, size: 4 }, { name: 'nX', offset: -0xc, size: 8 }];
      assert.strictEqual(flat(run(src, { ...withUnions, slots: wide, onReport: (_f, l) => lines.push(l) })), flat(run(src, {})));
      assert.ok(lines.some(l => /^nX: refused: .*not one 4-byte word/.test(l)), lines.join('\n'));
    });

    it('frame-group-locals sizes the union and declares the group after it', () => {
      const split = run(src, withUnions);
      const grouped = emit(frameGroupLocalsPlugin.createTransformer({ slots })(parse(split)) as AnyNode);
      const at = (t: string) => flat(grouped).indexOf(t);
      assert.ok(at('union nX_u') >= 0 && at('struct __frame0_t') > at('union nX_u'), grouped);
      has(grouped, 'nX_u nX;');
      has(grouped, '__frame0.nX.pRoom');
      has(grouped, 'g(&__frame0.a)');
    });

    it('computes what the shared slot computed, a callee writing it through a neighbour', native, () => {
      const prelude = `
        #include <stdint.h>
        struct D2RoomStrc { int a; D2RoomStrc *pNext; };
        static D2RoomStrc gRooms[2];
        namespace Units { static D2RoomStrc *GetRoom(int i) { return &gRooms[i]; } }
        static void g(int *p) { p[1] = p[0] + 40; }
        static int k(int x) { return x * 2; }
        static int h(D2RoomStrc *r) { return r->a; }`;
      const group = (code: string) => emit(frameGroupLocalsPlugin.createTransformer({ slots })(parse(code)) as AnyNode);
      const ours = group(run(src, withUnions));
      const ref = group(src);
      assert.ok(/nX_u/.test(ours) && /__frame0/.test(ref), ours);
      const call = 'gRooms[0].a = 5; gRooms[1].a = 7; printf("%d %d\\n", f(2), f(3));';
      const want = compileAndRun(prelude + ref, call);
      assert.strictEqual(compileAndRun(prelude + ours, call), want);
      assert.strictEqual(want.trim(), String(2 * (2 + 41) + 5 + 5 + 2 * (2 + 40 + 2)) + ' ' + String(2 * (3 + 41) + 7 + 7 + 2 * (3 + 40 + 2)));
    });
  });

  // ZLIB_InflateFast @0042dca0: an address kept in an integer local, loaded from the state's
  // integer words and read only through pointer casts at offsets.
  const OFFSETS = `int f(int *pState, int n) {
      int nWindowPos;
      g(n);
      nWindowPos = n * 2;
      g(nWindowPos);
      nWindowPos = pState[3];
      n = n + *(uint8_t *)(nWindowPos - 1);
      n = n + *(uint8_t *)(nWindowPos + 2);
      n = n + *(int *)(nWindowPos + 4);
      return n;
    }`;

  it('ZLIB_InflateFast: an integer life read only at offsets becomes a byte pointer, its integer store converted', () => {
    const lines: string[] = [];
    const out = run(OFFSETS, { ...O, onReport: (_f, l) => lines.push(l) });
    assert.ok(lines.some(l => /nWindowPos: split: \w+ char\*/.test(l)), lines.join('\n'));
    has(out, 'char *');
    has(out, 'g(nWindowPos);');
  });

  it('the offset life computes what the merged variable computed', native, () => {
    const prelude = `
      #include <stdint.h>
      #include <stdio.h>
      static int gSeen;
      static void g(int x) { gSeen += x; }
      static uint8_t gBuf[16] = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 };`;
    const out = run(OFFSETS, O);
    const call = 'int st[4] = { 0, 0, 0, (int)(intptr_t)&gBuf[4] }; printf("%d %d\\n", f(st, 3), gSeen);';
    assert.strictEqual(compileAndRun(prelude + out, call), compileAndRun(prelude + OFFSETS, call));
  });

  // D2WinPalette / SUNITNPC_GenerateNpcItems: a number in a pointer ordered against a constant,
  // and a pointer local that only relays a moved number.
  const RELAY = `int f(char *szSrcFile, D2ItemsTxt *pTxt, int n) {
      D2ItemsTxt *pTmp;
      g2(szSrcFile);
      g2(pTxt);
      szSrcFile = (char *)(n * 0xaa / 100);
      if (szSrcFile < (char *)0x100) n = n + (int)szSrcFile;
      pTxt = (D2ItemsTxt *)GetMouseY();
      pTmp = (D2ItemsTxt *)((int)pTxt + 1);
      return n + (int)pTmp;
    }`;
  const relayO = { ...O, functionReturnTypes: { ...O.functionReturnTypes, GetMouseY: 'int' } };

  it('an integer life ordered against a constant compares unsigned, as the pointers did', () => {
    const out = run(RELAY, relayO);
    has(out, 'if ((uint32_t)nSrcFile < 0x100)');
  });

  it('a local that only relays a moved integer moves with it', () => {
    const lines: string[] = [];
    const out = run(RELAY, { ...relayO, onReport: (_f, l) => lines.push(l) });
    assert.ok(lines.some(l => /pTmp: split/.test(l)), lines.join('\n'));
    assert.ok(!/\(D2ItemsTxt \*?\)/.test(out.replace(/\s+\*/g, '*').replace(/\*\)/g, ' *)')), out);
  });

  it('the unsigned comparison and the relay compute what the merged variables computed', native, () => {
    const prelude = `
      #include <stdint.h>
      #include <stdio.h>
      struct D2ItemsTxt { int a; };
      static int gSeen, gY = 7;
      static int GetMouseY() { return gY; }
      static void g2(void *p) { gSeen += p ? 1 : 0; }`;
    const fn = RELAY.replace('(char *)(n * 0xaa / 100)', '(char *)(intptr_t)(n * 0xaa / 100)').replace('(int)szSrcFile', '(int)(intptr_t)szSrcFile')
      .replace('(D2ItemsTxt *)GetMouseY()', '(D2ItemsTxt *)(intptr_t)GetMouseY()').replace('(D2ItemsTxt *)((int)pTxt + 1)', '(D2ItemsTxt *)((intptr_t)pTxt + 1)').replace('(int)pTmp', '(int)(intptr_t)pTmp');
    const out = run(RELAY, relayO);
    const call = 'D2ItemsTxt t; printf("%d %d ", f((char *)0, &t, 100), f((char *)0, &t, 200)); printf("%d %d %d\\n", f((char *)0, &t, -5), f((char *)0, &t, -400), gSeen);';
    assert.strictEqual(compileAndRun(prelude + out, call), compileAndRun(prelude + fn, call));
  });
});
