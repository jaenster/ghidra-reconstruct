/**
 * The pieces under the template header: the RTTI demangler, the registry, the
 * spelling and substitution of template-ids, the layout agreement check, the
 * member placement, and how the rest of the emitter treats a registered scope.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';

import { TemplateRegistry, demangleRttiTemplate, setTemplateRegistry } from '../codegen/templates/registry.js';
import { parseTypeSpelling, rootQualifyTemplateArguments, spellType, substituteType } from '../codegen/templates/identity.js';
import { deriveFamilyLayouts, genericSpelling } from '../codegen/templates/layout.js';
import { placeTemplateMembers } from '../codegen/templates/placement.js';
import { classScopedReference, templateHeaderTypes } from '../codegen/templates/index.js';
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
  classes: ['HASHKEY_NONE'],
  orphans: ['*_Unreferenced'],
};

afterEach(() => setTemplateRegistry(undefined));

const struct = (name: string, size: number, fields: Array<[string | null, string, number, number]>, category = '/'): ExtractedDataType =>
  ({ kind: 'STRUCTURE', name, category, size, fields: fields.map(([n, t, o, s]) => ({ name: n, dataType: t, offset: o, size: s })) }) as ExtractedDataType;

describe('RTTI demangling', () => {
  it('reads class and struct arguments, pointers, nested template-ids and integer values', () => {
    assert.deepStrictEqual(demangleRttiTemplate('.?AV?$TSExplicitList@UCELLIST@@$0?CCCCCCCD@@@'),
      { key: 'class', family: 'TSExplicitList', args: [{ kind: 'type', spelling: 'CELLIST' }, { kind: 'value', spelling: '-572662307' }], spelling: 'TSExplicitList<CELLIST,-572662307>' });
    assert.strictEqual(demangleRttiTemplate('.?AV?$TSExportTableSimple@UCELLIST@@PAUHCELLIST__@@$0A@@@')?.spelling, 'TSExportTableSimple<CELLIST,HCELLIST__*,0>');
    assert.strictEqual(demangleRttiTemplate('.?AV?$X@V?$TSHashObjectChunk@UCELLIST@@VHASHKEY_NONE@@@@$0BA@@@')?.spelling, 'X<TSHashObjectChunk<CELLIST,HASHKEY_NONE>,16>');
    assert.strictEqual(demangleRttiTemplate('.?AUCELLIST@@'), undefined);
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

  it('marks orphan copies by name, in registered scopes only', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>']);
    r.findOrphans([
      { address: '1', name: 'NextLink_Unreferenced', namespace: 'TSLink<CELLIST>' },
      { address: '2', name: 'NextLink', namespace: 'TSLink<CELLIST>' },
      { address: '3', name: 'Foo_Unreferenced', namespace: 'D2Common' },
    ]);
    assert.deepStrictEqual(['1', '2', '3'].map(a => r.isOrphan(a)), [true, false, false]);
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
  });

  it('spells a value argument over its parameter', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSHashTableReuse<CELLIST,HASHKEY_NONE,0>']);
    assert.strictEqual(genericSpelling('TSHashTableReuse<CELLIST, HASHKEY_NONE, 0> *', r.instantiation('TSHashTableReuse<CELLIST,HASHKEY_NONE,0>')!), 'TSHashTableReuse<T, TKey, N>*');
  });
});

describe('placement and scope', () => {
  it('defines a member beside the module function below it, per element', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>', 'TSLink<SGAMEDATA>']);
    const fn = (address: string, namespace: string) => ({ address, namespace, name: 'f' }) as ExtractedFunction;
    const placed = placeTemplateMembers(r, [
      fn('00601000', 'D2CMP::SRC::CelCmp'), fn('00601100', 'CELLIST'), fn('00601200', 'TSLink<CELLIST>'),
      fn('00450000', 'D2Client::GAME::Game'), fn('00450100', 'TSLink<SGAMEDATA>'),
      fn('00440000', 'HASHKEY_NONE'),
    ], new Set(['D2CMP', 'D2Client']));
    assert.strictEqual(placed.get('00601200'), 'D2CMP::SRC::stpl_CELLIST');
    assert.strictEqual(placed.get('00450100'), 'D2Client::GAME::stpl_SGAMEDATA');
    // Nothing below it in a module: the template header's own directory.
    assert.strictEqual(placed.get('00440000'), 'Storm::H::stpl_HASHKEY_NONE');
  });

  it('resolves a registered scope to the class, not to a namespace, and an orphan to root', () => {
    const r = TemplateRegistry.build(CONFIG, ['TSLink<CELLIST>']);
    r.findOrphans([{ address: '2', name: 'NextLink_Unreferenced', namespace: 'TSLink<CELLIST>' }]);
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
  async function load(templates: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'tmplcfg-'));
    try {
      const file = join(dir, 'project.json');
      writeFileSync(file, JSON.stringify({ version: 1, project: 't', templates }));
      return await loadProjectConfigFromFile(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('is read as written', async () => {
    assert.deepStrictEqual((await load(CONFIG))?.templates, CONFIG);
  });

  it('refuses a family without a class key, a parameter without a kind, and a bad orphan pattern', async () => {
    await assert.rejects(load({ header: 'h', families: { A: { params: [{ name: 'T', kind: 'type' }] } } }), /families.A.key/);
    await assert.rejects(load({ header: 'h', families: { A: { key: 'class', params: [{ name: 'T' }] } } }), /a kind "type" or "int"/);
    await assert.rejects(load({ header: 'h', families: {}, orphans: [''] }), /templates.orphans/);
    await assert.rejects(load({ families: {} }), /templates.header/);
  });
});
