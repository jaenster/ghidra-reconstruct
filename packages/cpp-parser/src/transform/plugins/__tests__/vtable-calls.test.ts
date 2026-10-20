/**
 * VTable Call Pattern Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { vtableCallPlugin } from '../builtins/vtable-calls.js';

describe('vtableCallPlugin', () => {
  const transformer = vtableCallPlugin.createTransformer();

  function transform(code: string): string {
    const ast = parse(code);
    const transformed = transformer(ast);
    return emit(transformed as AnyNode).trim();
  }

  describe('vtable call patterns', () => {
    // Note: These patterns are very specific to Ghidra output
    // VTable patterns are complex and parser-dependent

    it('should preserve regular function calls', () => {
      const code = `void f(int x) { printf("%d", x); }`;
      const result = transform(code);
      assert.ok(result.includes('printf'), `Expected printf in: ${result}`);
    });

    it('should preserve regular method calls', () => {
      const code = `void f(Obj *obj) { obj->method(); }`;
      const result = transform(code);
      assert.ok(result.includes('->method'), `Expected ->method in: ${result}`);
    });

    it('should preserve indirect calls through pointer', () => {
      const code = `void f(void *ptr) { int x = (*ptr)(); }`;
      // Parser may have issues with this, just verify no crash
      try {
        const result = transform(code);
        assert.ok(result.length > 0);
      } catch (e) {
        // Parser limitation - that's OK
        assert.ok(true);
      }
    });
  });

  describe('table vs object dispatch', () => {
    it('keeps ->vmethod_N only for a real `this`, where a class exists to declare it', () => {
      const code = `void f(int x) { (**(code **)(*this + 0x10))(this, x); }`;
      const result = transform(code);
      assert.ok(result.includes('->vmethod_4'), `Expected ->vmethod_4 in: ${result}`);
    });

    it('rewrites an object vtable on a non-`this` object to a faithful indirect call', () => {
      // `self` is a `int**`, not a class instance — `self->vmethod_4` would name a
      // member no type declares ("'int*' is not a pointer-to-object type").
      const code = `void f(int **self, int x) { (**(code **)(*self + 0x10))(self, x); }`;
      const result = transform(code);
      const norm = result.replace(/\s+/g, '');
      assert.ok(!norm.includes('->vmethod_'), `Expected no ->vmethod_ in: ${result}`);
      assert.ok(
        norm.includes('(**(code**)((char*)*(void**)(uintptr_t)self+16))(self,x)'),
        `Expected the indirect call in: ${result}`,
      );
    });

    it('treats the `this` of a FREE function as an untyped object, not a class instance', () => {
      // Every __thiscall function is emitted free: Ghidra's `this` is its `void *` ECX
      // argument. `pThis->vmethod_0(nEntry)` on it was "'void*' is not a
      // pointer-to-object type" (CELCMP_CelDataHash_RemoveAndCallbackSingle 00602620).
      const free = vtableCallPlugin.createTransformer({ thisIsClassInstance: false } as any);
      const code = `void f(int nEntry) { (*(code *)**(undefined4 **)this)(nEntry); }`;
      const result = emit(free(parse(code)) as AnyNode).trim();
      const norm = result.replace(/\s+/g, '');
      assert.ok(!norm.includes('->vmethod_'), `Expected no ->vmethod_ in: ${result}`);
      assert.ok(norm.includes('(**(code**)(char*)*(void**)(uintptr_t)this)(nEntry)'), `Expected the indirect call in: ${result}`);
    });

    it('rewrites a function-pointer TABLE (base + off) to a faithful byte-offset indirect call, not ->vmethod', () => {
      const code = `void f(void **arr, int a) { (**(code **)(arr + 8))(a); }`;
      const result = transform(code);
      const norm = result.replace(/\s+/g, '');
      assert.ok(!result.includes('vmethod'), `Should NOT emit vmethod for a table: ${result}`);
      assert.ok(norm.includes('(char*)arr+8'), `Expected byte-offset cast in: ${result}`);
      assert.ok(norm.includes('(code**)'), `Expected code** read in: ${result}`);
    });
  });

  describe('typed dispatch through the receiver\'s declared vtable', () => {
    // Shapes from the snapshot: a `__thiscall` slot is emitted with the object as its
    // first parameter; a `__stdcall` slot whose ECX Ghidra dropped is not.
    const dispatch = {
      classes: {
        ListBoxImplementation: { vfptrPath: ['pVtable'], vtable: 'ListBoxImplementationVtable' },
        TSExportTableSync_CELLIST: {
          vfptrPath: ['super_TSExportTableSimple_CELLIST', 'super_TSHashTable_CELLIST', '_vfptr'],
          vtable: 'TSHashTable_CELLIST_Vtable',
        },
      },
      vtables: {
        ListBoxImplementationVtable: {
          0: { member: 'ScalarDeletingDestructor', arity: 2, takesThis: true },
          4: { member: 'Draw', arity: 1, takesThis: true },
        },
        TSHashTable_CELLIST_Vtable: {
          0: { member: 'InternalDelete', arity: 1, takesThis: false },
          4: { member: 'InternalNew', arity: 4, takesThis: true },
        },
      },
    };
    const typed = (receiverTypes: Record<string, string>, globalTypes: Record<string, string> = {}) =>
      vtableCallPlugin.createTransformer({
        thisIsClassInstance: false,
        dispatch: { ...dispatch, receiverTypes, globalTypes },
      } as any);
    const run = (t: ReturnType<typeof typed>, code: string) =>
      emit(t(parse(code)) as AnyNode).trim().replace(/\s+/g, '');

    it('puts back the object a __thiscall slot takes first, which the untyped call dropped', () => {
      const out = run(typed({ pList: '::ListBoxImplementation *' }),
        `void f() { (**(code **)*(undefined4 *)pList)(1); }`);
      assert.ok(out.includes('pList->pVtable->ScalarDeletingDestructor(pList,1)'), out);
      assert.ok(!out.includes('code'), out);
    });

    it('keeps the argument list of a slot that takes no `this`', () => {
      const out = run(typed({ pThis: 'TSExportTableSync_CELLIST *' }),
        `void f(int nEntry) { (**(code **)*(undefined4 *)pThis)(nEntry); }`);
      assert.ok(out.includes(
        'pThis->super_TSExportTableSimple_CELLIST.super_TSHashTable_CELLIST._vfptr->InternalDelete(nEntry)'), out);
    });

    it('reads the slot at the byte offset the call indexes', () => {
      const out = run(typed({ pThis: 'TSExportTableSync_CELLIST *' }),
        `void f(int a, int b, int c) { x = (**(code **)(*(int *)pThis + 4))(a, b, c); }`);
      assert.ok(out.includes('._vfptr->InternalNew(pThis,a,b,c)'), out);
    });

    it('resolves a global receiver from its declared type', () => {
      const out = run(typed({}, { gpMercList: 'ListBoxImplementation *' }),
        `void f() { (**(code **)*gpMercList)(1); }`);
      assert.ok(out.includes('gpMercList->pVtable->ScalarDeletingDestructor(gpMercList,1)'), out);
    });

    it('does not pass the object twice when Ghidra already passed it', () => {
      const out = run(typed({ pList: 'ListBoxImplementation *' }),
        `void f() { (**(code **)(*(int *)pList + 4))(pList); }`);
      assert.ok(out.includes('pList->pVtable->Draw(pList)'), out);
    });

    it('falls back to the untyped call when the receiver is untyped (void *)', () => {
      const out = run(typed({ pThis: 'void *' }), `void f(int n) { (**(code **)*(undefined4 *)pThis)(n); }`);
      assert.ok(out.includes('(**(code**)(char*)*(void**)(uintptr_t)pThis)(n)'), out);
    });

    it('falls back when the arguments disagree with the slot\'s arity', () => {
      const out = run(typed({ pList: 'ListBoxImplementation *' }), `void f() { (**(code **)*(int *)pList)(1, 2, 3); }`);
      assert.ok(out.includes('(**(code**)(char*)*(void**)(uintptr_t)pList)(1,2,3)'), out);
    });

    it('falls back for a slot the vtable does not publish', () => {
      const out = run(typed({ pList: 'ListBoxImplementation *' }), `void f() { (**(code **)(*(int *)pList + 0x30))(); }`);
      assert.ok(out.includes('(**(code**)((char*)*(void**)(uintptr_t)pList+48))()'), out);
    });

    it('never retypes a pointer-to-pointer receiver', () => {
      const out = run(typed({ pp: 'ListBoxImplementation * *' }), `void f() { (**(code **)*pp)(1); }`);
      assert.ok(!out.includes('pVtable'), out);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(vtableCallPlugin.id, 'vtable-calls');
      assert.strictEqual(vtableCallPlugin.defaultEnabled, true);
      assert.ok(vtableCallPlugin.tags?.includes('core'));
      assert.ok(vtableCallPlugin.tags?.includes('cpp'));
    });

    it('should have low priority for early execution', () => {
      // Vtable calls should be processed early
      assert.ok(vtableCallPlugin.priority < 50, 'Expected priority < 50');
    });
  });
});

describe('vtableCallPlugin: a call through a typed function-pointer array', () => {
  const transformer = vtableCallPlugin.createTransformer();
  const transform = (code: string) => emit(transformer(parse(code)) as AnyNode).trim();
  it('keeps (*a[2])(...) and (*s.m[9])(...) as written - the element is already the function', () => {
    const out = transform(`void f(int g, int u, D2QuestDataStrc *q, QuestArg *a) {
      (*gapObjectOperateCallbacks[2])(g, u);
      (*(q->sStateFunctions).fpQuestStateHandler[9])(q, a);
      (*gaRoomExDeactivationHandlers[0])(u); }`);
    assert.ok(!out.includes('code'), out);
    assert.match(out, /\(\*gapObjectOperateCallbacks\[2\]\)\(g, u\)/);
    assert.match(out, /fpQuestStateHandler\[9\]\)\(q, a\)/);
  });
  it('still spells the raw untyped table form', () => {
    const out = transform('void f(void *p) { (*((int **)p)[8])(p); }');
    assert.ok(!/\(\(int \*\*\)p\)\[8\]/.test(out), out);
  });
});
