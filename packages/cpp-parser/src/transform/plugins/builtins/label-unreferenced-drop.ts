/**
 * Drop every label no goto of its function names - the last control-flow step.
 *
 * Raw Ghidra prints a label only where a goto lands. The goto passes, and the passes after
 * them, remove gotos without always removing the label they targeted: `exact:ifFalseArm`
 * moves Ghidra's `if (false) { L: X }` arm into the switch as the `default:` that was
 * `goto L` and carries `L:` along, `dead-branch-cleanup` deletes Ghidra's own
 * `if (false) goto L;`, `halt-site-fold` copies a shared halt tail to its jumps. Each of
 * those was proven value-preserving where it removed the goto (round 13: all 27 labels at
 * v1531); what it left is a name with nothing pointing at it, which reads as a jump target
 * that is not one and keeps a Ghidra address in the tree.
 *
 * So this runs after every pass that can add or remove a goto (halt-site-fold at 930, the
 * label restore at 985), once per function - labels are function-scoped - and replaces
 * `L: S` by `S` for every L that no goto in the same function names. A label on an empty
 * statement in a block (`L: ;`) goes with its statement; anywhere else (a case arm, an
 * if/loop body) the statement stays, since that position needs one.
 *
 * Nothing else changes: no goto is touched, and a label that is still targeted - from
 * anywhere in its function, nested scopes included - is kept.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, CompoundStmt, FunctionDecl, GotoStmt, LabelStmt, Statement } from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, updateNode } from '../../transformer.js';
import type { TransformPlugin } from '../types.js';
import { childStatements, withChildStatements } from './stmt-structure.js';

const STATS_KEY = Symbol.for('ghidra-mcp:label-unreferenced-drop-stats');
const STATS: { dropped: number } = ((globalThis as Record<symbol, unknown>)[STATS_KEY] ??= { dropped: 0 }) as { dropped: number };

/** Labels dropped since the last reset. */
export function getUnreferencedLabelsDropped(): number { return STATS.dropped; }
export function resetUnreferencedLabelsDropped(): void { STATS.dropped = 0; }

/** Every label name a goto in `root` targets. */
function gotoTargets(root: ASTNode): Set<string> {
  const out = new Set<string>();
  for (const n of traverseAST(root)) if (n.kind === NodeKind.GotoStmt) out.add((n as GotoStmt).label.name);
  return out;
}

function strip(s: Statement, targeted: ReadonlySet<string>, inBlock: boolean): Statement | null {
  if (s.kind === NodeKind.LabelStmt) {
    const l = s as LabelStmt;
    // The labelled statement is never removed from under a label: that position needs one.
    const inner = strip(l.statement, targeted, false) as Statement;
    if (targeted.has(l.label.name)) {
      return inner === l.statement ? s : updateNode(l, { statement: inner } as Partial<LabelStmt>);
    }
    STATS.dropped++;
    return inBlock && inner.kind === NodeKind.NullStmt ? null : inner;
  }
  const kids = childStatements(s);
  if (!kids.length) return s;
  const isBlock = s.kind === NodeKind.CompoundStmt;
  let changed = false;
  const out: Statement[] = [];
  for (const k of kids) {
    const r = strip(k, targeted, isBlock);
    if (r !== k) changed = true;
    if (r) out.push(r);
  }
  if (!changed) return s;
  if (isBlock) return updateNode(s as CompoundStmt, { statements: out });
  return withChildStatements(s, out);
}

/** `strip` returns null only for an unreferenced `L: ;` directly in a block. */
function dropUnreferencedLabels(fnBody: Statement, scope: ASTNode): Statement {
  const targeted = gotoTargets(scope);
  let any = false;
  for (const n of traverseAST(fnBody)) {
    if (n.kind === NodeKind.LabelStmt && !targeted.has((n as LabelStmt).label.name)) { any = true; break; }
  }
  if (!any) return fnBody;
  return strip(fnBody, targeted, false) ?? fnBody;
}

export const labelUnreferencedDropPlugin: TransformPlugin = {
  id: 'label-unreferenced-drop',
  name: 'Unreferenced Label Drop',
  description: 'Drop every label that no goto of its function targets (after all goto passes)',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 986,
  tags: ['control-flow', 'cleanup'],
  createTransformer: () => {
    const perFunction = createTransformer({
      visitFunctionDecl(fn: FunctionDecl) {
        if (!fn.body) return undefined;
        const body = dropUnreferencedLabels(fn.body as Statement, fn.body as ASTNode);
        return body === fn.body ? undefined : updateNode(fn, { body } as Partial<FunctionDecl>);
      },
    });
    return (node: ASTNode): ASTNode => {
      for (const n of traverseAST(node)) if (n.kind === NodeKind.FunctionDecl) return perFunction(node);
      // A bare body (no FunctionDecl around it) is one function's statements.
      return dropUnreferencedLabels(node as Statement, node) as ASTNode;
    };
  },
};
