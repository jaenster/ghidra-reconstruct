/**
 * Call-Argument Cast-Insertion Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { callArgCastPlugin } from '../builtins/call-arg-cast.js';

describe('callArgCastPlugin', () => {
  const run = (code: string, options: Record<string, unknown>): string =>
    emit(callArgCastPlugin.createTransformer(options)(parse(code)) as AnyNode)
      .replace(/\s+/g, ' ')
      .trim();

  const paramTypes = { Callee: ['uint8_t **'] };

  it('casts a differing pointer argument to the declared parameter type', () => {
    const out = run(`void f() { int* p; Callee(p); }`, { functionParamTypes: paramTypes });
    assert.ok(out.includes('Callee((uint8_t**)p)'), out);
  });

  it('casts an integer argument into a pointer slot', () => {
    const out = run(`void f() { int n; Callee(n); }`, { functionParamTypes: paramTypes });
    assert.ok(out.includes('Callee((uint8_t**)n)'), out);
  });

  it('leaves a matching argument alone', () => {
    const out = run(`void f() { uint8_t** p; Callee(p); }`, { functionParamTypes: paramTypes });
    assert.ok(out.includes('Callee(p)') && !out.includes('(uint8_t**)p'), out);
  });

  it('treats an aliased spelling as the same type', () => {
    const out = run(`void f() { int32_t* p; Callee(p); }`, {
      functionParamTypes: { Callee: ['int *'] },
    });
    assert.ok(!out.includes('(int*)p'), out);
  });

  it('leaves an integer-to-integer mismatch alone', () => {
    const out = run(`void f() { int n; Callee(n); }`, {
      functionParamTypes: { Callee: ['uint8_t'] },
    });
    assert.ok(out.includes('Callee(n)') && !out.includes('(uint8_t)n'), out);
  });

  it('leaves a void* parameter alone for a plain pointer', () => {
    const out = run(`void f() { int* p; Callee(p); }`, {
      functionParamTypes: { Callee: ['void *'] },
    });
    assert.ok(out.includes('Callee(p)') && !out.includes('(void*)p'), out);
  });

  it('casts a const pointer into a non-const void* slot', () => {
    const out = run(`void f() { LPCVOID p; Callee(p); }`, {
      functionParamTypes: { Callee: ['void *'] },
    });
    assert.ok(out.includes('Callee((void*)p)'), out);
  });

  it('reads a parameter type that only the caller table knows', () => {
    const out = run(`void f() { Callee(pParam); }`, {
      functionParamTypes: paramTypes,
      enclosingVarTypes: { pParam: 'void *' },
    });
    assert.ok(out.includes('Callee((uint8_t**)pParam)'), out);
  });

  it('reads a global variable type', () => {
    const out = run(`void f() { Callee(gList); }`, {
      functionParamTypes: paramTypes,
      globalTypes: { gList: 'char *' },
    });
    assert.ok(out.includes('Callee((uint8_t**)gList)'), out);
  });

  it('takes the address of a field whose type every aggregate agrees on', () => {
    const out = run(`void f() { D2Strc s; Callee(&s.nCount); }`, {
      functionParamTypes: paramTypes,
      fieldTypes: { nCount: 'int32_t' },
    });
    assert.ok(out.includes('Callee((uint8_t**)&s.nCount)'), out);
  });

  it('leaves a function-pointer parameter to funcptr-arg-cast', () => {
    const out = run(`void f() { int* p; Callee(p); }`, {
      functionParamTypes: { Callee: ['fpHandler'] },
      funcdefNames: ['fpHandler'],
    });
    assert.ok(!out.includes('(fpHandler)p'), out);
  });

  it('still casts a named parameter of a varargs callee', () => {
    const out = run(`void f() { int* p; Callee(p); }`, {
      functionParamTypes: paramTypes,
      varArgFunctions: ['Callee'],
    });
    assert.ok(out.includes('Callee((uint8_t**)p)'), out);
  });

  it('leaves the trailing ... arguments of a varargs call alone', () => {
    const out = run(`void f() { int* p; int* q; Callee(p, q); }`, {
      functionParamTypes: paramTypes,
      varArgFunctions: ['Callee'],
    });
    assert.ok(out.includes('Callee((uint8_t**)p, q)'), out);
  });

  it('leaves an arity mismatch alone — that is the database\'s to fix', () => {
    const out = run(`void f() { int* p; Callee(p, p); }`, { functionParamTypes: paramTypes });
    assert.ok(!out.includes('(uint8_t**)p'), out);
  });

  it('leaves an unknown callee alone', () => {
    const out = run(`void f() { int* p; Other(p); }`, { functionParamTypes: paramTypes });
    assert.ok(out.includes('Other(p)'), out);
  });

  it('is idempotent — a second pass reads its own cast and adds nothing', () => {
    const once = run(`void f() { int* p; Callee(p); }`, { functionParamTypes: paramTypes });
    const twice = run(once, { functionParamTypes: paramTypes });
    assert.strictEqual(twice, once);
  });

  describe('a function address passed to a slot that is not its own prototype', () => {
    const fns = { functionNames: ['MyCallback'], variableNames: ['gnData'] };

    it('casts into an object-pointer parameter', () => {
      const out = run(`void f() { Takes(MyCallback); }`, {
        ...fns, functionParamTypes: { Takes: ['char *'] },
      });
      assert.ok(out.includes('Takes((char*)MyCallback)'), out);
    });

    it('goes through uintptr_t into a word-wide parameter', () => {
      const out = run(`void f() { Takes(MyCallback); }`, {
        ...fns, functionParamTypes: { Takes: ['undefined4'] },
      });
      assert.ok(out.includes('Takes((undefined4)(uintptr_t)MyCallback)'), out);
    });

    it('casts into an opaque callback typedef the model cannot reduce', () => {
      const out = run(`void f() { Takes(MyCallback); }`, {
        ...fns, functionParamTypes: { Takes: ['FARPROC'] },
      });
      assert.ok(out.includes('Takes((FARPROC)MyCallback)'), out);
    });

    it('leaves a NARROWER parameter visible rather than truncating the address', () => {
      const out = run(`void f() { Takes(MyCallback); }`, {
        ...fns, functionParamTypes: { Takes: ['uint8_t'] },
      });
      assert.ok(out.includes('Takes(MyCallback)'), out);
    });

    it('leaves a funcdef-typedef parameter to funcptr-arg-cast', () => {
      const out = run(`void f() { Takes(MyCallback); }`, {
        ...fns, funcdefNames: ['PFN_Thing'], functionParamTypes: { Takes: ['PFN_Thing'] },
      });
      assert.ok(out.includes('Takes(MyCallback)'), out);
    });

    it('leaves a name that also denotes DATA alone', () => {
      const out = run(`void f() { Takes(gnData); }`, {
        functionNames: ['gnData'], variableNames: ['gnData'],
        functionParamTypes: { Takes: ['char *'] },
      });
      assert.ok(out.includes('Takes(gnData)'), out);
    });
  });

  it('keeps the pointer type through pointer arithmetic', () => {
    const out = run(`void f() { Takes(pBuf + 0x11); }`, {
      functionParamTypes: { Takes: ['uint32_t *'] },
      enclosingVarTypes: { pBuf: 'int *' },
    });
    assert.ok(out.includes('Takes((uint32_t*)(pBuf + 0x11))'), out);
  });

  it('does nothing without a parameter-type table', () => {
    const out = run(`void f() { int* p; Callee(p); }`, {});
    assert.ok(out.includes('Callee(p)'), out);
  });
});

/**
 * A call made THROUGH a function-pointer field or variable has no callee name,
 * so every name-keyed table misses it. The funcdef the slot is declared with is
 * the contract that call is made under - these cover the route from a field (or
 * variable) type to that funcdef, and from the funcdef to the call's arguments
 * and result.
 */
