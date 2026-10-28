/**
 * A function the original passed arguments to in registers its declared convention
 * does not use is emitted `static` when every reference to it is in its own unit.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { foreignParameterRegisters, readForeignSources, selectFileStaticFunctions } from '../codegen/file-static-functions.js';
import { generateProject } from '../codegen/index.js';
import type {
  AnalyzedDataSymbol,
  ExtractedFunction,
  ExtractedNamespace,
  ExtractedParameter,
  ProgramInfo,
  ReconstructOptions,
} from '../types.js';

function fn(
  name: string,
  address: string,
  ns: string,
  body: string,
  opts: { conv?: string; params?: ExtractedParameter[] } = {},
): ExtractedFunction {
  const params = opts.params ?? [];
  const list = params.map(p => `${p.dataType} ${p.name}`).join(', ') || 'void';
  return {
    name,
    address,
    signature: `int ${name}(${list})`,
    returnType: 'int',
    parameters: params,
    localVariables: [],
    callingConvention: opts.conv ?? '__stdcall',
    size: 0x20,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    namespace: ns,
    decompiled: `int ${opts.conv ?? '__stdcall'} ${name}(${list})\n{\n${body}\n}\n`,
  };
}

const inEax = (name = 'nValue'): ExtractedParameter => ({ name, dataType: 'int', size: 4, ordinal: 0, storage: 'EAX:4' });
const onStack = (name = 'nValue'): ExtractedParameter => ({ name, dataType: 'int', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' });

/** Each function's unit is its namespace. */
function unitsOf(functions: ExtractedFunction[]): Map<string, string> {
  return new Map(functions.map(f => [f.address.replace(/^0x/, '').padStart(8, '0'), f.namespace!]));
}

describe('foreignParameterRegisters', () => {
  it('names registers the convention does not pass arguments in', () => {
    assert.deepStrictEqual(foreignParameterRegisters({ callingConvention: '__stdcall', parameters: [inEax()] }), ['EAX']);
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__cdecl',
      parameters: [{ name: 'p', dataType: 'char', size: 1, ordinal: 0, storage: 'BL:1' }],
    }), ['EBX']);
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__stdcall',
      parameters: [{ name: 'p', dataType: 'int', size: 4, ordinal: 0, storage: 'ECX:4' }],
    }), ['ECX']);
  });

  it('accepts what the convention itself passes, and the stack', () => {
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__fastcall',
      parameters: [
        { name: 'a', dataType: 'int', size: 4, ordinal: 0, storage: 'ECX:4' },
        { name: 'b', dataType: 'short', size: 2, ordinal: 1, storage: 'DX:2' },
        onStack('c'),
      ],
    }), []);
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__fastcall_edxsafe',
      parameters: [{ name: 'a', dataType: 'int', size: 4, ordinal: 0, storage: 'ESI:4' }],
    }), ['ESI']);
  });
});

