/**
 * Typed memory regions: which part of which aggregate an access through a pointer reaches,
 * and whether two such parts may share bytes.
 *
 * An access through a pointer whose declared type is `S *`, S a struct or union of the
 * model, touches an S object: `p->f` the bytes of field f, `*p` and `p[i]` a whole S. Two
 * accesses may touch the same bytes only when they name the same aggregate at overlapping
 * field offsets, or when one aggregate holds the other by value (a field, an array of
 * them, a union member), at the field that holds it. Everything else is apart: an S object
 * is not a T object. A store through `char *`, `void *`, an integer cast to a pointer, a
 * pointer to a scalar, or an aggregate the model does not lay out is untyped and may touch
 * anything.
 *
 * The types are the decompile's, so the rule is only as good as Ghidra's typing. What it
 * trusts is kept narrow for that reason: a declared parameter, global or field, or a local
 * no assignment converts into its type with a cast.
 *
 * A region is spelled `S` (the whole object) or `S.f` (field f of it).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  BinaryExpr, CStyleCastExpr, Expression, Identifier, MemberExpr, ParenExpr, SubscriptExpr, UnaryExpr,
} from '../../../ast/nodes.js';
import { bareName, shapeOfNode, shapeOfSpelling, type TypeShape, type TypedefResolver } from './call-arg-cast.js';

export interface AggregateField { name: string; offset: number; size: number; type: string }

/** The model's aggregates: struct and union layouts by name. */
export interface AggregateModel {
  layouts: Record<string, readonly AggregateField[]>;
  unions?: readonly string[];
  sizes?: Record<string, number>;
  typedefs?: Record<string, string>;
}

/** Widths of the scalars a byte-offset access may be cast to. */
const SCALAR_WIDTHS: Record<string, number> = {
  'char': 1, 'signed char': 1, 'unsigned char': 1, 'bool': 1,
  'short': 2, 'unsigned short': 2, 'wchar_t': 2,
  'int': 4, 'unsigned int': 4, 'long': 4, 'unsigned long': 4, 'float': 4,
};

export class Regions {
  private readonly within = new Map<string, boolean>();
  readonly resolve: TypedefResolver;

  constructor(private readonly model: AggregateModel) {
    const t = model.typedefs ?? {};
    this.resolve = name => t[name];
  }

  /** The aggregate a base type spelling names, through typedefs; null for anything else. */
  aggregate(base: string): string | null {
    let b = bareName(base.replace(/^(struct|union|const)\s+/, '').trim());
    for (let depth = 0; depth < 8; depth++) {
      const fields = this.model.layouts[b];
      if (fields) return fields.length > 0 ? b : null;
      const under = this.model.typedefs?.[b];
      if (!under || under.includes('*') || under.includes('[')) return null;
      b = bareName(under.replace(/^(struct|union|const)\s+/, '').trim());
    }
    return null;
  }

  /** The aggregate a pointer of shape `s` points at, or null. */
  pointee(s: TypeShape | null): string | null {
    return s && s.stars === 1 ? this.aggregate(s.base) : null;
  }

  field(agg: string, name: string): AggregateField | undefined {
    return this.model.layouts[agg]?.find(f => f.name === name);
  }

  size(agg: string): number | undefined {
    return this.model.sizes?.[agg];
  }

  /** The aggregate a field holds by value (itself or as array elements), or null. */
  private embedded(f: AggregateField): string | null {
    const s = f.type.replace(/\[[^\]]*\]/g, '').trim();
    if (s.includes('*') || s.includes('(')) return null;
    const a = this.aggregate(s);
    if (a) return a;
    // A typedef to an array of an aggregate.
    const under = this.model.typedefs?.[s];
    if (under && !under.includes('*')) return this.aggregate(under.replace(/\[[^\]]*\]/g, '').trim());
    return null;
  }

  /** Whether an `inner` object can lie inside an `outer` one. */
  holds(outer: string, inner: string): boolean {
    const key = `${outer}\u0000${inner}`;
    const known = this.within.get(key);
    if (known !== undefined) return known;
    this.within.set(key, false);
    let r = false;
    for (const f of this.model.layouts[outer] ?? []) {
      const e = this.embedded(f);
      if (e && (e === inner || this.holds(e, inner))) { r = true; break; }
    }
    this.within.set(key, r);
    return r;
  }

  /** Whether field `f` of `outer` can hold an `inner` object. */
  private fieldHolds(outer: string, f: string, inner: string): boolean {
    const fd = this.field(outer, f);
    if (!fd) return true;
    const e = this.embedded(fd);
    return !!e && (e === inner || this.holds(e, inner));
  }

  /** Whether regions `a` and `b` may share a byte. */
  overlap(a: string, b: string): boolean {
    const [s, f] = split(a);
    const [t, g] = split(b);
    if (s === t) {
      if (!f || !g || f === g) return true;
      const x = this.field(s, f), y = this.field(t, g);
      if (!x || !y || x.size <= 0 || y.size <= 0) return true;
      return x.offset < y.offset + y.size && y.offset < x.offset + x.size;
    }
    if (this.holds(s, t)) return !f || this.fieldHolds(s, f, t);
    if (this.holds(t, s)) return !g || this.fieldHolds(t, g, s);
    return false;
  }

  /** Whether some region of `a` may share a byte with some region of `b`; null is untyped. */
  overlapAny(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean {
    if (a === null || b === null) return true;
    for (const x of a) for (const y of b) if (this.overlap(x, y)) return true;
    return false;
  }
}

function split(r: string): [string, string | null] {
  const i = r.indexOf('.');
  return i < 0 ? [r, null] : [r.slice(0, i), r.slice(i + 1)];
}

