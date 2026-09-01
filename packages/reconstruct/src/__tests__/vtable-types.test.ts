/**
 * Per-class vtable disambiguation — 35 Ghidra STRUCTUREs all named `vtable`,
 * separated only by category, must not collapse onto one name.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { disambiguateVtableTypes } from '../modules/vtable-types.js';
import type { ExtractedDataType, ExtractedStruct } from '../types.js';

function vtable(category: string, fields: Array<[string, string]>): ExtractedStruct {
  return {
    name: 'vtable',
    kind: 'STRUCTURE',
    category,
    size: fields.length * 4,
    fields: fields.map(([name, dataType], i) => ({ name, dataType, offset: i * 4, size: 4 })),
  } as unknown as ExtractedStruct;
}

function owner(name: string, fieldType: string): ExtractedStruct {
  return {
    name,
    kind: 'STRUCTURE',
    category: '/',
    size: 4,
    fields: [{ name: 'pVtable', dataType: fieldType, offset: 0, size: 4 }],
  } as unknown as ExtractedStruct;
}

describe('disambiguateVtableTypes', () => {
  it('names each vtable after the class that owns it and repoints the field', () => {
    const types: ExtractedDataType[] = [
      vtable('/ButtonImplementation', [['BUTTON_Draw', 'void *']]),
      vtable('/ListBoxImplementation', [['LISTBOX_Draw', 'void *']]),
      owner('ButtonImplementation', 'vtable *'),
      owner('ListBoxImplementation', 'vtable *'),
    ];

    const result = disambiguateVtableTypes(types);

    assert.equal(result.renamed, 2);
    assert.deepEqual(types.map(t => t.name), [
      'ButtonImplementationVtable',
      'ListBoxImplementationVtable',
      'ButtonImplementation',
      'ListBoxImplementation',
    ]);
    assert.equal((types[2] as ExtractedStruct).fields![0].dataType, 'ButtonImplementationVtable *');
    assert.equal((types[3] as ExtractedStruct).fields![0].dataType, 'ListBoxImplementationVtable *');
    assert.equal(result.fieldsRepointed, 2);
  });

  it('survives dedup-by-name: the renamed types no longer share a name', () => {
    const types: ExtractedDataType[] = [
      vtable('/IgnoreList', [['IGNORELIST_AddByPattern', 'void *']]),
      vtable('/ChatIgnoreList', [['IGNORELIST_AddByPattern', 'void *']]),
    ];
    disambiguateVtableTypes(types);
    assert.equal(new Set(types.map(t => t.name)).size, 2);
  });

  it('maps a member name to its vtable only when one vtable declares it', () => {
    const types: ExtractedDataType[] = [
      vtable('/IgnoreList', [['IGNORELIST_AddByPattern', 'void *'], ['shared', 'void *']]),
      vtable('/WardenClient', [['WARDEN_Run', 'void *'], ['shared', 'void *']]),
    ];
    const result = disambiguateVtableTypes(types);
    assert.equal(result.byMember.get('IGNORELIST_AddByPattern'), 'IgnoreListVtable');
    assert.equal(result.byMember.get('WARDEN_Run'), 'WardenClientVtable');
    assert.equal(result.byMember.has('shared'), false);
  });

  it('names a template instantiation\'s vtable too, under the flattened spelling', () => {
    // The tree already carries these classes flattened, and their bodies index
    // the vtable by member — leaving them all called `vtable` collapsed thirty-odd
    // distinct layouts onto one and stranded every member.
    const types: ExtractedDataType[] = [
      vtable('/TSHashTable<struct_CELLIST,class_HASHKEY_NONE>', [['FUN_006036d0', 'void *']]),
      owner('TSHashTable<struct_CELLIST,class_HASHKEY_NONE>', 'vtable *'),
    ];
    const result = disambiguateVtableTypes(types);

    assert.equal(result.renamed, 1);
    assert.equal(types[0].name, 'TSHashTable_struct_CELLIST_class_HASHKEY_NONE_Vtable');
    assert.equal(
      (types[1] as ExtractedStruct).fields![0].dataType,
      'TSHashTable_struct_CELLIST_class_HASHKEY_NONE_Vtable *',
    );
    assert.equal(result.byMember.get('FUN_006036d0'),
      'TSHashTable_struct_CELLIST_class_HASHKEY_NONE_Vtable');
  });

  it('keeps Ghidra pointer entries apart too', () => {
    const types: ExtractedDataType[] = [
      vtable('/IgnoreList', [['IGNORELIST_AddByPattern', 'void *']]),
      { name: 'vtable *', kind: 'POINTER', category: '/IgnoreList', size: 4 } as ExtractedDataType,
      { name: 'vtable * *', kind: 'POINTER', category: '/IgnoreList', size: 4 } as ExtractedDataType,
    ];
    disambiguateVtableTypes(types);
    assert.equal(types[1].name, 'IgnoreListVtable *');
    assert.equal(types[2].name, 'IgnoreListVtable * *');
  });
});
