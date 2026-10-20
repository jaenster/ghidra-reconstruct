/**
 * Paths into a function body, and the control facts the structurer reads from them: where
 * falling off a statement goes, what `break`/`continue` bind to, which labels and jumps a
 * block holds. Shared by the structurer (structure.ts) and the loop rewrites (loops.ts).
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, GotoStmt, IfStmt, LabelStmt, Statement,
} from '../../../../ast/nodes.js';
import { Stmt } from '../../../../ast/factory.js';
import { getChildren } from '../../../../ast/visitor.js';
import { emit } from '../../../../emit/index.js';
import { updateNode } from '../../../transformer.js';
import { isNoreturnStmt } from '../../../cfg/bcfg.js';

// ---------------------------------------------------------------------------------------
// Paths into the body
// ---------------------------------------------------------------------------------------

export type Field = 'statements' | 'thenBranch' | 'elseBranch' | 'body' | 'statement';
export interface Step { f: Field; i?: number }
export type Path = Step[];

export const LOOPS = new Set<string>([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt]);

export function child(n: ASTNode, s: Step): ASTNode | null {
  const v = (n as unknown as Record<string, unknown>)[s.f];
  if (s.f === 'statements') return ((v as Statement[] | undefined)?.[s.i!] as ASTNode) ?? null;
  return (v as ASTNode | null | undefined) ?? null;
}

export function getAt(root: ASTNode, path: Path): ASTNode {
  let n = root;
  for (const s of path) {
    const c = child(n, s);
    if (!c) throw new Error('structure: dangling path');
    n = c;
  }
  return n;
}

export function setAt(root: ASTNode, path: Path, v: ASTNode): ASTNode {
  if (path.length === 0) return v;
  const [s, ...rest] = path;
  const c = child(root, s)!;
  const nc = setAt(c, rest, v);
  if (s.f === 'statements') {
    const list = [...(root as CompoundStmt).statements];
    list[s.i!] = nc as Statement;
    return updateNode(root as CompoundStmt, { statements: list });
  }
  return updateNode(root as never, { [s.f]: nc } as never);
}

/** Replace the list of the compound at `listPath`. */
export function setList(root: ASTNode, listPath: Path, list: Statement[]): ASTNode {
  return setAt(root, listPath, updateNode(getAt(root, listPath) as CompoundStmt, { statements: list }));
}

export const key = (p: Path) => p.map(s => s.f === 'statements' ? String(s.i) : s.f[0]).join('/');

export const FIELD_ORDER: Record<Field, number> = { statements: 0, thenBranch: 1, elseBranch: 2, body: 3, statement: 4 };
/** Document order of two paths (a prefix comes first). */
export function comparePaths(a: Path, b: Path): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].f !== b[i].f) return FIELD_ORDER[a[i].f] - FIELD_ORDER[b[i].f];
    if ((a[i].i ?? 0) !== (b[i].i ?? 0)) return (a[i].i ?? 0) - (b[i].i ?? 0);
  }
  return a.length - b.length;
}

/** The statement-holding children of a statement, with the step to each. */
export function stmtChildren(n: ASTNode): [Step, ASTNode][] {
  switch (n.kind) {
    case NodeKind.CompoundStmt:
      return (n as CompoundStmt).statements.map((s, i) => [{ f: 'statements', i }, s as ASTNode]);
    case NodeKind.IfStmt: {
      const f = n as IfStmt;
      const out: [Step, ASTNode][] = [[{ f: 'thenBranch' }, f.thenBranch as ASTNode]];
      if (f.elseBranch) out.push([{ f: 'elseBranch' }, f.elseBranch as ASTNode]);
      return out;
    }
    case NodeKind.WhileStmt: case NodeKind.DoWhileStmt: case NodeKind.ForStmt: case NodeKind.ForRangeStmt: case NodeKind.SwitchStmt:
      return [[{ f: 'body' }, (n as unknown as { body: ASTNode }).body]];
    case NodeKind.LabelStmt: case NodeKind.CaseStmt: case NodeKind.DefaultStmt:
      return [[{ f: 'statement' }, (n as unknown as { statement: ASTNode }).statement]];
    default:
      return [];
  }
}

export function walk(root: ASTNode, at: (n: ASTNode, path: Path) => void): void {
  const go = (n: ASTNode, path: Path): void => {
    at(n, path);
    for (const [s, c] of stmtChildren(n)) if (c) go(c, [...path, s]);
  };
  go(root, []);
}

