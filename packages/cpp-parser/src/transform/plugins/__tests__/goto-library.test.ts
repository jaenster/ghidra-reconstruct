/**
 * E1 evidence (library-evidence.ts): what the library source licenses, and only that.
 *   - a rethread (T4) happens only at a label the evidence marks; the same shape at any other
 *     label keeps its goto;
 *   - an E1 copy is exactly the block the evidence describes: a tail of another size, or a
 *     join where the evidence speaks of the block at the label, gets no E1.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import { traverseAST } from '../../../ast/visitor.js';
import type { ASTNode, CompoundStmt, FunctionDecl, Statement } from '../../../ast/nodes.js';
import { gotoCleanupPlugin, resetGotoCleanupStats, getGotoCleanupStats } from '../builtins/goto-cleanup/index.js';
import { copyIsFaithful } from '../builtins/goto-cleanup/copy-policy.js';

function run(code: string): string {
  resetGotoCleanupStats();
  return emit(gotoCleanupPlugin.createTransformer()(parse(code)) as never);
}
function stmts(code: string): Statement[] {
  for (const n of traverseAST(parse(`void f() { ${code} }`))) {
    if (n.kind === NodeKind.FunctionDecl) return ((n as FunctionDecl).body as CompoundStmt).statements;
  }
  throw new Error('no body');
}

const DEFLATE = (a: string, b: string) => `int f(S *s, Z *z, int fl) {
  if (s->status == 0x29a) {
    if (z->avail_in != 0) { z->msg = "buffer error"; return -5; }
    ${a}:
    if (s->lookahead == 0 && (fl == 0 || s->status == 0x29a)) goto ${b};
  } else if (z->avail_in == 0) goto ${a};
  block(s, fl);
  ${b}:
  if (fl != 4) return 0;
  trailer(s, 1);
  trailer(s, 2);
  trailer(s, 3);
  flush(z);
  return s->pending == 0;
}`;

describe('E1: rethread only where the library source shows the second test', () => {
  it('deflate.c 893/899 at its own labels: two ifs, the source form', () => {
    const out = run(DEFLATE('LAB_004292b9', 'LAB_004293b8'));
    assert.doesNotMatch(out, /goto/);
    assert.match(out, /if \(s->status == 0x29a && z->avail_in != 0\)/);
    assert.match(out, /if \(z->avail_in != 0 \|\| s->lookahead != 0 \|\| fl != 0 && s->status != 0x29a\)/);
    assert.equal(getGotoCleanupStats().rethread, 1);
  });
  it('the same shape at labels with no evidence keeps its gotos', () => {
    const out = run(DEFLATE('LAB_00401000', 'LAB_00401010'));
    assert.match(out, /goto LAB_00401000/);
    assert.equal(getGotoCleanupStats().rethread, 0);
  });
});

describe('E1: the copy is the block the evidence describes', () => {
  const facts = (label: string, sunkJoin = false) => ({
    sites: [{ prefix: 's:a' }, { prefix: 's:b' }], hasFallthrough: true, fallthroughPrefix: 's:c', noreturn: new Set<string>(), label, sunkJoin,
  });
  it('send_tree LAB_0042c33b: one store is E1', () => {
    assert.equal(copyIsFaithful(stmts('s->bi_valid = n;'), facts('LAB_0042c33b')), 'E1');
  });
  it('a longer tail at the same label is not', () => {
    assert.notEqual(copyIsFaithful(stmts('s->bi_valid = n; s->x = 1; s->y = 2; s->z = 3;'), facts('LAB_0042c33b')), 'E1');
  });
  it('a join at a label whose evidence is the block (and the reverse) is not', () => {
    assert.notEqual(copyIsFaithful(stmts('s->bi_valid = n;'), facts('LAB_0042c33b', true)), 'E1');
    assert.notEqual(copyIsFaithful(stmts('s->status = 0x49;'), facts('LAB_00429052', false)), 'E1');
    assert.equal(copyIsFaithful(stmts('s->status = 0x49;'), facts('LAB_00429052', true)), 'E1');
  });
});

describe('E6 without evidence: a jump to a join is not a cross-jump (step-11 review)', () => {
  const region = (code: string) => stmts(code);
  const judge = (code: string, tail: string, label: string) => {
    const r = region(code);
    return copyIsFaithful(stmts(tail), {
      sites: [{ prefix: 's:a' }], hasFallthrough: true, fallthroughPrefix: 's:b', noreturn: new Set<string>(), label, region: r, tailInRegion: stmts(tail),
    });
  };
  it('refused: a search loop exit that falls into the same tail when nothing is found (SetPlayerRelationship 0055b3a0)', () => {
    const code = `for (p = list; p != 0; p = p->next) { if (p->id == id) goto LAB_1; } p = 0; LAB_1: if (p != 0) p->rel = r; return;`;
    assert.equal(judge(code, `if (p != 0) p->rel = r; return;`, 'LAB_1'), null);
  });
  it('refused: a guard that skips code falling on into the tail', () => {
    const code = `if (u == 0) goto LAB_1; pkt.guid = u->guid; LAB_1: Send(pkt); return;`;
    assert.equal(judge(code, `Send(pkt); return;`, 'LAB_1'), null);
  });
  it('kept: an arm end that cannot fall into the tail (the arm returns otherwise)', () => {
    const code = `if (a) { x(); if (b) goto LAB_1; y(); return; } z(); LAB_1: Done(q); return;`;
    assert.equal(judge(code, `Done(q); return;`, 'LAB_1'), 'E6');
  });
});
