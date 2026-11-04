/**
 * Register Store Select Plugin
 *
 * A store whose value the source merged on two paths, printed as one store per path:
 *
 *     if (nClassId >= 0 && nClassId < sgptDataTable->nTxtMonStatsSize) {
 *       pDVar1->pMonStatsTxt = sgptDataTable->pTxtMonStats + nClassId;
 *       return;
 *     }
 *     pDVar1->pMonStatsTxt = 0;
 *
 * VC8 compiles `p->x = c ? E : 0` with the store copied into each tail, and the constant
 * reaches its copy in the register the merged value lives in: `xor eax, eax; mov [esi], eax`.
 * A store of its own is an immediate, `mov dword ptr [esi], 0`. The decompiler prints both
 * the same; extract/register-stores.ts records, per name the left side ends in and constant,
 * which one the original's MOV is. Where every such store of an arm's constant is a register
 * store, the two stores become the select:
 *
 *     pDVar1->pMonStatsTxt = nClassId >= 0 && nClassId < sgptDataTable->nTxtMonStatsSize
 *       ? sgptDataTable->pTxtMonStats + nClassId : 0;
 *
 * Checked with the oracle's compiler: MONSTER_SetMonStatsTxtAndType (004ae0a0),
 * SBIG_BigBuffer_GetFirstWord (00421510), Q04_SetRescueTrigger (00592f80, `!pUnit ? -1 :
 * pUnit->nUnitGUID`, the condition as printed) and UI_SLIDER_InitAutomapParty (0047d4d0, the
 * nested form) match byte for byte.
 *
 * Shapes, X the same lvalue in both stores and C the condition as printed:
 *
 *   guard    `if (C) { X = A; return; } X = B;` ending a block in tail position (the
 *            function's body, or an arm of an if that ends one) of a void function, an
 *            optional `return;` after it  ->  `X = C ? A : B;`
 *   else     `if (C) { X = A; } else { X = B; }`  ->  `X = C ? A : B;`
 *   nested   `if (C1) { T t; t = E; if (P) { X = A; return; } } X = B;` in tail position,
 *            t (or `T t = E;`) a 32-bit integer or pointer local read only by P  ->
 *            `X = C1 && P[t := (E)] ? A : B;`
 *
 * A or B (or both) is an integer constant (a literal, its negation or a cast of one,
 * nullptr, true/false), and every constant arm must be a register store: the rows of its
 * name and value tied to the body's stores of that name and value by order where the counts
 * agree (SBIG_BigBuffer_GetFirstWord stores `*pOutWord = 0` first as an immediate), else
 * all of them `r`. X calls nothing, assigns nothing and has no subscript (the
 * fact names only a variable or a field).
 *
 * Value-preserving: C is evaluated first, then exactly the arm's value, then the store, as
 * before; X's address is formed after the same evaluations as in the arm it replaces, and
 * nothing in between writes. In the nested form `C1 && P[t := E]` evaluates E only when C1
 * holds, as the if did, and t is not read anywhere else.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, AssignExpr, BinaryExpr, CompoundStmt, CStyleCastExpr, DeclStmt, Expression, ExprStmt,
  FunctionDecl, Identifier, IfStmt, MemberExpr, ParenExpr, QualifiedId, ReturnStmt, Statement, TypeNode, UnaryExpr,
  VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface RegisterStoreRow { name: string; size: number; value: number; register: boolean }

export interface RegisterStoreSelectOptions extends PluginOptions {
  /** The function's register-store rows (extract/register-stores.ts). */
  registerStores?: ReadonlyArray<RegisterStoreRow>;
  onSite?: (e: { function: string; kind: 'guard' | 'else' | 'nested'; name: string }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** The integer value of a constant arm, or null. */
function constValue(e: Expression): bigint | null {
  let u = unwrap(e);
  while (u.kind === NodeKind.CStyleCastExpr) u = unwrap((u as CStyleCastExpr).expression);
  switch (u.kind) {
    case NodeKind.IntegerLiteral: {
      const v = (u as unknown as { value: bigint | number }).value;
      return typeof v === 'bigint' ? v : BigInt(v);
    }
    case NodeKind.NullptrLiteral: return 0n;
    case NodeKind.BoolLiteral: return (u as unknown as { value: boolean }).value ? 1n : 0n;
    case NodeKind.UnaryExpr: {
      const x = u as UnaryExpr;
      if (x.operator !== '-') return null;
      const v = constValue(x.operand);
      return v === null ? null : -v;
    }
    case NodeKind.Identifier:
      if ((u as Identifier).name === 'nullptr' || (u as Identifier).name === 'NULL') return 0n;
      return null;
    default: return null;
  }
}

/**
 * The name the left side ends in, as the decompiler's last variable or field token before
 * the `=`: a member's name, a variable's, through `*`, `&` and casts. Null for anything with
 * a subscript, a call or another operator.
 */
function lvalueName(e: Expression): string | null {
  const u = unwrap(e);
  switch (u.kind) {
    case NodeKind.Identifier: return (u as Identifier).name;
    case NodeKind.QualifiedId: {
      const t = emit(u as unknown as AnyNode).trim();
      return t.split('::').pop() || null;
    }
    case NodeKind.MemberExpr: {
      const m = (u as MemberExpr).member as unknown as Identifier;
      return lvaluePure((u as MemberExpr).object) ? m.name : null;
    }
    case NodeKind.UnaryExpr: {
      const x = u as UnaryExpr;
      return x.operator === '*' || x.operator === '&' ? lvalueName(x.operand) : null;
    }
    case NodeKind.CStyleCastExpr: return lvalueName((u as CStyleCastExpr).expression);
    default: return null;
  }
}

/** The object part of a member access: names, members, derefs, address-ofs and casts only. */
function lvaluePure(e: Expression): boolean {
  const u = unwrap(e);
  switch (u.kind) {
    case NodeKind.Identifier: case NodeKind.QualifiedId: case NodeKind.ThisExpr: return true;
    case NodeKind.MemberExpr: return lvaluePure((u as MemberExpr).object);
    case NodeKind.UnaryExpr: return ['*', '&'].includes((u as UnaryExpr).operator) && lvaluePure((u as UnaryExpr).operand);
    case NodeKind.CStyleCastExpr: return lvaluePure((u as CStyleCastExpr).expression);
    default: return false;
  }
}

const text = (n: ASTNode) => emit(n as unknown as AnyNode).replace(/\s+/g, '');

interface Store { node: AssignExpr; left: Expression; right: Expression }

/** `X = V` as a statement (no compound assignment). */
function store(s: Statement | undefined): Store | null {
  if (!s || s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  return { node: e as AssignExpr, left: (e as AssignExpr).left, right: (e as AssignExpr).right };
}

function body(s: Statement): readonly Statement[] {
  return s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];
}

function isVoidReturn(s: Statement | undefined): boolean {
  return !!s && s.kind === NodeKind.ReturnStmt && !(s as ReturnStmt).value;
}

/** `{ X = A; return; }` -> the store. */
function storeReturn(s: Statement): Store | null {
  const l = body(s);
  if (l.length !== 2 || !isVoidReturn(l[1])) return null;
  return store(l[0]);
}

function plainIf(s: Statement | undefined): IfStmt | null {
  if (!s || s.kind !== NodeKind.IfStmt) return null;
  const i = s as IfStmt;
  return i.init || i.isConstexpr ? null : i;
}

/**
 * Per constant store of the body, whether the original stores it from a register: the rows
 * of its name and value, tied by order when the body has exactly as many stores of that name
 * and value, else all of them, which must agree. Absent: no row, or no agreement.
 */
function registerStores(body: ASTNode, rows: ReadonlyArray<RegisterStoreRow>): Map<ASTNode, boolean> {
  const out = new Map<ASTNode, boolean>();
  const stores: Array<{ node: ASTNode; name: string; v: bigint }> = [];
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.AssignExpr || (n as AssignExpr).operator !== '=') continue;
    const name = lvalueName((n as AssignExpr).left);
    const v = constValue((n as AssignExpr).right);
    if (name && v !== null) stores.push({ node: n, name, v });
  }
  const fits = (r: RegisterStoreRow, name: string, v: bigint) => r.name === name && BigInt.asUintN(r.size * 8, v) === BigInt(r.value);
  for (const st of stores) {
    const mine = rows.filter(r => fits(r, st.name, st.v));
    if (mine.length === 0) continue;
    const peers = stores.filter(o => mine.every(r => fits(r, o.name, o.v)));
    if (peers.length === mine.length) out.set(st.node, mine[peers.indexOf(st)].register);
    else if (mine.every(r => r.register === mine[0].register)) out.set(st.node, mine[0].register);
  }
  return out;
}

