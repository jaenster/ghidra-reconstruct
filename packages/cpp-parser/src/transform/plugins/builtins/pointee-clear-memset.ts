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
import { covers, disjoint, lvalueSpan, memberSpan, memsetSpan, type RootInfo, type Span } from './byte-spans.js';

/** Per struct-typed stack local, the bytes the original's opening stores write zero (extract/zero-stores.ts). */
export interface ZeroStoreRow { name: string; size: number; zero: [number, number][] }

export interface PointeeClearMemsetOptions extends PluginOptions {
  /** Aggregate name -> every field's offset, size and Ghidra type, in offset order. */
  structLayouts?: Record<string, ReadonlyArray<{ name: string; offset: number; size: number; type: string; bitSize?: number }>>;
  /** Aggregate name -> size in bytes. */
  aggregateSizes?: Record<string, number>;
  /** Typedef name -> the spelling it stands for. */
  typedefTargets?: Record<string, string>;
  /** The function's register-store rows (extract/register-stores.ts). Absent: nothing changes. */
  registerStores?: ReadonlyArray<RegisterStoreRow>;
  /** The function's zero-store rows (extract/zero-stores.ts): evidence for a local's clear. */
  zeroStores?: ReadonlyArray<ZeroStoreRow>;
  onSite?: (e: { pointer: string; type: string; members: number; partial?: boolean }) => void;
}

/** VC8 SP1 /O2 inlines a memset of at most this many bytes. */
const MEMSET_INLINE_MAX = 32;

/**
 * A clear the original wrote as one memset but the decompiler printed in pieces is bounded
 * by what VC8 still expands into register stores: TEXT_AllocScreenMessage 0049db10 (38
 * bytes) and PLAYER_SendInventoryFullMessage 00549a60 (40) are register stores throughout.
 */
const PARTIAL_INLINE_MAX = 64;

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
  /** Name -> type name, for non-static locals declared once as a named type `T`. */
  value: Map<string, string>;
  addressed: Set<string>;
}

function localsOf(fn: FunctionDecl, typedefs: Record<string, string> = {}): Locals {
  const pointee = new Map<string, string>();
  const dup = new Set<string>();
  const add = (name: string, t: ASTNode) => {
    if (pointee.has(name) || dup.has(name)) { dup.add(name); pointee.delete(name); return; }
    if (t.kind !== NodeKind.PointerType) {
      // A pointer typedef, `LPMEMORYSTATUS` for `_MEMORYSTATUS *`.
      const tn = typeNodeName((t as unknown as { name?: unknown }).name);
      const m = tn ? /^(?:struct\s+)?([A-Za-z_]\w*)\s*\*$/.exec((typedefs[bareName(tn)] ?? '').trim()) : null;
      if (m) pointee.set(name, m[1]); else dup.add(name);
      return;
    }
    const inner = (t as PointerType).pointee;
    const n = typeNodeName((inner as unknown as { name?: unknown }).name);
    if (n) pointee.set(name, bareName(n)); else dup.add(name);
  };
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) add(p.name.name, p.type);
  const addressed = new Set<string>();
  const value = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) seen.set(p.name.name, 2);
  for (const n of traverseAST(fn.body!)) {
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      seen.set(v.name.name, (seen.get(v.name.name) ?? 0) + 1);
      const tn = v.type.kind === NodeKind.PointerType || v.type.kind === NodeKind.ArrayType ? undefined
        : typeNodeName((v.type as unknown as { name?: unknown }).name);
      if (tn && !v.specifiers.includes('static') && !v.specifiers.includes('extern')) value.set(v.name.name, bareName(tn));
    }
    if (n.kind === NodeKind.VariableDecl) add((n as VariableDecl).name.name, (n as VariableDecl).type);
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      const o = unwrap((n as UnaryExpr).operand);
      if (o.kind === NodeKind.Identifier) addressed.add((o as Identifier).name);
    }
  }
  for (const [k, c] of seen) if (c !== 1) value.delete(k);
  return { pointee, value, addressed };
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
    else name = punnedMember(l);
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

/**
 * `*(T *)&p->f`: the decompiler's line ends in the member's token, which is the name the
 * facts record (`*(undefined4 *)&pMessage->nLineCount = 0`). A store at an offset from it
 * ends in `)` and is never recorded.
 */
