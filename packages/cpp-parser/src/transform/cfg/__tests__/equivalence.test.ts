/**
 * The translation validator.
 *
 * Accept cases are the rewrites the structuring work performs - MOVE, UNFOLD, RETARGET -
 * each in the shape it really takes. Refuse cases are single mutations of an accepted output,
 * each one a way a rewrite has gone, or could go, silently wrong. Every accept case is ALSO
 * run as a control skeleton with g++ (testing/skeleton.ts), and so is every refuse case that
 * changes meaning: the proof and the execution must agree.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import { traverseAST } from '../../../ast/visitor.js';
import type { CompoundStmt, FunctionDecl, Statement } from '../../../ast/nodes.js';
import { isUnfolding } from '../equivalence.js';
import { countGotoTargets } from '../labels.js';
import type { BcfgOptions } from '../bcfg.js';
import { hasNativeGpp } from '../../../testing/native-cpp.js';
import { runSkeletons } from '../../../testing/skeleton.js';

function body(code: string): Statement[] {
  for (const n of traverseAST(parse(code))) {
    if (n.kind !== NodeKind.FunctionDecl) continue;
    const fn = n as FunctionDecl;
    if (fn.body?.kind === NodeKind.CompoundStmt) return (fn.body as CompoundStmt).statements;
  }
  throw new Error('no function body in fixture');
}

const fn = (b: string) => `void f(int a, int b, int c) {\n${b}\n}`;
const NORET = new Set(['halt']);

/** The region is the whole body, so the whole-function counts are the region's own. */
function wholeFn(before: string): BcfgOptions {
  return { noreturn: NORET, externalGotoCounts: countGotoTargets(body(fn(before))) };
}

function accepted(before: string, after: string, opts: BcfgOptions = {}) {
  const r = isUnfolding(body(fn(before)), body(fn(after)), { ...wholeFn(before), ...opts });
  assert.ok(r.ok, `should be accepted: ${!r.ok ? r.reason : ''}`);
  return r;
}
function refused(before: string, after: string, opts: BcfgOptions = {}) {
  const r = isUnfolding(body(fn(before)), body(fn(after)), { ...wholeFn(before), ...opts });
  assert.ok(!r.ok, 'should be refused but was accepted');
  return r.reason;
}

const gpp = hasNativeGpp();
/** Skeleton verdict for (before, after) as whole function bodies. */
function skeletonSame(before: string, after: string): boolean {
  const [r] = runSkeletons([{ name: 'x', before: body(fn(before)), after: body(fn(after)) }], { noreturn: NORET });
  return r.ok;
}

// ---------------------------------------------------------------------------------------
// Accept
// ---------------------------------------------------------------------------------------

