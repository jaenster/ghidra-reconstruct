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
import { copyIsFaithful, setCopyPolicyMode, setGotoLabelFlow, gotoSitesFor, type CopyFacts } from '../builtins/goto-cleanup/copy-policy.js';
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
  it('E6: a short terminating tail whose sites each set up a different value (the cross-jump)', () => {
    assert.equal(copyIsFaithful(stmts('ITEMS_IsA(pItem, eType); return;'), facts(['eType = 0x1b;', 'eType = 0x2c;'], 'eType = 0x47;')), 'E6');
  });
  it('not E6: the same tail without the return, and no evidence (rule 1)', () => {
    assert.equal(copyIsFaithful(stmts('ITEMS_IsA(pItem, eType);'), facts(['eType = 0x1b;', 'eType = 0x2c;'], 'eType = 0x47;')), null);
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
    assert.equal(copyIsFaithful(stmts('a(); b(); break;'), facts(['x = 1;', 'x = 2;'], 'x = 3;')), 'E6');
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

/**
 * The four rules of the 2026-10-20 E6 audit (design 11): 21 of 67 sampled E6 copies were
 * refuted against the asm, nearly all of them tails that do not end in a jump (a skip over a
 * statement into the next section, copied into each branch), copies made for `case 4:
 * goto L;` sites (stacked labels), and the `GuardStack(); return;` epilogue.
 */
describe('E6 after the audit', () => {
  const flow = (label: string, f: { back?: number; first?: string; pushedArgs?: boolean }) =>
    setGotoLabelFlow({ [label]: { back: f.back ?? 0, first: f.first ?? 'MOV', pushedArgs: f.pushedArgs ?? false } });
  after(() => setGotoLabelFlow(null));
  const nonTerm = (label: string): CopyFacts => ({ ...facts(['eType = 0x1b;', 'eType = 0x2c;'], 'eType = 0x47;'), label });

  it('rule 1: a non-terminating tail is E6 with A1 (a jump in from a higher address)', () => {
    flow('LAB_1', { back: 1 });
    assert.equal(copyIsFaithful(stmts('ITEMS_IsA(pItem, eType);'), nonTerm('LAB_1')), 'E6');
    flow('LAB_1', { back: 0 });
    assert.equal(copyIsFaithful(stmts('ITEMS_IsA(pItem, eType);'), nonTerm('LAB_1')), null);
  });
  it('rule 1: A3 - the label starts with a Jcc reading flags each site set, or a CALL of pushed arguments', () => {
    flow('LAB_1', { first: 'JZ' });
    assert.equal(copyIsFaithful(stmts('ITEMS_IsA(pItem, eType);'), nonTerm('LAB_1')), 'E6');
    flow('LAB_1', { first: 'JMP' });
    assert.equal(copyIsFaithful(stmts('ITEMS_IsA(pItem, eType);'), nonTerm('LAB_1')), null);
    flow('LAB_1', { first: 'CALL', pushedArgs: true });
    assert.equal(copyIsFaithful(stmts('ITEMS_IsA(pItem, eType);'), nonTerm('LAB_1')), 'E6');
    flow('LAB_1', { first: 'CALL', pushedArgs: false });
    assert.equal(copyIsFaithful(stmts('ITEMS_IsA(pItem, eType);'), nonTerm('LAB_1')), null);
  });
  it('rule 1: A2 - the tail ends at a point another path enters (a sibling arm jumps past it)', () => {
    setGotoLabelFlow(null);
    const judge = (code: string) => {
      const region = stmts(code);
      let tail: Statement[] = [];
      for (const n of traverseAST(region[0] as AnyNode)) {
        if (n.kind === NodeKind.LabelStmt) tail = [(n as unknown as { statement: Statement }).statement];
      }
      return copyIsFaithful(tail, {
        sites: gotoSitesFor(region, 'LAB_1'), hasFallthrough: true, fallthroughPrefix: key('x = 1;'),
        noreturn: DEFAULT_NORETURN_FUNCTIONS, label: 'LAB_1', region, tailInRegion: tail,
      });
    };
    // case 1 and case 2 share `n = 0xc` (case 2 jumps into it); case 3 breaks past it to the
    // same follow: the store ends SOME paths into a join.
    assert.equal(judge(`switch (s) { case 1: x = 1; LAB_1: n = 0xc; break; case 2: x = 2; goto LAB_1; default: x = 3; break; } use(n);`), 'E6');
    // When the third arm returns, the store's end is reached only through the store (a
    // switch with a default cannot fall past its arms either).
    assert.equal(judge(`switch (s) { case 1: x = 1; LAB_1: n = 0xc; break; case 2: x = 2; goto LAB_1; default: return; } use(n);`), null);
  });
  it('rule 1: a join sunk into the arms is not A2 just because the skip jumps to its end', () => {
    setGotoLabelFlow(null);
    const region = stmts(`if (a) { if (c) goto LAB_1; x = 1; } else { x = 2; } g = ver; LAB_1: next();`);
    const J = [region[1]];
    const f: CopyFacts = {
      sites: [{ prefix: 's:x = 1' }, { prefix: 's:x = 2' }], hasFallthrough: false,
      noreturn: DEFAULT_NORETURN_FUNCTIONS, label: 'LAB_1', region, tailInRegion: J,
    };
    assert.equal(copyIsFaithful(J, f), null);
  });
  it('rule 1: A2 counts only a sibling - not a path that bypasses the whole construct', () => {
    setGotoLabelFlow(null);
    // DRLGENV_UpdateEnvironmentCycle 0061bee0: `if (!eclipse) { if (act == 3) n += 15; else
    // { if (..) goto L; n += 9; } p->n = n; } L:` - the store's end L is also reached when
    // eclipse is set, but that path skips the whole if, not just its arms.
    const region = stmts(`if (e == 0) { if (a == 3) { n = n + 15; } else { if (c) goto LAB_1; n = n + 9; } p->n = n; } LAB_1: next();`);
    const outerThen = (region[0] as unknown as { thenBranch: CompoundStmt }).thenBranch.statements;
    const J = [outerThen[1]];
    const f: CopyFacts = {
      sites: [{ prefix: 's:n = n + 15' }, { prefix: 's:n = n + 9' }], hasFallthrough: false,
      noreturn: DEFAULT_NORETURN_FUNCTIONS, label: 'LAB_1', region, tailInRegion: J, sunkJoin: true,
    };
    assert.equal(copyIsFaithful(J, f), null);
  });
  it('rule 2: never E6 into the default of a compare tree (every site tests the same operand)', () => {
    // 00505a80: three leaves of a FOURCC compare tree jump to `name = "Unknown"`.
    const region = stmts(`if (v < 5) { if (v != 1) goto LAB_1; name = 1; } else { if (v != 7) goto LAB_1; name = 7; } LAB_1: use(name); return;`);
    const sites = gotoSitesFor(region, 'LAB_1');
    assert.equal(sites.length, 2);
    assert.ok(sites.every(s => !!s.branch));
    const f: CopyFacts = { sites, hasFallthrough: true, fallthroughPrefix: key('name = 7;'), noreturn: DEFAULT_NORETURN_FUNCTIONS, label: 'LAB_1' };
    assert.equal(copyIsFaithful(stmts('use(name); return;'), f), null);
    // Sites testing different operands are not a compare tree.
    const region2 = stmts(`if (v < 5) { if (v != 1) goto LAB_1; name = 1; } else { if (w != 7) goto LAB_1; name = 7; } LAB_1: use(name); return;`);
    assert.equal(copyIsFaithful(stmts('use(name); return;'), { ...f, sites: gotoSitesFor(region2, 'LAB_1') }), 'E6');
  });
  it('rule 2: never E6 for a site that is a case holding only the goto (stacked labels)', () => {
    const region = stmts(`switch (s) { case 3: x = 3; goto LAB_1; case 4: goto LAB_1; } y = 1; LAB_1: f(); return;`);
    const sites = gotoSitesFor(region, 'LAB_1');
    assert.deepEqual(sites.map(s => !!s.caseOnly), [false, true]);
    assert.equal(copyIsFaithful(stmts('f(); return;'), { sites, hasFallthrough: true, fallthroughPrefix: key('y = 1;'), noreturn: DEFAULT_NORETURN_FUNCTIONS }), null);
  });
  it('rule 2: never E6 into a case label reached by the default edge', () => {
    const f: CopyFacts = { sites: [{ prefix: 'c:default' }, { prefix: 's:x = 1' }], hasFallthrough: false, noreturn: DEFAULT_NORETURN_FUNCTIONS, label: 'switchD_005dd641_caseD_4' };
    assert.equal(copyIsFaithful(stmts('f(); return;'), f), null);
    assert.equal(copyIsFaithful(stmts('f(); return;'), { ...f, label: 'LAB_005dd685' }), 'E6');
  });
  it('rule 3: `GuardStack(); return v;` is E4 (the epilogue), not E6', () => {
    assert.equal(copyIsFaithful(stmts('Fog::Debug::GuardStack(); return 0xe;'), facts(['a();', 'b();'])), 'E4');
    assert.equal(copyIsFaithful(stmts('Fog::Debug::GuardStack(); return;'), facts(['a();', 'b();'])), 'E4');
    assert.equal(copyIsFaithful(stmts('n = 3; Fog::Debug::GuardStack(); return n;'), facts(['a();', 'b();'])), 'E4');
    // Another call before the return is still work.
    assert.equal(copyIsFaithful(stmts('Release(p); Fog::Debug::GuardStack(); return 0;'), facts(['a();', 'b();'])), 'E6');
  });
});
