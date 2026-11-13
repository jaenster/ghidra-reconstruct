/**
 * reused-param-slot: AITHINK_Fn1_NpcOutOfTown (005e7880) keeps a function pointer in
 * the dead slot of its `pAiParam` parameter; the pass gives it a funcdef-typed local.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { reusedParamSlotPlugin, type ReusedParamSlotOptions } from '../builtins/reused-param-slot.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';
import { transformGhidraCode } from '../../../ghidra.js';
import { input as nativeInput, harness as nativeHarness } from './fixtures/reused-param-slot/native.js';

const native = { skip: !hasNativeGpp() };

const SIG = 'void(D2GameStrc *,D2UnitStrc *)';
const OPTIONS: ReusedParamSlotOptions = {
  functionSignatures: {
    'Q::Q04_InitializeTristramObjects': SIG, Q04_InitializeTristramObjects: SIG,
    'Q::Q33_StartAnyaRescuePhase': SIG, Q33_StartAnyaRescuePhase: SIG,
    'Q::Other': 'int(D2GameStrc *)', Other: 'int(D2GameStrc *)',
  },
  functionConventions: {
    'Q::Q04_InitializeTristramObjects': '__fastcall', Q04_InitializeTristramObjects: '__fastcall',
    'Q::Q33_StartAnyaRescuePhase': '__fastcall', Q33_StartAnyaRescuePhase: '__fastcall',
    'Q::Other': '__fastcall', Other: '__fastcall',
  },
  // Four funcdefs share the contract in 1.14d; the program stores these two functions
  // as fpGameMechanicQuest in the sibling AI_QuestNpc_InitializeQuestPhase (005e77a0).
  funcdefSignatures: { fpGameMechanicQuest: SIG, fpTimerFunction: SIG, dt_1ae317ea: SIG, fpStdcallTwin: SIG },
  funcdefConventions: { fpGameMechanicQuest: '__fastcall', fpTimerFunction: '__fastcall', dt_1ae317ea: '__fastcall', fpStdcallTwin: '__stdcall' },
  functionStoredAs: {
    'Q::Q04_InitializeTristramObjects': ['fpGameMechanicQuest'], Q04_InitializeTristramObjects: ['fpGameMechanicQuest'],
    'Q::Q33_StartAnyaRescuePhase': ['fpGameMechanicQuest'], Q33_StartAnyaRescuePhase: ['fpGameMechanicQuest'],
  },
};

const run = (code: string, o: ReusedParamSlotOptions = OPTIONS) =>
  emit(reusedParamSlotPlugin.createTransformer(o)(parse(code)) as AnyNode).trim();

/** The else branch of 005e7880, trimmed to what the slot does. */
const SITE = `void f(D2GameStrc *pGame, D2UnitStrc *pUnit, D2AiParamStrc *pAiParam, int bIsAnya, int nArrived) {
  Use(pAiParam);
  if (nArrived == 0) {
    Use(pAiParam);
    return;
  }
  pAiParam = (D2AiParamStrc *)Q::Q04_InitializeTristramObjects;
  if (bIsAnya) {
    pAiParam = (D2AiParamStrc *)Q::Q33_StartAnyaRescuePhase;
  }
  if (nArrived == 1) {
    (*(code *)pAiParam)(pGame,pUnit);
    return;
  }
  return;
}`;

