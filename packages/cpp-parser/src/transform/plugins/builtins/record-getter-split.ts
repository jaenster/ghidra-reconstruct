/**
 * Record Getter Split Plugin
 *
 * The inlined record getter (`p = i >= 0 && i < T->nSize ? &T->pTxt[i] : NULL`) whose
 * guard the generator has already taken apart. The decompiler prints the getter's tests
 * and the null test as one condition, `if (i < 0 || n <= i || (p = base + i, p == 0))`;
 * comma expansion and early return make it
 *
 *     if (i < 0) return R;
 *     if (i >= n) return R;
 *     p = base + i;
 *     if (!p) return R;
 *
 * which VC8 lays out with a return copy after the first test. The original tests the
 * pointer after the add and leaves every failed test through the one block the null test
 * falls into, which is what the getter's form compiles to. This pass writes it back:
 *
 *     p = i >= 0 && i < n ? base + i : nullptr;
 *     if (!p) return R;
 *
 * Three shapes, each value-preserving as stated:
 *   - guards: consecutive `if (c) return R;` whose conditions read the index, then the
 *     assignment, then `if (!p) return R;` with the same R. On a failed test the new code
 *     stores null and returns R; R neither calls, writes nor reads `p`.
 *   - guards then a positive test: the same guards, the assignment, `if (p) S` with no else
 *     and `return R;` right after it. A failed test now skips S and reaches that return.
 *   - nested: `if (B) { p = base + i; if (p) S }`, no else on either and nothing else in
 *     the outer block. A failed B skips S as before; `p` is read nowhere else, so its
 *     value on that path does not matter.
 * The index is a name (cast allowed) that every guard reads, written by none, and `base`
 * is a pure expression. The conditions are kept in their order, each guard's negated.
 *
 * A held base (`p = base; if (!(p + i)) ..`, the record read as `p[i]`) also takes an
 * index written after it, when every read of `p` is evaluated before the first such write
 * (`i = p[i].f` reads first; MISSMODE_SrvDoFn07_GuidedMissile 005ae780), no loop holds
 * both, and nothing can run the store again.
 *
 * bare (SOUND_GetIdFromUnit 004c1d60): guards, then `if (!(base + i)) return R;` on the
 * table member itself with no local, the record read as `base[i]` after it, or not read at
 * all (Skills_CltDoFunc_Ass_AuraLevel_CastAttackTarget 004f2720 only null-tests it). With the
 * declarations for its type it becomes `T *p = c ? base + i : nullptr; if (!p) return R;`
 * and the reads after go through `p` up to what may change `base`, `i` or the record.
 *
 * Gate (`branchLayout`): the tests and the null test come from one decompiled `if` (the
 * same condition, so one exit block) or every return lies in one return copy of the
 * original that each test jumps to; and no return copy holding a return is laid out before
 * the last test (the original left its first test through a copy of its own). Without the
 * facts nothing changes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CompoundStmt, MemberExpr, CStyleCastExpr, DeclStmt, Expression, ExprStmt,
  FunctionDecl, Identifier, IfStmt, ParameterDecl, ParenExpr, ReturnStmt, Statement, SubscriptExpr,
  UnaryExpr, VariableDecl, BinaryOperator, TypeNode,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { Decl, Expr, Stmt } from '../../../ast/factory.js';
import { createTransformer, updateNode, cloneNode, nodesEqual, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { effectsOf } from './access-order-evidence.js';
import type { BranchLayoutEvidence } from './branch-layout/evidence.js';
import type { TypedefResolver } from './call-arg-cast.js';
import { createExprShape } from './expr-shape.js';
import { memberChain, routeReads, countReads, typeOfShape, recordName, hasJumpTarget, type Guard } from './record-getter-guard.js';

export interface RecordGetterSplitOptions extends PluginOptions {
  branchLayout?: BranchLayoutEvidence | null;
  /** Declarations, for the record type of a bare null test (none: that form is left). */
  functionReturnTypes?: Record<string, string>;
  globalTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  shadowedTypeNames?: string[];
  onSite?: (e: { line: number; name: string; form: 'guards' | 'guards-then' | 'nested' | 'held' | 'held-then' | 'bare'; tests: number }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function uncast(e: Expression): Expression {
  e = unwrap(e);
  while (e.kind === NodeKind.CStyleCastExpr) e = unwrap((e as CStyleCastExpr).expression);
  return e;
}

function pure(e: ASTNode): boolean {
  const f = effectsOf(e);
  return f.calls === 0 && f.writes === 0;
}

function mentions(e: ASTNode, name: string): boolean {
  for (const n of traverseAST(e)) if (n.kind === NodeKind.Identifier && (n as Identifier).name === name) return true;
  return false;
}

function isZero(e: Expression): boolean {
  const u = uncast(e);
  if (u.kind === NodeKind.NullptrLiteral) return true;
  return u.kind === NodeKind.IntegerLiteral && BigInt((u as unknown as { value: bigint | number }).value) === 0n;
}

/** The pointer a leaf tests: `p` or, for a held base, `p + i`; `i` a name, maybe cast. */
function testedPointer(e: Expression, name: string, held: string | null): boolean {
  const u = uncast(e);
  if (held === null) return u.kind === NodeKind.Identifier && (u as Identifier).name === name;
  if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '+') return false;
  const l = uncast((u as BinaryExpr).left), r = uncast((u as BinaryExpr).right);
  return l.kind === NodeKind.Identifier && (l as Identifier).name === name
    && r.kind === NodeKind.Identifier && (r as Identifier).name === held;
}

