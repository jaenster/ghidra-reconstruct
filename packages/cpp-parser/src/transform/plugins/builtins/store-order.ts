/**
 * Store Order Plugin
 *
 * The decompiler prints a run of independent stores in an order of its own; VC8 emits
 * them in the order the source wrote them. Where the facts (reconstruct
 * extract/access-order.ts) give each statement of a run its store instruction, the run
 * is written in the original's instruction order:
 *
 *     pHeadNode->pNext = 0;            pHeadNode->pPrev = 0;   // mov [eax + 0xc], esi
 *     pHeadNode->pPrev = 0;     =>     pHeadNode->pNext = 0;   // mov [eax + 0x10], esi
 *
 * (GLSUBTILE_RemoveNodeFromHead, 0050ef80.) An 8-byte aggregate copy of two 4-byte
 * fields the original wrote high half first (`mov [ecx + 4], edx; mov [ecx], eax`,
 * RollRandomSeed 0045c370) is written as the two field stores in that order; VC8 copies
 * the whole aggregate low half first.
 *
 * Value-preserving: statements change places only when neither writes what the other
 * reads or writes. Each statement of a run is `lhs = rhs;` alone on its line, with no
 * call and no other write, storing to a global, a field or through a pointer (a scalar
 * local's stack slot is VC8's choice, not a store the source made); the locations are
 * compared as the declarations lay them out:
 *
 *   - a local whose address is never taken overlaps only itself (by field range);
 *   - two globals overlap only when they are the same one (by field range);
 *   - two accesses through the same pointer, unchanged in the run, overlap when their
 *     field ranges do (from the aggregate layouts; a union's members all start at 0);
 *   - anything else through a pointer may overlap any global, addressed local or other
 *     pointer access.
 *
 * Without the facts nothing changes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, Expression, ExprStmt, FunctionDecl, Identifier, MemberExpr,
  ParameterDecl, ParenExpr, Statement, TypeNode, UnaryExpr, VariableDecl, CStyleCastExpr,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { bareName, calleeName, type TypedefResolver } from './call-arg-cast.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import { effectsOf, placed, type AccessOrderEvidence, type StoreFact } from './access-order-evidence.js';

export type AggregateLayout = Array<{ name: string; offset: number; size: number; type: string; bitSize?: number }>;

export interface StoreOrderOptions extends PluginOptions {
  accessOrder?: AccessOrderEvidence | null;
  /** Aggregate name -> its members' offsets and sizes. */
  structLayouts?: Record<string, AggregateLayout>;
  functionReturnTypes?: Record<string, string>;
  globalTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  onSite?: (e: { line: number; kind: 'order' | 'split'; count: number }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** A memory location: what it is rooted in and the byte range inside the root (null: all of it). */
interface Loc {
  root: string;
  kind: 'local' | 'global' | 'deref';
  range: [number, number] | null;
}

interface Ctx {
  locals: Map<string, { addressed: boolean }>;
  /** Bare names of the globals. */
  globals: Set<string>;
  shape: ExprShape;
  layouts: Record<string, AggregateLayout>;
}

function memberName(m: MemberExpr): string | null {
  const n = m.member as { kind?: string; name?: unknown };
  return n.kind === NodeKind.Identifier && typeof n.name === 'string' ? n.name : null;
}

/** The member's range in the aggregate `object` has, or null when the layout does not say. */
function fieldRange(object: Expression, name: string, arrow: boolean, ctx: Ctx): [number, number] | null {
  const s = ctx.shape(object);
  if (!s || s.stars !== (arrow ? 1 : 0)) return null;
  const f = ctx.layouts[s.base.replace(/^::/, '')]?.find(x => x.name === name);
  if (!f || f.bitSize !== undefined || f.size <= 0) return null;
  return [f.offset, f.offset + f.size];
}

/** The location an lvalue names, or undefined when it is not one this pass can place. */
function locOf(e: Expression, ctx: Ctx): Loc | undefined {
  e = unwrap(e);
  if (e.kind === NodeKind.Identifier) {
    const name = (e as Identifier).name;
    const l = ctx.locals.get(name);
    // A local whose address is taken may be reached through a pointer, but its own fields
    // still lie apart.
    if (l) return l.addressed ? { root: `&${name}`, kind: 'deref', range: null } : { root: name, kind: 'local', range: null };
    // A name that is no variable (an enumerator, a function) is no location.
    return ctx.globals.has(name) ? { root: name, kind: 'global', range: null } : undefined;
  }
  if (e.kind === NodeKind.QualifiedId) {
    const q = calleeName(e);
    return q && ctx.globals.has(bareName(q)) ? { root: bareName(q), kind: 'global', range: null } : undefined;
  }
  if (e.kind === NodeKind.MemberExpr) {
    const m = e as MemberExpr;
    const name = memberName(m);
    if (!name) return undefined;
    if (m.isArrow) {
      const base = unwrap(m.object);
      const r = fieldRange(m.object, name, true, ctx);
      if (base.kind === NodeKind.Identifier && ctx.locals.has((base as Identifier).name)) {
        return { root: `->${(base as Identifier).name}`, kind: 'deref', range: r };
      }
      return { root: '*', kind: 'deref', range: null };
    }
    const outer = locOf(m.object, ctx);
    if (!outer) return undefined;
    if (outer.kind === 'deref' && outer.root === '*') return outer;
    const r = fieldRange(m.object, name, false, ctx);
    if (!r) return { ...outer, range: outer.range };
    const base = outer.range ? outer.range[0] : 0;
    return { ...outer, range: [base + r[0], base + r[1]] };
  }
  if (e.kind === NodeKind.SubscriptExpr || (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '*')) {
    return { root: '*', kind: 'deref', range: null };
  }
  return undefined;
}

const overlap = (a: [number, number] | null, b: [number, number] | null) =>
  !a || !b || (a[0] < b[1] && b[0] < a[1]);

function mayAlias(a: Loc, b: Loc): boolean {
  if (a.kind === 'local' || b.kind === 'local') return a.kind === b.kind && a.root === b.root && overlap(a.range, b.range);
  if (a.kind === 'global' && b.kind === 'global') return a.root === b.root && overlap(a.range, b.range);
  if (a.kind === 'deref' && b.kind === 'deref' && a.root !== '*' && a.root === b.root) return overlap(a.range, b.range);
  return true;
}

/** What evaluating `e` as a value reads: every variable and memory access in it. */
function readsOf(e: Expression, ctx: Ctx): Loc[] | null {
  const out: Loc[] = [];
  let ok = true;
  const visit = (n: ASTNode): void => {
    if (!ok) return;
    if (n.kind === NodeKind.Identifier) {
      const l = locOf(n as Identifier, ctx);
      if (l) out.push(l);
      return;
    }
    if (n.kind === NodeKind.MemberExpr || n.kind === NodeKind.SubscriptExpr
      || (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '*')) {
      const l = locOf(n as Expression, ctx);
      if (!l) { ok = false; return; }
      out.push(l);
      // The address it is read through is read too.
      if (n.kind === NodeKind.MemberExpr) {
        const m = n as MemberExpr;
        if (m.isArrow) visit(m.object);
        else {
          const ar = addressReadsOf(m.object, ctx);
          if (!ar) ok = false;
          else out.push(...ar);
        }
        return;
      }
      for (const k of getChildren(n)) visit(k);
      return;
    }
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      // An address read is no memory read, but its index or base expression is.
      for (const k of getChildren((n as UnaryExpr).operand)) visit(k);
      return;
    }
    if (n.kind === NodeKind.CStyleCastExpr) { visit((n as CStyleCastExpr).expression); return; }
    for (const k of getChildren(n)) visit(k);
  };
  visit(e);
  return ok ? out : null;
}

