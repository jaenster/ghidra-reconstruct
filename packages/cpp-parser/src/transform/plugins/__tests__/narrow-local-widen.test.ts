/**
 * A one- or two-byte local the original compares at four bytes against a constant was an
 * int (narrow-local-widen). PLRSKILLS_CheckSkillWhipAndLeap 004d8520 loads the skill row's
 * srvdofunc with `MOVSX EAX, word ptr [EAX+0x2e]` and compares `CMP EAX,0x43`; Ghidra's
 * two-byte `short sSrvDoFunc` compiles to MOVZX and `CMP AX,0x43`. The widening must keep
 * every value: the native check runs the narrow and the wide form over every short.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createCompareFormTransformer, type CompareFormDecision, type CompareFormOptions } from '../builtins/compare-form.js';
import { createNarrowLocalWidenTransformer } from '../builtins/narrow-local-widen.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

type Site = { text: string; fp: [string, string]; size?: number };
const dec = (d: Partial<CompareFormDecision> & { ord: number; text: string; fp: [string, string] }): CompareFormDecision =>
  ({ width: 4, address: '00401000', keep: true, ...d });

const TABLES = { structFields: { D2SkillsTxt: { srvdofunc: 'short', nFlags: 'uint8_t' } } };

function run(code: string, sites: Site[], decisions: CompareFormDecision[], opts: Record<string, unknown> = TABLES): string {
  const tagged = createCompareFormTransformer({ sites, decisions } as CompareFormOptions)(parse(code));
  return emit(createNarrowLocalWidenTransformer(opts)(tagged) as AnyNode).trim();
}

const WHIP = `void f(D2SkillsTxt *pSkillsTxt) {
  short sSrvDoFunc = pSkillsTxt->srvdofunc;
  if (sSrvDoFunc != 0x43) {
    if (sSrvDoFunc == 0x4c) {
      g(1);
    }
    return;
  }
  g(2);
}`;
const WHIP_SITES: Site[] = [{ text: '!=', fp: ['v:sSrvDoFunc', 'c:43'] }, { text: '==', fp: ['v:sSrvDoFunc', 'c:4c'] }];

describe('narrow-local-widen', () => {
  it('PLRSKILLS_CheckSkillWhipAndLeap: the short compared at four bytes is declared int32_t', () => {
    const out = run(WHIP, WHIP_SITES, WHIP_SITES.map((s, ord) => dec({ ord, ...s })));
    assert.match(out, /int32_t sSrvDoFunc = pSkillsTxt->srvdofunc;/);
  });

  it('keeps a local any tied compare makes at its own width', () => {
    const out = run(WHIP, WHIP_SITES, [dec({ ord: 0, ...WHIP_SITES[0] }), dec({ ord: 1, ...WHIP_SITES[1], width: 2 })]);
    assert.match(out, /short (int )?sSrvDoFunc/);
  });

  it('keeps a local compared only with another variable', () => {
    const code = 'void f(D2SkillsTxt *p, int n) { short s = p->srvdofunc; if (s != n) { g(1); } }';
    const sites: Site[] = [{ text: '!=', fp: ['v:s', 'v:n'] }];
    assert.match(run(code, sites, [dec({ ord: 0, ...sites[0] })]), /short (int )?s =/);
  });

  it('keeps a local that is modified in place or whose address is taken', () => {
    const sites: Site[] = [{ text: '!=', fp: ['v:s', 'c:43'] }];
    for (const use of ['s++;', '--s;', 's += 2;', 'h(&s);']) {
      const code = `void f(D2SkillsTxt *p) { short s = p->srvdofunc; ${use} if (s != 0x43) { g(1); } }`;
      assert.match(run(code, sites, [dec({ ord: 0, ...sites[0] })]), /short (int )?s =/, use);
    }
  });

  it('keeps a local assigned a value its type might not hold', () => {
    const sites: Site[] = [{ text: '==', fp: ['v:s', 'c:5'] }];
    for (const value of ['n', '0x12345', 'n & 0x1ffff']) {
      const code = `void f(int n) { short s; s = ${value}; if (s == 5) { g(1); } }`;
      assert.match(run(code, sites, [dec({ ord: 0, ...sites[0] })]), /short (int )?s;/, value);
    }
  });

  it('widens a byte assigned casts, masks and literals in range, against an enum constant', () => {
    const code = `void f(uint32_t n, D2SkillsTxt *p) {
  uint8_t by = (uint8_t)(n >> 8);
  if (by == UNIT_MONSTER) {
    by = p->nFlags & 0x1f;
  }
  if (by < 7) {
    by = 3;
  }
}`;
    const sites: Site[] = [{ text: '==', fp: ['v:by', 'c:1'] }, { text: '<', fp: ['v:by', 'c:7'] }];
    const out = run(code, sites, sites.map((s, ord) => dec({ ord, ...s })),
      { ...TABLES, enumConstantNames: ['UNIT_MONSTER'] });
    assert.match(out, /int32_t by = \(uint8_t\)\(n >> 8\);/);
  });

  it('leaves a static, a parameter and a shared declaration alone', () => {
    const sites: Site[] = [{ text: '!=', fp: ['v:s', 'c:43'] }];
    const statik = run('void f(D2SkillsTxt *p) { static short s; s = p->srvdofunc; if (s != 0x43) { g(1); } }', sites,
      [dec({ ord: 0, ...sites[0] })]);
    assert.match(statik, /static short (int )?s;/);
    const param = run('void f(short s) { if (s != 0x43) { g(1); } }', sites, [dec({ ord: 0, ...sites[0] })]);
    assert.match(param, /short (int )?s\)/);
    const shared = run('void f(D2SkillsTxt *p) { short s, t; s = p->srvdofunc; t = 1; if (s != 0x43) { g(t); } }', sites,
      [dec({ ord: 0, ...sites[0] })]);
    assert.match(shared, /short (int )?s, t;/);
  });

  it('computes what the narrow local computed, over every short', { skip: !hasNativeGpp() }, () => {
    const out = run(WHIP.replace('void f(D2SkillsTxt *pSkillsTxt)', 'int wide(D2SkillsTxt *pSkillsTxt)')
      .replace(/g\(1\);/, 'return 1;').replace(/g\(2\);/, 'return 2;').replace('return;', 'return 0;'),
      WHIP_SITES, WHIP_SITES.map((s, ord) => dec({ ord, ...s })));
    assert.match(out, /int32_t sSrvDoFunc/);
    const narrow = out.replace('int wide(', 'int narrow(').replace('int32_t sSrvDoFunc', 'short sSrvDoFunc');
    const res = compileAndRun(`struct D2SkillsTxt { short srvdofunc; };\n${out}\n${narrow}`,
      'int bad = 0; for (int v = -32768; v < 32768; v++) { D2SkillsTxt t; t.srvdofunc = (short)v; if (wide(&t) != narrow(&t)) bad++; } printf("%d\\n", bad);');
    assert.strictEqual(res.trim(), '0');
  });

  // CLIENT_UpdateUnitLightRadius 00460930: `MOVZX EAX,AL; CMP EAX,ECX; JGE` against a byte field.
  describe('a byte local the original compares signed at four bytes with a byte field', () => {
    const LIGHT = `void f(D2MonStats2Txt *pMonStats2, D2UnitStrc *pUnit) {
  uint8_t bVar1;
  uint32_t nLightRadius;
  bVar1 = GetRadius(pUnit);
  nLightRadius = (uint32_t)bVar1;
  if ((uint32_t)bVar1 < (uint32_t)pMonStats2->byLight) {
    nLightRadius = (uint32_t)pMonStats2->byLight;
  }
  g(nLightRadius);
}`;
    const sites: Site[] = [{ text: '<', fp: ['e', 'e'] }];
    const tables = { structFields: { D2MonStats2Txt: { byLight: 'uint8_t' } }, functionReturnTypes: { GetRadius: 'uint8_t' } };
    // compare-form reads the same type tables to prove the operands narrow.
    const both = (code: string, t: Record<string, unknown>) => emit(createNarrowLocalWidenTransformer(t)(
      createCompareFormTransformer({ sites, decisions: [dec({ ord: 0, ...sites[0], signed: true, zextPair: true })], ...t } as CompareFormOptions)(parse(code))) as AnyNode);
    it('drops the unsigned casts and declares the local int', () => {
      const out = both(LIGHT, tables).replace(/\s+/g, ' ');
      assert.ok(out.includes('if (bVar1 < pMonStats2->byLight)'), out);
      assert.ok(out.includes('int32_t bVar1;'), out);
    });
    it('leaves the compare as printed when an operand is not a zero-extended narrow value', () => {
      const wide = { structFields: { D2MonStats2Txt: { byLight: 'uint32_t' } }, functionReturnTypes: { GetRadius: 'uint8_t' } };
      const out = both(LIGHT, wide).replace(/\s+/g, ' ');
      assert.ok(out.includes('(uint32_t)bVar1 < (uint32_t)pMonStats2->byLight'), out);
      assert.ok(out.includes('uint8_t bVar1;'), out);
    });
  });

  // Q33_Callback02_NpcDeactivate 00588f80: `MOV EAX,dword ptr [EAX+4] .. CMP AX,0x201`.
  describe('a narrow local the original loads whole and compares narrow', () => {
    const Q33 = `void f(D2QuestArgStrc *pQuestArgs) {
  short nTargetClassId = !pQuestArgs->pTarget ? -1 : (short)pQuestArgs->pTarget->nClassId;
  if (nTargetClassId != 0x201) {
    return;
  }
  g();
}`;
    const sites: Site[] = [{ text: '!=', fp: ['v:nTargetClassId', 'c:201'], size: 2 }];
    const tables = { structFields: { D2UnitStrc: { nClassId: 'int' }, D2QuestArgStrc: { pTarget: 'D2UnitStrc*' } } };

    it('declares it int, drops the cast on the load and narrows it at the compare', () => {
      const out = run(Q33, sites, [dec({ ord: 0, ...sites[0], width: 2 })], tables).replace(/\s+/g, ' ');
      assert.ok(out.includes('int32_t nTargetClassId = !pQuestArgs->pTarget ? -1 : pQuestArgs->pTarget->nClassId;'), out);
      assert.ok(/if \(\(short( int)?\)nTargetClassId != 0x201\)/.test(out), out);
    });

    it('leaves it where it is read other than in a narrow compare, or holds a wider value', () => {
      const read = run(Q33.replace('g();', 'g(nTargetClassId);'), sites, [dec({ ord: 0, ...sites[0], width: 2 })], tables);
      assert.match(read, /short (int )?nTargetClassId/);
      const wide = run(Q33, sites, [dec({ ord: 0, ...sites[0], width: 4 })], tables);
      assert.ok(!/\(short( int)?\)nTargetClassId/.test(wide), wide);
      const big = run(Q33.replace('? -1 :', '? 0x12345 :'), sites, [dec({ ord: 0, ...sites[0], width: 2 })], tables);
      assert.match(big, /short (int )?nTargetClassId/);
      const narrowField = run(Q33, sites, [dec({ ord: 0, ...sites[0], width: 2 })], { structFields: { D2UnitStrc: { nClassId: 'short' }, D2QuestArgStrc: { pTarget: 'D2UnitStrc*' } } });
      assert.match(narrowField, /short (int )?nTargetClassId/);
    });
  });

  // NET_SID_CLIENT_SetCDKeyBit 005225a0 and its neighbours: `MOV ECX,EDX; AND ECX,0x1f`.
  describe('a narrow local the original computes in a full register', () => {
    const go = (code: string) => run(code, [], [], {}).replace(/\s+/g, ' ');
    it('declares a masked byte int and drops the cast under the mask', () => {
      const out = go('void f(uint32_t* p, uint32_t nBitIndex) { uint8_t byBitPos = (uint8_t)nBitIndex & 0x1f; p[0] = 1 << byBitPos; }');
      assert.ok(out.includes('int32_t byBitPos = nBitIndex & 0x1f;'), out);
    });
    it('takes a multiple of a mask and spells its char operand as an integer', () => {
      const out = go("uint32_t f(uint32_t* p, uint32_t n) { int8_t nShift = ((uint8_t)n & 7) * '\\x04'; return p[0] >> nShift; }");
      assert.ok(out.includes('int32_t nShift = (n & 7) * 4;'), out);
    });
    it('takes a value an early-return guard holds in range (DAMAGE_SafeShiftMultiply 0057e350)', () => {
      const out = go('int f(int a, int n) { if (!(n - 1U <= 0x1e)) { return a; } uint8_t byShift = (uint8_t)n; return a >> byShift; }');
      assert.ok(out.includes('int32_t byShift = n;'), out);
    });
    it('leaves a value out of range, unguarded, stored again, or compared narrow', () => {
      assert.ok(go('void f(uint32_t n) { int8_t b = (uint8_t)n & 0xff; g(b); }').includes('int8_t b'));
      assert.ok(go('int f(int a, int n) { uint8_t s = (uint8_t)n; return a >> s; }').includes('uint8_t s'));
      assert.ok(go('int f(int a, int n) { if (!(n - 1 <= 0x1e)) { return a; } uint8_t s = (uint8_t)n; return a >> s; }').includes('uint8_t s'));
      assert.ok(go('int f(int a, int n) { if (!(n - 1U <= 0x1e)) { return a; } n = g(); uint8_t s = (uint8_t)n; return a >> s; }').includes('uint8_t s'));
      assert.ok(go('void f(uint32_t n) { uint8_t b = (uint8_t)n & 0x1f; b = 3; g(b); }').includes('uint8_t b'));
      assert.ok(go('void f(uint32_t n) { uint8_t b = (uint8_t)n & 0x1f; g(&b); }').includes('uint8_t b'));
    });
  });
});
