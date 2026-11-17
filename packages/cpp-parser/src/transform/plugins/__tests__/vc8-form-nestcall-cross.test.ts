import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, CompoundStmt, FunctionDecl, Identifier, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';
import { summarizeWriteEffects, type EffectFunction } from '../builtins/write-effects.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(tables: Vc8FormTables | undefined, lines: string[], ...forms: string[]): { out: string; sites: Vc8FormSite[] } {
  const sites: Vc8FormSite[] = [];
  const parsed = forms.map(f => {
    const form = parseVc8Form(f);
    assert.ok(form, `parses: ${f}`);
    return { form: form!, tag: f };
  });
  const tu = applyVc8Forms(parse(lines.join('\n')) as TranslationUnit, parsed, s => sites.push(s), tables);
  return { out: flat(emit(tu as AnyNode)), sites };
}

function refused(tables: Vc8FormTables | undefined, lines: string[], form: string): void {
  const { out, sites } = run(tables, lines, form);
  assert.strictEqual(sites[0].applied, false, `${form} should refuse`);
  assert.strictEqual(out, flat(emit(parse(lines.join('\n')) as AnyNode)));
}

/** Write effects of every function of `src`, as the generator summarizes them. */
function effectsOf(src: string) {
  const tu = parse(src) as unknown as { declarations: FunctionDecl[] };
  const fns: EffectFunction[] = tu.declarations.filter(d => d.body).map(d => ({
    keys: [(d.name as unknown as Identifier).name],
    params: d.parameters.map(p => (p as unknown as { name?: Identifier }).name?.name ?? ''),
    paramTypes: d.parameters.map(p => emit((p as unknown as { type: never }).type)),
    body: d.body as CompoundStmt,
  }));
  return summarizeWriteEffects(fns);
}

// The getters MONUNIQUE_SpawnSuicideExplosion passes to MakeMissileAtXY, as the tree prints
// them (D2Common 0045adf0/0045ae20 and their leaves 006488c0/00648900).
const GETTERS = `
int32_t __stdcall GetXPos(D2DynamicPathStrc * pDynamicPath) {
  if (!pDynamicPath) {
    Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("", Fog::Src::ErrorManager::GetInstructionPointer(), 0x692);
    exit(-1);
  }
  return (uint32_t)(uint16_t)pDynamicPath->Coords.tSubtile.nPosX;
}
int32_t __stdcall GetYPos(D2DynamicPathStrc * pDynamicPath) {
  if (!pDynamicPath) {
    Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("", Fog::Src::ErrorManager::GetInstructionPointer(), 0x69d);
    exit(-1);
  }
  return (uint32_t)(uint16_t)pDynamicPath->Coords.tSubtile.nPosY;
}
int32_t __fastcall GetXPosFromDynamicPathUnit(D2UnitStrc * pUnit) {
  eD2UnitType eUnitType = pUnit->eUnitType;
  if (eUnitType != UNIT_OBJECT && ((int)eUnitType <= 3 || (int)eUnitType > 5)) {
    int32_t nXPos;
    if (pUnit->pPath.pDynamicPath) {
      nXPos = GetXPos(pUnit->pPath.pDynamicPath);
      return nXPos;
    }
    return 0;
  }
  return pUnit->pPath.pStaticPath->nPosX;
}
int32_t __fastcall GetYPosFromDynamicPathUnit(D2UnitStrc * pUnit) {
  eD2UnitType eUnitType = pUnit->eUnitType;
  if (eUnitType != UNIT_OBJECT && ((int)eUnitType <= 3 || (int)eUnitType > 5)) {
    int32_t nYPos;
    if (pUnit->pPath.pDynamicPath) {
      nYPos = GetYPos(pUnit->pPath.pDynamicPath);
      return nYPos;
    }
    return 0;
  }
  return pUnit->pPath.pStaticPath->nPosY;
}
`;

