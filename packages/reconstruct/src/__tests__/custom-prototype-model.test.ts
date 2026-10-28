/**
 * Regression test: a function typed with a prototype model the program defines
 * itself (`__stdcall_edxsafe`, `__fastcall_ecxsafe`, `__stdcall_ecxedxsafe`, ...)
 * must emit with the stock convention its code follows.
 *
 * Those models exist so the decompiler keeps a value a caller holds in ECX or
 * EDX across the call (0055f240, 006711a0, 0064f0f5). The emitter only knew the
 * stock names, so every function carrying one came out `__cdecl`: 17 functions
 * whose asm is `RET n` with stack arguments, or reads ECX/EDX on entry, lost
 * their convention. The storage, not the model name, says which of the two
 * callee-pops conventions applies: `GetItemQuality` is `__fastcall_ecxsafe` with
 * a stack argument and `RET 4`, `SKILLS_PopValue` is `__stdcall_ecxedxsafe` with
 * its argument in ECX and a plain `RET`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateFunctionDeclaration } from '../codegen/header.js';
import { generateEhHandlerDefinition } from '../codegen/impl.js';
import { abiConvention, conventionKeyword } from '../codegen/calling-convention.js';
import { buildFuncPtrArgCastTables } from '../codegen/index.js';
import type { ExtractedFunction, ExtractedFunctionDefinition, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'flat',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

function fn(name: string, callingConvention: string, storage: string[], returnType = 'int'): ExtractedFunction {
  return {
    name,
    address: '0x00000000',
    signature: `${returnType} ${name}()`,
    returnType,
    parameters: storage.map((s, i) => ({ name: `p${i}`, dataType: 'int', size: 4, ordinal: i, storage: s })),
    localVariables: [],
    callingConvention,
    size: 32,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
  };
}

/** The 17, as Game.exe v1757 types them: model and parameter storage. */
const SEVENTEEN: ReadonlyArray<[string, string, string, string[], string]> = [
  ['00483ab0', 'IsInInventoryScreenRange', '__fastcall_ecxedxsafe', ['ECX:4', 'EDX:4'], '__fastcall'],
  ['004b1980', 'NPCMENU_AddHandledMessageId', '__fastcall_ecxedxsafe', ['CX:2'], '__fastcall'],
  ['005284f0', 'SRP_IsContextInitialized', '__fastcall_ecxsafe', ['ECX:4'], '__fastcall'],
  ['006281e0', 'ITEM_GetItemData_nItemLevel', '__stdcall_edxsafe', ['Stack[0x4]:4'], '__stdcall'],
  ['00486e10', 'INV_IsMouseOverCloseButton', '__fastcall_edxsafe', ['ECX:4', 'EDX:4'], '__fastcall'],
  ['00529f50', 'SHA1_Init', '__fastcall_ecxedxsafe', ['ECX:4'], '__fastcall'],
  ['0055ca00', 'ITEMMODE_CheckQuestItemCodePair', '__fastcall_edxsafe', ['ECX:4', 'EDX:4', 'Stack[0x4]:4', 'Stack[0x8]:4'], '__fastcall'],
  ['00627e70', 'GetItemQuality', '__fastcall_ecxsafe', ['Stack[0x4]:4'], '__stdcall'],
  ['0062a8d0', 'ITEM_GetItemData_eD2ItemFlag_IsEthereal', '__stdcall_ecxedxsafe', ['Stack[0x4]:4'], '__stdcall'],
  ['0064a280', 'GetSkillId', '__stdcall_ecxedxsafe', ['Stack[0x4]:4'], '__stdcall'],
  ['00658460', 'MONSTERTBLS_GetMonSeqFrameCount', '__fastcall_edxsafe', ['ECX:4', 'EDX:4'], '__fastcall'],
  ['006c0ba0', 'SKILLS_PopValue', '__stdcall_ecxedxsafe', ['ECX:4'], '__fastcall'],
  ['00627f80', 'GetMagicSuffix', '__stdcall_edxsafe', ['Stack[0x4]:4', 'Stack[0x8]:4'], '__stdcall'],
  ['005a0180', 'CheckMonsterType', '__fastcall_edxsafe', ['ECX:4', 'DX:2'], '__fastcall'],
  ['006280a0', 'CheckItemFlag', '__stdcall_ecxedxsafe', ['Stack[0x4]:4', 'Stack[0x8]:4', 'Stack[0xc]:4', 'Stack[0x10]:4'], '__stdcall'],
  ['00643690', 'TXT_Skills_GetPassiveState', '__stdcall_edxsafe', ['Stack[0x4]:4'], '__stdcall'],
  ['0064f020', 'COMPOSIT_GetItemTypeIndex', '__stdcall_edxsafe', ['Stack[0x4]:4'], '__stdcall'],
];

