/**
 * Pointee Clear Memset Plugin
 *
 * `memset(p, 0, sizeof(T))` of a small struct is inlined by VC8 /O2 as one zeroed register
 * and a store of it per dword (`xor ecx, ecx; mov [eax], ecx; mov [eax+4], ecx`). The
 * decompiler prints those stores member by member, `p->x = 0; p->y = 0;`, which VC8 compiles
 * to one `mov dword ptr [eax], 0` per member: an immediate each, where the original stores
 * the register (FIELDTBLS_AllocPoint 0066a4b0, STRUCT_CreateTxtLinkStrc 006bd040).
 *
 * The text cannot tell the two apart; the instructions can. The register-store facts
 * (reconstruct extract/register-stores.ts) say, per constant `=`, whether the original
 * stored it from a register loaded with the constant. A run is written as the memset when
 *
 *   - it is a run of consecutive statements `P->f = 0` (0, '\0', nullptr, a cast of one),
 *     P one local or parameter declared `T *`, whose address is never taken;
 *   - the run writes every member of T's layout exactly once, each a plain (not bit) member
 *     of at most 4 bytes, and T is at most 32 bytes, so VC8 inlines the memset;
 *   - at least two members, and every store of the run is one the original made from a
 *     register (the facts tie each by member name and value; a name stored both ways in
 *     the function is tied by order, or not at all).
 *
 * Value-preserving: the run stores zero to every member of *P, and the memset stores zero to
 * every byte of *P; the bytes no member covers are padding, which no member read sees. The
 * stores are consecutive, so no read of *P sits between them, and P is read once instead of
 * once per store, which reads the same pointer: nothing in the run writes P.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CharLiteralExpr, CompoundStmt, CStyleCastExpr, ExprStmt, Expression, FunctionDecl,
  Identifier, MemberExpr, ParameterDecl, ParenExpr, PointerType, Statement, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { typeNodeName, bareName } from './call-arg-cast.js';
import type { RegisterStoreRow } from './register-store-select.js';

export interface PointeeClearMemsetOptions extends PluginOptions {
  /** Aggregate name -> every field's offset, size and Ghidra type, in offset order. */
  structLayouts?: Record<string, ReadonlyArray<{ name: string; offset: number; size: number; type: string; bitSize?: number }>>;
  /** Aggregate name -> size in bytes. */
  aggregateSizes?: Record<string, number>;
  /** Typedef name -> the spelling it stands for. */
  typedefTargets?: Record<string, string>;
  /** The function's register-store rows (extract/register-stores.ts). Absent: nothing changes. */
  registerStores?: ReadonlyArray<RegisterStoreRow>;
  onSite?: (e: { pointer: string; type: string; members: number }) => void;
}

/** VC8 SP1 /O2 inlines a memset of at most this many bytes. */
const MEMSET_INLINE_MAX = 32;

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** 0, '\0', nullptr or NULL, under casts and parentheses. */
function isZero(e: Expression): boolean {
  let u = unwrap(e);
  while (u.kind === NodeKind.CStyleCastExpr) u = unwrap((u as CStyleCastExpr).expression);
  if (u.kind === NodeKind.IntegerLiteral) return (u as unknown as { value: bigint }).value === 0n;
  if (u.kind === NodeKind.CharLiteral) {
    const v = (u as CharLiteralExpr as unknown as { value: number | string }).value;
    return v === 0 || v === '\0' || v === '\\0';
  }
  if (u.kind === NodeKind.NullptrLiteral) return true;
  return u.kind === NodeKind.Identifier && (u as Identifier).name === 'NULL';
}

/** `P->f = 0;`: P and f. */
function zeroStore(s: Statement): { p: string; f: string; assign: AssignExpr } | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr) return null;
  const a = e as AssignExpr;
  if (a.operator !== '=' || !isZero(a.right)) return null;
  const l = unwrap(a.left);
  if (l.kind !== NodeKind.MemberExpr || !(l as MemberExpr).isArrow) return null;
  const m = l as MemberExpr;
  const base = unwrap(m.object);
  if (base.kind !== NodeKind.Identifier) return null;
  const f = typeof m.member === 'string' ? m.member : (m.member as Identifier).name;
  return { p: (base as Identifier).name, f, assign: a };
}

interface Locals {
  /** Name -> pointee type name, for locals and parameters declared once as `T *`. */
  pointee: Map<string, string>;
  addressed: Set<string>;
}

function localsOf(fn: FunctionDecl): Locals {
  const pointee = new Map<string, string>();
  const dup = new Set<string>();
  const add = (name: string, t: ASTNode) => {
    if (pointee.has(name) || dup.has(name)) { dup.add(name); pointee.delete(name); return; }
    if (t.kind !== NodeKind.PointerType) { dup.add(name); return; }
    const inner = (t as PointerType).pointee;
    const n = typeNodeName((inner as unknown as { name?: unknown }).name);
    if (n) pointee.set(name, bareName(n)); else dup.add(name);
  };
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) add(p.name.name, p.type);
  const addressed = new Set<string>();
  for (const n of traverseAST(fn.body!)) {
    if (n.kind === NodeKind.VariableDecl) add((n as VariableDecl).name.name, (n as VariableDecl).type);
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      const o = unwrap((n as UnaryExpr).operand);
      if (o.kind === NodeKind.Identifier) addressed.add((o as Identifier).name);
    }
  }
  return { pointee, addressed };
}

