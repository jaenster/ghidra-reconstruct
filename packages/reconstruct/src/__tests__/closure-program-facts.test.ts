/**
 * Whole-program facts reach closure-admitted functions.
 *
 * A function in an excluded namespace that kept code calls is admitted after
 * decompilation and emitted like any other. The program-wide scripts (operand
 * references, PUSH slots, SEH frames, call-site overrides) must therefore see it:
 * the live daemon's per-function re-read attaches those facts, so a full extraction
 * that skipped them produced a model the rolling verifier flagged as stale
 * (`__security_check_cookie` 00681a48 and every other admitted CRT function).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { extractAllFunctions } from '../extract/functions.js';
import type { GhidraConnection } from '../types.js';

function fakeConnection(): GhidraConnection {
  const listed = [
    { name: 'GAME_Start', address: '0x401000', namespace: 'Global' },
    { name: '__security_check_cookie', address: '0x681a48', namespace: 'CRT' },
  ];
  return {
    sessionId: 'test',
    async close() {},
    async sendCommand<T>(command: string, params?: Record<string, unknown>): Promise<T> {
      if (command === 'list_functions') {
        const all = listed.map(f => ({
          ...f,
          signature: `void ${f.name}(void)`,
          returnType: 'void',
          callingConvention: 'cdecl',
          size: 16,
          isThunk: false,
          isExternal: false,
          hasVarArgs: false,
        }));
        const offset = Number(params?.offset ?? 0);
        const limit = Number(params?.limit ?? 100);
        return { functions: all.slice(offset, offset + limit), total: all.length } as T;
      }
      if (command === 'batch_decompile') {
        const addresses = params?.addresses as string[];
        const body = (a: string): string => a === '0x401000'
          ? 'void GAME_Start(void)\n{\n  CRT::__security_check_cookie();\n  return;\n}\n'
          : 'void __security_check_cookie(void)\n{\n  return;\n}\n';
        return {
          results: addresses.map(address => ({ functionName: 'x', address, signature: 'void x(void)', pseudocode: body(address) })),
          failed: [], total: addresses.length, decompiled: addresses.length,
        } as T;
      }
      if (command === 'execute_script') {
        const code = String(params?.code ?? '');
        // Only the operand-reference script answers; the others report no output.
        if (code.includes('getReferencesFrom') && code.includes('__FUNCTIONS__') === false && code.includes('isOffsetReference')) {
          return {
            success: true,
            output: 'F\t00401000\nR\t00401004\t1\t00749de0\tREAD\t1\nF\t00681a48\nR\t00681a48\t1\t00749de0\tREAD\t1\n',
          } as T;
        }
        return { success: false, error: 'not faked' } as T;
      }
      throw new Error(`unexpected command ${command}`);
    },
  };
}

describe('whole-program facts and the exclusion closure', () => {
  it('attaches operand references to a function the closure admits', async () => {
    const functions = await extractAllFunctions(fakeConnection(), { decompile: true, excludePatterns: ['CRT'] });
    const admitted = functions.find(f => f.name === '__security_check_cookie');
    assert.ok(admitted, 'the CRT function kept code calls is admitted');
    assert.equal(admitted.excludedNamespaceReachable, true);
    assert.deepEqual(admitted.operandRefs?.refs.map(r => r.to), ['00749de0']);
    const kept = functions.find(f => f.name === 'GAME_Start');
    assert.deepEqual(kept?.operandRefs?.refs.map(r => r.to), ['00749de0']);
  });
});