/** The two arms qualify: at least one constant, every constant one a register store. */
function armsQualify(a: Store, b: Store, reg: Map<ASTNode, boolean>): boolean {
  const ka = constValue(a.right), kb = constValue(b.right);
  if (ka === null && kb === null) return false;
  if (ka !== null && reg.get(a.node) !== true) return false;
  if (kb !== null && reg.get(b.node) !== true) return false;
  return true;
}

function select(left: Expression, cond: Expression, a: Expression, b: Expression): Statement {
  return Stmt.expr(Expr.assign(cloneNode(left), Expr.conditional(cloneNode(cond), cloneNode(a), cloneNode(b))));
}

const INT32 = /^(int|unsigned|unsigned int|signed|signed int|long|unsigned long|BOOL|DWORD|UINT|INT|LONG|ULONG|u?int32_t)$/;

function is32(t: TypeNode): boolean {
  if (t.kind === NodeKind.PointerType) return true;
  return INT32.test(emit(t as unknown as AnyNode).trim());
}

function countName(n: ASTNode, name: string): number {
  let k = 0;
  for (const m of traverseAST(n)) if (m.kind === NodeKind.Identifier && (m as Identifier).name === name) k++;
  return k;
}

/** P with t replaced by its value, for P one of `t`, `!t`, `t != 0`, `t == 0` (0 or nullptr). */
function substitute(p: Expression, name: string, by: Expression): Expression | null {
  const isT = (e: Expression) => { const u = unwrap(e); return u.kind === NodeKind.Identifier && (u as Identifier).name === name; };
  const v = () => Expr.paren(cloneNode(by));
  const u = unwrap(p);
  if (isT(u)) return v();
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!' && isT((u as UnaryExpr).operand)) return Expr.not(v());
  if (u.kind === NodeKind.BinaryExpr && ['==', '!='].includes((u as BinaryExpr).operator)) {
    const x = u as BinaryExpr;
    if (isT(x.left) && constValue(x.right) === 0n) return Expr.binary(v(), x.operator, cloneNode(x.right));
  }
  return null;
}

