/**
 * Record Getter Guard Plugin
 *
 * The data-table record getters (`SKILLS_GetSkillsTxtRecord` and its kind) are inlined
 * into their callers: a pointer that is the record when the index is in range and
 * NULL when it is not, tested and then read through. ITEM_GetTxtItemTypes_throwable
 * (0062ba80) is
 *
 *     imul eax, eax, 0xe4; add eax, [ecx + 0xbf8]; test eax, eax; je ...
 *     movzx eax, byte ptr [eax + 0x10]
 *
 * a TEST of the record pointer and a read through the very register it is in. The
 * decompiler prints the getter's three conditions as one guard and the read as a fresh
 * index, `if (n >= 0 && n < T->nSize && T->pTxt + n) { .. T->pTxt[n].f .. }`, which VC8
 * compiles with the table loaded first and no TEST. This pass gives the record its
 * local again:
 *
 *     D2ItemTypesTxt *pItemTypesTxt = n >= 0 && n < T->nSize ? T->pTxt + n : nullptr;
 *     if (pItemTypesTxt) { .. pItemTypesTxt->f .. }
 *
 * and the same under `!` with the reads after the guard. With the reads left as indexes
 * VC8 keeps its old code, so a guard none of whose reads can move is left as printed.
 *
 * The getter can also be one run of a longer chain: conditions before it, conditions
 * after it that read the record, an else-if arm, the index loaded by the chain itself as
 * `(i = e, i >= 0)` (SKILLS_GetUnitWalkVelocity 0056e5b0, AI_Monster_TryCastRateLimitedSkill
 * 005e5b70). The record is then declared before the statement and set where the getter ran:
 *
 *     T *p;
 *     .. else if (pre && (i = e, p = i >= 0 && i < T->nSize ? T->pTxt + i : nullptr) && post) { .. p->f .. }
 *
 * which VC8 compiles as the original: the record tested after the add and read through.
 * A trailing `&& true` is dropped first; it does not change the chain's value.
 *
 * Value-preserving by construction, made only when:
 *   - the guard is an `if` in a block whose condition (or its operand under `!`) is an
 *     `&&` chain holding `base + i`: `base` a member chain from a name (`T->pTxt`), a
 *     pointer whose type the declarations give, and `i` a local or parameter whose
 *     address is never taken; the range tests before it mention `i` and neither call nor
 *     write. The local holds `base + i` exactly when they are true, so testing it is
 *     testing them;
 *   - under `!` the guard has no else and its branch leaves (ends in return, goto or a
 *     halt), so the statements after it run only with the record in range;
 *   - a read `base[i]` (also `&base[i]`, `base[i].f`) or `base + i` becomes the local
 *     only up to the first statement that could change `base` or `i` or what `base`
 *     points at: a call (one call whose arguments neither call nor write still has its
 *     arguments rewritten, being evaluated before it runs), a write to `i`, to the name
 *     `base` starts from or to a member named as `base`'s last one, or a label;
 *   - no label, case or default follows the declaration in its block, but a case of a
 *     switch that lies there itself;
 *   - in a chain: the conditions after the getter run only when it held, so their reads
 *     go through the record up to one that calls or writes `i` or `base`, and the body's
 *     reads only when none of them does. The record is read nowhere the getter may not
 *     have run (not in the else branch, not past a label); a `!` chain must be the
 *     block's statement, not an else-if arm.
 *
 * Without a type for `base` nothing changes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, BinaryOperator, CallExpr, CompoundStmt, CStyleCastExpr, DeclStmt, Expression,
  ExprStmt, FunctionDecl, GotoStmt, Identifier, IfStmt, MemberExpr, ParameterDecl, ParenExpr,
  PostfixExpr, ReturnStmt, Statement, SubscriptExpr, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { Decl, Stmt, Expr, Type } from '../../../ast/factory.js';
import { createTransformer, updateNode, cloneNode, nodesEqual, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { calleeName, type TypedefResolver, type TypeShape } from './call-arg-cast.js';
import { createExprShape } from './expr-shape.js';
import { effectsOf } from './access-order-evidence.js';

export interface RecordGetterGuardOptions extends PluginOptions {
  functionReturnTypes?: Record<string, string>;
  globalTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  /** Type names a same-named namespace shadows: spelled `::Name`. */
  shadowedTypeNames?: string[];
  onSite?: (e: { line: number; name: string; reads: number; negated: boolean }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function pure(e: ASTNode): boolean {
  const f = effectsOf(e);
  return f.calls === 0 && f.writes === 0;
}

function conjuncts(e: Expression): Expression[] {
  const u = unwrap(e);
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '&&') {
    const b = u as BinaryExpr;
    return [...conjuncts(b.left), ...conjuncts(b.right)];
  }
  return [e];
}