/**
 * What `cond` is when the pointer is null, decided by its leftmost test alone: `!p` is
 * true, `p && X` false, `!p || X` true. Null when the leftmost operand does not test it.
 */
function valueOnNull(cond: Expression, name: string, held: string | null): boolean | null {
  const u = unwrap(cond);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    const v = valueOnNull((u as UnaryExpr).operand, name, held);
    return v === null ? null : !v;
  }
  if (u.kind === NodeKind.BinaryExpr) {
    const b = u as BinaryExpr;
    if (b.operator === '&&') return valueOnNull(b.left, name, held) === false ? false : null;
    if (b.operator === '||') return valueOnNull(b.left, name, held) === true ? true : null;
    if ((b.operator === '==' || b.operator === '!=') && isZero(b.right) && testedPointer(b.left, name, held)) {
      return b.operator === '==';
    }
  }
  return testedPointer(u, name, held) ? false : null;
}

/** The index name the leftmost test of `cond` adds to `name` (`!(p + i)`), or null. */
function heldIndex(cond: Expression, name: string): string | null {
  let u = unwrap(cond);
  for (;;) {
    if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') { u = unwrap((u as UnaryExpr).operand); continue; }
    if (u.kind === NodeKind.BinaryExpr && ['&&', '||', '==', '!='].includes((u as BinaryExpr).operator)) {
      u = unwrap((u as BinaryExpr).left);
      continue;
    }
    break;
  }
  u = uncast(u);
  if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '+') return null;
  const l = uncast((u as BinaryExpr).left), r = uncast((u as BinaryExpr).right);
  if (l.kind !== NodeKind.Identifier || (l as Identifier).name !== name || r.kind !== NodeKind.Identifier) return null;
  return (r as Identifier).name;
}

const LOOP_KINDS = new Set<string>([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt]);

/**
 * Every write of `name` in `root` comes before `stmt` in the text, and nothing can run it
 * again after `stmt`: no write at all, or `stmt` in no loop and no label in the function.
 */
function writtenOnlyBefore(root: ASTNode, stmt: ASTNode, name: string): boolean {
  let seen = false, inLoop = false, any = false, after = false, label = false;
  const walk = (n: ASTNode, loops: number): void => {
    if (n === stmt) { seen = true; inLoop = loops > 0; return; }
    if (n.kind === NodeKind.LabelStmt) label = true;
    const own = n.kind === NodeKind.AssignExpr || n.kind === NodeKind.PostfixExpr || n.kind === NodeKind.UnaryExpr;
    if (own && writes(n, name)) { any = true; if (seen) after = true; }
    const inner = loops + (LOOP_KINDS.has(n.kind) ? 1 : 0);
    for (const k of getChildren(n)) walk(k, inner);
  };
  walk(root, 0);
  return !after && !(any && (inLoop || label));
}

/**
 * Every reference to `base` after `stmt` is evaluated while `index` still holds the value
 * it had at `stmt`: no write of `index` after `stmt` comes before one, in evaluation order
 * (`i = base[i].f` reads before it stores), no loop holds both a write of `index` and a
 * reference to `base`, `stmt` is in no loop and the function has no label.
 */
