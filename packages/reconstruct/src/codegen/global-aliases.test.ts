import { describe, it } from 'node:test';
import assert from 'node:assert';

import { foldGlobalAliases, globalAliasComment } from './global-aliases.js';
import { markPrimaryLabels, parsePrimaryLabels, PRIMARY_LABEL_SCRIPT } from '../extract/globals.js';
import { generateProject } from './index.js';
import { globalAliasResolvePlugin, parse, emit } from '@ghidra-mcp/cpp-parser';
import type { AnalyzedDataSymbol, ExtractedFunction, ProgramInfo, ReconstructOptions } from '../types.js';

function g(name: string, address: string, extra: Partial<AnalyzedDataSymbol> = {}): AnalyzedDataSymbol {
  return {
    name, address, dataType: 'tagRECT', size: 16, isInitialized: false, xrefCount: 1,
    referencingFunctions: [], scope: 'global', ...extra,
  } as AnalyzedDataSymbol;
}

// 007c9160 at v1234: four labels, one object.
const rect = () => [
  g('?rInitialWindowRect@@3UtagRECT@@A', '007c9160'),
  g('Ordinal_24', '007c9160'),
  g('rInitialWindowRect', '007c9160'),
  g('lpRect_007c9160', '007c9160'),
];

describe('foldGlobalAliases', () => {
  it('keeps the label Ghidra marks primary and records the others as aliases', () => {
    const gs = rect();
    gs[2].primary = true;
    for (const x of [gs[0], gs[1], gs[3]]) x.primary = false;
    const f = foldGlobalAliases(gs);
    assert.strictEqual(f.globals.length, 1);
    assert.strictEqual(f.globals[0].name, 'rInitialWindowRect');
    assert.deepStrictEqual(f.globals[0].aliases, ['?rInitialWindowRect@@3UtagRECT@@A', 'Ordinal_24', 'lpRect_007c9160']);
    assert.deepStrictEqual(f.folded, { ghidra: 1, decompiler: 0, first: 0 });
    assert.strictEqual(f.referenceAliases['Ordinal_24'], 'rInitialWindowRect');
    assert.strictEqual(f.referenceAliases['lpRect_007c9160'], 'rInitialWindowRect');
    // The decorated name is reachable in both its raw and its legalized spelling.
    assert.strictEqual(f.referenceAliases['?rInitialWindowRect@@3UtagRECT@@A'], 'rInitialWindowRect');
    assert.strictEqual(f.referenceAliases['_rInitialWindowRect__3UtagRECT__A'], 'rInitialWindowRect');
  });

  it('without a flag, takes the one label the decompiler prints', () => {
    const body = 'void D2WIN_HandleSystemCommand(void)\n{\n  lpRect_007c9160.left = 0; /* Ordinal_24 in a comment is not a use */\n}\n';
    const f = foldGlobalAliases(rect(), [{ decompiled: body }]);
    assert.strictEqual(f.globals.length, 1);
    assert.strictEqual(f.globals[0].name, 'lpRect_007c9160');
    assert.deepStrictEqual(f.folded, { ghidra: 0, decompiler: 1, first: 0 });
  });

  it('a label spelled like a type is no evidence', () => {
    const gs = [g('sockaddr_in', '00882b38'), g('name_00882b38', '00882b38')];
    const body = 'void f(void)\n{\n  sockaddr_in local;\n  bind(s, &name_00882b38, 16);\n}\n';
    const f = foldGlobalAliases(gs, [{ decompiled: body }], new Set(['sockaddr_in']));
    assert.strictEqual(f.globals[0].name, 'name_00882b38');
    // ... and the type's spelling is never made an alias of the global.
    assert.strictEqual(f.referenceAliases['sockaddr_in'], undefined);
  });

  it('with no evidence keeps the first label listed', () => {
    const f = foldGlobalAliases([g('gaCrtLocaleCategoryTable', '006f3168'), g('gaLocaleCategoryNames', '006f3168')]);
    assert.strictEqual(f.globals[0].name, 'gaCrtLocaleCategoryTable');
    assert.deepStrictEqual(f.folded, { ghidra: 0, decompiler: 0, first: 1 });
  });

  it('a flag that is not unique falls back to the decompiler', () => {
    const gs = [g('a', '1000', { primary: true }), g('b', '1000', { primary: true })];
    const f = foldGlobalAliases(gs, [{ decompiled: 'void f(void)\n{\n  b = 1;\n}\n' }]);
    assert.strictEqual(f.globals[0].name, 'b');
  });

  it('leaves single-label addresses, other platforms and member paths alone', () => {
    const gs = [
      g('lpRect_007c9160', '007c9160', { primary: true }),
      g('Ordinal_24', '007c9160', { primary: false }),
      g('lpRect_007c9160.top', '007c9164'),
      g('gOther', '007c9170'),
      g('gMac', '007c9160', { platform: 'mac' }),
    ];
    const f = foldGlobalAliases(gs);
    assert.deepStrictEqual(f.globals.map(x => x.name), ['lpRect_007c9160', 'lpRect_007c9160.top', 'gOther', 'gMac']);
  });

  it('merges the referencing functions of every label', () => {
    const gs = [
      g('p', '2000', { primary: true, referencingFunctions: ['A'], xrefCount: 1 }),
      g('q', '2000', { primary: false, referencingFunctions: ['B'], xrefCount: 3 }),
    ];
    const f = foldGlobalAliases(gs);
    assert.deepStrictEqual(f.globals[0].referencingFunctions, ['A', 'B']);
    assert.strictEqual(f.globals[0].xrefCount, 3);
  });

  it('respells pointer initializers that name an alias, interior paths included', () => {
    const gs = [
      g('gZlibExtraLBitsBlOrder', '006d0d90', { primary: true }),
      g('gnSSCompLZHBufferState', '006d0d90', { primary: false }),
      g('gZlibStaticBlDesc', '0070891c', {
        isInitialized: true,
        initializedData: {
          kind: 'struct',
          fields: [
            { name: 'static_tree', value: { kind: 'pointer', value: 'gnSSCompLZHBufferState' } },
            { name: 'extra_bits', value: { kind: 'pointer', value: 'gnSSCompLZHBufferState.bl_order[0]' } },
            { name: 'other', value: { kind: 'pointer', value: 'gnSSCompLZHBufferState+4' } },
            { name: 'kept', value: { kind: 'pointer', value: 'gZlibExtraLBitsBlOrder' } },
            { name: 'longer', value: { kind: 'pointer', value: 'gnSSCompLZHBufferStateX' } },
          ],
        },
      }),
    ];
    const f = foldGlobalAliases(gs);
    const fields = f.globals.find(x => x.name === 'gZlibStaticBlDesc')!.initializedData!.fields!;
    assert.deepStrictEqual(fields.map(x => x.value.value), [
      'gZlibExtraLBitsBlOrder',
      'gZlibExtraLBitsBlOrder.bl_order[0]',
      'gZlibExtraLBitsBlOrder+4',
      'gZlibExtraLBitsBlOrder',
      'gnSSCompLZHBufferStateX',
    ]);
    assert.strictEqual(f.initializerRespellings, 3);
    // The input is not mutated.
    assert.strictEqual(gs[2].initializedData!.fields![0].value.value, 'gnSSCompLZHBufferState');
  });

  it('an alias spelled like a symbol that stays is not an alias', () => {
    const gs = [
      g('RTTI_Type_Descriptor', '0070811c', { namespace: 'Fog::Logging::Message', primary: true }),
      g('struct_LogManager::Message_RTTI_Type_Descriptor', '0070811c', { primary: false }),
      g('RTTI_Type_Descriptor', '007083b8', { namespace: 'FILEREC', primary: true }),
      g('Alias', '007083b8', { primary: false }),
      g('Alias', '00700000'),
    ];
    const f = foldGlobalAliases(gs);
    assert.strictEqual(f.referenceAliases['RTTI_Type_Descriptor'], undefined);
    assert.strictEqual(f.referenceAliases['Alias'], undefined);
    assert.strictEqual(f.referenceAliases['struct_LogManager::Message_RTTI_Type_Descriptor'], 'Fog::Logging::Message::RTTI_Type_Descriptor');
  });

  it('the definition comment is one line', () => {
    assert.strictEqual(globalAliasComment({ aliases: ['Ordinal_24', 'a\nb'] }), '// also labelled: Ordinal_24, a b');
    assert.strictEqual(globalAliasComment({}), undefined);
  });
});

