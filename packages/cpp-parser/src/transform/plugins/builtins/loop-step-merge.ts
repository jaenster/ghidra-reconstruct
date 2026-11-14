/**
 * Loop Step Merge Plugin
 *
 * A loop that steps one running variable by a constant is printed by the decompiler with the
 * variable split in two wherever the step's old and new values live in different registers:
 * a copy at the top of the body that the rest of the body reads, and the step at the bottom
 * computed from the copy. NET_SID_CLIENT_IDEACrypt (00524540) as printed:
 *
 *   do {
 *     pRoundKey = pSubkeys;                  <- the copy
 *     ... pRoundKey[0], pRoundKey[1] ...
 *     pSubkeys = pRoundKey + 6;              <- the step, from the copy
 *   } while (...);
 *
 * Both names are live across the body, so VC8 needs a register more than the original and
 * homes one of them in the frame. The source had one variable:
 *
 *   do {
 *     ... pSubkeys[0], pSubkeys[1] ...
 *     pSubkeys = pSubkeys + 6;
 *   } while (...);
 *
 * The mirror form steps first and copies back at the bottom (a vertex loop's `pNext = pVertex +
 * 1; ... pVertex = pNext;`): the step moves down to the copy, which goes.
 *
 * Merged only on a proof, for two statements S1 before S2 directly in one loop body:
 *  - (copy form)  S1 `q = p;` and S2 `p = q + K;` (or `- K`), K an integer literal;
 *    (step form)  S1 `q = p + K;` and S2 `p = q;`;
 *    S1 may be the declaration `T q = ...;`.
 *  - p and q are distinct locals or parameters of one emitted type, each declared once,
 *    neither's address taken, so no call or store through a pointer reaches them;
 *  - no path from S1 to S2 writes p or q;
 *  - every read of the value S1 gives q is in a statement after S1 up to S2 in the body, sees
 *    only S1's definition, and no write of p lies on any path from S1 to it: q equals p
 *    (copy form) or p's stepped value (step form) at every such read;
 *  - step form only: q's one read is the copy back, which becomes the step;
 *  - copy form: a read of q after S2 (seeing S1's value, with no write of p since S2) is
 *    `q[c]` or `*q` and reads through p as `p[c - K]`;
 *  - a declaration S1 goes only when nothing after S2 in the body names q.
 * Each read of q then reads p, which holds the same value there, and p ends the body with the
 * value it had.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, AssignExpr, BinaryExpr, CompoundStmt, DeclStmt, DoWhileStmt, ExprStmt, Expression, ForStmt,
  FunctionDecl, Identifier, IntegerLiteralExpr, MemberExpr, ParameterDecl, Statement, SubscriptExpr, TypeNode, UnaryExpr,
  VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { buildFunctionFlow, type FunctionFlow } from '../../cfg/index.js';

type Loop = WhileStmt | DoWhileStmt | ForStmt;

function unwrap(e: Expression): Expression {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as unknown as { expression: Expression }).expression;
  return x;
}

/** The declared type of every local and parameter declared exactly once, by name. */
function declaredTypes(fn: FunctionDecl): Map<string, TypeNode> {
  const out = new Map<string, TypeNode>();
  const bad = new Set<string>();
  const add = (name: string, t: TypeNode) => {
    if (out.has(name)) bad.add(name);
    out.set(name, t);
  };
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) add(p.name.name, p.type);
  for (const x of traverseAST(fn.body!)) {
    if (x.kind !== NodeKind.VariableDecl) continue;
    const v = x as VariableDecl;
    if (v.specifiers.length > 0 || v.bitWidth || v.directInit || v.copyListInit) bad.add(v.name.name);
    add(v.name.name, v.type);
  }
  for (const [n, t] of out) {
    const k = (t as unknown as { kind: NodeKind }).kind;
    if (k === NodeKind.ReferenceType || k === NodeKind.RValueReferenceType || k === NodeKind.ArrayType) bad.add(n);
    if (/\bvolatile\b/.test(emit(t as unknown as AnyNode))) bad.add(n);
  }
  for (const n of bad) out.delete(n);
  return out;
}

