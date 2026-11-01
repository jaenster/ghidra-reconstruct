/**
 * Seed Product Fold Plugin
 *
 * The game's seed step is one inline function, `D2_SEED_NEXT(seed)`: low * 0x6ac690c5 +
 * high, as 64 bits. Where the compiler kept the 64-bit product in a register pair across
 * a store, the decompiler names the pair and prints the step in pieces
 * (AITHINK_Fn1_ZakarumPriest 005f02c0):
 *
 *   lSeedMul = (uint64_t)pSeed->nSeedLow * 0x6ac690c5;
 *   bEngagedInCombat = (int)((uint64_t)lSeedMul >> 0x20);     // the EDX half, never read
 *   sSeedRoll = (D2SeedStrc)(lSeedMul + (uint64_t)pUnit->sSeed.nSeedHigh);
 *
 * with the high half read through the unit where the original read it through the seed
 * pointer (`mov edx,[edi+4]`, not `[esi+0x24]`): `pSeed = &pUnit->sSeed` is the same
 * address, so the decompiler is free to print either. As pieces the step is not the idiom
 * prng-transform folds, VC8 cannot share the seed base between the halves, and the dead
 * high-half store keeps a stack slot of its own. This puts the step back:
 *
 *   sSeedRoll = D2_SEED_NEXT(*pSeed);
 *
 * Only when all of this is proven, by reaching definitions over the CFG:
 *  - the product is the only definition of P reaching the step, and P is read nowhere
 *    else but in high-half stores `H = (T)(P >> 0x20)` whose H no node then reads;
 *  - no node between the product and the step calls or stores through memory, and no
 *    path runs the step twice without the product between, so the seed the step reads
 *    is the one the product read;
 *  - the two halves are one seed: the same lvalue, or `q->` and `X->sSeed` (either way
 *    round) where every definition of q reaching the product is `q = &X->sSeed` and
 *    neither q nor X is written between that definition and the step.
 * The macro takes the low half's seed, which is the one the product read. P and the
 * dead stores go; P's declaration goes when nothing names P any more.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, CStyleCastExpr, DeclStmt, ExprStmt, Expression,
  FunctionDecl, Identifier, IntegerLiteralExpr, MemberExpr, ParameterDecl, PostfixExpr, Statement, UnaryExpr,
  VariableDecl,
} from '../../../ast/nodes.js';
import { Expr } from '../../../ast/factory.js';
import { findNodesByKind, traverseAST } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { buildFunctionFlow, ENTRY_DEF, type FunctionFlow } from '../../cfg/index.js';
import { emit } from '../../../emit/index.js';

const MULTIPLIER = 0x6ac690c5n;

function unwrap(e: Expression): Expression {
  let x = e;
  for (;;) {
    if (x.kind === NodeKind.ParenExpr) x = (x as { expression: Expression }).expression;
    else if (x.kind === NodeKind.CStyleCastExpr) x = (x as CStyleCastExpr).expression;
    else return x;
  }
}

function typeName(c: CStyleCastExpr): string {
  return emit(c.type as unknown as AnyNode).replace(/\s+/g, '');
}

/** Peel parens and casts to an integer type at least 32 bits wide that keeps the value (`uint64_t`, `uint32_t`). */
function peelWidening(e: Expression): Expression {
  let x = e;
  for (;;) {
    if (x.kind === NodeKind.ParenExpr) { x = (x as { expression: Expression }).expression; continue; }
    if (x.kind === NodeKind.CStyleCastExpr && ['uint64_t', 'ulonglong', 'unsignedlonglong', 'uint32_t', 'uint']
      .includes(typeName(x as CStyleCastExpr))) { x = (x as CStyleCastExpr).expression; continue; }
    return x;
  }
}

/** `S.nSeedLow` / `S->nSeedHigh`: the member access, or null. */
function seedHalf(e: Expression, half: 'nSeedLow' | 'nSeedHigh'): MemberExpr | null {
  const x = peelWidening(e);
  if (x.kind !== NodeKind.MemberExpr) return null;
  const m = x as MemberExpr;
  return m.member.kind === NodeKind.Identifier && (m.member as Identifier).name === half ? m : null;
}

function isMultiplier(e: Expression): boolean {
  const x = unwrap(e);
  return x.kind === NodeKind.IntegerLiteral && (x as IntegerLiteralExpr).value === MULTIPLIER;
}