describe('callArgCastPlugin — calls through a function pointer', () => {
  const run = (code: string, options: Record<string, unknown>): string =>
    emit(callArgCastPlugin.createTransformer(options)(parse(code)) as AnyNode)
      .replace(/\s+/g, ' ')
      .trim();

  // `functionParamTypes` is what arms the pass at all, so every case carries an
  // unrelated entry — the funcdef route must not depend on the callee's name.
  const base = {
    functionParamTypes: { Unrelated: ['int'] },
    funcdefDecls: {
      fnLoad: { returnType: 'void *', paramTypes: [] },
      fnDraw: { returnType: 'int', paramTypes: ['uint8_t *', 'int'] },
    },
    structFieldFuncdefs: { Callbacks: { pfnLoad: 'fnLoad', pfnDraw: 'fnDraw' } },
    fieldFuncdefs: { pfnDraw: 'fnDraw' },
    structFields: { Callbacks: { pNext: 'Callbacks *' } },
  };

  it('casts arguments to the funcdef a struct field is declared with', () => {
    const out = run(`void f() { Callbacks* c; int* p; c->pfnDraw(p, 1); }`, {
      ...base,
      globalTypes: {},
    });
    assert.ok(out.includes('c->pfnDraw((uint8_t*)p, 1)'), out);
  });

  it('types the RESULT of a call through a field, so it can be cast onward', () => {
    const out = run(`void f() { Callbacks* c; Other(c->pfnLoad()); }`, {
      ...base,
      functionParamTypes: { Other: ['uint8_t *'] },
    });
    assert.ok(out.includes('Other((uint8_t*)c->pfnLoad())'), out);
  });

  it('reads the field off the aggregate the walk names, not off the field name', () => {
    // `pfnLoad` is unanimous nowhere, so only the struct-keyed table can place
    // it — which is the point of keying on what the expression actually walks.
    const out = run(`void f() { Callbacks* c; Other(c->pfnLoad()); }`, {
      ...base,
      fieldFuncdefs: {},
      functionParamTypes: { Other: ['uint8_t *'] },
    });
    assert.ok(out.includes('Other((uint8_t*)c->pfnLoad())'), out);
  });

  it('does not let a unanimous field name overrule the aggregate that is known', () => {
    // The walk says `Other2`, which declares no function-pointer field at all;
    // `pfnDraw` meaning `fnDraw` in some OTHER struct is not evidence about this
    // one, and guessing there would cast against the wrong prototype.
    const out = run(`void f() { Other2* c; int* p; c->pfnDraw(p, 1); }`, {
      ...base,
      structFieldFuncdefs: { ...base.structFieldFuncdefs, Other2: { pfnOther: 'fnLoad' } },
      structFields: { Other2: { pNext: 'Other2 *' } },
    });
    assert.ok(out.includes('c->pfnDraw(p, 1)') && !out.includes('(uint8_t*)p'), out);
  });

  it('falls back to the unanimous field table when the aggregate is unknown', () => {
    const out = run(`void f() { int* p; gpUnknown->pfnDraw(p, 1); }`, base);
    assert.ok(out.includes('gpUnknown->pfnDraw((uint8_t*)p, 1)'), out);
  });

  it('casts through a funcdef-typed variable, which has no callee signature', () => {
    const out = run(`void f() { fnDraw pfn; int* p; pfn(p, 1); }`, base);
    assert.ok(out.includes('pfn((uint8_t*)p, 1)'), out);
  });

  it('resolves the same funcdef through a dereference', () => {
    const out = run(`void f() { fnDraw pfn; int* p; (*pfn)(p, 1); }`, base);
    assert.ok(out.includes('(uint8_t*)p'), out);
  });

  it('leaves an arity disagreement alone — a cast cannot fix a missing argument', () => {
    const out = run(`void f() { Callbacks* c; int* p; c->pfnDraw(p, 1, 2); }`, base);
    assert.ok(out.includes('c->pfnDraw(p, 1, 2)') && !out.includes('(uint8_t*)p'), out);
  });

  it('still casts the named parameters of a varargs funcdef', () => {
    const out = run(`void f() { Callbacks* c; int* p; c->pfnLog(p, 1); }`, {
      ...base,
      funcdefDecls: {
        ...base.funcdefDecls,
        fnLog: { returnType: 'void', paramTypes: ['uint8_t *', 'int'], varArgs: true },
      },
      structFieldFuncdefs: { Callbacks: { pfnLog: 'fnLog' } },
      fieldFuncdefs: {},
    });
    assert.ok(out.includes('c->pfnLog((uint8_t*)p, 1)'), out);
  });

  it('leaves the trailing ... arguments of a varargs funcdef call alone — no declared type past the named slots', () => {
    const out = run(`void f() { Callbacks* c; int* p; c->pfnLog(p, 1, p); }`, {
      ...base,
      funcdefDecls: {
        ...base.funcdefDecls,
        fnLog: { returnType: 'void', paramTypes: ['uint8_t *', 'int'], varArgs: true },
      },
      structFieldFuncdefs: { Callbacks: { pfnLog: 'fnLog' } },
      fieldFuncdefs: {},
    });
    assert.ok(out.includes('c->pfnLog((uint8_t*)p, 1, p)'), out);
  });

  it('leaves a field the model does not record as a function pointer alone', () => {
    const out = run(`void f() { Callbacks* c; int* p; c->pfnMystery(p, 1); }`, base);
    assert.ok(out.includes('c->pfnMystery(p, 1)'), out);
  });

  it('does nothing at all without the funcdef tables', () => {
    const out = run(`void f() { Callbacks* c; int* p; c->pfnDraw(p, 1); }`, {
      functionParamTypes: { Unrelated: ['int'] },
    });
    assert.ok(out.includes('c->pfnDraw(p, 1)'), out);
  });

  it('is idempotent — a second run reads its own cast and adds nothing', () => {
    const once = run(`void f() { Callbacks* c; int* p; c->pfnDraw(p, 1); }`, base);
    const twice = run(once, base);
    assert.strictEqual(twice, once);
  });
});
