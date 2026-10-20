/**
 * Branch CFG: a region of the statement tree lowered to a graph with LABELLED edges.
 *
 * `build.ts` answers "can control get in here?" - reachability. It cannot tell an `if` from
 * the same `if` with its arms swapped, because its successors are an unordered pair and its
 * conditions are not nodes. A structurer needs more than that: it needs to know that after a
 * rewrite every path still does the same work and asks the same questions in the same order
 * and takes the same answer the same way. That is what this graph is for; `equivalence.ts`
 * compares two of them.
 *
 * Node kinds:
 *
 *   work      one statement with an observable effect, keyed by its emitted text
 *   test      one ATOM of a condition, with a true and a false successor. `&&`, `||`, `!`,
 *             `?:` and `,` inside a condition are lowered here, the way the compiler lowers
 *             them, so `if (!a) X else Y` and `if (a) Y else X` are the same graph and
 *             `a && b` is a test on `a` whose true edge is a test on `b`.
 *   dispatch  a `switch`: the scrutinee's key, case value -> successor, and a default
 *   exit      `return` (a valued return is a work node `r:<expr>` and then exit)
 *   follow    falling off the end of the region; the caller says when that IS the exit
 *   external  leaving the region by name: a goto to a label the region does not define, a
 *             `break`/`continue` with no binder inside the region
 *   noreturn  a call that does not return (by name, or by Ghidra's warning)
 *   spin      a cycle with no work and no test in it (`for (;;) {}`)
 *   nop       scaffolding (label, goto, compound, case label, null statement): contracted
 *
 * Literal conditions have one edge: `if (false)` reaches its then-arm only through labels,
 * which is exactly Ghidra's meaning for that shape.
 *
 * ## Assumptions, stated once
 *
 * A2 (text is identity): two statements with the same emitted text do the same thing. The
 *    exception is SITE-UNIQUE work, whose value depends on where it sits -
 *    `GetInstructionPointer()` returns its own return address. Such a statement is keyed by
 *    its object identity as well, so a copy of it can never match the original.
 * A3 (noreturn): a call named in `noreturn`, or carrying Ghidra's "Subroutine does not return"
 *    warning, does not return. The goto passes already rely on this; the graph says so
 *    explicitly so the proof does too.
 * A1 (scope) is checked, not assumed: every work and test node records the declarations it
 *    can see inside the region, and `equivalence.ts` requires a copy to see the same ones.
 *
 * Anything this file cannot model (try, range-for, a label inside an expression statement it
 * cannot see into, ...) throws `Unsupported`, and the caller treats it as "not proven".
 */

import { NodeKind } from '../../ast/kinds.js';
import type {
  ASTNode,
  CaseStmt,
  CompoundStmt,
  DeclStmt,
  DefaultStmt,
  DoWhileStmt,
  Expression,
  ForStmt,
  GotoStmt,
  IfStmt,
  LabelStmt,
  ReturnStmt,
  Statement,
  SwitchStmt,
  VariableDecl,
  WhileStmt,
} from '../../ast/nodes.js';
import { emit } from '../../emit/index.js';
import { getChildren } from '../../ast/visitor.js';
import { TriviaKind } from '../../lexer/trivia.js';

export type BNodeKind =
  | 'entry' | 'work' | 'test' | 'dispatch' | 'exit' | 'follow' | 'external' | 'noreturn' | 'spin' | 'nop';

export interface BNode {
  id: number;
  kind: BNodeKind;
  /** work / test / dispatch: canonical key. external: the name it leaves by. */
  key: string;
  /** work, nop, entry: the one successor. */
  next: number;
  /** test: successors. */
  t: number;
  f: number;
  /** dispatch: case key -> successor, and the default. */
  cases: Map<string, number> | null;
  dflt: number;
  /** The statement (work/nop) or expression (test/dispatch) the node came from. */
  origin: ASTNode | null;
  /** work/test/dispatch: the region declarations visible here. */
  scope: Scope | null;
  /** test: the atom has no side effect (see `isPureExpr`). */
  pure: boolean;
}

/** A persistent chain of declarations, innermost first. */
export interface Scope {
  name: string;
  decl: DeclStmt;
  parent: Scope | null;
}

export interface Bcfg {
  nodes: BNode[];
  entry: number;
  /**
   * Entry points other than falling into the region: `label:<name>` for every label the
   * region defines that is also targeted from outside it, and `case:<value>` for every case
   * label whose switch is outside the region. Control reaches these without `entry`.
   */
  namedEntries: Map<string, number>;
  /** DeclStmt -> its work node, for the scope check. */
  declNodes: Map<DeclStmt, number>;
}

