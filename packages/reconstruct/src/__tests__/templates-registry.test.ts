/**
 * The pieces under the template header: the RTTI demangler, the registry, the
 * spelling and substitution of template-ids, the layout agreement check, the
 * member placement, and how the rest of the emitter treats a registered scope.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';

import { TemplateRegistry, classKeyOf, demangleRttiClass, demangleRttiTemplate, setTemplateRegistry } from '../codegen/templates/registry.js';
import { parseTypeSpelling, rootQualifyTemplateArguments, spellType, substituteType } from '../codegen/templates/identity.js';
import { deriveFamilyLayouts, genericSpelling } from '../codegen/templates/layout.js';
import { placeTemplateMembers } from '../codegen/templates/placement.js';
import { baseComponentOf, baseComponentNamed, baseModel } from '../codegen/templates/bases.js';
import { memberModel, pointeeClass } from '../codegen/templates/members.js';
import { classScopedReference, memberCallModel, templateHeaderTypes } from '../codegen/templates/index.js';
import { flattenTemplateNames } from '../codegen/template-names.js';
import { NamespaceResolution } from '../codegen/namespace-resolution.js';
import { normalizeSignatureType } from '../codegen/platform-types.js';
import { emitDataValue, setGlobalInitializerTypes } from '../codegen/globals-header.js';
import type { TemplatesConfig } from '../config/schema.js';
import { loadProjectConfigFromFile } from '../config/loader.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtractedDataType, ExtractedFunction } from '../types.js';

const CONFIG: TemplatesConfig = {
  header: 'Storm/H/stpl.h',
  implPrefix: 'stpl_',
  families: {
    TSLink: { key: 'class', params: [{ name: 'T', kind: 'type' }] },
    TSExplicitList: { key: 'class', params: [{ name: 'T', kind: 'type' }, { name: 'OFFSET', kind: 'int' }] },
    TSHashObject: { key: 'class', params: [{ name: 'T', kind: 'type' }, { name: 'TKey', kind: 'type' }] },
    TSHashTable: { key: 'class', params: [{ name: 'T', kind: 'type' }, { name: 'TKey', kind: 'type' }] },
    TSHashTableReuse: { key: 'class', params: [{ name: 'T', kind: 'type' }, { name: 'TKey', kind: 'type' }, { name: 'N', kind: 'int' }], base: 'TSHashTable<T, TKey>' },
  },
  classes: { HASHKEY_NONE: { key: 'class' } },
};

afterEach(() => setTemplateRegistry(undefined));

const struct = (name: string, size: number, fields: Array<[string | null, string, number, number]>, category = '/'): ExtractedDataType =>
  ({ kind: 'STRUCTURE', name, category, size, fields: fields.map(([n, t, o, s]) => ({ name: n, dataType: t, offset: o, size: s })) }) as ExtractedDataType;

describe('RTTI demangling', () => {
  it('reads class and struct arguments, pointers, nested template-ids and integer values', () => {
    assert.deepStrictEqual(demangleRttiTemplate('.?AV?$TSExplicitList@UCELLIST@@$0?CCCCCCCD@@@'),
      { key: 'class', family: 'TSExplicitList', args: [{ kind: 'type', spelling: 'CELLIST', className: 'CELLIST', classKey: 'struct' }, { kind: 'value', spelling: '-572662307' }], spelling: 'TSExplicitList<CELLIST,-572662307>' });
    assert.strictEqual(demangleRttiTemplate('.?AV?$TSExportTableSimple@UCELLIST@@PAUHCELLIST__@@$0A@@@')?.spelling, 'TSExportTableSimple<CELLIST,HCELLIST__*,0>');
    assert.strictEqual(demangleRttiTemplate('.?AV?$X@V?$TSHashObjectChunk@UCELLIST@@VHASHKEY_NONE@@@@$0BA@@@')?.spelling, 'X<TSHashObjectChunk<CELLIST,HASHKEY_NONE>,16>');
    assert.strictEqual(demangleRttiTemplate('.?AUCELLIST@@'), undefined);
  });

  it('keeps the class key each argument records, through pointers and nested template-ids', () => {
    const d = demangleRttiTemplate('.?AV?$TSExportTableSync@USGAMEDATA@@PAUHSGAMEDATA__@@PAUHSGAMEDATALOCK__@@VCCritSect@@$0A@@@')!;
    assert.deepStrictEqual(d.args.map(a => [a.className, a.classKey]),
      [['SGAMEDATA', 'struct'], ['HSGAMEDATA__', 'struct'], ['HSGAMEDATALOCK__', 'struct'], ['CCritSect', 'class'], [undefined, undefined]]);
    // A pointer to a class (PAV) keeps `class`, as a pointer to a struct (PAU) keeps `struct`.
    assert.deepStrictEqual(demangleRttiTemplate('.?AV?$X@PAVCCritSect@@@@')!.args.map(a => [a.spelling, a.classKey]), [['CCritSect*', 'class']]);
    const nested = demangleRttiTemplate('.?AV?$X@V?$TSHashObjectChunk@UCELLIST@@VHASHKEY_NONE@@@@$0BA@@@')!.args[0];
    assert.deepStrictEqual([nested.className, nested.classKey], ['TSHashObjectChunk<CELLIST,HASHKEY_NONE>', 'class']);
    assert.deepStrictEqual(nested.nested?.map(a => [a.className, a.classKey]), [['CELLIST', 'struct'], ['HASHKEY_NONE', 'class']]);
    assert.deepStrictEqual(demangleRttiClass('.?AVCCritSect@@'), { key: 'class', name: 'CCritSect' });
    assert.strictEqual(demangleRttiClass('.?AV?$TSLink@UCELLIST@@@@'), undefined);
  });
});

describe('RTTI class keys of the arguments', () => {
  const SYNC: TemplatesConfig = {
    ...CONFIG,
    families: { ...CONFIG.families, TSExportTableSync: { key: 'class', params: [{ name: 'T', kind: 'type' }, { name: 'THandle', kind: 'type' }, { name: 'TLockedHandle', kind: 'type' }, { name: 'TSync', kind: 'type' }, { name: 'N', kind: 'int' }] } },
  };
  const sync = '.?AV?$TSExportTableSync@UCELLIST@@PAUHCELLIST__@@PAUHLOCKEDCELLIST__@@VCCritSect@@$0A@@@';
  const table = '.?AV?$TSHashTable@UCELLIST@@VHASHKEY_NONE@@@@';

  it('declares every argument class with the key its descriptors record', () => {
    const r = TemplateRegistry.build(SYNC, [], [sync, table, '.?AUCELLIST@@']);
    assert.strictEqual(r.classKey('CCritSect'), 'class');
    assert.strictEqual(r.classKey('CELLIST'), 'struct');
    assert.strictEqual(r.classKey('HCELLIST__'), 'struct');
    assert.strictEqual(r.classKey('HASHKEY_NONE'), 'class');
    assert.strictEqual(r.classKey('IgnoreList'), undefined);
    setTemplateRegistry(r);
    assert.strictEqual(classKeyOf('CCritSect'), 'class');
    assert.strictEqual(classKeyOf('D2UnitStrc'), 'struct');
  });

  it('refuses a key class whose project.json key disagrees with the descriptors', () => {
    assert.throws(() => TemplateRegistry.build({ ...SYNC, classes: { HASHKEY_NONE: { key: 'struct' } } }, [], [table]),
      /RTTI \.\?AV\?\$TSHashTable@UCELLIST@@VHASHKEY_NONE@@@@: HASHKEY_NONE is a class, project.json says struct/);
    // Its own descriptor counts too, even where no template names it.
    assert.throws(() => TemplateRegistry.build({ ...SYNC, classes: { HASHKEY_NONE: { key: 'struct' } } }, [], ['.?AVHASHKEY_NONE@@']),
      /HASHKEY_NONE is a class, project.json says struct/);
  });

  it('refuses a class two descriptors give different keys', () => {
    assert.throws(() => TemplateRegistry.build(SYNC, [], [sync, '.?AUCCritSect@@']),
      /RTTI \.\?AUCCritSect@@: CCritSect is a struct, RTTI .*TSExportTableSync.* says class/);
  });

  it('refuses a nested template-id argument whose key disagrees with its family', () => {
    assert.throws(() => TemplateRegistry.build(CONFIG, [], ['.?AV?$TSExplicitList@U?$TSHashTable@UCELLIST@@VHASHKEY_NONE@@@@$0BA@@@']),
      /TSHashTable is a struct, project.json says class/);
    assert.throws(() => TemplateRegistry.build(CONFIG, [], ['.?AV?$TSExplicitList@V?$TSHashTable@UCELLIST@@UHASHKEY_NONE@@@@$0BA@@@']),
      /HASHKEY_NONE is a struct, project.json says class/);
  });
});

describe('the registry', () => {
  it('registers an instantiation with its template-id arguments, in the tree spelling', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSExplicitList<CELLIST,-572662307>', 'TSHashTable<CELLIST,HASHKEY_NONE>', 'Other<int>']);
    assert.strictEqual(r.instantiation('TSExplicitList<CELLIST,-572662307>')?.spelling, 'TSExplicitList<CELLIST, -572662307>');
    assert.strictEqual(r.instantiation('TSExplicitList<CELLIST, -572662307>')?.element, 'CELLIST');
    assert.strictEqual(r.instantiation('Other<int>'), undefined);
    assert.ok(r.isTreeType('TSExplicitList<::CELLIST, -572662307> *'));
    assert.ok(!r.isTreeType('TSExplicitList<SGAMEDATA, -572662307> *'));
    assert.ok(r.isClassScope('HASHKEY_NONE'));
  });

  it('takes the element through a nested instantiation and registers the nested one too', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<TSExplicitList<CELLIST,-572662307>>']);
    assert.strictEqual(r.instantiation('TSLink<TSExplicitList<CELLIST,-572662307>>')?.element, 'CELLIST');
    assert.ok(r.instantiation('TSExplicitList<CELLIST, -572662307>'));
  });

  it('refuses an allowlist that leaves out an argument it needs, and a wrong argument kind', () => {
    assert.throws(() => TemplateRegistry.build({ ...CONFIG, instantiations: ['TSLink<TSExplicitList<CELLIST,-572662307>>'] },
      ['TSLink<TSExplicitList<CELLIST,-572662307>>']), /is not registered itself/);
    assert.throws(() => TemplateRegistry.build(CONFIG, ['TSExplicitList<CELLIST,SGAMEDATA>']), /is not an integer/);
  });

  it('checks every RTTI descriptor of a registered family against the model', () => {
    assert.doesNotThrow(() => TemplateRegistry.build(CONFIG, ['TSExplicitList<CELLIST,-572662307>'], ['.?AV?$TSExplicitList@UCELLIST@@$0?CCCCCCCD@@@']));
    assert.throws(() => TemplateRegistry.build({ ...CONFIG, families: { ...CONFIG.families, TSLink: { key: 'class', params: [{ name: 'T', kind: 'int' }] } } },
      [], ['.?AV?$TSLink@UCELLIST@@@@']), /argument 1 kind disagrees/);
  });

  it('marks the orphan copies Ghidra tags, in a registered class or an element, and no others', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>']);
    const orphan = [{ type: 'ORPHAN_COPY' }];
    r.findOrphans([
      { address: '1', name: 'NextLink_Unreferenced', namespace: 'TSLink<CELLIST>', tags: orphan },
      { address: '2', name: 'NextLink_Unreferenced2', namespace: 'TSLink<CELLIST>' },
      { address: '3', name: 'Destructor_Unreferenced', namespace: 'CELLIST', tags: [{ type: 'llm-typed' }, ...orphan] },
      { address: '4', name: 'NextLink', namespace: 'TSLink<CELLIST>', tags: [{ type: 'llm-typed' }] },
    ]);
    assert.deepStrictEqual(['1', '2', '3', '4'].map(a => r.isOrphan(a)), [true, false, true, false]);
  });

  it('refuses an orphan tag outside every registered class and element', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>']);
    assert.throws(() => r.findOrphans([{ address: '00500000', name: 'Foo', namespace: 'D2Common', tags: [{ type: 'ORPHAN_COPY' }] }]),
      /tagged ORPHAN_COPY outside every registered class and element: 00500000 D2Common::Foo/);
  });
});

describe('template-id spelling', () => {
  it('substitutes arguments for parameters, outermost first, through root qualifiers and member types', () => {
    const map = new Map([['CELLIST', 'T'], ['-572662307', 'OFFSET'], ['HASHKEY_NONE', 'TKey']]);
    const sub = (s: string) => spellType(substituteType(parseTypeSpelling(s)!, map));
    assert.strictEqual(sub('TSGrowableArray<TSExplicitList<::CELLIST, -572662307>>*'), 'TSGrowableArray<TSExplicitList<T, OFFSET>>*');
    assert.strictEqual(sub('TSHashTable<CELLIST, HASHKEY_NONE>::Vtable *'), 'TSHashTable<T, TKey>::Vtable*');
  });

  it('root-qualifies only the argument types a namespace shadows', () => {
    const shadowed = new Set(['CELLIST']);
    assert.strictEqual(rootQualifyTemplateArguments('TSHashTable<CELLIST, HASHKEY_NONE> *', shadowed), 'TSHashTable<::CELLIST, HASHKEY_NONE>*');
    assert.strictEqual(rootQualifyTemplateArguments('TSHashTable<SGAMEDATA, HASHKEY_NONE> *', shadowed), undefined);
    assert.strictEqual(rootQualifyTemplateArguments('CELLIST *', shadowed), undefined);
  });

  it('keeps a registered template-id in a signature, and still voids an unknown one', () => {
    setTemplateRegistry(TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>']));
    assert.strictEqual(normalizeSignatureType('TSLink<CELLIST> *'), 'TSLink<CELLIST> *');
    assert.strictEqual(normalizeSignatureType('Other<CELLIST> *'), 'void *');
  });

  it('respells registered names model-wide, the decompiler display form and the vtable included', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSHashTable<CELLIST,HASHKEY_NONE>', 'TSExplicitList<CELLIST,-572662307>']);
    const dataTypes = [
      struct('TSHashTable<CELLIST,HASHKEY_NONE>', 8, [['pVtable', 'TSHashTable_CELLIST_HASHKEY_NONE_Vtable *', 0, 4]]),
      struct('TSHashTable_CELLIST_HASHKEY_NONE_Vtable', 4, [['Destroy', 'pointer', 0, 4]], '/TSHashTable<CELLIST,HASHKEY_NONE>'),
      struct('Other<int>', 4, [['x', 'int', 0, 4]]),
    ];
    const fn = { name: 'F', namespace: 'TSHashTable<CELLIST,HASHKEY_NONE>', parameters: [], localVariables: [], returnType: 'void',
      decompiled: '{ TSExplicitList<CELLIST,_572662307> *p; TSExplicitList<CELLIST,-572662307>::UnlinkAll(p); Other<int> o; }' } as unknown as ExtractedFunction;
    flattenTemplateNames(dataTypes, [fn], [], r);
    assert.strictEqual(dataTypes[0].name, 'TSHashTable<CELLIST, HASHKEY_NONE>');
    assert.strictEqual((dataTypes[0] as any).fields[0].dataType, 'TSHashTable<CELLIST, HASHKEY_NONE>::Vtable *');
    assert.strictEqual(dataTypes[1].name, 'TSHashTable<CELLIST, HASHKEY_NONE>::Vtable');
    assert.strictEqual(dataTypes[2].name, 'Other_int_');
    assert.strictEqual(fn.namespace, 'TSHashTable<CELLIST, HASHKEY_NONE>');
    assert.strictEqual(fn.decompiled, '{ TSExplicitList<CELLIST, -572662307> *p; TSExplicitList<CELLIST, -572662307>::UnlinkAll(p); Other_int_ o; }');
  });
});

describe('the primary template layout', () => {
  const insts = ['TSHashObject<CELLIST,HASHKEY_NONE>', 'TSHashObject<STRINGNODE,HASHKEY_STRI>'];

  it('is derived when the instantiations agree, without Ghidra filler', () => {
    const r = TemplateRegistry.build(CONFIG, insts);
    const types = [
      struct('TSHashObject<CELLIST, HASHKEY_NONE>', 24, [['m_hashval', 'uint32_t', 0, 4], ['m_link', 'TSLink<CELLIST>', 4, 8], ['m_key', 'HASHKEY_NONE', 20, 1], [null, 'undefined', 21, 1]]),
      struct('TSHashObject<STRINGNODE, HASHKEY_STRI>', 24, [['m_hashval', 'uint32_t', 0, 4], ['m_link', 'TSLink<STRINGNODE>', 4, 8], ['m_key', 'HASHKEY_STRI', 20, 4]]),
    ];
    const layout = deriveFamilyLayouts(r, types).get('TSHashObject')!;
    assert.deepStrictEqual(layout.fields.map(f => `${f.name}:${f.dataType}`), ['m_hashval:uint32_t', 'm_link:TSLink<T>', 'm_key:TKey']);
  });

  it('refuses to pick one instantiation when they disagree', () => {
    const r = TemplateRegistry.build(CONFIG, insts);
    const types = [
      struct('TSHashObject<CELLIST, HASHKEY_NONE>', 8, [['m_hashval', 'uint32_t', 0, 4], ['m_link', 'TSLink<CELLIST>', 4, 8]]),
      struct('TSHashObject<STRINGNODE, HASHKEY_STRI>', 8, [['m_hashval', 'uint32_t', 0, 4], ['tLink', 'TSLink<STRINGNODE>', 4, 8]]),
    ];
    assert.throws(() => deriveFamilyLayouts(r, types), /disagree on its layout[\s\S]*tLink/);
  });

  it('checks the first member against the base project.json gives', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSHashTableReuse<CELLIST,HASHKEY_NONE,0>']);
    const types = [struct('TSHashTableReuse<CELLIST, HASHKEY_NONE, 0>', 4, [['super_TSHashTable', 'TSHashTable<CELLIST,HASHKEY_NONE>', 0, 4]])];
    assert.doesNotThrow(() => deriveFamilyLayouts(r, types));
    const wrong = [struct('TSHashTableReuse<CELLIST, HASHKEY_NONE, 0>', 4, [['first', 'int', 0, 4]])];
    assert.throws(() => deriveFamilyLayouts(r, wrong), /gives the base TSHashTable<T, TKey>/);
    // The base's type in a member Ghidra did not model as the base component.
    const unnamed = [struct('TSHashTableReuse<CELLIST, HASHKEY_NONE, 0>', 4, [['m_table', 'TSHashTable<CELLIST,HASHKEY_NONE>', 0, 4]])];
    assert.throws(() => deriveFamilyLayouts(r, unnamed), /gives the base TSHashTable<T, TKey>, the first member is m_table@0/);
  });

  it('refuses a base Ghidra models that project.json does not register', () => {
    const config = { ...CONFIG, families: { ...CONFIG.families, TSHashTableReuse: { ...CONFIG.families.TSHashTableReuse, base: undefined } } };
    const r = TemplateRegistry.build(config, ['TSHashTableReuse<CELLIST,HASHKEY_NONE,0>']);
    const types = [struct('TSHashTableReuse<CELLIST, HASHKEY_NONE, 0>', 4, [['super_TSHashTable', 'TSHashTable<CELLIST,HASHKEY_NONE>', 0, 4]])];
    assert.throws(() => deriveFamilyLayouts(r, types), /TSHashTableReuse: Ghidra models the base TSHashTable<T, TKey> \(super_TSHashTable\), project.json registers none/);
  });

  it('spells a value argument over its parameter', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSHashTableReuse<CELLIST,HASHKEY_NONE,0>']);
    assert.strictEqual(genericSpelling('TSHashTableReuse<CELLIST, HASHKEY_NONE, 0> *', r.instantiation('TSHashTableReuse<CELLIST,HASHKEY_NONE,0>')!), 'TSHashTableReuse<T, TKey, N>*');
  });
});

describe('placement and scope', () => {
  const MODULES = { D2CMP: { namespaces: ['D2CMP'] }, D2Common: { namespaces: ['D2Common'] }, D2Client: { namespaces: ['D2Client'] } };
  const fn = (address: string, namespace: string) => ({ address, namespace, name: 'f' }) as ExtractedFunction;

  it('defines a member beside the module function below it, per element', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>', 'TSLink<SGAMEDATA>']);
    const placed = placeTemplateMembers(r, [
      fn('00601000', 'D2CMP::SRC::CelCmp'), fn('00601100', 'CELLIST'), fn('00601200', 'TSLink<CELLIST>'),
      fn('00450000', 'D2Client::GAME::Game'), fn('00450100', 'TSLink<SGAMEDATA>'),
    ], MODULES, [{ module: 'D2Client', start: '00440000', end: '00460000' }, { module: 'D2CMP', start: '005fde10', end: '0060dc70' }]);
    assert.strictEqual(placed.get('00601200'), 'D2CMP::SRC::stpl_CELLIST');
    assert.strictEqual(placed.get('00450100'), 'D2Client::GAME::stpl_SGAMEDATA');
  });

  it('never looks below the start of the member\'s own module run', () => {
    // D2CMP ends where D2Common starts; the key class's members open the D2Common run.
    const r = TemplateRegistry.build({ ...CONFIG, classes: { HASHKEY_STRI: { key: 'class' } } }, ['TSLink<StringEntryNode>']);
    const runs = [{ module: 'D2CMP', start: '005fde10', end: '0060dc70' }, { module: 'D2Common', start: '0060dc70', end: '00681f6a' }];
    const placed = placeTemplateMembers(r, [
      fn('0060db60', 'D2CMP::SRC::CelCmp'),
      fn('0060dc70', 'HASHKEY_STRI'), fn('0060dd00', 'HASHKEY_STRI'),
      fn('0060dd50', 'ChatIgnoreList'),
      fn('0060ddb0', 'D2Common::Chat::Ignorelist'),
      fn('0060e130', 'HASHKEY_STRI'), fn('0060e170', 'TSLink<StringEntryNode>'),
    ], MODULES, runs);
    // Nothing of D2Common below them in their run: beside the D2Common code above them,
    // the object their COMDATs were linked ahead of - one unit with 0060e130.
    assert.strictEqual(placed.get('0060dc70'), 'D2Common::Chat::stpl_HASHKEY_STRI');
    assert.strictEqual(placed.get('0060dd00'), 'D2Common::Chat::stpl_HASHKEY_STRI');
    assert.strictEqual(placed.get('0060e130'), 'D2Common::Chat::stpl_HASHKEY_STRI');
    assert.strictEqual(placed.get('0060e170'), 'D2Common::Chat::stpl_StringEntryNode');
  });

  it('places an element\'s orphan copy with the members, and passes over the element\'s own code', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>']);
    const functions = [
      fn('00601000', 'D2CMP::SRC::CelCmp'), fn('00601100', 'CELLIST'),
      { ...fn('00601200', 'CELLIST'), name: 'Destructor_Unreferenced', tags: [{ type: 'ORPHAN_COPY' }] } as ExtractedFunction,
    ];
    r.findOrphans(functions);
    const placed = placeTemplateMembers(r, functions, MODULES, [{ module: 'D2CMP', start: '00600000', end: '00610000' }]);
    assert.strictEqual(placed.get('00601200'), 'D2CMP::SRC::stpl_CELLIST');
    assert.strictEqual(placed.get('00601100'), undefined);
  });

  it('knows an element class nested under its module by the class name', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>']);
    const functions = [
      fn('00601000', 'D2CMP::SRC::CelCmp'),
      { ...fn('00601200', 'D2CMP::SRC::CelCmp::CELLIST'), name: 'Destructor_Unreferenced', tags: [{ type: 'ORPHAN_COPY' }] } as ExtractedFunction,
    ];
    r.findOrphans(functions);
    assert.strictEqual(r.isOrphan('00601200'), true);
    const placed = placeTemplateMembers(r, functions, MODULES, [{ module: 'D2CMP', start: '00600000', end: '00610000' }]);
    assert.strictEqual(placed.get('00601200'), 'D2CMP::SRC::stpl_CELLIST');
  });

  it('places a run with no module function at all in the module directory', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>']);
    const placed = placeTemplateMembers(r, [fn('00601200', 'TSLink<CELLIST>'), fn('00601300', 'TSLink<CELLIST>')],
      MODULES, [{ module: 'D2CMP', start: '00600000', end: '00610000' }]);
    assert.strictEqual(placed.get('00601200'), 'D2CMP::stpl_CELLIST');
    assert.strictEqual(placed.get('00601300'), 'D2CMP::stpl_CELLIST');
  });

  it('refuses a member in the run of a module the project does not configure', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>']);
    assert.throws(() => placeTemplateMembers(r, [fn('00601200', 'TSLink<CELLIST>')], MODULES,
      [{ module: 'D2gfx', start: '00600000', end: '00610000' }]), /00601200 .* D2gfx run, a module project.json does not configure/);
  });

  it('passes over a function homed in another module than its run\'s', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>']);
    const placed = placeTemplateMembers(r, [
      fn('00601000', 'D2CMP::SRC::CelCmp'), fn('00601100', 'D2Common::Misfiled'), fn('00601200', 'TSLink<CELLIST>'),
    ], MODULES, [{ module: 'd2cmp', start: '00600000', end: '00610000' }]);
    assert.strictEqual(placed.get('00601200'), 'D2CMP::SRC::stpl_CELLIST');
  });

  it('refuses a member that lies in no module run', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>']);
    assert.throws(() => placeTemplateMembers(r, [fn('00601200', 'TSLink<CELLIST>')], MODULES, []), /00601200 .* lies in no module run/);
  });

  it('resolves a registered scope to the class, not to a namespace, and an orphan to root', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>']);
    r.findOrphans([{ address: '2', name: 'NextLink_Unreferenced', namespace: 'TSLink<CELLIST>', tags: [{ type: 'ORPHAN_COPY' }] }]);
    setTemplateRegistry(r);
    const res = new NamespaceResolution(new Set(['TSLink<CELLIST>', 'IgnoreList']));
    assert.deepStrictEqual(res.claim('1', 'TSLink<CELLIST>'), { ghidraSegments: ['TSLink<CELLIST>'], segments: ['TSLink<CELLIST>'], classScope: true });
    assert.deepStrictEqual(res.claim('2', 'TSLink<CELLIST>').segments, []);
    assert.deepStrictEqual(res.claim('3', 'IgnoreList').segments, ['Class', 'IgnoreList']);
    assert.strictEqual(classScopedReference('TSLink<CELLIST>::NextLink'), 'TSLink<CELLIST>::NextLink');
    assert.strictEqual(classScopedReference('D2Common::Fn'), undefined);
  });

  it('owns each instantiation, its vtable and slot types and the key classes in the template header', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>']);
    const owned = templateHeaderTypes(r, [
      struct('TSLink<CELLIST>', 8, []), struct('TSLink<CELLIST>::Vtable', 4, [], '/TSLink<CELLIST>'),
      { kind: 'FUNCTION_DEFINITION', name: 'TSLink_CELLIST__Destroy', category: '/TSLink<CELLIST>' } as ExtractedDataType,
      struct('CELLIST', 4, []),
    ]);
    assert.deepStrictEqual([...owned].sort(), ['HASHKEY_NONE', 'TSLink<CELLIST>', 'TSLink<CELLIST>::Vtable', 'TSLink_CELLIST__Destroy']);
  });
});

describe('data initializers', () => {
  it('leaves Ghidra filler out of an instantiation the template lays out itself, and refuses it non-zero', () => {
    setTemplateRegistry(TemplateRegistry.build(CONFIG, ['TSHashObject<CELLIST,HASHKEY_NONE>']));
    setGlobalInitializerTypes([
      struct('TSHashObject<CELLIST, HASHKEY_NONE>', 8, [['m_hashval', 'uint32_t', 0, 4], ['m_key', 'HASHKEY_NONE', 4, 1], [null, 'undefined', 5, 1]]),
    ]);
    const value = (pad: string) => ({ kind: 'struct' as const, fields: [
      { name: 'm_hashval', value: { kind: 'scalar' as const, value: '7' } },
      { name: 'm_key', value: { kind: 'struct' as const, fields: [{ name: 'field0_0x0', value: { kind: 'scalar' as const, value: '0' } }] } },
      { name: 'field2_0x5', value: { kind: 'scalar' as const, value: pad } },
    ] });
    const out = emitDataValue(value('0'), 0, 'TSHashObject<CELLIST, HASHKEY_NONE>');
    assert.doesNotMatch(out, /field2_0x5/);
    assert.match(out, /\.m_key/);
    assert.throws(() => emitDataValue(value('3'), 0, 'TSHashObject<CELLIST, HASHKEY_NONE>'), /initialized non-zero/);
    setGlobalInitializerTypes([]);
  });
});

describe('project.json templates', () => {
  async function load(templates: unknown, moduleRuns?: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'tmplcfg-'));
    try {
      const file = join(dir, 'project.json');
      writeFileSync(file, JSON.stringify({ version: 1, project: 't', templates, moduleRuns }));
      return await loadProjectConfigFromFile(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('is read as written', async () => {
    assert.deepStrictEqual((await load(CONFIG))?.templates, CONFIG);
  });

  it('refuses a family without a class key, a parameter without a kind, and orphan patterns', async () => {
    await assert.rejects(load({ header: 'h', families: { A: { params: [{ name: 'T', kind: 'type' }] } } }), /families.A.key/);
    await assert.rejects(load({ header: 'h', families: { A: { key: 'class', params: [{ name: 'T' }] } } }), /a kind "type" or "int"/);
    await assert.rejects(load({ header: 'h', families: {}, orphans: ['*_Unreferenced'] }), /templates.orphans is not read: Ghidra tags each orphan copy ORPHAN_COPY/);
    await assert.rejects(load({ families: {} }), /templates.header/);
    await assert.rejects(load({ header: 'h', families: {}, classes: ['KEY'] }), /templates.classes must be an object/);
    await assert.rejects(load({ header: 'h', families: {}, classes: { KEY: {} } }), /templates.classes.KEY.key/);
  });

  it('reads module runs, and refuses a run without a module, an empty run and overlapping runs', async () => {
    const runs = [{ module: 'D2CMP', start: '005fde10', end: '0060dc70' }, { module: 'D2Common', start: '0060dc70', end: '00681f6a' }];
    assert.deepStrictEqual((await load(CONFIG, runs))?.moduleRuns, runs);
    await assert.rejects(load(CONFIG, [{ start: '1', end: '2' }]), /moduleRuns\[0\] needs a "module"/);
    await assert.rejects(load(CONFIG, [{ module: 'A', start: '2', end: '2' }]), /moduleRuns\[0\] ends before it starts/);
    await assert.rejects(load(CONFIG, [{ module: 'A', start: '10', end: '20' }, { module: 'B', start: '1f', end: '30' }]), /moduleRuns\[1\] overlaps moduleRuns\[0\]/);
  });
});

describe('base classes', () => {
  const insts = ['TSHashTableReuse<CELLIST,HASHKEY_NONE,0>', 'TSHashTable<CELLIST,HASHKEY_NONE>', 'TSHashObject<CELLIST,HASHKEY_NONE>'];
  const model = () => [
    struct('CELLIST', 0x20, [['super_TSHashObject', 'TSHashObject<CELLIST,HASHKEY_NONE>', 0, 0x18], ['dwFlags', 'uint32_t', 0x18, 4]]),
    struct('TSHashObject<CELLIST,HASHKEY_NONE>', 0x18, [['m_hashval', 'uint32_t', 0, 4], ['m_key', 'HASHKEY_NONE', 0x14, 1]]),
    struct('TSHashTable<CELLIST,HASHKEY_NONE>', 8, [['pVtable', 'void *', 0, 4], ['nSlotMask', 'uint32_t', 4, 4]]),
    struct('TSHashTableReuse<CELLIST,HASHKEY_NONE,0>', 12, [['super_TSHashTable', 'TSHashTable<CELLIST,HASHKEY_NONE>', 0, 8], ['nChunkSize', 'uint32_t', 8, 4]]),
    // A component that only looks like a base: an unregistered family.
    struct('OTHER', 8, [['super_Unregistered', 'Unregistered<int>', 0, 8]]),
  ];

  it('takes the first member, at offset 0, named for a registered family and typed as it, as the base', () => {
    const r = TemplateRegistry.build(CONFIG, insts);
    const [cellist, , , reuse, other] = model() as unknown as Array<{ fields: never[] }>;
    assert.strictEqual(baseComponentOf(r, cellist.fields)?.type, 'TSHashObject<CELLIST,HASHKEY_NONE>');
    assert.strictEqual(baseComponentOf(r, reuse.fields)?.family.name, 'TSHashTable');
    assert.strictEqual(baseComponentOf(r, other.fields), undefined);
    const f = (name: string, dataType: string, offset: number) => [{ name, dataType, offset, size: 4 }] as never;
    assert.strictEqual(baseComponentOf(r, f('super_TSHashTable', 'TSHashObject<CELLIST,HASHKEY_NONE>', 0)), undefined);
    assert.strictEqual(baseComponentOf(r, f('super_TSHashTable', 'TSHashTable<CELLIST,HASHKEY_NONE>', 4)), undefined);
  });

  it('applies the one base rule to whatever names the bases', () => {
    const fields = [{ name: 'super_TSHashTable', dataType: 'TSHashTable<CELLIST,HASHKEY_NONE>', offset: 0 }, { name: 'n', dataType: 'int', offset: 0x28 }];
    assert.strictEqual(baseComponentNamed(fields, n => (n === 'TSHashTable' ? 1 : undefined))?.field, fields[0]);
    assert.strictEqual(baseComponentNamed(fields, () => undefined), undefined);
    // Leading filler is skipped; a component away from offset 0 is no base.
    assert.ok(baseComponentNamed([{ dataType: 'undefined', offset: 0 }, { ...fields[0] }], () => 1));
    assert.strictEqual(baseComponentNamed([{ ...fields[0], offset: 4 }], () => 1), undefined);
  });

  it('lists every base component, every class with its direct base in the tree\'s spelling, and the members a derived class hides', () => {
    const r = TemplateRegistry.build(CONFIG, insts);
    const m = baseModel(r, model(), [
      { name: 'Destructor', namespace: 'TSHashTable<CELLIST,HASHKEY_NONE>' },
      { name: 'Destructor', namespace: 'TSHashTableReuse<CELLIST,HASHKEY_NONE,0>' },
      { name: 'Constructor', namespace: 'TSHashTableReuse<CELLIST,HASHKEY_NONE,0>' },
    ]);
    assert.deepStrictEqual(m.componentNames, ['super_TSHashObject', 'super_TSHashTable']);
    assert.deepStrictEqual(m.bases, [
      ['CELLIST', 'TSHashObject<CELLIST, HASHKEY_NONE>'],
      ['TSHashTableReuse<CELLIST, HASHKEY_NONE, 0>', 'TSHashTable<CELLIST, HASHKEY_NONE>'],
    ]);
    assert.deepStrictEqual(m.hiddenMembers, ['Destructor']);
  });

  it('refuses a component named as a base that is not the struct\'s base', () => {
    const r = TemplateRegistry.build(CONFIG, insts);
    const misplaced = [...model(), struct('HOLDER', 0x1c, [['nCount', 'int', 0, 4], ['super_TSHashObject', 'TSHashObject<CELLIST,HASHKEY_NONE>', 4, 0x18]])];
    assert.throws(() => baseModel(r, misplaced, []), /HOLDER\.super_TSHashObject \(\+0x4, TSHashObject<CELLIST,HASHKEY_NONE>\) is named as a base/);
  });

  it('counts what an element\'s own namespace and a whole family declare, but not an orphan copy', () => {
    const r = TemplateRegistry.build(CONFIG, [...insts, 'TSHashTable<OTHER,HASHKEY_NONE>']);
    r.findOrphans([{ address: '00400010', name: 'Release_Unreferenced', namespace: 'CELLIST', tags: [{ type: 'ORPHAN_COPY' }] }]);
    const m = baseModel(r, model(), [
      // The element's namespace is its class scope: its Destructor hides the base's.
      { name: 'Destructor', namespace: 'CELLIST', address: '00400000' },
      { name: 'Destructor', namespace: 'TSHashObject<CELLIST,HASHKEY_NONE>', address: '00400020' },
      { name: 'Release_Unreferenced', namespace: 'CELLIST', address: '00400010' },
      // Declared by the primary template for every instantiation, this one included.
      { name: 'Grow', namespace: 'TSHashTable<OTHER,HASHKEY_NONE>', address: '00400030' },
      { name: 'Grow', namespace: 'TSHashTableReuse<CELLIST,HASHKEY_NONE,0>', address: '00400040' },
    ]);
    assert.deepStrictEqual(m.hiddenMembers, ['Destructor', 'Grow']);
    assert.deepStrictEqual(m.declaredNames['CELLIST'], ['Destructor', 'dwFlags']);
    assert.deepStrictEqual(m.declaredNames['TSHashTable<CELLIST, HASHKEY_NONE>'], ['Grow', 'nSlotMask', 'pVtable']);
    assert.deepStrictEqual(m.declaredNames['TSHashTableReuse<CELLIST, HASHKEY_NONE, 0>'], ['Grow', 'nChunkSize']);
  });

  it('refuses a derived class that declares a data member of its base again', () => {
    const r = TemplateRegistry.build(CONFIG, insts);
    const types = model();
    (types[0] as unknown as { fields: unknown[] }).fields.push({ name: 'm_hashval', dataType: 'uint32_t', offset: 0x1c, size: 4 });
    assert.throws(() => baseModel(r, types, []), /CELLIST declares m_hashval, which hides the data member of its base TSHashObject<CELLIST, HASHKEY_NONE>/);
  });
});

describe('member functions', () => {
  const insts = ['TSExplicitList<CELLIST,-572662307>', 'TSExplicitList<OTHER,-572662307>', 'TSHashTable<CELLIST,HASHKEY_NONE>'];
  const fn = (address: string, ns: string, name: string, receiver: string | null, extra: object = {}): ExtractedFunction => ({
    address, name, namespace: ns, returnType: 'void', callingConvention: receiver ? '__thiscall' : '__stdcall',
    parameters: receiver ? [{ name: 'this', dataType: receiver, ordinal: 0 }] : [{ name: 'nValue', dataType: 'uint32_t', ordinal: 0 }],
    ...extra,
  }) as unknown as ExtractedFunction;
  const build = () => {
    const r = TemplateRegistry.build(CONFIG, insts);
    setTemplateRegistry(r);
    r.findOrphans([{ address: '00401050', name: 'Link_Unreferenced', namespace: 'TSExplicitList<CELLIST,-572662307>', tags: [{ type: 'ORPHAN_COPY' }] }]);
    return r;
  };
  const functions = [
    fn('00401000', 'TSExplicitList<CELLIST,-572662307>', 'UnlinkAll', 'TSExplicitList<CELLIST,-572662307> *'),
    fn('00401010', 'TSExplicitList<OTHER,-572662307>', 'UnlinkAll', 'TSExplicitList<OTHER,-572662307> *'),
    fn('00401020', 'TSHashTable<CELLIST,HASHKEY_NONE>', 'InternalDelete', 'TSHashTable<CELLIST,HASHKEY_NONE> *'),
    fn('00401030', 'TSHashTable<CELLIST,HASHKEY_NONE>', 'Ptr', 'TSHashTable<CELLIST,HASHKEY_NONE> *'),
    fn('00401040', 'TSExplicitList<CELLIST,-572662307>', 'RoundToMultiple', null),
    fn('00401050', 'TSExplicitList<CELLIST,-572662307>', 'Link_Unreferenced', 'TSExplicitList<CELLIST,-572662307> *'),
    fn('00401060', 'HASHKEY_NONE', 'Equals', 'HASHKEY_NONE *'),
    // An element's own function is no registered member.
    fn('00401070', 'CELLIST', 'Destructor', 'CELLIST *'),
  ];
  // The vtable holds InternalDelete's address as a plain pointer.
  const globals = [{ initializedData: { kind: 'array' as const, elements: [{ kind: 'pointer' as const, value: 'TSHashTable<CELLIST,HASHKEY_NONE>::InternalDelete' }] } }];

  it('makes a member with a receiver non-static, unless the program holds its address or it has no receiver', () => {
    const m = memberModel(build(), functions, globals);
    assert.deepStrictEqual([...m.instanceAddresses].sort(), ['00401000', '00401010', '00401030', '00401060']);
    assert.deepStrictEqual(m.instanceMembers, {
      'TSExplicitList<CELLIST, -572662307>': ['UnlinkAll'],
      'TSExplicitList<OTHER, -572662307>': ['UnlinkAll'],
      'TSHashTable<CELLIST, HASHKEY_NONE>': ['Ptr'],
      HASHKEY_NONE: ['Equals'],
    });
  });

  it('decides per member name of a family: a held address keeps every instantiation\'s static', () => {
    const held = [{ initializedData: { kind: 'pointer' as const, value: 'TSExplicitList<OTHER,-572662307>::UnlinkAll' } }];
    const m = memberModel(build(), functions, held);
    assert.ok(!m.instanceAddresses.has('00401000') && !m.instanceAddresses.has('00401010'));
    assert.ok(m.instanceAddresses.has('00401020'));
  });

  it('finds a held address in a struct initializer\'s fields, at any depth', () => {
    const inStruct = [{ initializedData: { kind: 'struct' as const, fields: [
      { name: 'nCount', value: { kind: 'scalar' as const, value: '0' } },
      { name: 'tVtable', value: { kind: 'struct' as const, fields: [
        { name: 'pfnPtr', value: { kind: 'pointer' as const, value: 'TSHashTable<CELLIST,HASHKEY_NONE>::Ptr' } },
      ] } },
    ] } }];
    const m = memberModel(build(), functions, inStruct);
    assert.ok(!m.instanceAddresses.has('00401030'));
    assert.ok(m.instanceAddresses.has('00401000'));
  });

  it('reads a receiver\'s class from a pointer spelling only', () => {
    assert.strictEqual(pointeeClass('TSHashTable<::CELLIST, HASHKEY_NONE> *'), 'TSHashTable<CELLIST, HASHKEY_NONE>');
    assert.strictEqual(pointeeClass('TSHashTable<CELLIST,HASHKEY_NONE>'), undefined);
    const byValue = [...functions, fn('004010a0', 'TSHashTable<CELLIST,HASHKEY_NONE>', 'Next', 'TSHashTable<CELLIST,HASHKEY_NONE>')];
    assert.throws(() => memberModel(build(), byValue, globals), /004010a0 TSHashTable<CELLIST, HASHKEY_NONE>::Next: its receiver is TSHashTable<CELLIST,HASHKEY_NONE>, not a pointer to TSHashTable<CELLIST, HASHKEY_NONE>/);
  });

  it('answers member calls from the registry in force, also after it is replaced', () => {
    const first = build();
    first.setMembers(memberModel(first, functions, globals));
    const hash = 'TSHashTable<CELLIST, HASHKEY_NONE>';
    assert.ok(memberCallModel()!.isInstanceMember(hash, 'Ptr'));
    // A second run in the same process (the resident daemon): Ptr's address is now held.
    const second = build();
    second.setMembers(memberModel(second, functions, [{ initializedData: { kind: 'pointer' as const, value: 'TSHashTable<CELLIST,HASHKEY_NONE>::Ptr' } }]));
    assert.ok(!memberCallModel()!.isInstanceMember(hash, 'Ptr'));
    assert.ok(memberCallModel()!.isInstanceMember('TSExplicitList<CELLIST, -572662307>', 'UnlinkAll'));
  });

  it('refuses a family whose instantiations disagree on the receiver, and a receiver of another class', () => {
    const mixed = [...functions, fn('00401080', 'TSExplicitList<OTHER,-572662307>', 'RoundToMultiple', 'TSExplicitList<OTHER,-572662307> *')];
    assert.throws(() => memberModel(build(), mixed, globals), /TSExplicitList::RoundToMultiple: some instantiations have a receiver and some have none/);
    const stray = [...functions, fn('00401090', 'TSHashTable<CELLIST,HASHKEY_NONE>', 'Next', 'CELLIST *')];
    assert.throws(() => memberModel(build(), stray, globals), /00401090 TSHashTable<CELLIST, HASHKEY_NONE>::Next: its receiver is CELLIST \*, not a pointer to TSHashTable<CELLIST, HASHKEY_NONE>/);
  });
});
