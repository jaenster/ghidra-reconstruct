/**
 * Jump Table Case Plugin
 *
 * VC8 compiles a dense switch to `cmp ecx, MAX; ja FALLBACK; jmp [table + ecx*4]`, where MAX
 * is the largest case the source wrote. A case whose body is the code after the switch
 * (`case 5: return 0;` in front of a trailing `return 0;`) shares that code's address, and
 * the decompiler folds it into the fallback, so the decompile has no `case 5`. Compiled
 * back, the table ends one entry early (`cmp ecx, 4`):
 *
 *   switch (pUnit->eUnitType) {          // GetUnitSizeX 00620510: 6 entries, the bound 5
 *   case UNIT_PLAYER: return 2;
 *   ...
 *   case UNIT_ITEM: return 1;
 *   }                                    // entry 5 -> the `return 0` below, as is `ja`
 *   return 0;
 *
 * From the decompiler's own jump table (`jumpTables`), the table's last entry gets its case
 * back when it goes where the bound check sends an uncovered value and the decompile prints
 * no case for it:
 *
 *  - without a `default:`, after the last group, with a copy of what follows the switch,
 *    which must be a `return` of a constant (or a bare `return;`) whose code holds the
 *    fallback. `case 5: break;` would not do: VC8 drops an empty case from the table;
 *  - with a `default:`, as one more label on it.
 *
 * Only a jump-table switch the decompiler printed (its line prints the indirect jump), whose
 * table the decompiler labelled with case values, and whose `case` labels are exactly the
 * entries that do not go to the fallback: a switch another pass reshaped is left alone. The
 * value reaches the same code as before, so nothing a path computes changes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, FunctionDecl, ReturnStmt, Statement, SwitchStmt, CaseStmt, DefaultStmt, Expression,
  IfStmt, CStyleCastExpr, ParenExpr, UnaryExpr,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { LayoutReader, type BranchLayoutEvidence } from './branch-layout/evidence.js';

/** One jump table as reconstruct's extract/jump-tables.ts reads it. */
export interface JumpTableFact {
  /** The indirect jump's offset from the function entry. */
  at: number;
  /** Where the bound check's conditional jump goes. */
  fallback?: number;
  bound?: number;
  /** The decompiler labelled every entry with its case value. */
  labelled: boolean;
  entries: ReadonlyArray<{ value: number; target: number }>;
}

export interface JumpTableCaseOptions extends PluginOptions {
  jumpTables?: readonly JumpTableFact[];
  /** The original's addresses, keyed by line of the parsed text. */
  branchLayout?: BranchLayoutEvidence | null;
  onSite?: (e: { rule: 'case' | 'left'; line: number; value?: number; why?: string }) => void;
}

function isLabel(s: Statement): boolean {
  return s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt;
}

/** Every `case` and `default` label at the top of a switch body, through label runs. */
function labelsOf(body: readonly Statement[]): { cases: number; defaults: number } {
  let cases = 0, defaults = 0;
  for (let s of body) {
    while (isLabel(s)) {
      if (s.kind === NodeKind.CaseStmt) cases++; else defaults++;
      s = (s as CaseStmt | DefaultStmt).statement;
    }
  }
  return { cases, defaults };
}

/** A constant a `return` can hand back with no code of its own. */
function isConstant(e: Expression): boolean {
  switch (e.kind) {
    case NodeKind.IntegerLiteral: case NodeKind.BoolLiteral: case NodeKind.NullptrLiteral:
    case NodeKind.CharLiteral:
      return true;
    case NodeKind.ParenExpr: return isConstant((e as ParenExpr).expression);
    case NodeKind.CStyleCastExpr: return isConstant((e as CStyleCastExpr).expression);
    case NodeKind.UnaryExpr: {
      const u = e as UnaryExpr;
      return (u.operator === '-' || u.operator === '~') && isConstant(u.operand);
    }
    case NodeKind.Identifier: return (e as { name: string }).name === 'NULL';
    default: return false;
  }
}

