/**
 * A vtable held in a plain LOCAL, not in a class's `_vfptr` field.
 *
 * `disambiguateVtableTypes` repoints the owning struct's field, but Ghidra types
 * a body's own vtable locals with the bare `vtable *`, which the tree can only
 * render as `void *`:
 *
 *     vtable *pListHead = (vtable *)(pGameDataHashTable + 2);
 *     pListHead->FUN_004503f0 = (FUN_004503f0 *)pListHead;   // member on void*
 *
 * The member the body indexes names the vtable — and the member→vtable map drops
 * anything two vtables claim, so a hit is unambiguous by construction. A variable
 * is retyped only when every access through it agrees.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { retypeVtableLocals, vtableMembersByType } from '../modules/vtable-types.js';
import type { ExtractedDataType, ExtractedFunction, ExtractedStruct } from '../types.js';

function fn(decompiled: string, opts: {
  params?: Array<[string, string]>;
  locals?: Array<[string, string]>;
} = {}): ExtractedFunction {
  return {
    name: 'F', address: '00400000', signature: '', returnType: 'void',
    parameters: (opts.params ?? []).map(([name, dataType], ordinal) => ({
      name, dataType, size: 4, ordinal,
    })),
    localVariables: (opts.locals ?? []).map(([name, dataType]) => ({
      name, dataType, size: 4, storage: 'stack',
    })),
    decompiled, callingConvention: '__cdecl', size: 0,
    isThunk: false, isExternal: false, hasVarArgs: false,
  };
}

/** A vtable STRUCTURE as it looks AFTER disambiguateVtableTypes has renamed it. */
function renamed(category: string, name: string, members: string[]): ExtractedStruct {
  return {
    kind: 'STRUCTURE', name, category, size: members.length * 4,
    fields: members.map((m, i) => ({ name: m, dataType: 'void *', offset: i * 4, size: 4 })),
  };
}

describe('vtableMembersByType', () => {
  it('rebuilds the member map from types the rename already touched', () => {
    const types: ExtractedDataType[] = [
      renamed('/ListBoxImplementation', 'ListBoxImplementationVtable', ['LISTBOX_OnMouseUp']),
      renamed('/TSHashTable<struct_SGAMEDATA,class_HASHKEY_NONE>',
        'TSHashTable_struct_SGAMEDATA_class_HASHKEY_NONE_Vtable', ['FUN_004503f0']),
      // Not a vtable: its name is not `<owner>Vtable`.
      renamed('/ListBoxImplementation', 'ListBoxImplementation', ['pVtable']),
    ];

    const byMember = vtableMembersByType(types);
    assert.equal(byMember.get('LISTBOX_OnMouseUp'), 'ListBoxImplementationVtable');
    assert.equal(byMember.get('FUN_004503f0'),
      'TSHashTable_struct_SGAMEDATA_class_HASHKEY_NONE_Vtable');
    assert.equal(byMember.has('pVtable'), false);
  });

  it('drops a member two vtables both claim', () => {
    const byMember = vtableMembersByType([
      renamed('/IgnoreList', 'IgnoreListVtable', ['shared', 'IGNORELIST_Save']),
      renamed('/WardenClient', 'WardenClientVtable', ['shared', 'WARDEN_Run']),
    ]);
    assert.equal(byMember.has('shared'), false);
    assert.equal(byMember.get('IGNORELIST_Save'), 'IgnoreListVtable');
  });
});

describe('retypeVtableLocals', () => {
  const byMember = new Map([
    ['FUN_004503f0', 'TSHashTable_struct_SGAMEDATA_class_HASHKEY_NONE_Vtable'],
    ['LISTBOX_OnMouseUp', 'ListBoxImplementationVtable'],
  ]);

  it('rewrites the declaration in the body, not just the variable list', () => {
    const f = fn(
      'vtable *pListHead;\npListHead = (vtable *)(p + 2);\npListHead->FUN_004503f0 = 0;',
      { locals: [['pListHead', 'vtable *']] },
    );
    assert.equal(retypeVtableLocals([f], byMember), 1);
    assert.equal(f.localVariables[0].dataType,
      'TSHashTable_struct_SGAMEDATA_class_HASHKEY_NONE_Vtable *');
    assert.match(f.decompiled!,
      /TSHashTable_struct_SGAMEDATA_class_HASHKEY_NONE_Vtable \*pListHead;/);
    assert.doesNotMatch(f.decompiled!, /\bvtable\b/);
  });

  it('reads a member through a subscript too', () => {
    const f = fn(
      'vtable *pvVar2;\nif (n < (uint)&pvVar2[-1].LISTBOX_OnMouseUp) { }',
      { locals: [['pvVar2', 'vtable *']] },
    );
    assert.equal(retypeVtableLocals([f], byMember), 1);
    assert.equal(f.localVariables[0].dataType, 'ListBoxImplementationVtable *');
    assert.match(f.decompiled!, /ListBoxImplementationVtable \*pvVar2;/);
  });

  it('retypes a parameter, and keeps the pointer depth', () => {
    const f = fn('pp->FUN_004503f0 = 0;', { params: [['pp', 'vtable * *']] });
    assert.equal(retypeVtableLocals([f], byMember), 1);
    assert.equal(f.parameters[0].dataType,
      'TSHashTable_struct_SGAMEDATA_class_HASHKEY_NONE_Vtable **');
  });

  it('leaves a body that names two different vtables alone', () => {
    const f = fn(
      'vtable *p;\np->FUN_004503f0 = 0;\np->LISTBOX_OnMouseUp = 0;',
      { locals: [['p', 'vtable *']] },
    );
    assert.equal(retypeVtableLocals([f], byMember), 0);
    assert.equal(f.localVariables[0].dataType, 'vtable *');
    assert.match(f.decompiled!, /vtable \*p;/);
  });

  it('leaves a vtable variable nothing is read through alone', () => {
    const f = fn('vtable *pVt;\npVt = (vtable *)0;', { locals: [['pVt', 'vtable *']] });
    assert.equal(retypeVtableLocals([f], byMember), 0);
    assert.equal(f.localVariables[0].dataType, 'vtable *');
  });

  it('never touches a body that names no vtable at all', () => {
    const f = fn('p->FUN_004503f0 = 0;', { locals: [['p', 'D2UnitStrc *']] });
    assert.equal(retypeVtableLocals([f], byMember), 0);
    assert.equal(f.localVariables[0].dataType, 'D2UnitStrc *');
    assert.equal(f.decompiled, 'p->FUN_004503f0 = 0;');
  });

  it('leaves `vftable` and `_vfptr` untouched — only the bare word is a type', () => {
    const f = fn(
      'vtable *p;\np = (vtable *)Cls::vftable;\nq->_vfptr = p;\np->FUN_004503f0 = 0;',
      { locals: [['p', 'vtable *']] },
    );
    assert.equal(retypeVtableLocals([f], byMember), 1);
    assert.match(f.decompiled!, /Cls::vftable;/);
    assert.match(f.decompiled!, /q->_vfptr = p;/);
  });

  it('is a no-op the second time — nothing is spelled `vtable` any more', () => {
    const f = fn('vtable *p;\np->FUN_004503f0 = 0;', { locals: [['p', 'vtable *']] });
    assert.equal(retypeVtableLocals([f], byMember), 1);
    assert.equal(retypeVtableLocals([f], byMember), 0);
  });
});
