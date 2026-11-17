import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const field = (name: string, offset: number, size: number, type: string) => ({ name, offset, size, type });
const TABLES: Vc8FormTables = {
  structFields: {
    D2GSPacketSrv0x8C: { nPacketId: 'uint8_t', nUnitGUID: 'uint32_t', nOtherUnitGUID: 'uint32_t', wRelationFlags: 'uint16_t' },
    D2StateExArgStrc: { pUnit: 'D2UnitStrc*', pTarget: 'D2UnitStrc*', eSkill: 'eD2Skills', nSkillLvl: 'int', nDurationInFrames: 'int', eStat: 'eD2Skills', nSkillCalc: 'int', eAuraState: 'int', pFunction: 'void*' },
    D2SkillArgStrc: { nFlags: 'int', pOwner: 'D2UnitStrc*', nMissileTxtNo: 'eMissilesId', nX: 'int', nY: 'int', eSkillNo: 'eD2Skills', nSkillLevel: 'int', aBytes: 'uint8_t[4]', nBits: 'int' },
    D2SkillsTxt: { cltmissile: 'int16_t[4]' },
    D2DataTablesStrc: { nTxtMissilesSize: 'int' },
    U: { a: 'int', b: 'int' },
  },
  structLayouts: {
    D2SkillArgStrc: [field('nFlags', 0, 4, 'int'), field('pOwner', 4, 4, 'D2UnitStrc*'), field('nMissileTxtNo', 16, 4, 'eMissilesId'),
      { ...field('nBits', 60, 4, 'int'), bitSize: 3 }],
  },
  unionNames: ['U'],
  globalTypes: { sgptDataTable: 'D2DataTablesStrc*', gpAny: 'uint8_t*' },
};
function run(source: string, tag: string, tables: Vc8FormTables | undefined = TABLES) {
  const form = parseVc8Form(tag);
  assert.ok(form, tag);
  const sites: Vc8FormSite[] = [];
  const output = applyVc8Forms(parse(source) as TranslationUnit, [{ form, tag }], s => sites.push(s), tables);
  return { before: flat(emit(parse(source) as AnyNode)), out: flat(emit(output as AnyNode)), site: sites[0]! };
}
function applied(source: string, tag: string, want: string) {
  const { out, site } = run(source, tag);
  assert.equal(site.applied, true, site.why);
  assert.equal(out, flat(emit(parse(want) as AnyNode)));
}
function refused(source: string, tag: string, why?: RegExp, tables?: Vc8FormTables) {
  const { before, out, site } = run(source, tag, tables ?? TABLES);
  assert.equal(site.applied, false, source);
  assert.equal(out, before, source);
  if (why) assert.match(site.why!, why);
}

