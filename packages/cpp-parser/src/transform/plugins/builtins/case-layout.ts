/**
 * Case Layout Plugin
 *
 * VC8 lays a switch's case bodies out in source order, and its jump table names each
 * body's address; the decompiler prints a jump-table switch's cases by value. Where the
 * source wrote them in another order, the tree's switch puts every body somewhere else
 * (NET_D2GS_CLIENT_Handle0x50_QuestSpecial: the body of 0x24 is the first in the
 * original, FreeAny and UNITS_PlaceUnitInRoom on eUnitType, PLAYER_EndInteraction). This
 * prints the case groups in the order of their addresses (branch-layout/evidence.ts).
 *
 * A group is a run of `case`/`default` labels and the statements up to the next label.
 * A group that runs on into the next keeps it as its successor (the pair moves as one,
 * and its addresses must already be ascending); a group with no code of its own (only a
 * `break;`, a `goto`, a bare `return;`: its table entry is a jump target elsewhere) stays
 * behind the group before it. A group that ends the
 * switch without leaving gets a `break;` where it no longer comes last.
 *
 * Where the original's jump table names a group's body (the entry of its case values, or the
 * bound check's target for `default:`), that address orders it: it is the body's first
 * instruction, where a statement's own address can sit deeper in the body or be missing
 * (the `return 1;` goto-cleanup copies in place of `goto switchD_..._caseD_5`,
 * UI_GoldDialogConfirmCallback 00454080). The statements' addresses order the rest.
 *
 * Only a jump-table switch the decompiler printed (its line prints the indirect jump and
 * is no `if`'s line: a switch built from ifs is ordered by switch-chain), whose groups
 * hold every label at the top of the switch body, and where every group with code has an
 * address. Anything else is left as printed. Reordering whole groups that leave, or that
 * move with their successor, keeps every path through the switch.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, FunctionDecl, ReturnStmt, Statement, SwitchStmt, CaseStmt, DefaultStmt,
  Expression, ParenExpr, IntegerLiteralExpr, CharLiteralExpr, UnaryExpr,
} from '../../../ast/nodes.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { DEFAULT_NORETURN_FUNCTIONS } from './goto-cleanup/types.js';
import { holdsFreeCase } from './goto-cleanup/paths.js';
import { leaves } from './assert-order.js';
import { LayoutReader, type BranchLayoutEvidence } from './branch-layout/evidence.js';
import type { JumpTableFact } from './jump-table-case.js';

export interface CaseLayoutOptions extends PluginOptions {
  /** The original's addresses, keyed by line of the parsed text; absent: nothing changes. */
  branchLayout?: BranchLayoutEvidence | null;
  /** The original's jump tables (reconstruct's extract/jump-tables.ts). */
  jumpTables?: readonly JumpTableFact[];
  /** Enum constant -> value, for case labels spelled as enumerators. */
  enumValues?: Readonly<Record<string, number>>;
  /** Further callees that never return, by unqualified name. */
  noreturnFunctions?: string[];
  /** Called once per switch reordered, and per switch left with a reason. */
  onSite?: (e: { rule: 'order' | 'left'; line: number; groups?: number; why?: string }) => void;
}

interface Group {
  /** The labelled statement first, then the statements up to the next label. */
  stmts: Statement[];
  /** Runs on into the next group. */
  into: boolean;
  /** No code of its own: only jumps (`break;`, `goto`, a bare `return;`). */
  empty: boolean;
  entry: number | null;
}

function isLabel(s: Statement): boolean {
  return s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt;
}

/** The statement a run of labels labels. */
function labelled(s: Statement): Statement {
  while (isLabel(s)) s = (s as CaseStmt | DefaultStmt).statement;
  return s;
}

function noCode(s: Statement): boolean {
  if (s.kind === NodeKind.BreakStmt || s.kind === NodeKind.ContinueStmt || s.kind === NodeKind.GotoStmt) return true;
  if (s.kind === NodeKind.ReturnStmt) return !(s as ReturnStmt).value;
  if (s.kind === NodeKind.NullStmt) return true;
  if (s.kind === NodeKind.CompoundStmt) return (s as CompoundStmt).statements.every(noCode);
  return false;
}