const ACCEPT: [string, string, string][] = [
  ['cascade: if (c) goto L becomes if (!c)',
    `if (a) goto LAB_1; x(); LAB_1: y();`,
    `if (!a) { x(); } y();`],
  ['negation pushed into the arms: if (!a) X else Y == if (a) Y else X',
    `if (!a) { x(); } else { y(); } z();`,
    `if (a) { y(); } else { x(); } z();`],
  ['UNFOLD: the arm-crossing tail copied into the other arm (MakeMissile shape)',
    `if (!(a & 4)) { x(); LAB_1: y(); } else { z(); if (!(b & 0x10)) goto LAB_1; } w();`,
    `if (!(a & 4)) { x(); y(); } else { z(); if (!(b & 0x10)) { y(); } } w();`],
  ['RETARGET: goto to the label after a loop is break',
    `while (a) { if (b) goto LAB_1; x(); } LAB_1: y();`,
    `while (a) { if (b) break; x(); } y();`],
  ['RETARGET: goto to the empty latch of a do-while is continue',
    `do { if (b) goto LAB_1; x(); LAB_1: ; } while (a); y();`,
    `do { if (b) continue; x(); } while (a); y();`],
  ['RETARGET: a for latch goto is continue and runs the increment',
    `for (int i = 0; i < a; i++) { if (b) goto LAB_1; x(i); LAB_1: ; } y();`,
    `for (int i = 0; i < a; i++) { if (b) continue; x(i); } y();`],
  ['switch: a goto into the next case start is fallthrough',
    `switch (a) { case 1: x(); goto LAB_1; case 2: LAB_1: y(); break; } z();`,
    `switch (a) { case 1: x(); case 2: y(); break; } z();`],
  ['switch: an arm that is only a goto becomes a stacked label',
    `switch (a) { case 1: goto LAB_1; case 2: LAB_1: y(); break; default: w(); } z();`,
    `switch (a) { case 1: case 2: y(); break; default: w(); } z();`],
  ['switch: arms may be reordered',
    `switch (a) { case 1: x(); break; case 2: y(); break; } z();`,
    `switch (a) { case 2: y(); break; case 1: x(); break; } z();`],
  ['short-circuit: nested ifs fold to &&',
    `if (a) { if (b) { x(); } } y();`,
    `if (a && b) { x(); } y();`],
  ['short-circuit: a goto DAG folds to ||',
    `if (a) goto LAB_1; if (!b) goto LAB_2; LAB_1: x(); LAB_2: y();`,
    `if (a || b) { x(); } y();`],
  ['backward goto becomes a loop',
    `LAB_1: x(); if (a) goto LAB_1; y();`,
    `do { x(); } while (a); y();`],
  ['valued return copied to each site (merged epilogue)',
    `if (a) goto LAB_1; x(); LAB_1: return;`,
    `if (a) { return; } x();`],
  ['noreturn tail copied: nothing after it is reachable',
    `if (a) goto LAB_1; x(); return; LAB_1: halt();`,
    `if (a) { halt(); } x(); return;`],
  ['if (false) arm moved into the switch it was entered from',
    `if (false) { LAB_1: y(); } else { switch (a) { case 1: x(); break; default: goto LAB_1; } } z();`,
    `switch (a) { case 1: x(); break; default: y(); break; } z();`],
  ['a pure test whose edges agree is scaffolding: if (x) goto L; L:',
    `if (a) goto LAB_1; LAB_1: y();`,
    `y();`],
  ['two copies of the same work merged (cross-jump) is still an unfolding',
    `if (a) { x(); y(); } else { z(); y(); } w();`,
    `if (a) { x(); } else { z(); } y(); w();`],
];

// ---------------------------------------------------------------------------------------
// Refuse: one mutation each
// ---------------------------------------------------------------------------------------

const REFUSE: [string, string, string, RegExp][] = [
  ['swapped arms without negating',
    `if (a) { x(); } else { y(); } z();`,
    `if (a) { y(); } else { x(); } z();`, /work/],
  ['reordered f() && g() (side effects: the order is observable)',
    `if (f() && g()) { x(); } y();`,
    `if (g() && f()) { x(); } y();`, /test/],
  ['a dropped test with a side effect, even when both edges agree',
    `if (f()) goto LAB_1; LAB_1: y();`,
    `y();`, /test/],
  ['a dropped work statement',
    `if (a) goto LAB_1; x(); LAB_1: y(); w();`,
    `if (!a) { x(); } w();`, /work/],
  ['a continue that now runs the increment it skipped',
    `for (int i = 0; i < a; i++) { if (b) goto LAB_1; x(i); } LAB_1: y();`,
    `for (int i = 0; i < a; i++) { if (b) continue; x(i); } y();`, /./],
  ['a copy missing its last statement',
    `if (!(a & 4)) { x(); LAB_1: y(); v(); } else { if (b) goto LAB_1; } w();`,
    `if (!(a & 4)) { x(); y(); v(); } else { if (b) { y(); } } w();`, /./],
  ['a case label moved to the wrong value',
    `switch (a) { case 1: x(); break; case 2: y(); break; } z();`,
    `switch (a) { case 2: x(); break; case 1: y(); break; } z();`, /./],
  ['a copy that reaches the wrong join',
    `if (a) { x(); LAB_1: y(); } else { if (b) goto LAB_1; v(); } w();`,
    `if (a) { x(); y(); } else { if (b) { y(); return; } v(); } w();`, /./],
  ['a duplicated GetInstructionPointer()',
    `if (a) goto LAB_1; x(); return; LAB_1: n = GetInstructionPointer(); halt();`,
    `if (a) { n = GetInstructionPointer(); halt(); } x(); return; n = GetInstructionPointer(); halt();`, /./],
  ['a copy that a new declaration shadows',
    `if (a) { x(); LAB_1: y(n); } else { int n = 2; z(n); if (b) goto LAB_1; } w();`,
    `if (a) { x(); y(n); } else { int n = 2; z(n); if (b) { y(n); } } w();`, /scope/],
  ['a goto turned into fallthrough (removeOrphanedGotos)',
    `if (a) goto LAB_1; x(); return; LAB_1: y();`,
    `if (a) ; x(); return; y();`, /./],
  ['a fabricated return in a region whose fallthrough is not the function exit',
    `if (a) goto LAB_1; x(); LAB_1: y();`,
    `if (a) { y(); return; } x(); y();`, /./],
  ['a lost switch arm (the 170-arm class)',
    `switch (a) { case 1: x(); goto LAB_1; case 12: y(); LAB_1: z(); break; } w();`,
    `switch (a) { case 1: x(); z(); break; } w();`, /case/],
  ['a flag variable (needs a lemma, not proven here)',
    `while (a) { if (b) goto LAB_1; x(); } y(); LAB_1: z();`,
    `bool found = false; while (a) { if (b) { found = true; break; } x(); } if (!found) { y(); } z();`, /./],
  ['a copied label (the __dup source)',
    `if (a) goto LAB_2; x(); LAB_2: if (b) goto LAB_1; v(); LAB_1: y();`,
    `if (a) { if (b) goto LAB_1; v(); LAB_1: y(); return; } x(); if (b) goto LAB_1; v(); LAB_1: y();`, /duplicate label/],
];

