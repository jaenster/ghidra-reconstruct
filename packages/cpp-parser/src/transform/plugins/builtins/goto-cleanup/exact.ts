/**
 * Exact rewrites: a goto replaced by structure that reaches the same place, with no code
 * copied (design section 8, step 5). Each is a RETARGET or a MOVE (design 3.1), and every
 * candidate goes through the same `accept()` as the other handlers, so the validator
 * proves it.
 *
 *   latchContinue   `goto L` to an empty label that ends a loop body -> `continue`.
 *                   Ghidra prints `continue` only for a jump to the loop HEAD; a jump to
 *                   the latch of a do-while or the increment of a for stays a goto.
 *   nextCase        `goto L` ending an arm, L the first statement of the next arm ->
 *                   fallthrough (the goto goes).
 *   stackCase       an arm that is only `goto L`, L the start of another arm -> its case
 *                   labels stack on that arm (`case 1: case 7: ...`). Only when nothing
 *                   falls into the arm being removed.
 *   rotatedEntry    `goto L; do { A; L: B } while (C);` - a loop entered at its middle ->
 *                   `while (true) { B; if (!C) break; A; }`, or `while (C) { A }` when B is
 *                   empty, or `do { B } while (C)` when A is.
 *   ifFalseArm      Ghidra's `if (false) { L: X } else { switch ... }`: a block entered
 *                   only by gotos from inside the switch -> moved into the switch as the
 *                   `default:` arm it was (when the default is `goto L`), or as an arm
 *                   reached only by its label otherwise.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode, CaseStmt, CompoundStmt, DefaultStmt, DoWhileStmt, GotoStmt,
  IfStmt, LabelStmt, Statement, SwitchStmt, WhileStmt,
} from '../../../../ast/nodes.js';
import { Stmt, Expr } from '../../../../ast/factory.js';
import { updateNode } from '../../../transformer.js';
import { negateCondition } from './helpers.js';
import { countGotosInStatements } from './analysis.js';
import { canFallThrough } from './tail-inline.js';
import { holdsLabelOrCase } from './copy-safety.js';

export type ExactKind = 'latchContinue' | 'nextCase' | 'stackCase' | 'rotatedEntry' | 'ifFalseArm';

const LOOPS = new Set<string>([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt]);

/** How many gotos to `label` the whole function holds (exact through the round). */
export type GotoTotal = (label: string) => number;

function gotoCount(stmts: Statement[], label: string): number {
  return countGotosInStatements(stmts).get(label) ?? 0;
}

/** Statement children of a statement node (the fields that hold statements). */
function mapChildren(s: Statement, f: (c: Statement, isLoopBody: boolean) => Statement): Statement {
  switch (s.kind) {
    case NodeKind.CompoundStmt: {
      const c = s as CompoundStmt;
      let changed = false;
      const out = c.statements.map(x => { const y = f(x, false); if (y !== x) changed = true; return y; });
      return changed ? updateNode(c, { statements: out }) : s;
    }
    case NodeKind.IfStmt: {
      const n = s as IfStmt;
      const t = f(n.thenBranch, false);
      const e = n.elseBranch ? f(n.elseBranch, false) : null;
      return t !== n.thenBranch || e !== n.elseBranch ? updateNode(n, { thenBranch: t, elseBranch: e }) : s;
    }
    case NodeKind.WhileStmt: case NodeKind.DoWhileStmt: case NodeKind.ForStmt: case NodeKind.ForRangeStmt: {
      const n = s as WhileStmt;
      const b = f(n.body, true);
      return b !== n.body ? updateNode(n, { body: b } as never) : s;
    }
    case NodeKind.SwitchStmt: {
      const n = s as SwitchStmt;
      const b = f(n.body, false);
      return b !== n.body ? updateNode(n, { body: b }) : s;
    }
    case NodeKind.CaseStmt: case NodeKind.DefaultStmt: case NodeKind.LabelStmt: {
      const n = s as CaseStmt;
      const b = f(n.statement, false);
      return b !== n.statement ? updateNode(n, { statement: b }) : s;
    }
    default:
      return s;
  }
}

/** Replace `goto label` by `make()`, never inside a nested loop; returns [result, count, nestedLoopGotos]. */
function retarget(s: Statement, label: string, make: (g: GotoStmt) => Statement): { out: Statement; done: number; blocked: number } {
  let done = 0, blocked = 0;
  const walk = (x: Statement, inLoop: boolean): Statement => {
    if (x.kind === NodeKind.GotoStmt && (x as GotoStmt).label.name === label) {
      if (inLoop) { blocked++; return x; }
      done++;
      return make(x as GotoStmt);
    }
    return mapChildren(x, (c, isLoopBody) => walk(c, inLoop || isLoopBody));
  };
  return { out: walk(s, false), done, blocked };
}