/** `a->b->c` / `a.b` down to a name: the name and the last member; null for anything else. */
export function memberChain(e: Expression): { root: string; last: string } | null {
  e = unwrap(e);
  if (e.kind !== NodeKind.MemberExpr) return null;
  const m = e as MemberExpr;
  const member = m.member as { kind?: string; name?: unknown };
  if (member.kind !== NodeKind.Identifier || typeof member.name !== 'string') return null;
  let o = unwrap(m.object);
  while (o.kind === NodeKind.MemberExpr) o = unwrap((o as MemberExpr).object);
  // The table global is a name Ghidra prints qualified once it lives in a module
  // namespace (`D2Common::ITEMS::Items::sgptDataTable->pTxtSkills`); same root.
  const root = o.kind === NodeKind.Identifier ? (o as Identifier).name
    : o.kind === NodeKind.QualifiedId ? calleeName(o) : undefined;
  if (root === undefined) return null;
  return { root, last: member.name };
}

function mentions(e: ASTNode, name: string): boolean {
  for (const n of traverseAST(e)) if (n.kind === NodeKind.Identifier && (n as Identifier).name === name) return true;
  return false;
}

/**
 * Whether control can enter `stmts` other than from their start: a label, or a case or
 * default of a switch that does not itself lie in them.
 */
export function hasJumpTarget(stmts: Statement[]): boolean {
  const walk = (n: ASTNode): boolean => {
    if (n.kind === NodeKind.LabelStmt || n.kind === NodeKind.CaseStmt || n.kind === NodeKind.DefaultStmt) return true;
    if (n.kind === NodeKind.SwitchStmt) {
      for (const m of traverseAST(n)) if (m.kind === NodeKind.LabelStmt) return true;
      return false;
    }
    for (const k of getChildren(n)) if (walk(k)) return true;
    return false;
  };
  return stmts.some(walk);
}

/** Whether a statement list cannot fall off its end into what follows. */
function leaves(s: Statement): boolean {
  let last: Statement | undefined = s;
  while (last && last.kind === NodeKind.CompoundStmt) {
    const st = (last as CompoundStmt).statements;
    last = st[st.length - 1];
  }
  if (!last) return false;
  if (last.kind === NodeKind.ReturnStmt || last.kind === NodeKind.GotoStmt) return true;
  if (last.kind !== NodeKind.ExprStmt) return false;
  const e = unwrap((last as ExprStmt).expression);
  if (e.kind !== NodeKind.CallExpr) return false;
  const name = calleeName((e as CallExpr).callee) ?? '';
  const bare = name.split('::').pop() ?? '';
  return bare === 'exit' || bare === 'ExitProcess' || /_Halt$/.test(bare);
}

export interface Guard {
  base: Expression;
  index: Identifier;
  bounds: Expression[];
  root: string;
  last: string;
}

/**
 * Where the getter sits in an `&&` chain: the conditions before it, its own range tests
 * and `base + i`, the conditions after it. `seed` is `i = e` when the first range test
 * was printed as `(i = e, test)`.
 */
interface Run {
  g: Guard;
  pre: Expression[];
  post: Expression[];
  seed: AssignExpr | null;
}

function isCommaSeed(e: Expression, index: string): { seed: AssignExpr; test: Expression } | null {
  const u = unwrap(e);
  if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator as string !== ',') return null;
  const a = unwrap((u as BinaryExpr).left);
  const test = (u as BinaryExpr).right;
  if (a.kind !== NodeKind.AssignExpr || (a as AssignExpr).operator !== '=') return null;
  const l = unwrap((a as AssignExpr).left);
  if (l.kind !== NodeKind.Identifier || (l as Identifier).name !== index) return null;
  if (!pure((a as AssignExpr).right)) return null;
  if (!pure(test) || !mentions(test, index)) return null;
  return { seed: a as AssignExpr, test };
}