describe('isUnfolding: accepts the rewrites the structurer makes', () => {
  for (const [name, before, after] of ACCEPT) {
    it(name, () => {
      accepted(before, after, { followIsExit: name.includes('return') });
      if (gpp) assert.ok(skeletonSame(before, after), 'the control skeleton must agree with the proof');
    });
  }
});

describe('isUnfolding: refuses every single mutation that changes meaning', () => {
  for (const [name, before, after, why] of REFUSE) {
    it(name, () => {
      const reason = refused(before, after);
      assert.match(reason, why);
    });
  }
  it('the skeleton also tells each meaning-changing mutation apart', { skip: !gpp }, () => {
    // Not every refusal changes meaning (a flag variable may be equivalent; a duplicated
    // GetInstructionPointer() is identical in a skeleton) - but these do, and the
    // execution must see it independently of the proof.
    // The fabricated return only changes meaning inside a nested region; as a whole
    // function body the fall-off IS the return, so it is excluded here too.
    const changesMeaning = REFUSE.filter(([n]) => !/flag variable|GetInstructionPointer|copied label|shadows|fabricated return/.test(n));
    const results = runSkeletons(changesMeaning.map(([name, b, a]) => ({ name, before: body(fn(b)), after: body(fn(a)) })), { noreturn: NORET });
    for (const r of results) assert.equal(r.ok, false, `skeleton could not tell apart: ${r.name}`);
  });
});

describe('isUnfolding: region entry points', () => {
  it('a label targeted from outside the region must survive', () => {
    const r = isUnfolding(body(fn(`x(); LAB_1: y();`)), body(fn(`x(); y();`)), { externalGotoCounts: new Map([['LAB_1', 1]]) });
    assert.ok(!r.ok);
    assert.match((r as { reason: string }).reason, /entry label:LAB_1 lost/);
  });
  it('removing one of the region\'s own gotos does not make its label outside-targeted', () => {
    accepted(`switch (a) { case 1: x(); goto LAB_1; case 2: LAB_1: y(); break; } z();`,
      `switch (a) { case 1: x(); case 2: LAB_1: y(); break; } z();`,
      { externalGotoCounts: new Map([['LAB_1', 1]]) });
  });
  it('a label only targeted from inside may go', () => {
    accepted(`if (a) goto LAB_1; x(); LAB_1: y();`, `if (!a) { x(); } y();`, { externalGotoCounts: new Map([['LAB_1', 1]]) });
  });
  it('a case label whose switch is outside the region is an entry', () => {
    const r = isUnfolding(body(fn(`case 1: x(); break; case 2: y(); break;`)), body(fn(`case 1: x(); break;`)));
    assert.ok(!r.ok);
  });
});

// ---------------------------------------------------------------------------------------
// Mutation testing: random single mutations of every accepted output. The validator may
// refuse an equivalent mutant (that only costs a rewrite), but it must never ACCEPT one the
// compiled skeleton can tell apart from the original.
// ---------------------------------------------------------------------------------------