function readBeforeRewritten(root: ASTNode, stmt: ASTNode, index: string, base: string): boolean {
  let seen = false, inLoop = false, label = false, written = false, ok = true;
  const refers = (n: ASTNode) => { for (const m of traverseAST(n)) if (m.kind === NodeKind.Identifier && (m as Identifier).name === base) return true; return false; };
  const walk = (n: ASTNode, loops: number): void => {
    if (!ok) return;
    if (n === stmt) { seen = true; inLoop = loops > 0; return; }
    if (n.kind === NodeKind.LabelStmt) label = true;
    if (seen && LOOP_KINDS.has(n.kind) && writes(n, index) && refers(n)) { ok = false; return; }
    if (seen && n.kind === NodeKind.Identifier && (n as Identifier).name === base && written) { ok = false; return; }
    const inner = loops + (LOOP_KINDS.has(n.kind) ? 1 : 0);
    if (n.kind === NodeKind.AssignExpr) {
      const a = n as AssignExpr;
      walk(a.right, inner);
      walk(a.left, inner);
      if (seen && writes(n, index)) written = true;
      return;
    }
    const own = n.kind === NodeKind.PostfixExpr || n.kind === NodeKind.UnaryExpr;
    for (const k of getChildren(n)) walk(k, inner);
    if (seen && own && writes(n, index)) written = true;
  };
  walk(root, 0);
  return ok && seen && !inLoop && !label;
}

/** Whether `n` writes `name`: an assignment, an increment or a decrement of it. */
function writes(n: ASTNode, name: string): boolean {
  const is = (e: Expression) => { const u = unwrap(e); return u.kind === NodeKind.Identifier && (u as Identifier).name === name; };
  for (const m of traverseAST(n)) {
    if (m.kind === NodeKind.AssignExpr && is((m as AssignExpr).left)) return true;
    if (m.kind === NodeKind.PostfixExpr && is((m as unknown as { operand: Expression }).operand)) return true;
    if (m.kind === NodeKind.UnaryExpr && ((m as UnaryExpr).operator === '++' || (m as UnaryExpr).operator === '--')
      && is((m as UnaryExpr).operand)) return true;
  }
  return false;
}

/** The index a record address reads: `base + i` or `&base[i]`, under casts; `i` a name, maybe cast. */
function recordIndex(e: Expression): { base: Expression; index: string } | null {
  const u = uncast(e);
  let base: Expression, idx: Expression;
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '+') {
    base = (u as BinaryExpr).left; idx = (u as BinaryExpr).right;
  } else if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '&'
    && unwrap((u as UnaryExpr).operand).kind === NodeKind.SubscriptExpr) {
    const s = unwrap((u as UnaryExpr).operand) as SubscriptExpr;
    base = s.array; idx = s.index;
  } else return null;
  const i = uncast(idx);
  if (i.kind !== NodeKind.Identifier || !pure(base) || mentions(base, (i as Identifier).name)) return null;
  const b = uncast(base);
  if (b.kind === NodeKind.IntegerLiteral) return null;
  return { base, index: (i as Identifier).name };
}

const FLIP: Partial<Record<BinaryOperator, BinaryOperator>> = {
  '<': '>=', '>=': '<', '>': '<=', '<=': '>', '==': '!=', '!=': '==',
};

/** `!c` as the conjuncts it is: `!(a && b)` is `a`, `b`; `a || b` is `!a`, `!b`; a comparison flips. */
export function negatedConjuncts(c: Expression): Expression[] {
  const u = unwrap(c);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') return conjuncts((u as UnaryExpr).operand);
  if (u.kind === NodeKind.BinaryExpr) {
    const b = u as BinaryExpr;
    if (b.operator === '||') return [...negatedConjuncts(b.left), ...negatedConjuncts(b.right)];
    const f = FLIP[b.operator];
    if (f) return [Expr.binary(cloneNode(b.left), f, cloneNode(b.right))];
  }
  return [Expr.not(Expr.paren(cloneNode(c)))];
}

export function conjuncts(e: Expression): Expression[] {
  const u = unwrap(e);
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '&&') {
    return [...conjuncts((u as BinaryExpr).left), ...conjuncts((u as BinaryExpr).right)];
  }
  return [cloneNode(e)];
}

/** The single statement of a branch: `{ s }` or `s`. */
export function only(s: Statement): Statement | null {
  if (s.kind !== NodeKind.CompoundStmt) return s;
  const st = (s as CompoundStmt).statements;
  return st.length === 1 ? only(st[0]) : null;
}

/** `if (c) return R;` with no else: the condition and the return. */
export function returnGuard(s: Statement): { cond: Expression; ret: ReturnStmt } | null {
  if (s.kind !== NodeKind.IfStmt) return null;
  const ifs = s as IfStmt;
  if (ifs.init || ifs.elseBranch) return null;
  const r = only(ifs.thenBranch);
  if (!r || r.kind !== NodeKind.ReturnStmt) return null;
  return { cond: ifs.condition, ret: r as ReturnStmt };
}

