/**
 * A function Ghidra tags `inline-host` is a DLL-era header inline: declared
 * `__attribute__((noinline)) inline` in its unit header, defined in the unit's inline
 * header, and included by every file that names it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { selectFileStaticFunctions } from '../codegen/file-static-functions.js';
import { generateProject, unitStaticKeys, unitStaticsHold, answerPlacementLookup, functionHeadersKey } from '../codegen/index.js';
import { INLINE_HOST_TAG, inlineHostHeaderPath, inlineHostRefusal, isInlineHeaderPath, isInlineHost } from '../codegen/inline-hosts.js';
import { hashFunction } from '../modules/buildinfo.js';
import { parseSource } from '../lint/tree.js';
import type {
  AnalyzedDataSymbol,
  ExtractedDataType,
  ExtractedFunction,
  ExtractedNamespace,
  ExtractedParameter,
  ProgramInfo,
  ReconstructOptions,
} from '../types.js';

const GPP = 'i686-w64-mingw32-g++';
function haveGpp(): boolean {
  try { execFileSync(GPP, ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
}

const HOST = [{ type: INLINE_HOST_TAG }];

function fn(
  name: string,
  address: string,
  ns: string,
  body: string,
  opts: { params?: ExtractedParameter[]; tags?: Array<{ type: string; data?: string }>; returnType?: string } = {},
): ExtractedFunction {
  const params = opts.params ?? [];
  const ret = opts.returnType ?? 'int';
  const list = params.map(p => `${p.dataType} ${p.name}`).join(', ') || 'void';
  return {
    name,
    address,
    signature: `${ret} ${name}(${list})`,
    returnType: ret,
    parameters: params,
    localVariables: [],
    callingConvention: '__fastcall',
    size: 0x20,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    namespace: ns,
    tags: opts.tags,
    decompiled: `${ret} __fastcall ${name}(${list})\n{\n${body}\n}\n`,
  };
}

const inEcx = (name: string): ExtractedParameter => ({ name, dataType: 'int', size: 4, ordinal: 0, storage: 'ECX:4' });
const inEax = (name: string): ExtractedParameter => ({ name, dataType: 'int', size: 4, ordinal: 0, storage: 'EAX:4' });

describe('inline host selection', () => {
  it('takes a tagged free function and nothing else', () => {
    const host = fn('GetLine', '00451f80', 'Alpha', '  return n;', { params: [inEcx('n')], tags: HOST });
    assert.strictEqual(isInlineHost(host), true);
    assert.strictEqual(isInlineHost({ ...host, tags: [{ type: 'llm-named' }] }), false);
    assert.strictEqual(inlineHostRefusal({ ...host, parentClass: 'Unit' }), 'method');
    assert.strictEqual(inlineHostRefusal({ ...host, isThunk: true }), 'thunk');
    assert.strictEqual(inlineHostRefusal({ ...host, ifdef: 'D2_PLATFORM_MAC' }), 'platform-guarded');
    assert.strictEqual(inlineHostRefusal({ ...host, isLibrary: true }), 'library function');
  });

  it('names the inline header beside the unit header', () => {
    assert.strictEqual(inlineHostHeaderPath('D2Common/DATATBLS/MonsterTbls.h'), 'D2Common/DATATBLS/MonsterTbls.inline.h');
    assert.ok(isInlineHeaderPath('D2Common/DATATBLS/MonsterTbls.inline.h'));
    assert.ok(!isInlineHeaderPath('D2Common/DATATBLS/MonsterTbls.data.h'));
  });

  it('is never made static, and gets no extern entry', () => {
    // A register argument its convention does not use, called only from its own unit:
    // without the tag it is a file-static candidate, and foreign source calling its
    // entry would give it one.
    const host = fn('Roll', '00401000', 'Alpha', '  return n;', { params: [inEax('n')], tags: HOST });
    const user = fn('User', '00401100', 'Alpha', '  return Roll(1);');
    const all = [host, user];
    const unitOf = new Map(all.map(f => [f.address, f.namespace!]));
    const foreignSources = [{ path: 'support/hand.cpp', text: 'int Hook() { return Alpha::Roll_Extern(2); }' }];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf, globals: [], foreignSources });
    assert.strictEqual(sel.selected.size, 0);
    assert.deepStrictEqual(sel.refused.get('a header inline'), ['Roll']);
    assert.strictEqual(sel.externEntries.size, 0);

    const untagged = { ...host, tags: undefined };
    const plain = selectFileStaticFunctions({ allFunctions: [untagged, user], unitOf, globals: [], foreignSources });
    assert.strictEqual(plain.selected.size, 1, 'the same function untagged is static');
  });
});

describe('inline host reuse', () => {
  const host = fn('GetLine', '00451f80', 'Alpha', '  return n;', { params: [inEcx('n')], tags: HOST });
  const untagged = { ...host, tags: undefined };

  it('moves the function hash with the tag', () => {
    assert.notStrictEqual(hashFunction(host), hashFunction(untagged));
  });

  it('records the inline header among the unit statics', () => {
    const tagged = unitStaticKeys<ExtractedFunction>([host], undefined, undefined, undefined, undefined, isInlineHost);
    const plain = unitStaticKeys<ExtractedFunction>([untagged], undefined, undefined, undefined, undefined, isInlineHost);
    assert.deepStrictEqual(tagged, ['I:00451f80']);
    assert.deepStrictEqual(plain, []);
    assert.strictEqual(unitStaticsHold(plain, tagged), false, 'a unit written before the tag is not reused after it');
  });

  it('changes the include answer every caller recorded', () => {
    const lookup = (header: string) => answerPlacementLookup('f:GetLine', {
      typeOwner: () => undefined,
      functionHeaders: () => [{ qualified: 'Alpha::GetLine', header }],
      fieldType: () => undefined,
      templateHeader: undefined,
      constructorFact: () => '',
    });
    assert.strictEqual(lookup('Alpha.inline.h'), functionHeadersKey([{ qualified: 'Alpha::GetLine', header: 'Alpha.inline.h' }]));
    assert.notStrictEqual(lookup('Alpha.inline.h'), lookup('Alpha.h'));
  });
});

describe('inline host emission', () => {
  const options: ReconstructOptions = {
    outputDir: './out',
    format: 'cpp',
    organization: 'namespace',
    generateCMake: false,
    generateSourceMaps: true,
    transformPreset: 'quick',
    includeAddressComments: false,
    promoteStaticGlobals: true,
  };
  const programInfo: ProgramInfo = {
    name: 'Inline.exe', path: '/tmp/Inline.exe', format: 'PE', architecture: 'x86', compiler: 'msvc',
    imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
  };
  // TXT_MonStats_GetLine (00451f80): a bounds check on the data table, a record pointer back.
  const dataTypes: ExtractedDataType[] = [
    { kind: 'STRUCTURE', name: 'TABLE', category: '/', size: 8, fields: [
      { name: 'pRecords', dataType: 'int *', offset: 0, size: 4 },
      { name: 'nCount', dataType: 'int', offset: 4, size: 4 },
    ] } as ExtractedDataType,
  ];
  const host = fn('GetLine', '00401000', 'Alpha', '  if (n < gpTable->nCount) {\n    return gpTable->pRecords + n;\n  }\n  return (int *)0x0;',
    { params: [inEcx('n')], tags: HOST, returnType: 'int *' });
  const functions = [
    host,
    { ...fn('Local', '00401100', 'Alpha', '  return *GetLine(n);', { params: [inEcx('n')] }), calledFunctions: ['GetLine'] },
    { ...fn('Remote', '00402000', 'Beta', '  return *Alpha::GetLine(n) + 1;', { params: [inEcx('n')] }), calledFunctions: ['GetLine'] },
    fn('Unrelated', '00403000', 'Gamma', '  return n;', { params: [inEcx('n')] }),
  ];
  // Named only by the host and its own unit: without the host it would be Alpha.cpp's static.
  const globals = [{
    name: 'gpTable', address: '00500000', dataType: 'TABLE *', size: 4, namespace: null,
    isInitialized: false, xrefCount: 2, referencingFunctions: ['GetLine', 'Local'], scope: 'global',
  }] as unknown as AnalyzedDataSymbol[];
  const namespaces: ExtractedNamespace[] = [
    { name: 'Alpha', fullPath: 'Alpha', functionCount: 2, isClass: false },
    { name: 'Beta', fullPath: 'Beta', functionCount: 1, isClass: false },
    { name: 'Gamma', fullPath: 'Gamma', functionCount: 1, isClass: false },
  ];
  const project = generateProject('inline', functions.map(f => ({ ...f })), [], dataTypes, globals.map(g => ({ ...g })), namespaces, options, programInfo);
  const path = (suffix: string) => [...project.files.keys()].find(p => p.endsWith(suffix));
  const file = (suffix: string) => project.files.get(path(suffix)!)!.content;

  it('declares it inline and never inlined in the unit header', () => {
    assert.match(file('Alpha.h'), /^__attribute__\(\(noinline\)\) inline int \* __fastcall GetLine\(int n\);/m);
  });

  it('defines it in the inline header and not in the unit .cpp', () => {
    const inline = file('Alpha.inline.h');
    assert.match(inline, /^#pragma once$/m);
    assert.match(inline, /^#include "Alpha\/Alpha\.h"$/m);
    assert.match(inline, /^__attribute__\(\(noinline\)\) inline int \* __fastcall GetLine\(int n\) \{$/m);
    assert.doesNotMatch(inline, /\bLocal\s*\(/);
    const impl = file('Alpha.cpp');
    assert.doesNotMatch(impl, /GetLine\(int n\) \{/, `the .cpp defines it again:\n${impl}`);
    assert.match(impl, /\bLocal\(int n\) \{/);
  });

  it('is included by every file that names it, and by no other', () => {
    assert.match(file('Alpha.cpp'), /^#include "Alpha\/Alpha\.inline\.h"$/m);
    assert.match(file('Beta.cpp'), /^#include "Alpha\/Alpha\.inline\.h"$/m);
    assert.doesNotMatch(file('Gamma.cpp'), /Alpha\.inline\.h/);
    for (const [p, f] of project.files) {
      if (p.endsWith('.h')) assert.doesNotMatch(f.content, /#include "[^"]*\.inline\.h"/, `${p} includes an inline header`);
    }
  });

  it('keeps a global it names external', () => {
    const all = [...project.files.values()].map(f => f.content).join('\n');
    assert.doesNotMatch(all, /static TABLE \* gpTable/);
  });

  it('maps the function in its unit and names the header holding the body', () => {
    const map = [...project.sourceMaps.entries()].find(([p]) => p.endsWith('Alpha.cpp.map'))![1];
    const entry = map.functions.find(f => f.name === 'GetLine');
    assert.ok(entry, 'GetLine is in its unit\'s map');
    assert.strictEqual(entry!.definedIn, path('Alpha.inline.h'));
    assert.strictEqual(map.functions.find(f => f.name === 'Local')!.definedIn, undefined);
  });

  it('is read as code by the lint', () => {
    assert.strictEqual(parseSource('Alpha/Alpha.inline.h', file('Alpha.inline.h')).isHeader, false);
    assert.strictEqual(parseSource('Alpha/Alpha.h', file('Alpha.h')).isHeader, true);
  });

  it('compiles in every TU and links to one copy', { skip: !haveGpp() && 'mingw g++ not installed' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'inline-host-'));
    try {
      for (const [p, f] of project.files) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), f.content);
      }
      const units = [...project.files.keys()].filter(p => p.endsWith('.cpp'));
      const objects: string[] = [];
      for (const unit of units) {
        const obj = `${unit}.o`;
        execFileSync(GPP, ['-std=c++17', '-c', '-w', '-fms-extensions', '-I.', unit, '-o', obj], { cwd: dir, stdio: 'pipe' });
        objects.push(obj);
      }
      // A relocatable link refuses two strong definitions of one symbol; the COMDAT
      // copies Alpha and Beta each emitted fold to one.
      execFileSync(GPP, ['-r', '-nostdlib', '-o', 'all.o', ...objects], { cwd: dir, stdio: 'pipe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