// NET_D2GS_SERVER_Send_0x8C_PLAYERFLAGS 0053de50, as the generator prints it.
const PLAYERFLAGS = `void f(D2UnitStrc* pUnit, uint32_t nUnitGUID, uint32_t nOtherUnitGUID, uint16_t wRelationFlags) {
  D2GSPacketSrv0x8C packet;
  packet.nOtherUnitGUID = nOtherUnitGUID;
  size_t nSize = 0xb;
  D2GSPacketSrv0x8C* pBytes = &packet;
  packet.nUnitGUID = nUnitGUID;
  packet.wRelationFlags = wRelationFlags;
  packet.nPacketId = 0x8c;
  SCMD_QueuePacketForClient(SUNIT_GetClient(pUnit, "x", 0xbd0), &pBytes->nPacketId, nSize);
}`;
// SKILL_ApplyTimedStateWithCurseExpiry 005d6520, the part before the call.
const TIMEDSTATE = `uint32_t f(D2SkillCallbackContextStrc* pContext, D2UnitStrc* pUnit) {
  eD2Skills* pStatId = (eD2Skills*)pContext->pCallbackArg;
  D2StateExArgStrc sStateArgs;
  memset(&sStateArgs, 0, sizeof(sStateArgs));
  sStateArgs.pUnit = pContext->pUnit;
  sStateArgs.eSkill = *pStatId;
  sStateArgs.nSkillLvl = pStatId[1];
  sStateArgs.eStat = pStatId[4];
  if ((int)sStateArgs.eStat <= 0) {
    sStateArgs.eStat = ~SKILL_Attack;
  }
  sStateArgs.pFunction = OnCurseExpire;
  sStateArgs.pTarget = pUnit;
  return SetStateWithExpiryTime(&sStateArgs) != 0;
}`;
// Skills_CltDoFunc_DualMissileAtCoords 004f1f20, the missile part.
const DUAL = `BOOL f(D2UnitStrc* pUnit, D2SkillsTxt* pSkillTxt) {
  D2SkillArgStrc sSkillArg;
  memset(&sSkillArg, 0, 0x5c);
  sSkillArg.pOwner = pUnit;
  if (pSkillTxt->cltmissile[1] >= 0) {
    sSkillArg.nMissileTxtNo = (eMissilesId)pSkillTxt->cltmissile[1];
    if ((int)sSkillArg.nMissileTxtNo < sgptDataTable->nTxtMissilesSize) {
      MakeMissile(&sSkillArg);
    }
  }
  if (pSkillTxt->cltmissile[2] < 0) {
    return 1;
  }
  sSkillArg.nMissileTxtNo = (eMissilesId)pSkillTxt->cltmissile[2];
  if ((int)sSkillArg.nMissileTxtNo >= sgptDataTable->nTxtMissilesSize) {
    return 1;
  }
  D2UnitStrc* pMissile = MakeMissile(&sSkillArg);
  if (pMissile) {
    SetTargetX(pMissile, pUnit->nInitSeed);
  }
  return 1;
}`;

