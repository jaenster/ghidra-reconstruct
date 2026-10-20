import { describe, it } from 'node:test';
import assert from 'node:assert';
import { transformGhidraCode } from '../../../index.js';

/**
 * MONSTER_InitStats (00573cb0): Stack[-0x14] is the union
 * `D2MonStatsExTxtSlot { D2MonPropTxt *pMonPropTxt; D2MonStats2Txt *pMonStats2Txt; }`
 * and the isAtt bit test at 00574146 prints as `uMonTxt->isAtt`.
 */
const OPTS = {
  usePluginRegistry: true as const,
  preset: 'full' as const,
  pluginOptions: {
    pluginOptions: {
      'union-arrow-member': {
        unionNames: ['D2MonStatsExTxtSlot', 'AmbiguousSlot', 'D2UIMsgLParamUnion', 'TwoWords'],
        aggregateMembers: {
          D2MonStatsExTxtSlot: ['pMonPropTxt', 'pMonStats2Txt'],
          AmbiguousSlot: ['pA', 'pB'],
          D2MonPropTxt: ['Id', 'entry', 'chance'],
          D2MonStats2Txt: ['Id', 'revive', 'isAtt', 'isSmall'],
          PlainStruct: ['pMonStats2Txt'],
          D2UIMsgLParamUnion: ['nLParam', 'sMousePos'],
          D2UIMsgMousePosStrc: ['nX', 'nY'],
          D2UIMouseMsgStrc: ['hWnd', 'uLParam'],
        },
        structFields: {
          D2MonStatsExTxtSlot: { pMonPropTxt: 'D2MonPropTxt *', pMonStats2Txt: 'D2MonStats2Txt *' },
          AmbiguousSlot: { pA: 'D2MonPropTxt *', pB: 'D2MonStats2Txt *' },
          PlainStruct: { pMonStats2Txt: 'D2MonStats2Txt *' },
          D2UIMsgLParamUnion: { nLParam: 'int32_t', sMousePos: 'D2UIMsgMousePosStrc' },
          TwoWords: { nA: 'int32_t', nB: 'uint32_t', fC: 'float' },
          D2UIMouseMsgStrc: { hWnd: 'uint32_t', uLParam: 'D2UIMsgLParamUnion' },
        },
      },
    },
  },
};

const run = (src: string) => transformGhidraCode(src, OPTS);

describe('union-arrow-member', () => {
  it('restores the one pointer member whose pointee declares the field', () => {
    const r = run(`void f(void) { D2MonStatsExTxtSlot uMonTxt; if (uMonTxt->isAtt != 0) { g(); } }`);
    assert.ok(r.success, r.error);
    assert.ok(r.code.includes('uMonTxt.pMonStats2Txt->isAtt'), r.code);
  });

  it('leaves a field both pointees declare alone', () => {
    const r = run(`void f(void) { AmbiguousSlot u; int x = u->Id; }`);
    assert.ok(r.success, r.error);
    assert.ok(r.code.includes('u->Id'), r.code);
  });

  it('leaves a field no pointee declares alone', () => {
    const r = run(`void f(void) { D2MonStatsExTxtSlot u; int x = u->nothing; }`);
    assert.ok(r.success, r.error);
    assert.ok(r.code.includes('u->nothing'), r.code);
  });

  it('leaves a struct held by value alone', () => {
    const r = run(`void f(void) { PlainStruct s; int x = s->isAtt; }`);
    assert.ok(r.success, r.error);
    assert.ok(r.code.includes('s->isAtt'), r.code);
  });

  it('leaves a pointer to the union alone', () => {
    const r = run(`void f(D2MonStatsExTxtSlot *p) { D2MonPropTxt *q = p->pMonPropTxt; }`);
    assert.ok(r.success, r.error);
    assert.ok(r.code.includes('p->pMonPropTxt'), r.code);
  });

  it('leaves a correctly spelled member access alone', () => {
    const r = run(`void f(void) { D2MonStatsExTxtSlot u; int x = u.pMonStats2Txt->isAtt; }`);
    assert.ok(r.success, r.error);
    assert.ok(r.code.includes('u.pMonStats2Txt->isAtt'), r.code);
    assert.ok(!r.code.includes('pMonStats2Txt.pMonStats2Txt'), r.code);
  });

  // SMsgDispatchMessage 00420b00: the prototype's `undefined4 dwLParam` stored into
  // the D2UIMsgLParamUnion field. The store is four bytes; nLParam is the only
  // four-byte integer member.
  it('stores a scalar into the union member of its width', () => {
    const r = run(`void f(uint32_t dwLParam) { D2UIMouseMsgStrc hMsgWnd; hMsgWnd.uLParam = dwLParam; }`);
    assert.ok(r.success, r.error);
    assert.match(r.code, /hMsgWnd\.uLParam\.nLParam = dwLParam;/, r.code);
  });

  it('prefers the member of the exact type', () => {
    const r = run(`void f(uint32_t v) { TwoWords u; u = v; float g; u = g; }`);
    assert.ok(r.success, r.error);
    assert.match(r.code, /u\.nB = v;/, r.code);
    assert.match(r.code, /u\.fC = g;/, r.code);
  });

  it('leaves a store with two same-width candidates alone', () => {
    const r = run(`void f(uint16_t v) { TwoWords u; u = (long)v; }`);
    assert.ok(r.success, r.error);
    assert.doesNotMatch(r.code, /u\.n[AB]/, r.code);
  });

  it('leaves a whole-union copy alone', () => {
    const r = run(`void f(D2UIMsgLParamUnion v) { D2UIMouseMsgStrc m; m.uLParam = v; }`);
    assert.ok(r.success, r.error);
    assert.match(r.code, /m\.uLParam = v;/, r.code);
  });

  it('never stores an integer into a floating or narrower member', () => {
    const r = run(`void f(uint8_t b) { D2UIMouseMsgStrc m; m.uLParam = b; }`);
    assert.ok(r.success, r.error);
    assert.match(r.code, /m\.uLParam = b;/, r.code);
  });
});