// ---------------------------------------------------------------------------------------
// Where control goes after falling off a statement
// ---------------------------------------------------------------------------------------

/** `exit`, the statement at a list position, or a loop's continue point. */
export type Cont = { k: 'exit' } | { k: 'pos'; list: Path; i: number } | { k: 'loop'; loop: Path };
export const contKey = (c: Cont) => c.k === 'exit' ? 'exit' : c.k === 'pos' ? `pos:${key(c.list)}#${c.i}` : `loop:${key(c.loop)}`;

/** Where falling off the statement at `path` goes. */
export function after(root: ASTNode, path: Path): Cont {
  if (path.length === 0) return { k: 'exit' };
  const last = path[path.length - 1];
  const pp = path.slice(0, -1);
  const parent = getAt(root, pp);
  if (last.f === 'statements') {
    const list = (parent as CompoundStmt).statements;
    if (last.i! + 1 < list.length) return { k: 'pos', list: pp, i: last.i! + 1 };
    return after(root, pp);
  }
  if (last.f === 'body' && LOOPS.has(parent.kind)) return { k: 'loop', loop: pp };
  return after(root, pp);
}

/** The innermost loop and the innermost loop-or-switch around `site`: what continue and break bind to. */
export function binders(root: ASTNode, site: Path): { loop: Path | null; breakable: Path | null } {
  let loop: Path | null = null, breakable: Path | null = null;
  for (let d = site.length; d > 0; d--) {
    if (site[d - 1].f !== 'body') continue;
    const pp = site.slice(0, d - 1);
    const n = getAt(root, pp);
    if (!breakable && (LOOPS.has(n.kind) || n.kind === NodeKind.SwitchStmt)) breakable = pp;
    if (!loop && LOOPS.has(n.kind)) loop = pp;
    if (loop && breakable) break;
  }
  return { loop, breakable };
}

/** The jump that reaches `target` from inside the statement at `site`, or null. */
export function jumpFor(root: ASTNode, site: Path, target: Cont, voidFn: boolean): Statement | null {
  if (target.k === 'exit') return voidFn ? Stmt.return_() : null;
  const { loop, breakable } = binders(root, site);
  if (target.k === 'loop' && loop && key(loop) === key(target.loop)) return Stmt.continue_();
  if (breakable && contKey(after(root, breakable)) === contKey(target)) return Stmt.break_();
  return null;
}

// ---------------------------------------------------------------------------------------
// Facts about statements
// ---------------------------------------------------------------------------------------

/** Can control fall off the end of `s`? Conservative: true unless it certainly cannot. */
export function fallsThrough(s: Statement, noreturn: ReadonlySet<string>): boolean {
  switch (s.kind) {
    case NodeKind.ReturnStmt: case NodeKind.BreakStmt: case NodeKind.ContinueStmt: case NodeKind.GotoStmt:
      return false;
    case NodeKind.ExprStmt:
      return !isNoreturnStmt(s, noreturn);
    case NodeKind.CompoundStmt: {
      const l = (s as CompoundStmt).statements;
      return l.length === 0 || fallsThrough(l[l.length - 1], noreturn);
    }
    case NodeKind.IfStmt: {
      const n = s as IfStmt;
      return !n.elseBranch || fallsThrough(n.thenBranch, noreturn) || fallsThrough(n.elseBranch, noreturn);
    }
    case NodeKind.LabelStmt:
      return fallsThrough((s as LabelStmt).statement, noreturn);
    default:
      return true;
  }
}

export function anyStmt(stmts: Statement[], pred: (s: ASTNode) => boolean): boolean {
  const go = (n: ASTNode): boolean => {
    if (!n || typeof n !== 'object') return false;
    if (pred(n)) return true;
    for (const c of getChildren(n)) if (String(c.kind).endsWith('Stmt') && go(c)) return true;
    return false;
  };
  return stmts.some(s => go(s as ASTNode));
}

export const isCaseLike = (n: ASTNode) => n.kind === NodeKind.CaseStmt || n.kind === NodeKind.DefaultStmt;

/** A case label in `stmts` that belongs to a switch outside them (one of a nested switch does not). */
export function holdsFreeCase(stmts: Statement[]): boolean {
  const go = (n: ASTNode): boolean => {
    if (!n || typeof n !== 'object') return false;
    if (isCaseLike(n)) return true;
    if (n.kind === NodeKind.SwitchStmt) return false;
    for (const c of getChildren(n)) if (String(c.kind).endsWith('Stmt') && go(c)) return true;
    return false;
  };
  return stmts.some(s => go(s as ASTNode));
}