/** `L:` (possibly `L1: L2:`) around nothing: the statement is empty. */
function emptyLabel(s: Statement): string[] | null {
  const names: string[] = [];
  let cur = s;
  while (cur.kind === NodeKind.LabelStmt) { names.push((cur as LabelStmt).label.name); cur = (cur as LabelStmt).statement; }
  if (!names.length) return null;
  if (cur.kind === NodeKind.NullStmt) return names;
  if (cur.kind === NodeKind.CompoundStmt && (cur as CompoundStmt).statements.length === 0) return names;
  return null;
}

// ---------------------------------------------------------------------------------------

/** goto to an empty label that ends the loop body -> continue. */
function latchContinue(stmts: Statement[], total: GotoTotal): Statement[] | null {
  for (let i = 0; i < stmts.length; i++) {
    const loop = stmts[i];
    if (loop.kind !== NodeKind.WhileStmt && loop.kind !== NodeKind.DoWhileStmt && loop.kind !== NodeKind.ForStmt) continue;
    const body = (loop as WhileStmt).body;
    if (body.kind !== NodeKind.CompoundStmt) continue;
    const list = (body as CompoundStmt).statements;
    if (!list.length) continue;
    const names = emptyLabel(list[list.length - 1]);
    if (!names || names.length !== 1) continue;
    const L = names[0];
    const inside = gotoCount(list, L);
    if (inside === 0 || inside !== total(L)) continue;
    const head = list.slice(0, -1);
    let done = 0, blocked = 0;
    const newHead = head.map(s => {
      const r = retarget(s, L, () => Stmt.continue_());
      done += r.done; blocked += r.blocked;
      return r.out;
    });
    if (blocked > 0 || done !== inside) continue;
    const newBody = updateNode(body as CompoundStmt, { statements: newHead });
    const out = [...stmts];
    out[i] = updateNode(loop as WhileStmt, { body: newBody } as never);
    return out;
  }
  return null;
}

/** The label a statement starts with, through case labels: `case 2: L: x;` -> L. */
function leadingLabel(s: Statement): string | null {
  let cur = s;
  while (cur.kind === NodeKind.CaseStmt || cur.kind === NodeKind.DefaultStmt) cur = (cur as CaseStmt).statement;
  return cur.kind === NodeKind.LabelStmt ? (cur as LabelStmt).label.name : null;
}

/** `case 2: L: x;` with L removed (it has no gotos left). */
function dropLeadingLabel(s: Statement, label: string): Statement {
  if (s.kind === NodeKind.LabelStmt && (s as LabelStmt).label.name === label) return (s as LabelStmt).statement;
  if (s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) {
    const inner = dropLeadingLabel((s as CaseStmt).statement, label);
    return inner === (s as CaseStmt).statement ? s : updateNode(s as CaseStmt, { statement: inner });
  }
  return s;
}

function isArmStart(s: Statement): boolean {
  return s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt;
}

/** The goto that is the last thing in the arm ending at index i of a switch body, if any. */
function armEndGoto(list: Statement[], i: number): { label: string; rebuild: (s: Statement | null) => Statement | null } | null {
  const s = list[i];
  if (s.kind === NodeKind.GotoStmt) return { label: (s as GotoStmt).label.name, rebuild: () => null };
  // `case 1: goto L;` - the arm is the case's own statement.
  let cur: Statement = s;
  const wrap: ((x: Statement) => Statement)[] = [];
  while (cur.kind === NodeKind.CaseStmt || cur.kind === NodeKind.DefaultStmt) {
    const c = cur as CaseStmt;
    wrap.push(x => updateNode(c, { statement: x }));
    cur = c.statement;
  }
  if (cur.kind === NodeKind.GotoStmt && wrap.length) {
    return {
      label: (cur as GotoStmt).label.name,
      rebuild: () => wrap.reduceRight<Statement>((acc, w) => w(acc), Stmt.null_()),
    };
  }
  return null;
}

/**
 * Next-case fallthrough, then case stacking, on a switch body. The region handed in is
 * either the body list itself (it holds the arms: its case labels are dispatched from the
 * switch outside it) or a list holding switch statements.
 */
function switchArms(stmts: Statement[], total: GotoTotal): { out: Statement[]; kind: ExactKind } | null {
  if (stmts.some(isArmStart)) {
    const r = armRewrite(stmts, total);
    if (r) return r;
  }
  for (let si = 0; si < stmts.length; si++) {
    const sw = stmts[si];
    if (sw.kind !== NodeKind.SwitchStmt || (sw as SwitchStmt).body.kind !== NodeKind.CompoundStmt) continue;
    const body = (sw as SwitchStmt).body as CompoundStmt;
    const r = armRewrite(body.statements, total);
    if (!r) continue;
    const res = [...stmts];
    res[si] = updateNode(sw as SwitchStmt, { body: updateNode(body, { statements: r.out }) });
    return { out: res, kind: r.kind };
  }
  return null;
}