/**
 * The first `[bounds &&] base + i` run of the chain, with the bounds about `i`; null when
 * the condition has none.
 */
function runOf(cond: Expression, indexOk: (name: string) => boolean): Run | null {
  const parts = conjuncts(cond);
  for (let k = 1; k < parts.length; k++) {
    const sum = unwrap(parts[k]);
    if (sum.kind !== NodeKind.BinaryExpr || (sum as BinaryExpr).operator !== '+') continue;
    const base = (sum as BinaryExpr).left;
    const idx = unwrap((sum as BinaryExpr).right);
    if (idx.kind !== NodeKind.Identifier || !indexOk((idx as Identifier).name)) continue;
    const chain = memberChain(base);
    if (!chain || !pure(base)) continue;
    const index = idx as Identifier;
    let j = k;
    while (j > 0 && pure(parts[j - 1]) && mentions(parts[j - 1], index.name)) j--;
    let seed: AssignExpr | null = null;
    const bounds = parts.slice(j, k);
    if (j > 0) {
      const c = isCommaSeed(parts[j - 1], index.name);
      if (c) { seed = c.seed; bounds.unshift(c.test); j--; }
    }
    if (bounds.length === 0) continue;
    // `&& true` tests nothing: a chain's value is the same without it.
    const isTrue = (e: Expression) => { const u = unwrap(e); return u.kind === NodeKind.BoolLiteral && (u as unknown as { value: boolean }).value === true; };
    return {
      g: { base, index, bounds, root: chain.root, last: chain.last },
      pre: parts.slice(0, j), post: parts.slice(k + 1).filter(e => !isTrue(e)), seed,
    };
  }
  return null;
}

function isSum(e: ASTNode, g: Guard): boolean {
  if (e.kind !== NodeKind.BinaryExpr || (e as BinaryExpr).operator !== '+') return false;
  const b = e as BinaryExpr;
  return nodesEqual(unwrap(b.left), unwrap(g.base)) && nodesEqual(unwrap(b.right), g.index);
}

function isIndex(e: ASTNode, g: Guard): boolean {
  if (e.kind !== NodeKind.SubscriptExpr) return false;
  const s = e as SubscriptExpr;
  return nodesEqual(unwrap(s.array), unwrap(g.base)) && nodesEqual(unwrap(s.index), g.index);
}

/** Rewrite every read of the record in `n` (mutating) to go through `name`; the count. */
function substitute(n: ASTNode, g: Guard, name: string): number {
  let count = 0;
  const rewrite = (e: ASTNode): ASTNode | null => {
    const u = e.kind === NodeKind.ParenExpr ? unwrap(e as Expression) : e;
    if (isSum(u, g)) { count++; return Expr.identifier(name); }
    if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '&' && isIndex(unwrap((u as UnaryExpr).operand), g)) {
      count++;
      return Expr.identifier(name);
    }
    if (u.kind === NodeKind.MemberExpr && !(u as MemberExpr).isArrow && isIndex(unwrap((u as MemberExpr).object), g)) {
      count++;
      const m = u as MemberExpr;
      return { ...m, object: Expr.identifier(name), isArrow: true } as MemberExpr;
    }
    if (isIndex(u, g)) { count++; return Expr.deref(Expr.identifier(name)); }
    return null;
  };
  const walk = (node: ASTNode): void => {
    const rec = node as unknown as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia' || key === 'ghidraInfo') continue;
      const v = rec[key];
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const c = v[i];
          if (!c || typeof c !== 'object' || typeof (c as ASTNode).kind !== 'string') continue;
          const r = rewrite(c as ASTNode);
          if (r) v[i] = r; else walk(c as ASTNode);
        }
      } else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') {
        const r = rewrite(v as ASTNode);
        if (r) rec[key] = r; else walk(v as ASTNode);
      }
    }
  };
  walk(n);
  return count;
}

