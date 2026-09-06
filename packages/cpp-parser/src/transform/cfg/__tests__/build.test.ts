/**
 * CFG construction.
 *
 * The cases that matter here are the ones the ad-hoc predicates got wrong: what counts as
 * an entry point of a region, and where control goes when it leaves one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import { traverseAST } from '../../../ast/visitor.js';
import type { CompoundStmt, FunctionDecl, Statement } from '../../../ast/nodes.js';
import { buildCfg } from '../build.js';
import type { Cfg } from '../types.js';

/** The statements of the first function body in `code`. */
function body(code: string): Statement[] {
  for (const n of traverseAST(parse(code))) {
    if (n.kind !== NodeKind.FunctionDecl) continue;
    const fn = n as FunctionDecl;
    if (fn.body?.kind === NodeKind.CompoundStmt) return (fn.body as CompoundStmt).statements;
  }
  throw new Error('no function body in fixture');
}

/** Node ids reachable from the region's entry alone — no jumping in. */
function reachableFromFallthrough(cfg: Cfg): Set<number> {
  const seen = new Set<number>([cfg.entry]);
  const stack = [cfg.entry];
  while (stack.length) {
    for (const s of cfg.nodes[stack.pop()!].succ) {
      if (!seen.has(s)) { seen.add(s); stack.push(s); }
    }
  }
  return seen;
}

function keysOf(cfg: Cfg, ids: Iterable<number>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const k = cfg.nodes[id].key;
    if (k) out.push(k);
  }
  return out.sort();
}

