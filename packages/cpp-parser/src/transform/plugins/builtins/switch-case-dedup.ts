/**
 * Duplicate Switch-Case Label Plugin
 *
 * Ghidra's switch recovery sometimes emits the same `case` value — or a second
 * `default` — inside one switch. C++ rejects both ("duplicate case value",
 * "multiple default labels"). The second occurrence is unreachable anyway: the
 * first label already matches that value.
 *
 * Drop the duplicate LABEL and keep the statement it labelled, so the code stays
 * where it was as now-explicitly-unreachable fallthrough — the same disposition
 * the text pass this replaces had, without commenting anything out.
 *
 * ## Why this had to leave the text
 *
 * The label runs to the first `:` that is not part of a `::`. Written as a
 * regex over emitted lines that was `case\s+([^:]+):`, which stops at the SCOPE
 * operator: once `enum-constant-qualify` began emitting `<Enum>_ns::Name`, every
 * such label reduced to its namespace and the second one in any switch was
 * struck out as a duplicate of the first. It was caught before it shipped, and
 * it is the whole argument for doing this on the tree: a `CaseStmt.value` is one
 * expression node whether it is `3`, `EnumName_ns::CONSTANT` or `A::B::C`.
 *
 * Values are compared by VALUE where they are literals, so `case 0:` and
 * `case 0x0:` are the same label — which a text compare of the two spellings
 * missed.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, SwitchStmt, Statement, CaseStmt, DefaultStmt,
  Expression, IntegerLiteralExpr, CharLiteralExpr, BoolLiteralExpr, UnaryExpr, ParenExpr,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { emit } from '../../../emit/index.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { childStatements, withChildStatements } from './stmt-structure.js';

export interface SwitchCaseDedupOptions extends PluginOptions {}

/**
 * Identity of a case label. A literal compares by its VALUE (so `0` and `0x0`
 * are one label); anything else compares by its emitted spelling, which for a
 * qualified enumerator is the whole `<Enum>_ns::Name` and not a prefix of it.
 */
function caseKey(e: Expression): string {
  let x = e;
  let negate = false;
  for (;;) {
    if (x.kind === NodeKind.ParenExpr) { x = (x as ParenExpr).expression; continue; }
    if (x.kind === NodeKind.UnaryExpr) {
      const u = x as UnaryExpr;
      if (u.operator === '-') { negate = !negate; x = u.operand; continue; }
      if (u.operator === '+') { x = u.operand; continue; }
    }
    break;
  }
  switch (x.kind) {
    case NodeKind.IntegerLiteral: {
      const v = (x as IntegerLiteralExpr).value;
      return `#${negate ? -v : v}`;
    }
    case NodeKind.CharLiteral: {
      const v = (x as CharLiteralExpr).value;
      return `#${negate ? -v : v}`;
    }
    case NodeKind.BoolLiteral:
      return `#${(x as BoolLiteralExpr).value ? 1 : 0}`;
    default:
      return (negate ? '-' : '') + emit(e);
  }
}

interface DedupState { seen: Set<string>; hasDefault: boolean; changed: boolean }

/**
 * Strip duplicate labels off one statement of a switch body.
 *
 * A `case` label belongs to its nearest enclosing switch however deeply it is
 * nested, and Ghidra's recovery does nest them — a second `case 6:` can sit
 * inside an `if` inside the switch. So this descends through every statement
 * form and stops only at a nested SWITCH, which owns its own labels and is
 * deduplicated by its own visit against its own set of values.
 */
function stripDuplicateLabels(s: Statement, st: DedupState): Statement {
  if (s.kind === NodeKind.SwitchStmt) return s;

  if (s.kind === NodeKind.CaseStmt) {
    const c = s as CaseStmt;
    const key = caseKey(c.value);
    const inner = stripDuplicateLabels(c.statement, st);
    if (st.seen.has(key)) { st.changed = true; return inner; }
    st.seen.add(key);
    return inner === c.statement ? c : updateNode(c, { statement: inner } as Partial<CaseStmt>);
  }

  if (s.kind === NodeKind.DefaultStmt) {
    const d = s as DefaultStmt;
    const inner = stripDuplicateLabels(d.statement, st);
    if (st.hasDefault) { st.changed = true; return inner; }
    st.hasDefault = true;
    return inner === d.statement ? d : updateNode(d, { statement: inner } as Partial<DefaultStmt>);
  }

  const kids = childStatements(s);
  if (kids.length === 0) return s;
  let changed = false;
  const newKids = kids.map(k => {
    const nk = stripDuplicateLabels(k, st);
    if (nk !== k) changed = true;
    return nk;
  });
  return changed ? withChildStatements(s, newKids) : s;
}

function createSwitchCaseDedupTransformer(_options: SwitchCaseDedupOptions = {}): Transformer {
  return createTransformer({
    visitSwitchStmt(node: SwitchStmt): ASTNode | undefined {
      const st: DedupState = { seen: new Set(), hasDefault: false, changed: false };
      const body = stripDuplicateLabels(node.body, st);
      if (!st.changed) return undefined;
      return updateNode(node, { body } as Partial<SwitchStmt>);
    },
  });
}

export const switchCaseDedupPlugin: TransformPlugin = {
  id: 'switch-case-dedup',
  name: 'Duplicate Switch-Case Label Removal',
  description: 'Drops a repeated `case` value or a second `default` in one switch, keeping the statement it labelled',
  version: '1.0.0',
  defaultEnabled: true,
  // After switch-reconstruct and enum-constant-qualify, so the switch exists and
  // its labels wear their final spelling.
  priority: 691,
  tags: ['cleanup', 'control-flow', 'switch'],
  createTransformer: createSwitchCaseDedupTransformer,
};