describe('reused-param-slot', () => {
  it('gives the reused slot a local of the funcdef the program stores those functions as', () => {
    const out = run(SITE);
    assert.match(out, /fpGameMechanicQuest\* pfnGameMechanicQuest;/, out);
    assert.match(out, /pfnGameMechanicQuest = Q::Q04_InitializeTristramObjects;/, out);
    assert.match(out, /pfnGameMechanicQuest = Q::Q33_StartAnyaRescuePhase;/, out);
    assert.match(out, /\(\*pfnGameMechanicQuest\)\(pGame, pUnit\);/, out);
    // The parameter keeps its own uses.
    assert.strictEqual(out.match(/Use\(pAiParam\)/g)?.length, 2, out);
    assert.doesNotMatch(out, /code|\(D2AiParamStrc\*\)/, out);
  });

  it('calls the same functions as the slot did', native, () => {
    const out = run(SITE);
    const prelude = [
      'struct D2GameStrc { int n; }; struct D2UnitStrc { int n; }; struct D2AiParamStrc { int n; };',
      'typedef void code(D2GameStrc *, D2UnitStrc *);',
      'typedef void fpGameMechanicQuest(D2GameStrc *, D2UnitStrc *);',
      'static int gLog = 0; static void Use(D2AiParamStrc *p) { gLog = gLog * 7 + (p ? p->n : 1); }',
      'namespace Q { void Q04_InitializeTristramObjects(D2GameStrc *g, D2UnitStrc *u) { gLog = gLog * 3 + g->n + 1; }',
      '  void Q33_StartAnyaRescuePhase(D2GameStrc *g, D2UnitStrc *u) { gLog = gLog * 5 + u->n + 2; } }',
      `namespace ref { ${SITE} }`,
      `namespace low { ${out} }`,
    ].join('\n');
    const body = [
      'D2GameStrc g{4}; D2UnitStrc u{9}; D2AiParamStrc a{6}; int bad = 0;',
      'for (int anya = 0; anya < 2; anya++) for (int arrived = 0; arrived < 3; arrived++) {',
      '  gLog = 0; ref::f(&g, &u, &a, anya, arrived); int x = gLog;',
      '  gLog = 0; low::f(&g, &u, &a, anya, arrived); if (x != gLog) bad++;',
      '}',
      'printf("%d\\n", bad);',
    ].join('\n');
    assert.strictEqual(compileAndRun(prelude, body).trim(), '0', out);
  });

  it('leaves the slot when a read of the parameter itself is reachable from a store', () => {
    const code = SITE.replace('  return;\n}', '  Use(pAiParam);\n  return;\n}');
    assert.match(run(code), /\(\*\(code\*\)pAiParam\)/);
  });

  it('leaves the slot when the stored functions differ in signature', () => {
    assert.match(run(SITE.replace('Q::Q33_StartAnyaRescuePhase', 'Q::Other')), /\(\*\(code\*\)pAiParam\)/);
  });

  it('leaves the slot when identical funcdefs cannot be told apart', () => {
    assert.match(run(SITE, { ...OPTIONS, functionStoredAs: {} }), /\(\*\(code\*\)pAiParam\)/);
  });

  it('leaves a slot written with something that is not a function', () => {
    assert.match(run(SITE.replace('pAiParam = (D2AiParamStrc *)Q::Q33_StartAnyaRescuePhase;', 'pAiParam = Next(pAiParam);')),
      /\(\*\(code\*\)pAiParam\)/);
  });
});

