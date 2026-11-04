/**
 * Byte spans of an object that a statement reads or writes, from the struct layout.
 *
 * The decompiler prints a store to part of a struct three ways: as the member (`s.f`,
 * `p->f`), as a pun at a byte offset (`*(uint32_t *)((char *)&s + 4)`,
 * `*(uint16_t *)((uintptr_t)&p->nGold + 1)`), and, for an array member, as a `memset` of
 * it. These helpers turn each into the object it is rooted in and the bytes it covers, so a
 * pass can prove that a run of statements covers a whole object.
 *
 * A root is a name: a pointer (`p->`, `*p`) or an object (`s.`, `&s`). Only one member level
 * is read; a nested member (`s.a.b`) or a variable index is no span.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  BinaryExpr, CallExpr, CStyleCastExpr, Expression, Identifier, IntegerLiteralExpr, MemberExpr,
  ParenExpr, PointerType, SizeofExpr, SubscriptExpr, TypeNode, UnaryExpr,
} from '../../../ast/nodes.js';
import { scalarTypeSize } from './rep-string-form.js';
import { typeNodeName } from './call-arg-cast.js';

export interface LayoutField { name: string; offset: number; size: number; type: string; bitSize?: number }

/** Where a root's bytes are laid out: its type's fields and size. */
export interface RootInfo { fields: ReadonlyArray<LayoutField>; size: number }

/** The bytes [start, start + size) of root, reached through it as a pointer (arrow) or not. */
export interface Span { root: string; arrow: boolean; start: number; size: number }

/** An address into root at byte offset off. */
export interface Address { root: string; arrow: boolean; off: number; field?: LayoutField }

/** Resolves a root name used through `->`/`*` (arrow) or `.`/`&` to its layout. */
export type RootLookup = (name: string, arrow: boolean) => RootInfo | null;

export function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function intValue(e: Expression): number | null {
  const u = unwrap(e);
  return u.kind === NodeKind.IntegerLiteral ? Number((u as IntegerLiteralExpr).value) : null;
}

function memberName(m: MemberExpr): string | null {
  return m.member.kind === NodeKind.Identifier ? (m.member as Identifier).name : null;
}

/** A type node's spelled name: a builtin's string, a named type's identifier. */
function typeName(t: TypeNode): string | undefined {
  const n = (t as unknown as { name?: unknown }).name;
  if (typeof n === 'string') {
    const mods = (t as unknown as { modifiers?: string[] }).modifiers ?? [];
    return [...mods, n].join(' ');
  }
  return typeNodeName(n);
}

/** A cast to a byte pointer or to an integer: arithmetic on it counts bytes. */
function byteCast(t: TypeNode): boolean {
  if (t.kind === NodeKind.PointerType) {
    const n = typeName((t as PointerType).pointee);
    return !!n && /^(char|unsigned char|uchar|byte|BYTE|uint8_t|int8_t|undefined1|undefined)$/.test(n);
  }
  const n = typeName(t);
  return !!n && /^(uintptr_t|intptr_t|int|uint|unsigned|unsigned int|DWORD|UINT|int32_t|uint32_t)$/.test(n);
}

/** Element count of an array spelling `T[K]`; null when not one array extent. */
export function arrayCount(type: string): number | null {
  const m = /\[(\d+)\]$/.exec(type.trim());
  return m && !/\]\s*\[/.test(type) ? Number(m[1]) : null;
}

/** The field covering offset off exactly at its start. */
function fieldAt(info: RootInfo, off: number): LayoutField | undefined {
  return info.fields.find(f => f.offset === off && f.name);
}

/** `R->f` / `R.f` with f a named field of R's layout. */
export function memberSpan(e: Expression, lookup: RootLookup): (Span & { field: LayoutField }) | null {
  const u = unwrap(e);
  if (u.kind !== NodeKind.MemberExpr) return null;
  const m = u as MemberExpr;
  const obj = unwrap(m.object);
  const name = memberName(m);
  if (obj.kind !== NodeKind.Identifier || !name) return null;
  const root = (obj as Identifier).name;
  const info = lookup(root, m.isArrow);
  const field = info?.fields.find(f => f.name === name);
  if (!info || !field || field.bitSize) return null;
  return { root, arrow: m.isArrow, start: field.offset, size: field.size, field };
}