/** Control the statement graph does not model, or a frame position named by offset. */
function unmodelled(fn: FunctionDecl): boolean {
  for (const x of traverseAST(fn.body!)) {
    if (x.kind === NodeKind.TryStmt || x.kind === NodeKind.SehTryStmt || x.kind === NodeKind.AsmDecl) return true;
    if (x.kind === NodeKind.Identifier) {
      const n = (x as Identifier).name;
      if (n === 'ExceptionList' || /^_?setjmp|^__asm|^_asm$|^stack0x|^in_stack_/.test(n)) return true;
    }
  }
  return false;
}

interface Assign {
  /** The variable written. */
  l: string;
  /** The variable read. */
  r: string;
  /** `+ K` / `- K` on the read, or null for a plain copy. */
  step: { op: '+' | '-'; k: IntegerLiteralExpr } | null;
  decl: boolean;
}

/** `l = r;`, `l = r + K;`, `l = r - K;` or the declaration `T l = ...;` of one of them. */
function assignOf(s: Statement): Assign | null {
  let l: Expression | null = null, r: Expression | null = null, decl = false;
  if (s.kind === NodeKind.ExprStmt) {
    const e = unwrap((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    l = unwrap((e as AssignExpr).left); r = unwrap((e as AssignExpr).right);
  } else if (s.kind === NodeKind.DeclStmt) {
    const ds = (s as DeclStmt).declarations;
    if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return null;
    const v = ds[0] as VariableDecl;
    if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr) return null;
    l = v.name as unknown as Expression; r = unwrap(v.initializer as Expression); decl = true;
  } else return null;
  if (l.kind !== NodeKind.Identifier) return null;
  const ln = (l as Identifier).name;
  if (r.kind === NodeKind.Identifier) return (r as Identifier).name === ln ? null : { l: ln, r: (r as Identifier).name, step: null, decl };
  if (r.kind === NodeKind.BinaryExpr && ((r as BinaryExpr).operator === '+' || (r as BinaryExpr).operator === '-')) {
    const a = unwrap((r as BinaryExpr).left), k = unwrap((r as BinaryExpr).right);
    if (a.kind !== NodeKind.Identifier || k.kind !== NodeKind.IntegerLiteral || (a as Identifier).name === ln) return null;
    return { l: ln, r: (a as Identifier).name, step: { op: (r as BinaryExpr).operator as '+' | '-', k: k as IntegerLiteralExpr }, decl };
  }
  return null;
}

function names(n: ASTNode | null | undefined, v: string): boolean {
  if (!n) return false;
  for (const x of traverseAST(n)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === v) return true;
  return false;
}

/** The graph nodes of every statement inside `stmts`, nested ones included. */
function nodesIn(stmts: Statement[], flow: FunctionFlow): Set<number> {
  const out = new Set<number>();
  for (const s of stmts) {
    for (const x of traverseAST(s)) {
      const id = flow.nodeOf(x as Statement);
      if (id !== undefined) out.add(id);
    }
  }
  return out;
}

/** `n` with the variable `from` renamed; a member named like it is a field and keeps its name. */
function rename<T extends ASTNode>(n: T, from: string, to: string): T {
  const walk = (x: ASTNode): ASTNode => {
    if (x.kind === NodeKind.Identifier) return (x as Identifier).name === from ? { ...x, name: to } as ASTNode : x;
    if (x.kind === NodeKind.MemberExpr) {
      const m = x as MemberExpr;
      const o = walk(m.object as ASTNode) as Expression;
      return o === m.object ? x : { ...m, object: o } as ASTNode;
    }
    let changed = false;
    const copy: Record<string, unknown> = { ...x };
    for (const [k, v] of Object.entries(x)) {
      if (k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if ((x.kind === NodeKind.LabelStmt || x.kind === NodeKind.GotoStmt) && k === 'label') continue;
      if (Array.isArray(v)) {
        const arr = v.map(y => (y && typeof y === 'object' && 'kind' in y) ? walk(y as ASTNode) : y);
        if (arr.some((y, i) => y !== v[i])) { copy[k] = arr; changed = true; }
      } else if (v && typeof v === 'object' && 'kind' in v) {
        const y = walk(v as ASTNode);
        if (y !== v) { copy[k] = y; changed = true; }
      }
    }
    return changed ? copy as unknown as ASTNode : x;
  };
  return walk(n) as T;
}

/**
 * `s` with every read of q, known to hold p - K (p - (-K)), written through p: `q[c]` as
 * `p[c - K]`, `*q` as `p[-K]`. Null when q appears in any other form.
 */
function offsetReads(s: Statement, q: string, p: string, step: NonNullable<Assign['step']>): Statement | null {
  const k = BigInt((step.k as unknown as { value: string | number | bigint }).value) * (step.op === '+' ? 1n : -1n);
  let bad = false;
  const lit = (v: bigint): Expression => (v < 0n
    ? Expr.unary('-', Expr.intLiteral(-v) as Expression) as Expression
    : Expr.intLiteral(v) as Expression);
  const walk = (x: ASTNode): ASTNode => {
    if (x.kind === NodeKind.Identifier) { if ((x as Identifier).name === q) bad = true; return x; }
    if (x.kind === NodeKind.SubscriptExpr) {
      const a = unwrap((x as SubscriptExpr).array), ix = unwrap((x as SubscriptExpr).index);
      if (a.kind === NodeKind.Identifier && (a as Identifier).name === q) {
        if (ix.kind !== NodeKind.IntegerLiteral) { bad = true; return x; }
        const c = BigInt((ix as unknown as { value: string | number | bigint }).value);
        return { ...x, array: Expr.identifier(p), index: lit(c - k) } as ASTNode;
      }
    }
    if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') {
      const o = unwrap((x as UnaryExpr).operand);
      if (o.kind === NodeKind.Identifier && (o as Identifier).name === q) return Expr.subscript(Expr.identifier(p), lit(-k)) as ASTNode;
    }
    if (x.kind === NodeKind.MemberExpr) {
      const m = x as MemberExpr;
      const o = walk(m.object as ASTNode) as Expression;
      return o === m.object ? x : { ...m, object: o } as ASTNode;
    }
    let changed = false;
    const copy: Record<string, unknown> = { ...x };
    for (const [key, v] of Object.entries(x)) {
      if (key === 'leadingTrivia' || key === 'trailingTrivia') continue;
      if ((x.kind === NodeKind.LabelStmt || x.kind === NodeKind.GotoStmt) && key === 'label') continue;
      if (Array.isArray(v)) {
        const arr = v.map(y => (y && typeof y === 'object' && 'kind' in y) ? walk(y as ASTNode) : y);
        if (arr.some((y, n) => y !== v[n])) { copy[key] = arr; changed = true; }
      } else if (v && typeof v === 'object' && 'kind' in v) {
        const y = walk(v as ASTNode);
        if (y !== v) { copy[key] = y; changed = true; }
      }
    }
    return changed ? copy as unknown as ASTNode : x;
  };
  const out = walk(s) as Statement;
  return bad ? null : out;
}

interface Ctx {
  fn: FunctionDecl;
  types: Map<string, TypeNode>;
  flow: FunctionFlow | null;
}

function flowOf(ctx: Ctx): FunctionFlow {
  if (!ctx.flow) {
    const pointers = new Set<string>();
    for (const [n, t] of ctx.types) if ((t as unknown as { kind: NodeKind }).kind === NodeKind.PointerType) pointers.add(n);
    ctx.flow = buildFunctionFlow(ctx.fn.body!.statements, new Set(ctx.types.keys()), { shortCircuitConditions: true, pointers });
  }
  return ctx.flow;
}

/** The step `p = p op K` S2 or S1 becomes, keeping the statement's trivia. */
function stepStmt(at: Statement, p: string, step: NonNullable<Assign['step']>): Statement {
  const e = Expr.assign(Expr.identifier(p), Expr.binary(Expr.identifier(p), step.op, cloneNode(step.k) as Expression));
  return { ...Stmt.expr(e), location: at.location, leadingTrivia: at.leadingTrivia ?? [], trailingTrivia: at.trailingTrivia ?? [] } as Statement;
}

/** The loop's body with one split variable merged, or null when none can be. */
function mergeIn(loop: Loop, ctx: Ctx): { body: Statement[]; gone: string } | null {
  if (loop.body.kind !== NodeKind.CompoundStmt) return null;
  const list = (loop.body as CompoundStmt).statements;
  for (let i = 0; i < list.length - 1; i++) {
    const s1 = assignOf(list[i]);
    if (!s1) continue;
    for (let j = i + 1; j < list.length; j++) {
      const s2 = assignOf(list[j]);
      if (!s2 || s2.decl || s2.l !== s1.r || s2.r !== s1.l) continue;
      const copyForm = s1.step === null && s2.step !== null;
      const stepForm = s1.step !== null && s2.step === null;
      if (!copyForm && !stepForm) continue;
      const q = s1.l, p = s1.r;
      const tq = ctx.types.get(q), tp = ctx.types.get(p);
      if (!tq || !tp || emit(tq as unknown as AnyNode) !== emit(tp as unknown as AnyNode)) break;
      const flow = flowOf(ctx);
      if (flow.isEscaped(p) || flow.isEscaped(q)) break;
      const n1 = flow.nodeOf(list[i]), n2 = flow.nodeOf(list[j]);
      if (n1 === undefined || n2 === undefined) break;
      if (flow.writtenBetween(n1, n2, [p, q])) break;
      const span = nodesIn(list.slice(i + 1, j + 1), flow);
      const post = list.slice(j + 1);
      const postNodes = nodesIn(post, flow);
      const uses = flow.usesOf(n1, q);
      if (!uses.includes(n2)) break;
      let ok = true;
      const postUses: number[] = [];
      for (const u of uses) {
        const r = flow.reaching(u, q);
        if (r.size !== 1 || !r.has(n1)) { ok = false; break; }
        if (span.has(u)) {
          if (u !== n2 && (flow.writtenBetween(n1, u, [p]) || flow.writes(u).has(p))) { ok = false; break; }
        } else if (copyForm && postNodes.has(u)) {
          // After the step p holds q + K: a read of q there is p - K, while p is not written again.
          if (flow.writtenBetween(n2, u, [p]) || flow.writes(u).has(p)) { ok = false; break; }
          postUses.push(u);
        } else { ok = false; break; }
      }
      if (!ok) break;
      // Every read of q in the span is one of those, and nothing in it writes q.
      if ([...span].some(id => flow.writes(id).has(q) || flow.reads(id).has(q) && !uses.includes(id))) break;
      let rest = post;
      if (postUses.length) {
        if ([...postNodes].some(id => flow.writes(id).has(q) || flow.reads(id).has(q) && !postUses.includes(id))) break;
        const conv = post.map(s => offsetReads(s, q, p, s2.step!));
        if (conv.some(s => s === null)) break;
        rest = conv as Statement[];
      } else if (s1.decl && post.some(s => names(s, q))) break;
      const mid = list.slice(i + 1, j).map(s => rename(s, q, p));
      if (copyForm) return { body: [...list.slice(0, i), ...mid, stepStmt(list[j], p, s2.step!), ...rest], gone: q };
      // Step form: q is read only by the copy back, so the step goes where the copy was. (Moving
      // the step up to S1 instead, for a q read between, costs AllocMonsterRegion 005479c0.)
      if (uses.length !== 1) break;
      return { body: [...list.slice(0, i), ...mid, stepStmt(list[j], p, s1.step!), ...rest], gone: q };
    }
  }
  return null;
}

/** `root` with `target` replaced, rebuilding only the nodes on the path to it. */
function replaceNode(root: ASTNode, target: ASTNode, replacement: ASTNode): ASTNode {
  if (root === target) return replacement;
  for (const [k, v] of Object.entries(root)) {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        if (!x || typeof x !== 'object' || !('kind' in x)) continue;
        const y = replaceNode(x as ASTNode, target, replacement);
        if (y !== x) {
          const arr = v.slice();
          arr[i] = y;
          return { ...root, [k]: arr } as ASTNode;
        }
      }
    } else if (v && typeof v === 'object' && 'kind' in v) {
      const y = replaceNode(v as ASTNode, target, replacement);
      if (y !== v) return { ...root, [k]: y } as ASTNode;
    }
  }
  return root;
}