describe('reused-param-slot: a second value in a dead stack-argument slot', () => {
  const V: ReusedParamSlotOptions = {
    stackParameters: ['nVelocity', 'pUnit', 'pProperty'],
    functionReturnTypes: { 'D2Common::Units::Units::UNITS_GetRoom': 'D2RoomStrc *', UNITS_GetRoom: 'D2RoomStrc *' },
  };

  it('HirelingFollowOwnerAction @005e3930: the room kept in nVelocity\'s slot gets a local of its own', () => {
    const out = run(`int f(D2UnitStrc *pOwner, int nVelocity) {
      g(nVelocity);
      nVelocity = (int)D2Common::Units::Units::UNITS_GetRoom(pOwner);
      h((D2RoomStrc *)nVelocity, 1);
      return 0;
    }`, V);
    assert.ok(/D2RoomStrc\s*\*\s*pRoom;/.test(out), out);
    assert.ok(/pRoom = D2Common::Units::Units::UNITS_GetRoom\(pOwner\);/.test(out), out);
    assert.ok(/h\(pRoom, 1\);/.test(out), out);
    assert.ok(/g\(nVelocity\);/.test(out), out);
  });

  it('ITEM_RollSocketCount @0062bcb0: an integer in a pointer slot, typed by the reads', () => {
    const out = run(`void f(D2UnitStrc *pUnit, uint n) {
      if (pUnit != (D2UnitStrc *)0x0) {
        pUnit = (D2UnitStrc *)((uint)n << 0x18);
        n = ((uint)pUnit >> 0x18) * 2;
        k((uint)pUnit);
      }
    }`, V);
    assert.ok(/uint nUnit;/.test(out), out);
    assert.ok(/nUnit = \(uint\)\(\(uint\)n << 0x18\);/.test(out), out);
    assert.ok(/n = \(nUnit >> 0x18\) \* 2;/.test(out), out);
    assert.ok(/k\(nUnit\);/.test(out), out);
    assert.ok(/pUnit != \(D2UnitStrc\s*\*\)0x0/.test(out), out);
  });

  it('a bare read of the second value keeps its bits through the parameter type', () => {
    const out = run(`int f(D2UnitStrc *pOwner, int nVelocity) {
      int bWalked;
      g(nVelocity);
      nVelocity = (int)D2Common::Units::Units::UNITS_GetRoom(pOwner);
      bWalked = nVelocity;
      return h((D2RoomStrc *)nVelocity, bWalked);
    }`, V);
    assert.ok(/bWalked = \(int\)pRoom;/.test(out), out);
    assert.ok(/h\(pRoom, bWalked\)/.test(out), out);
  });

  it('leaves a slot one read sees with both values (a loop around the store)', () => {
    const src = `void f(D2UnitStrc *pOwner, int nVelocity) {
      while (g(nVelocity)) {
        nVelocity = (int)D2Common::Units::Units::UNITS_GetRoom(pOwner);
      }
    }`;
    assert.strictEqual(run(src, V).replace(/\s+/g, ' '), run(src, {}).replace(/\s+/g, ' '));
  });

  it('leaves a register parameter, an integer reused as an integer, and a type nothing says', () => {
    const reg = `int f(D2UnitStrc *pOwner, int nScratch) { nScratch = (int)D2Common::Units::Units::UNITS_GetRoom(pOwner); return h((D2RoomStrc *)nScratch); }`;
    assert.ok(!/pRoom/.test(run(reg, V)), 'not a stack parameter');
    const ints = `int f(int nVelocity) { g(nVelocity); nVelocity = q(); return (int)nVelocity; }`;
    assert.strictEqual(run(ints, V).replace(/\s+/g, ' '), run(ints, {}).replace(/\s+/g, ' '));
    const unknown = `int f(int nVelocity) { g(nVelocity); nVelocity = q(); return h(nVelocity); }`;
    assert.strictEqual(run(unknown, V).replace(/\s+/g, ' '), run(unknown, {}).replace(/\s+/g, ' '));
  });

  it('computes what the slot computed (a pointer slot carries an integer)', native, () => {
    const prelude = `
      struct D2UnitStrc { int nId; };
      static int g(D2UnitStrc *p) { return p ? p->nId : -1; }`;
    const fn = `int f(D2UnitStrc *pUnit, int n) {
        int a = g(pUnit);
        pUnit = (D2UnitStrc *)(intptr_t)(n << 4);
        return a + (int)(intptr_t)pUnit + 1;
      }`;
    const o: ReusedParamSlotOptions = { stackParameters: ['pUnit'] };
    const split = run(fn, o);
    assert.ok(/intptr_t nUnit;/.test(split), split);
    const call = 'D2UnitStrc u = { 7 }; printf("%d\\n", f(&u, 3));';
    assert.strictEqual(compileAndRun(prelude + split, call), compileAndRun(prelude + fn, call));
  });
});