/** The address an expression holds, as root and byte offset. */
export function addressOf(e: Expression, lookup: RootLookup): Address | null {
  const u = unwrap(e);
  if (u.kind === NodeKind.Identifier) {
    const root = (u as Identifier).name;
    const info = lookup(root, true);
    return info ? { root, arrow: true, off: 0, field: fieldAt(info, 0) } : null;
  }
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '&') {
    const o = unwrap((u as UnaryExpr).operand);
    if (o.kind === NodeKind.Identifier) {
      const root = (o as Identifier).name;
      const info = lookup(root, false);
      return info ? { root, arrow: false, off: 0, field: fieldAt(info, 0) } : null;
    }
    const m = memberSpan(o, lookup);
    return m ? { root: m.root, arrow: m.arrow, off: m.start, field: m.field } : null;
  }
  if (u.kind === NodeKind.MemberExpr) {
    // An array member decays to its address.
    const m = memberSpan(u, lookup);
    return m && arrayCount(m.field.type) !== null ? { root: m.root, arrow: m.arrow, off: m.start, field: m.field } : null;
  }
  if (u.kind === NodeKind.CStyleCastExpr) {
    const c = u as CStyleCastExpr;
    if (!byteCast(c.type)) return null;
    const a = addressOf(c.expression, lookup);
    return a ? { root: a.root, arrow: a.arrow, off: a.off } : null;
  }
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '+') {
    const b = u as BinaryExpr;
    const k = intValue(b.right);
    const l = unwrap(b.left);
    if (k === null || l.kind !== NodeKind.CStyleCastExpr || !byteCast((l as CStyleCastExpr).type)) return null;
    const a = addressOf((l as CStyleCastExpr).expression, lookup);
    return a ? { root: a.root, arrow: a.arrow, off: a.off + k } : null;
  }
  return null;
}

/** The bytes an lvalue (or the same expression read) covers: a member, or `*(T *)ADDR`. */
export function lvalueSpan(e: Expression, lookup: RootLookup): Span | null {
  const m = memberSpan(e, lookup);
  if (m) return { root: m.root, arrow: m.arrow, start: m.start, size: m.size };
  const u = unwrap(e);
  if (u.kind !== NodeKind.UnaryExpr || (u as UnaryExpr).operator !== '*') return null;
  const o = unwrap((u as UnaryExpr).operand);
  if (o.kind !== NodeKind.CStyleCastExpr || (o as CStyleCastExpr).type.kind !== NodeKind.PointerType) return null;
  const c = o as CStyleCastExpr;
  const size = scalarTypeSize((c.type as PointerType).pointee);
  if (!size) return null;
  const inner = unwrap(c.expression);
  // `(T *)&s.f`, `(T *)((char *)&s + k)`, `(T *)p`, and a byte cast in between.
  const a = inner.kind === NodeKind.CStyleCastExpr && byteCast((inner as CStyleCastExpr).type)
    ? addressOf((inner as CStyleCastExpr).expression, lookup)
    : addressOf(inner, lookup);
  return a ? { root: a.root, arrow: a.arrow, start: a.off, size } : null;
}

/** The constant byte count of a `memset`/`memcpy` length naming the field it starts at. */
export function lengthOf(e: Expression, field: LayoutField | undefined): number | null {
  const v = intValue(e);
  if (v !== null) return v;
  const u = unwrap(e);
  if (u.kind === NodeKind.SizeofExpr && field) {
    // sizeof(s.f) / sizeof(p->f): the whole field.
    const s = u as SizeofExpr;
    if (!s.isType) {
      const o = unwrap(s.operand as Expression);
      if (o.kind === NodeKind.MemberExpr && memberName(o as MemberExpr) === field.name) return field.size;
    }
    return null;
  }
  if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '*' || !field) return null;
  const b = u as BinaryExpr;
  const k = intValue(b.left);
  const r = unwrap(b.right);
  const n = arrayCount(field.type);
  if (k === null || n === null || r.kind !== NodeKind.SizeofExpr || (r as SizeofExpr).isType) return null;
  // K * sizeof(s.f[0]) over the field's own K elements.
  const o = unwrap((r as SizeofExpr).operand as Expression);
  if (o.kind !== NodeKind.SubscriptExpr || intValue((o as SubscriptExpr).index) !== 0) return null;
  const arr = unwrap((o as SubscriptExpr).array);
  if (arr.kind !== NodeKind.MemberExpr || memberName(arr as MemberExpr) !== field.name) return null;
  return k === n ? field.size : null;
}

/** `memset(ADDR, 0, N)`: the span it clears. */
export function memsetSpan(c: CallExpr, lookup: RootLookup, isZero: (e: Expression) => boolean): Span | null {
  const callee = unwrap(c.callee);
  if (callee.kind !== NodeKind.Identifier || (callee as Identifier).name !== 'memset' || c.arguments.length !== 3) return null;
  if (!isZero(c.arguments[1])) return null;
  const a = addressOf(c.arguments[0], lookup);
  if (!a) return null;
  const n = lengthOf(c.arguments[2], a.field);
  return n && n > 0 ? { root: a.root, arrow: a.arrow, start: a.off, size: n } : null;
}

/** True when the spans together cover every byte of [from, to). */
export function covers(spans: ReadonlyArray<{ start: number; size: number }>, from: number, to: number): boolean {
  const s = [...spans].sort((a, b) => a.start - b.start);
  let at = from;
  for (const x of s) {
    if (x.start > at) break;
    at = Math.max(at, x.start + x.size);
    if (at >= to) return true;
  }
  return at >= to;
}

/** True when no two spans share a byte. */
export function disjoint(spans: ReadonlyArray<{ start: number; size: number }>): boolean {
  const s = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < s.length; i++) if (s[i].start < s[i - 1].start + s[i - 1].size) return false;
  return true;
}