/** The function body without the declaration of `v` once nothing else names it. */
function dropUnusedDecl(fn: FunctionDecl, v: string): FunctionDecl {
  let mentioned = false;
  let declStmt: DeclStmt | null = null;
  const declNames = new Set<ASTNode>();
  for (const x of traverseAST(fn.body!)) if (x.kind === NodeKind.VariableDecl) declNames.add((x as VariableDecl).name as unknown as ASTNode);
  for (const x of traverseAST(fn.body!)) {
    if (x.kind === NodeKind.Identifier && (x as Identifier).name === v && !declNames.has(x)) mentioned = true;
    if (x.kind === NodeKind.DeclStmt) {
      const ds = (x as DeclStmt).declarations;
      if (ds.length === 1 && ds[0].kind === NodeKind.VariableDecl && (ds[0] as VariableDecl).name.name === v && !(ds[0] as VariableDecl).initializer) declStmt = x as DeclStmt;
    }
  }
  if (mentioned || !declStmt) return fn;
  const drop = (n: ASTNode): ASTNode => {
    if (n.kind === NodeKind.CompoundStmt) {
      const st = (n as CompoundStmt).statements;
      const k = st.indexOf(declStmt as unknown as Statement);
      if (k >= 0) return { ...n, statements: [...st.slice(0, k), ...st.slice(k + 1)] } as ASTNode;
    }
    for (const [key, val] of Object.entries(n)) {
      if (key === 'leadingTrivia' || key === 'trailingTrivia') continue;
      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          const x = val[i];
          if (!x || typeof x !== 'object' || !('kind' in x)) continue;
          const y = drop(x as ASTNode);
          if (y !== x) { const arr = val.slice(); arr[i] = y; return { ...n, [key]: arr } as ASTNode; }
        }
      } else if (val && typeof val === 'object' && 'kind' in val) {
        const y = drop(val as ASTNode);
        if (y !== val) return { ...n, [key]: y } as ASTNode;
      }
    }
    return n;
  };
  return updateNode(fn, { body: drop(fn.body!) as CompoundStmt } as Partial<FunctionDecl>);
}