/** `(uint64_t)S.nSeedLow * K`: the low half's access. */
function productLow(e: Expression): MemberExpr | null {
  const x = unwrap(e);
  if (x.kind !== NodeKind.BinaryExpr || (x as BinaryExpr).operator !== '*') return null;
  const b = x as BinaryExpr;
  if (isMultiplier(b.right)) return seedHalf(b.left, 'nSeedLow');
  if (isMultiplier(b.left)) return seedHalf(b.right, 'nSeedLow');
  return null;
}

function identName(e: Expression): string | null {
  const x = peelWidening(e);
  return x.kind === NodeKind.Identifier ? (x as Identifier).name : null;
}

/** `(D2SeedStrc)(P + (uint64_t)S.nSeedHigh)`: P and the high half's access. */
function seedStep(e: Expression): { p: string; high: MemberExpr } | null {
  if (e.kind !== NodeKind.CStyleCastExpr || typeName(e as CStyleCastExpr) !== 'D2SeedStrc') return null;
  let x = (e as CStyleCastExpr).expression;
  while (x.kind === NodeKind.ParenExpr) x = (x as { expression: Expression }).expression;
  if (x.kind !== NodeKind.BinaryExpr || (x as BinaryExpr).operator !== '+') return null;
  const b = x as BinaryExpr;
  for (const [pe, he] of [[b.left, b.right], [b.right, b.left]] as const) {
    const p = identName(pe);
    const high = seedHalf(he, 'nSeedHigh');
    if (p && high) return { p, high };
  }
  return null;
}

/** `(T)(P >> 0x20)`, the product's high dword. */
function isHighOf(e: Expression, p: string): boolean {
  const x = unwrap(e);
  if (x.kind !== NodeKind.BinaryExpr || (x as BinaryExpr).operator !== '>>') return false;
  const b = x as BinaryExpr;
  const k = unwrap(b.right);
  return identName(b.left) === p && k.kind === NodeKind.IntegerLiteral && (k as IntegerLiteralExpr).value === 32n;
}

/** Does the expression call anything, or store anywhere but a named local? */
function touchesMemory(e: Expression): boolean {
  for (const n of traverseAST(e)) {
    if (n.kind === NodeKind.CallExpr) return true;
    let target: Expression | null = null;
    if (n.kind === NodeKind.AssignExpr) target = (n as AssignExpr).left;
    else if (n.kind === NodeKind.PostfixExpr) target = (n as PostfixExpr).operand;
    else if (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as UnaryExpr).operator)) target = (n as UnaryExpr).operand;
    if (target && unwrap(target).kind !== NodeKind.Identifier) return true;
  }
  return false;
}

function rootName(e: Expression): string | null {
  const x = unwrap(e);
  return x.kind === NodeKind.Identifier ? (x as Identifier).name : null;
}

/** The seed object a half belongs to, as the macro takes it: `*q` for `q->half`, else the object. */
function seedArg(half: MemberExpr): Expression {
  return half.isArrow ? Expr.unary('*', half.object) : half.object;
}

/** `X->sSeed` / `X.sSeed` with X a name: X. */
function unitOfSeed(e: Expression): { unit: string; text: string } | null {
  const x = unwrap(e);
  if (x.kind !== NodeKind.MemberExpr) return null;
  const m = x as MemberExpr;
  const unit = rootName(m.object);
  if (!unit || m.member.kind !== NodeKind.Identifier) return null;
  return { unit, text: emit(x as unknown as AnyNode) };
}

interface Site { cast: CStyleCastExpr; drop: Set<Statement>; p: string; arg: Expression }

/**
 * Are `lowHalf` and `highHalf` one seed at `use`? The product sits at `prod`.
 */