function groupsOf(body: readonly Statement[]): Group[] | null {
  const out: Group[] = [];
  for (const s of body) {
    if (isLabel(s)) out.push({ stmts: [s], into: false, empty: false, entry: null });
    else if (out.length === 0) return null;
    else out[out.length - 1].stmts.push(s);
  }
  return out;
}

/** The group's statements with the labels peeled off its first. */
function code(g: Group): Statement[] {
  return [labelled(g.stmts[0]), ...g.stmts.slice(1)];
}

/** A case label's value: an integer literal, its negation, or an enumerator with a known value. */
function labelValue(e: Expression, enumValues: Readonly<Record<string, number>>): number | null {
  switch (e.kind) {
    case NodeKind.ParenExpr: return labelValue((e as ParenExpr).expression, enumValues);
    case NodeKind.IntegerLiteral: {
      const v = Number((e as IntegerLiteralExpr).value);
      return Number.isSafeInteger(v) ? v : null;
    }
    case NodeKind.CharLiteral: return (e as CharLiteralExpr).value;
    case NodeKind.UnaryExpr: {
      const u = e as UnaryExpr;
      const v = u.operator === '-' ? labelValue(u.operand, enumValues) : null;
      return v === null ? null : -v;
    }
    case NodeKind.Identifier: case NodeKind.QualifiedId: {
      const name = emit(e as never).split('::').pop()!;
      return Object.prototype.hasOwnProperty.call(enumValues, name) ? enumValues[name] : null;
    }
    default: return null;
  }
}

