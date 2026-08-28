/**
 * The assignment half of funcptr-arg-cast: a function address stored into a
 * struct field whose declared type is a funcdef with a different prototype.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { funcPtrArgCastPlugin } from '../builtins/funcptr-arg-cast.js';

const BASE = {
  paramFuncdefs: {},
  funcdefSignatures: { Draw: 'BOOL(D2ControlStrc *)' },
  functionSignatures: { 'D2Client::Forms::D2WinList::Draw': 'BOOL(D2WinList *)' },
  fieldFuncdefs: { fpDraw: 'Draw' },
};

function run(code: string, extra: Record<string, unknown> = {}): string {
  const ast = parse(code);
  return emit(funcPtrArgCastPlugin.createTransformer({ ...BASE, ...extra })(ast) as AnyNode);
}

describe('funcdef-typed field assignment', () => {
  it('casts a covariant callback to the funcdef the slot declares', () => {
    const out = run('void f() { pList->sControl.fpDraw = Draw; }', {
      enclosingSegments: ['D2Client', 'Forms', 'D2WinList'],
    });
    assert.ok(/fpDraw = \(Draw\)Draw/.test(out), out);
  });

  it('resolves an unqualified name through the enclosing scope', () => {
    // Without the enclosing scope the bare `Draw` is one of twelve and the
    // tables refuse to answer, so no cast may be emitted.
    const out = run('void f() { pList->sControl.fpDraw = Draw; }');
    assert.ok(!/\(Draw\)/.test(out), `no scope, no cast: ${out}`);
  });

  it('resolves an outer-scope qualified spelling deeper into the enclosing path', () => {
    // The emitter qualifies the reference to `D2Client::Forms::Draw` before
    // stripping it back; the function it denotes is `...::D2WinList::Draw`.
    const out = run('void f() { pList->sControl.fpDraw = D2Client::Forms::Draw; }', {
      enclosingSegments: ['D2Client', 'Forms', 'D2WinList'],
    });
    assert.ok(/\(Draw\)/.test(out), out);
  });

  it('leaves a qualifier that is not a prefix of the enclosing path alone', () => {
    const out = run('void f() { pList->sControl.fpDraw = Storm::Draw; }', {
      enclosingSegments: ['D2Client', 'Forms', 'D2WinList'],
    });
    assert.ok(!/\(Draw\)/.test(out), out);
  });

  it('emits nothing when the prototypes already agree', () => {
    const out = run('void f() { pList->sControl.fpDraw = Draw; }', {
      enclosingSegments: ['D2Client', 'Forms', 'D2WinList'],
      functionSignatures: { 'D2Client::Forms::D2WinList::Draw': 'BOOL(D2ControlStrc *)' },
    });
    assert.ok(!/\(Draw\)/.test(out), out);
  });

  it('refuses to cast across an arity change', () => {
    const out = run('void f() { pList->sControl.fpDraw = Draw; }', {
      enclosingSegments: ['D2Client', 'Forms', 'D2WinList'],
      functionSignatures: { 'D2Client::Forms::D2WinList::Draw': 'BOOL(D2WinList *,int)' },
    });
    assert.ok(!/\(Draw\)/.test(out), `an arity mismatch is a real disagreement: ${out}`);
  });

  it('leaves a field no funcdef declares alone', () => {
    const out = run('void f() { pList->sControl.pNext = Draw; }', {
      enclosingSegments: ['D2Client', 'Forms', 'D2WinList'],
    });
    assert.ok(!/\(Draw\)/.test(out), out);
  });
});