describe('vc8form movestore', () => {
  it('parses a store and an anchor', () => {
    assert.deepEqual(parseVc8Form('movestore(packet.nUnitGUID,packet)'), { op: 'movestore', store: 'packet.nUnitGUID', anchor: 'packet' });
    for (const bad of ['movestore(a.b)', 'movestore(a.b,a.b)', 'movestore(a.b,c,d)', 'movestore(a.b,@1)']) assert.equal(parseVc8Form(bad), undefined, bad);
  });

  it('moves the GUID store up to the packet declaration past a private alias (0053de50)', () => {
    applied(PLAYERFLAGS, 'movestore(packet.nUnitGUID,packet)', PLAYERFLAGS
      .replace('  packet.nUnitGUID = nUnitGUID;\n', '')
      .replace('D2GSPacketSrv0x8C packet;\n', 'D2GSPacketSrv0x8C packet;\n packet.nUnitGUID = nUnitGUID;\n'));
  });

  it('moves the target store up to the pUnit store across the stat guard (005d6520)', () => {
    applied(TIMEDSTATE, 'movestore(sStateArgs.pTarget,sStateArgs.pUnit)', TIMEDSTATE
      .replace('  sStateArgs.pTarget = pUnit;\n', '')
      .replace('sStateArgs.pUnit = pContext->pUnit;\n', 'sStateArgs.pUnit = pContext->pUnit;\n sStateArgs.pTarget = pUnit;\n'));
  });

  it('refuses when the alias is read before the store', () => {
    refused(PLAYERFLAGS.replace('size_t nSize = 0xb;', 'size_t nSize = 0xb; g(pBytes);').replace('D2GSPacketSrv0x8C* pBytes = &packet;\n', '').replace('g(pBytes);', 'D2GSPacketSrv0x8C* pBytes = &packet; g(pBytes);'),
      'movestore(packet.nUnitGUID,packet)', /address of packet|is used before/);
    refused(PLAYERFLAGS.replace('packet.nUnitGUID = nUnitGUID;', 'pBytes->nPacketId = 1; packet.nUnitGUID = nUnitGUID;'), 'movestore(packet.nUnitGUID,packet)', /is used before/);
  });

  it('refuses when the value is stored between, or its address taken', () => {
    refused(PLAYERFLAGS.replace('size_t nSize = 0xb;', 'size_t nSize = 0xb; nUnitGUID = 3;'), 'movestore(packet.nUnitGUID,packet)', /stored between/);
    refused(PLAYERFLAGS.replace('size_t nSize = 0xb;', 'size_t nSize = 0xb; h(&nUnitGUID);'), 'movestore(packet.nUnitGUID,packet)', /address is taken/);
  });

  it('refuses when the aggregate escapes to a call before the store', () => {
    refused(TIMEDSTATE.replace('sStateArgs.eSkill = *pStatId;', 'sStateArgs.eSkill = *pStatId; Keep(&sStateArgs);'), 'movestore(sStateArgs.pTarget,sStateArgs.pUnit)', /address of sStateArgs/);
    refused(TIMEDSTATE.replace('D2StateExArgStrc sStateArgs;', 'D2StateExArgStrc sStateArgs; Keep(&sStateArgs);'), 'movestore(sStateArgs.pTarget,sStateArgs.pUnit)', /address of sStateArgs/);
  });

  it('refuses a memset between, a guard naming the member, a jump between, and a loop', () => {
    refused(TIMEDSTATE, 'movestore(sStateArgs.pTarget,sStateArgs)', /address of sStateArgs/);
    refused(TIMEDSTATE.replace('(int)sStateArgs.eStat <= 0', 'sStateArgs.pTarget == 0'), 'movestore(sStateArgs.pTarget,sStateArgs.pUnit)', /names sStateArgs.pTarget/);
    refused(TIMEDSTATE.replace('sStateArgs.eStat = ~SKILL_Attack;', 'return 0;'), 'movestore(sStateArgs.pTarget,sStateArgs.pUnit)', /leave/);
    refused('void f(int n, D2UnitStrc* p) { while (n) { D2StateExArgStrc s; s.pUnit = p; s.eSkill = 1; s.pTarget = p; g(&s); } }', 'movestore(s.pTarget,s.pUnit)', /loop/);
  });

  it('refuses a value that loads memory or calls, unions, unknown types and a store already in place', () => {
    refused(TIMEDSTATE.replace('sStateArgs.pTarget = pUnit;', 'sStateArgs.pTarget = pContext->pUnit;'), 'movestore(sStateArgs.pTarget,sStateArgs.pUnit)', /loads memory/);
    refused('void f(int v) { U u; u.b = 1; u.a = v; g(&u); }', 'movestore(u.a,u)', /union/);
    refused(PLAYERFLAGS, 'movestore(packet.nUnitGUID,packet)', /not a known struct/, {});
    refused(PLAYERFLAGS, 'movestore(packet.wRelationFlags,packet.nUnitGUID)', /already follows/);
  });
});