/** The reads computing an lvalue's address (not the location itself). */
function addressReadsOf(lhs: Expression, ctx: Ctx): Loc[] | null {
  const e = unwrap(lhs);
  if (e.kind === NodeKind.Identifier) return [];
  if (e.kind === NodeKind.MemberExpr) {
    const m = e as MemberExpr;
    return m.isArrow ? readsOf(m.object, ctx) : addressReadsOf(m.object, ctx);
  }
  const all = readsOf(e, ctx);
  return all ? all.slice(1) : null;
}

interface Store {
  stmt: ExprStmt;
  fact: StoreFact;
  write: Loc;
  reads: Loc[];
}

function storeOf(s: Statement, ev: AccessOrderEvidence, owners: Map<number, number>, ctx: Ctx): Store | null {
  if (s.kind !== NodeKind.ExprStmt || !placed(s)) return null;
  const line = s.location.start.line;
  if (s.location.end.line !== line || (owners.get(line) ?? 0) !== 1) return null;
  const facts = ev.stores.get(line);
  if (!facts || facts.length !== 1 || facts[0].ord !== 0 || facts[0].at === null) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const a = e as AssignExpr;
  const fl = effectsOf(a.left), fr = effectsOf(a.right);
  if (fl.calls || fl.writes || fr.calls || fr.writes) return null;
  const write = locOf(a.left, ctx);
  // A scalar local lives where VC8 puts it; its stack slot is no store the source wrote.
  if (!write || unwrap(a.left).kind === NodeKind.Identifier && write.kind !== 'global') return null;
  const r1 = readsOf(a.right, ctx), r2 = addressReadsOf(a.left, ctx);
  if (!r1 || !r2) return null;
  return { stmt: s as ExprStmt, fact: facts[0], write, reads: [...r1, ...r2] };
}

