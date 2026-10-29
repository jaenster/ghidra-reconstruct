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
 * Only a jump-table switch the decompiler printed (its line prints the indirect jump and
 * is no `if`'s line: a switch built from ifs is ordered by switch-chain), whose groups
 * hold every label at the top of the switch body, and where every group with code has an
 * address. Anything else is left as printed. Reordering whole groups that leave, or that
 * move with their successor, keeps every path through the switch.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, FunctionDecl, ReturnStmt, Statement, SwitchStmt, CaseStmt, DefaultStmt,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { DEFAULT_NORETURN_FUNCTIONS } from './goto-cleanup/types.js';
import { holdsFreeCase } from './goto-cleanup/paths.js';
import { leaves } from './assert-order.js';
import { LayoutReader, type BranchLayoutEvidence } from './branch-layout/evidence.js';

export interface CaseLayoutOptions extends PluginOptions {
  /** The original's addresses, keyed by line of the parsed text; absent: nothing changes. */
  branchLayout?: BranchLayoutEvidence | null;
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

  // Units: a group with everything it runs into, and the empty groups behind them. A run's
  // address is read over all of its statements (a label run `case 3: case 6:` prints the
  // body's address on each label).
  const units: { groups: Group[]; entry: number }[] = [];
  for (let i = 0; i < groups.length;) {
    const start = i;
    while (groups[i].into && i + 1 < groups.length) i++;
    i++;
    const run = groups.slice(start, i);
    const known = run.filter(g => g.entry !== null).map(g => g.entry!);
    for (let k = 1; k < known.length; k++) if (known[k] <= known[k - 1]) return left('a case runs into one laid out before it');
    if (run.every(g => g.empty)) {
      if (units.length === 0) return left('an empty case first');
      units[units.length - 1].groups.push(...run);
      continue;
    }
    const entry = reader.entry(run.flatMap(g => g.stmts), jump);
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
  const stmts: Statement[] = [];
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
