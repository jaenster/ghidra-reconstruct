/**
 * A root-scope global named like a parameter of the function that references it. Ghidra
 * prints both bare (UpdateScaleFactor 006b1c10, before v2050 renamed the global):
 *
 *     void __fastcall UpdateScaleFactor(int nScaleFactor) { nScaleFactor = nScaleFactor; }
 *
 * and C++ binds both to the parameter, so the global is never written. The decompiler
 * markup says which token is the global (extract/shadowed-globals.ts); the emitted store
 * must say `::nScaleFactor = nScaleFactor;`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateImplementation, type ImplGenContext } from '../codegen/impl.js';
import { parseFunctionFacts, selectFacts } from '../extract/function-facts.js';
import { parseShadowedGlobalRow } from '../extract/shadowed-globals.js';
import type { AnalyzedDataSymbol, ExtractedFunction, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

const SCALE: AnalyzedDataSymbol = {
  name: 'nScaleFactor',
  address: '007b57e4',
  dataType: 'int',
  size: 4,
  isInitialized: false,
  xrefCount: 3,
  scope: 'global',
};

const COMPRESSED: AnalyzedDataSymbol = {
  name: 'bUseCompressedData',
  address: '00741efc',
  dataType: 'BOOL',
  size: 4,
  isInitialized: true,
  xrefCount: 6,
  scope: 'global',
};

function fn(name: string, address: string, param: string, type: string, lines: string[]): ExtractedFunction {
  return {
    name,
    address,
    signature: `void ${name}(${type} ${param})`,
    returnType: 'void',
    parameters: [{ name: param, dataType: type, size: 4, ordinal: 0 }],
    localVariables: [],
    callingConvention: '__fastcall',
    size: 16,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    namespace: 'D2Direct3D::Renderer::Direct3D',
    decompiled: lines.join('\n') + '\n',
  };
}

// The decompile as the v2049 snapshot holds it (lines 1-8).
const UPDATE_LINES = [
  '',
  'void __fastcall D2Direct3D::Renderer::Direct3D::UpdateScaleFactor(int nScaleFactor)',
  '',
  '{',
  '  nScaleFactor = nScaleFactor;',
  '  return;',
  '}',
  '',
];

const SET_LINES = [
  '',
  'void __fastcall D2Direct3D::Renderer::Direct3D::SetCompressed(BOOL bUseCompressedData)',
  '',
  '{',
  '  SRegLoadValue("Diablo II","CompressedData",1,&bUseCompressedData);',
  '  if (bUseCompressedData == 0) {',
  '    bUseCompressedData = 0;',
  '  }',
  '  return;',
  '}',
  '',
];

const context = (): ImplGenContext => ({
  analyzedGlobals: [SCALE, COMPRESSED],
  knownNamespaces: new Set(['D2Direct3D', 'D2Direct3D::Renderer', 'D2Direct3D::Renderer::Direct3D']),
});

function emit(f: ExtractedFunction): string {
  return generateImplementation(
    'D2Direct3D/Renderer/Direct3D', [f], undefined, 'D2Direct3D/Renderer/Direct3D.h', options, context(), undefined, new Set<string>(),
  );
}

const bodyLine = (impl: string, needle: RegExp) => impl.split('\n').find(l => needle.test(l))?.trim();

describe('a global a parameter of the same name hides', () => {
  it('stores into the global, not the parameter', () => {
    const f = fn('UpdateScaleFactor', '006b1c10', 'nScaleFactor', 'int', UPDATE_LINES);
    f.shadowedGlobals = parseShadowedGlobalRow('8\t5:nScaleFactor,0,2,7b57e4')!;
    assert.ok(f.shadowedGlobals);
    const impl = emit(f);
    assert.strictEqual(bodyLine(impl, /nScaleFactor =/), '::nScaleFactor = nScaleFactor;', impl);
  });

  it('reads and writes the global where the markup says, and the parameter elsewhere', () => {
    const f = fn('SetCompressed', '005fe280', 'bUseCompressedData', 'BOOL', SET_LINES);
    // The global is written through its address and stored at line 7; the test at line 6 reads the parameter.
    f.shadowedGlobals = parseShadowedGlobalRow('11\t5:bUseCompressedData,0,1,741efc;7:bUseCompressedData,0,1,741efc')!;
    const impl = emit(f);
    assert.match(impl, /&::bUseCompressedData\)/, impl);
    assert.match(impl, /^\s*::bUseCompressedData = 0;/m, impl);
    assert.match(impl, /if \(!?bUseCompressedData/, impl);
    assert.doesNotMatch(impl, /if \(.*::bUseCompressedData/, impl);
  });

  it('leaves a line alone whose name count differs from the markup', () => {
    const f = fn('UpdateScaleFactor', '006b1c10', 'nScaleFactor', 'int', UPDATE_LINES);
    f.shadowedGlobals = parseShadowedGlobalRow('8\t5:nScaleFactor,0,3,7b57e4')!;
    assert.strictEqual(bodyLine(emit(f), /nScaleFactor =/), 'nScaleFactor = nScaleFactor;');
  });

  it('leaves the text alone for another decompile (line count) or an unknown global', () => {
    const f = fn('UpdateScaleFactor', '006b1c10', 'nScaleFactor', 'int', UPDATE_LINES);
    f.shadowedGlobals = parseShadowedGlobalRow('9\t5:nScaleFactor,0,2,7b57e4')!;
    assert.strictEqual(bodyLine(emit(f), /nScaleFactor =/), 'nScaleFactor = nScaleFactor;');
    f.shadowedGlobals = parseShadowedGlobalRow('8\t5:nScaleFactor,0,2,7b57e8')!;
    assert.strictEqual(bodyLine(emit(f), /nScaleFactor =/), 'nScaleFactor = nScaleFactor;');
  });

  it('emits the self-assignment Ghidra printed when the facts are absent', () => {
    // Without the markup the text cannot be read any other way; the self-assignment lint names it.
    const f = fn('UpdateScaleFactor', '006b1c10', 'nScaleFactor', 'int', UPDATE_LINES);
    assert.strictEqual(bodyLine(emit(f), /nScaleFactor =/), 'nScaleFactor = nScaleFactor;');
  });
});

describe('shadowed-globals row', () => {
  it('parses lines of references', () => {
    assert.deepStrictEqual(parseShadowedGlobalRow('8\t5:nScaleFactor,0,2,7b57e4;7:a,1,2,10|b,0,1,7d55a4'), {
      lineCount: 8,
      lines: [
        [5, [{ name: 'nScaleFactor', ord: 0, total: 2, address: '007b57e4' }]],
        [7, [{ name: 'a', ord: 1, total: 2, address: '00000010' }, { name: 'b', ord: 0, total: 1, address: '007d55a4' }]],
      ],
    });
  });

  it('rejects a malformed row or an ordinal past the count', () => {
    assert.strictEqual(parseShadowedGlobalRow('9\t'), null);
    assert.strictEqual(parseShadowedGlobalRow('9\t5:n,2,2,10'), null);
    assert.strictEqual(parseShadowedGlobalRow('9\t5:n,0,2'), null);
    assert.strictEqual(parseShadowedGlobalRow('x\t5:n,0,2,10'), null);
  });

  it('reaches the facts through the script output', () => {
    const text = UPDATE_LINES.join('\n') + '\n';
    const out = parseFunctionFacts('F\t006b1c10\tself\t1f\t10\t1\nN\t006b1c10\t8\t5:nScaleFactor,0,2,7b57e4\nD\t\n');
    const row = out.rows.get('006b1c10');
    assert.ok(row);
    assert.deepStrictEqual(selectFacts(text, '006b1c10', row, false).shadowedGlobals, {
      lineCount: 8,
      lines: [[5, [{ name: 'nScaleFactor', ord: 0, total: 2, address: '007b57e4' }]]],
    });
  });
});
