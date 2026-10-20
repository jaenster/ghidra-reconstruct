/**
 * The copy policy (goto-cleanup/copy-policy.ts): a tail is copied to its goto sites only
 * with evidence that the source wrote it at each one. Every accept case has a decline case
 * one fact away from it.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import { traverseAST } from '../../../ast/visitor.js';
import type { AnyNode, CompoundStmt, FunctionDecl, Statement } from '../../../ast/nodes.js';
import { gotoCleanupPlugin, getGotoCleanupStats, resetGotoCleanupStats } from '../builtins/goto-cleanup/index.js';
import { copyIsFaithful, setCopyPolicyMode, type CopyFacts } from '../builtins/goto-cleanup/copy-policy.js';
import { DEFAULT_NORETURN_FUNCTIONS } from '../builtins/goto-cleanup/types.js';

function stmts(code: string): Statement[] {
  for (const n of traverseAST(parse(`void f() { ${code} }`))) {
    if (n.kind === NodeKind.FunctionDecl) return ((n as FunctionDecl).body as CompoundStmt).statements;
  }
  throw new Error('no body');
}
const one = (code: string) => stmts(code)[0];
const key = (p: string) => 's:' + emit(one(p) as AnyNode).trim();
const facts = (prefixes: (string | null)[], fallthrough: string | null | false = false): CopyFacts => ({
  sites: prefixes.map(p => ({ prefix: p === null ? null : key(p) })),
  hasFallthrough: fallthrough !== false,
  fallthroughPrefix: fallthrough === false || fallthrough === null ? null : key(fallthrough),
  noreturn: DEFAULT_NORETURN_FUNCTIONS,
});

const HALT = `nLine = 0x172; nAddress = Fog::GetInstructionPointer(); ERROR_UnrecoverableInternalError_Halt("", nAddress, nLine); exit(-1);`;

describe('copyIsFaithful', () => {
  it('E3: the assert/halt sequence, at any number of sites', () => {
    assert.equal(copyIsFaithful(stmts(HALT), facts(['a();', 'a();', 'a();', 'a();', 'a();'])), 'E3');
  });
  it('E3 through the cast Ghidra puts on the instruction pointer', () => {
    assert.equal(copyIsFaithful(stmts(`nLine = 0x19b; pErr = (char*)GetInstructionPointer(); Halt("", pErr, nLine); exit(-1);`), facts(['a();', 'b();'])), 'E3');
  });
  it('not E3 when the sequence does other work', () => {
    assert.equal(copyIsFaithful(stmts(`free(p); ${HALT}`), facts(['a();', 'b();'])), null);
  });
  it('E4: return, a phi move then return, break', () => {
    assert.equal(copyIsFaithful(stmts('return 1;'), facts([null, null])), 'E4');
    assert.equal(copyIsFaithful(stmts('nResult = 0; return nResult;'), facts([null], null)), 'E4');
    assert.equal(copyIsFaithful(stmts('break;'), facts([null, null])), 'E4');
  });
  it('not E4: a call before the return is work, not a phi move', () => {
    assert.equal(copyIsFaithful(stmts('Release(p); return 0;'), facts([null, null])), null);
  });
  it('not E4: two phi moves', () => {
    assert.equal(copyIsFaithful(stmts('a = 1; b = 2; return a;'), facts([null, null])), null);
  });
  it('E6: a short tail whose sites each set up a different value (the cross-jump)', () => {
    assert.equal(copyIsFaithful(stmts('ITEMS_IsA(pItem, eType);'), facts(['eType = 0x1b;', 'eType = 0x2c;'], 'eType = 0x47;')), 'E6');
  });
  it('not E6 when two sites have the same prefix (nothing distinguishes them)', () => {
    assert.equal(copyIsFaithful(stmts('ITEMS_IsA(pItem, eType);'), facts(['eType = 0x1b;', 'eType = 0x1b;'])), null);
  });
  it('not E6 when a site has no prefix (a condition DAG, not a cross-jump)', () => {
    assert.equal(copyIsFaithful(stmts('ITEMS_IsA(pItem, eType);'), facts([null, 'eType = 0x2c;'])), null);
  });
  it('not E6 over 3 work nodes, or over the (sites - 1) x tail volume', () => {
    assert.equal(copyIsFaithful(stmts('a(); b(); c(); d();'), facts(['x = 1;', 'x = 2;'])), null);
    assert.equal(copyIsFaithful(stmts('a(); b(); c();'), facts(['x = 1;', 'x = 2;', 'x = 3;', 'x = 4;'])), null);
    assert.equal(copyIsFaithful(stmts('a(); b(); c();'), facts(['x = 1;', 'x = 2;'], 'x = 3;')), 'E6');
  });
  it('a single goto into a block nothing falls into is a move, not a copy', () => {
    assert.equal(copyIsFaithful(stmts('Release(p); Release(q); free(r); return 0;'), facts(['a();'])), 'move');
    assert.equal(copyIsFaithful(stmts('Release(p); Release(q); free(r); return 0;'), facts(['a();'], 'b();')), null);
  });
  it('E6 site prefixes: the statement before the jump, else the branch that leads to it', async () => {
    const { gotoSitesFor, labelFallthrough } = await import('../builtins/goto-cleanup/copy-policy.js');
    const { canFallThrough } = await import('../builtins/goto-cleanup/tail-inline.js');
    const body = stmts(`if (a) goto LAB_1; if (b) { x = 2; goto LAB_1; } switch (c) { case 3: goto LAB_1; } y = 1; LAB_1: f(x); return;`);
    assert.deepEqual(gotoSitesFor(body, 'LAB_1').map(s => s.prefix), ['t:a', 's:x = 2', 'c:3']);
    assert.deepEqual(labelFallthrough(body, 'LAB_1', canFallThrough), { hasFallthrough: true, prefix: 's:y = 1' });
  });
  it('never a tail holding a label or a case label, whatever else holds', () => {
    assert.equal(copyIsFaithful(stmts('LAB_1: return 1;'), facts([null])), null);
    assert.equal(copyIsFaithful(stmts('if (a) { LAB_1: ; } return 1;'), facts([null, null])), null);
  });
});

function run(code: string): string {
  return emit(gotoCleanupPlugin.createTransformer()(parse(code)) as AnyNode).trim();
}

describe('copy policy in the handlers (enforce)', () => {
  before(() => setCopyPolicyMode('enforce'));
  after(() => setCopyPolicyMode(null));

  it('keeps a goto error whose 4-statement cleanup block is over the E6 ceiling', () => {
    const out = run(`
int f(int a, int b) {
  while (a) {
    if (b == 0) goto LAB_err;
    a = step(a);
    if (a < 0) goto LAB_err;
  }
  use(a, b);
  return 1;
LAB_err:
  Release(a);
  Release(b);
  Log(a, b);
  return 0;
}`);
    assert.match(out, /if \(b == 0\)\s*goto LAB_err;/);
    assert.match(out, /if \(a < 0\)\s*goto LAB_err;/);
    assert.equal((out.match(/Release\(a\);/g) ?? []).length, 1);
  });

  it('copies a 3-statement tail whose two sites are different branches (E6), counted as E6', () => {
    resetGotoCleanupStats();
    const out = run(`
int f(int a, int b) {
  while (a) {
    if (b == 0) goto LAB_err;
    a = step(a);
    if (a < 0) goto LAB_err;
  }
  use(a, b);
  return 1;
LAB_err:
  Release(a);
  Release(b);
  return 0;
}`);
    assert.doesNotMatch(out, /goto/);
    assert.equal(getGotoCleanupStats().copyE6, 2);
  });

  it('copies a halt (E3) and counts it as E3', () => {
    resetGotoCleanupStats();
    const out = run(`
void f(int a, int b) {
  int nLine;
  int nAddress;
  while (a) {
    if (b == 0) { nLine = 0x10; goto LAB_halt; }
    a = step(a);
    if (a < 0) { nLine = 0x11; goto LAB_halt; }
  }
  use(a, b);
  return;
LAB_halt:
  nAddress = GetInstructionPointer();
  ERROR_UnrecoverableInternalError_Halt("", nAddress, nLine);
  exit(-1);
}`);
    assert.doesNotMatch(out, /goto/);
    assert.equal((out.match(/ERROR_UnrecoverableInternalError_Halt/g) ?? []).length, 2);
    assert.equal(getGotoCleanupStats().copyE3, 2);
    assert.equal(getGotoCleanupStats().copyE6, 0);
  });
});