/** The `break`s and `continue`s in T that bind outside T: their target depends on where T sits. */
export function freeJumps(stmts: Statement[]): { brk: boolean; cont: boolean } {
  const r = { brk: false, cont: false };
  const go = (n: ASTNode, inLoop: boolean, inBreakable: boolean): void => {
    if (!n || typeof n !== 'object') return;
    if (n.kind === NodeKind.ContinueStmt && !inLoop) r.cont = true;
    if (n.kind === NodeKind.BreakStmt && !inBreakable) r.brk = true;
    const loop = LOOPS.has(n.kind);
    const sw = n.kind === NodeKind.SwitchStmt;
    for (const c of getChildren(n)) {
      if (String(c.kind).endsWith('Stmt')) go(c, inLoop || loop, inBreakable || loop || sw);
    }
  };
  stmts.forEach(s => go(s as ASTNode, false, false));
  return r;
}

export const sameBinder = (a: Path | null, b: Path | null) => (a === null ? b === null : b !== null && key(a) === key(b));

// ---------------------------------------------------------------------------------------
// One label
// ---------------------------------------------------------------------------------------

export interface LabelSlot {
  /** The list holding the label, and the index of the statement that carries it. */
  list: Path;
  k: number;
  /** Case labels and labels wrapped around ours, outermost first, and ours. */
  wrappers: Statement[];
  /** The statement our label labels. */
  inner: Statement;
  /** Index where the tail ends (exclusive): the next `case`, or the list's end. */
  m: number;
}

export function findLabel(body: CompoundStmt, name: string): LabelSlot | null {
  let found: LabelSlot | null = null;
  walk(body as ASTNode, (n, path) => {
    if (found || n.kind !== NodeKind.CompoundStmt) return;
    const list = (n as CompoundStmt).statements;
    list.forEach((s, k) => {
      if (found) return;
      const wrappers: Statement[] = [];
      let cur: Statement = s;
      while (cur.kind === NodeKind.LabelStmt || isCaseLike(cur as ASTNode)) {
        wrappers.push(cur);
        if (cur.kind === NodeKind.LabelStmt && (cur as LabelStmt).label.name === name) {
          let m = k + 1;
          while (m < list.length && !isCaseLike(list[m] as ASTNode)) m++;
          found = { list: path, k, wrappers, inner: (cur as LabelStmt).statement, m };
          return;
        }
        cur = (cur as LabelStmt).statement;
      }
    });
  });
  return found;
}

export function gotoPaths(body: CompoundStmt, name: string): Path[] {
  const out: Path[] = [];
  walk(body as ASTNode, (n, path) => {
    if (n.kind === NodeKind.GotoStmt && (n as GotoStmt).label.name === name) out.push(path);
  });
  return out;
}

/** Rebuild the label slot's statement with `name` removed from its wrapper chain. */
export function dropLabel(slotStmt: Statement, name: string): Statement {
  if (slotStmt.kind === NodeKind.LabelStmt && (slotStmt as LabelStmt).label.name === name) {
    const inner = (slotStmt as LabelStmt).statement;
    return { ...inner, leadingTrivia: [...(slotStmt.leadingTrivia ?? []), ...(inner.leadingTrivia ?? [])] } as Statement;
  }
  if (slotStmt.kind === NodeKind.LabelStmt || isCaseLike(slotStmt as ASTNode)) {
    const inner = (slotStmt as LabelStmt).statement;
    const d = dropLabel(inner, name);
    return d === inner ? slotStmt : updateNode(slotStmt as LabelStmt, { statement: d });
  }
  return slotStmt;
}

/**
 * Whether list positions i and j are in the same arm: no case label starts between them.
 * Outside a switch body every position is in one arm. A goto from another arm of the same
 * switch is an arm crossing, not a skip, even though its list holds the label.
 */
export function sameArm(list: Statement[], i: number, j: number): boolean {
  const [a, b] = i < j ? [i, j] : [j, i];
  for (let x = a + 1; x <= b; x++) if (isCaseLike(list[x] as ASTNode)) return false;
  return true;
}

export const emitText = (s: Statement) => emit(s as never).trim();

export const isPrefix = (p: Path, q: Path) => p.length <= q.length && p.every((s, i) => s.f === q[i].f && s.i === q[i].i);
