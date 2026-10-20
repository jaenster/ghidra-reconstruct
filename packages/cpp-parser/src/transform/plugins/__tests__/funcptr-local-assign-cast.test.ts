/**
 * A function stored into a LOCAL declared with a funcdef typedef whose prototype it
 * differs from only in its pointer types: PlayerMsg's `pfnChatCallback =
 * CHAT_DeliverWhisper` (fpForEachClientFn, `void *` context) and D2WinEditBox's
 * `pfnDraw = Src::Draw` (Draw over D2ControlStrc *, the box's own over D2WinEditBox *).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { funcPtrArgCastPlugin } from '../builtins/funcptr-arg-cast.js';

const OPTS = {
  paramFuncdefs: {},
  funcdefSignatures: { fpForEachClientFn: 'void(D2ClientStrc *,void *)', Draw: 'BOOL(D2ControlStrc *)' },
  functionSignatures: {
    CHAT_DeliverWhisper: 'void(D2ClientStrc *,char * *)',
    'D2Win::Src::D2WinEditBox::Draw': 'BOOL(D2WinEditBox *)',
    TooMany: 'void(D2ClientStrc *,void *,int)',
  },
  overloadedFunctionNames: ['Draw'],
  functionReturnTypes: { 'D2Win::Src::D2WinEditBox::Draw': 'BOOL' },
  functionParamTypes: { 'D2Win::Src::D2WinEditBox::Draw': ['D2WinEditBox *'] },
  enclosingSegments: ['D2Win', 'Src', 'D2WinEditBox'],
};
const run = (code: string) => emit(funcPtrArgCastPlugin.createTransformer(OPTS)(parse(code)) as AnyNode);

describe('funcptr-arg-cast: a store into a funcdef-typed local', () => {
  it('casts a callback whose prototype differs only in pointer types', () => {
    const out = run('void f(void) { fpForEachClientFn pfnChatCallback; pfnChatCallback = CHAT_DeliverWhisper; }');
    assert.match(out, /pfnChatCallback = \(fpForEachClientFn\)CHAT_DeliverWhisper;/);
  });
  it('reduces an overload set first', () => {
    const out = run('void f(void) { Draw pfnDraw = Draw; }');
    assert.match(out, /pfnDraw = \(Draw\)\(BOOL \(\*\)\(D2WinEditBox ?\*\)\)Draw;/, out);
  });
  it('does not cast across an arity change', () => {
    const out = run('void f(void) { fpForEachClientFn p; p = TooMany; }');
    assert.match(out, /p = TooMany;/);
  });
});

describe('funcptr-arg-cast: a root-qualified funcdef local', () => {
  it('`::Draw pfnDraw;` is still the Draw slot (D2WinEditBox, v1126)', () => {
    const out = run('void f(void) { ::Draw pfnDraw; pfnDraw = Draw; }');
    assert.match(out, /pfnDraw = \(Draw\)\(BOOL \(\*\)\(D2WinEditBox ?\*\)\)Draw;/, out);
  });
});