function rewriteFunction(fn: FunctionDecl): FunctionDecl | undefined {
  if (!fn.body || unmodelled(fn)) return undefined;
  const ctx: Ctx = { fn, types: declaredTypes(fn), flow: null };
  if (ctx.types.size < 2) return undefined;
  let changed = false;
  // One site per round: each merge changes the graph the next proof reads.
  for (let round = 0; round < 32; round++) {
    let site: { loop: Loop; body: Statement[]; gone: string } | null = null;
    for (const x of traverseAST(ctx.fn.body!)) {
      if (x.kind !== NodeKind.WhileStmt && x.kind !== NodeKind.DoWhileStmt && x.kind !== NodeKind.ForStmt) continue;
      const out = mergeIn(x as Loop, ctx);
      if (out) { site = { loop: x as Loop, ...out }; break; }
    }
    if (!site) break;
    const loop = updateNode(site.loop, {
      body: updateNode(site.loop.body as CompoundStmt, { statements: site.body } as Partial<CompoundStmt>),
    } as Partial<Loop>);
    const body = replaceNode(ctx.fn.body!, site.loop, loop) as CompoundStmt;
    ctx.fn = updateNode(ctx.fn, { body } as Partial<FunctionDecl>);
    ctx.fn = dropUnusedDecl(ctx.fn, site.gone);
    ctx.types = declaredTypes(ctx.fn);
    ctx.flow = null;
    changed = true;
  }
  return changed ? ctx.fn : undefined;
}

function createLoopStepMergeTransformer(_options: PluginOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node);
    },
  });
}

export const loopStepMergePlugin: TransformPlugin = {
  id: 'loop-step-merge',
  name: 'Loop Step Merge',
  description: 'A running loop variable the decompiler split into a copy and a step from the copy is one variable again, on a dataflow proof',
  version: '1.0.0',
  defaultEnabled: true,
  // After loop-copy-sink (62.7), which puts a loop-carried copy at the end of the body.
  priority: 62.72,
  tags: ['matching'],
  createTransformer: createLoopStepMergeTransformer,
};

export { createLoopStepMergeTransformer };