function punnedMember(l: Expression): string | null {
  if (l.kind !== NodeKind.UnaryExpr || (l as UnaryExpr).operator !== '*') return null;
  const c = unwrap((l as UnaryExpr).operand);
  if (c.kind !== NodeKind.CStyleCastExpr) return null;
  const a = unwrap((c as CStyleCastExpr).expression);
  if (a.kind !== NodeKind.UnaryExpr || (a as UnaryExpr).operator !== '&') return null;
  const m = unwrap((a as UnaryExpr).operand);
  if (m.kind !== NodeKind.MemberExpr) return null;
  const f = (m as MemberExpr).member;
  return typeof f === 'string' ? f : (f as Identifier).name ?? null;
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

/** A statement mentions the name. */
function mentions(n: ASTNode, name: string): boolean {
  for (const m of traverseAST(n)) if (m.kind === NodeKind.Identifier && (m as Identifier).name === name) return true;
  return false;
}

/** An expression that only reads: no call, assignment or increment. */
function pureRead(e: Expression): boolean {
  for (const m of traverseAST(e)) {
    if (m.kind === NodeKind.CallExpr || m.kind === NodeKind.AssignExpr || m.kind === NodeKind.PostfixExpr) return false;
    if (m.kind === NodeKind.UnaryExpr && ['++', '--'].includes((m as UnaryExpr).operator)) return false;
  }
  return true;
}

/**
 * A clear printed in pieces: a run of zero writes to one object (member stores, stores at
 * a byte offset, a memset of an array member), and after it the member stores that cover
 * what the run leaves out, the stores whose zero VC8 dropped because they are overwritten
 * before any read:
 *
 *   pMemoryStatus->dwMemoryLoad = 0; ...            memset(pMemoryStatus, 0, sizeof(*pMemoryStatus));
 *   pMemoryStatus->dwAvailVirtual = 0;         ->   pMemoryStatus->dwLength = 0x20;
 *   pMemoryStatus->dwLength = 0x20;
 *
 * (GetGlobalMemoryStatus 00410930, SOUNDSMP_InitWaveFormat 00516720, FINDTILE_AddTileToChain
 * 0060cea0; TEXT_AllocScreenMessage 0049db10 and PLAYER_SendInventoryFullMessage 00549a60 with
 * the decompiler's own memset of an array member in the run). The evidence that the original
 * cleared the whole object: through a pointer, the register-store facts tie at least one zero
 * store of the run to a register loaded with zero and none to an immediate; for a stack
 * local, the zero-store facts say its opening stores write zero to every byte.
 *
 * The window after the run is a straight run of whole-member stores `R->m = E` whose E only
 * reads (no call, assignment or increment) and never names R, so nothing between the memset
 * and the store reads the bytes the memset writes and the window does not.
 */
function partialClear(
  list: Statement[], i: number, locals: Locals, reg: Map<string, boolean>, zeroRows: ReadonlyArray<ZeroStoreRow>,
  layouts: NonNullable<PointeeClearMemsetOptions['structLayouts']>, sizes: Record<string, number>, typedefs: Record<string, string>,
): { stmt: Statement; end: number; root: string; type: string } | null {
  const types = new Map<string, string>();
  const lookup = (name: string, arrow: boolean): RootInfo | null => {
    const t = arrow ? (locals.addressed.has(name) ? undefined : locals.pointee.get(name)) : locals.value.get(name);
    if (!t) return null;
    const rt = resolve(t, typedefs);
    const fields = layouts[rt], size = sizes[rt];
    if (!fields || !size) return null;
    types.set(name, rt);
    return { fields, size };
  };
  const elem = (st: Statement): { span: Span; assign?: AssignExpr } | null => {
    if (st.kind !== NodeKind.ExprStmt) return null;
    const e = unwrap((st as ExprStmt).expression);
    if (e.kind === NodeKind.AssignExpr) {
      const a = e as AssignExpr;
      if (a.operator !== '=' || !isZero(a.right)) return null;
      const sp = lvalueSpan(a.left, lookup);
      return sp ? { span: sp, assign: a } : null;
    }
    if (e.kind === NodeKind.CallExpr) {
      const sp = memsetSpan(e as unknown as import('../../../ast/nodes.js').CallExpr, lookup, isZero);
      return sp ? { span: sp } : null;
    }
    return null;
  };
  const first = elem(list[i]);
  if (!first) return null;
  const { root, arrow } = first.span;
  const info = lookup(root, arrow)!;
  const type = types.get(root)!;
  if (info.size > PARTIAL_INLINE_MAX || info.fields.some(f => f.bitSize)) return null;
  const run: Array<{ span: Span; assign?: AssignExpr }> = [];
  let j = i;
  for (; j < list.length; j++) {
    const x = elem(list[j]);
    if (!x || x.span.root !== root || x.span.arrow !== arrow) break;
    run.push(x);
  }
  const spans = run.map(r => r.span);
  if (!disjoint(spans) || spans.some(sp => sp.start < 0 || sp.start + sp.size > info.size)) return null;
  // Pointers of the same pointee type might reach the same object: the window must not read them.
  const peers = arrow ? [...locals.pointee].filter(([n, t]) => n !== root && resolve(t, typedefs) === type).map(([n]) => n) : [];
  const window: Span[] = [];
  for (let k = j; k < list.length; k++) {
    const st = list[k];
    if (st.kind !== NodeKind.ExprStmt) break;
    const e = unwrap((st as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') break;
    const a = e as AssignExpr;
    const m = memberSpan(a.left, lookup);
    if (!m || m.root !== root || m.arrow !== arrow || m.size > 4 || /\[/.test(m.field.type)) break;
    if (!pureRead(a.right) || mentions(a.right, root) || peers.some(p => mentions(a.right, p))) break;
    window.push(m);
  }
  const all = [...spans, ...window];
  if (!info.fields.every(f => f.size <= 0 || covers(all, f.offset, f.offset + f.size))) return null;
  if (arrow) {
    let tied = 0;
    for (const r of run) {
      if (!r.assign) continue;
      const k = key(r.assign);
      const v = k ? reg.get(k) : undefined;
      if (v === false) return null;
      if (v === true) tied++;
    }
    if (tied === 0) return null;
  } else {
    const z = zeroRows.find(r => r.name === root);
    if (!z || z.size !== info.size || !covers(z.zero.map(([a, b]) => ({ start: a, size: b - a })), 0, info.size)) return null;
  }
  const id = Expr.identifier(root);
  const call = arrow
    ? Expr.call('memset', [id, Expr.intLiteral(0), Expr.sizeof(Expr.deref(cloneNode(id)), false)])
    : Expr.call('memset', [Expr.addressOf(id), Expr.intLiteral(0), Expr.sizeof(cloneNode(id), false)]);
  return { stmt: Stmt.expr(call), end: j, root, type };
}

function createPointeeClearMemsetTransformer(options: PointeeClearMemsetOptions = {}): Transformer {
  const layouts = options.structLayouts ?? {};
  const sizes = options.aggregateSizes ?? {};
  const typedefs = options.typedefTargets ?? {};
  const rows = options.registerStores;
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      const zeroRows = options.zeroStores ?? [];
      if (!fn.body || (!rows?.some(r => r.register && r.value === 0) && zeroRows.length === 0)) return undefined;
      const locals = localsOf(fn, typedefs);
      const reg = registerZeroStores(fn.body, rows ?? []);
      const partial = (list: Statement[], i: number) => partialClear(list, i, locals, reg, zeroRows, layouts, sizes, typedefs);
      let changed = false;
      const inner = createTransformer({
        visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
          const list = block.statements;
          const out: Statement[] = [];
          let edited = false;
          for (let i = 0; i < list.length;) {
            const first = zeroStore(list[i]);
            const type = first ? locals.pointee.get(first.p) : undefined;
            const t = type ? resolve(type, typedefs) : '';
            const layout = layouts[t];
            const size = sizes[t];
            let j = i;
            const fields = new Set<string>();
            const run: AssignExpr[] = [];
            for (; first && j < list.length; j++) {
              const z = zeroStore(list[j]);
              if (!z || z.p !== first.p || fields.has(z.f)) break;
              fields.add(z.f);
              run.push(z.assign);
            }
            const whole = !!first && !!type && !locals.addressed.has(first.p) && !!layout && !!size && size <= MEMSET_INLINE_MAX && run.length >= 2
              && layout.length === fields.size
              && layout.every(f => fields.has(f.name) && !f.bitSize && f.size <= 4)
              && run.every(a => { const k = key(a); return !!k && reg.get(k) === true; });
            if (!whole) {
              const pc = partial(list, i);
              if (!pc) { out.push(list[i++]); continue; }
              pc.stmt.location = list[i].location;
              (pc.stmt as unknown as { leadingTrivia: unknown }).leadingTrivia = list[i].leadingTrivia;
              out.push(pc.stmt);
              options.onSite?.({ pointer: pc.root, type: pc.type, members: pc.end - i, partial: true });
              i = pc.end;
              edited = true;
              continue;
            }
            const p = Expr.identifier(first!.p);
            const call = Expr.call('memset', [p, Expr.intLiteral(0), Expr.sizeof(Expr.deref(cloneNode(p)), false)]);
            const stmt = Stmt.expr(call);
            stmt.location = list[i].location;
            (stmt as unknown as { leadingTrivia: unknown }).leadingTrivia = list[i].leadingTrivia;
            out.push(stmt);
            options.onSite?.({ pointer: first!.p, type: t, members: run.length });
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