describe('reused-param-slot: the second value typed by member reads, with constant stores voting for nothing (round 13)', () => {
  const V: ReusedParamSlotOptions = {
    stackParameters: ['pTarget', 'eSkill'],
    functionReturnTypes: { 'D2Common::PATH::DynamicPath::GetXPos': 'int32_t', GetXPos: 'int32_t' },
    structFields: { D2UnitStrc: { pPath: 'D2PathUnion' }, D2PathUnion: { pStaticPath: 'D2StaticPathStrc *', pDynamicPath: 'D2DynamicPathStrc *' }, D2StaticPathStrc: { nPosX: 'int' } },
    enumConstants: ['MISSILE_Arrow'],
    enumValues: { MISSILE_Arrow: 0 },
  };
  it("MoveAndCastSkill @005de4e0: pTarget's slot holds the caster's X once pTarget is dead", () => {
    const out = run(`int f(D2UnitStrc *pUnit, D2UnitStrc *pTarget, int nXOffset) {
      int nDist;
      nDist = GetDistance(pUnit, pTarget);
      if (pUnit->eUnitType == 2) {
        pTarget = (D2UnitStrc *)((pUnit->pPath).pStaticPath)->nPosX;
      }
      else if ((pUnit->pPath).pDynamicPath == (D2DynamicPathStrc *)0x0) {
        pTarget = (D2UnitStrc *)0x0;
      }
      else {
        pTarget = (D2UnitStrc *)D2Common::PATH::DynamicPath::GetXPos((pUnit->pPath).pDynamicPath);
      }
      return nXOffset - (int)pTarget + nDist;
    }`, V);
    assert.match(out, /int nTarget;/);
    assert.match(out, /nTarget = pUnit->pPath\.pStaticPath->nPosX;/);
    assert.match(out, /nTarget = 0x0;|nTarget = 0;/);
    assert.match(out, /return nXOffset - nTarget \+ nDist;/);
    assert.match(out, /GetDistance\(pUnit, pTarget\)/);
  });
  it('without the member tables the second type is still not evident', () => {
    const out = run(`int f(D2UnitStrc *pUnit, D2UnitStrc *pTarget) {
      g(pTarget);
      if (pUnit) pTarget = (D2UnitStrc *)((pUnit->pPath).pStaticPath)->nPosX; else pTarget = (D2UnitStrc *)0x0;
      return h(pTarget);
    }`, { stackParameters: ['pTarget'] });
    assert.doesNotMatch(out, /nTarget/);
  });
});

describe('reused-param-slot: mixed integer views of a reused pointer slot', () => {
  const V: ReusedParamSlotOptions = { stackParameters: ['nParam'] };

  it('MONSTER_InitStats @00573cb0: keeps the incoming pointer and gives the later difficulty its own word local', () => {
    const out = run(`void f(Game *pGame, short *nParam, Unit *pUnit) {
      uint8_t byDifficultyIdx;
      short *psVar2;
      UseRegion((uint8_t *)nParam, pUnit);
      byDifficultyIdx = pGame->nDifficulty;
      if (byDifficultyIdx) {
        if (1 < byDifficultyIdx) { nParam = (short *)0x2; goto difficulty; }
        nParam = (short *)(uint32_t)byDifficultyIdx;
        goto difficulty;
      }
      nParam = (short *)0x0;
    difficulty:
      if (GetMercType(pUnit)) nParam = (short *)0x0;
      UseLevel(pUnit->aLevel[(int)nParam]);
      if (nParam != (short *)0x0) {
        psVar2 = nParam;
        UseDifficulty((Difficulty)psVar2);
      }
      UseUnsigned((uint32_t)nParam);
      UseNested((uint32_t)(int)nParam);
      UseOffset((intptr_t)nParam);
    }`, V);
    assert.match(out, /uint32_t nParam2;/);
    assert.match(out, /UseRegion\(\(uint8_t\*\)nParam, pUnit\)/);
    assert.match(out, /nParam2 = 0x2;/);
    assert.match(out, /nParam2 = \(uint32_t\)byDifficultyIdx;/);
    assert.match(out, /aLevel\[\(int\)nParam2\]/);
    assert.match(out, /UseUnsigned\(nParam2\)/);
    assert.match(out, /UseNested\(\(uint32_t\)\(int\)nParam2\)/);
    assert.match(out, /UseOffset\(\(intptr_t\)nParam2\)/);
    assert.doesNotMatch(out, /nParam = \(short int\*\)/);
  });

  it('refuses a loop read reached by both the entry pointer and a later integer store', () => {
    const src = `void f(short *nParam, uint32_t next) {
      while (UseRegion((uint8_t *)nParam)) {
        nParam = (short *)(uint32_t)next;
      }
      UseLevel((int)nParam);
      UseUnsigned((uint32_t)nParam);
    }`;
    assert.strictEqual(run(src, V).replace(/\s+/g, ' '), run(src, {}).replace(/\s+/g, ' '));
  });

  it('refuses a second lifetime read through an unrelated pointer type', () => {
    const src = `void f(short *nParam, uint32_t next) {
      UseRegion(nParam);
      nParam = (short *)(uint32_t)next;
      UseLevel((int)nParam);
      UseOther((Other *)nParam);
    }`;
    assert.strictEqual(run(src, V).replace(/\s+/g, ' '), run(src, {}).replace(/\s+/g, ' '));
  });

  it('refuses a pointer cast around an integer cast of the second lifetime', () => {
    const src = `void f(short *nParam, int next) {
      UseRegion(nParam);
      nParam = (short *)(int)next;
      UseLevel((uint32_t)nParam);
      UseOther((Other *)(int)nParam);
    }`;
    assert.strictEqual(run(src, V).replace(/\s+/g, ' '), run(src, {}).replace(/\s+/g, ' '));
  });

  it('refuses a wider integer view of the reused slot', () => {
    const src = `void f(short *nParam, uint32_t next) {
      UseRegion(nParam);
      nParam = (short *)(uint32_t)next;
      UseLevel((int)nParam);
      UseWide((uint64_t)nParam);
    }`;
    assert.strictEqual(run(src, V).replace(/\s+/g, ' '), run(src, {}).replace(/\s+/g, ' '));
  });

  it('refuses a slot whose parameter address escapes', () => {
    const src = `void f(short *nParam, uint32_t next) {
      SaveAddress(&nParam);
      nParam = (short *)(uint32_t)next;
      UseLevel((int)nParam);
      UseUnsigned((uint32_t)nParam);
    }`;
    assert.strictEqual(run(src, V).replace(/\s+/g, ' '), run(src, {}).replace(/\s+/g, ' '));
  });
});

