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
    tagPOINT: { x: 'LONG', y: 'LONG' },
    D2UIMouseMsgStrc: { hWnd: 'HWND', uMessage: 'uint32_t', uWParam: 'uint32_t', uLParam: 'D2MouseLParamUnion', bHandled: 'int', pIntPtr: 'int*', pPtr: 'int**', aBytes: 'uint8_t[4]', nWide: 'uint32_t' },
    D2MouseLParamUnion: { sMousePos: 'D2MousePosStrc', nLParam: 'uint32_t' },
    D2MousePosStrc: { nMouseX: 'uint16_t', nMouseY: 'uint16_t' },
    Three: { a: 'int', b: 'int', c: 'int' },
    Shorts: { a: 'int16_t', b: 'int16_t' },
    Bits: { a: 'int', b: 'int' },
    U2: { a: 'int', b: 'int' },
  },
  structLayouts: {
    tagPOINT: [field('x', 0, 4, 'LONG'), field('y', 4, 4, 'LONG')],
    Three: [field('a', 0, 4, 'int'), field('b', 4, 4, 'int'), field('c', 8, 4, 'int')],
    Shorts: [field('a', 0, 2, 'int16_t'), field('b', 2, 2, 'int16_t')],
    Bits: [field('a', 0, 4, 'int'), { ...field('b', 4, 4, 'int'), bitSize: 3 }],
    U2: [field('a', 0, 4, 'int'), field('b', 4, 4, 'int')],
    D2UIMouseMsgStrc: [field('uLParam', 12, 4, 'D2MouseLParamUnion')],
  },
  typedefTargets: { POINT: 'tagPOINT', LONG: 'long' },
  unionNames: ['U2', 'D2MouseLParamUnion'],
  globalTypes: { MouseX: 'int', MouseY: 'int', gnShort: 'int16_t', gnVol: 'volatile int', gpPtr: 'int*', gnTick: 'uint32_t' },
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

// UI_HandleCursorMouseUp 00467fa0, as the generator prints it.
const MOUSEUP = (x: string, y: string, pre = '') => `void __stdcall f(D2UIMouseMsgStrc* pMsg) {
  ${pre}
  MouseX = ${x};
  MouseY = ${y};
  gnCursorAnimStartTick = GetTickCount();
  if (ItemTypeOnHand == 5) {
    nCursorDataIndex = 5;
    pMsg->bHandled = 0;
    return;
  }
  pMsg->bHandled = 0;
}`;
const X = '(int)pMsg->uLParam.sMousePos.nMouseX', Y = '(int)pMsg->uLParam.sMousePos.nMouseY';