/** One arm rewrite on a switch body list, or null. */
function armRewrite(list: Statement[], total: GotoTotal): { out: Statement[]; kind: ExactKind } | null {
  {
    for (let i = 0; i + 1 < list.length; i++) {
      const g = armEndGoto(list, i);
      if (!g || !isArmStart(list[i + 1]) || leadingLabel(list[i + 1]) !== g.label) continue;
      // The goto's arm ends here and the next arm starts with its label: fall through.
      const rebuilt = g.rebuild(null);
      const out = [...list];
      if (rebuilt) out[i] = rebuilt; else out.splice(i, 1);
      const nextIdx = rebuilt ? i + 1 : i;
      if (total(g.label) === 1) out[nextIdx] = dropLeadingLabel(out[nextIdx], g.label);
      return { out, kind: 'nextCase' };
    }
    for (let i = 0; i < list.length; i++) {
      // An arm that is ONLY `case v: goto L;`, closed by the next arm.
      const s = list[i];
      if (!isArmStart(s)) continue;
      const g = armEndGoto(list, i);
      if (!g || !g.rebuild(null)) continue;
      if (i + 1 < list.length && !isArmStart(list[i + 1])) continue;
      if (i > 0 && canFallThrough(list[i - 1])) continue;
      const j = list.findIndex((x, k) => k !== i && isArmStart(x) && leadingLabel(x) === g.label);
      if (j < 0) continue;
      // Stack this arm's case labels on arm j.
      const labels: Statement[] = [];
      let cur: Statement = s;
      while (cur.kind === NodeKind.CaseStmt || cur.kind === NodeKind.DefaultStmt) { labels.push(cur); cur = (cur as CaseStmt).statement; }
      let target: Statement = total(g.label) === 1 ? dropLeadingLabel(list[j], g.label) : list[j];
      for (let k = labels.length - 1; k >= 0; k--) target = updateNode(labels[k] as CaseStmt, { statement: target });
      const out = [...list];
      out[j] = target;
      out.splice(i, 1);
      return { out, kind: 'stackCase' };
    }
  }
  return null;
}

/** A `continue` bound to the loop whose body this is (not to an inner loop). */
function hasOwnContinue(stmts: Statement[]): boolean {
  const walk = (s: ASTNode): boolean => {
    if (!s || typeof s !== 'object') return false;
    if (s.kind === NodeKind.ContinueStmt) return true;
    if (LOOPS.has(s.kind)) return false;
    let found = false;
    mapChildren(s as Statement, c => { if (!found && walk(c)) found = true; return c; });
    return found;
  };
  return stmts.some(walk);
}

/** `goto L; do { A; L: B } while (C);` */
function rotatedEntry(stmts: Statement[], total: GotoTotal): Statement[] | null {
  for (let i = 0; i + 1 < stmts.length; i++) {
    const g = stmts[i];
    const loop = stmts[i + 1];
    if (g.kind !== NodeKind.GotoStmt || loop.kind !== NodeKind.DoWhileStmt) continue;
    const L = (g as GotoStmt).label.name;
    if (total(L) !== 1) continue;
    const dw = loop as DoWhileStmt;
    if (dw.body.kind !== NodeKind.CompoundStmt) continue;
    const list = (dw.body as CompoundStmt).statements;
    const k = list.findIndex(s => s.kind === NodeKind.LabelStmt && (s as LabelStmt).label.name === L);
    if (k < 0) continue;
    const A = list.slice(0, k);
    const labelled = list[k] as LabelStmt;
    const B = [labelled.statement, ...list.slice(k + 1)].filter(s => s.kind !== NodeKind.NullStmt);
    if (holdsLabelOrCase(A) || hasOwnContinue([...A, ...B])) continue;
    let rebuilt: Statement;
    if (B.length === 0) {
      rebuilt = Stmt.while_(dw.condition, Stmt.compound(A));
    } else if (A.length === 0) {
      rebuilt = Stmt.doWhile(Stmt.compound(B), dw.condition);
    } else {
      rebuilt = Stmt.while_(Expr.boolLiteral(true), Stmt.compound([
        ...B, Stmt.if_(negateCondition(dw.condition), Stmt.break_()), ...A,
      ]));
    }
    (rebuilt as { location?: unknown }).location = dw.location;
    (rebuilt as { leadingTrivia?: unknown }).leadingTrivia = dw.leadingTrivia ?? [];
    return [...stmts.slice(0, i), rebuilt, ...stmts.slice(i + 2)];
  }
  return null;
}