describe('program-defined prototype models are spelled as the stock convention they follow', () => {
  for (const [addr, name, model, storage, expected] of SEVENTEEN) {
    it(`${addr} ${name} (${model}) is ${expected}`, () => {
      const f = fn(name, model, storage);
      assert.strictEqual(conventionKeyword(f), expected);
      assert.match(generateFunctionDeclaration(f, options), new RegExp(`int ${expected} ${name}\\(`));
      assert.match(generateEhHandlerDefinition(f), new RegExp(`int ${expected} ${name}\\(`));
    });
  }

  it('keeps the base the model is named after when the storage fits neither convention', () => {
    // A file-static function's own register convention (EAX, ESI, ST0).
    assert.strictEqual(conventionKeyword(fn('SFILE_CheckArchiveHandle', '__stdcall_ecxedxsafe', ['ECX:4', 'EAX:4'])), '__stdcall');
    assert.strictEqual(conventionKeyword(fn('UI_SLIDER_GetPositionFromValue', '__fastcall_ecxsafe', ['ECX:4', 'EDX:4', 'EAX:4'])), '__fastcall');
    assert.strictEqual(conventionKeyword(fn('UNICODE_IsControlChar', '__stdcall_edxsafe', ['DL:1'])), '__stdcall');
    assert.strictEqual(conventionKeyword(fn('CRT_X87_Exp2_ST0', '__stdcall_x87safe', ['ST0:10'])), '__stdcall');
    // EDX before ECX, or a register after a stack argument, is not __fastcall.
    assert.strictEqual(conventionKeyword(fn('Swapped', '__stdcall_edxsafe', ['EDX:4', 'ECX:4'])), '__stdcall');
    assert.strictEqual(conventionKeyword(fn('Late', '__stdcall_edxsafe', ['Stack[0x4]:4', 'ECX:4'])), '__stdcall');
  });

  it('applies the parameterless rules to the convention the model resolves to', () => {
    assert.strictEqual(conventionKeyword(fn('INV_IsInteractiveMode', '__fastcall_ecxsafe', [])), '');
    assert.strictEqual(conventionKeyword(fn('GetMouseClickFlags', '__stdcall_ecxedxsafe', [])), '__stdcall');
  });

  it('leaves stock conventions exactly as before, whatever their storage', () => {
    assert.strictEqual(abiConvention(fn('A', '__fastcall', ['Stack[0x4]:4'])), '__fastcall');
    assert.strictEqual(abiConvention(fn('B', '__stdcall', ['ECX:4'])), '__stdcall');
    assert.strictEqual(abiConvention(fn('C', '__cdecl', ['Stack[0x4]:4'])), '__cdecl');
    assert.strictEqual(abiConvention(fn('D', 'unknown', [])), 'unknown');
    assert.strictEqual(abiConvention({}), undefined);
    assert.strictEqual(conventionKeyword(fn('E', '__cdecl_x87safe', ['Stack[0x4]:4'])), '');
  });

  it('records the resolved convention where a function is matched against a funcdef', () => {
    const slot: ExtractedFunctionDefinition = {
      name: 'fpMsgHandler',
      category: '/Diablo2/D2Client',
      kind: 'FUNCTION_DEFINITION',
      size: 4,
      returnType: 'void',
      parameters: [{ name: 'wMsgId', dataType: 'short', ordinal: 0 }],
      callingConvention: '__fastcall',
    };
    const f = fn('NPCMENU_AddHandledMessageId', '__fastcall_ecxedxsafe', ['CX:2'], 'void');
    const tables = buildFuncPtrArgCastTables([f], [], [slot], [slot as never]);
    assert.strictEqual(tables.functionGhidraConventions?.['NPCMENU_AddHandledMessageId'], tables.funcdefConventions?.['fpMsgHandler']);
  });
});

function hasGpp(): boolean {
  try { execFileSync('i686-w64-mingw32-g++', ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
}

describe('the rebuild keeps the value a caller holds across a safe-model call', () => {
  /**
   * COMPOSIT_ResolveWeaponClass keeps the weapon-class token in EDX across
   * GetItemTypeIndex (0064f0f5) and returns it. In source the token is a local;
   * the convention keyword changes where the argument goes and who pops it, and
   * the compiler preserves the local across the call however it allocates it.
   */
  it('compiles the callee __stdcall (RET 4, @4 decoration) and the caller still returns its token', { skip: !hasGpp() }, () => {
    const callee = fn('COMPOSIT_GetItemTypeIndex', '__stdcall_edxsafe', ['Stack[0x4]:4']);
    const popper = fn('SKILLS_PopValue', '__stdcall_ecxedxsafe', ['ECX:4']);
    const src = [
      `extern "C" ${generateFunctionDeclaration(callee, options).trim()}`,
      `extern "C" ${generateFunctionDeclaration(popper, options).trim()}`,
      'extern "C" int COMPOSIT_GetItemTypeIndex(int p0) { return p0 * 3; }',
      'extern "C" int SKILLS_PopValue(int p0) { return p0 + 1; }',
      'extern "C" unsigned ResolveWeaponClass(int nType, int * pnIndex, unsigned uToken) {',
      '  *pnIndex = COMPOSIT_GetItemTypeIndex(nType);',
      '  *pnIndex += SKILLS_PopValue(*pnIndex);',
      '  return uToken;',
      '}',
    ].join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'safe-model-'));
    const file = join(dir, 'composit.cpp');
    const asm = join(dir, 'composit.s');
    writeFileSync(file, src);
    execFileSync('i686-w64-mingw32-g++', ['-std=c++17', '-O2', '-S', '-o', asm, file], { stdio: 'pipe' });
    const out = readFileSync(asm, 'utf8');
    assert.match(out, /_COMPOSIT_GetItemTypeIndex@4:/);
    assert.match(out, /@SKILLS_PopValue@4:/);
    assert.match(out, /ret\s+\$4/);
  });
});
