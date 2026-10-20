/**
 * A call-site override's anonymous `/auto_proto/dt_*` funcdef is spelled with the one
 * named funcdef stating the same contract (G8: dt_eb7b2831 at LoadDataForGame 0044da0c is
 * fpServerInitFunctions, void __fastcall (D2IniConfigStrc *)).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { autoProtoAliases, buildFunctionStoredAs } from '../codegen/index.js';

const SIG = 'void(D2IniConfigStrc *)';

describe('autoProtoAliases', () => {
  it('maps an override funcdef to the single named funcdef with its contract', () => {
    const out = autoProtoAliases(
      [
        { name: 'dt_eb7b2831', callingConvention: '__fastcall' },
        { name: 'fpServerInitFunctions', callingConvention: '__fastcall' },
        { name: 'fpOther', callingConvention: '__stdcall' },
      ],
      { dt_eb7b2831: SIG, fpServerInitFunctions: SIG, fpOther: SIG },
    );
    assert.deepStrictEqual(out, { dt_eb7b2831: 'fpServerInitFunctions' });
  });

  it('keeps the anonymous funcdef when two named ones state the contract', () => {
    const out = autoProtoAliases(
      [
        { name: 'dt_1ae317ea', callingConvention: '__fastcall' },
        { name: 'fpGameMechanicQuest', callingConvention: '__fastcall' },
        { name: 'fpTimerFunction', callingConvention: '__fastcall' },
      ],
      { dt_1ae317ea: SIG, fpGameMechanicQuest: SIG, fpTimerFunction: SIG },
    );
    assert.deepStrictEqual(out, {});
  });

  it('never maps across a convention or varargs difference', () => {
    const out = autoProtoAliases(
      [{ name: 'dt_00000001', callingConvention: '__cdecl', hasVarArgs: true }, { name: 'fpX', callingConvention: '__cdecl' }],
      { dt_00000001: SIG, fpX: SIG },
    );
    assert.deepStrictEqual(out, {});
  });
});

describe('buildFunctionStoredAs', () => {
  it('reads a funcdef-typed local assigned a function, and a funcdef table', () => {
    const out = buildFunctionStoredAs(
      [{
        localVariables: [{ name: 'pfnInitFunc', dataType: 'fpGameMechanicQuest *' }],
        decompiled: 'void f(void) { fpGameMechanicQuest *pfnInitFunc;\n  pfnInitFunc = D2Game::Q::Q04_Init;\n  /* pfnInitFunc = Other; */ }',
      }],
      [{ dataType: 'fpTimerFunction *[2]', initializedData: { kind: 'array', elements: [
        { kind: 'pointer', value: 'D2Game::T::Tick' }, { kind: 'pointer', value: 'DAT_00000000' },
      ] } as never }],
      new Set(['fpGameMechanicQuest', 'fpTimerFunction']),
    );
    assert.deepStrictEqual(out['D2Game::Q::Q04_Init'], ['fpGameMechanicQuest']);
    assert.deepStrictEqual(out.Q04_Init, ['fpGameMechanicQuest']);
    assert.deepStrictEqual(out.Tick, ['fpTimerFunction']);
    assert.strictEqual(out.Other, undefined, 'a comment is not a store');
  });
});