function independent(a: Store, b: Store): boolean {
  if (mayAlias(a.write, b.write)) return false;
  if (a.reads.some(r => mayAlias(r, b.write))) return false;
  if (b.reads.some(r => mayAlias(r, a.write))) return false;
  return true;
}

/** `L = R;` copying an 8-byte aggregate of two 4-byte fields, high half first: the two stores. */
function splitHighFirst(s: Statement, ev: AccessOrderEvidence, owners: Map<number, number>, ctx: Ctx): Statement[] | null {
  if (s.kind !== NodeKind.ExprStmt || !placed(s)) return null;
  const line = s.location.start.line;
  if (s.location.end.line !== line || (owners.get(line) ?? 0) !== 1) return null;
  const facts = ev.stores.get(line);
  if (!facts || facts.length !== 1 || facts[0].size !== 8 || facts[0].half !== 'h') return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const a = e as AssignExpr;
  const fl = effectsOf(a.left), fr = effectsOf(a.right);
  if (fl.calls || fl.writes || fr.calls || fr.writes) return null;
  const ls = ctx.shape(a.left), rs = ctx.shape(a.right);
  if (!ls || !rs || ls.stars !== 0 || rs.stars !== 0 || ls.base !== rs.base) return null;
  const layout = ctx.layouts[ls.base.replace(/^::/, '')];
  if (!layout || layout.length !== 2) return null;
  const lo = layout.find(f => f.offset === 0), hi = layout.find(f => f.offset === 4);
  if (!lo || !hi || lo.size !== 4 || hi.size !== 4 || lo.bitSize !== undefined || hi.bitSize !== undefined) return null;
  // The right side is an lvalue the left side's store cannot reach.
  const right = unwrap(a.right);
  const wl = locOf(a.left, ctx), rl = locOf(right, ctx);
  if (!wl || !rl || mayAlias(wl, rl)) return null;
  const field = (x: Expression, name: string): Expression => {
    const u = unwrap(x);
    if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '*') {
      return Expr.member(cloneNode((u as UnaryExpr).operand), name, true);
    }
    const base = u.kind === NodeKind.Identifier || u.kind === NodeKind.MemberExpr ? cloneNode(u) : Expr.paren(cloneNode(u));
    return Expr.member(base, name, false);
  };
  const one = (name: string): ExprStmt => {
    const st = Stmt.expr({ kind: NodeKind.AssignExpr, operator: '=', left: field(a.left, name), right: field(right, name) } as unknown as AssignExpr);
    st.location = s.location;
    return st;
  };
  const first = one(hi.name), second = one(lo.name);
  first.leadingTrivia = s.leadingTrivia;
  second.trailingTrivia = s.trailingTrivia;
  return [first, second];
}

const globalNameCache = new WeakMap<Record<string, string>, Set<string>>();
function globalNames(types: Record<string, string> | undefined): Set<string> {
  if (!types) return new Set();
  let s = globalNameCache.get(types);
  if (!s) { s = new Set(Object.keys(types).map(bareName)); globalNameCache.set(types, s); }
  return s;
}

