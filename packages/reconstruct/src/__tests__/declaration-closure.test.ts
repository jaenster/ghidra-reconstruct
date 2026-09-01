/**
 * The emitted tree has to be CLOSED: every name a body references must have a
 * declaration somewhere the translation unit can see. Three decisions used to
 * break that — excluding a namespace from emission without declaring its
 * callees, filtering a data symbol out of globals.h without removing its
 * references, and Ghidra naming untyped data in a body that never had a symbol
 * record for it.
 *
 * The other half of the contract matters just as much: names that are DEFECTS
 * (an unresolved call target, a lost goto label, a jump table, a decompiler
 * local that escaped its scope) must NOT be declared. A declaration would make
 * the defect compile, and the error is the only thing pointing at it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  computeDeclarationClosure,
  renderClosureBlock,
  artifactReason,
  type ClosureInputs,
} from '../codegen/declaration-closure.js';
import type { AnalyzedDataSymbol, ExtractedFunction } from '../types.js';

const EXCLUDED_CALLEE = {
  name: 'DirectSoundCreate', address: '002e76fe', namespace: 'VisualStudio',
  returnType: 'undefined4', parameters: [{ name: 'param_1', dataType: 'int', size: 4, ordinal: 0, storage: 'stack' }],
  signature: 'undefined4 DirectSoundCreate(int param_1)', localVariables: [],
  callingConvention: '__cdecl', size: 16, isThunk: false, isExternal: false, hasVarArgs: false,
} as unknown as ExtractedFunction;

/** Ghidra name `MPQ_d2kfixup.mpq` — the dot is why globals.h never declared it. */
const FILTERED_GLOBAL = {
  name: 'MPQ_d2kfixup.mpq', address: '007d5620', dataType: 'D2MPQFileStrc *',
  suggestedType: 'D2MPQFileStrc *', size: 4, isInitialized: false, xrefCount: 2, scope: 'global',
} as unknown as AnalyzedDataSymbol;

function inputs(over: Partial<ClosureInputs> = {}): ClosureInputs {
  return {
    allFunctions: [EXCLUDED_CALLEE],
    allGlobals: [FILTERED_GLOBAL],
    referenced: new Map(),
    declared: new Set<string>(),
    emittedFunctionNames: new Set<string>(),
    renderPrototype: (f) => `${f.returnType} ${f.name}(int param_1);`,
    renderExtern: (g) => `extern ${g.suggestedType ?? g.dataType} ${(g.suggestedName ?? g.name).replace(/[^A-Za-z0-9_]/g, '_')};`,
    sanitize: (n) => n.replace(/[^A-Za-z0-9_]/g, '_'),
    ...over,
  };
}

describe('declaration closure', () => {
  it('declares a callee whose namespace this build excludes', () => {
    const { declarations } = computeDeclarationClosure(inputs({
      referenced: new Map([['DirectSoundCreate', 1]]),
    }));
    assert.deepStrictEqual(declarations.map(d => d.origin), ['unemitted-function']);
    assert.match(declarations[0].decl, /DirectSoundCreate/);
  });

  it('declares a data symbol under the spelling the bodies use, not the Ghidra one', () => {
    const { declarations } = computeDeclarationClosure(inputs({
      referenced: new Map([['MPQ_d2kfixup_mpq', 2]]),
    }));
    assert.strictEqual(declarations.length, 1);
    assert.strictEqual(declarations[0].origin, 'undeclared-global');
    assert.match(declarations[0].decl, /MPQ_d2kfixup_mpq/);
  });

  it('declares Ghidra untyped data at the width its own name states', () => {
    const { declarations } = computeDeclarationClosure(inputs({
      referenced: new Map([['UNK_006dff20', 3], ['DWORD_006db8d0', 1], ['_DAT_00700140', 1]]),
    }));
    const byName = new Map(declarations.map(d => [d.name, d.decl]));
    // `(&UNK_x)[i]` only indexes from a SCALAR — an array declaration would make
    // `&UNK_x` a pointer-to-array and the subscript would step by the whole array.
    assert.strictEqual(byName.get('UNK_006dff20'), 'extern uint8_t UNK_006dff20;');
    assert.strictEqual(byName.get('DWORD_006db8d0'), 'extern uint32_t DWORD_006db8d0;');
    assert.strictEqual(byName.get('_DAT_00700140'), 'extern uint8_t _DAT_00700140;');
  });

  it('never declares a name that is already declared', () => {
    const { declarations } = computeDeclarationClosure(inputs({
      referenced: new Map([['MPQ_d2kfixup_mpq', 2]]),
      declared: new Set(['MPQ_d2kfixup_mpq']),
    }));
    assert.deepStrictEqual(declarations, []);
  });

  it('does not re-declare an EMITTED function that a body failed to qualify', () => {
    const { declarations, unresolved } = computeDeclarationClosure(inputs({
      referenced: new Map([['UI_DrawPlayerNameOverhead', 1]]),
      emittedFunctionNames: new Set(['UI_DrawPlayerNameOverhead']),
    }));
    assert.deepStrictEqual(declarations, []);
    assert.ok([...unresolved.keys()].some(k => /qualifier/.test(k)),
      'a definition exists — a second root-scope declaration would be a different function');
  });

  it('refuses to declare decompiler and emitter artifacts, and says what each one is', () => {
    const artifacts = [
      'func_0x0042644a', 'LAB_0057ee77_1', 'switchD_0046b678',
      'param_2', 'iVar7', 'register0x00000000', 'uRam00723a7a', 'ram0x007bf038',
    ];
    const { declarations, unresolved } = computeDeclarationClosure(inputs({
      referenced: new Map(artifacts.map(n => [n, 1])),
    }));
    assert.deepStrictEqual(declarations, []);
    const noted = new Set([...unresolved.values()].flat());
    for (const name of artifacts) {
      assert.ok(noted.has(name), `${name} must be reported, not declared`);
      assert.ok(artifactReason(name), `${name} must be recognised as an artifact`);
    }
  });

  it('leaves a real symbol name alone even when it looks noisy', () => {
    for (const name of ['gpWaypointButtonHover', 'D2GSPacketSrv0x91', 'nMercNameId']) {
      assert.strictEqual(artifactReason(name), null, name);
    }
  });

  it('never declares a width-alias for a stack slot', () => {
    // When one stack slot is accessed at two widths, Ghidra keeps ONE variable
    // and renders the wider access as `_<base>`. That is a rendering
    // convention, not a second symbol — `underscore-slot-local` gives it a
    // declaration in the body it belongs to. An `extern` here would bind those
    // uses to a phantom global and turn loud type errors into silent wrong
    // behaviour, which is the worst outcome available.
    const { declarations, unresolved } = computeDeclarationClosure(inputs({
      referenced: new Map([['_sPacket0x89', 6], ['_nWaypointId', 2]]),
    }));
    assert.deepStrictEqual(declarations, []);
    const noted = new Set([...unresolved.values()].flat());
    assert.ok(noted.has('_sPacket0x89') && noted.has('_nWaypointId'));
  });

  it('emits nothing at all when there is nothing to close', () => {
    assert.deepStrictEqual(renderClosureBlock([]), []);
  });
});
