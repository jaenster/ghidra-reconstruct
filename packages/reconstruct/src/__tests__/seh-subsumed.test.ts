/**
 * A lowered `__finally` replaces its block's function and its scope table.
 * v1410: SOUNDUTIL_ReadVersionResource @00516ac0 - the block @00516c01 was emitted
 * standalone with the parent's EBP as a "parameter", and the scope table
 * gaSoundUtilReadVersionScopeTable @007011b0 named the termination-handler label
 * `SOUNDUTIL_ReadVersionResource_finally`, which nothing declares.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { sehSubsumedSymbols, normaliseAddress } from '../codegen/seh-subsumed.js';
import type { ExtractedFunction } from '../types.js';

const FRAME = {
  kind: 'eh3', scopeTable: '007011b0', handlerSymbol: '_except_handler3',
  entries: [{ level: 0, enclosingLevel: -1, handler: '00516bfc', filterCode: [], handlerCode: [
    { address: '00516bfc', inParent: false, text: 'XOR EBX,EBX' },
    { address: '00516bfe', inParent: false, text: 'MOV EDI,dword ptr [EBP + -0x1c]' },
    { address: '00516c01', inParent: false, text: 'CALL dword ptr [0x006cc1b4]' },
  ] }],
  tryLevelStores: { '-1': 1, reg: 1 },
  afterStores: { '00516bda': { level: '-1', code: [
    { address: '00516be1', text: 'CALL 0x00516c01', callTarget: '00516c01' },
    { address: '00516be6', text: 'MOV EAX,dword ptr [EBP + -0x2c]' },
    { address: '00516be9', text: 'MOV ECX,dword ptr [EBP + -0x10]' },
    { address: '00516bec', text: 'MOV dword ptr FS:[0x0],ECX' },
  ] } },
};

const fn = (name: string, address: string, extra: Partial<ExtractedFunction> = {}): ExtractedFunction => ({
  name, address, signature: '', returnType: 'void', parameters: [], localVariables: [], namespace: 'D2Sound::D2SoundUntil',
  callingConvention: '__cdecl', size: 8, isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
  decompiled: '', ...extra,
} as ExtractedFunction);

describe('what a lowered SEH frame subsumes', () => {
  it('the __finally body and the scope table', () => {
    const parent = fn('SOUNDUTIL_ReadVersionResource', '00516ac0', { sehFrame: FRAME as never });
    const body = fn('SOUNDUTIL_CleanupFileMapping', '00516c01');
    const s = sehSubsumedSymbols([parent, body, fn('Other', '00516c40', { decompiled: 'void Other(void) { f(); }' })]);
    assert.deepStrictEqual([...s.finallyBodies], ['516c01']);
    assert.deepStrictEqual([...s.scopeTables], ['7011b0']);
  });

  it('a __finally body another function calls keeps its definition', () => {
    const parent = fn('SOUNDUTIL_ReadVersionResource', '00516ac0', { sehFrame: FRAME as never });
    const body = fn('SOUNDUTIL_CleanupFileMapping', '00516c01');
    const caller = fn('Other', '00516c40', { decompiled: 'void Other(void) { SOUNDUTIL_CleanupFileMapping(); }' });
    assert.deepStrictEqual([...sehSubsumedSymbols([parent, body, caller]).finallyBodies], []);
  });

  it('normalises the address spellings', () => {
    assert.strictEqual(normaliseAddress('Game.exe.ram:00516C01'), '516c01');
    assert.strictEqual(normaliseAddress('0x00516c01'), '516c01');
  });
});
