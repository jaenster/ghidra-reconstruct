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
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import { parseVc8LinkageTag, vc8LinkageVerdict } from '../codegen/vc8-linkage.js';
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
        { ...onStack('c'), ordinal: 2 },
      ],
    }), []);
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__fastcall_edxsafe',
      parameters: [{ name: 'a', dataType: 'int', size: 4, ordinal: 0, storage: 'ESI:4' }],
    }), ['ESI']);
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__thiscall',
      parameters: [{ name: 'this', dataType: 'Obj *', size: 4, ordinal: 0, storage: 'ECX:4' }, { ...onStack('b'), ordinal: 1 }],
    }), []);
  });

  it('compares a program-defined model with the fastcall its storage is spelled as', () => {
    // ITEMMODE_GetAlternateBodyLoc 0055f240: `lea eax, [ecx-4]`, called with ECX loaded.
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__stdcall_edxsafe',
      parameters: [{ name: 'eBodyLoc', dataType: 'int', size: 4, ordinal: 0, storage: 'ECX:4' }],
    }), []);
    // _oldSaveGameLoadingPart8_part1_part1 00533a70: `movzx eax, cx`, `cmp edx, 0x31`.
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__stdcall_ecxedxsafe',
      parameters: [
        { name: 'wHirelingId', dataType: 'undefined2', size: 2, ordinal: 0, storage: 'CX:2' },
        { name: 'nLevel', dataType: 'int', size: 4, ordinal: 1, storage: 'EDX:4' },
      ],
    }), []);
    // Storage no stock convention describes keeps the model's base.
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__stdcall_edxsafe',
      parameters: [{ name: 'p', dataType: 'int', size: 4, ordinal: 0, storage: 'EAX:4' }],
    }), ['EAX']);
    // A stock name is compared as named.
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__stdcall',
      parameters: [{ name: 'p', dataType: 'int', size: 4, ordinal: 0, storage: 'ECX:4' }],
    }), ['ECX']);
  });

  it('names EDX in a fastcall that passes nothing in ECX', () => {
    // init_block (0042b9e0): __fastcall, its one parameter in EDX.
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__fastcall',
      parameters: [{ name: 's', dataType: 'deflate_state *', size: 4, ordinal: 0, storage: 'EDX:4' }],
    }), ['EDX']);
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__fastcall',
      parameters: [
        { name: 'b', dataType: 'uint8_t', size: 1, ordinal: 0, storage: 'DL:1' },
        { name: 'q', dataType: 'void *', size: 4, ordinal: 1, storage: 'Stack[0x4]:4' },
      ],
    }), ['EDX']);
  });

  it('leaves a fastcall alone that uses ECX, whatever order Ghidra lists its parameters in', () => {
    // A receiver in ECX listed last is the thiscall shape, not a convention of its own.
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__fastcall',
      parameters: [
        { name: 'a', dataType: 'int', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' },
        { name: 'node', dataType: 'void *', size: 4, ordinal: 1, storage: 'ECX:4' },
      ],
    }), []);
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__fastcall',
      parameters: [
        { name: 'a', dataType: 'int', size: 4, ordinal: 0, storage: 'EDX:4' },
        { name: 'b', dataType: 'int', size: 4, ordinal: 1, storage: 'ECX:4' },
      ],
    }), []);
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__thiscall',
      parameters: [{ name: 'p', dataType: 'int', size: 4, ordinal: 0, storage: 'EDX:4' }],
    }), ['EDX']);
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

  it('selects a fastcall function whose one parameter is in EDX, and not one in ECX', () => {
    const inEdx = fn('InEdx', '00401200', 'A', '  return p != 0;', {
      conv: '__fastcall', params: [{ name: 'p', dataType: 'int', size: 4, ordinal: 0, storage: 'EDX:4' }],
    });
    const inEcx = fn('InEcx', '00401300', 'A', '  return p != 0;', {
      conv: '__fastcall', params: [{ name: 'p', dataType: 'int', size: 4, ordinal: 0, storage: 'ECX:4' }],
    });
    const user = fn('User', '00401400', 'A', '  return InEdx(1) + InEcx(2);');
    const all = [inEdx, inEcx, user];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    assert.deepStrictEqual([...sel.selected.keys()], ['00401200']);
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

  it('selects a function nothing references when its unit holds its body inlined, and defines it inline', () => {
    const lone = fn('Lone', '00401200', 'A', '  return nValue;', { params: [inEax()] });
    const all = [lone, caller];
    const asked: string[] = [];
    const sel = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [],
      inlinedCalls: unreferenced => {
        asked.push(...unreferenced.map(u => `${u.func.name}@${u.unit}`));
        return new Map([['00401200', new Set(['00401100'])]]);
      },
    });
    assert.deepStrictEqual(asked, ['Lone@A']);
    assert.deepStrictEqual(sel.selected.get('00401200'), { unit: 'A', referrers: new Set(['00401100']), inline: true });
  });

  it('keeps it extern when the inlined copies are all in other units', () => {
    const lone = fn('Lone', '00401200', 'A', '  return nValue;', { params: [inEax()] });
    const elsewhere = fn('Elsewhere', '00402000', 'B', '  return 1;');
    const all = [lone, caller, elsewhere];
    const sel = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [],
      inlinedCalls: () => new Map([['00401200', new Set(['00402000'])]]),
    });
    assert.strictEqual(sel.selected.size, 0);
    assert.deepStrictEqual(sel.refused.get('no caller in its unit'), ['Lone']);
  });

  it('asks only about functions nothing references', () => {
    const all = [helper, caller];
    const asked: string[] = [];
    const sel = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [],
      inlinedCalls: unreferenced => { asked.push(...unreferenced.map(u => u.func.name)); return new Map(); },
    });
    assert.deepStrictEqual(asked, []);
    assert.strictEqual(sel.selected.get('00401000')!.inline, undefined);
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

  it('tells a shared name apart by the namespace each mention prints', () => {
    const own = fn('Helper', '00401000', 'A::X', '  return nValue + 1;', { params: [inEax()] });
    const user = fn('Caller', '00401100', 'A::X', '  return A::X::Helper(3);');
    const twin = fn('Helper', '00402000', 'B::X', '  return 0;');
    const other = fn('Other', '00402100', 'B::X', '  return B::X::Helper() + X::Helper();');
    const all = [own, user, twin, other];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    // `X::Helper` fits both: Other's unit keeps A::X::Helper extern.
    assert.deepStrictEqual(sel.refused.get('name shared with another symbol'), ['Helper']);
    const clean = fn('Other', '00402100', 'B::X', '  return B::X::Helper();');
    const all2 = [own, user, twin, clean];
    const sel2 = selectFileStaticFunctions({ allFunctions: all2, unitOf: unitsOf(all2), globals: [] });
    assert.deepStrictEqual([...sel2.selected.keys()], ['00401000']);
    assert.deepStrictEqual([...sel2.selected.get('00401000')!.referrers], ['00401100']);
  });

  it('keeps a shared name extern when another unit calls it by its namespace', () => {
    const own = fn('Helper', '00401000', 'A', '  return nValue + 1;', { params: [inEax()] });
    const user = fn('Caller', '00401100', 'A', '  return A::Helper(3);');
    const twin = fn('Helper', '00402000', 'B', '  return 0;');
    const other = fn('Other', '00402100', 'B', '  return A::Helper(1);');
    const all = [own, user, twin, other];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    assert.deepStrictEqual(sel.refused.get('referenced from another unit'), ['Helper']);
  });

  it('keeps a shared name extern when foreign source names it or a table holds it', () => {
    const own = fn('Helper', '00401000', 'A', '  return nValue + 1;', { params: [inEax()] });
    const user = fn('Caller', '00401100', 'A', '  return A::Helper(3);');
    const twin = fn('Helper', '00402000', 'B', '  return 0;');
    const all = [own, user, twin];
    const foreign = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [],
      foreignSources: [{ path: 'hand.cpp', text: 'void f() { B::Helper(); }' }],
    });
    assert.deepStrictEqual(foreign.refused.get('named by foreign source'), ['Helper']);
    const table: Partial<AnalyzedDataSymbol> = {
      name: 'gpfnHandlers',
      initializedData: { kind: 'array', elements: [{ kind: 'pointer', value: 'A::Helper' }] },
    };
    const data = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [table] });
    assert.deepStrictEqual(data.refused.get('named by a data initializer'), ['Helper']);
    const twinTable: Partial<AnalyzedDataSymbol> = {
      name: 'gpfnOthers',
      initializedData: { kind: 'array', elements: [{ kind: 'pointer', value: 'B::Helper' }] },
    };
    const none = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [twinTable] });
    assert.deepStrictEqual([...none.selected.keys()], ['00401000']);
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

  it('makes it static when hand-written source calls it only through its extern entry', () => {
    const all = [helper, caller];
    const sel = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [],
      foreignSources: [{ path: 'support/hand.cpp', text: 'int Hook() { return A::Helper_Extern(7); }' }],
    });
    assert.deepStrictEqual([...sel.selected.keys()], ['00401000']);
    assert.deepStrictEqual([...sel.externEntries], ['00401000']);
    assert.strictEqual(sel.refused.get('named by foreign source'), undefined);
  });

  it('keeps it extern when foreign source also names it directly, and still emits the entry', () => {
    const all = [helper, caller];
    const sel = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [],
      foreignSources: [{ path: 'support/hand.cpp', text: 'int Hook() { return A::Helper_Extern(7) + A::Helper(1); }' }],
    });
    assert.strictEqual(sel.selected.size, 0);
    assert.deepStrictEqual(sel.refused.get('named by foreign source'), ['Helper']);
    assert.deepStrictEqual([...sel.externEntries], ['00401000']);
  });

  it('keeps it extern when a binder imports it by address, whatever else calls the entry', () => {
    const all = [helper, caller];
    const sel = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [],
      foreignSources: [
        { path: 'support/hand.cpp', text: 'int Hook() { return A::Helper_Extern(7); }' },
        { path: 'imports.h', text: 'inline GameAsmFunc Helper_I{0x1000};', addressBase: 0x400000 },
      ],
    });
    assert.strictEqual(sel.selected.size, 0);
    assert.deepStrictEqual(sel.refused.get('named by foreign source'), ['Helper']);
  });

  it('gives no entry whose address foreign code takes: a call redirect would miss the unit', () => {
    const all = [helper, caller];
    const sel = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [],
      foreignSources: [{ path: 'support/patch.cpp', text: 'void P() { Redirect((void*)&A::Helper_Extern); A::Helper_Extern(1); }' }],
    });
    assert.strictEqual(sel.externEntries.size, 0);
    assert.deepStrictEqual([...sel.selected.keys()], ['00401000']);
  });

  it('gives no entry when a symbol already has the entry name', () => {
    const taken = fn('Helper_Extern', '00401500', 'B', '  return 0;');
    const all = [helper, caller, taken];
    const sel = selectFileStaticFunctions({
      allFunctions: all, unitOf: unitsOf(all), globals: [],
      foreignSources: [{ path: 'support/hand.cpp', text: 'int Hook() { return A::Helper_Extern(7); }' }],
    });
    assert.strictEqual(sel.externEntries.size, 0);
  });

  it('ignores a function with only stack and convention registers', () => {
    const plain = fn('Plain', '00401300', 'A', '  return nValue;', { params: [onStack()] });
    const user = fn('User', '00401400', 'A', '  return Plain(1);');
    const all = [plain, user];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    assert.strictEqual(sel.candidates, 0);
  });
});