describe('reused-param-slot: the current MONSTER_InitStats body', () => {
  it('preserves the incoming pointer, difficulty byte address, aliases and mixed word views', native, () => {
    const lower = (split: boolean) => transformGhidraCode(nativeInput, {
      preset: 'full', usePluginRegistry: true, tolerateErrors: false,
      pluginOptions: { pluginOptions: { 'reused-param-slot': { stackParameters: split ? ['p'] : [] } } },
    }).code;
    assert.strictEqual(compileAndRun(nativeHarness(lower(false), lower(true)), 'if (CheckCases()) return 1;',
      { optimize: true, flags: ['-fwrapv', '-fno-delete-null-pointer-checks'] }).trim(), '1548');
  });

  it('splits the current v2088 body with its small-address store and typed region-field read', () => {
    const source = readFileSync(new URL('./fixtures/reused-param-slot/00573cb0.c', import.meta.url), 'utf8');
    const out = run(source, { stackParameters: ['pMonRegionField'] });
    const code = out.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(code, /\b(?:uint|uint32_t|unsigned int) nMonRegionField;/);
    assert.match(code, /MONSTER_RollComponentAppearance\(pMonRegionField, pUnit\)/);
    assert.strictEqual((code.match(/\bpMonRegionField\b/g) ?? []).length, 2, 'only the parameter and its incoming-pointer use remain');
    assert.doesNotMatch(code, /\bpMonRegionField\s*=/);
  });

  it('keeps the captured function split through the full transform pipeline', () => {
    const source = readFileSync(new URL('./fixtures/reused-param-slot/00573cb0.c', import.meta.url), 'utf8');
    const out = transformGhidraCode(source, {
      preset: 'full', usePluginRegistry: true, tolerateErrors: false,
      pluginOptions: { pluginOptions: { 'reused-param-slot': { stackParameters: ['pMonRegionField'] } } },
    }).code.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(out, /\bnMonRegionField\b/);
    assert.strictEqual((out.match(/\bpMonRegionField\b/g) ?? []).length, 2);
    assert.doesNotMatch(out, /\bDAT_00000002\b/);
  });

  for (const address of ['&DAT_00002000', '&gRegion']) {
    it(`still requires a type for the real address ${address}`, () => {
      const source = `void f(Region *p, uint32_t next, int choose) {
        UseRegion(p);
        p = (Region *)(uint32_t)next;
        if (choose) p = (Region *)${address};
        UseUnsigned((uint32_t)p);
        UseSigned((int)p);
      }`;
      assert.strictEqual(run(source, { stackParameters: ['p'] }), run(source, {}));
    });
  }

  it('does not treat the address of a shadowing local DAT name as a literal', () => {
    const source = `void f(Region *p, uint32_t next, int choose) {
      int DAT_00000002;
      UseRegion(p);
      p = (Region *)(uint32_t)next;
      if (choose) p = (Region *)&DAT_00000002;
      UseUnsigned((uint32_t)p);
      UseSigned((int)p);
    }`;
    assert.strictEqual(run(source, { stackParameters: ['p'] }), run(source, {}));
  });
});
