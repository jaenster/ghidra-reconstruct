import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, CompoundStmt, FunctionDecl } from '../../../ast/nodes.js';
import { hostTwinFoldPlugin, type HostTwin } from '../builtins/host-twin-fold.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function hostOf(name: string, axis: 'X' | 'Y'): HostTwin {
  const src = `int32_t f(D2UnitStrc *pUnit) {
    int32_t n${axis}Pos;
    eD2UnitType eUnitType;
    eUnitType = pUnit->eUnitType;
    if ((eUnitType != UNIT_OBJECT) && (((int)eUnitType < 4 || (5 < (int)eUnitType)))) {
      if ((pUnit->pPath).pDynamicPath != (D2DynamicPathStrc *)0x0) {
        n${axis}Pos = D2Common::PATH::DynamicPath::Get${axis}Pos((pUnit->pPath).pDynamicPath);
        return n${axis}Pos;
      }
      return 0;
    }
    return ((pUnit->pPath).pStaticPath)->nPos${axis};
  }`;
  const fn = (parse(src) as unknown as { declarations: FunctionDecl[] }).declarations[0];
  return {
    call: `D2Common::Units::${name}`, param: 'pUnit', returnType: 'int32_t',
    body: fn.body as CompoundStmt, locals: { [`n${axis}Pos`]: 'int32_t', eUnitType: 'eD2UnitType' },
  };
}
const TWINS = [hostOf('GetXPosFromDynamicPathUnitInline', 'X'), hostOf('GetYPosFromDynamicPathUnitInline', 'Y')];
const OPTS = {
  enumValues: { UNIT_OBJECT: 2, UNIT_COUNT: 6 },
  typedefTargets: { eD2UnitType: 'uint32_t' },
  structFields: { D2StaticPathStrc: { nPosX: 'int', nPosY: 'int' }, D2UnitStrc: { eUnitType: 'eD2UnitType' }, Pkt: { wX: 'uint16_t', wY: 'uint16_t' } },
  fieldTypes: { nPosX: 'int', nPosY: 'int', eUnitType: 'eD2UnitType', wY: 'uint16_t' },
  functionReturnTypes: { GetXPos: 'int32_t', GetYPos: 'int32_t', 'D2Common::PATH::DynamicPath::GetXPos': 'int32_t', 'D2Common::PATH::DynamicPath::GetYPos': 'int32_t' },
};

function run(src: string) {
  const sites: string[] = [];
  const why: string[] = [];
  const t = hostTwinFoldPlugin.createTransformer({ ...OPTS, twins: TWINS, onSite: e => sites.push(`${e.form}:${e.call.replace(/^.*::/, '')}`), onReject: e => why.push(e.why) } as never);
  return { out: flat(emit(t(parse(src)) as AnyNode)), sites, why };
}