describe('vc8form pairvia', () => {
  it('parses the tag', () => {
    assert.deepEqual(parseVc8Form('pairvia(MouseX,MouseY,POINT)'), { op: 'pairvia', first: 'MouseX', second: 'MouseY', type: 'POINT' });
    assert.deepEqual(parseVc8Form('pairvia(D2Client::Cursor::MouseX,MouseY,POINT)'), { op: 'pairvia', first: 'D2Client::Cursor::MouseX', second: 'MouseY', type: 'POINT' });
    assert.equal(parseVc8Form('pairvia(MouseX,MouseY)'), undefined);
    assert.equal(parseVc8Form('pairvia(MouseX,MouseX,POINT)'), undefined);
    assert.equal(parseVc8Form('pairvia(MouseX,MouseY,POINT*)'), undefined);
    assert.equal(parseVc8Form('pairvia(a.x,MouseY,POINT)'), undefined);
    assert.equal(parseVc8Form('pairvia(MouseX,MouseY,POINT,@1)'), undefined);
  });

  it('writes 00467fa0 through a private POINT', () => {
    applied(MOUSEUP(X, Y), 'pairvia(MouseX,MouseY,POINT)', `void __stdcall f(D2UIMouseMsgStrc* pMsg) {
      POINT sPair;
      sPair.x = ${X};
      sPair.y = ${Y};
      MouseX = sPair.x;
      MouseY = sPair.y;
      gnCursorAnimStartTick = GetTickCount();
      if (ItemTypeOnHand == 5) { nCursorDataIndex = 5; pMsg->bHandled = 0; return; }
      pMsg->bHandled = 0;
    }`);
  });

  it('matches namespace-qualified stores and picks a fresh name', () => {
    const src = MOUSEUP(X, Y, 'int sPair = 0;').replace('MouseX =', 'D2Client::Cursor::MouseX =');
    const { out, site } = run(src, 'pairvia(MouseX,MouseY,POINT)');
    assert.equal(site.applied, true, site.why);
    assert.match(out, /POINT sPair2; sPair2\.x = .*D2Client::Cursor::MouseX = sPair2\.x; MouseY = sPair2\.y;/);
  });

  it('refuses without a two-member 4-byte integer struct', () => {
    refused(MOUSEUP(X, Y), 'pairvia(MouseX,MouseY,RECT)', /not a struct/);
    refused(MOUSEUP(X, Y), 'pairvia(MouseX,MouseY,Three)', /3 members/);
    refused(MOUSEUP(X, Y), 'pairvia(MouseX,MouseY,Shorts)', /not at 0 and 4|bytes/);
    refused(MOUSEUP(X, Y), 'pairvia(MouseX,MouseY,Bits)', /bit-field/);
    refused(MOUSEUP(X, Y), 'pairvia(MouseX,MouseY,U2)', /union/);
  });

  it('refuses stores that are not adjacent, or in the other order', () => {
    refused(MOUSEUP(X, Y).replace(`MouseY = ${Y};`, `n = 1; MouseY = ${Y};`), 'pairvia(MouseX,MouseY,POINT)', /0 adjacent/);
    refused(MOUSEUP(X, Y), 'pairvia(MouseY,MouseX,POINT)', /0 adjacent/);
    refused(MOUSEUP(X, Y, `if (pMsg) { MouseX = ${X}; MouseY = ${Y}; }`), 'pairvia(MouseX,MouseY,POINT)', /2 adjacent/);
  });

  it('refuses a second value that may read the first global', () => {
    refused(MOUSEUP(X, '(int)MouseX + 1'), 'pairvia(MouseX,MouseY,POINT)', /reads MouseX/);
    refused(MOUSEUP(X, '*gpPtr'), 'pairvia(MouseX,MouseY,POINT)', /as wide/);
    refused(MOUSEUP(X, 'pMsg->bHandled'), 'pairvia(MouseX,MouseY,POINT)', /as wide/);
    refused(MOUSEUP(X, 'pMsg->pIntPtr[2]'), 'pairvia(MouseX,MouseY,POINT)', /as wide/);
    refused(MOUSEUP(X, '(int)pMsg->aBytes[1]'), 'pairvia(MouseX,MouseY,POINT)', /character/);
    refused(MOUSEUP(X, '(int)pUnknown->nField'), 'pairvia(MouseX,MouseY,POINT)', /unknown/);
  });

  it('allows a second value that reads another global or a narrower member', () => {
    for (const y of ['(int)gnShort', '(int)pMsg->uLParam.sMousePos.nMouseY + 1']) {
      const { site } = run(MOUSEUP(X, y), 'pairvia(MouseX,MouseY,POINT)');
      assert.equal(site.applied, true, `${y}: ${site.why}`);
    }
  });

  it('refuses effects, calls and volatile', () => {
    refused(MOUSEUP(X, 'GetY()'), 'pairvia(MouseX,MouseY,POINT)', /calls or stores/);
    refused(MOUSEUP('n++', Y), 'pairvia(MouseX,MouseY,POINT)', /calls or stores|effect/);
    refused(MOUSEUP(X, Y).replace('MouseY =', 'gnVol ='), 'pairvia(MouseX,gnVol,POINT)', /volatile/);
  });

  it('refuses a value outside its member, or a global that is no integer', () => {
    refused(MOUSEUP('(uint32_t)pMsg->nWide', Y), 'pairvia(MouseX,MouseY,POINT)', /does not fit/);
    refused(MOUSEUP(X, Y).replace('MouseY =', 'gpPtr ='), 'pairvia(MouseX,gpPtr,POINT)', /not known to be an integer/);
    refused(MOUSEUP(X, Y, 'int MouseY;'), 'pairvia(MouseX,MouseY,POINT)', /local/);
  });
});