/** The inner block of the nested form: `[T t;] t = E; if (P) { X = A; return; }`, or `T t = E; if ...`. */
function nestedInner(l: readonly Statement[]): { cond: Expression; st: Store } | null {
  let t: string | null = null, type: TypeNode | null = null, value: Expression | null = null, k = 0;
  if (l[k]?.kind === NodeKind.DeclStmt) {
    const d = (l[k] as DeclStmt).declarations;
    if (d.length !== 1 || d[0].kind !== NodeKind.VariableDecl) return null;
    const v = d[0] as VariableDecl;
    if (v.specifiers.length > 0 || v.directInit || v.copyListInit) return null;
    t = v.name.name; type = v.type;
    if (v.initializer) {
      if (v.initializer.kind === NodeKind.InitListExpr) return null;
      value = v.initializer as Expression;
    }
    k++;
  }
  if (!value) {
    const s = store(l[k]);
    if (!s || !t) return null;
    const lu = unwrap(s.left);
    if (lu.kind !== NodeKind.Identifier || (lu as Identifier).name !== t) return null;
    value = s.right; k++;
  }
  if (!t || !type || !is32(type) || l.length !== k + 1) return null;
  const inner = plainIf(l[k]);
  if (!inner || inner.elseBranch) return null;
  const st = storeReturn(inner.thenBranch);
  if (!st) return null;
  // t is read by P alone: once there, nowhere in the store, and not in its own value.
  if (countName(inner.thenBranch, t) !== 0 || countName(value, t) !== 0) return null;
  const cond = substitute(inner.condition, t, value);
  return cond ? { cond, st } : null;
}

interface Hit { kind: 'guard' | 'else' | 'nested'; name: string }