/** The case values of a group's label run; null where one does not resolve. */
function groupValues(g: Group, enumValues: Readonly<Record<string, number>>): number[] | null {
  const out: number[] = [];
  for (let s: Statement = g.stmts[0]; isLabel(s); s = (s as CaseStmt | DefaultStmt).statement) {
    if (s.kind !== NodeKind.CaseStmt) continue;
    const v = labelValue((s as CaseStmt).value, enumValues);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

/**
 * Case value -> the table's target, or null where the table cannot be read in the switch's
 * values. A labelled table names each entry's case value. An unlabelled one is indexed by the
 * value less the smallest case (VC8 subtracts it before the bound check), taken only where
 * the largest case less that bias is the bound: two readings of one bias.
 */
function tableTargets(table: JumpTableFact, groups: readonly Group[], enumValues: Readonly<Record<string, number>>): ((v: number) => number | null) | null {
  if (table.labelled) {
    return v => {
      const hit = table.entries.filter(x => x.value === v || x.value === (v >>> 0));
      return hit.length === 1 ? hit[0].target : null;
    };
  }
  const values: number[] = [];
  for (const g of groups) {
    const vs = groupValues(g, enumValues);
    if (!vs) return null;
    values.push(...vs);
  }
  if (!values.length || table.bound === undefined) return null;
  const bias = Math.min(...values);
  if (Math.max(...values) - bias !== table.bound) return null;
  return v => {
    const i = v - bias;
    if (i < 0 || i > table.bound!) return null;
    const hit = table.entries.filter(x => x.value === i);
    return hit.length === 1 ? hit[0].target : null;
  };
}

/**
 * The address the jump table sends the group's labels to, when every label of its run
 * resolves and all agree; null otherwise.
 */
function tableEntry(g: Group, table: JumpTableFact, target: (v: number) => number | null, enumValues: Readonly<Record<string, number>>): number | null {
  let entry: number | null = null;
  for (let s: Statement = g.stmts[0]; isLabel(s); s = (s as CaseStmt | DefaultStmt).statement) {
    let t: number | null | undefined;
    if (s.kind === NodeKind.DefaultStmt) t = table.fallback;
    else {
      const v = labelValue((s as CaseStmt).value, enumValues);
      t = v === null ? null : target(v);
    }
    if (t === null || t === undefined || (entry !== null && t !== entry)) return null;
    entry = t;
  }
  return entry;
}

function rewriteSwitch(sw: SwitchStmt, reader: LayoutReader, noreturn: ReadonlySet<string>, opts: CaseLayoutOptions): SwitchStmt | null {
  const line = sw.location?.start.line ?? 0;
  const left = (why: string): null => { opts.onSite?.({ rule: 'left', line, why }); return null; };
  if (sw.init || sw.body.kind !== NodeKind.CompoundStmt) return null;
  const jump = reader.switchBranch(sw);
  if (jump === null) return null;
  const groups = groupsOf((sw.body as CompoundStmt).statements);
  if (!groups || groups.length < 2) return null;
  for (const g of groups) {
    const c = code(g);
    if (holdsFreeCase(c)) return left('a label inside a case body');
    g.empty = c.every(noCode);
    g.into = !leaves(c[c.length - 1], noreturn);
    g.entry = g.empty ? null : reader.entry(g.stmts, jump);
  }

  const enumValues = opts.enumValues ?? {};
  const table = opts.jumpTables?.find(t => t.at === jump);
  const target = table ? tableTargets(table, groups, enumValues) : null;

  // Units: a group with everything it runs into, and the empty groups behind them. A run's
  // address is read over all of its statements (a label run `case 3: case 6:` prints the
  // body's address on each label).
  const units: { groups: Group[]; entry: number }[] = [];
  // Empty groups before any code stay first: a label run that only jumps (`case A: case B:
  // break;`, Q38_Callback00_NpcActivate 005984c0) lays out no body of its own.
  const lead: Group[] = [];
  for (let i = 0; i < groups.length;) {
    const start = i;
    while (groups[i].into && i + 1 < groups.length) i++;
    i++;
    const run = groups.slice(start, i);
    const known = run.filter(g => g.entry !== null).map(g => g.entry!);
    for (let k = 1; k < known.length; k++) if (known[k] <= known[k - 1]) return left('a case runs into one laid out before it');
    if (run.every(g => g.empty)) {
      if (units.length === 0) { lead.push(...run); continue; }
      units[units.length - 1].groups.push(...run);
      continue;
    }
    const entry = (table && target ? tableEntry(run[0], table, target, enumValues) : null)
      ?? reader.entry(run.flatMap(g => g.stmts), jump);
    if (entry === null) return left('a case body without an address');
    units.push({ groups: run, entry });
  }
  if (new Set(units.map(u => u.entry)).size !== units.length) return left('two cases at one address');
  const sorted = [...units].sort((a, b) => a.entry - b.entry);
  if (sorted.every((u, k) => u === units[k])) return null;

  // The last group ends the switch: where it runs off the end and no longer comes last,
  // it leaves by a `break;`.
  const lastUnit = units[units.length - 1];
  const tail = lastUnit.groups[lastUnit.groups.length - 1];
  const stmts: Statement[] = lead.flatMap(g => g.stmts);
  for (const u of sorted) {
    for (const g of u.groups) {
      stmts.push(...g.stmts);
      if (g === tail && g.into && u !== sorted[sorted.length - 1]) stmts.push(Stmt.break_());
    }
  }
  opts.onSite?.({ rule: 'order', line, groups: groups.length });
  return updateNode(sw, { body: updateNode(sw.body as CompoundStmt, { statements: stmts } as Partial<CompoundStmt>) } as Partial<SwitchStmt>);
}

function rewriteFunction(fn: FunctionDecl, ev: BranchLayoutEvidence, opts: CaseLayoutOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const reader = new LayoutReader(ev, fn.body);
  const noreturn = new Set([...DEFAULT_NORETURN_FUNCTIONS, ...(opts.noreturnFunctions ?? [])]);
  let n = 0;
  const t = createTransformer({
    visitSwitchStmt(node: SwitchStmt): ASTNode | undefined {
      const r = rewriteSwitch(node, reader, noreturn, opts);
      if (!r) return undefined;
      n++;
      return r;
    },
  });
  const body = t(fn.body) as CompoundStmt;
  return n ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
}

function createCaseLayoutTransformer(options: CaseLayoutOptions = {}): Transformer {
  const ev = options.branchLayout;
  if (!ev) return (node: ASTNode) => node;
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, ev, options);
    },
  });
}

export const caseLayoutPlugin: TransformPlugin = {
  id: 'case-layout',
  name: 'Case Layout',
  description: "Prints a jump-table switch's case groups in the order of their bodies' addresses in the original",
  version: '1.0.0',
  defaultEnabled: true,
  // After branch-layout (988): the case bodies have their final shape.
  priority: 989,
  tags: ['control-flow', 'layout'],
  createTransformer: createCaseLayoutTransformer,
};