function caseValue(v: number): Expression {
  return v < 0 ? Expr.neg(Expr.intLiteral(-v)) : Expr.intLiteral(v);
}

function caseLabel(value: number, statement: Statement): CaseStmt {
  return { kind: NodeKind.CaseStmt, value: caseValue(value), statement, location: statement.location, leadingTrivia: [], trailingTrivia: [] } as CaseStmt;
}

/** Statement-valued fields: the parent map's edges. */
const STMT_FIELDS = ['statements', 'thenBranch', 'elseBranch', 'body', 'statement'] as const;

function parentsOf(root: Statement): Map<Statement, Statement> {
  const out = new Map<Statement, Statement>();
  const go = (s: Statement): void => {
    for (const f of STMT_FIELDS) {
      const v = (s as unknown as Record<string, unknown>)[f];
      const kids = Array.isArray(v) ? v : v ? [v] : [];
      for (const k of kids) {
        if (k && typeof k === 'object' && typeof (k as ASTNode).kind === 'string' && ((k as ASTNode).kind as string).endsWith('Stmt')) {
          out.set(k as Statement, s);
          go(k as Statement);
        }
      }
    }
  };
  go(root);
  return out;
}

/**
 * The statement control reaches when it leaves `s` at its end: the next one in its block, or
 * that of an enclosing `if` it ends. Null where a loop, a switch or the function's end is in
 * the way.
 */
function after(s: Statement, parents: ReadonlyMap<Statement, Statement>): Statement | null {
  let cur = s;
  for (let depth = 0; depth < 64; depth++) {
    const p = parents.get(cur);
    if (!p) return null;
    if (p.kind === NodeKind.CompoundStmt) {
      const list = (p as CompoundStmt).statements;
      const i = list.indexOf(cur);
      if (i < 0) return null;
      if (i + 1 < list.length) {
        let next = list[i + 1];
        while (next.kind === NodeKind.CompoundStmt && (next as CompoundStmt).statements.length > 0) next = (next as CompoundStmt).statements[0];
        return next;
      }
      cur = p;
      continue;
    }
    if (p.kind === NodeKind.IfStmt && ((p as IfStmt).thenBranch === cur || (p as IfStmt).elseBranch === cur)) { cur = p; continue; }
    return null;
  }
  return null;
}

function rewriteSwitch(
  sw: SwitchStmt, reader: LayoutReader, ev: BranchLayoutEvidence, tables: readonly JumpTableFact[],
  parents: ReadonlyMap<Statement, Statement>, opts: JumpTableCaseOptions,
): SwitchStmt | null {
  const line = sw.location?.start.line ?? 0;
  const left = (why: string): null => { opts.onSite?.({ rule: 'left', line, why }); return null; };
  const jump = reader.switchBranch(sw);
  if (jump === null) return null;
  const table = tables.find(t => t.at === jump);
  if (!table) return null;
  if (table.fallback === undefined) return null;
  const top = table.entries.reduce((a, b) => (b.value > a.value ? b : a));
  if (top.target !== table.fallback) return null;
  if (!table.labelled) return left('the table has no case values');
  if (sw.body.kind !== NodeKind.CompoundStmt) return left('no switch body');
  const body = (sw.body as CompoundStmt).statements;
  if (body.length === 0 || !isLabel(body[0])) return left('code before the first label');
  const printed = new Set(table.entries.filter(e => e.target !== table.fallback).map(e => e.value)).size;
  const { cases, defaults } = labelsOf(body);
  if (cases !== printed || defaults > 1) return left(`${cases} case labels for ${printed} table entries`);

  if (defaults === 1) {
    // The fallback is the default's code: one more label on it.
    const at = body.findIndex(s => {
      for (let x = s; isLabel(x); x = (x as CaseStmt | DefaultStmt).statement) if (x.kind === NodeKind.DefaultStmt) return true;
      return false;
    });
    if (at < 0) return left('the default is not at the top of the body');
    const out = [...body];
    out[at] = caseLabel(top.value, body[at]);
    opts.onSite?.({ rule: 'case', line, value: top.value });
    return updateNode(sw, { body: updateNode(sw.body as CompoundStmt, { statements: out } as Partial<CompoundStmt>) } as Partial<SwitchStmt>);
  }

  const next = after(sw, parents);
  if (!next || next.kind !== NodeKind.ReturnStmt) return left('what follows the switch is not a return');
  const ret = next as ReturnStmt;
  if (ret.value && !isConstant(ret.value)) return left('the return after the switch computes its value');
  const retLine = ret.location?.start.line ?? 0;
  if (!(ev.lines.get(retLine) ?? []).includes(table.fallback)) return left('the return after the switch is not the fallback');
  const copy = Stmt.return_(ret.value ? { ...ret.value } : null);
  opts.onSite?.({ rule: 'case', line, value: top.value });
  return updateNode(sw, {
    body: updateNode(sw.body as CompoundStmt, { statements: [...body, caseLabel(top.value, copy)] } as Partial<CompoundStmt>),
  } as Partial<SwitchStmt>);
}