/** `p = E;` or `T *p = E;`: the name, the value and whether it declares. */
export function recordStore(s: Statement): { name: string; value: Expression; decl: VariableDecl | null } | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unwrap((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    const l = unwrap((e as AssignExpr).left);
    if (l.kind !== NodeKind.Identifier) return null;
    return { name: (l as Identifier).name, value: (e as AssignExpr).right, decl: null };
  }
  if (s.kind === NodeKind.DeclStmt) {
    const d = (s as DeclStmt).declarations;
    if (d.length !== 1 || d[0].kind !== NodeKind.VariableDecl) return null;
    const v = d[0] as VariableDecl;
    if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr) return null;
    return { name: v.name.name, value: v.initializer as Expression, decl: v };
  }
  return null;
}

export function sameReturn(a: ReturnStmt, b: ReturnStmt): boolean {
  if (!a.value || !b.value) return !a.value && !b.value;
  return nodesEqual(unwrap(a.value), unwrap(b.value));
}

export function placedLine(n: ASTNode): number | null {
  const l = n.location;
  if (!l || l.file === '<generated>' || l.start.line <= 0) return null;
  return l.start.line;
}

function placedRange(n: ASTNode): [number, number] | null {
  const l = n.location;
  if (!l || l.file === '<generated>' || l.start.line <= 0) return null;
  return [l.start.line, Math.max(l.start.line, l.end.line)];
}

export class Gate {
  private readonly ifLines: number[];
  constructor(private readonly ev: BranchLayoutEvidence) {
    this.ifLines = [...ev.ifs.keys()].sort((a, b) => a - b);
  }

  /** Every line lies in the condition of one decompiled `if`: after its keyword, before the next. */
  oneCondition(lines: number[]): boolean {
    if (lines.length === 0) return false;
    const lo = Math.min(...lines), hi = Math.max(...lines);
    let start = -1;
    for (const l of this.ifLines) if (l <= lo) start = l;
    if (start < 0) return false;
    const next = this.ifLines.find(l => l > start);
    return next === undefined || hi < next;
  }

  /** The offsets the lines of `nodes` print; null when one is not placed or prints nothing. */
  private offsets(nodes: ASTNode[]): number[] | null {
    const out: number[] = [];
    for (const n of nodes) {
      const r = placedRange(n);
      if (!r) return null;
      const own: number[] = [];
      for (let l = r[0]; l <= r[1]; l++) own.push(...(this.ev.lines.get(l) ?? []));
      if (own.length === 0) return null;
      out.push(...own);
    }
    return out;
  }

  /**
   * No return copy that a return's offsets lie in starts before a test ends: the original
   * did not leave the first tests through a copy laid out between them.
   */
  copyAfterTests(rets: ReturnStmt[], tests: ASTNode[]): boolean {
    const ro = this.offsets(rets);
    const to = this.offsets(tests);
    if (!ro || !to) return false;
    const last = Math.max(...to);
    for (const o of ro) {
      const c = (this.ev.returns ?? []).find(x => x.start <= o && o <= x.ret);
      if (c && c.start <= last) return false;
    }
    return true;
  }

  /**
   * The return copy every return lies in, laid out after every test, entered by a forward
   * jump per test: \`jumps\` of them, or one fewer when the code before falls into it (the
   * null test skipping it). Null when there is no such copy.
   */
  sharedExit(rets: ReturnStmt[], tests: ASTNode[], jumps: number, fallCounts: boolean): boolean {
    const copies = this.ev.returns ?? [];
    const ro = this.offsets(rets);
    const to = this.offsets(tests);
    if (!ro || !to) return false;
    let copy: (typeof copies)[number] | null = null;
    for (const o of ro) {
      const c = copies.find(x => x.start <= o && o <= x.ret);
      if (!c || (copy && copy !== c)) return false;
      copy = c;
    }
    if (!copy || !copy.jumpsIn) return false;
    if (to.some(o => o >= copy!.start)) return false;
    const forward = copy.jumpsIn.filter(j => j < copy!.start).length;
    return forward >= jumps || (fallCounts && !!copy.fallsIn && forward >= jumps - 1);
  }
}