function sameSeed(flow: FunctionFlow, lowHalf: MemberExpr, highHalf: MemberExpr, prod: number, use: number): boolean {
  const lo = emit(lowHalf.object as unknown as AnyNode), hi = emit(highHalf.object as unknown as AnyNode);
  if (lowHalf.isArrow === highHalf.isArrow && lo === hi) {
    // One lvalue: its names must not change between the halves.
    const names = [...traverseAST(lowHalf.object)].filter(n => n.kind === NodeKind.Identifier).map(n => (n as Identifier).name);
    return !flow.writtenBetween(prod, use, names);
  }
  // `q->` beside `X->sSeed`, either way round.
  const [ptr, obj] = lowHalf.isArrow && !highHalf.isArrow ? [lowHalf, highHalf]
    : highHalf.isArrow && !lowHalf.isArrow ? [highHalf, lowHalf] : [null, null];
  if (!ptr || !obj) return false;
  const q = rootName(ptr.object);
  const seed = unitOfSeed(obj.object);
  if (!q || !seed || unwrap(ptr.object).kind !== NodeKind.Identifier) return false;
  const defs = flow.reaching(prod, q);
  if (defs.size === 0) return false;
  for (const d of defs) {
    if (d === ENTRY_DEF) return false;
    const def = flow.definition(d, q);
    if (!def || !def.killing || !def.rhs) return false;
    const r = unwrap(def.rhs);
    if (r.kind !== NodeKind.UnaryExpr || (r as UnaryExpr).operator !== '&') return false;
    const target = unitOfSeed((r as UnaryExpr).operand);
    if (!target || target.text !== seed.text) return false;
    if (flow.writtenBetween(d, use, [q, seed.unit])) return false;
  }
  return true;
}

/** The statements, with `drop` gone and each cast in `casts` replaced. */
function rebuild<T>(node: T, drop: ReadonlySet<Statement>, casts: ReadonlyMap<CStyleCastExpr, Expression>): T {
  if (Array.isArray(node)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of node) {
      if (drop.has(item as Statement)) { changed = true; continue; }
      const r = rebuild(item, drop, casts);
      if (r !== item) changed = true;
      out.push(r);
    }
    return (changed ? out : node) as T;
  }
  if (!node || typeof node !== 'object') return node;
  const replaced = casts.get(node as unknown as CStyleCastExpr);
  if (replaced) return replaced as unknown as T;
  let copy: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(node as object)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || !v || typeof v !== 'object') continue;
    const r = rebuild(v, drop, casts);
    if (r !== v) { copy = copy ?? { ...(node as object) } as Record<string, unknown>; copy[k] = r; }
  }
  return (copy ?? node) as T;
}

export function foldSeedProducts(fn: FunctionDecl): Statement[] | null {
  const body = fn.body as CompoundStmt | undefined;
  if (!body) return null;
  const statements = body.statements as Statement[];
  if (!emit(body as unknown as AnyNode).includes('0x6ac690c5')) return null;
  const declared = new Set<string>();
  for (const p of fn.parameters) if ((p as ParameterDecl).name) declared.add((p as ParameterDecl).name!.name);
  for (const d of findNodesByKind(body, NodeKind.VariableDecl)) declared.add((d as VariableDecl).name.name);
  const flow = buildFunctionFlow(statements, declared);
  const stmtOf = new Map<number, Statement>();
  for (const s of findStatements(statements)) {
    const n = flow.nodeOf(s);
    if (n !== undefined) stmtOf.set(n, s);
  }

  const sites: Site[] = [];
  for (const [use, stmt] of stmtOf) {
    if (stmt.kind !== NodeKind.ExprStmt && stmt.kind !== NodeKind.DeclStmt) continue;
    // The step is the whole value the statement stores, so nothing else it evaluates runs
    // between the seed's read and the store.
    const value = storedValue(stmt);
    for (const n of value ? [value] : []) {
      if (n.kind !== NodeKind.CStyleCastExpr) continue;
      const step = seedStep(n as CStyleCastExpr);
      if (!step || flow.isEscaped(step.p)) continue;
      const reach = [...flow.reaching(use, step.p)];
      if (reach.length !== 1 || reach[0] === ENTRY_DEF) continue;
      const prod = reach[0];
      const def = flow.definition(prod, step.p);
      const low = def?.killing && def.rhs ? productLow(def.rhs) : null;
      const prodStmt = stmtOf.get(prod);
      if (!low || !prodStmt || prodStmt.kind !== NodeKind.ExprStmt) continue;
      // Nothing between may change the seed, and every run of the step follows a run of
      // the product (a loop around the step alone would re-read a seed the product did not).
      if (flow.nodesBetween(prod, use).some(b => flow.ownExprs(b).some(touchesMemory))) continue;
      if (flow.nodesBetween(use, use, new Set([prod])).length > 0) continue;
      if (!sameSeed(flow, low, step.high, prod, use)) continue;
      // P is read by the step and by dead high-half stores, nothing else.
      const drop = new Set<Statement>([prodStmt]);
      let ok = true;
      for (const u of flow.usesOf(prod, step.p)) {
        if (u === use) continue;
        const s = stmtOf.get(u);
        const e = s && s.kind === NodeKind.ExprStmt ? unwrap((s as ExprStmt).expression) : null;
        const h = e && e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=' ? rootName((e as AssignExpr).left) : null;
        if (!h || h === step.p || unwrap((e as AssignExpr).left).kind !== NodeKind.Identifier
            || !isHighOf((e as AssignExpr).right, step.p) || flow.isEscaped(h) || flow.usesOf(u, h).length > 0) {
          ok = false;
          break;
        }
        drop.add(s!);
      }
      if (ok && flow.usesOf(prod, step.p).filter(u => u === use).length === 1) {
        sites.push({ cast: n as CStyleCastExpr, drop, p: step.p, arg: seedArg(low) });
      }
    }
  }
  if (sites.length === 0) return null;

  const drop = new Set<Statement>();
  const casts = new Map<CStyleCastExpr, Expression>();
  for (const s of sites) {
    for (const d of s.drop) drop.add(d);
    const call: CallExpr = { ...Expr.call(Expr.identifier('D2_SEED_NEXT'), [s.arg]), location: s.cast.location } as CallExpr;
    casts.set(s.cast, call);
  }
  let out = rebuild(statements, drop, casts);
  // A product variable nothing names any more loses its declaration.
  for (const p of new Set(sites.map(s => s.p))) {
    const named = out.some(st => [...traverseAST(st)].some(n => n.kind === NodeKind.Identifier && (n as Identifier).name === p
      && !isDeclName(st, n as Identifier)));
    if (!named) out = dropDeclaration(out, p);
  }
  return out;
}