describe('primary label extraction', () => {
  it('the script asks the symbol table for the primary', () => {
    assert.ok(PRIMARY_LABEL_SCRIPT.includes('getPrimarySymbol'));
  });

  it('parses rows and flags exactly one label per address', () => {
    const map = parsePrimaryLabels('007c9160\trInitialWindowRect\t\n0070811c\tRTTI_Type_Descriptor\tFog::Logging::Message\nnot a row\n\n');
    assert.deepStrictEqual(map.get('007c9160'), { name: 'rInitialWindowRect' });
    assert.deepStrictEqual(map.get('0070811c'), { name: 'RTTI_Type_Descriptor', namespace: 'Fog::Logging::Message' });
    assert.strictEqual(map.size, 2);

    const gs: Array<{ name: string; address: string; namespace?: string | null; primary?: boolean }> = [
      ...rect(),
      { name: 'struct_LogManager::Message_RTTI_Type_Descriptor', address: '0070811c', namespace: null },
      { name: 'RTTI_Type_Descriptor', address: '0070811c', namespace: 'Fog::Logging::Message' },
      { name: 'gAlone', address: '00400000' },
    ];
    const n = markPrimaryLabels(gs, map);
    assert.deepStrictEqual(n, { flagged: 2, unmatched: 0 });
    assert.deepStrictEqual(gs.map(x => x.primary), [false, false, true, false, false, true, undefined]);
  });

  it('a primary missing from the listing leaves the group unflagged', () => {
    const gs: Array<{ name: string; address: string; primary?: boolean }> = [
      { name: 'a', address: '00001000' }, { name: 'b', address: '00001000' },
    ];
    const n = markPrimaryLabels(gs, parsePrimaryLabels('00001000\tc\t\n'));
    assert.deepStrictEqual(n, { flagged: 0, unmatched: 1 });
    assert.deepStrictEqual(gs.map(x => x.primary), [undefined, undefined]);
  });
});