function countReads(n: ASTNode, g: Guard): number {
  let c = 0;
  for (const m of traverseAST(n)) if (isSum(m, g) || isIndex(m, g)) c++;
  return c;
}

/** Whether `n` writes `i`, the name `base` starts from, or a member named as `base`'s last. */
function clobbers(n: ASTNode, g: Guard): boolean {
  const target = (lhs: Expression): boolean => {
    const u = unwrap(lhs);
    if (u.kind === NodeKind.Identifier) {
      const name = (u as Identifier).name;
      return name === g.index.name || name === g.root;
    }
    if (u.kind === NodeKind.QualifiedId) return calleeName(u) === g.root;
    if (u.kind === NodeKind.MemberExpr) {
      const m = (u as MemberExpr).member as { name?: unknown };
      return m.name === g.last;
    }
    return false;
  };
  for (const m of traverseAST(n)) {
    if (m.kind === NodeKind.AssignExpr && target((m as AssignExpr).left)) return true;
    if (m.kind === NodeKind.PostfixExpr && target((m as PostfixExpr).operand)) return true;
    if (m.kind === NodeKind.UnaryExpr) {
      const u = m as UnaryExpr;
      if ((u.operator === '++' || u.operator === '--') && target(u.operand)) return true;
    }
  }
  return false;
}

/** The call a statement makes as its whole value: `f(..);`, `x = f(..);`, `T x = f(..);`, `return f(..);`. */
function topCall(s: Statement): CallExpr | null {
  let e: Expression | null = null;
  if (s.kind === NodeKind.ExprStmt) {
    e = unwrap((s as ExprStmt).expression);
    if (e.kind === NodeKind.AssignExpr) {
      const a = e as AssignExpr;
      if (a.operator !== '=' || unwrap(a.left).kind !== NodeKind.Identifier) return null;
      e = a.right;
    }
  } else if (s.kind === NodeKind.DeclStmt) {
    const d = (s as DeclStmt).declarations;
    if (d.length !== 1 || d[0].kind !== NodeKind.VariableDecl) return null;
    const v = d[0] as VariableDecl;
    if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr) return null;
    e = v.initializer as Expression;
  } else if (s.kind === NodeKind.ReturnStmt) {
    e = (s as ReturnStmt).value ?? null;
  }
  if (!e) return null;
  e = unwrap(e);
  while (e.kind === NodeKind.CStyleCastExpr) e = unwrap((e as CStyleCastExpr).expression);
  return e.kind === NodeKind.CallExpr ? e as CallExpr : null;
}

/**
 * Route the reads of `stmts` through `name`, in order, up to what may change the record
 * (see the header). Returns the number of reads routed.
 */
export function routeReads(stmts: Statement[], g: Guard, name: string, dryRun: boolean): number {
  let routed = 0;
  for (const s of stmts) {
    if (s.kind === NodeKind.LabelStmt || s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) break;
    if (clobbers(s, g)) {
      // `i = base[i].f;`: the value is read before the store.
      const e = s.kind === NodeKind.ExprStmt ? unwrap((s as ExprStmt).expression) : null;
      if (e && e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '='
        && unwrap((e as AssignExpr).left).kind === NodeKind.Identifier && pure((e as AssignExpr).right)) {
        const a = e as AssignExpr;
        if (dryRun) routed += countReads(a.right, g);
        else {
          const holder = { kind: NodeKind.ParenExpr, expression: a.right } as unknown as ParenExpr;
          routed += substitute(holder, g, name);
          (a as { right: Expression }).right = holder.expression;
        }
      }
      break;
    }
    const fx = effectsOf(s);
    if (fx.calls === 0) {
      routed += dryRun ? countReads(s, g) : substitute(s, g, name);
      continue;
    }
    const call = topCall(s);
    if (call && effectsOf(call).calls === 1 && call.arguments.every(a => pure(a))) {
      for (let i = 0; i < call.arguments.length; i++) {
        if (dryRun) { routed += countReads(call.arguments[i], g); continue; }
        const holder = { kind: NodeKind.ParenExpr, expression: call.arguments[i] } as unknown as ParenExpr;
        routed += substitute(holder, g, name);
        call.arguments[i] = holder.expression;
      }
    }
    break;
  }
  return routed;
}

