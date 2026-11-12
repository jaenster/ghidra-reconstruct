/** Exact live CrashGame 00407970 decompile, isolated from the full Fog snapshot. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { generateProject } from '../codegen/index.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import type { AnalyzedDataSymbol, ExtractedFunction, ReconstructOptions } from '../types.js';

const decompiled = `/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */
/* Diablo 2 1.14d reverse team
   https://blizzhackers.dev */

void Fog::Src::ErrorManager::CrashGame(void)

{
  _DAT_00000000 = 0;
  return;
}
`;
const form = `nullfault32();ev=0000000000;bh=5-f8b0e2a8;dh=${vc8formBodyHash(decompiled)}`;
const options = { outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'full' } as ReconstructOptions;
const programInfo = { name: 'Game.exe', path: '/tmp/Game.exe', format: 'PE', architecture: 'x86', compiler: 'msvc',
  imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4 } as never;

function emitted(tag: 'current' | 'absent' | 'stale'): string {
  const fn = {
    name: 'CrashGame', address: '00407970', namespace: 'Fog::Src::ErrorManager',
    returnType: 'void', callingConvention: '__stdcall', size: 5,
    signature: 'void __stdcall CrashGame(void)', parameters: [], localVariables: [],
    decompiled, isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
    tags: tag === 'absent' ? [] : [{ type: 'vc8form', data: tag === 'current' ? form : form.replace(/dh=[0-9a-f]+/, 'dh=deadbeef') }],
  } as unknown as ExtractedFunction;
  const global = { name: '_DAT_00000000', suggestedName: '_DAT_00000000', address: '00000000', dataType: 'undefined1',
    suggestedType: 'undefined1', size: 1, scope: 'global', isInitialized: false, xrefCount: 1, referencingFunctions: ['CrashGame'] } as unknown as AnalyzedDataSymbol;
  const namespaces = [{ name: 'Fog::Src::ErrorManager', fullPath: 'Fog::Src::ErrorManager', functionCount: 1, isClass: false }];
  const project = generateProject('CrashGame', [fn], [], [], [global], namespaces as never, options, programInfo);
  return [...project.files.values()].filter(f => f.path.endsWith('.cpp')).map(f => f.content).join('\n');
}

describe('CrashGame live nullfault32 vc8form fixture', () => {
  it('emits the pointer-local volatile dword fault only with a current tag', () => {
    const current = emitted('current');
    const absent = emitted('absent');
    const stale = emitted('stale');
    assert.match(absent, /\*\(volatile uint8_t\*\)0x0 = 0;/);
    assert.equal(stale, absent);
    assert.match(current, /volatile uint32_t\s*\*\s*pNull = 0;/);
    assert.match(current, /\*pNull = \(uint32_t\)\(uintptr_t\)pNull;/);
    assert.doesNotMatch(current, /\*\(volatile uint8_t\*\)0x0 = 0;/);
    const target = /void __stdcall CrashGame\(\) \{([^}]*)\}/.exec(current)?.[1];
    assert.ok(target);
    assert.equal(target.replace(/\s+/g, ''), 'volatileuint32_t*pNull=0;*pNull=(uint32_t)(uintptr_t)pNull;');
    if (process.env.CRASHGAME_EMIT_PATH) writeFileSync(process.env.CRASHGAME_EMIT_PATH, current);
  });
});