describe('registers the original leaves unread are no convention of its own', () => {
  // The original enters these 1.14d functions reading ECX and not EDX with stack
  // arguments (`ret N`), or EDX and not ECX. Their storage is the declared convention's
  // own placement, a parameter left unused or a receiver in ECX: compiled extern they
  // match the original byte for byte, so nothing says they were static.
  const p = (name: string, dataType: string, ordinal: number, storage: string): ExtractedParameter =>
    ({ name, dataType, size: 4, ordinal, storage });

  it('leaves a receiver in ECX and the rest on the stack extern', () => {
    // TSGrowableArray_Ui_CalcChunkSize 004210a0, MATCH extern (emitted __thiscall).
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__fastcall',
      parameters: [p('this', 'BigBuffer *', 0, 'ECX:4'), p('nValue', 'uint32_t', 1, 'Stack[0x4]:4')],
    }), []);
  });

  it('leaves a fastcall extern whose EDX parameter is unused', () => {
    // Missiles_SrvDmgFunc_ConvertColdLengthToFreezeLength 005ad290, a table callback: the
    // original never reads pMissile (EDX). MATCH extern.
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__fastcall',
      parameters: [
        p('pGame', 'SGAMEDATA *', 0, 'ECX:4'), p('pMissile', 'D2UnitStrc *', 1, 'EDX:4'),
        p('pTarget', 'D2UnitStrc *', 2, 'Stack[0x4]:4'), p('pDamage', 'D2DamageStrc *', 3, 'Stack[0x8]:4'),
      ],
    }), []);
  });

  it('leaves a fastcall extern whose ECX parameter is unused', () => {
    // AUTOMAP_RotateCellRight 00457860: dwUnused in ECX, never read. MATCH extern.
    assert.deepStrictEqual(foreignParameterRegisters({
      callingConvention: '__fastcall',
      parameters: [p('dwUnused', 'undefined4', 0, 'ECX:4'), p('ppRootNode', 'D2AutomapCellStrc * *', 1, 'EDX:4')],
    }), []);
  });
});