export function typeOfShape(shape: TypeShape, shadowed: Set<string>): TypeNode {
  let t: TypeNode = Type.typedefAt(shape.base, shadowed.has(shape.base));
  for (let i = 0; i < shape.stars; i++) t = Type.pointer(t);
  return t;
}

export function recordName(last: string): string {
  const m = /^pTxt([A-Z]\w*)$/.exec(last);
  if (m) return `p${m[1]}Txt`;
  const p = /^p([A-Z]\w*)$/.exec(last);
  return p ? `p${p[1]}Record` : `p${last[0].toUpperCase()}${last.slice(1)}Record`;
}

function rewriteFunction(fn: FunctionDecl, opts: RecordGetterGuardOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const body = cloneNode(fn.body);
  const typedefTargets = opts.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  const localTypes = new Map<string, TypeNode>();
  const counts = new Map<string, number>();
  for (const p of fn.parameters as ParameterDecl[]) {
    const n = (p as unknown as { name?: Identifier | null }).name;
    if (n && n.kind === NodeKind.Identifier) {
      localTypes.set(n.name, (p as unknown as VariableDecl).type);
      counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
    }
  }
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      localTypes.set(v.name.name, v.type);
      counts.set(v.name.name, (counts.get(v.name.name) ?? 0) + 1);
    }
  }
  const addressed = new Set<string>();
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      for (const m of traverseAST((n as UnaryExpr).operand)) {
        if (m.kind === NodeKind.Identifier) addressed.add((m as Identifier).name);
      }
    }
  }
  const indexOk = (name: string) => counts.get(name) === 1 && !addressed.has(name);
  const shapeOf = createExprShape(localTypes, {
    globalTypes: opts.globalTypes, enclosingVarTypes: opts.enclosingVarTypes, structFields: opts.structFields,
    fieldTypes: opts.fieldTypes, returnTypes: opts.functionReturnTypes, resolve,
  });
  const shadowed = new Set(opts.shadowedTypeNames ?? []);
  const members = new Set<ASTNode>();
  for (const n of traverseAST(fn)) if (n.kind === NodeKind.MemberExpr) members.add((n as MemberExpr).member);
  const taken = new Set<string>();
  for (const n of traverseAST(fn)) if (n.kind === NodeKind.Identifier && !members.has(n)) taken.add((n as Identifier).name);
  const fresh = (want: string): string => {
    let name = want;
    for (let i = 2; taken.has(name); i++) name = `${want}${i}`;
    taken.add(name);
    return name;
  };

  let changed = 0;
  /**
   * One `if` of a block, `top` when it is the block's statement and not an else-if arm.
   * Returns the declaration to place before the block's statement, or null.
   */
  const tryIf = (ifs: IfStmt, top: boolean, block: CompoundStmt, b: number): DeclStmt | null => {
    if (ifs.init) return null;
    let cond = unwrap(ifs.condition);
    const negated = cond.kind === NodeKind.UnaryExpr && (cond as UnaryExpr).operator === '!';
    if (negated) cond = unwrap((cond as UnaryExpr).operand);
    const run = runOf(cond, indexOk);
    if (!run) return null;
    const g = run.g;
    const shape = shapeOf(unwrap(g.base));
    if (!shape || shape.stars !== 1 || shape.isConst || shape.base === 'void') return null;
    if (hasJumpTarget(block.statements.slice(b + 1))) return null;
    // The plain guard: the whole condition is the getter, the if a statement of the block.
    const plain = top && run.pre.length === 0 && run.post.length === 0 && !run.seed;
    // Conditions after the getter run only when it held; the body only when they all did,
    // so the body's reads go through the record only if none of them can change it.
    const postClean = run.post.every(p => effectsOf(p).calls === 0 && !clobbers(p, g));
    let reads: Statement[] = [];
    if (negated) {
      if (!top || ifs.elseBranch || !leaves(ifs.thenBranch)) return null;
      if (postClean) reads = block.statements.slice(b + 1);
    } else if (postClean) {
      reads = ifs.thenBranch.kind === NodeKind.CompoundStmt
        ? (ifs.thenBranch as CompoundStmt).statements : [ifs.thenBranch];
    }
    if (!plain && hasJumpTarget(reads)) return null;
    // The reads in the conditions after the getter, in order, up to one that may change it.
    const postReads = (dryRun: boolean, name: string): number => {
      let n = 0;
      for (let i = 0; i < run.post.length; i++) {
        const p = run.post[i];
        if (effectsOf(p).calls !== 0 || clobbers(p, g)) break;
        if (dryRun) { n += countReads(p, g); continue; }
        const holder = { kind: NodeKind.ParenExpr, expression: p } as unknown as ParenExpr;
        n += substitute(holder, g, name);
        run.post[i] = holder.expression;
      }
      return n;
    };
    if (routeReads(reads, g, '', true) + postReads(true, '') === 0) return null;
    const name = fresh(recordName(g.last));
    const routed = routeReads(reads, g, name, false) + postReads(false, name);
    const sum = Expr.binary(cloneNode(g.base), '+', cloneNode(g.index));
    const test = g.bounds.map(x => cloneNode(x)).reduce((l, r) => Expr.binary(l, '&&', r));
    const value = Expr.conditional(test, sum, Expr.nullptr());
    const id = Expr.identifier(name);
    const type = typeOfShape(shape, shadowed);
    let out: DeclStmt;
    if (plain) {
      out = Stmt.declStmt([Decl.variable(name, type, value)]);
      (ifs as { condition: Expression }).condition = negated ? Expr.not(id) : id;
    } else {
      // The record is set where the getter ran: `pre && (p = getter) && post`, its
      // declaration before the statement. `p` is read only where the getter has run.
      out = Stmt.declStmt([Decl.variable(name, type)]);
      let at: Expression = Expr.assign(Expr.identifier(name), value);
      if (run.seed) {
        at = Expr.binary(cloneNode(run.seed), ',' as BinaryOperator, at);
      }
      const chain = [...run.pre, Expr.paren(at), ...run.post].reduce((l, r) => Expr.binary(l, '&&', r));
      (ifs as { condition: Expression }).condition = negated ? Expr.not(Expr.paren(chain)) : chain;
    }
    changed++;
    opts.onSite?.({ line: ifs.location?.start.line ?? 0, name, reads: routed, negated });
    return out;
  };
  const visitBlock = (block: CompoundStmt): void => {
    for (let b = 0; b < block.statements.length; b++) {
      const s = block.statements[b];
      for (const k of getChildren(s)) visitAll(k);
      if (s.kind !== NodeKind.IfStmt) continue;
      const decls: DeclStmt[] = [];
      for (let c: IfStmt | null = s as IfStmt, top = true; c; top = false) {
        const d = tryIf(c, top, block, b);
        if (d) decls.push(d);
        c = c.elseBranch && c.elseBranch.kind === NodeKind.IfStmt ? c.elseBranch as IfStmt : null;
      }
      if (decls.length === 0) continue;
      decls[0].location = s.location;
      decls[0].leadingTrivia = s.leadingTrivia;
      for (const d of decls.slice(1)) d.location = s.location;
      s.leadingTrivia = [];
      block.statements.splice(b, 0, ...decls);
      b += decls.length;
    }
  };
  const visitAll = (n: ASTNode): void => {
    if (n.kind === NodeKind.CompoundStmt) { visitBlock(n as CompoundStmt); return; }
    for (const k of getChildren(n)) visitAll(k);
  };
  visitAll(body);
  if (!changed) return undefined;
  return updateNode(fn, { body } as Partial<FunctionDecl>);
}

function createRecordGetterGuardTransformer(options: RecordGetterGuardOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  });
}

export const recordGetterGuardPlugin: TransformPlugin = {
  id: 'record-getter-guard',
  name: 'Record Getter Guard',
  description:
    'Gives an inlined record getter its pointer local again: tested, and read through where the original reads it',
  version: '1.0.0',
  defaultEnabled: true,
  // After early-return (60) has set which guards are `!`-guards and after
  // decl-init-merge (60); before decl-order-fix (61) and decl-scope-sink (62).
  priority: 60.5,
  tags: ['matching'],
  createTransformer: createRecordGetterGuardTransformer,
};