/** How a body's names are typed for the region rules. */
export interface TypingEnv {
  /** A name's declared type where it may be trusted, else null. */
  nameType(e: Expression): TypeShape | null;
  /**
   * For an integer local that holds a pointer's value: that pointer expression, when the
   * local is assigned it exactly once before any use; else null.
   */
  pointerHeld?(e: Identifier): Expression | null;
}

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function memberName(m: MemberExpr): string | null {
  return m.member.kind === NodeKind.Identifier ? (m.member as Identifier).name : null;
}

/** The type of a pointer-valued expression, where the rules can tell it; else null. */
export function typeOf(e: Expression, env: TypingEnv, R: Regions): TypeShape | null {
  const u = unwrapParens(e);
  switch (u.kind) {
    case NodeKind.Identifier: case NodeKind.QualifiedId:
      return env.nameType(u);
    case NodeKind.MemberExpr: {
      const m = u as MemberExpr;
      const o = typeOf(m.object, env, R);
      const agg = m.isArrow ? R.pointee(o) : o && o.stars === 0 ? R.aggregate(o.base) : null;
      const name = memberName(m);
      if (!agg || !name) return null;
      const f = R.field(agg, name);
      return f ? shapeOfSpelling(f.type, R.resolve) : null;
    }
    case NodeKind.UnaryExpr: {
      const x = u as UnaryExpr;
      if (x.operator === '*') {
        const t = typeOf(x.operand, env, R);
        return t && t.stars > 0 ? { ...t, stars: t.stars - 1 } : null;
      }
      if (x.operator === '&') {
        const o = unwrapParens(x.operand);
        // The address of an array is not a pointer to its element.
        if (o.kind === NodeKind.MemberExpr) {
          const m = o as MemberExpr;
          const agg = m.isArrow ? R.pointee(typeOf(m.object, env, R)) : null;
          const name = memberName(m);
          const f = agg && name ? R.field(agg, name) : undefined;
          if (!f || f.type.includes('[')) return null;
          const t = shapeOfSpelling(f.type, R.resolve);
          return t ? { ...t, stars: t.stars + 1 } : null;
        }
        return null;
      }
      return null;
    }
    case NodeKind.SubscriptExpr: {
      const t = typeOf((u as SubscriptExpr).array, env, R);
      return t && t.stars > 0 ? { ...t, stars: t.stars - 1 } : null;
    }
    case NodeKind.BinaryExpr: {
      const b = u as BinaryExpr;
      if (b.operator !== '+' && b.operator !== '-') return null;
      const l = typeOf(b.left as Expression, env, R);
      if (!l || l.stars === 0) return null;
      const r = unwrapParens(b.right as Expression);
      return r.kind === NodeKind.IntegerLiteral ? l : null;
    }
    default:
      return null;
  }
}

/** An integer address as aggregate plus byte offset: `(int)pS + 0x10`. */
function byteAddress(e: Expression, env: TypingEnv, R: Regions): { agg: string; offset: bigint } | null {
  const u = unwrapParens(e);
  if (u.kind === NodeKind.Identifier && env.pointerHeld) {
    const p = env.pointerHeld(u as Identifier);
    const agg = p ? R.pointee(typeOf(p, env, R)) : null;
    return agg ? { agg, offset: 0n } : null;
  }
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '+') {
    const b = u as BinaryExpr;
    const r = unwrapParens(b.right as Expression);
    if (r.kind !== NodeKind.IntegerLiteral) return null;
    const base = byteAddress(b.left as Expression, env, R);
    return base ? { agg: base.agg, offset: base.offset + (r as unknown as { value: bigint }).value } : null;
  }
  return null;
}

/**
 * The region an lvalue reached through a pointer designates (`p->f`, `p->a.b`, `p[i]`,
 * `*p`, `p->arr[i]`, `*(T *)((int)pS + c)` inside an S); null when untyped.
 */
export function regionOf(e: Expression, env: TypingEnv, R: Regions): string | null {
  const u = unwrapParens(e);
  switch (u.kind) {
    case NodeKind.MemberExpr: {
      const m = u as MemberExpr;
      if (!m.isArrow) return regionOf(m.object, env, R);
      const agg = R.pointee(typeOf(m.object, env, R));
      const name = memberName(m);
      if (!agg || !name) return null;
      return R.field(agg, name) ? `${agg}.${name}` : agg;
    }
    case NodeKind.SubscriptExpr: {
      const s = u as SubscriptExpr;
      const base = unwrapParens(s.array);
      if (base.kind === NodeKind.MemberExpr) {
        // An array member is part of the object holding it.
        const m = base as MemberExpr;
        const o = typeOf(m.object, env, R);
        const agg = m.isArrow ? R.pointee(o) : o && o.stars === 0 ? R.aggregate(o.base) : null;
        const name = memberName(m);
        const f = agg && name ? R.field(agg, name) : undefined;
        if (f && f.type.includes('[')) return regionOf(base, env, R);
      }
      return R.pointee(typeOf(s.array, env, R));
    }
    case NodeKind.UnaryExpr: {
      const x = u as UnaryExpr;
      if (x.operator !== '*') return null;
      const direct = R.pointee(typeOf(x.operand, env, R));
      if (direct) return direct;
      const op = unwrapParens(x.operand);
      if (op.kind !== NodeKind.CStyleCastExpr) return null;
      const c = op as CStyleCastExpr;
      const to = shapeOfNode(c.type, 0, R.resolve);
      const width = to && to.stars === 1 ? SCALAR_WIDTHS[to.base] : undefined;
      if (!width) return null;
      const at = byteAddress(c.expression, env, R);
      const size = at ? R.size(at.agg) : undefined;
      if (!at || size === undefined || at.offset < 0n || at.offset + BigInt(width) > BigInt(size)) return null;
      return at.agg;
    }
    default:
      return null;
  }
}