describe('selectFileStaticFunctions', () => {
  const helper = fn('Helper', '00401000', 'A', '  return nValue + 1;', { params: [inEax()] });
  const caller = fn('Caller', '00401100', 'A', '  return Helper(3);');

  it('selects a function whose every caller is in its unit', () => {
    const all = [helper, caller];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    assert.deepStrictEqual([...sel.selected.keys()], ['00401000']);
    assert.deepStrictEqual([...sel.selected.get('00401000')!.referrers], ['00401100']);
  });

  it('keeps it extern when a function of another unit calls it', () => {
    const other = fn('Other', '00402000', 'B', '  return A::Helper(4);');
    const all = [helper, caller, other];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    assert.strictEqual(sel.selected.size, 0);
    assert.deepStrictEqual(sel.refused.get('referenced from another unit'), ['Helper']);
  });

  it('keeps it extern when another unit takes its address as a literal', () => {
    const other = fn('Other', '00402000', 'B', '  Register((code *)0x401000);\n  return 0;');
    const all = [helper, caller, other];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    assert.strictEqual(sel.selected.size, 0);
  });

  it('keeps it extern when the caller is code that is not emitted', () => {
    const excluded = fn('RuntimeHook', '00403000', 'compiler', '  return Helper(5);');
    const all = [helper, caller, excluded];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf([helper, caller]), globals: [] });
    assert.deepStrictEqual(sel.refused.get('referenced from excluded code'), ['Helper']);
  });

  it('keeps it extern when nothing calls it', () => {
    const lone = fn('Lone', '00401200', 'A', '  return nValue;', { params: [inEax()] });
    const all = [lone, caller];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    assert.strictEqual(sel.selected.size, 0);
    assert.deepStrictEqual(sel.refused.get('no caller in its unit'), ['Lone']);
  });

  it('does not count a mention in a comment or a string as a call', () => {
    const mentioner = fn('Mentioner', '00401100', 'A', '  /* Helper(1) */\n  Log("Helper(2)");\n  return 0;');
    const all = [helper, mentioner];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    assert.deepStrictEqual(sel.refused.get('no caller in its unit'), ['Helper']);
  });

  it('keeps it extern when a data initializer names it', () => {
    const all = [helper, caller];
    const table: Partial<AnalyzedDataSymbol> = {
      name: 'gpfnHandlers',
      initializedData: { kind: 'array', elements: [{ kind: 'pointer', value: 'A::Helper' }] },
    };
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [table] });
    assert.deepStrictEqual(sel.refused.get('named by a data initializer'), ['Helper']);
  });

  it('keeps it extern when another symbol shares its name', () => {
    const twin = fn('Helper', '00402000', 'B', '  return 0;');
    const all = [helper, caller, twin];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    assert.deepStrictEqual(sel.refused.get('name shared with another symbol'), ['Helper']);
  });

  it('counts emitted code beside the decompile as a reference', () => {
    const other = fn('Other', '00402000', 'B', '  return 0;');
    const all = [helper, caller, other];
    const sel = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [],
      extraReferenceText: f => (f.name === 'Other' ? 'return A::Helper(9);' : undefined),
    });
    assert.deepStrictEqual(sel.refused.get('referenced from another unit'), ['Helper']);
  });

  it('keeps it extern when hand-written source names it by qualified name', () => {
    const all = [helper, caller];
    const sel = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [],
      foreignSources: [{ path: 'support/hand.cpp', text: 'int Hook() { return A::Helper(7); }' }],
    });
    assert.strictEqual(sel.selected.size, 0);
    assert.deepStrictEqual(sel.refused.get('named by foreign source'), ['Helper']);
  });

  it('does not count a foreign mention in a comment or a string', () => {
    const all = [helper, caller];
    const sel = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [],
      foreignSources: [{ path: 'support/hand.cpp', text: '// Helper(1)\nconst char *s = "Helper";' }],
    });
    assert.deepStrictEqual([...sel.selected.keys()], ['00401000']);
  });

  it('reads the names out of a mangled symbol in foreign assembly', () => {
    const all = [helper, caller];
    const sel = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [],
      foreignSources: [{ path: 'support/link.s', text: '\t.globl\t__ZN1A6HelperEi\n\tjmp\t__ZN1A6HelperEi\n' }],
    });
    assert.deepStrictEqual(sel.refused.get('named by foreign source'), ['Helper']);
  });

  it('reads foreign integer literals as addresses only with an address base', () => {
    const all = [helper, caller];
    const text = 'inline GameAsmFunc ClickHelper_I{0x1000};';
    const without = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [], foreignSources: [{ path: 'imports.h', text }],
    });
    assert.deepStrictEqual([...without.selected.keys()], ['00401000']);
    const withBase = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [],
      foreignSources: [{ path: 'imports.h', text, addressBase: 0x400000 }],
    });
    assert.deepStrictEqual(withBase.refused.get('named by foreign source'), ['Helper']);
  });

  it('reads a foreign directory recursively, sources only, in sorted order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-'));
    try {
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'b.cpp'), 'B();');
      fs.writeFileSync(path.join(dir, 'a.h'), 'A();');
      fs.writeFileSync(path.join(dir, 'README.md'), 'Helper');
      fs.writeFileSync(path.join(dir, 'sub', 'c.s'), 'call C');
      const read = readForeignSources([{ path: path.basename(dir) }, { path: path.join(dir, 'b.cpp'), addressBase: '0x400000' }], path.dirname(dir));
      assert.deepStrictEqual(read.map(r => path.relative(dir, r.path)), ['a.h', 'b.cpp', path.join('sub', 'c.s'), 'b.cpp']);
      assert.deepStrictEqual(read.map(r => r.addressBase), [undefined, undefined, undefined, 0x400000]);
      assert.throws(() => readForeignSources([{ path: path.join(dir, 'missing') }], dir), /does not exist/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a function with only stack and convention registers', () => {
    const plain = fn('Plain', '00401300', 'A', '  return nValue;', { params: [onStack()] });
    const user = fn('User', '00401400', 'A', '  return Plain(1);');
    const all = [plain, user];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    assert.strictEqual(sel.candidates, 0);
  });
});

