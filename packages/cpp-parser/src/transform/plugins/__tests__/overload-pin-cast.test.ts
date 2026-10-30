/**
 * The exact type of the member of a shared qualified name whose address a body takes.
 *
 * `D2Win::Src::D2WinImage::Draw` names two functions (004fd1f0 over `D2WinImage *`,
 * 004fd470 over `D2WinImageEx *`). The caller pins the one the body's instructions
 * take and hands its exact type; every place the name is not CALLED gets it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { funcPtrArgCastPlugin } from '../builtins/funcptr-arg-cast.js';
import { overloadPinCastPlugin } from '../builtins/overload-pin-cast.js';

const NAME = 'D2Win::Src::D2WinImage::Draw';
const PINNED = { [NAME]: { returnType: 'BOOL', paramTypes: ['::D2WinImage *'], convention: '__fastcall' } };
const EXACT = '(BOOL (__fastcall *)(::D2WinImage*))';

function pin(code: string, pinnedFunctions: Record<string, unknown> = PINNED): string {
  return emit(overloadPinCastPlugin.createTransformer({ pinnedFunctions })(parse(code)) as AnyNode);
}

/** The slot pass first, as the pipeline orders them, with the member's entries pinned. */
function slotThenPin(code: string): string {
  const slot = funcPtrArgCastPlugin.createTransformer({
    paramFuncdefs: { RegisterDraw: { 0: 'Draw' } },
    funcdefSignatures: { Draw: 'BOOL(D2ControlStrc *)' },
    functionSignatures: { [NAME]: 'BOOL(D2WinImage *)' },
    functionParamTypes: { [NAME]: ['::D2WinImage *'] },
    functionReturnTypes: { [NAME]: 'BOOL' },
    functionConventions: { [NAME]: '__fastcall' },
    fieldFuncdefs: { fpDraw: 'Draw' },
    rootQualifiedTypedefs: ['Draw'],
    overloadedFunctionNames: ['Draw'],
    enclosingSegments: ['D2Win', 'Src', 'D2WinImage'],
  });
  const ast = slot(parse(code));
  return emit(overloadPinCastPlugin.createTransformer({ pinnedFunctions: PINNED })(ast) as AnyNode);
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('overload-pin-cast', () => {
  it('completes the funcdef-slot store with the member\'s own type, once', () => {
    const out = slotThenPin(`void f() { pNew->sControl.fpDraw = ${NAME}; }`);
    assert.ok(out.includes(`fpDraw = (::Draw)${EXACT}${NAME}`), out);
    assert.strictEqual(count(out, EXACT), 1, out);
  });

  it('casts a function passed as a call argument', () => {
    const out = slotThenPin(`void f() { RegisterDraw(${NAME}); Install(${NAME}, 3); }`);
    assert.ok(out.includes(`RegisterDraw((::Draw)${EXACT}${NAME})`), out);
    assert.ok(out.includes(`Install(${EXACT}${NAME}, 3)`), out);
  });

  it('casts a compared and a returned reference', () => {
    const out = pin(`int f() { if (p->fpDraw == ${NAME}) return 1; return (int)${NAME}; }`);
    assert.ok(out.includes(`p->fpDraw == ${EXACT}${NAME}`), out);
    assert.ok(out.includes(`(int)${EXACT}${NAME}`), out);
  });

  it('casts outside an address-of, and leaves a call alone', () => {
    const out = pin(`void f() { g(&${NAME}); ${NAME}(pImage); }`);
    assert.ok(out.includes(`g(${EXACT}&${NAME})`), out);
    assert.ok(out.includes(`${NAME}(pImage)`) && !out.includes(`${EXACT}${NAME}(`), out);
  });

  it('follows the model spelling of a shortened reference', () => {
    const ast = parse('void f() { g(D2Win::Src::Draw); }');
    // What qualified-name-cleanup leaves on a reference it shortened.
    const q = (((ast as any).declarations[0].body.statements[0].expression.arguments[0]));
    q.ghidraInfo = { modelQualifiedName: NAME };
    const out = emit(overloadPinCastPlugin.createTransformer({ pinnedFunctions: PINNED })(ast) as AnyNode);
    assert.ok(out.includes(`g(${EXACT}D2Win::Src::Draw)`), out);
  });

  it('touches nothing it was not handed', () => {
    const code = `void f() { p->fpDraw = D2Win::Src::D2WinButton::Draw; Draw = 1; }`;
    assert.strictEqual(pin(code), emit(parse(code) as AnyNode));
    assert.strictEqual(pin(code, {}), emit(parse(code) as AnyNode));
  });
});