describe('vc8form sinkstore', () => {
  it('parses a store and an optional index', () => {
    assert.deepEqual(parseVc8Form('sinkstore(s.n)'), { op: 'sinkstore', store: 's.n', index: 0 });
    assert.deepEqual(parseVc8Form('sinkstore(s.n,2)'), { op: 'sinkstore', store: 's.n', index: 2 });
    for (const bad of ['sinkstore()', 'sinkstore(s.n,x)', 'sinkstore(s.n,1,2)']) assert.equal(parseVc8Form(bad), undefined, bad);
  });

  it('stores each missile ID after its bounds check (004f1f20)', () => {
    applied(DUAL, 'sinkstore(sSkillArg.nMissileTxtNo)', `BOOL f(D2UnitStrc* pUnit, D2SkillsTxt* pSkillTxt) {
  D2SkillArgStrc sSkillArg;
  memset(&sSkillArg, 0, 0x5c);
  sSkillArg.pOwner = pUnit;
  if (pSkillTxt->cltmissile[1] >= 0) {
    if ((int)(eMissilesId)pSkillTxt->cltmissile[1] < sgptDataTable->nTxtMissilesSize) {
      sSkillArg.nMissileTxtNo = (eMissilesId)pSkillTxt->cltmissile[1];
      MakeMissile(&sSkillArg);
    }
  }
  if (pSkillTxt->cltmissile[2] < 0) {
    return 1;
  }
  if ((int)(eMissilesId)pSkillTxt->cltmissile[2] >= sgptDataTable->nTxtMissilesSize) {
    return 1;
  }
  sSkillArg.nMissileTxtNo = (eMissilesId)pSkillTxt->cltmissile[2];
  D2UnitStrc* pMissile = MakeMissile(&sSkillArg);
  if (pMissile) {
    SetTargetX(pMissile, pUnit->nInitSeed);
  }
  return 1;
}`);
  });

  it('takes one site by index', () => {
    const { out, site } = run(DUAL, 'sinkstore(sSkillArg.nMissileTxtNo,2)');
    assert.equal(site.applied, true, site.why);
    assert.match(out, /sSkillArg\.nMissileTxtNo = \(eMissilesId\)pSkillTxt->cltmissile\[1\]; if \(\(int\)sSkillArg\.nMissileTxtNo </);
    assert.match(out, /return 1; \} sSkillArg\.nMissileTxtNo = \(eMissilesId\)pSkillTxt->cltmissile\[2\]; D2UnitStrc/);
    refused(DUAL, 'sinkstore(sSkillArg.nMissileTxtNo,3)', /no store #3/);
  });

  it('refuses when the skip path reads the member, or calls once the address escaped', () => {
    refused(DUAL.replace('if (pSkillTxt->cltmissile[2] < 0) {', 'if (sSkillArg.nMissileTxtNo == 3) {'), 'sinkstore(sSkillArg.nMissileTxtNo,1)', /may be read/);
    refused(DUAL.replace('if (pSkillTxt->cltmissile[2] < 0) {', 'Log(); if (pSkillTxt->cltmissile[2] < 0) {'), 'sinkstore(sSkillArg.nMissileTxtNo,1)', /a call/);
    refused(DUAL.replace('if (pSkillTxt->cltmissile[2] < 0) {', 'if (gpAny[2] < 0) {'), 'sinkstore(sSkillArg.nMissileTxtNo,1)', /read through memory/);
    refused(DUAL.replace('    return 1;\n  }\n  D2UnitStrc', '    return Read(&sSkillArg);\n  }\n  D2UnitStrc'), 'sinkstore(sSkillArg.nMissileTxtNo,2)', /return may read/);
  });

  it('refuses a value that calls or is not spelled as the member type', () => {
    refused(DUAL.replace('(eMissilesId)pSkillTxt->cltmissile[1];', '(eMissilesId)Next();'), 'sinkstore(sSkillArg.nMissileTxtNo,1)', /calls/);
    refused(DUAL.replace('(eMissilesId)pSkillTxt->cltmissile[1];', '(int)pSkillTxt->cltmissile[1];'), 'sinkstore(sSkillArg.nMissileTxtNo,1)', /spelled/);
  });

  it('refuses a test that calls, reads memory of unknown type, or an if with an else, a loop, a bit-field', () => {
    refused(DUAL.replace('< sgptDataTable->nTxtMissilesSize', '< Count()'), 'sinkstore(sSkillArg.nMissileTxtNo,1)', /calls/);
    refused(DUAL.replace('< sgptDataTable->nTxtMissilesSize', '< gUnknown->nTxtMissilesSize'), 'sinkstore(sSkillArg.nMissileTxtNo,1)', /may be the member/);
    refused(DUAL.replace('      MakeMissile(&sSkillArg);\n    }', '      MakeMissile(&sSkillArg);\n    } else { g(); }'), 'sinkstore(sSkillArg.nMissileTxtNo,1)', /else/);
    refused('void f(D2SkillsTxt* p, int n) { D2SkillArgStrc s; while (n--) { s.nMissileTxtNo = (eMissilesId)p->cltmissile[1]; if ((int)s.nMissileTxtNo < 3) { g(&s); } } }', 'sinkstore(s.nMissileTxtNo)', /loop/);
    refused('void f(int v) { D2SkillArgStrc s; s.nBits = (int)v; if (s.nBits) { g(&s); } }', 'sinkstore(s.nBits)', /plain member/);
  });
});
