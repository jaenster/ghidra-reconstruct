/**
 * Tests for the seed roll step: a D2 seed step written back into the seed it read becomes
 * `D2_SeedRoll(&seed)`. The golden cases are Game.exe decompiles (live, program v2058) run
 * through the whole pipeline with the seed struct's layout as the generator supplies it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { transformGhidraCode } from '../../../ghidra.js';
import { seedRollStepPlugin } from '../builtins/seed-roll-step.js';

function run(code: string): { out: string; sites: number } {
  let sites = 0;
  const t = seedRollStepPlugin.createTransformer({ onSite: () => { sites++; } });
  return { out: emit(t(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim(), sites };
}

describe('seedRollStepPlugin', () => {
  it('a step stored back high word then low word becomes the call; the temporary holds the low word', () => {
    const { out, sites } = run(`void f(D2SeedStrc* pSeed) {
      int n;
      D2SeedStrc sNext;
      sNext = D2_SEED_NEXT(*pSeed);
      pSeed->nSeedHigh = sNext.nSeedHigh;
      pSeed->nSeedLow = sNext.nSeedLow;
      n = (int)(sNext.nSeedLow % 5);
    }`);
    assert.strictEqual(sites, 1);
    assert.match(out, /uint32_t sNext; sNext = D2_SeedRoll\(pSeed\); n = \(int\)\(sNext % 5\);/);
    assert.doesNotMatch(out, /nSeedHigh|D2_SEED_NEXT/);
  });

  it('a struct-copy write-back into a member seed takes its address', () => {
    const { out } = run(`void f(D2UnitStrc* pUnit) {
      D2SeedStrc s = D2_SEED_NEXT(pUnit->sSeed);
      pUnit->sSeed = s;
      g(s.nSeedLow & 0x3f);
    }`);
    assert.match(out, /uint32_t s = D2_SeedRoll\(&pUnit->sSeed\); g\(s & 0x3f\);/);
  });

  it('a step whose value nothing reads is a bare call, and its temporary goes', () => {
    const { out } = run(`void f(D2UnitStrc* pUnit) {
      D2SeedStrc s;
      s = D2_SEED_NEXT(pUnit->sSeed);
      pUnit->sSeed = s;
      pUnit->sSeed = D2_SEED_NEXT(pUnit->sSeed);
    }`);
    assert.strictEqual(out, 'void f(D2UnitStrc* pUnit) { D2_SeedRoll(&pUnit->sSeed); D2_SeedRoll(&pUnit->sSeed); }');
  });

  it('a label on the step stays on the call', () => {
    const { out } = run(`void f(D2UnitStrc* pUnit) {
      D2SeedStrc DVar1;
      int n;
      roll:
      DVar1 = D2_SEED_NEXT(pUnit->sSeed);
      pUnit->sSeed = DVar1;
      n = DVar1.nSeedLow % 100;
      if (n < 3) goto roll;
    }`);
    assert.match(out, /roll: DVar1 = D2_SeedRoll\(&pUnit->sSeed\); n = DVar1 % 100;/);
  });

  it('local declarations and arithmetic between the step and its write-back move after the call', () => {
    const { out } = run(`void f(D2SeedStrc* pSeed) {
      D2SeedStrc s;
      s = D2_SEED_NEXT(*pSeed);
      char c;
      c = '\\0';
      *pSeed = s;
      g(s.nSeedLow, c);
    }`);
    assert.match(out, /s = D2_SeedRoll\(pSeed\); char c; c = '\\0'; g\(s, c\);/);
  });

  it('a temporary a later D2_SEED_NEXT_VAL continues from keeps its form', () => {
    const code = `void f(D2UnitStrc* pUnit) {
      D2SeedStrc s = D2_SEED_NEXT(pUnit->sSeed);
      pUnit->sSeed = s;
      s = D2_SEED_NEXT_VAL(s);
      pUnit->sSeed = s;
    }`;
    assert.strictEqual(run(code).sites, 0);
  });

  it('a write-back into another seed, a high-word read, or a call in between keeps the form', () => {
    assert.strictEqual(run(`void f(D2SeedStrc* a, D2SeedStrc* b) {
      D2SeedStrc s = D2_SEED_NEXT(*a);
      *b = s;
    }`).sites, 0);
    assert.strictEqual(run(`void f(D2SeedStrc* a) {
      D2SeedStrc s = D2_SEED_NEXT(*a);
      *a = s;
      g(s.nSeedHigh);
    }`).sites, 0);
    assert.strictEqual(run(`void f(D2SeedStrc* a) {
      int n;
      D2SeedStrc s = D2_SEED_NEXT(*a);
      n = h();
      *a = s;
      g(s.nSeedLow + n);
    }`).sites, 0);
  });

  it('a seed lvalue with a call in it keeps the form', () => {
    assert.strictEqual(run(`void f(D2GameStrc* pGame) {
      D2SeedStrc s = D2_SEED_NEXT(*GetSeed(pGame));
      *GetSeed(pGame) = s;
    }`).sites, 0);
  });

  it('a frame seed stepped in place as D2_SEED_NEXT_VAL becomes the call', () => {
    const { out, sites } = run(`void f(int n) {
      D2SeedStrc sSeed;
      InitSeed(&sSeed, n);
      sSeed = D2_SEED_NEXT_VAL(sSeed);
      g(sSeed.nSeedLow % 100);
    }`);
    assert.strictEqual(sites, 1);
    assert.match(out, /D2_SeedRoll\(&sSeed\); g\(sSeed\.nSeedLow % 100\);/, out);
  });

  it('a D2_SEED_NEXT_VAL self-step of a seed in registers, or of another seed, keeps its form', () => {
    assert.strictEqual(run(`void f(D2UnitStrc* pUnit) {
      D2SeedStrc s;
      s = pUnit->sSeed;
      s = D2_SEED_NEXT_VAL(s);
      pUnit->sSeed = s;
    }`).sites, 0);
    assert.strictEqual(run(`void f(int n) {
      D2SeedStrc a;
      D2SeedStrc b;
      InitSeed(&a, n);
      b = D2_SEED_NEXT_VAL(a);
      g(b.nSeedLow);
    }`).sites, 0);
  });

  it('a temporary whose address is taken keeps the form', () => {
    assert.strictEqual(run(`void f(D2SeedStrc* a) {
      D2SeedStrc s = D2_SEED_NEXT(*a);
      *a = s;
      g(&s.nSeedLow);
    }`).sites, 0);
  });
});

describe('Golden: seed steps in Game.exe decompiles', () => {
  const fixture = (addr: string) =>
    readFileSync(new URL(`./fixtures/seed-roll/${addr}.c`, import.meta.url), 'utf8')
      .replace(/(?:\w+::)+(\w+)\s*\(/, '$1(');
  // The seed struct as the generator describes it to the passes that spell its words.
  const layout = {
    structFields: { D2SeedStrc: { nSeedLow: 'uint32_t', nSeedHigh: 'uint32_t' } },
    structFieldOffsets: { D2SeedStrc: { nSeedLow: 0, nSeedHigh: 4 } },
    aggregateSizes: { D2SeedStrc: 8 },
    convertingAggregates: ['D2SeedStrc'],
  };
  const full = (addr: string) => transformGhidraCode(fixture(addr), {
    preset: 'full', usePluginRegistry: true, tolerateErrors: false,
    pluginOptions: { pluginOptions: { 'arith-idioms': layout, 'float-pointer-bitcast': layout } as never },
  }).code.replace(/\s+/g, ' ');

  // `MOV [EBX+4],EDX; MOV [EBX],EAX` and the DIV on EAX: the roll's low word, in a loop.
  it('RollStonesOrder 00592e90: the quest seed roll in the loop', () => {
    const out = full('00592e90');
    assert.match(out, /uint32_t sNextSeed;/, out);
    assert.match(out, /sNextSeed = D2_SeedRoll\(pSeed\); nRandomStoneSlot = \(int\)\(sNextSeed % 5\);/, out);
    assert.doesNotMatch(out, /D2_SEED_NEXT|\*pSeed = sNextSeed/, out);
  });

  // The low store before the ADC: VC8 puts it there only for the call form.
  it('OBJECT_ClientFn_PeriodicOperate 004bd730: both rolls of the unit seed', () => {
    const out = full('004bd730');
    assert.strictEqual(out.match(/DVar1 = D2_SeedRoll\(&pUnit->sSeed\);/g)?.length, 2, out);
    assert.match(out, /pUnit->dwTickCount = DVar1 & 0x3f;/, out);
    assert.doesNotMatch(out, /D2_SEED_NEXT|pUnit->sSeed = DVar1/, out);
  });

  // The high word stored before the % 7, the low word after it: the reciprocal between the
  // step and its write-back is plain arithmetic on the low word.
  it('Q28_TimerCallback_DropForgeRunes 005b6710: the % 7 between the step and the write-back', () => {
    const out = full('005b6710');
    assert.strictEqual(out.match(/sSeedNext = D2_SeedRoll\(pSeed\); nRngMod = \(int\)\(\(uint64_t\)sSeedNext \* 0x24924925 >> 0x20\);/g)?.length, 2, out);
    assert.doesNotMatch(out, /D2_SEED_NEXT|\*pSeed = sSeedNext/, out);
  });

  // A frame seed (InitSeed is handed its address) stepped in place: VC8 keeps the printed step's
  // words in a 4-byte frame temporary the original does not have; the call form drops it.
  it('MISSILE_CalculatePierceCount 004cd420: the pierce roll of a frame seed', () => {
    const out = full('004cd420');
    assert.match(out, /D2_SeedRoll\(&sSeed\)/, out);
    assert.doesNotMatch(out, /D2_SEED_NEXT/, out);
  });

  // The second step reuses the first one's registers (no reload): the chain stays.
  it('CLIENT_SendMonsterMoveToRandomNearbyPosMessage 0046c960: a D2_SEED_NEXT_VAL chain keeps its form', () => {
    const out = full('0046c960');
    assert.match(out, /D2_SEED_NEXT\(pUnit->sSeed\)/, out);
    assert.match(out, /D2_SEED_NEXT_VAL\(sSeed\)/, out);
    assert.doesNotMatch(out, /D2_SeedRoll/, out);
  });
});