// MONUNIQUE_SpawnSuicideExplosion 004adbc0 as the tree prints it (redivivus#490).
const SPAWN = [
  "void __fastcall MONUNIQUE_SpawnSuicideExplosion(D2UnitStrc * pUnit, int32_t nUMod, uint32_t nParam2) {",
  "    int32_t nPosY;",
  "    int32_t nPosX;",
  "    eMissilesId eMissileId;",
  "    D2MonStatsTxt* pMonStatsTxt;",
  "    int nClassId;",
  "    int nTotalFrames;",
  "    int nCurrentFrame;",
  "    eD2Skills eSkill;",
  "    eD2UnitType eUnitType;",
  "    if (!pUnit || (nClassId = pUnit->nClassId , nClassId < 0) || nClassId >= D2Common::ITEMS::Items::sgptDataTable->nTxtMonStatsSize) {",
  "      pMonStatsTxt = 0;",
  "    } else {",
  "      pMonStatsTxt = D2Common::ITEMS::Items::sgptDataTable->pTxtMonStats + nClassId;",
  "    }",
  "",
  "    uint8_t bVar1;",
  "    bVar1 = GAME::Game::GetDificulity();",
  "    nClassId = (int)pMonStatsTxt->aip[0][bVar1];",
  "    D2Common::Units::GetShiftedFrameMetrics(pUnit, &nCurrentFrame, &nTotalFrames);",
  "    if (pUnit && pUnit->eAnimMode.ePlayerMode != Death) {",
  "      return;",
  "    }",
  "    if (nCurrentFrame != 4) {",
  "      return;",
  "    }",
  "    if (nClassId == 1) {",
  "      eSkill = SKILL_Attack;",
  "      nPosY = D2Common::Units::GetYPosFromDynamicPathUnit(pUnit);",
  "      nPosX = D2Common::Units::GetXPosFromDynamicPathUnit(pUnit);",
  "      eMissileId = MISSILE_Suicidefireexplode;",
  "    } else {",
  "      if (nClassId < 2) {",
  "        goto spawn_corpse_explosion;",
  "      }",
  "",
  "      nClassId = 1;",
  "      eSkill = SKILL_Attack;",
  "      nPosY = D2Common::Units::GetYPosFromDynamicPathUnit(pUnit);",
  "      nPosX = D2Common::Units::GetXPosFromDynamicPathUnit(pUnit);",
  "      eMissileId = MISSILE_Suicideiceexplode;",
  "    }",
  "",
  "    Missile::MakeMissileAtXY(pUnit, eMissileId, nPosX, nPosY, eSkill, nClassId);",
  "    spawn_corpse_explosion:",
  "    eUnitType = pUnit->eUnitType;",
  "    if (eUnitType == UNIT_OBJECT || (int)eUnitType > 3 && (int)eUnitType <= 5) {",
  "      nClassId = pUnit->pPath.pStaticPath->nPosY;",
  "    } else if (pUnit->pPath.pDynamicPath) {",
  "      nClassId = D2Common::PATH::DynamicPath::GetYPos(pUnit->pPath.pDynamicPath);",
  "    } else {",
  "      nClassId = 0;",
  "    }",
  "",
  "    eUnitType = pUnit->eUnitType;",
  "    if (eUnitType == UNIT_OBJECT || (int)eUnitType > 3 && (int)eUnitType <= 5) {",
  "      nPosY = pUnit->pPath.pStaticPath->nPosX;",
  "    } else if (pUnit->pPath.pDynamicPath) {",
  "      nPosY = D2Common::PATH::DynamicPath::GetXPos(pUnit->pPath.pDynamicPath);",
  "    } else {",
  "      nPosY = 0;",
  "    }",
  "",
  "    Missile::MakeMissileAtXY(pUnit, MISSILE_Suicidecorpseexplode, nPosY, nClassId, SKILL_Attack, 1);",
  "}",
];