describe('global-alias-resolve', () => {
  const run = (code: string, globalAliases: Record<string, string>) =>
    emit(globalAliasResolvePlugin.createTransformer({ globalAliases })(parse(code)) as any);

  it('respells a reference by an alias', () => {
    const out = run('void f() { Ordinal_24.left = 1; GetWindowRect(h, &Ordinal_24); }', { Ordinal_24: 'rInitialWindowRect' });
    assert.ok(/rInitialWindowRect\.left = 1/.test(out), out);
    assert.ok(/&rInitialWindowRect\)/.test(out), out);
    assert.ok(!/Ordinal_24/.test(out), out);
  });

  it('keeps member names, and a body that declares the name', () => {
    const out = run('void f() { p->Ordinal_24 = s.Ordinal_24; }', { Ordinal_24: 'rInitialWindowRect' });
    assert.ok(/p->Ordinal_24 = s\.Ordinal_24/.test(out), out);
    const shadowed = run('void f(int WindowRect) { g = WindowRect; }', { WindowRect: 'lpRect_007d5580' });
    assert.ok(/g = WindowRect/.test(shadowed), shadowed);
  });

  it('respells a qualified alias to a qualified primary', () => {
    const out = run('void f() { x = &Ns::gOld; y = gOld2; }', { 'Ns::gOld': 'Ns::gNew', gOld2: 'Other::gNew2' });
    assert.ok(/&Ns::gNew;/.test(out), out);
    assert.ok(/y = Other::gNew2;/.test(out), out);
  });
});