type Any = any;
function rng(seed: number) {
  let x = seed * 2654435761 >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

interface MSite { holder: Any; field: string; index?: number; node: Any; loops: number }
function sites(stmts: Statement[]): MSite[] {
  const out: MSite[] = [];
  const walk = (holder: Any, field: string, index: number | undefined, node: Any, loops: number) => {
    if (!node || typeof node !== 'object' || typeof node.kind !== 'string') return;
    out.push({ holder, field, index, node, loops });
    const inLoop = loops + (node.kind === NodeKind.WhileStmt || node.kind === NodeKind.DoWhileStmt || node.kind === NodeKind.ForStmt ? 1 : 0);
    if (node.kind === NodeKind.CompoundStmt) node.statements.forEach((c: Any, i: number) => walk(node, 'statements', i, c, inLoop));
    for (const f of ['thenBranch', 'elseBranch', 'body', 'statement']) if (node[f]) walk(node, f, undefined, node[f], inLoop);
  };
  const root = { kind: NodeKind.CompoundStmt, statements: stmts };
  stmts.forEach((c, i) => walk(root, 'statements', i, c, 0));
  return out;
}
function put(s: MSite, v: Any) { if (s.index !== undefined) s.holder[s.field][s.index] = v; else s.holder[s.field] = v; }

/** One random mutation of `stmts` (mutated in place); false when none applied. */
function mutate(stmts: Statement[], r: () => number): boolean {
  const all = sites(stmts);
  const labels = all.filter(s => s.node.kind === NodeKind.LabelStmt).map(s => s.node.label.name);
  const pick = <T,>(xs: T[]): T | undefined => xs.length ? xs[Math.floor(r() * xs.length)] : undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const op = Math.floor(r() * 8);
    if (op === 0) { // swap if arms
      const s = pick(all.filter(x => x.node.kind === NodeKind.IfStmt && x.node.elseBranch));
      if (!s) continue;
      [s.node.thenBranch, s.node.elseBranch] = [s.node.elseBranch, s.node.thenBranch];
      return true;
    }
    if (op === 1) { // drop a non-label statement from a compound
      const s = pick(all.filter(x => x.index !== undefined && x.node.kind !== NodeKind.LabelStmt
        && x.node.kind !== NodeKind.CaseStmt && x.node.kind !== NodeKind.DefaultStmt
        && !JSON.stringify(x.node, (k, v) => typeof v === 'bigint' ? String(v) : v).includes('LabelStmt')));
      if (!s) continue;
      s.holder[s.field].splice(s.index!, 1);
      return true;
    }
    if (op === 2) { // swap adjacent statements
      const s = pick(all.filter(x => x.index !== undefined && x.index + 1 < x.holder[x.field].length));
      if (!s) continue;
      const a = s.holder[s.field];
      [a[s.index!], a[s.index! + 1]] = [a[s.index! + 1], a[s.index!]];
      return true;
    }
    if (op === 3) { // retarget a goto
      const s = pick(all.filter(x => x.node.kind === NodeKind.GotoStmt));
      const to = pick(labels.filter(l => l !== s?.node.label.name));
      if (!s || !to) continue;
      s.node.label = { ...s.node.label, name: to };
      return true;
    }
    if (op === 4) { // break <-> continue inside a loop
      const s = pick(all.filter(x => (x.node.kind === NodeKind.BreakStmt || x.node.kind === NodeKind.ContinueStmt) && x.loops > 0));
      if (!s) continue;
      put(s, { ...s.node, kind: s.node.kind === NodeKind.BreakStmt ? NodeKind.ContinueStmt : NodeKind.BreakStmt });
      return true;
    }
    if (op === 5) { // negate a condition
      const s = pick(all.filter(x => x.node.kind === NodeKind.IfStmt || x.node.kind === NodeKind.WhileStmt || x.node.kind === NodeKind.DoWhileStmt));
      if (!s) continue;
      s.node.condition = { kind: NodeKind.UnaryExpr, operator: '!', operand: { kind: NodeKind.ParenExpr, expression: s.node.condition } };
      return true;
    }
    if (op === 6) { // duplicate a work statement
      const s = pick(all.filter(x => x.index !== undefined && x.node.kind === NodeKind.ExprStmt));
      if (!s) continue;
      s.holder[s.field].splice(s.index!, 0, structuredClone(s.node));
      return true;
    }
    if (op === 7) { // swap two case values
      const cs = all.filter(x => x.node.kind === NodeKind.CaseStmt);
      if (cs.length < 2) continue;
      const a = pick(cs)!, b = pick(cs.filter(x => x !== a))!;
      [a.node.value, b.node.value] = [b.node.value, a.node.value];
      return true;
    }
  }
  return false;
}

