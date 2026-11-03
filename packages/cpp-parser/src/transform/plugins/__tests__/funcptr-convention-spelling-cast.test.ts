/**
 * A parameterless function whose spelled convention is not its slot's.
 *
 * `UIAction_ResetKeyBindingsToDefaults` is `__fastcall` and takes nothing; the
 * slot it is stored in, `pfnUIConfigTabAction`, is `__cdecl`. The signatures
 * are equal, so the old "same prototype, no cast" rule skipped it - but C++
 * keeps the two conventions distinct types, and the store does not compile
 * without the cast. With no parameters nothing is placed, so the cast is safe.
 * A convention disagreement WITH parameters stays uncast (a real defect).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { funcPtrArgCastPlugin } from '../builtins/funcptr-arg-cast.js';

const BASE = {
  paramFuncdefs: { UI_RegisterTabAction: { 0: 'pfnUIConfigTabAction' } },
  funcdefSignatures: { pfnUIConfigTabAction: 'void()', fpChatSend: 'void(void *)' },
  funcdefConventionKeywords: { pfnUIConfigTabAction: '', fpChatSend: '' },
  functionSignatures: { UIAction_ResetKeyBindingsToDefaults: 'void()', CONTROLCONFIG_SaveAndCancel: 'void()', CHAT_Send: 'void(void *)' },
  functionConventions: { UIAction_ResetKeyBindingsToDefaults: '__fastcall', CONTROLCONFIG_SaveAndCancel: '', CHAT_Send: '__fastcall' },
  fieldFuncdefs: { pfnAction: 'pfnUIConfigTabAction', fpSend: 'fpChatSend' },
};

function run(code: string, extra: Record<string, unknown> = {}): string {
  const ast = parse(code);
  return emit(funcPtrArgCastPlugin.createTransformer({ ...BASE, ...extra })(ast) as AnyNode);
}

describe('a parameterless store across a convention spelling', () => {
  it('casts a __fastcall function stored in a __cdecl field', () => {
    const out = run('void f() { pTab->pfnAction = UIAction_ResetKeyBindingsToDefaults; }');
    assert.match(out, /pfnAction = \(pfnUIConfigTabAction\)UIAction_ResetKeyBindingsToDefaults/);
  });

  it('casts it as a call argument', () => {
    const out = run('void f() { UI_RegisterTabAction(UIAction_ResetKeyBindingsToDefaults); }');
    assert.match(out, /UI_RegisterTabAction\(\(pfnUIConfigTabAction\)UIAction_ResetKeyBindingsToDefaults\)/);
  });

  it('leaves a function of the slot\'s own convention uncast', () => {
    const out = run('void f() { pTab->pfnAction = CONTROLCONFIG_SaveAndCancel; }');
    assert.doesNotMatch(out, /\(pfnUIConfigTabAction\)/, out);
  });

  it('refuses the cast when there are parameters to misplace', () => {
    const out = run('void f() { pChat->fpSend = CHAT_Send; }');
    assert.doesNotMatch(out, /\(fpChatSend\)/, out);
  });
});
