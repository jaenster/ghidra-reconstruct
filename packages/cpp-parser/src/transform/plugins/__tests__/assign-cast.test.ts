/**
 * Assignment / Initialiser Cast-Insertion Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { assignCastPlugin } from '../builtins/assign-cast.js';

describe('assignCastPlugin', () => {
  const run = (code: string, options: Record<string, unknown>): string =>
    emit(assignCastPlugin.createTransformer(options)(parse(code)) as AnyNode)
      .replace(/\s+/g, ' ')
      .trim();

  const globals = { globalTypes: { gpThing: 'D2UnitStrc *', gnWord: 'uint32_t' } };

  it('casts a void* call result into a typed global', () => {
    const out = run(`void f() { gpThing = Alloc(4); }`, {
      ...globals,
      functionReturnTypes: { Alloc: 'void *' },
    });
    assert.ok(out.includes('gpThing = (D2UnitStrc*)Alloc(4)'), out);
  });

  it('casts into a PARAMETER, whose type is not in the AST at all', () => {
    const out = run(`void f() { pOut = pIn; }`, {
      enclosingVarTypes: { pOut: 'uint8_t *', pIn: 'uint32_t *' },
    });
    assert.ok(out.includes('pOut = (uint8_t*)pIn'), out);
  });

  it('casts into a struct field whose type every aggregate agrees on', () => {
    const out = run(`void f() { p->pNext = gpThing; }`, {
      ...globals,
      fieldTypes: { pNext: 'D2RoomStrc *' },
    });
    assert.ok(out.includes('p->pNext = (D2RoomStrc*)gpThing'), out);
  });

  it('spells a pointer stored into a word slot through uintptr_t', () => {
    const out = run(`void f() { gnWord = gpThing; }`, globals);
    assert.ok(out.includes('gnWord = (uint32_t)(uintptr_t)gpThing'), out);
  });

  it('leaves a pointer stored into a NARROWER slot visible', () => {
    const out = run(`void f() { nByte = gpThing; }`, {
      ...globals,
      enclosingVarTypes: { nByte: 'uint8_t' },
    });
    assert.ok(!out.includes('(uint8_t)'), out);
  });

  it('leaves an integer-to-integer assignment alone', () => {
    const out = run(`void f() { gnWord = nOther; }`, {
      ...globals,
      enclosingVarTypes: { nOther: 'uint16_t' },
    });
    assert.ok(out.includes('gnWord = nOther') && !out.includes('(uint32_t)'), out);
  });

  it('leaves a matching assignment alone', () => {
    const out = run(`void f() { gpThing = pSame; }`, {
      ...globals,
      enclosingVarTypes: { pSame: 'D2UnitStrc *' },
    });
    assert.ok(out.includes('gpThing = pSame') && !out.includes('(D2UnitStrc*)'), out);
  });

  it('leaves a plain pointer stored into void* alone', () => {
    const out = run(`void f() { pAny = gpThing; }`, {
      ...globals,
      enclosingVarTypes: { pAny: 'void *' },
    });
    assert.ok(out.includes('pAny = gpThing') && !out.includes('(void*)'), out);
  });

  it('sees the indirection hidden inside a typedef name', () => {
    const out = run(`void f() { hThing = gpThing; }`, {
      ...globals,
      enclosingVarTypes: { hThing: 'HACCEL' },
      typedefTargets: { HACCEL: 'HACCEL__ *' },
    });
    assert.ok(out.includes('hThing = (HACCEL)gpThing'), out);
  });

  it('does not follow a self-referential typedef', () => {
    const out = run(`void f() { pProc = gpThing; }`, {
      ...globals,
      enclosingVarTypes: { pProc: 'FARPROC' },
      typedefTargets: { FARPROC: 'FARPROC *' },
    });
    // FARPROC stays a scalar name; the store is a pointer into a non-word slot
    // and is left visible rather than cast through a bogus resolution.
    assert.ok(out.includes('pProc = gpThing'), out);
  });

  it('casts a variable initialiser to the declared type', () => {
    const out = run(`void f() { uint8_t* p = gpThing; }`, globals);
    assert.ok(out.includes('uint8_t* p = (uint8_t*)gpThing'), out);
  });

  it('never casts to an array type', () => {
    const out = run(`void f() { szBuf = gpThing; }`, {
      ...globals,
      enclosingVarTypes: { szBuf: 'char [4]' },
    });
    assert.ok(!out.includes('(char[4])') && !out.includes('(char [4])'), out);
  });

  it('uses the struct the walk actually names, not the unanimous guess', () => {
    // `pNext` means a different type in every struct that has one, so the
    // unanimity rule drops it - but the object's own type says which struct.
    const out = run(`void f() { pRoom->pNext = gpThing; }`, {
      ...globals,
      enclosingVarTypes: { pRoom: 'D2RoomStrc *' },
      structFields: { D2RoomStrc: { pNext: 'D2RoomStrc *' } },
    });
    assert.ok(out.includes('pRoom->pNext = (D2RoomStrc*)gpThing'), out);
  });

  it('falls back to the unanimous field type when the object type is unknown', () => {
    const out = run(`void f() { pUnknown->pNext = gpThing; }`, {
      ...globals,
      fieldTypes: { pNext: 'D2RoomStrc *' },
      structFields: { D2RoomStrc: { pNext: 'uint32_t' } },
    });
    assert.ok(out.includes('pUnknown->pNext = (D2RoomStrc*)gpThing'), out);
  });

  it('is idempotent', () => {
    const once = run(`void f() { gpThing = Alloc(4); }`, {
      ...globals,
      functionReturnTypes: { Alloc: 'void *' },
    });
    const twice = run(once, { ...globals, functionReturnTypes: { Alloc: 'void *' } });
    assert.strictEqual(twice, once);
  });

  describe('a function address stored into a slot that is not its own prototype', () => {
    const fns = { functionNames: ['MyCallback', 'Ns::MyCallback'], variableNames: ['gnData'] };

    it('casts into an object pointer', () => {
      const out = run(`void f() { pOut = MyCallback; }`, {
        ...fns, enclosingVarTypes: { pOut: 'char *' },
      });
      assert.ok(out.includes('pOut = (char*)MyCallback'), out);
    });

    it('goes through uintptr_t into a word-wide slot', () => {
      const out = run(`void f() { nSlot = MyCallback; }`, {
        ...fns, enclosingVarTypes: { nSlot: 'uint32_t' },
      });
      assert.ok(out.includes('nSlot = (uint32_t)(uintptr_t)MyCallback'), out);
    });

    it('casts into an opaque callback typedef the model cannot reduce', () => {
      const out = run(`void f() { pfn = MyCallback; }`, {
        ...fns, enclosingVarTypes: { pfn: 'FARPROC' },
      });
      assert.ok(out.includes('pfn = (FARPROC)MyCallback'), out);
    });

    it('casts a returned function address to the declared return type', () => {
      const out = run(`uint32_t f() { return MyCallback; }`, {
        ...fns, enclosingVarTypes: { unused: 'int' },
      });
      assert.ok(out.includes('return (uint32_t)(uintptr_t)MyCallback'), out);
    });

    it('leaves a NARROWER slot visible rather than truncating the address', () => {
      const out = run(`void f() { nByte = MyCallback; }`, {
        ...fns, enclosingVarTypes: { nByte: 'uint8_t' },
      });
      assert.ok(!out.includes('(uint8_t)'), out);
    });

    it('leaves a name that also denotes DATA alone', () => {
      const out = run(`void f() { pOut = gnData; }`, {
        functionNames: ['gnData'], variableNames: ['gnData'],
        enclosingVarTypes: { pOut: 'char *' },
      });
      assert.ok(out.includes('pOut = gnData'), out);
    });

    it('leaves a funcdef-typedef slot to funcptr-arg-cast', () => {
      const out = run(`void f() { pfn = MyCallback; }`, {
        ...fns, funcdefNames: ['PFN_Thing'], enclosingVarTypes: { pfn: 'PFN_Thing' },
      });
      assert.ok(out.includes('pfn = MyCallback'), out);
    });
  });

  it('keeps the pointer type through pointer arithmetic', () => {
    const out = run(`void f() { pOut = pBuf + 0x11; }`, {
      enclosingVarTypes: { pOut: 'uint32_t *', pBuf: 'int *' },
    });
    assert.ok(out.includes('pOut = (uint32_t*)(pBuf + 0x11)'), out);
  });

  it('leaves a pointer DIFFERENCE alone - it is an integer, not a pointer', () => {
    const out = run(`void f() { pOut = pBuf - pEnd; }`, {
      enclosingVarTypes: { pOut: 'uint32_t *', pBuf: 'int *', pEnd: 'int *' },
    });
    assert.ok(!out.includes('(uint32_t*)(pBuf'), out);
  });

  it('does nothing without a type environment', () => {
    const out = run(`void f() { gpThing = Alloc(4); }`, {});
    assert.ok(out.includes('gpThing = Alloc(4)'), out);
  });
});

/**
 * The result of a call made THROUGH a function pointer. There is no callee name
 * for `functionReturnTypes` to match, so the funcdef the slot is declared with
 * is the only record of what the call returns.
 */
