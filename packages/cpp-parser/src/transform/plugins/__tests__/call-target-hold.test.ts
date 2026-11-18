/**
 * A table handler tested and then called is held in a local (call-target-hold).
 * MONSTER_DispatchUniqueModifiers 005a4270 is the reference shape; the refusals are the
 * shapes VC8 already reads once as printed, or where holding could change a value.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createCallTargetHoldTransformer } from '../builtins/call-target-hold.js';

const globalTypes = { gTable: 'Entry[8]', gFuncs: 'Fn*[8]', gInits: 'fpInit *[8]' };
const structFields = { Entry: { pfnMissile: 'Handler', aModes: 'Handler[4]' } };
const xf = createCallTargetHoldTransformer({ globalTypes, structFields, funcdefNames: ['fpInit'] });
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const run = (code: string) => norm(emit(xf(parse(code)) as AnyNode));
const same = (code: string) => assert.strictEqual(run(code), norm(emit(parse(code) as AnyNode)));

describe('call-target-hold', () => {
  it('MONSTER_DispatchUniqueModifiers 005a4270: the element is read once into a local', () => {
    assert.strictEqual(
      run('void f(unsigned char* pList, int i) { if (gTable[pList[i]].pfnMissile) { gTable[pList[i]].pfnMissile(1, pList[i]); } }'),
      'void f(unsigned char* pList, int i) { Handler pfnHandler = gTable[pList[i]].pfnMissile; if (pfnHandler) { pfnHandler(1, pList[i]); } }');
  });

  it('a dereferenced callee and a stored result keep their form', () => {
    assert.strictEqual(
      run('int f(int* p) { int r = 0; if (gFuncs[*p]) { r = (*gFuncs[*p])(2); } return r; }'),
      'int f(int* p) { int r = 0; Fn* pfnHandler = gFuncs[*p]; if (pfnHandler) { r = (*pfnHandler)(2); } return r; }');
  });

  it('UMOD 005a46e0: a Ghidra function definition is the tree\'s pointer typedef, declared without a star', () => {
    assert.strictEqual(
      run('void f(unsigned char* p, int i) { if (gInits[p[i]]) { (*gInits[p[i]])(p[i], 0); } }'),
      'void f(unsigned char* p, int i) { fpInit pfnHandler = gInits[p[i]]; if (pfnHandler) { (*pfnHandler)(p[i], 0); } }');
  });

  it('two sites get two names', () => {
    assert.match(
      run('void f(int* p) { if (gFuncs[p[0]]) gFuncs[p[0]](0); if (gFuncs[p[1]]) gFuncs[p[1]](1); }'),
      /Fn\* pfnHandler = gFuncs\[p\[0\]\];.*Fn\* pfnHandler2 = gFuncs\[p\[1\]\];/);
  });

  it('refuses a table indexed by a plain local: VC8 reads it once as printed (005a2120)', () => {
    same('void f(int i) { if (gFuncs[i]) { gFuncs[i](i); } }');
  });

  it('refuses a plain global and a member through a pointer', () => {
    same('void f(T* p) { if (gpfn) { gpfn(1); } if (p->pfn) { p->pfn(2); } }');
  });

  it('refuses an argument with an effect, an else, and a different callee', () => {
    same('void f(int* p) { if (gFuncs[*p]) { gFuncs[*p](g()); } }');
    same('void f(int* p) { if (gFuncs[*p]) { gFuncs[*p](0); } else { h(); } }');
    same('void f(int* p) { if (gFuncs[*p]) { gFuncs[p[1]](0); } }');
  });

  it('refuses a local table and an unknown type', () => {
    same('void f(int* p) { Fn* aLocal[4]; if (aLocal[*p]) { aLocal[*p](0); } }');
    same('void f(int* p) { if (gUnknown[*p]) { gUnknown[*p](0); } }');
  });
});
