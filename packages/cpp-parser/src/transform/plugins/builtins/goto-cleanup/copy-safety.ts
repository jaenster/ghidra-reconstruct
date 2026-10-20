/**
 * What a tail-copying handler must know about the tail before it copies it.
 *
 * Three facts, each the cause of a defect the existing handlers shipped:
 *
 *   - A tail holding a label, `case` or `default` is never copied. Copying a label is the
 *     whole source of the `__dupN` labels: raw Ghidra defines no label twice, and every
 *     duplicate in the tree came from a handler copying a tail that held one, after which
 *     `duplicate-label-uniquify` renamed the copy. A copied `case` would be a second arm for
 *     one value.
 *   - Size is counted in WORK NODES, recursively. Counting top-level statements let a whole
 *     `while` holding a `switch` and 18 internal gotos pass as "1 statement" under a limit of
 *     20 (ITEM_DeserializeFromBitBuffer 0062cbe0).
 *   - A tail inside a switch body ends at the next `case`/`default` label. Running "to the end
 *     of the compound" pulled the following arms into the tail, so a short `L: f(); return 1;`
 *     followed by `case 0x16:` looked like a 40-statement tail and was declined (34 of the 60
 *     exit-epilogue gotos), and when it was not declined the copy carried case labels.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type { ASTNode, Statement } from '../../../../ast/nodes.js';
import { getChildren } from '../../../../ast/visitor.js';

/** Statement kinds that are scaffolding, not work. */
const SCAFFOLD = new Set<string>([NodeKind.CompoundStmt, NodeKind.LabelStmt, NodeKind.NullStmt]);

/** Statements in `stmts`, counted recursively, scaffolding excluded. */
export function workNodes(stmts: Statement[]): number {
  let n = 0;
  const walk = (s: ASTNode): void => {
    if (!s || typeof s !== 'object') return;
    const k = String(s.kind);
    if (!k.endsWith('Stmt')) return;
    if (!SCAFFOLD.has(k)) n++;
    for (const c of getChildren(s)) if (String(c.kind).endsWith('Stmt')) walk(c);
  };
  for (const s of stmts) walk(s as ASTNode);
  return n;
}

/** True when any statement in `stmts`, at any depth, is a label, `case` or `default`. */
export function holdsLabelOrCase(stmts: Statement[]): boolean {
  const walk = (s: ASTNode): boolean => {
    if (!s || typeof s !== 'object') return false;
    if (s.kind === NodeKind.LabelStmt || s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) return true;
    for (const c of getChildren(s)) if (String(c.kind).endsWith('Stmt') && walk(c)) return true;
    return false;
  };
  return stmts.some(s => walk(s as ASTNode));
}

/**
 * The part of a label's tail that belongs to its own switch arm: everything up to the next
 * top-level `case`/`default`. `cut` is true when the tail was shortened - falling off it then
 * runs into the next arm, never to the function's return.
 */
export function cutAtCase(tail: Statement[]): { tail: Statement[]; cut: boolean } {
  for (let i = 1; i < tail.length; i++) {
    if (tail[i].kind === NodeKind.CaseStmt || tail[i].kind === NodeKind.DefaultStmt) return { tail: tail.slice(0, i), cut: true };
  }
  return { tail, cut: false };
}