describe('file-static emission', () => {
  const options: ReconstructOptions = {
    outputDir: './out',
    format: 'cpp',
    organization: 'namespace',
    generateCMake: false,
    generateSourceMaps: false,
    transformPreset: 'quick',
    includeAddressComments: false,
    promoteStaticGlobals: false,
  };
  const programInfo: ProgramInfo = {
    name: 'Static.exe', path: '/tmp/Static.exe', format: 'PE', architecture: 'x86', compiler: 'msvc',
    imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
  };

  it('defines the function static, declares it ahead of an earlier caller, and leaves it out of the header', () => {
    const functions = [
      fn('EarlyCaller', '0x401000', 'Alpha', '  return LocalHelper(1);'),
      fn('LocalHelper', '0x401100', 'Alpha', '  return nValue * 2;', { params: [inEax()] }),
      fn('SharedHelper', '0x401200', 'Alpha', '  return nValue * 3;', { params: [inEax()] }),
      fn('LateCaller', '0x401300', 'Alpha', '  return SharedHelper(2);'),
      fn('Outsider', '0x402000', 'Beta', '  return Alpha::SharedHelper(3);'),
    ];
    const namespaces: ExtractedNamespace[] = [
      { name: 'Alpha', fullPath: 'Alpha', functionCount: 4, isClass: false },
      { name: 'Beta', fullPath: 'Beta', functionCount: 1, isClass: false },
    ];
    const project = generateProject('static', functions, [], [], [], namespaces, options, programInfo);
    const file = (suffix: string) => [...project.files.values()].find(f => f.path.endsWith(suffix))!.content;
    const header = file('Alpha.h');
    const impl = file('Alpha.cpp');

    assert.ok(!/\bLocalHelper\s*\(/.test(header), `header must not declare LocalHelper:\n${header}`);
    assert.ok(/\bSharedHelper\s*\(/.test(header), 'SharedHelper is called from Beta: still declared');

    const forward = impl.search(/^static int __stdcall LocalHelper\(int nValue\);$/m);
    const caller = impl.search(/\bEarlyCaller\s*\(/);
    const definition = impl.search(/^static int __stdcall LocalHelper\(int nValue\) \{$/m);
    assert.ok(forward >= 0, `forward declaration missing:\n${impl}`);
    assert.ok(definition >= 0, `static definition missing:\n${impl}`);
    assert.ok(forward < caller && caller < definition, 'declared before its first caller, defined after it');
    assert.ok(!/static[^\n]*SharedHelper/.test(impl), 'SharedHelper keeps external linkage');
  });
});