function rewriteFunction(fn: FunctionDecl, opts: RecordGetterSplitOptions): FunctionDecl | undefined {
  if (!fn.body || !opts.branchLayout) return undefined;
  const gate = new Gate(opts.branchLayout);
  const body = cloneNode(fn.body);
  const counts = new Map<string, number>();
  for (const p of fn.parameters as ParameterDecl[]) {
    const n = (p as unknown as { name?: Identifier | null }).name;
    if (n && n.kind === NodeKind.Identifier) counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
  }
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      counts.set(v.name.name, (counts.get(v.name.name) ?? 0) + 1);
    }
  }
  // A name whose storage `&` takes: `&x`, `&x.f`, `&x[k]` of an array; `&p[k]` through a
  // pointer takes neither `p`'s nor `k`'s.
  const pointers = new Set<string>();
  for (const p of fn.parameters as ParameterDecl[]) {
    const n = (p as unknown as { name?: Identifier | null }).name;
    if (n && (p as unknown as VariableDecl).type?.kind === NodeKind.PointerType) pointers.add(n.name);
  }
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl && (n as VariableDecl).type?.kind === NodeKind.PointerType) pointers.add((n as VariableDecl).name.name);
  }
  const addressed = new Set<string>();
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.UnaryExpr || (n as UnaryExpr).operator !== '&') continue;
    let x = uncast((n as UnaryExpr).operand);
    let root: string | null = null;
    for (;;) {
      if (x.kind === NodeKind.Identifier) { root = (x as Identifier).name; break; }
      if (x.kind === NodeKind.MemberExpr && !(x as MemberExpr).isArrow) { x = uncast((x as MemberExpr).object); continue; }
      if (x.kind === NodeKind.SubscriptExpr) {
        const a = uncast((x as SubscriptExpr).array);
        if (a.kind === NodeKind.Identifier && pointers.has((a as Identifier).name)) break;
        x = a;
        continue;
      }
      if (x.kind === NodeKind.MemberExpr) break;
      for (const m of traverseAST(x)) if (m.kind === NodeKind.Identifier) addressed.add((m as Identifier).name);
      break;
    }
    if (root) addressed.add(root);
  }
  const local = (name: string) => counts.get(name) === 1 && !addressed.has(name);
  /** References to `name` in the body outside `inside`, its declarations without a value excepted. */
  const refsOutside = (name: string, inside: ASTNode[]): number => {
    const skip = new Set<ASTNode>();
    for (const r of inside) for (const n of traverseAST(r)) skip.add(n);
    for (const n of traverseAST(body)) {
      if (n.kind === NodeKind.VariableDecl && !(n as VariableDecl).initializer) skip.add((n as VariableDecl).name);
    }
    let c = 0;
    for (const n of traverseAST(body)) {
      if (skip.has(n)) continue;
      if (n.kind === NodeKind.Identifier && (n as Identifier).name === name) c++;
    }
    return c;
  };

  const store = (s: Statement, value: Expression): Statement => {
    const st = recordStore(s)!;
    let out: Statement;
    if (st.decl) {
      const d = s as DeclStmt;
      out = { ...d, declarations: [{ ...st.decl, initializer: value }] } as DeclStmt;
    } else {
      const e = unwrap((s as ExprStmt).expression) as AssignExpr;
      out = { ...(s as ExprStmt), expression: { ...e, right: value } } as ExprStmt;
    }
    return out;
  };

  /** `p + i`, `&p[i]`, `p[i]` (as a read through `p`): the forms a held base reads its record by. */
  const heldRead = (e: ASTNode, name: string, index: string): 'sum' | 'addr' | 'member' | 'index' | null => {
    const isP = (x: Expression) => { const u = uncast(x); return u.kind === NodeKind.Identifier && (u as Identifier).name === name; };
    const isI = (x: Expression) => { const u = uncast(x); return u.kind === NodeKind.Identifier && (u as Identifier).name === index; };
    const sub = (x: Expression) => { const u = unwrap(x); return u.kind === NodeKind.SubscriptExpr && isP((u as SubscriptExpr).array) && isI((u as SubscriptExpr).index); };
    if (e.kind === NodeKind.BinaryExpr && (e as BinaryExpr).operator === '+' && isP((e as BinaryExpr).left) && isI((e as BinaryExpr).right)) return 'sum';
    if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '&' && sub((e as UnaryExpr).operand)) return 'addr';
    if (e.kind === NodeKind.MemberExpr && !(e as MemberExpr).isArrow && sub((e as MemberExpr).object)) return 'member';
    if (sub(e as Expression)) return 'index';
    return null;
  };
  /**
   * Every reference to the held base `name` in the body but `except` reads the record at
   * `index`: rewrite them to read through `name` as the record (mutating). Dry run: whether
   * they all do.
   */
  const routeHeld = (name: string, index: string, except: Set<ASTNode>, dryRun: boolean): boolean => {
    let ok = true;
    const walk = (node: ASTNode): void => {
      const rec = node as unknown as Record<string, unknown>;
      for (const key of Object.keys(rec)) {
        if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia' || key === 'ghidraInfo') continue;
        if (node.kind === NodeKind.VariableDecl && key === 'name') continue;
        const v = rec[key];
        const visit = (c: ASTNode, set: (r: ASTNode) => void): void => {
          if (except.has(c)) return;
          const u = c.kind === NodeKind.ParenExpr ? unwrap(c as Expression) : c;
          const form = heldRead(u, name, index);
          if (form) {
            if (dryRun) return;
            if (form === 'sum' || form === 'addr') set(Expr.identifier(name));
            else if (form === 'member') set({ ...(u as MemberExpr), object: Expr.identifier(name), isArrow: true } as MemberExpr);
            else set(Expr.deref(Expr.identifier(name)));
            return;
          }
          if (c.kind === NodeKind.Identifier && (c as Identifier).name === name) { ok = false; return; }
          walk(c);
        };
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) {
            const c = v[i];
            if (c && typeof c === 'object' && typeof (c as ASTNode).kind === 'string') visit(c as ASTNode, r => { v[i] = r; });
          }
        } else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') {
          visit(v as ASTNode, r => { rec[key] = r; });
        }
      }
    };
    walk(body);
    return ok;
  };

  // The record type of a bare null test: from the declarations.
  const localTypes = new Map<string, TypeNode>();
  for (const p of fn.parameters as ParameterDecl[]) {
    const n = (p as unknown as { name?: Identifier | null }).name;
    if (n && n.kind === NodeKind.Identifier) localTypes.set(n.name, (p as unknown as VariableDecl).type);
  }
  for (const n of traverseAST(body)) if (n.kind === NodeKind.VariableDecl) localTypes.set((n as VariableDecl).name.name, (n as VariableDecl).type);
  const typedefTargets = opts.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  const shapeOf = opts.structFields || opts.globalTypes ? createExprShape(localTypes, {
    globalTypes: opts.globalTypes, enclosingVarTypes: opts.enclosingVarTypes, structFields: opts.structFields,
    fieldTypes: opts.fieldTypes, returnTypes: opts.functionReturnTypes, resolve,
  }) : null;
  const shadowed = new Set(opts.shadowedTypeNames ?? []);
  const taken = new Set<string>();
  {
    const members = new Set<ASTNode>();
    for (const n of traverseAST(fn)) if (n.kind === NodeKind.MemberExpr) members.add((n as MemberExpr).member);
    for (const n of traverseAST(fn)) if (n.kind === NodeKind.Identifier && !members.has(n)) taken.add((n as Identifier).name);
  }
  const fresh = (want: string): string => {
    let name = want;
    for (let i = 2; taken.has(name); i++) name = `${want}${i}`;
    taken.add(name);
    return name;
  };

  /**
   * bare: `if (c) return R; .. if (!(base + i)) return R;` and the record read as
   * `base[i]` after it, with no local for it at all. `base` is a member chain from a
   * name. Written `T *p = c' ? base + i : nullptr; if (!p) return R;` and the reads after
   * go through `p` up to what may change `base`, `i` or the record (as record-getter-guard
   * routes them). On a failed test both return R before reading anything.
   */
  let bareSites = 0;
  const tryBare = (block: CompoundStmt, b: number): number | null => {
    if (!shapeOf) return null;
    const s = block.statements[b];
    const ng = returnGuard(s);
    if (!ng) return null;
    const neg = unwrap(ng.cond);
    if (neg.kind !== NodeKind.UnaryExpr || (neg as UnaryExpr).operator !== '!') return null;
    const sum = unwrap((neg as UnaryExpr).operand);
    if (sum.kind !== NodeKind.BinaryExpr || (sum as BinaryExpr).operator !== '+') return null;
    const base = (sum as BinaryExpr).left;
    const idx = unwrap((sum as BinaryExpr).right);
    if (idx.kind !== NodeKind.Identifier || !local((idx as Identifier).name)) return null;
    const index = (idx as Identifier).name;
    const chain = memberChain(base);
    if (!chain || !pure(base) || mentions(base, index)) return null;
    const shape = shapeOf(unwrap(base));
    if (!shape || shape.stars !== 1 || shape.isConst || shape.base === 'void') return null;
    const ret = ng.ret;
    if (ret.value && !pure(ret.value)) return null;
    let first = b;
    const guards: { cond: Expression; ret: ReturnStmt }[] = [];
    while (first > 0) {
      const g = returnGuard(block.statements[first - 1]);
      if (!g || !pure(g.cond) || !mentions(g.cond, index) || !sameReturn(g.ret, ret)) break;
      guards.unshift(g);
      first--;
    }
    if (guards.length === 0) return null;
    const after = block.statements.slice(b + 1);
    if (hasJumpTarget(after)) return null;
    const rets = [...guards.map(g => g.ret), ret];
    const tests = [...guards.map(g => g.cond), ng.cond];
    const leaves = guards.reduce((n, g) => n + negatedConjuncts(g.cond).length, 0);
    const lines = tests.map(placedLine);
    const oneIf = lines.every(l => l !== null) && gate.oneCondition(lines as number[]);
    if (!oneIf && !gate.sharedExit(rets, tests, leaves + 1, true)) return null;
    if (!gate.copyAfterTests(rets, tests)) return null;
    const g: Guard = { base, index: idx as Identifier, bounds: [], root: chain.root, last: chain.last };
    // Reads it may not route leave the test as printed; none at all is a null test alone.
    if (routeReads(after, g, '', true) === 0 && after.some(x => countReads(x, g) > 0)) return null;
    const name = fresh(recordName(chain.last));
    routeReads(after, g, name, false);
    const test = guards.flatMap(x => negatedConjuncts(x.cond)).reduce((l, r) => Expr.binary(l, '&&', r));
    const value = Expr.conditional(test, Expr.binary(cloneNode(base), '+', cloneNode(idx as Identifier)), Expr.nullptr());
    const ds = Stmt.declStmt([Decl.variable(name, typeOfShape(shape, shadowed), value)]);
    const head = block.statements[first];
    ds.location = s.location;
    ds.leadingTrivia = head.leadingTrivia;
    (s as IfStmt).leadingTrivia = [];
    (s as { condition: Expression }).condition = Expr.not(Expr.identifier(name));
    block.statements.splice(first, b - first, ds);
    bareSites++;
    opts.onSite?.({ line: placedLine(head) ?? 0, name, form: 'bare', tests: guards.length });
    return first + 1;
  };

  let changed = 0;
  const visitBlock = (block: CompoundStmt): void => {
    for (let b = 0; b < block.statements.length; b++) {
      const s = block.statements[b];
      for (const k of getChildren(s)) visitAll(k);

      // nested: if (B) { p = base + i; if (p ..) S }
      if (s.kind === NodeKind.IfStmt && !(s as IfStmt).init && !(s as IfStmt).elseBranch
        && (s as IfStmt).thenBranch.kind === NodeKind.CompoundStmt) {
        const outer = s as IfStmt;
        const inner = (outer.thenBranch as CompoundStmt).statements;
        const st = inner.length === 2 ? recordStore(inner[0]) : null;
        const rec = st ? recordIndex(st.value) : null;
        const test = inner.length === 2 && inner[1].kind === NodeKind.IfStmt ? inner[1] as IfStmt : null;
        if (st && rec && test && !test.init && !test.elseBranch && valueOnNull(test.condition, st.name, null) === false
          && local(st.name) && local(rec.index) && !mentions(st.value, st.name)
          && pure(outer.condition) && !mentions(outer.condition, st.name)
          && conjuncts(outer.condition).some(c => mentions(c, rec.index))
          && refsOutside(st.name, [outer]) === 0) {
          const lines = [placedLine(outer.condition), placedLine(test.condition)];
          if (lines.every(l => l !== null) && gate.oneCondition(lines as number[])) {
            const value = Expr.conditional(cloneNode(outer.condition), cloneNode(st.value), Expr.nullptr());
            const ns = store(inner[0], value);
            ns.location = s.location;
            ns.leadingTrivia = s.leadingTrivia;
            block.statements.splice(b, 1, ns, test);
            changed++;
            opts.onSite?.({ line: placedLine(s) ?? 0, name: st.name, form: 'nested', tests: 1 });
            continue;
          }
        }
      }

      // guards: if (c) return R; .. p = base + i; if (!p ..) return R;   (or if (p ..) S return R;)
      // A held base: p = base; if (!(p + i) ..) .., its record read as p[i] everywhere.
      const bare = tryBare(block, b);
      if (bare !== null) { b = bare; continue; }

      const st = recordStore(s);
      const next = block.statements[b + 1];
      if (!st || !local(st.name) || mentions(st.value, st.name) || !pure(st.value)) continue;
      if (!next || next.kind !== NodeKind.IfStmt || (next as IfStmt).init) continue;
      const cond = (next as IfStmt).condition;
      const direct = recordIndex(st.value);
      const held = direct ? null : heldIndex(cond, st.name);
      const index = direct ? direct.index : held;
      if (!index || !local(index)) continue;
      if (held && (uncast(st.value).kind === NodeKind.IntegerLiteral || mentions(st.value, held) || !(writtenOnlyBefore(body, s, held) || readBeforeRewritten(body, s, held, st.name)))) continue;
      const onNull = valueOnNull(cond, st.name, held);
      let ret: ReturnStmt | null;
      let form: 'guards' | 'guards-then';
      if (onNull === true) {
        const g = returnGuard(next);
        if (!g) continue;
        ret = g.ret; form = 'guards';
      } else if (onNull === false) {
        const after = block.statements[b + 2];
        if ((next as IfStmt).elseBranch || !after || after.kind !== NodeKind.ReturnStmt) continue;
        ret = after as ReturnStmt; form = 'guards-then';
      } else continue;
      if (ret.value && (!pure(ret.value) || mentions(ret.value, st.name))) continue;
      let first = b;
      const guards: { cond: Expression; ret: ReturnStmt }[] = [];
      while (first > 0) {
        const g = returnGuard(block.statements[first - 1]);
        if (!g || !pure(g.cond) || !mentions(g.cond, index) || mentions(g.cond, st.name) || !sameReturn(g.ret, ret)) break;
        guards.unshift(g);
        first--;
      }
      if (guards.length === 0) continue;
      const rets = [...guards.map(g => g.ret), ret];
      const tests = [...guards.map(g => g.cond), cond];
      const leaves = guards.reduce((n, g) => n + negatedConjuncts(g.cond).length, 0);
      const lines = tests.map(placedLine);
      const oneIf = lines.every(l => l !== null) && gate.oneCondition(lines as number[]);
      if (!oneIf && !gate.sharedExit(rets, tests, leaves + 1, form === 'guards')) continue;
      if (!gate.copyAfterTests(rets, tests)) continue;
      if (held && !routeHeld(st.name, held, new Set([s]), true)) continue;
      let value = cloneNode(st.value);
      if (held) {
        const at = (() => {
          let u = unwrap(cond);
          for (;;) {
            if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') { u = unwrap((u as UnaryExpr).operand); continue; }
            if (u.kind === NodeKind.BinaryExpr && ['&&', '||', '==', '!='].includes((u as BinaryExpr).operator)) { u = unwrap((u as BinaryExpr).left); continue; }
            return uncast(u) as BinaryExpr;
          }
        })();
        value = Expr.binary(value, '+', cloneNode(at.right));
        routeHeld(st.name, held, new Set([s]), false);
      }
      const test = guards.flatMap(g => negatedConjuncts(g.cond)).reduce((l, r) => Expr.binary(l, '&&', r));
      const ns = store(s, Expr.conditional(test, value, Expr.nullptr()));
      const head = block.statements[first];
      ns.location = s.location;
      ns.leadingTrivia = head.leadingTrivia;
      block.statements.splice(first, b - first + 1, ns);
      b = first;
      changed++;
      opts.onSite?.({ line: placedLine(head) ?? 0, name: st.name, form: held ? (form === 'guards' ? 'held' : 'held-then') : form, tests: guards.length });
    }
  };
  const visitAll = (n: ASTNode): void => {
    if (n.kind === NodeKind.CompoundStmt) { visitBlock(n as CompoundStmt); return; }
    for (const k of getChildren(n)) visitAll(k);
  };
  visitAll(body);
  if (!changed && !bareSites) return undefined;
  return updateNode(fn, { body } as Partial<FunctionDecl>);
}

function createRecordGetterSplitTransformer(options: RecordGetterSplitOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  });
}

export const recordGetterSplitPlugin: TransformPlugin = {
  id: 'record-getter-split',
  name: 'Record Getter Split',
  description:
    'Writes an inlined record getter whose range tests and null test were split apart back as one conditional pointer and its null test',
  version: '1.0.0',
  defaultEnabled: true,
  // After early-return (60) and decl-init-merge (60) have split the guard and joined the
  // store to its declaration, after record-getter-guard (60.5); before decl-order-fix (61).
  priority: 60.55,
  tags: ['matching'],
  createTransformer: createRecordGetterSplitTransformer,
};