describe('host-twin-fold', () => {
  it('leaves a site the decompiler printed as one store on every path', () => {
    const { sites, why } = run(`void f(D2UnitStrc *pPlayer) {
      uint32_t wPosY;
      eD2UnitType eUnitType = pPlayer->eUnitType;
      if (eUnitType == UNIT_OBJECT || (int)eUnitType > 3 && (int)eUnitType <= 5) {
        wPosY = pPlayer->pPath.pStaticPath->nPosY;
      } else if (pPlayer->pPath.pDynamicPath) {
        wPosY = D2Common::PATH::DynamicPath::GetYPos(pPlayer->pPath.pDynamicPath);
      } else {
        wPosY = 0;
      }
      Use(wPosY);
    }`);
    assert.deepStrictEqual(sites, []);
  });

  it('keeps the type temporary when something else reads it', () => {
    const { out } = run(`void f(D2UnitStrc *pUnit) {
      int nX; int nTmp;
      eD2UnitType eUnitType = pUnit->eUnitType;
      if (eUnitType == UNIT_OBJECT || (int)eUnitType > 3 && (int)eUnitType <= 5) {
        nX = pUnit->pPath.pStaticPath->nPosX;
      } else if (pUnit->pPath.pDynamicPath) {
        nTmp = D2Common::PATH::DynamicPath::GetXPos(pUnit->pPath.pDynamicPath);
        nX = nTmp;
      } else {
        nX = 0;
      }
      Use(nX, eUnitType);
    }`);
    assert.ok(out.includes('eD2UnitType eUnitType = pUnit->eUnitType; nX = D2Common::Units::GetXPosFromDynamicPathUnitInline(pUnit);'), out);
    assert.ok(!out.includes('nTmp'), out);
  });

  it('folds a call result copied through a temporary, and a narrowing store', () => {
    const { out, sites, why } = run(`void f(D2UnitStrc *pUnit) {
      int32_t nUnitCoord; Pkt sPacket; eD2UnitType eUnitType;
      eUnitType = pUnit->eUnitType;
      if (eUnitType == UNIT_OBJECT || (int)eUnitType > 3 && (int)eUnitType <= 5) {
        sPacket.wY = (uint16_t)pUnit->pPath.pStaticPath->nPosY;
      } else if (pUnit->pPath.pDynamicPath) {
        nUnitCoord = D2Common::PATH::DynamicPath::GetYPos(pUnit->pPath.pDynamicPath);
        sPacket.wY = (uint16_t)nUnitCoord;
      } else {
        sPacket.wY = 0;
      }
      Send(&sPacket);
    }`);
    assert.deepStrictEqual(sites, ['store:GetYPosFromDynamicPathUnitInline'], why.join('\n'));
    assert.ok(out.includes('sPacket.wY = D2Common::Units::GetYPosFromDynamicPathUnitInline(pUnit);'), out);
    assert.ok(!out.includes('nUnitCoord'), out);
  });

  it('writes a tail-duplicated call once (005773d0)', () => {
    const { out, sites, why } = run(`void f(G *pGame, D2UnitStrc *pPlayer) {
      uint32_t wPosY; int32_t nPosX;
      wPosY = Y(pPlayer);
      eD2UnitType eUnitType = pPlayer->eUnitType;
      if (eUnitType != UNIT_OBJECT && ((int)eUnitType <= 3 || (int)eUnitType > 5)) {
        if (pPlayer->pPath.pDynamicPath) {
          nPosX = D2Common::PATH::DynamicPath::GetXPos(pPlayer->pPath.pDynamicPath);
          PETS(pGame, pPlayer, (uint16_t)nPosX, (uint16_t)wPosY);
          return;
        }
        PETS(pGame, pPlayer, 0, (uint16_t)wPosY);
        return;
      }
      PETS(pGame, pPlayer, (uint16_t)pPlayer->pPath.pStaticPath->nPosX, (uint16_t)wPosY);
    }`);
    assert.deepStrictEqual(sites, ['tail:GetXPosFromDynamicPathUnitInline'], why.join('\n'));
    assert.ok(out.endsWith('nPosX = D2Common::Units::GetXPosFromDynamicPathUnitInline(pPlayer); PETS(pGame, pPlayer, (uint16_t)nPosX, (uint16_t)wPosY); }'), out);
  });

  it('leaves a site whose arms store another value', () => {
    const { sites } = run(`void f(D2UnitStrc *pUnit) {
      int nX;
      if (pUnit->eUnitType == UNIT_OBJECT || (int)pUnit->eUnitType > 3 && (int)pUnit->eUnitType <= 5) {
        nX = pUnit->pPath.pStaticPath->nPosY;
      } else if (pUnit->pPath.pDynamicPath) {
        nX = D2Common::PATH::DynamicPath::GetXPos(pUnit->pPath.pDynamicPath);
      } else {
        nX = 0;
      }
      Use(nX);
    }`);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a site whose type test differs (type 3 static)', () => {
    const { sites } = run(`void f(D2UnitStrc *pUnit) {
      int nX;
      if (pUnit->eUnitType == UNIT_OBJECT || (int)pUnit->eUnitType > 2 && (int)pUnit->eUnitType <= 5) {
        nX = pUnit->pPath.pStaticPath->nPosX;
      } else if (pUnit->pPath.pDynamicPath) {
        nX = D2Common::PATH::DynamicPath::GetXPos(pUnit->pPath.pDynamicPath);
      } else {
        nX = 0;
      }
      Use(nX);
    }`);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a site with a non-zero default', () => {
    const { sites } = run(`void f(D2UnitStrc *pUnit) {
      int nX;
      if (pUnit->eUnitType == UNIT_OBJECT || (int)pUnit->eUnitType > 3 && (int)pUnit->eUnitType <= 5) {
        nX = pUnit->pPath.pStaticPath->nPosX;
      } else if (pUnit->pPath.pDynamicPath) {
        nX = D2Common::PATH::DynamicPath::GetXPos(pUnit->pPath.pDynamicPath);
      } else {
        nX = 1;
      }
      Use(nX);
    }`);
    assert.deepStrictEqual(sites, []);
  });
});
