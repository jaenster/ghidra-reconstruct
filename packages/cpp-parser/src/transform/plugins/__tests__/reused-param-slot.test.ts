/**
 * reused-param-slot: AITHINK_Fn1_NpcOutOfTown (005e7880) keeps a function pointer in
 * the dead slot of its `pAiParam` parameter; the pass gives it a funcdef-typed local.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { reusedParamSlotPlugin, type ReusedParamSlotOptions } from '../builtins/reused-param-slot.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const native = { skip: !hasNativeGpp() };

const SIG = 'void(D2GameStrc *,D2UnitStrc *)';
const OPTIONS: ReusedParamSlotOptions = {
  functionSignatures: {
    'Q::Q04_InitializeTristramObjects': SIG, Q04_InitializeTristramObjects: SIG,
    'Q::Q33_StartAnyaRescuePhase': SIG, Q33_StartAnyaRescuePhase: SIG,
    'Q::Other': 'int(D2GameStrc *)', Other: 'int(D2GameStrc *)',
  },
  functionConventions: {
    'Q::Q04_InitializeTristramObjects': '__fastcall', Q04_InitializeTristramObjects: '__fastcall',
    'Q::Q33_StartAnyaRescuePhase': '__fastcall', Q33_StartAnyaRescuePhase: '__fastcall',
    'Q::Other': '__fastcall', Other: '__fastcall',
  },
  // Four funcdefs share the contract in 1.14d; the program stores these two functions
  // as fpGameMechanicQuest in the sibling AI_QuestNpc_InitializeQuestPhase (005e77a0).
  funcdefSignatures: { fpGameMechanicQuest: SIG, fpTimerFunction: SIG, dt_1ae317ea: SIG, fpStdcallTwin: SIG },
  funcdefConventions: { fpGameMechanicQuest: '__fastcall', fpTimerFunction: '__fastcall', dt_1ae317ea: '__fastcall', fpStdcallTwin: '__stdcall' },
  functionStoredAs: {
    'Q::Q04_InitializeTristramObjects': ['fpGameMechanicQuest'], Q04_InitializeTristramObjects: ['fpGameMechanicQuest'],
    'Q::Q33_StartAnyaRescuePhase': ['fpGameMechanicQuest'], Q33_StartAnyaRescuePhase: ['fpGameMechanicQuest'],
  },
};

const run = (code: string, o: ReusedParamSlotOptions = OPTIONS) =>
  emit(reusedParamSlotPlugin.createTransformer(o)(parse(code)) as AnyNode).trim();

/** The else branch of 005e7880, trimmed to what the slot does. */
const SITE = `void f(D2GameStrc *pGame, D2UnitStrc *pUnit, D2AiParamStrc *pAiParam, int bIsAnya, int nArrived) {
  Use(pAiParam);
  if (nArrived == 0) {
    Use(pAiParam);
    return;
  }
  pAiParam = (D2AiParamStrc *)Q::Q04_InitializeTristramObjects;
  if (bIsAnya) {
    pAiParam = (D2AiParamStrc *)Q::Q33_StartAnyaRescuePhase;
  }
  if (nArrived == 1) {
    (*(code *)pAiParam)(pGame,pUnit);
    return;
  }
  return;
}`;

describe('reused-param-slot', () => {
  it('gives the reused slot a local of the funcdef the program stores those functions as', () => {
    const out = run(SITE);
    assert.match(out, /fpGameMechanicQuest\* pfnGameMechanicQuest;/, out);
    assert.match(out, /pfnGameMechanicQuest = Q::Q04_InitializeTristramObjects;/, out);
    assert.match(out, /pfnGameMechanicQuest = Q::Q33_StartAnyaRescuePhase;/, out);
    assert.match(out, /\(\*pfnGameMechanicQuest\)\(pGame, pUnit\);/, out);
    // The parameter keeps its own uses.
    assert.strictEqual(out.match(/Use\(pAiParam\)/g)?.length, 2, out);
    assert.doesNotMatch(out, /code|\(D2AiParamStrc\*\)/, out);
  });

  it('calls the same functions as the slot did', native, () => {
    const out = run(SITE);
    const prelude = [
      'struct D2GameStrc { int n; }; struct D2UnitStrc { int n; }; struct D2AiParamStrc { int n; };',
      'typedef void code(D2GameStrc *, D2UnitStrc *);',
      'typedef void fpGameMechanicQuest(D2GameStrc *, D2UnitStrc *);',
      'static int gLog = 0; static void Use(D2AiParamStrc *p) { gLog = gLog * 7 + (p ? p->n : 1); }',
      'namespace Q { void Q04_InitializeTristramObjects(D2GameStrc *g, D2UnitStrc *u) { gLog = gLog * 3 + g->n + 1; }',
      '  void Q33_StartAnyaRescuePhase(D2GameStrc *g, D2UnitStrc *u) { gLog = gLog * 5 + u->n + 2; } }',
      `namespace ref { ${SITE} }`,
      `namespace low { ${out} }`,
    ].join('\n');
    const body = [
      'D2GameStrc g{4}; D2UnitStrc u{9}; D2AiParamStrc a{6}; int bad = 0;',
      'for (int anya = 0; anya < 2; anya++) for (int arrived = 0; arrived < 3; arrived++) {',
      '  gLog = 0; ref::f(&g, &u, &a, anya, arrived); int x = gLog;',
      '  gLog = 0; low::f(&g, &u, &a, anya, arrived); if (x != gLog) bad++;',
      '}',
      'printf("%d\\n", bad);',
    ].join('\n');
    assert.strictEqual(compileAndRun(prelude, body).trim(), '0', out);
  });

  it('leaves the slot when a read of the parameter itself is reachable from a store', () => {
    const code = SITE.replace('  return;\n}', '  Use(pAiParam);\n  return;\n}');
    assert.match(run(code), /\(\*\(code\*\)pAiParam\)/);
  });

  it('leaves the slot when the stored functions differ in signature', () => {
    assert.match(run(SITE.replace('Q::Q33_StartAnyaRescuePhase', 'Q::Other')), /\(\*\(code\*\)pAiParam\)/);
  });

  it('leaves the slot when identical funcdefs cannot be told apart', () => {
    assert.match(run(SITE, { ...OPTIONS, functionStoredAs: {} }), /\(\*\(code\*\)pAiParam\)/);
  });

  it('leaves a slot written with something that is not a function', () => {
    assert.match(run(SITE.replace('pAiParam = (D2AiParamStrc *)Q::Q33_StartAnyaRescuePhase;', 'pAiParam = Next(pAiParam);')),
      /\(\*\(code\*\)pAiParam\)/);
  });
});