function rewriteFunction(fn: FunctionDecl, ev: BranchLayoutEvidence, tables: readonly JumpTableFact[], opts: JumpTableCaseOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const reader = new LayoutReader(ev, fn.body);
  const parents = parentsOf(fn.body);
  const done = new Map<SwitchStmt, SwitchStmt>();
  const visit = (s: Statement): void => {
    if (s.kind === NodeKind.SwitchStmt) {
      const r = rewriteSwitch(s as SwitchStmt, reader, ev, tables, parents, opts);
      if (r) done.set(s as SwitchStmt, r);
    }
    for (const f of STMT_FIELDS) {
      const v = (s as unknown as Record<string, unknown>)[f];
      const kids = Array.isArray(v) ? v : v ? [v] : [];
      for (const k of kids) if (k && typeof k === 'object' && typeof (k as ASTNode).kind === 'string') visit(k as Statement);
    }
  };
  visit(fn.body);
  if (done.size === 0) return undefined;
  // Identity-keyed: a replacement still holds the original nodes below it, so a switch
  // nested in a rewritten one is rewritten too.
  const rebuild = (n: ASTNode): ASTNode => {
    const base = done.get(n as SwitchStmt) ?? n;
    let patch: Record<string, unknown> | null = null;
    for (const [key, v] of Object.entries(base as unknown as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        const m = v.map(x => (isNode(x) ? rebuild(x) : x));
        if (m.some((x, i) => x !== v[i])) (patch ??= {})[key] = m;
      } else if (isNode(v) && key !== 'location') {
        const r = rebuild(v);
        if (r !== v) (patch ??= {})[key] = r;
      }
    }
    return patch ? updateNode(base, patch as Partial<ASTNode>) : base;
  };
  return updateNode(fn, { body: rebuild(fn.body) as CompoundStmt } as Partial<FunctionDecl>);
}

function isNode(v: unknown): v is ASTNode {
  return !!v && typeof v === 'object' && typeof (v as { kind?: unknown }).kind === 'string';
}

function createJumpTableCaseTransformer(options: JumpTableCaseOptions = {}): Transformer {
  const ev = options.branchLayout;
  const tables = options.jumpTables;
  if (!ev || !tables || tables.length === 0) return (node: ASTNode) => node;
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, ev, tables, options);
    },
  });
}

export const jumpTableCasePlugin: TransformPlugin = {
  id: 'jump-table-case',
  name: 'Jump Table Case',
  description: "Restores a jump table's last case that the decompiler folded into the code after the switch",
  version: '1.0.0',
  defaultEnabled: true,
  // After case-layout (989), which orders the printed groups by their addresses and needs
  // every group with code to have one; the restored case has none of its own.
  priority: 989.5,
  tags: ['matching', 'control-flow'],
  createTransformer: createJumpTableCaseTransformer,
};