describe('vc8linkage tags', () => {
  const body = (name: string): string => `int __stdcall ${name}(int nValue)\n{\n  return nValue;\n}\n`;
  const tag = (linkage: string, decompiled: string, size = 0x20): { type: string; data: string } =>
    ({ type: 'vc8linkage', data: `${linkage};ev=0123456789;bh=${size}-89abcdef;dh=${vc8formBodyHash(decompiled)}` });

  it('parses a record and refuses a malformed one', () => {
    assert.deepStrictEqual(parseVc8LinkageTag('extern;ev=0123456789;bh=32-89abcdef;dh=01234567'),
      { linkage: 'extern', size: 32, body: '01234567' });
    assert.strictEqual(parseVc8LinkageTag('inline;ev=0123456789;bh=32-89abcdef;dh=01234567'), undefined);
    assert.strictEqual(parseVc8LinkageTag('static;ev=0123;bh=32-89abcdef;dh=01234567'), undefined);
    assert.strictEqual(parseVc8LinkageTag('static;ev=0123456789;bh=32-89abcdef'), undefined);
  });

  it('applies a tag measured against this size and decompile, and stales any other', () => {
    const decompiled = body('F');
    assert.strictEqual(vc8LinkageVerdict({ size: 0x20, decompiled, tags: [tag('static', decompiled)] }).linkage, 'static');
    const moved = vc8LinkageVerdict({ size: 0x24, decompiled, tags: [tag('static', decompiled)] });
    assert.strictEqual(moved.linkage, undefined);
    assert.match(moved.stale[0].why, /^size 36/);
    const retyped = vc8LinkageVerdict({ size: 0x20, decompiled: body('G'), tags: [tag('extern', decompiled)] });
    assert.strictEqual(retyped.linkage, undefined);
    assert.match(retyped.stale[0].why, /^decompile /);
  });

  it('stales two tags that disagree', () => {
    const decompiled = body('F');
    const v = vc8LinkageVerdict({ size: 0x20, decompiled, tags: [tag('static', decompiled), tag('extern', decompiled)] });
    assert.strictEqual(v.linkage, undefined);
    assert.strictEqual(v.stale.length, 2);
  });

  it('keeps a function its storage selects extern when the oracle measured it so', () => {
    const helper = fn('Helper', '00401000', 'A', '  return nValue + 1;', { params: [inEax()] });
    helper.tags = [tag('extern', helper.decompiled!)];
    const caller = fn('Caller', '00401100', 'A', '  return Helper(3);');
    const all = [helper, caller];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    assert.strictEqual(sel.selected.size, 0);
    assert.deepStrictEqual(sel.refused.get('measured extern by the VC8 oracle'), ['Helper']);
  });

  it('selects a function its storage does not when the oracle measured it static', () => {
    const plain = fn('Plain', '00401300', 'A', '  return nValue;', { params: [onStack()] });
    plain.tags = [tag('static', plain.decompiled!)];
    const user = fn('User', '00401400', 'A', '  return Plain(1);');
    const all = [plain, user];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    assert.deepStrictEqual([...sel.selected.keys()], ['00401300']);
    assert.strictEqual(sel.measuredStatic, 1);
  });

  it('still keeps a measured-static function extern when another unit calls it', () => {
    const plain = fn('Plain', '00401300', 'A', '  return nValue;', { params: [onStack()] });
    plain.tags = [tag('static', plain.decompiled!)];
    const user = fn('User', '00401400', 'B', '  return Plain(1);');
    const all = [plain, user];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    assert.strictEqual(sel.selected.size, 0);
    assert.deepStrictEqual(sel.refused.get('referenced from another unit'), ['Plain']);
  });

  it('ignores a stale tag and reports it', () => {
    const plain = fn('Plain', '00401300', 'A', '  return nValue;', { params: [onStack()] });
    plain.tags = [tag('static', plain.decompiled!, 0x40)];
    const user = fn('User', '00401400', 'A', '  return Plain(1);');
    const all = [plain, user];
    const sel = selectFileStaticFunctions({ allFunctions: all, unitOf: unitsOf(all), globals: [] });
    assert.strictEqual(sel.selected.size, 0);
    assert.strictEqual(sel.staleLinkageTags.length, 1);
    assert.strictEqual(sel.staleLinkageTags[0].name, 'Plain');
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

  // NET_D2GS_CLIENT_Send (00478350, size in EDI) is called by support/d2_control.cpp.
  it('defines the extern entry after the static and declares only the entry in the header', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-'));
    try {
      fs.mkdirSync(path.join(dir, 'support'));
      fs.writeFileSync(path.join(dir, 'support', 'hand.cpp'), 'void Hook() { Alpha::Send_Extern(p, 3); }');
      const send = fn('Send', '0x401000', 'Alpha', '  return nSize;', {
        params: [
          { name: 'pBytes', dataType: 'char *', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' },
          { name: 'nSize', dataType: 'int', size: 4, ordinal: 1, storage: 'EDI:4' },
        ],
      });
      const user = fn('SendCmd', '0x401100', 'Alpha', '  return Send((char *)0, 1);');
      const namespaces: ExtractedNamespace[] = [{ name: 'Alpha', fullPath: 'Alpha', functionCount: 2, isClass: false }];
      const project = generateProject('entry', [send, user], [], [], [], namespaces,
        { ...options, projectDir: dir, projectConfig: { foreignReferences: [{ path: 'support' }] } as ReconstructOptions['projectConfig'] },
        programInfo);
      const file = (suffix: string) => [...project.files.values()].find(f => f.path.endsWith(suffix))!.content;
      const header = file('Alpha.h');
      const impl = file('Alpha.cpp');
      assert.ok(/^static int __stdcall Send\(char \* pBytes, int nSize\) \{$/m.test(impl), `static definition missing:\n${impl}`);
      assert.ok(/^int __stdcall Send_Extern\(char \* pBytes, int nSize\) \{\n    return ::Alpha::Send\(pBytes, nSize\);\n\}$/m.test(impl),
        `entry definition missing:\n${impl}`);
      assert.ok(impl.indexOf('Send_Extern(') > impl.search(/^static int __stdcall Send\(/m), 'the entry follows the static');
      assert.ok(/^int __stdcall Send_Extern\(char \* pBytes, int nSize\);$/m.test(header), `entry not declared:\n${header}`);
      assert.ok(!/\bSend\s*\(/.test(header), 'the static itself is not declared');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // DRLGGRID_GetCellAddress (0067c4d0) and AlterGridFlag (0067c4f0): no call, the body inlined.
  it('writes the inlined call back and defines the callee static inline', () => {
    const cell = fn('GetCell', '00401000', 'Alpha', '  return gaTable[nY] + nX;', {
      params: [
        { name: 'nY', dataType: 'int', size: 4, ordinal: 0, storage: 'EAX:4' },
        { name: 'nX', dataType: 'int', size: 4, ordinal: 1, storage: 'Stack[0x4]:4' },
      ],
    });
    const alter = fn('Alter', '00401040', 'Alpha', '  return gaTable[a] + b + 1;', {
      params: [
        { name: 'a', dataType: 'int', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' },
        { name: 'b', dataType: 'int', size: 4, ordinal: 1, storage: 'Stack[0x8]:4' },
      ],
    });
    const other = fn('Other', '00401080', 'Alpha', '  return gaTable[a] - b;', {
      params: [
        { name: 'a', dataType: 'int', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' },
        { name: 'b', dataType: 'int', size: 4, ordinal: 1, storage: 'Stack[0x8]:4' },
      ],
    });
    const namespaces: ExtractedNamespace[] = [{ name: 'Alpha', fullPath: 'Alpha', functionCount: 3, isClass: false }];
    const project = generateProject('inlined', [cell, alter, other], [], [], [], namespaces, options, programInfo);
    const file = (suffix: string) => [...project.files.values()].find(f => f.path.endsWith(suffix))!.content;
    const impl = file('Alpha.cpp');
    assert.ok(/^static inline int __stdcall GetCell\(int nY, int nX\) \{$/m.test(impl), `static inline definition missing:\n${impl}`);
    assert.ok(/return GetCell\(a, b\) \+ 1;/.test(impl), `call not restored:\n${impl}`);
    assert.ok(/return gaTable\[a\] - b;/.test(impl), `an unrelated body must stay:\n${impl}`);
    assert.ok(!/\bGetCell\s*\(/.test(file('Alpha.h')), 'a static is not declared in the header');
  });
});