/** A break or continue in X that would bind to something outside it. */
function escapes(s: ASTNode): boolean {
  if (!s || typeof s !== 'object') return false;
  if (s.kind === NodeKind.BreakStmt || s.kind === NodeKind.ContinueStmt) return true;
  if (LOOPS.has(s.kind) || s.kind === NodeKind.SwitchStmt) return false;
  let found = false;
  mapChildren(s as Statement, c => { if (!found && escapes(c)) found = true; return c; });
  return found;
}

/** `if (false) { L: X } else { switch (e) { ... } }` -> X becomes an arm of the switch. */
function ifFalseArm(stmts: Statement[], total: GotoTotal): Statement[] | null {
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (s.kind !== NodeKind.IfStmt) continue;
    const n = s as IfStmt;
    if (n.condition.kind !== NodeKind.BoolLiteral || (n.condition as unknown as { value: boolean }).value !== false) continue;
    if (!n.elseBranch) continue;
    const elseList = n.elseBranch.kind === NodeKind.CompoundStmt ? (n.elseBranch as CompoundStmt).statements : [n.elseBranch];
    // The switch must be the else's last statement: then its follow is the if's follow.
    const sw = elseList[elseList.length - 1];
    // What precedes the switch moves to the enclosing block; a declaration would change scope.
    if (elseList.slice(0, -1).some(x => x.kind === NodeKind.DeclStmt)) continue;
    if (!sw || sw.kind !== NodeKind.SwitchStmt || (sw as SwitchStmt).body.kind !== NodeKind.CompoundStmt) continue;
    const thenList = n.thenBranch.kind === NodeKind.CompoundStmt ? (n.thenBranch as CompoundStmt).statements : [n.thenBranch];
    if (!thenList.length) continue;
    // Every label of the then-arm must be targeted only from inside the switch.
    const thenLabels: string[] = [];
    let cur: Statement = thenList[0];
    while (cur.kind === NodeKind.LabelStmt) { thenLabels.push((cur as LabelStmt).label.name); cur = (cur as LabelStmt).statement; }
    if (!thenLabels.length) continue;
    const X = [cur, ...thenList.slice(1)];
    if (holdsLabelOrCase(X) || X.some(x => escapes(x as ASTNode))) continue;
    const swBody = (sw as SwitchStmt).body as CompoundStmt;
    if (!thenLabels.every(L => gotoCount(swBody.statements, L) === total(L) && total(L) > 0)) continue;

    // The arm keeps the labels a goto still names. The `default: goto L` this block replaces
    // is one of L's gotos; when it was the only one, `L:` would be left naming nothing.
    const arm = (consumed: string | null): Statement[] => {
      const kept = thenLabels.filter(L => total(L) - (L === consumed ? 1 : 0) > 0);
      const head = kept.reduceRight<Statement>((acc, L) => Stmt.label(L, acc), X[0]);
      return [head, ...X.slice(1), ...(canFallThrough(X[X.length - 1]) ? [Stmt.break_()] : [])];
    };

    const list = swBody.statements;
    let newList: Statement[] | null = null;
    // The default arm that is only `goto L` IS this block: the block replaces it.
    const di = list.findIndex(x => x.kind === NodeKind.DefaultStmt);
    if (di >= 0) {
      const g = armEndGoto(list, di);
      const closes = di + 1 >= list.length || isArmStart(list[di + 1]);
      if (g && thenLabels.includes(g.label) && closes && (list[di] as DefaultStmt).statement.kind === NodeKind.GotoStmt) {
        const a = arm(g.label);
        newList = [...list.slice(0, di), updateNode(list[di] as DefaultStmt, { statement: a[0] }), ...a.slice(1), ...list.slice(di + 1)];
      }
    }
    if (!newList) {
      const a = arm(null);
      // Otherwise an arm reached only by its labels, after a last arm that cannot fall into it.
      const tail = list.length && canFallThrough(list[list.length - 1]) ? [Stmt.break_()] : [];
      newList = [...list, ...tail, ...a];
    }
    const newSwitch = updateNode(sw as SwitchStmt, { body: updateNode(swBody, { statements: newList }) });
    const replacement = [...elseList.slice(0, -1), newSwitch];
    return [...stmts.slice(0, i), ...replacement, ...stmts.slice(i + 1)];
  }
  return null;
}

/** Try each exact rewrite in turn; the first that applies is the candidate. */
export function exactCandidates(stmts: Statement[], total: GotoTotal): { out: Statement[]; kind: ExactKind }[] {
  const out: { out: Statement[]; kind: ExactKind }[] = [];
  const a = latchContinue(stmts, total); if (a) out.push({ out: a, kind: 'latchContinue' });
  const b = switchArms(stmts, total); if (b) out.push(b);
  const c = rotatedEntry(stmts, total); if (c) out.push({ out: c, kind: 'rotatedEntry' });
  const d = ifFalseArm(stmts, total); if (d) out.push({ out: d, kind: 'ifFalseArm' });
  return out;
}

