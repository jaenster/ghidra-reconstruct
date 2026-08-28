/**
 * Four ways declaration and reference had drifted apart in the globals emitter.
 * Each one is a symbol some emitter REFERENCES under a spelling no emitter
 * DECLARES, which is the worst of both worlds — the reference does not go away
 * when the declaration is refused.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  isSwitchTableSymbol,
  generateGlobalsHeader,
  generateGlobalsImpl,
  promoteCentrallyReferencedGlobals,
  setMultidimArrayGlobals,
  setCentralInitializerScope,
} from '../codegen/globals-header.js';
import { collectTemplateNames, flattenTemplateNames } from '../codegen/template-names.js';
import type { AnalyzedDataSymbol, ReconstructOptions } from '../types.js';

const options = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

describe('MSVC-decorated data symbols are real data, not switch tables', () => {
  it('does not classify an @-decorated name as a jump-table artifact', () => {
    // `s_.?AUSGAMEDATA@@_0070f56c` is the RTTI name string SMemAlloc call sites
    // pass as their allocator tag — 10 xrefs across two modules.
    assert.strictEqual(isSwitchTableSymbol('s_.?AUSGAMEDATA@@_0070f56c'), false);
    assert.strictEqual(isSwitchTableSymbol('PTR__BinkOpen@8_006cc5b8'), false);
    // The genuine artifacts are still recognised.
    assert.strictEqual(isSwitchTableSymbol('switchdataD_0067582c'), true);
    assert.strictEqual(isSwitchTableSymbol('LAB_00646c24'), true);
    assert.strictEqual(isSwitchTableSymbol('PTR_caseD_3_0067582c+2'), true);
  });

  it('declares it, under the sanitized spelling bodies use', () => {
    const g: AnalyzedDataSymbol = {
      name: 's_.?AUSGAMEDATA@@_0070f56c',
      address: '0070f56c',
      dataType: 'char[16]',
      size: 16,
      isInitialized: true,
      value: '.?AUSGAMEDATA@@',
      xrefCount: 12,
      scope: 'global',
    } as AnalyzedDataSymbol;
    setMultidimArrayGlobals([g]);
    const header = generateGlobalsHeader([g], options);
    assert.match(header, /s___AUSGAMEDATA___0070f56c/);
    assert.doesNotMatch(header, /@/);
  });
});

describe('globals.cpp can see what globals.cpp names', () => {
  const defined: AnalyzedDataSymbol = {
    name: 'aNpcGossipData', address: '00732ff8', dataType: 'int', size: 4,
    isInitialized: true, value: '0', xrefCount: 1, scope: 'global',
  } as AnalyzedDataSymbol;

  it('forward-declares a definition globals.h did not declare', () => {
    setMultidimArrayGlobals([defined]);
    // Header not generated for it, so globals.cpp owns the declaration.
    generateGlobalsHeader([], options);
    const impl = generateGlobalsImpl([defined], options);
    const declAt = impl.indexOf('extern int aNpcGossipData;');
    const defAt = impl.indexOf('int aNpcGossipData = ');
    assert.ok(declAt >= 0, `no forward extern:\n${impl}`);
    assert.ok(declAt < defAt, 'the forward extern must precede the definition');
    setCentralInitializerScope(false);
  });
});

describe('a global named only by another global initializer keeps its name', () => {
  it('is promoted out of static-local so globals.h declares it', () => {
    const table: AnalyzedDataSymbol = {
      name: 'gaUnitSoundTable', address: '00729400', dataType: 'int *[1]', size: 4,
      isInitialized: true, xrefCount: 2, scope: 'global',
      initializedData: { kind: 'array', elements: [{ kind: 'pointer', value: 'gaUnitSoundTableModeChange' }] },
    } as AnalyzedDataSymbol;
    const target: AnalyzedDataSymbol = {
      name: 'gaUnitSoundTableModeChange', address: '00729328', dataType: 'int[7]', size: 28,
      isInitialized: true, xrefCount: 14, scope: 'static-local',
    } as AnalyzedDataSymbol;

    const promoted = promoteCentrallyReferencedGlobals([table, target]);
    assert.deepStrictEqual(promoted.map(g => g.name), ['gaUnitSoundTableModeChange']);
    assert.strictEqual(target.scope, 'global');
  });

  it('leaves an ambiguous name alone — two symbols, no way to pick one', () => {
    const table: AnalyzedDataSymbol = {
      name: 'tbl', address: '1', dataType: 'int *[1]', size: 4, isInitialized: true,
      xrefCount: 1, scope: 'global',
      initializedData: { kind: 'array', elements: [{ kind: 'pointer', value: 'gpDup' }] },
    } as AnalyzedDataSymbol;
    const a = { name: 'gpDup', address: '2', dataType: 'int', size: 4, isInitialized: true, xrefCount: 1, scope: 'static-local' } as AnalyzedDataSymbol;
    const b = { name: 'gpDup', address: '3', dataType: 'int', size: 4, isInitialized: true, xrefCount: 1, scope: 'static-local' } as AnalyzedDataSymbol;
    assert.deepStrictEqual(promoteCentrallyReferencedGlobals([table, a, b]), []);
    assert.strictEqual(a.scope, 'static-local');
    assert.strictEqual(b.scope, 'static-local');
  });
});

describe('demangled template spellings are flattened model-wide', () => {
  const dataTypes = [
    {
      name: 'TSHashTableReuse<struct_CELLIST,class_HASHKEY_NONE,0>', kind: 'STRUCTURE', category: '/',
      fields: [{ name: 'super_TSHashTable<struct_CELLIST,class_HASHKEY_NONE>', dataType: 'TSHashTable<struct_CELLIST,class_HASHKEY_NONE>', offset: 0, size: 4 }],
    },
  ] as any[];

  it('collects the closed name set from Ghidra, longest first', () => {
    const names = collectTemplateNames(dataTypes);
    assert.ok(names.includes('TSHashTableReuse<struct_CELLIST,class_HASHKEY_NONE,0>'));
    assert.ok(names.includes('super_TSHashTable<struct_CELLIST,class_HASHKEY_NONE>'));
    for (let i = 1; i < names.length; i++) {
      assert.ok(names[i - 1].length >= names[i].length, 'longest must come first');
    }
  });

  it('rewrites the type, the field and the body to the same identifier', () => {
    const types = JSON.parse(JSON.stringify(dataTypes));
    const fn = {
      name: 'TSHASH_Ctor', parameters: [], localVariables: [],
      signature: 'void TSHASH_Ctor(TSHashTableReuse<struct_CELLIST,class_HASHKEY_NONE,0> * p)',
      decompiled: 'void TSHASH_Ctor(TSHashTableReuse<struct_CELLIST,class_HASHKEY_NONE,0> *p)\n{\n  p->super_TSHashTable<struct_CELLIST,class_HASHKEY_NONE>._vfptr = 0;\n}',
    } as any;
    flattenTemplateNames(types, [fn], []);
    const flat = 'TSHashTableReuse_struct_CELLIST_class_HASHKEY_NONE_0_';
    assert.strictEqual(types[0].name, flat);
    assert.doesNotMatch(fn.decompiled, /</);  // `->` keeps its `>`
    assert.ok(fn.decompiled.includes(types[0].fields[0].name),
      'the body must name the field exactly as the struct declares it');
  });

  it('leaves text that merely contains angle brackets alone', () => {
    const fn = { name: 'f', parameters: [], localVariables: [], decompiled: 'if (a < b) log("MODULE<%p>");' } as any;
    flattenTemplateNames(JSON.parse(JSON.stringify(dataTypes)), [fn], []);
    assert.strictEqual(fn.decompiled, 'if (a < b) log("MODULE<%p>");');
  });
});
