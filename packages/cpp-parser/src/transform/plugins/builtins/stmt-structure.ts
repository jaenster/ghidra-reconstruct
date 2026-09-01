/**
 * Statement-structure helpers.
 *
 * A label and a `goto` are STATEMENTS, so a pass that has to reason about where
 * one sits relative to another needs the statement tree and nothing else. These
 * two functions are that tree: `childStatements` lists a statement's statement
 * children in source order, and `withChildStatements` puts a rebuilt list back.
 *
 * They are deliberately a matched pair — the same order in, the same order out —
 * so a pass can walk once to decide and once to rewrite and be sure the two
 * walks visit the same positions. That is what lets a decision be keyed on a
 * structural PATH rather than on node identity, which the transformer does not
 * preserve (`transformChildren` shallow-copies every node it descends through).
 *
 * Expressions are not descended into: a `goto`/label cannot appear inside one in
 * decompiled C, and skipping them keeps the two walks aligned.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  Statement, CompoundStmt, IfStmt, SwitchStmt, CaseStmt, DefaultStmt,
  WhileStmt, DoWhileStmt, ForStmt, ForRangeStmt, LabelStmt, TryStmt,
} from '../../../ast/nodes.js';
import { updateNode } from '../../transformer.js';

/** A statement's statement children, in source order. */
export function childStatements(s: Statement): Statement[] {
  switch (s.kind) {
    case NodeKind.CompoundStmt:
      return (s as CompoundStmt).statements;
    case NodeKind.IfStmt: {
      const n = s as IfStmt;
      return n.elseBranch ? [n.thenBranch, n.elseBranch] : [n.thenBranch];
    }
    case NodeKind.SwitchStmt:
      return [(s as SwitchStmt).body];
    case NodeKind.CaseStmt:
      return [(s as CaseStmt).statement];
    case NodeKind.DefaultStmt:
      return [(s as DefaultStmt).statement];
    case NodeKind.LabelStmt:
      return [(s as LabelStmt).statement];
    case NodeKind.WhileStmt:
      return [(s as WhileStmt).body];
    case NodeKind.DoWhileStmt:
      return [(s as DoWhileStmt).body];
    case NodeKind.ForStmt:
      return [(s as ForStmt).body];
    case NodeKind.ForRangeStmt:
      return [(s as ForRangeStmt).body];
    case NodeKind.TryStmt:
      return [(s as TryStmt).body];
    default:
      return [];
  }
}

/** Rebuild `s` with `kids` in place of the list `childStatements(s)` returned. */
export function withChildStatements(s: Statement, kids: Statement[]): Statement {
  switch (s.kind) {
    case NodeKind.CompoundStmt:
      return updateNode(s as CompoundStmt, { statements: kids } as Partial<CompoundStmt>);
    case NodeKind.IfStmt: {
      const n = s as IfStmt;
      return n.elseBranch
        ? updateNode(n, { thenBranch: kids[0], elseBranch: kids[1] } as Partial<IfStmt>)
        : updateNode(n, { thenBranch: kids[0] } as Partial<IfStmt>);
    }
    case NodeKind.SwitchStmt:
      return updateNode(s as SwitchStmt, { body: kids[0] } as Partial<SwitchStmt>);
    case NodeKind.CaseStmt:
      return updateNode(s as CaseStmt, { statement: kids[0] } as Partial<CaseStmt>);
    case NodeKind.DefaultStmt:
      return updateNode(s as DefaultStmt, { statement: kids[0] } as Partial<DefaultStmt>);
    case NodeKind.LabelStmt:
      return updateNode(s as LabelStmt, { statement: kids[0] } as Partial<LabelStmt>);
    case NodeKind.WhileStmt:
      return updateNode(s as WhileStmt, { body: kids[0] } as Partial<WhileStmt>);
    case NodeKind.DoWhileStmt:
      return updateNode(s as DoWhileStmt, { body: kids[0] } as Partial<DoWhileStmt>);
    case NodeKind.ForStmt:
      return updateNode(s as ForStmt, { body: kids[0] } as Partial<ForStmt>);
    case NodeKind.ForRangeStmt:
      return updateNode(s as ForRangeStmt, { body: kids[0] } as Partial<ForRangeStmt>);
    case NodeKind.TryStmt:
      return updateNode(s as TryStmt, { body: kids[0] as CompoundStmt } as Partial<TryStmt>);
    default:
      return s;
  }
}