describe('buildCfg', () => {
  it('chains a straight-line sequence and ends at exit', () => {
    const cfg = buildCfg(body('void f() { a(); b(); return 7; }'));
    const keys = keysOf(cfg, reachableFromFallthrough(cfg));
    assert.deepStrictEqual(keys, ['e:a()', 'e:b()', 'r:7']);
    // `return` must land on the synthetic exit, not on whatever follows it.
    const ret = cfg.nodes.find(n => n.key === 'r:7')!;
    assert.deepStrictEqual(ret.succ, [cfg.exit]);
  });

  it('keys a returned value but not a bare return', () => {
    // A bare `return;` is what falling off the end of a void body already does, so it is
    // control flow. `return expr;` computes something and is work.
    const bare = buildCfg(body('void f() { return; }'));
    assert.deepStrictEqual(bare.nodes.map(n => n.key).filter(Boolean), []);
    const valued = buildCfg(body('int f() { return x + 1; }'));
    assert.deepStrictEqual(valued.nodes.map(n => n.key).filter(Boolean), ['r:x + 1']);
  });

  it('gives an if two successors and rejoins them', () => {
    const cfg = buildCfg(body('void f() { if (c) { a(); } else { b(); } d(); }'));
    const ifNode = cfg.nodes.find(n => n.stmt?.kind === NodeKind.IfStmt)!;
    assert.strictEqual(ifNode.succ.length, 2);
    assert.deepStrictEqual(keysOf(cfg, ifNode.succ), ['e:a()', 'e:b()']);
  });

  it('closes a while loop back onto its condition', () => {
    const cfg = buildCfg(body('void f() { while (c) { a(); } b(); }'));
    const loop = cfg.nodes.find(n => n.stmt?.kind === NodeKind.WhileStmt)!;
    const a = cfg.nodes.find(n => n.key === 'e:a()')!;
    assert.deepStrictEqual(a.succ, [loop.id]);
    assert.deepStrictEqual(keysOf(cfg, loop.succ), ['e:a()', 'e:b()']);
  });

  it('runs a do-while body before its condition', () => {
    const cfg = buildCfg(body('void f() { do { a(); } while (c); b(); }'));
    // Entry goes to the BODY, not to the test.
    assert.deepStrictEqual(keysOf(cfg, cfg.nodes[cfg.entry].succ), ['e:a()']);
  });

  it('sends break to after the loop and continue back to the latch', () => {
    const cfg = buildCfg(body('void f() { while (c) { if (x) break; if (y) continue; a(); } b(); }'));
    const loop = cfg.nodes.find(n => n.stmt?.kind === NodeKind.WhileStmt)!;
    const brk = cfg.nodes.find(n => n.stmt?.kind === NodeKind.BreakStmt)!;
    const cont = cfg.nodes.find(n => n.stmt?.kind === NodeKind.ContinueStmt)!;
    assert.deepStrictEqual(keysOf(cfg, brk.succ), ['e:b()']);
    assert.deepStrictEqual(cont.succ, [loop.id]);
  });

  it('wires switch dispatch to every arm, and past the switch when there is no default', () => {
    const cfg = buildCfg(body('void f() { switch (v) { case 1: a(); break; case 2: b(); break; } c(); }'));
    const sw = cfg.nodes.find(n => n.stmt?.kind === NodeKind.SwitchStmt)!;
    const keys = keysOf(cfg, sw.succ);
    assert.ok(keys.includes('c:1'), `dispatch must reach case 1: ${keys}`);
    assert.ok(keys.includes('c:2'), `dispatch must reach case 2: ${keys}`);
    assert.ok(keys.includes('e:c()'), `no default means the switch can be skipped: ${keys}`);
  });

  it('does not let a switch with a default fall past itself', () => {
    const cfg = buildCfg(body('void f() { switch (v) { case 1: a(); break; default: b(); } c(); }'));
    const sw = cfg.nodes.find(n => n.stmt?.kind === NodeKind.SwitchStmt)!;
    assert.ok(!keysOf(cfg, sw.succ).includes('e:c()'));
  });

  it('falls one case arm through into the next', () => {
    const cfg = buildCfg(body('void f() { switch (v) { case 1: a(); case 2: b(); break; } }'));
    const a = cfg.nodes.find(n => n.key === 'e:a()')!;
    assert.deepStrictEqual(keysOf(cfg, a.succ), ['c:2']);
  });

  it('resolves a backward goto to its label', () => {
    // Statements are built right-to-left, so a backward goto is created before its target
    // exists and is patched afterwards. The label node itself carries no key, so follow it.
    const cfg = buildCfg(body('void f() { L: a(); if (c) goto L; b(); }'));
    const go = cfg.nodes.find(n => n.stmt?.kind === NodeKind.GotoStmt)!;
    assert.strictEqual(go.succ.length, 1);
    const target = cfg.nodes[go.succ[0]];
    assert.strictEqual(target.stmt?.kind, NodeKind.LabelStmt);
    assert.deepStrictEqual(keysOf(cfg, target.succ), ['e:a()']);
  });

  it('sends a goto out of the region to the external sink', () => {
    // `LAB_elsewhere` is not defined in the region: the edge must still exist.
    const cfg = buildCfg(body('void f() { a(); goto LAB_elsewhere; }'));
    const go = cfg.nodes.find(n => n.stmt?.kind === NodeKind.GotoStmt)!;
    assert.deepStrictEqual(go.succ, [cfg.external]);
  });

  describe('entry points', () => {
    it('treats a case whose switch is outside the region as an entry point', () => {
      // This is the shape `handleUnconditionalGoto` deleted 170 times: a slice of a
      // switch BODY. Nothing falls into `case 2` — the dispatch jumps to it.
      const stmts = body('void f() { case 1: a(); break; case 2: b(); break; }');
      const cfg = buildCfg(stmts);
      const fallthrough = keysOf(cfg, reachableFromFallthrough(cfg));
      assert.ok(!fallthrough.includes('c:2'), 'case 2 is not reachable by fallthrough');
      assert.ok(
        keysOf(cfg, cfg.extraEntries).includes('c:2'),
        'case 2 must still be an entry point of the region',
      );
    });

    it('does not treat a nested switch\'s own cases as region entry points', () => {
      const cfg = buildCfg(body('void f() { a(); switch (v) { case 1: b(); break; } }'));
      assert.deepStrictEqual(keysOf(cfg, cfg.extraEntries), []);
    });

    it('treats a label as an entry point when the function has more gotos than the region', () => {
      const stmts = body('void f() { a(); L: b(); }');
      // One goto to L lives outside this region.
      const cfg = buildCfg(stmts, { externalGotoCounts: new Map([['L', 1]]) });
      assert.strictEqual(cfg.extraEntries.length, 1);
      assert.deepStrictEqual(keysOf(cfg, cfg.nodes[cfg.extraEntries[0]].succ), ['e:b()']);
    });

    it('does not treat a label as an entry point when every goto to it is inside the region', () => {
      const stmts = body('void f() { if (c) goto L; a(); L: b(); }');
      const cfg = buildCfg(stmts, { externalGotoCounts: new Map([['L', 1]]) });
      assert.deepStrictEqual(cfg.extraEntries, []);
    });

    it('assumes every label is entered when whole-function counts are unavailable', () => {
      // The safe answer: deleting less than we could is a cost, deleting live code is a defect.
      const cfg = buildCfg(body('void f() { a(); L: b(); }'));
      assert.strictEqual(cfg.extraEntries.length, 1);
    });
  });

  it('keys work but not conditions', () => {
    // A cascade legitimately rewrites `if (c)` into `if (!c)`; keying on the condition
    // would report every correct cascade as a loss.
    const cfg = buildCfg(body('void f() { if (c) { a(); } }'));
    const ifNode = cfg.nodes.find(n => n.stmt?.kind === NodeKind.IfStmt)!;
    assert.strictEqual(ifNode.key, null);
    assert.strictEqual(cfg.nodes.find(n => n.stmt?.kind === NodeKind.ExprStmt)!.key, 'e:a()');
  });

  it('keys a case label, because the label is the only evidence the arm exists', () => {
    const cfg = buildCfg(body("void f() { switch (v) { case '\\f': a(); break; default: b(); } }"));
    const keys = cfg.nodes.map(n => n.key).filter(Boolean);
    assert.ok(keys.includes("c:'\\f'"), `case label must be keyed: ${keys}`);
    assert.ok(keys.includes('c:default'));
  });
});
