import { describe, it } from 'node:test';
import assert from 'node:assert';

import { applyEvents, buildIndices, type ChangeEvent, type LiveModel } from '../model.js';
import { LIVE_EXTRACTION_OPTIONS } from '../exclude-patterns.js';
import { factsScriptOutput } from './fake-facts.js';

/**
 * v2021 touched 5181 of 14916 functions, so the daemon took the full re-extraction
 * (`refreshAllFunctions`). The model's options carried no `excludePatterns`, so that
 * listing admitted every excluded-namespace function: 661 `compiler`/`_Wrappers`/
 * `UnDecorator` records the batch extraction never keeps. The generator then declared
 * the CRT's winsock callees as C++ functions in globals.h and the link failed on three
 * undefined symbols. The escalation must yield the batch extraction's function set: the
 * kept functions, plus an excluded one only where a kept body reaches it.
 */

interface Fn { address: string; name: string; namespace: string; body: string }

const PROGRAM: Fn[] = [
  { address: '00401000', name: 'GAME_Tick', namespace: 'D2Game', body: 'void GAME_Tick(void)\n{\n  _memset(0,0,0);\n}\n' },
  { address: '00402000', name: 'CLIENT_Draw', namespace: 'D2Client', body: 'void CLIENT_Draw(void)\n{\n}\n' },
  { address: '00403000', name: 'FOG_Alloc', namespace: 'Fog', body: 'void FOG_Alloc(void)\n{\n}\n' },
  // Excluded namespaces: one a kept body calls, two nobody calls.
  { address: '00681000', name: '_memset', namespace: 'compiler', body: 'void _memset(int a,int b,int c)\n{\n}\n' },
  { address: '00681c95', name: '__cinit', namespace: 'compiler', body: 'void __cinit(void)\n{\n}\n' },
  { address: '00690000', name: 'UnDecorator_getName', namespace: 'UnDecorator', body: 'void UnDecorator_getName(void)\n{\n}\n' },
];

function info(f: Fn) {
  return {
    name: f.name, address: f.address, namespace: f.namespace, signature: `void ${f.name}(void)`,
    returnType: 'void', parameters: [], localVariables: [], callingConvention: '__cdecl', size: 16,
  };
}

function fakeGhidra() {
  const client = {
    async sendCommand(cmd: string, params: Record<string, unknown> = {}) {
      switch (cmd) {
        case 'list_functions': {
          const offset = Number(params.offset ?? 0), limit = Number(params.limit ?? 100);
          return { functions: PROGRAM.slice(offset, offset + limit).map(info), total: PROGRAM.length };
        }
        case 'get_function_info': {
          const fn = PROGRAM.find(f => f.address === params.address);
          if (!fn) throw new Error('no function');
          return info(fn);
        }
        case 'batch_decompile': {
          const addresses = params.addresses as string[];
          return { results: PROGRAM.filter(f => addresses.includes(f.address)).map(f => ({ address: f.address, pseudocode: f.body })), failed: [] };
        }
        case 'decompile': {
          const fn = PROGRAM.find(f => f.address === params.address);
          return { pseudocode: fn?.body ?? '' };
        }
        case 'execute_script': {
          if (factsScriptOutput(params.code) !== null) return { success: true, output: factsScriptOutput(params.code)! };
          return { success: true, output: '' };
        }
        default: return {};
      }
    },
  };
  return client as never;
}

/** The model the batch regen wrote: the kept functions and the one reachable CRT callee. */
function batchModel(): LiveModel {
  const kept = PROGRAM.filter(f => f.namespace !== 'UnDecorator' && f.name !== '__cinit');
  return {
    seq: 0,
    options: { ...LIVE_EXTRACTION_OPTIONS },
    primary: {
      functions: kept.map(f => ({ name: f.name, namespace: f.namespace, address: f.address, calledFunctions: [], decompiled: f.body })),
      globals: [], dataTypes: [],
    },
  } as unknown as LiveModel;
}

describe('the full re-extraction keeps the batch extraction\'s function set', () => {
  it('admits no excluded-namespace function a kept body does not reach', async () => {
    const m = batchModel();
    const before = m.primary.functions.map(f => f.address).sort();
    // Two of four functions changed: past the escalation threshold.
    const events: ChangeEvent[] = ['00401000', '00402000'].map((key, i) =>
      ({ seq: 2021000001 + i, kind: 'function.changed', target: 'function', key }) as ChangeEvent);
    const result = await applyEvents(m, buildIndices(m), events, fakeGhidra());
    assert.equal(result.escalatedToFullDecompile, true, 'the test must drive the full re-extraction');
    assert.deepStrictEqual(m.primary.functions.map(f => f.address).sort(), before);
  });

  it('the daemon and the codegen child extract with the same exclusions', () => {
    assert.ok(LIVE_EXTRACTION_OPTIONS.excludePatterns && LIVE_EXTRACTION_OPTIONS.excludePatterns.length > 0);
    assert.ok(LIVE_EXTRACTION_OPTIONS.excludePatterns.some(p => p instanceof RegExp && p.test('compiler')));
  });
});
