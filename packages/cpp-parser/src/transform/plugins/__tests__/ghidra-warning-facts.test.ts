/**
 * Ghidra WARNING comments: classified into facts, stripped from the tree.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { gotoCleanupPlugin } from '../builtins/goto-cleanup/index.js';
import { classifyLabelTail } from '../builtins/goto-cleanup/analysis.js';
import {
  classifyWarning, collectWarningFacts, warningCommentStripPlugin, WARNING_TEMPLATES,
} from '../builtins/ghidra-warning-facts.js';
import { allBuiltinPlugins } from '../index.js';
import { transformGhidraCode } from '../../../ghidra.js';

describe('classifyWarning', () => {
  const cases: Array<[string, string, string]> = [
    ['Switch is manually overridden', 'switch-override', 'informational'],
    ['Inlined function: SKILLS_GetSkillByEnum', 'inlined-function', 'informational'],
    ['This is an inlined function', 'inlined-function-marker', 'informational'],
    ['Function: __alloca_probe replaced with injection: alloca_probe', 'replaced-with-injection', 'informational'],
    ['Enum "eCollisionFlags": Some values do not have unique names', 'enum-duplicate-names', 'informational'],
    ['Unknown calling convention', 'unknown-calling-convention', 'informational'],
    ['Unknown calling convention -- yet parameter storage is locked', 'unknown-calling-convention', 'informational'],
    ['Variable defined which should be unmapped: sSkill', 'unmapped-variable', 'informational'],
    ["Globals starting with '_' overlap smaller symbols at the same address", 'globals-overlap', 'informational'],
    ['Restarted to delay deadcode elimination for space: stack', 'deadcode-restart', 'informational'],
    ['Could not inline here', 'could-not-inline', 'defect'],
    ['Could not recover jumptable at 0x0040a1b2. Too many branches', 'jumptable-unrecovered', 'defect'],
    ['Treating indirect jump as call', 'indirect-jump-as-call', 'defect'],
    ['Jumptable at 0x00412345 did not pass sanity check', 'jumptable-sanity', 'defect'],
    ['Sanity check requires truncation of jumptable', 'jumptable-truncated', 'defect'],
    ['Could not find normalized switch variable to match jumptable', 'switch-variable-unmatched', 'defect'],
    ['Removing unreachable block (ram,0x0040100f)', 'unreachable-block-removed', 'defect'],
    ['Bad instruction - Truncating control flow here', 'bad-instruction', 'defect'],
    ['Unable to track spacebase fully for stack', 'spacebase-untracked', 'defect'],
    ['Type propagation algorithm not settling', 'type-propagation-unsettled', 'defect'],
    ['Possible PIC construction at 0x00401000: Changing call to branch', 'pic-construction', 'defect'],
    ['Unable to use type for symbol pCurrent', 'unusable-symbol-type', 'defect'],
    ['Read-only address (ram,0x006f28b0) is written', 'readonly-address-written', 'defect'],
    ['Control flow encountered bad instruction data', 'bad-instruction-data', 'defect'],
    ['Instruction at (ram,0x006d5be8) overlaps instruction at (ram,0x006d5be7)', 'overlapping-instruction', 'defect'],
    ['Some message no Ghidra version printed yet', 'unclassified', 'defect'],
  ];
  for (const [msg, kind, cls] of cases) {
    it(`${msg.slice(0, 40)} -> ${kind}`, () => {
      const r = classifyWarning(msg);
      assert.strictEqual(r.kind, kind);
      assert.strictEqual(r.class, cls);
    });
  }

  it('every template is reached by its own prefix (no earlier template shadows it)', () => {
    for (const t of WARNING_TEMPLATES) {
      if (t.kind === 'noreturn') continue;
      assert.strictEqual(classifyWarning(`${t.prefix}x`).kind, t.kind, t.prefix);
    }
  });

  it('noreturn into a terminal callee is informational', () => {
    assert.deepStrictEqual(classifyWarning('Subroutine does not return', 'exit'),
      { kind: 'noreturn', class: 'informational', callee: 'exit' });
    assert.strictEqual(classifyWarning('Subroutine does not return', 'ERROR_UnrecoverableInternalError_Halt').class,
      'informational');
  });

  it('noreturn into any other callee is a defect', () => {
    assert.deepStrictEqual(classifyWarning('Subroutine does not return', 'InitDrlgAct'),
      { kind: 'noreturn-unknown-callee', class: 'defect', callee: 'InitDrlgAct' });
    assert.strictEqual(classifyWarning('Subroutine does not return').kind, 'noreturn-unknown-callee');
  });
});

describe('collectWarningFacts', () => {
  it('reads header and body warnings in text order, finding the noreturn callee', () => {
    const text = `
/* WARNING: Unknown calling convention */
/* WARNING (jumptable): Sanity check requires truncation of jumptable */

void __thiscall Ns::F(int a)