/** `x = V;` or `T x = V;` with nothing in x that calls or stores: V; else null. */
function storedValue(s: Statement): Expression | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = (s as ExprStmt).expression;
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=' || touchesMemory((e as AssignExpr).left)) return null;
    return unwrapParensOnly((e as AssignExpr).right);
  }
  if (s.kind === NodeKind.DeclStmt) {
    const ds = (s as DeclStmt).declarations;
    if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return null;
    const init = (ds[0] as VariableDecl).initializer as Expression | null;
    return init && init.kind !== NodeKind.InitListExpr ? unwrapParensOnly(init) : null;
  }
  return null;
}

function unwrapParensOnly(e: Expression): Expression {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as { expression: Expression }).expression;
  return x;
}

function* findStatements(list: readonly Statement[]): Generator<Statement> {
  for (const s of list) {
    for (const n of traverseAST(s)) if (String(n.kind).endsWith('Stmt')) yield n as Statement;
  }
}

function isDeclName(st: Statement, id: Identifier): boolean {
  for (const n of traverseAST(st)) {
    if (n.kind === NodeKind.VariableDecl && (n as VariableDecl).name === id) return true;
  }
  return false;
}

/** The statements with the initialiser-free declaration of `name` removed (a lone declarator only). */
function dropDeclaration(list: Statement[], name: string): Statement[] {
  const drop = new Set<Statement>();
  for (const s of findStatements(list)) {
    if (s.kind !== NodeKind.DeclStmt) continue;
    const ds = (s as DeclStmt).declarations;
    if (ds.length === 1 && ds[0].kind === NodeKind.VariableDecl && (ds[0] as VariableDecl).name.name === name
        && !(ds[0] as VariableDecl).initializer) drop.add(s);
  }
  return drop.size > 0 ? rebuild(list, drop, new Map()) : list;
}

function createSeedProductFoldTransformer(_options?: PluginOptions): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      const statements = foldSeedProducts(fn);
      if (!statements) return undefined;
      return updateNode(fn, { body: { ...(fn.body as CompoundStmt), statements } } as Partial<FunctionDecl>);
    },
  });
}

export const seedProductFoldPlugin: TransformPlugin = {
  id: 'seed-product-fold',
  name: 'Seed Product Fold',
  description: 'A seed step printed as a named 64-bit product plus the high half -> D2_SEED_NEXT(seed), proven by reaching definitions',
  version: '1.0.0',
  defaultEnabled: true,
  // Before prng-transform (80) and prng-temp-collapse (85), which then treat the step as
  // one the decompiler printed whole.
  priority: 79,
  tags: ['game', 'patterns', 'diablo'],
  createTransformer: createSeedProductFoldTransformer,
};
