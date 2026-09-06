/**
 * The preservation check.
 *
 * Every "must accept" case here is a rewrite the goto passes really perform, and every
 * "must reject" case is a shape that has actually shipped broken code. The point of the
 * accept cases is that a check nobody can satisfy just gets switched off.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import { traverseAST } from '../../../ast/visitor.js';
import type { CompoundStmt, FunctionDecl, Statement } from '../../../ast/nodes.js';
import { preservesReachableWork } from '../preserve.js';
import type { BuildCfgOptions } from '../types.js';

function body(code: string): Statement[] {
  for (const n of traverseAST(parse(code))) {
    if (n.kind !== NodeKind.FunctionDecl) continue;
    const fn = n as FunctionDecl;
    if (fn.body?.kind === NodeKind.CompoundStmt) return (fn.body as CompoundStmt).statements;
  }
  throw new Error('no function body in fixture');
}

function check(beforeSrc: string, afterSrc: string, options: BuildCfgOptions = {}) {
  return preservesReachableWork(body(beforeSrc), body(afterSrc), options);
}

function assertAccepted(beforeSrc: string, afterSrc: string, options: BuildCfgOptions = {}) {
  const r = check(beforeSrc, afterSrc, options);
  assert.ok(r.ok, `should have been accepted\nlost keys: ${r.lostKeys}\nlost edges: ${r.lostEdges}`);
}

function assertRejected(beforeSrc: string, afterSrc: string, options: BuildCfgOptions = {}) {
  const r = check(beforeSrc, afterSrc, options);
  assert.ok(!r.ok, 'should have been rejected but was accepted');
  return r;
}

describe('preservesReachableWork', () => {
  describe('rejects a rewrite that drops reachable work', () => {
    it('catches a deleted switch arm — the CheckCollision_BlockPlayer_Cross shape', () => {
      // `case 3` hosts the label `case 2` jumps into. Deleting the span between the goto
      // and the label takes the whole arm with it, which is what shipped.
      const before = `void f() {
        switch (v) {
          case 1: a(); break;
          case 2: p(); goto L;
          case 3: q(); L: r(); break;
        }
      }`;
      const after = `void f() {
        switch (v) {
          case 1: a(); break;
          case 2: p(); r(); break;
        }
      }`;
      const r = assertRejected(before, after);
      assert.ok(r.lostKeys.some(k => k.startsWith('c:3')), `case 3 must be reported: ${r.lostKeys}`);
      assert.ok(r.lostKeys.some(k => k.startsWith('e:q()')), `its body must be reported: ${r.lostKeys}`);
    });

    it('catches a fallthrough path deleted while the statement count stays the same', () => {
      // The count-only check passes here: `t()` still appears once. What is gone is the
      // path from `a()` into it — `a()` used to fall through the label.
      const before = 'void f() { if (c) goto L; a(); L: t(); }';
      const after = 'void f() { if (c) { t(); } a(); }';
      const r = assertRejected(before, after);
      assert.deepStrictEqual(r.lostKeys, [], 'no key is lost - only an edge');
      assert.ok(r.lostEdges.some(e => e.startsWith('e:a() =>')), `a() -> t() must be reported: ${r.lostEdges}`);
    });

    it('catches an if(false) arm that a goto jumps into', () => {
      const before = 'void f() { if (false) { L: a(); } if (c) goto L; b(); }';
      const after = 'void f() { if (c) goto L; b(); }';
      assertRejected(before, after);
    });

    it('catches a case arm deleted from a bare switch-body region', () => {
      // A region that IS a switch body: the dispatch is outside it, so every case is an
      // entry point and nothing in an arm is dead however unreachable it looks.
      const before = 'void f() { case 1: a(); break; case 2: b(); break; }';
      const after = 'void f() { case 1: a(); break; }';
      const r = assertRejected(before, after);
      assert.ok(r.lostKeys.some(k => k.startsWith('c:2')));
    });
  });

  describe('accepts the rewrites these passes are for', () => {
    it('accepts a forward-goto cascade that negates the condition', () => {
      // `if (c) goto L; A; L: T;` -> `if (!c) { A; } T;`
      assertAccepted(
        'void f() { if (c) goto L; a(); L: t(); }',
        'void f() { if (!c) { a(); } t(); }',
        { externalGotoCounts: new Map([['L', 1]]) },
      );
    });

    it('accepts an unconditional goto whose skipped span really is dead', () => {
      assertAccepted(
        'void f() { a(); goto L; dead(); L: t(); }',
        'void f() { a(); t(); }',
        { externalGotoCounts: new Map([['L', 1]]) },
      );
    });

    it('accepts a tail inlined at two goto sites', () => {
      // Duplication is fine: the invariant is that nothing becomes unreachable.
      assertAccepted(
        'void f() { if (c) goto L; if (d) goto L; a(); return; L: t(); }',
        'void f() { if (c) { t(); return; } if (d) { t(); return; } a(); return; }',
        { externalGotoCounts: new Map([['L', 2]]) },
      );
    });

    it('accepts a loop-exit goto turned into flag + break', () => {
      // The rewrite INSERTS `bool found` and `found = true`, which splits edges that
      // existed before. Inserted work has to be transparent or every such pass is vetoed.
      assertAccepted(
        'void f(int x) { while (x > 0) { if (x == 5) goto L; x = x - 1; } return; L: t(); }',
        `void f(int x) {
           bool found = false;
           while (x > 0) { if (x == 5) { found = true; break; } x = x - 1; }
           if (!found) return;
           t();
         }`,
        { externalGotoCounts: new Map([['L', 1]]) },
      );
    });

    it('accepts a backward goto turned into a do-while', () => {
      assertAccepted(
        'void f() { L: a(); b(); if (c) goto L; d(); }',
        'void f() { do { a(); b(); } while (c); d(); }',
        { externalGotoCounts: new Map([['L', 1]]) },
      );
    });

    it('accepts a goto-out-of-switch turned into break', () => {
      assertAccepted(
        'void f() { switch (v) { case 1: a(); goto L; case 2: b(); goto L; } L: t(); }',
        'void f() { switch (v) { case 1: a(); break; case 2: b(); break; } t(); }',
        { externalGotoCounts: new Map([['L', 2]]) },
      );
    });

    it('accepts a no-op rewrite', () => {
      const src = 'void f() { switch (v) { case 1: a(); break; default: b(); } }';
      assertAccepted(src, src);
    });
  });

  describe('entry-point assumptions', () => {
    it('protects a label when the whole-function goto counts are not supplied', () => {
      // Without counts every label is assumed to be entered from outside, so its body is
      // live and deleting it is a loss.
      assertRejected('void f() { a(); L: t(); }', 'void f() { a(); }');
    });

    it('allows the same deletion once the counts show nothing targets the label', () => {
      assertAccepted(
        'void f() { a(); return; L: t(); }',
        'void f() { a(); return; }',
        { externalGotoCounts: new Map() },
      );
    });
  });
});