describe('one definition per address, end to end', () => {
  const options: ReconstructOptions = {
    outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
    generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: false,
  };
  const programInfo: ProgramInfo = {
    name: 'Game.exe', path: '/tmp/Game.exe', format: 'PE', architecture: 'x86', compiler: 'msvc',
    imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
  };
  const fn = (name: string, body: string): ExtractedFunction => ({
    name, address: name === 'Reader' ? '00401000' : '00401100', signature: `int ${name}(void)`, returnType: 'int',
    parameters: [], localVariables: [], callingConvention: '__cdecl', size: 0x20, isThunk: false,
    isExternal: false, hasVarArgs: false, namespace: 'Mod',
    decompiled: `int ${name}(void)\n{\n${body}\n}\n`, calledFunctions: [],
  } as unknown as ExtractedFunction);

  it('defines the primary once and binds an alias reference to it', () => {
    const globals = [
      g('gnPacketLogWriteOffset0', '0075bfa0', { dataType: 'int', size: 4, primary: false, referencingFunctions: ['Mod::Writer'] }),
      g('gnSentPacketRawBytes', '0075bfa0', { dataType: 'int', size: 4, primary: true, referencingFunctions: ['Mod::Reader'] }),
    ];
    const project = generateProject('T', [
      fn('Reader', '  return gnSentPacketRawBytes;'),
      fn('Writer', '  gnPacketLogWriteOffset0 = 5;\n  return 0;'),
    ], [], [], globals, [], options, programInfo, []);
    const all = [...project.files.entries()].map(([p, f]) => `//// ${p}\n${f.content}`).join('\n');
    const defs = all.match(/^\s*(?:static\s+)?int\s+gn\w+\s*(?:=[^;]*)?;/gm) ?? [];
    assert.deepStrictEqual(defs.map(d => d.trim()), ['int gnSentPacketRawBytes;'], all);
    assert.ok(/\/\/ also labelled: gnPacketLogWriteOffset0\n\s*int gnSentPacketRawBytes;/.test(all), all);
    assert.ok(/gnSentPacketRawBytes = 5;/.test(all), all);
    assert.ok(!/gnPacketLogWriteOffset0 =/.test(all), all);
  });

  it('a member-path label inside another global defines nothing of its own', () => {
    // sgtDataTable.pTxtSounds @0096bdc4 lies inside sgtDataTable @0096bc30. Used by one
    // function it was file-local, and the per-file emitter defined
    // `static D2DataTableTxtStrc sgtDataTable_pTxtSounds = {};`.
    const globals = [
      g('sgtDataTable', '0096bc30', { dataType: 'int[16]', size: 64, referencingFunctions: ['Mod::Reader', 'Other::User'] }),
      g('sgtDataTable.pTxtSounds', '0096bc34', { dataType: 'int[16]', size: 64, referencingFunctions: ['Mod::Reader', 'Mod::Writer'] }),
    ];
    const project = generateProject('T', [
      fn('Reader', '  return sgtDataTable[1];'),
      fn('Writer', '  sgtDataTable[0] = 5;\n  return 0;'),
    ], [], [], globals, [], { ...options, promoteStaticGlobals: true }, programInfo, []);
    const all = [...project.files.entries()].map(([p, f]) => `//// ${p}\n${f.content}`).join('\n');
    assert.ok(!/sgtDataTable_pTxtSounds/.test(all), all);
    assert.ok(/int sgtDataTable\[16\]/.test(all), all);
  });
});