describe('assignCastPlugin — results of calls through a function pointer', () => {
  const run = (code: string, options: Record<string, unknown>): string =>
    emit(assignCastPlugin.createTransformer(options)(parse(code)) as AnyNode)
      .replace(/\s+/g, ' ')
      .trim();

  const base = {
    globalTypes: { gpCallbacks: 'Callbacks *', gpGateway: 'D2GatewayStrc *' },
    structFields: { Callbacks: { pNext: 'Callbacks *' } },
    funcdefDecls: {
      fnLoad: { returnType: 'void *', paramTypes: [] },
      fnCount: { returnType: 'void', paramTypes: [] },
    },
    structFieldFuncdefs: { Callbacks: { pfnLoad: 'fnLoad', pfnCount: 'fnCount' } },
    fieldFuncdefs: {},
  };

  it('casts a void* result from a field call into the typed slot it is stored in', () => {
    const out = run(`void f() { gpGateway = gpCallbacks->pfnLoad(); }`, base);
    assert.ok(out.includes('gpGateway = (D2GatewayStrc*)gpCallbacks->pfnLoad()'), out);
  });

  it('casts it into an initialiser as well', () => {
    const out = run(`void f() { D2GatewayStrc* p = gpCallbacks->pfnLoad(); }`, base);
    assert.ok(out.includes('(D2GatewayStrc*)gpCallbacks->pfnLoad()'), out);
  });

  // A funcdef that says the call returns nothing, assigned to a pointer, is the
  // database disagreeing with the machine — the caller demonstrably reads EAX.
  // No cast makes that true, and writing one would assert something false.
  it('leaves a void-returning funcdef alone rather than inventing a value', () => {
    const out = run(`void f() { gpGateway = gpCallbacks->pfnCount(); }`, base);
    assert.ok(out.includes('gpGateway = gpCallbacks->pfnCount()'), out);
    assert.ok(!out.includes('(D2GatewayStrc*)gpCallbacks->pfnCount()'), out);
  });

  it('leaves the result alone when nothing records the field as a function pointer', () => {
    const out = run(`void f() { gpGateway = gpCallbacks->pfnMystery(); }`, base);
    assert.ok(out.includes('gpGateway = gpCallbacks->pfnMystery()'), out);
  });
});