/** One rewrite in `l`, a block in tail position when `tail`. */
function rewriteBlock(l: Statement[], tail: boolean, isVoid: boolean, reg: Map<ASTNode, boolean>): Hit | null {
  for (let i = 0; i < l.length; i++) {
    const g = plainIf(l[i]);
    if (!g) continue;
    // else: both arms one store of the same lvalue.
    if (g.elseBranch) {
      const a = body(g.thenBranch), b = body(g.elseBranch);
      if (a.length === 1 && b.length === 1) {
        const sa = store(a[0]), sb = store(b[0]);
        if (sa && sb && text(sa.left) === text(sb.left)) {
          const name = lvalueName(sa.left);
          if (name && armsQualify(sa, sb, reg)) {
            l.splice(i, 1, select(sa.left, g.condition, sa.right, sb.right));
            return { kind: 'else', name };
          }
        }
      }
      continue;
    }
    if (!tail || !isVoid) continue;
    const rest = l.slice(i + 1);
    const final = store(rest[0]);
    if (!final || rest.length > 2 || (rest.length === 2 && !isVoidReturn(rest[1]))) continue;
    const name = lvalueName(final.left);
    if (!name) continue;
    // guard
    const sa = storeReturn(g.thenBranch);
    if (sa && text(sa.left) === text(final.left) && armsQualify(sa, final, reg)) {
      l.splice(i, 2, select(final.left, g.condition, sa.right, final.right));
      return { kind: 'guard', name };
    }
    // nested
    const n = nestedInner(body(g.thenBranch));
    if (n && text(n.st.left) === text(final.left) && armsQualify(n.st, final, reg)) {
      const cond = Expr.binary(cloneNode(g.condition), '&&', n.cond);
      l.splice(i, 2, select(final.left, cond, n.st.right, final.right));
      return { kind: 'nested', name };
    }
  }
  return null;
}

/** Blocks in tail position: the body, then the arms of an if ending one. */
function tailBlocks(b: CompoundStmt, out: Set<ASTNode>): void {
  out.add(b);
  const last = b.statements[b.statements.length - 1];
  if (last?.kind === NodeKind.IfStmt) {
    const i = last as IfStmt;
    for (const arm of [i.thenBranch, i.elseBranch]) if (arm?.kind === NodeKind.CompoundStmt) tailBlocks(arm as CompoundStmt, out);
  }
}

function isVoidFunction(fn: FunctionDecl): boolean {
  const r = (fn as unknown as { returnType?: TypeNode }).returnType;
  return !!r && emit(r as unknown as AnyNode).trim() === 'void';
}

function rewriteFunction(fn: FunctionDecl, opts: RegisterStoreSelectOptions): FunctionDecl | undefined {
  if (!fn.body || !opts.registerStores || !opts.registerStores.some(r => r.register)) return undefined;
  const fname = (fn as unknown as { name?: { name?: string } }).name?.name ?? '';
  const isVoid = isVoidFunction(fn);
  const b = cloneNode(fn.body) as CompoundStmt;
  // Tied once, on the body as printed: the rewrites only replace the stores they join.
  const reg = registerStores(b, opts.registerStores);
  let changed = false;
  for (let round = 0; round < 16; round++) {
    const tails = new Set<ASTNode>();
    tailBlocks(b, tails);
    let hit: Hit | null = null;
    for (const n of traverseAST(b)) {
      if (n.kind !== NodeKind.CompoundStmt) continue;
      hit = rewriteBlock((n as CompoundStmt).statements as Statement[], tails.has(n), isVoid, reg);
      if (hit) break;
    }
    if (!hit) break;
    changed = true;
    opts.onSite?.({ function: fname, ...hit });
  }
  return changed ? updateNode(fn, { body: b } as Partial<FunctionDecl>) : undefined;
}

export const registerStoreSelectPlugin: TransformPlugin = {
  id: 'register-store-select',
  name: 'Register Store Select',
  description: 'Two stores of one lvalue whose constant the original stores from a register become one store of a select',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 989.992,
  tags: ['matching'],
  createTransformer: (options: RegisterStoreSelectOptions = {}): Transformer => createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  }),
};