function rewriteFunction(fn: FunctionDecl, ev: AccessOrderEvidence, opts: StoreOrderOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const body = cloneNode(fn.body);
  const locals = new Map<string, { addressed: boolean }>();
  const localTypes = new Map<string, TypeNode>();
  for (const p of fn.parameters as ParameterDecl[]) {
    const n = (p as unknown as { name?: Identifier | null }).name;
    if (n && n.kind === NodeKind.Identifier) { locals.set(n.name, { addressed: false }); localTypes.set(n.name, p.type); }
  }
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.VariableDecl) continue;
    const v = n as VariableDecl;
    if (v.specifiers.includes('static') || v.specifiers.includes('extern')) continue;
    locals.set(v.name.name, { addressed: false });
    localTypes.set(v.name.name, v.type);
  }
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      for (const m of traverseAST((n as UnaryExpr).operand)) {
        if (m.kind === NodeKind.Identifier) { const l = locals.get((m as Identifier).name); if (l) l.addressed = true; }
      }
    }
  }
  // An array is its own address: a local array is addressed wherever it is named bare.
  for (const [name, t] of localTypes) {
    if (t.kind === NodeKind.ArrayType) locals.get(name)!.addressed = true;
  }
  const typedefTargets = opts.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  const ctx: Ctx = {
    locals,
    globals: globalNames(opts.globalTypes),
    shape: createExprShape(localTypes, {
      globalTypes: opts.globalTypes, enclosingVarTypes: opts.enclosingVarTypes, structFields: opts.structFields,
      fieldTypes: opts.fieldTypes, returnTypes: opts.functionReturnTypes, resolve,
    }),
    layouts: opts.structLayouts ?? {},
  };
  const owners = new Map<number, number>();
  for (const n of traverseAST(body)) {
    if ((n.kind === NodeKind.ExprStmt || n.kind === NodeKind.ReturnStmt || n.kind === NodeKind.DeclStmt) && placed(n)) {
      const l = n.location.start.line;
      owners.set(l, (owners.get(l) ?? 0) + 1);
    }
  }

  let changed = 0;
  const visitBlock = (block: CompoundStmt): void => {
    for (const s of block.statements) for (const k of getChildren(s)) visitAll(k);
    // Splits first: the two halves stand where the copy stood, and stay together.
    const halves = new Set<Statement>();
    for (let i = 0; i < block.statements.length; i++) {
      const parts = splitHighFirst(block.statements[i], ev, owners, ctx);
      if (!parts) continue;
      for (const p of parts) halves.add(p);
      block.statements.splice(i, 1, ...parts);
      i += parts.length - 1;
      changed++;
      opts.onSite?.({ line: parts[0].location?.start.line ?? 0, kind: 'split', count: 2 });
    }
    let i = 0;
    while (i < block.statements.length) {
      const run: Store[] = [];
      let j = i;
      for (; j < block.statements.length; j++) {
        const st = halves.has(block.statements[j]) ? null : storeOf(block.statements[j], ev, owners, ctx);
        if (!st) break;
        run.push(st);
      }
      if (run.length >= 2) {
        const sorted = [...run].sort((x, y) => (x.fact.at! - y.fact.at!) || (run.indexOf(x) - run.indexOf(y)));
        const moved = sorted.some((x, k) => x !== run[k]);
        let ok = moved;
        for (let x = 0; ok && x < run.length; x++) {
          for (let y = x + 1; ok && y < run.length; y++) {
            if (sorted.indexOf(run[x]) > sorted.indexOf(run[y]) && !independent(run[x], run[y])) ok = false;
          }
        }
        if (ok) {
          block.statements.splice(i, run.length, ...sorted.map(x => x.stmt));
          changed++;
          opts.onSite?.({ line: run[0].stmt.location.start.line, kind: 'order', count: run.length });
        }
      }
      i = Math.max(j, i + 1);
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

export function storeOrder_forTest(fn: FunctionDecl, opts: StoreOrderOptions): FunctionDecl {
  return opts.accessOrder ? rewriteFunction(fn, opts.accessOrder, opts) ?? fn : fn;
}

function createStoreOrderTransformer(options: StoreOrderOptions = {}): Transformer {
  const ev = options.accessOrder;
  if (!ev || ev.stores.size === 0) return (node: ASTNode) => node;
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, ev, options);
    },
  });
}

export const storeOrderPlugin: TransformPlugin = {
  id: 'store-order',
  name: 'Store Order',
  description: 'Writes a run of independent stores in the order of the original\'s store instructions',
  version: '1.0.0',
  defaultEnabled: true,
  // With the statement lists final (after goto structuring, comma expansion and
  // nest-call), before decl-init-merge (60).
  priority: 59.7,
  tags: ['matching'],
  createTransformer: createStoreOrderTransformer,
};