describe('isUnfolding: mutation testing against the compiled skeleton', () => {
  it('never accepts a mutant the skeleton tells apart', { skip: !gpp }, () => {
    const pairs: { name: string; before: Statement[]; after: Statement[] }[] = [];
    let refusedCount = 0;
    ACCEPT.forEach(([name, before, after], fi) => {
      const r = rng(fi + 1);
      for (let m = 0; m < 50; m++) {
        const mutant = body(fn(after));
        if (!mutate(mutant, r)) continue;
        const v = isUnfolding(body(fn(before)), mutant, { ...wholeFn(before), followIsExit: name.includes('return') });
        if (v.ok) pairs.push({ name: `${name} #${m}`, before: body(fn(before)), after: mutant });
        else refusedCount++;
      }
    });
    const results = runSkeletons(pairs, { noreturn: NORET });
    const unsound = results.filter(x => !x.ok);
    assert.deepEqual(unsound.map(u => `${u.name}: ${u.detail}`), [], 'the validator accepted a mutant that changes behaviour');
    assert.ok(refusedCount > 500, `expected most mutants refused, got ${refusedCount}`);
  });
});

describe('control skeleton: a binary that does not finish', () => {
  it('is killed at its time limit; pairs it did not report are unproven, not agreement', { skip: !gpp }, () => {
    const t0 = Date.now();
    const res = runSkeletons([
      { name: 'fine', before: body(fn(`if (a) x(); y();`)), after: body(fn(`if (!a) { y(); return; } x(); y();`)) },
      // An empty infinite loop calls no T/D/S, so the step budget never stops it.
      { name: 'spins', before: body(fn(`x(); for (;;) { }`)), after: body(fn(`x(); for (;;) { }`)) },
    ], { noreturn: NORET, runSeconds: 1 });
    const secs = (Date.now() - t0) / 1000;
    assert.ok(secs < 30, `took ${secs}s`);
    assert.equal(res[0].ok, true);
    assert.equal(res[0].timedOut, undefined);
    assert.equal(res[1].ok, false);
    assert.equal(res[1].timedOut, true);
  });
});

describe('control skeleton: region mode', () => {
  it('a fabricated return is told apart when the region does not end the function', { skip: !gpp }, () => {
    const [r] = runSkeletons([{
      name: 'fab', before: body(fn(`if (a) goto LAB_1; x(); LAB_1: y();`)), after: body(fn(`if (a) { y(); return; } x(); y();`)),
      region: { entries: [], followIsExit: false },
    }]);
    assert.equal(r.ok, false);
    const [s] = runSkeletons([{
      name: 'fab-tail', before: body(fn(`if (a) goto LAB_1; x(); LAB_1: y();`)), after: body(fn(`if (a) { y(); return; } x(); y();`)),
      region: { entries: [], followIsExit: true },
    }]);
    assert.equal(s.ok, true);
  });
  it('a switch body region: foreign cases, an outside-targeted label, break and an outside goto', { skip: !gpp }, () => {
    const before = `case 1: x(); goto LAB_1; case 2: LAB_1: y(); break; case 3: if (a) goto LAB_9; LAB_2: z(); break;`;
    const after = `case 1: x(); case 2: y(); break; case 3: if (a) goto LAB_9; LAB_2: z(); break;`;
    const opts = { externalGotoCounts: new Map([['LAB_1', 1], ['LAB_2', 1], ['LAB_9', 1]]) };
    assert.ok(isUnfolding(body(fn(before)), body(fn(after)), opts).ok);
    const pair = (a: string) => ({ name: 'sw', before: body(fn(before)), after: body(fn(a)), region: { entries: ['LAB_2'], followIsExit: false } });
    assert.equal(runSkeletons([pair(after)])[0].ok, true);
    // ...and the same region with the case-3 arm lost, or LAB_2 dropped, is told apart.
    assert.equal(runSkeletons([pair(`case 1: x(); case 2: y(); break;`)])[0].ok, false);
    assert.equal(runSkeletons([pair(`case 1: x(); case 2: y(); break; case 3: if (a) goto LAB_9; z(); break;`)])[0].ok, false);
  });
});