/**
 * Per zero store of the body, whether the original stores it from a register, tied as
 * register-store-select ties them: by name and value, by order where the body has exactly
 * as many such stores as rows, else only when every row of that name and value agrees.
 */
function registerZeroStores(body: ASTNode, rows: ReadonlyArray<RegisterStoreRow>): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const stores: Array<{ node: AssignExpr; name: string }> = [];
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.AssignExpr || (n as AssignExpr).operator !== '=' || !isZero((n as AssignExpr).right)) continue;
    const l = unwrap((n as AssignExpr).left);
    let name: string | null = null;
    if (l.kind === NodeKind.MemberExpr) {
      const m = (l as MemberExpr).member;
      name = typeof m === 'string' ? m : (m as Identifier).name;
    } else if (l.kind === NodeKind.Identifier) name = (l as Identifier).name;
    if (name) stores.push({ node: n as AssignExpr, name });
  }
  for (const st of stores) {
    const mine = rows.filter(r => r.name === st.name && r.value === 0);
    if (mine.length === 0) continue;
    const peers = stores.filter(o => o.name === st.name);
    const k = key(st.node);
    if (!k) continue;
    if (peers.length === mine.length) out.set(k, mine[peers.indexOf(st)].register);
    else if (mine.every(r => r.register === mine[0].register)) out.set(k, mine[0].register);
  }
  return out;
}

/** A parsed node's place in the text: the transformer copies nodes, so identity does not survive. */
function key(n: ASTNode): string | null {
  const o = n.location?.start?.offset;
  return o === undefined || n.location.file === '<generated>' ? null : `${o}:${n.location.end?.offset}`;
}

function resolve(name: string, typedefs: Record<string, string>): string {
  for (let i = 0; i < 8; i++) {
    const t = typedefs[name];
    if (!t || t.includes('*') || t.includes('[')) break;
    name = bareName(t.replace(/^(struct|union|class)\s+/, '').trim());
  }
  return name;
}

function createPointeeClearMemsetTransformer(options: PointeeClearMemsetOptions = {}): Transformer {
  const layouts = options.structLayouts ?? {};
  const sizes = options.aggregateSizes ?? {};
  const typedefs = options.typedefTargets ?? {};
  const rows = options.registerStores;
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body || !rows || !rows.some(r => r.register && r.value === 0)) return undefined;
      const locals = localsOf(fn);
      const reg = registerZeroStores(fn.body, rows);
      let changed = false;
      const inner = createTransformer({
        visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
          const list = block.statements;
          const out: Statement[] = [];
          let edited = false;
          for (let i = 0; i < list.length;) {
            const first = zeroStore(list[i]);
            const type = first ? locals.pointee.get(first.p) : undefined;
            if (!first || !type || locals.addressed.has(first.p)) { out.push(list[i++]); continue; }
            const t = resolve(type, typedefs);
            const layout = layouts[t];
            const size = sizes[t];
            let j = i;
            const fields = new Set<string>();
            const run: AssignExpr[] = [];
            for (; j < list.length; j++) {
              const z = zeroStore(list[j]);
              if (!z || z.p !== first.p || fields.has(z.f)) break;
              fields.add(z.f);
              run.push(z.assign);
            }
            const whole = !!layout && !!size && size <= MEMSET_INLINE_MAX && run.length >= 2
              && layout.length === fields.size
              && layout.every(f => fields.has(f.name) && !f.bitSize && f.size <= 4)
              && run.every(a => { const k = key(a); return !!k && reg.get(k) === true; });
            if (!whole) { out.push(list[i++]); continue; }
            const p = Expr.identifier(first.p);
            const call = Expr.call('memset', [p, Expr.intLiteral(0), Expr.sizeof(Expr.deref(cloneNode(p)), false)]);
            const stmt = Stmt.expr(call);
            stmt.location = list[i].location;
            (stmt as unknown as { leadingTrivia: unknown }).leadingTrivia = list[i].leadingTrivia;
            out.push(stmt);
            options.onSite?.({ pointer: first.p, type: t, members: run.length });
            i = j;
            edited = true;
          }
          if (!edited) return undefined;
          changed = true;
          return updateNode(block, { statements: out } as Partial<CompoundStmt>);
        },
      });
      const body = inner(fn.body);
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const pointeeClearMemsetPlugin: TransformPlugin = {
  id: 'pointee-clear-memset',
  name: 'Pointee Clear Memset',
  description: 'Zero stores to every member of *P that the original makes from one register are the memset',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 975,
  tags: ['matching'],
  createTransformer: (options: PointeeClearMemsetOptions = {}) => createPointeeClearMemsetTransformer(options),
};