export interface BcfgOptions {
  /**
   * Whole-function goto counts, label -> gotos anywhere in the function. A label with more
   * gotos than the region holds is an entry point. Without it every label is one.
   */
  externalGotoCounts?: Map<string, number> | null;
  /** Falling off the end of the region is the function's return (a void tail). */
  followIsExit?: boolean;
  /** Names of calls that do not return (A3). */
  noreturn?: ReadonlySet<string>;
  /**
   * The halt exception to A2 (design 4.2, "halt-site-fold keeps its own halt-specific
   * exception"): a site-unique statement whose every successor up to a noreturn call is a
   * step of the assert/halt sequence is keyed by its text, not its site. Its value only
   * reaches the halt report, and every assert in the source expanded the sequence at its
   * own site - copying it back is the E3 evidence class, not a change of behaviour.
   */
  haltException?: boolean;
}

export class Unsupported extends Error {}

const SITE_UNIQUE = /\bGetInstructionPointer\s*\(|__LINE__|__FILE__|_ReturnAddress\s*\(|__builtin_return_address\s*\(/;

const identity = new WeakMap<object, number>();
let identityNext = 1;
function objectIdentity(o: object): number {
  let n = identity.get(o);
  if (n === undefined) { n = identityNext++; identity.set(o, n); }
  return n;
}

/**
 * Every copy a goto handler makes is stamped with a fresh mark (`markCopy`). An enumerable
 * symbol property survives the transformer's rebuilding of nodes (it spreads them), and a
 * fresh `structuredClone` drops it - so `<source offset>#<mark>` names one SITE: stable while
 * the statement is merely carried through the passes, different the moment it is copied.
 */
export const COPY_MARK = Symbol.for('ghidra-mcp:goto-copy-mark');
let copyNext = 1;

/** Stamp every node of a freshly cloned subtree as one new copy. */
export function markCopy<T>(tree: T): T {
  const id = copyNext++;
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const node = n as Record<string | symbol, unknown>;
    if (typeof node.kind === 'string') {
      Object.defineProperty(node, COPY_MARK, { value: id, enumerable: true, configurable: true, writable: true });
    }
    for (const k of Object.keys(node)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      const v = node[k];
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(tree);
  return tree;
}

function identityOf(o: object): string {
  const loc = (o as { location?: { file?: string; start?: { offset?: number } } }).location;
  const off = loc?.start?.offset;
  if (typeof off !== 'number') return 'obj' + objectIdentity(o);
  return `${loc?.file ?? ''}@${off}.${(o as Record<symbol, unknown>)[COPY_MARK] ?? 0}`;
}

const textCache = new WeakMap<object, string>();
/** Emitted text, cached on the node (untouched subtrees keep their identity across rewrites). */
export function nodeText(n: ASTNode): string {
  const hit = textCache.get(n as object);
  if (hit !== undefined) return hit;
  let t: string;
  try { t = emit(n as never); } catch { throw new Unsupported(`cannot emit ${n.kind}`); }
  t = t.trim();
  textCache.set(n as object, t);
  return t;
}

function stripParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as unknown as { expression: Expression }).expression;
  return e;
}

/** Constant truth value of a condition, or null when it has to be evaluated. */
function constTruth(e: Expression): boolean | null {
  e = stripParens(e);
  if (e.kind === NodeKind.BoolLiteral) return (e as unknown as { value: boolean }).value;
  if (e.kind === NodeKind.IntegerLiteral) return (e as unknown as { value: bigint }).value !== 0n;
  return null;
}

const NORETURN_WARNING = 'WARNING: Subroutine does not return';

function calleeName(e: Expression): string | null {
  e = stripParens(e);
  if (e.kind !== NodeKind.CallExpr) return null;
  let c = stripParens((e as unknown as { callee: Expression }).callee);
  if (c.kind === NodeKind.Identifier) return (c as unknown as { name: string }).name;
  if (c.kind === NodeKind.QualifiedId) {
    const n = (c as unknown as { name: ASTNode }).name;
    if (n.kind === NodeKind.Identifier) return (n as unknown as { name: string }).name;
  }
  return null;
}

function isNoreturnStmt(s: Statement, names: ReadonlySet<string> | undefined): boolean {
  if (s.kind !== NodeKind.ExprStmt) return false;
  for (const t of s.leadingTrivia ?? []) {
    if ((t.kind === TriviaKind.BlockComment || t.kind === TriviaKind.LineComment) && t.text.includes(NORETURN_WARNING)) return true;
  }
  const n = calleeName((s as unknown as { expression: Expression }).expression);
  return n !== null && !!names?.has(n);
}

interface Ctx {
  brk: number | null;
  cont: number | null;
  /** case key -> node, for the innermost switch of the region; null outside any. */
  caseSink: Map<string, number> | null;
  scope: Scope | null;
}

class Builder {
  nodes: BNode[] = [];
  labels = new Map<string, number>();
  pendingGotos: { from: number; label: string }[] = [];
  foreignCases = new Map<string, number>();
  declNodes = new Map<DeclStmt, number>();
  exit: number;
  follow: number;
  noretNode: number;
  spin: number;
  externals = new Map<string, number>();

  constructor(private opts: BcfgOptions) {
    this.exit = this.add('exit', '');
    this.follow = opts.followIsExit ? this.exit : this.add('follow', '');
    this.noretNode = this.add('noreturn', '');
    this.spin = this.add('spin', '');
  }

  add(kind: BNodeKind, key: string, origin: ASTNode | null = null, scope: Scope | null = null): number {
    const id = this.nodes.length;
    this.nodes.push({ id, kind, key, next: -1, t: -1, f: -1, cases: null, dflt: -1, origin, scope, pure: false });
    return id;
  }

  external(name: string): number {
    let id = this.externals.get(name);
    if (id === undefined) { id = this.add('external', name); this.externals.set(name, id); }
    return id;
  }

  nop(next: number, origin: ASTNode | null = null): number {
    const id = this.add('nop', '', origin);
    this.nodes[id].next = next;
    return id;
  }

  workKey(s: Statement): string {
    // An expression statement is keyed by its EXPRESSION, so `i++;` in a latch and the `i++`
    // of a `for` header are the same work.
    const text = s.kind === NodeKind.ExprStmt
      ? nodeText((s as unknown as { expression: Expression }).expression)
      : nodeText(s);
    const prefix = s.kind === NodeKind.DeclStmt ? 'd:' : s.kind === NodeKind.ExprStmt ? 'e:' : `s:${s.kind}:`;
    return SITE_UNIQUE.test(text) ? `${prefix}${text}#site${identityOf(s)}` : prefix + text;
  }

  /** Key of an expression evaluated for its effect (a `for` increment, a comma operand). */
  exprKey(e: Expression): string {
    const text = nodeText(e);
    return SITE_UNIQUE.test(text) ? `e:${text}#site${identityOf(e)}` : 'e:' + text;
  }

  /** Lower a condition: control reaches `t` when it is true and `f` when false. */
  cond(e: Expression, t: number, f: number, scope: Scope | null): number {
    const c = constTruth(e);
    if (c !== null) return c ? t : f;
    e = stripParens(e);
    if (e.kind === NodeKind.UnaryExpr && (e as unknown as { operator: string }).operator === '!') {
      return this.cond((e as unknown as { operand: Expression }).operand, f, t, scope);
    }
    if (e.kind === NodeKind.BinaryExpr) {
      const b = e as unknown as { operator: string; left: Expression; right: Expression };
      if (b.operator === '&&') return this.cond(b.left, this.cond(b.right, t, f, scope), f, scope);
      if (b.operator === '||') return this.cond(b.left, t, this.cond(b.right, t, f, scope), scope);
    }
    if (e.kind === NodeKind.ConditionalExpr) {
      const q = e as unknown as { condition: Expression; thenExpr: Expression; elseExpr: Expression };
      return this.cond(q.condition, this.cond(q.thenExpr, t, f, scope), this.cond(q.elseExpr, t, f, scope), scope);
    }
    if (e.kind === NodeKind.CommaExpr) {
      const xs = (e as unknown as { expressions: Expression[] }).expressions;
      let cur = this.cond(xs[xs.length - 1], t, f, scope);
      for (let i = xs.length - 2; i >= 0; i--) {
        const w = this.add('work', this.exprKey(xs[i]), xs[i], scope);
        this.nodes[w].next = cur;
        cur = w;
      }
      return cur;
    }
    const text = nodeText(e);
    const id = this.add('test', SITE_UNIQUE.test(text) ? `${text}#site${identityOf(e)}` : text, e, scope);
    this.nodes[id].pure = isPureExpr(e);
    this.nodes[id].t = t;
    this.nodes[id].f = f;
    return id;
  }

  /** Scope link for every position in a statement list: index i sees the decls before i. */
  scopesFor(stmts: Statement[], outer: Scope | null): (Scope | null)[] {
    const out: (Scope | null)[] = [];
    let cur = outer;
    for (const s of stmts) {
      out.push(cur);
      cur = this.extendScope(s, cur);
    }
    return out;
  }

  extendScope(s: Statement, cur: Scope | null): Scope | null {
    // A label or case wrapping a declaration still declares it in this compound.
    while (s.kind === NodeKind.LabelStmt || s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) {
      s = (s as unknown as { statement: Statement }).statement;
    }
    if (s.kind !== NodeKind.DeclStmt) return cur;
    for (const d of (s as DeclStmt).declarations) {
      if (d.kind === NodeKind.VariableDecl) {
        cur = { name: (d as VariableDecl).name.name, decl: s as DeclStmt, parent: cur };
      }
    }
    return cur;
  }

  seq(stmts: Statement[], next: number, ctx: Ctx): number {
    const scopes = this.scopesFor(stmts, ctx.scope);
    let cur = next;
    for (let i = stmts.length - 1; i >= 0; i--) {
      cur = this.stmt(stmts[i], cur, { ...ctx, scope: scopes[i] });
    }
    return cur;
  }

  stmt(s: Statement, next: number, ctx: Ctx): number {
    switch (s.kind) {
      case NodeKind.CompoundStmt:
        return this.seq((s as CompoundStmt).statements, next, ctx);
      case NodeKind.NullStmt:
        return next;
      case NodeKind.ExprStmt:
      case NodeKind.DeclStmt: {
        const id = this.add('work', this.workKey(s), s, ctx.scope);
        if (s.kind === NodeKind.DeclStmt) this.declNodes.set(s as DeclStmt, id);
        this.nodes[id].next = isNoreturnStmt(s, this.opts.noreturn) ? this.noretNode : next;
        return id;
      }
      case NodeKind.IfStmt: {
        const n = s as IfStmt;
        if (n.init) throw new Unsupported('if with an init statement');
        const t = this.stmt(n.thenBranch, next, ctx);
        const f = n.elseBranch ? this.stmt(n.elseBranch, next, ctx) : next;
        return this.cond(n.condition, t, f, ctx.scope);
      }
      case NodeKind.WhileStmt: {
        const n = s as WhileStmt;
        const head = this.nop(-1, s);
        const body = this.stmt(n.body, head, { ...ctx, brk: next, cont: head });
        this.nodes[head].next = this.cond(n.condition, body, next, ctx.scope);
        return head;
      }
      case NodeKind.DoWhileStmt: {
        const n = s as DoWhileStmt;
        const test = this.nop(-1, s);
        const body = this.stmt(n.body, test, { ...ctx, brk: next, cont: test });
        this.nodes[test].next = this.cond(n.condition, body, next, ctx.scope);
        // The body is entered first; a nop in front keeps `body` a single node id.
        return this.nop(body, s);
      }
      case NodeKind.ForStmt: {
        const n = s as ForStmt;
        const inner = n.init ? this.extendScope(n.init, ctx.scope) : ctx.scope;
        const head = this.nop(-1, s);
        let incr = head;
        if (n.increment) {
          incr = this.add('work', this.exprKey(n.increment), n.increment, inner);
          this.nodes[incr].next = head;
        }
        const body = this.stmt(n.body, incr, { ...ctx, brk: next, cont: incr, scope: inner });
        this.nodes[head].next = n.condition ? this.cond(n.condition, body, next, inner) : body;
        return n.init ? this.stmt(n.init, head, ctx) : head;
      }
      case NodeKind.SwitchStmt: {
        const n = s as SwitchStmt;
        if (n.init) throw new Unsupported('switch with an init statement');
        const sink = new Map<string, number>();
        const disp = this.add('dispatch', 'sw:' + nodeText(n.condition), n.condition, ctx.scope);
        // Statements before the first case are reachable only through labels.
        this.stmt(n.body, next, { ...ctx, brk: next, caseSink: sink });
        const dflt = sink.get('default');
        sink.delete('default');
        this.nodes[disp].cases = sink;
        this.nodes[disp].dflt = dflt ?? next;
        return disp;
      }
      case NodeKind.CaseStmt:
      case NodeKind.DefaultStmt: {
        const inner = (s as CaseStmt | DefaultStmt).statement;
        const key = s.kind === NodeKind.CaseStmt ? nodeText((s as CaseStmt).value) : 'default';
        const target = this.stmt(inner, next, ctx);
        const id = this.nop(target, s);
        const sink = ctx.caseSink ?? this.foreignCases;
        if (sink.has(key)) throw new Unsupported(`duplicate case ${key}`);
        sink.set(key, id);
        return id;
      }
      case NodeKind.LabelStmt: {
        const n = s as LabelStmt;
        const id = this.nop(this.stmt(n.statement, next, ctx), s);
        if (this.labels.has(n.label.name)) throw new Unsupported(`duplicate label ${n.label.name}`);
        this.labels.set(n.label.name, id);
        return id;
      }
      case NodeKind.GotoStmt: {
        const id = this.nop(-1, s);
        this.pendingGotos.push({ from: id, label: (s as GotoStmt).label.name });
        return id;
      }
      case NodeKind.ReturnStmt: {
        const v = (s as ReturnStmt).value;
        if (!v) return this.exit;
        const id = this.add('work', 'r:' + nodeText(v), s, ctx.scope);
        this.nodes[id].next = this.exit;
        return id;
      }
      case NodeKind.BreakStmt:
        return ctx.brk ?? this.external('break');
      case NodeKind.ContinueStmt:
        return ctx.cont ?? this.external('continue');
      default: {
        // An unknown statement is opaque work only if it holds no statements of its own:
        // anything with control flow inside it is beyond this model.
        for (const c of getChildren(s as ASTNode)) {
          if (/Stmt$/.test(String(c.kind))) throw new Unsupported(`statement kind ${s.kind}`);
        }
        const id = this.add('work', this.workKey(s), s, ctx.scope);
        this.nodes[id].next = next;
        return id;
      }
    }
  }
}

/** Lower `stmts` (one region) to a branch CFG. Throws `Unsupported`. */
export function buildBcfg(stmts: Statement[], opts: BcfgOptions = {}): Bcfg {
  const b = new Builder(opts);
  const first = b.seq(stmts, b.follow, { brk: null, cont: null, caseSink: null, scope: null });
  const entry = b.nop(first);
  b.nodes[entry].kind = 'entry';
  for (const g of b.pendingGotos) b.nodes[g.from].next = b.labels.get(g.label) ?? b.external('label:' + g.label);

  if (opts.haltException) {
    const resolve = resolver({ nodes: b.nodes, entry, namedEntries: new Map(), declNodes: b.declNodes });
    for (const n of b.nodes) {
      if (n.kind !== 'work' || !n.key.includes('#site') || !n.origin) continue;
      let cur = resolve(n.next), ok = isHaltStep(n.origin as Statement, opts.noreturn), steps = 0;
      while (ok && b.nodes[cur].kind === 'work' && steps++ < 8) {
        ok = isHaltStep(b.nodes[cur].origin as Statement, opts.noreturn);
        cur = resolve(b.nodes[cur].next);
      }
      if (ok && b.nodes[cur].kind === 'noreturn') n.key = n.key.replace(/#site.*$/, '');
    }
  }

  const namedEntries = new Map<string, number>();
  for (const [k, id] of b.foreignCases) namedEntries.set('case:' + k, id);
  const inside = new Map<string, number>();
  for (const g of b.pendingGotos) inside.set(g.label, (inside.get(g.label) ?? 0) + 1);
  const outer = opts.externalGotoCounts;
  for (const [name, id] of b.labels) {
    if (!outer || (outer.get(name) ?? 0) > (inside.get(name) ?? 0)) namedEntries.set('label:' + name, id);
  }
  return { nodes: b.nodes, entry, namedEntries, declNodes: b.declNodes };
}

/**
 * Follow scaffolding to the first node that does something. A cycle of scaffolding is an
 * empty infinite loop and resolves to the graph's `spin` node.
 *
 * A PURE test whose two edges lead to the same node is scaffolding too: evaluating an
 * expression with no side effect and then going the same way either way is the same
 * program as not evaluating it (`if (x) goto L; L:`). A test whose branch loops back to
 * itself is never contracted - `while (x) {}` is not `{}`.
 */
export function resolver(g: Bcfg): (id: number) => number {
  const memo = new Map<number, number>();
  const spin = g.nodes.find(n => n.kind === 'spin')!.id;
  const testing = new Set<number>();
  const resolve = (id: number): number => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const path: number[] = [];
    const onPath = new Set<number>();
    let cur = id;
    while (g.nodes[cur].kind === 'nop' || g.nodes[cur].kind === 'entry') {
      const m = memo.get(cur);
      if (m !== undefined) { cur = m; break; }
      if (onPath.has(cur)) { cur = spin; break; }
      onPath.add(cur);
      path.push(cur);
      cur = g.nodes[cur].next;
    }
    const n = g.nodes[cur];
    if (n.kind === 'test' && n.pure && !testing.has(cur) && !memo.has(cur)) {
      testing.add(cur);
      const a = resolve(n.t), b = resolve(n.f);
      testing.delete(cur);
      const r = a === b && a !== cur ? a : cur;
      memo.set(cur, r);
      cur = r;
    } else if (memo.has(cur)) {
      cur = memo.get(cur)!;
    }
    for (const p of path) memo.set(p, cur);
    return cur;
  };
  return resolve;
}

/**
 * No side effect: no call, no assignment, no increment or decrement, no `volatile`. A read
 * through a pointer is pure for this purpose - the compiler deletes an unused load just the
 * same, and the original only had the test because it branched on it.
 */
export function isPureExpr(e: ASTNode): boolean {
  const walk = (x: ASTNode): boolean => {
    if (!x || typeof x !== 'object') return true;
    switch (x.kind) {
      case NodeKind.CallExpr:
      case NodeKind.AssignExpr:
      case NodeKind.PostfixExpr:
        return false;
      case NodeKind.UnaryExpr: {
        const op = (x as unknown as { operator: string }).operator;
        if (op === '++' || op === '--') return false;
        break;
      }
      default:
        if (String(x.kind) === 'NewExpr' || String(x.kind) === 'DeleteExpr') return false;
    }
    if (String(x.kind).endsWith('Type')) {
      try { if (/\bvolatile\b/.test(emit(x as never))) return false; } catch { return false; }
      return true;
    }
    for (const c of getChildren(x)) if (!walk(c)) return false;
    return true;
  };
  return walk(e);
}

/** The identifiers an expression or statement READS or writes (not member names, not types). */
export function usedNames(n: ASTNode): Set<string> {
  const out = new Set<string>();
  const walk = (x: ASTNode): void => {
    if (!x || typeof x !== 'object') return;
    const k = String(x.kind);
    if (k.endsWith('Type') || x.kind === NodeKind.QualifiedId) return;
    if (x.kind === NodeKind.Identifier) { out.add((x as unknown as { name: string }).name); return; }
    if (x.kind === NodeKind.MemberExpr) { walk((x as unknown as { object: ASTNode }).object); return; }
    if (x.kind === NodeKind.VariableDecl) {
      const init = (x as unknown as VariableDecl).initializer;
      if (init) walk(init as ASTNode);
      return;
    }
    for (const c of getChildren(x)) walk(c);
  };
  walk(n);
  return out;
}

export function lookup(scope: Scope | null, name: string): DeclStmt | null {
  for (let s = scope; s; s = s.parent) if (s.name === name) return s.decl;
  return null;
}

/**
 * One step of the assert/halt sequence Ghidra shows for the halt macro: a constant line
 * number, the instruction-pointer read, a call to a halt routine, or the noreturn exit.
 */
export function isHaltStep(s: Statement | null, noreturn?: ReadonlySet<string>): boolean {
  if (!s || s.kind !== NodeKind.ExprStmt) return false;
  let e = stripParens((s as unknown as { expression: Expression }).expression);
  if (e.kind === NodeKind.AssignExpr) {
    let right = stripParens((e as unknown as { right: Expression }).right);
    if (isConstantExpr(right)) return true;
    // `p = (char*)GetInstructionPointer()` - Ghidra casts it to whatever the slot is typed.
    while (right.kind === NodeKind.CStyleCastExpr) right = stripParens((right as unknown as { expression: Expression }).expression);
    e = right;
  }
  const name = calleeName(e);
  if (name === null) return false;
  return name === 'GetInstructionPointer' || /Halt|FatalError|Assert/.test(name) || !!noreturn?.has(name);
}

function isConstantExpr(e: Expression): boolean {
  e = stripParens(e);
  if (e.kind === NodeKind.IntegerLiteral || e.kind === NodeKind.CharLiteral || e.kind === NodeKind.StringLiteral) return true;
  if (e.kind === NodeKind.UnaryExpr && (e as unknown as { operator: string }).operator === '-') {
    return isConstantExpr((e as unknown as { operand: Expression }).operand);
  }
  if (e.kind === NodeKind.CStyleCastExpr) return isConstantExpr((e as unknown as { expression: Expression }).expression);
  return false;
}