{
  if (a == 0) {
                    /* WARNING: Subroutine does not return */
    compiler::_exit(-1);
  }
  /* WARNING: Subroutine does not return */
  pAct = D2Common::InitDrlgAct(a);
  return;
}
`;
    const facts = collectWarningFacts(text);
    assert.deepStrictEqual(facts.map(f => [f.kind, f.class, f.callee]), [
      ['unknown-calling-convention', 'informational', undefined],
      ['jumptable-truncated', 'defect', undefined],
      ['noreturn', 'informational', '_exit'],
      ['noreturn-unknown-callee', 'defect', 'InitDrlgAct'],
    ]);
  });

  it('skips a store Ghidra printed before the call the warning belongs to', () => {
    const facts = collectWarningFacts(`void f(void) {
  /* WARNING: Subroutine does not return */
  uStack00000004 = 0x4b6ee3;
  compiler::_exit(-1);
}`);
    assert.deepStrictEqual(facts.map(f => [f.kind, f.callee]), [['noreturn', '_exit']]);
  });

  it('a text the lexer cannot read is one defect, not silence', () => {
    const facts = collectWarningFacts(`/* a plate comment with a stray */ end */ @ void f() {}`);
    assert.strictEqual(facts.length, 1);
    assert.strictEqual(facts[0].kind, 'unreadable-text');
    assert.strictEqual(facts[0].class, 'defect');
  });

  it('ignores ordinary comments mentioning a warning', () => {
    assert.deepStrictEqual(collectWarningFacts(`void f() { /* see the WARNING: above */ g(); }`), []);
  });
});

describe('warningCommentStripPlugin', () => {
  const strip = warningCommentStripPlugin.createTransformer();
  const goto = gotoCleanupPlugin.createTransformer();
  const run = (code: string, ...ts: Array<(n: any) => any>) =>
    emit(ts.reduce((ast, t) => t(ast), parse(code) as any) as AnyNode).trim();

  it('runs after every pass that reads WARNING comments', () => {
    const readers = ['indirect-call-cleanup', 'goto-cleanup'];
    for (const id of readers) {
      const p = allBuiltinPlugins.find(x => x.id === id)!;
      assert.ok(p.priority < warningCommentStripPlugin.priority, id);
    }
    const max = Math.max(...allBuiltinPlugins.filter(p => p !== warningCommentStripPlugin).map(p => p.priority));
    assert.ok(warningCommentStripPlugin.priority > max);
  });

  it('removes warning comments and leaves other comments alone', () => {
    const out = run(`void f(int a) {
  /* WARNING: Could not inline here */
  g(a); /* WARNING: Removing unreachable block (ram,0x0040100f) */
  /* keep me */
  h();
}`, strip);
    assert.ok(!out.includes('WARNING'), out);
    assert.ok(out.includes('keep me'), out);
    assert.ok(out.includes('g(a);') && out.includes('h();'), out);
  });

  it('goto-cleanup still reads the noreturn warning; the comment is gone afterwards', () => {
    // InitDrlgAct is not a known noreturn function: only the WARNING makes the tail noreturn.
    const withWarning = `void foo(int error) {
  if (error) goto LAB_die;
  normal_code();
  return;
LAB_die:
  /* WARNING: Subroutine does not return */
  InitDrlgAct(error);
}`;
    // The tail classification goto-cleanup makes from the comment: noreturn only with it.
    const opts = { detectGhidraNoreturn: true, noreturnFunctions: [] } as any;
    const tailOf = (code: string) => {
      const fn = (parse(code) as any).declarations[0];
      const stmts = fn.body.statements;
      const i = stmts.findIndex((s: any) => s.kind === 'LabelStmt');
      return [stmts[i].statement, ...stmts.slice(i + 1)];
    };
    const withoutWarning = withWarning.replace('  /* WARNING: Subroutine does not return */\n', '');
    assert.strictEqual(classifyLabelTail(tailOf(withWarning), opts), 'exit-noreturn');
    assert.strictEqual(classifyLabelTail(tailOf(withoutWarning), opts), 'cleanup-fallthrough');
    const driven = run(withWarning, goto, strip);
    assert.strictEqual(driven, `void foo(int error) {
  if (!error) {
    normal_code();
    return;
  }
  InitDrlgAct(error);
}`);
    assert.ok(!driven.includes('WARNING'));
  });

  it('the full pipeline emits no WARNING text', () => {
    const r = transformGhidraCode(`int dummy(int a) {
  /* WARNING: Could not inline here */
  int x = foo(a);
  switch (a) {
  case 1:
    /* WARNING: Switch is manually overridden */
    x = 2;
  }
  if (a == 7) {
    /* WARNING: Subroutine does not return */
    exit(-1);
  }
  return x;
}`, { preset: 'full', usePluginRegistry: true, tolerateErrors: true });
    assert.ok(r.success);
    assert.ok(!r.code.includes('WARNING'), r.code);
  });
});