const ENUMS = { MISSILE_Suicidefireexplode: 0x1ab, MISSILE_Suicideiceexplode: 0x1ac };
const DUP = 'dup(Missile::MakeMissileAtXY(pUnit, eMissileId, nPosX, nPosY, eSkill, nClassId))';
const NESTS = ['nestcall(nPosX,2)', 'nestcall(nPosX,1)', 'nestcall(nPosY,2)', 'nestcall(nPosY,1)'];

describe('vc8-form nestcall: crossed stores and quiet sibling calls', () => {
  it('summarizes both getters as writing nothing', () => {
    const w = effectsOf(GETTERS);
    for (const k of ['GetXPos', 'GetYPos', 'GetXPosFromDynamicPathUnit', 'GetYPosFromDynamicPathUnit']) {
      const { reads: _r, ...writes } = w[k]!;
      assert.deepStrictEqual(writes, {}, k);
    }
  });

  it('004adbc0: nests both getters in each arm dup wrote, the missile id stored first', () => {
    const tables: Vc8FormTables = { writeEffects: effectsOf(GETTERS), enumValues: ENUMS };
    const { out, sites } = run(tables, SPAWN, DUP, ...NESTS);
    for (const s of sites) assert.ok(s.applied, `${s.tag}: ${s.why}`);
    const call = 'Missile::MakeMissileAtXY(pUnit, eMissileId, D2Common::Units::GetXPosFromDynamicPathUnit(pUnit), D2Common::Units::GetYPosFromDynamicPathUnit(pUnit), eSkill, nClassId);';
    assert.ok(out.includes(`if (nClassId == 1) { eSkill = SKILL_Attack; eMissileId = MISSILE_Suicidefireexplode; ${call} } else {`), out);
    assert.ok(out.includes(`nClassId = 1; eSkill = SKILL_Attack; eMissileId = MISSILE_Suicideiceexplode; ${call} } spawn_corpse_explosion:`), out);
    assert.ok(!/\bnPosX\b/.test(out.replace(/->nPosX/g, '')), 'nPosX is gone');
    // The second life of nPosY, after the label, stays as it was.
    assert.ok(out.includes('nPosY = pUnit->pPath.pStaticPath->nPosX;'));
    assert.ok(out.includes('Missile::MakeMissileAtXY(pUnit, MISSILE_Suicidecorpseexplode, nPosY, nClassId, SKILL_Attack, 1);'));
  });

  it('004adbc0: without write effects the second getter stays a temporary', () => {
    const { sites } = run({ enumValues: ENUMS }, SPAWN, DUP, ...NESTS);
    assert.deepStrictEqual(sites.map(s => s.applied), [true, true, true, false, false]);
    assert.match(sites[3].why!, /calls, stores or reads memory/);
  });

  it('004adbc0: a getter that writes keeps both temporaries beside it', () => {
    const writeEffects = { ...effectsOf(GETTERS), GetXPosFromDynamicPathUnit: { globals: ['gnLastX'] } };
    const { sites } = run({ writeEffects, enumValues: ENUMS }, SPAWN, DUP, ...NESTS);
    assert.deepStrictEqual(sites.map(s => s.applied), [true, true, true, false, false]);
  });

  const quiet: Vc8FormTables = { writeEffects: { g: {}, k: {}, w: { globals: ['gX'] } }, enumValues: { E_ONE: 1 } };

  it('crosses a store of a constant, a local or an enumerator to a private local', () => {
    let r = run(quiet, ['int f(U* p, int a) {', '  int t;', '  int x;', '  t = g(p);', '  x = E_ONE;', '  return h(x, t);', '}'], 'nestcall(t)');
    assert.ok(r.sites[0].applied, r.sites[0].why);
    assert.strictEqual(r.out, 'int f(U* p, int a) { int x; x = E_ONE; return h(x, g(p)); }');
    r = run(quiet, ['int f(U* p, int a) {', '  int t;', '  int x;', '  int y;', '  t = g(p);', '  x = a + 1;', '  y = 2;', '  return h(x, t, y);', '}'], 'nestcall(t)');
    assert.ok(r.sites[0].applied, r.sites[0].why);
    assert.strictEqual(r.out, 'int f(U* p, int a) { int x; int y; x = a + 1; y = 2; return h(x, g(p), y); }');
  });

  it('refuses to cross a store the call could see or change', () => {
    // The call names the stored local.
    refused(quiet, ['int f(U* p, int a) {', '  int t;', '  t = g(a);', '  a = 1;', '  return h(a, t);', '}'], 'nestcall(t)');
    // The stored value reads memory, calls, or reads the temporary.
    refused(quiet, ['int f(U* p) {', '  int t;', '  int x;', '  t = g(p);', '  x = p->n;', '  return h(x, t);', '}'], 'nestcall(t)');
    refused(quiet, ['int f(U* p) {', '  int t;', '  int x;', '  t = g(p);', '  x = k(p);', '  return h(x, t);', '}'], 'nestcall(t)');
    refused(quiet, ['int f(U* p) {', '  int t;', '  int x;', '  t = g(p);', '  x = gGlobal;', '  return h(x, t);', '}'], 'nestcall(t)');
    // The stored local's address is taken, or it is a global, or the store is compound.
    refused(quiet, ['int f(U* p) {', '  int t;', '  int x;', '  q(&x);', '  t = g(p);', '  x = 1;', '  return h(x, t);', '}'], 'nestcall(t)');
    refused(quiet, ['int f(U* p) {', '  int t;', '  t = g(p);', '  gGlobal = 1;', '  return h(t);', '}'], 'nestcall(t)');
    refused(quiet, ['int f(U* p) {', '  int t;', '  int x;', '  x = 0;', '  t = g(p);', '  x += 1;', '  return h(x, t);', '}'], 'nestcall(t)');
  });

  it('nests beside a sibling call only when both write nothing and take plain arguments', () => {
    const r = run(quiet, ['int f(U* p) {', '  int t;', '  t = g(p);', '  return h(t, k(p));', '}'], 'nestcall(t)');
    assert.ok(r.sites[0].applied, r.sites[0].why);
    assert.strictEqual(r.out, 'int f(U* p) { return h(g(p), k(p)); }');
    // The sibling writes, the nested call writes, an unknown callee, an argument reading memory.
    refused(quiet, ['int f(U* p) {', '  int t;', '  t = g(p);', '  return h(t, w(p));', '}'], 'nestcall(t)');
    refused(quiet, ['int f(U* p) {', '  int t;', '  t = w(p);', '  return h(t, k(p));', '}'], 'nestcall(t)');
    refused(quiet, ['int f(U* p) {', '  int t;', '  t = g(p);', '  return h(t, z(p));', '}'], 'nestcall(t)');
    refused(quiet, ['int f(U* p) {', '  int t;', '  t = g(p);', '  return h(t, k(p->n));', '}'], 'nestcall(t)');
    refused(quiet, ['int f(U* p) {', '  int t;', '  t = g(p->n);', '  return h(t, k(p));', '}'], 'nestcall(t)');
  });

  it('passes a label on the way to a store that ends the life, never a jump out', () => {
    const r = run(quiet, ['int f(U* p, int a) {', '  int t;', '  if (a) {', '    t = g(p);', '    h(t);', '  }', '  L:', '  a = 2;', '  t = a;', '  return t;', '}'], 'nestcall(t)');
    assert.ok(r.sites[0].applied, r.sites[0].why);
    assert.strictEqual(r.out, 'int f(U* p, int a) { int t; if (a) { h(g(p)); } L: a = 2; t = a; return t; }');
    refused(quiet, ['int f(U* p, int a) {', '  int t;', '  if (a) {', '    t = g(p);', '    h(t);', '  }', '  L:', '  a = 2;', '  return t;', '}'], 'nestcall(t)');
    refused(quiet, ['int f(U* p, int a) {', '  int t;', '  if (a) {', '    t = g(p);', '    h(t);', '  }', '  goto M;', '  t = 1;', '  M:', '  a = 2;', '  return t;', '}'], 'nestcall(t)');
  });
});
