/**
 * Reducing an overload set before reinterpreting it.
 *
 * The emitter files a function under the namespace of its DIRECTORY, so the
 * per-file `Draw` of every `D2Win/Src/*.cpp` lands in one `D2Win::Src`. C++ then
 * sees an overload set, and a cast selects from one only on an EXACT function
 * type — which the slot's funcdef is, by construction, not: that disagreement is
 * the whole reason the cast is being written. GCC answers "overloaded function
 * with no contextual type information".
 *
 * Naming the function's own type first reduces the set to one member; the outer
 * cast then reinterprets it, exactly as it did before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { funcPtrArgCastPlugin } from '../builtins/funcptr-arg-cast.js';
import { assignCastPlugin } from '../builtins/assign-cast.js';
import { Type, Expr } from '../../../ast/factory.js';

const SCOPE = ['D2Win', 'Src', 'D2WinTextBox'];

const BASE = {
  paramFuncdefs: {},
  funcdefSignatures: { Draw: 'BOOL(D2ControlStrc *)' },
  functionSignatures: { 'D2Win::Src::D2WinTextBox::Draw': 'BOOL(D2WinTextBox *)' },
  fieldFuncdefs: { fpDraw: 'Draw' },
  functionReturnTypes: { 'D2Win::Src::D2WinTextBox::Draw': 'BOOL' },
  functionParamTypes: { 'D2Win::Src::D2WinTextBox::Draw': ['::D2WinTextBox *'] },
  enclosingSegments: SCOPE,
};

function run(code: string, extra: Record<string, unknown> = {}): string {
  const ast = parse(code);
  return emit(funcPtrArgCastPlugin.createTransformer({ ...BASE, ...extra })(ast) as AnyNode);
}

describe('overloaded function designator in a funcdef-slot cast', () => {
  it('spells the function own type when the bare name is an overload set', () => {
    const out = run('void f() { pNew->sControl.fpDraw = Draw; }', {
      overloadedFunctionNames: ['Draw'],
    });
    assert.ok(/\(Draw\)\(BOOL \(\*\)\(::D2WinTextBox\*\)\)Draw/.test(out), out);
  });

  it('leaves a name only one function carries alone', () => {
    const out = run('void f() { pNew->sControl.fpDraw = Draw; }');
    assert.ok(/fpDraw = \(Draw\)Draw/.test(out), out);
    assert.ok(!/BOOL \(\*\)/.test(out), `no overload, no inner cast: ${out}`);
  });

  it('refuses when the signature is not spellable as a plain type', () => {
    // A prototype this cannot spell EXACTLY selects no overload at all, so an
    // approximate cast would trade one error for another.
    const out = run('void f() { pNew->sControl.fpDraw = Draw; }', {
      overloadedFunctionNames: ['Draw'],
      functionParamTypes: { 'D2Win::Src::D2WinTextBox::Draw': ['void (*)(int)'] },
    });
    assert.ok(/fpDraw = \(Draw\)Draw/.test(out), out);
    assert.ok(!/BOOL \(\*\)/.test(out), out);
  });

  it('casts the function arm of a ternary, and only that arm', () => {
    // `branchless-select` leaves the callback in a ternary arm, where it is
    // still a designator whose type has to be spelled. The null arm needs none.
    const out = run('void f() { pNew->sControl.fpDraw = nParam & 1 ? Draw : nullptr; }', {
      overloadedFunctionNames: ['Draw'],
    });
    assert.ok(/\(Draw\)\(BOOL \(\*\)\(::D2WinTextBox\*\)\)Draw/.test(out), out);
    assert.ok(/: nullptr/.test(out), out);
  });
});

describe('overloaded function designator in a non-funcdef slot', () => {
  const ASSIGN = {
    functionNames: ['D2Win::Src::D2WinEditBox::Draw', 'Draw'],
    functionReturnTypes: { 'D2Win::Src::D2WinEditBox::Draw': 'BOOL' },
    functionParamTypes: { 'D2Win::Src::D2WinEditBox::Draw': ['::D2WinEditBox *'] },
    globalTypes: { gDummy: 'int' },
    enclosingSegments: ['D2Win', 'Src', 'D2WinEditBox'],
  };

  function runAssign(code: string, extra: Record<string, unknown> = {}): string {
    const ast = parse(code);
    return emit(assignCastPlugin.createTransformer({ ...ASSIGN, ...extra })(ast) as AnyNode);
  }

  it('reduces the set before reinterpreting into a code pointer', () => {
    const out = runAssign('void f() { code* pfnDraw; pfnDraw = Draw; }', {
      overloadedFunctionNames: ['Draw'],
    });
    assert.ok(/\(code\*\)\(BOOL \(\*\)\(::D2WinEditBox\*\)\)Draw/.test(out), out);
  });

  it('leaves an unambiguous name as the plain reinterpret', () => {
    const out = runAssign('void f() { code* pfnDraw; pfnDraw = Draw; }');
    assert.ok(/pfnDraw = \(code\*\)Draw/.test(out), out);
    assert.ok(!/BOOL \(\*\)/.test(out), out);
  });
});

describe('the C++ emitter spells a pointer to a function type', () => {
  it('binds the star inside the parentheses', () => {
    // `ret(args) *` is a function RETURNING a pointer, a different type.
    const cast = Expr.cast(
      Type.pointer(Type.function(Type.typedef('BOOL'), [Type.pointer(Type.typedef('::D2WinTextBox'))])),
      Expr.identifier('Draw'),
    );
    assert.equal(emit(cast as AnyNode).replace(/\s+/g, ' ').trim(), '(BOOL (*)(::D2WinTextBox*))Draw');
  });

  it('spells a variadic function pointer', () => {
    const cast = Expr.cast(
      Type.pointer(Type.function(Type.int(), [Type.pointer(Type.char())], true)),
      Expr.identifier('printf'),
    );
    assert.ok(/\(int \(\*\)\(char\*, \.\.\.\)\)printf/.test(emit(cast as AnyNode)), emit(cast as AnyNode));
  });
});
