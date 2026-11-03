/**
 * Values the emitted code computes and then loses: a constant converted where its bits were
 * meant, a field store that a later memset of the whole object overwrites.
 */

import { NodeKind, type ASTNode } from '@ghidra-mcp/cpp-parser';
import type { Check, Finding, LintContext } from '../context.js';
import type { FunctionInfo } from '../tree.js';
import {
  calleeName, elementType, isArrayType, isCast, line, refName, signature, strip, typeRefName, typeText, typeWidth,
  unparen, walk,
} from '../ast.js';

// -------------------------------------------------------------------------------------------
// double-bit-pattern
// -------------------------------------------------------------------------------------------

const FLOATING = new Set(['double', 'float', 'long double']);

/**
 * An integer literal wider than 32 bits converted to a floating type: `(double)0x3ff0000000000000`.
 *
 * Ghidra prints a double constant it could not type as the integer of its bits; cast to double,
 * the conversion is numeric, so the program runs on 4.6e18 instead of 1.0. A 32-bit game has no
 * reason to convert a 64-bit integer constant to floating point, so every one is a candidate.
 */
export const doubleBitPattern: Check = {
  id: 'double-bit-pattern',
  blurb: 'a 64-bit integer literal cast to a floating type - the bits were meant, not the number',
  run(ctx) {
    const out: Finding[] = [];
    for (const file of ctx.tree.files) {
      walk(file.tu as ASTNode, (n: any) => {
        if (!isCast(n) || !FLOATING.has(typeText(n.type).replace(/\bconst\b/g, '').trim())) return undefined;
        const lit = unparen(n.expression);
        if (lit?.kind !== NodeKind.IntegerLiteral) return undefined;
        const raw = String(lit.raw ?? '');
        if (!/^0[xX]0*[0-9a-fA-F]{9,16}[uUlL]*$/.test(raw)) return undefined;
        const bits = raw.replace(/[uUlL]+$/, '');
        out.push({
          check: this.id, file: file.path, line: line(n), subject: bits,
          detail: `${typeText(n.type)} of the integer ${bits}: converted as a number, not read as the bits of a ${typeText(n.type)}`,
          sig: signature(n),
        });
        return undefined;
      });
    }
    return out;
  },
};

// -------------------------------------------------------------------------------------------
// field-set-then-memset
// -------------------------------------------------------------------------------------------

/** The variable a store target is part of: `x` of `x.a`, `x.a[i].b`, `x->a`, `x[i]`. */
function storeRoot(e: any): string | null {
  let x = strip(e);
  for (;;) {
    if (x?.kind === NodeKind.MemberExpr) x = strip(x.object);
    else if (x?.kind === NodeKind.SubscriptExpr) x = strip(x.array);
    else break;
  }
  return refName(x);
}

/** Whether `e` names anything at all - a part of `x` or `x` itself. */
function storesInto(e: any): boolean {
  const x = strip(e);
  return x?.kind === NodeKind.MemberExpr || x?.kind === NodeKind.SubscriptExpr;
}

/** The variable a memset clears: `memset(&x, ...)`, `memset(x, ...)`, `memset(x.a, ...)`, `memset(x + 4, ...)`. */
function memsetTarget(s: any): { name: string; call: any; whole: boolean } | null {
  if (s?.kind !== NodeKind.ExprStmt) return null;
  const c = unparen(s.expression);
  if (c?.kind !== NodeKind.CallExpr || calleeName(c.callee) !== 'memset') return null;
  let dst = strip(c.arguments?.[0]);
  if (dst?.kind === NodeKind.UnaryExpr && dst.operator === '&') dst = strip(dst.operand);
  const whole = !!refName(dst);
  if (dst?.kind === NodeKind.BinaryExpr && dst.operator === '+') dst = strip(dst.left);
  const name = dst ? storeRoot(dst) : null;
  return name ? { name, call: c, whole } : null;
}

/** A byte range [off, off + size) inside the object a name designates (a pointer's pointee). */
interface ByteRange { off: number; size: number }

/**
 * Where the parts of a variable lie, from the declared type and Ghidra's struct model: the
 * range of `x.f`, `p->f`, `x[k]`, `x.f[k]`, and of a memset destination `&x`, `x`, `x + k`,
 * `&x[k]`, `x.f`. Null wherever a step cannot be measured.
 */
function rangeModel(ctx: LintContext, fn: FunctionInfo) {
  const structs = new Map<string, any | null>();
  for (const st of ctx.snapshot?.structs ?? []) structs.set(st.name, structs.has(st.name) ? null : st);

  /** The struct a type names, directly (`x.f`) or through one pointer (`p->f`, `memset(p)`). */
  const structOf = (t: any, arrow: boolean): any | null => {
    const u = arrow ? elementType(t) : t;
    const n = typeRefName(u);
    return n ? structs.get(n) ?? null : null;
  };
  const constIndex = (e: any): number | null => {
    const v = ctx.value(fn, e);
    return v !== null && Number.isInteger(v) && v >= 0 ? v : null;
  };
  /** The base of a root name: the object itself for a struct or an array, the pointee for a pointer. */
  const rootType = (e: any): any => ctx.exprType(fn, e);

  const field = (m: any): { off: number; size: number; elem: number | null } | null => {
    const obj = strip(m.object);
    if (!refName(obj)) return null;
    const st = structOf(rootType(obj), !!m.isArrow);
    const f = st?.fields?.find((x: any) => x.name === m.member?.name);
    if (!f || typeof f.offset !== 'number' || typeof f.size !== 'number' || f.size <= 0) return null;
    const dim = /\[(\d+)\]$/.exec(String(f.dataType ?? ''));
    const elem = dim && Number(dim[1]) > 0 && f.size % Number(dim[1]) === 0 ? f.size / Number(dim[1]) : null;
    return { off: f.offset, size: f.size, elem };
  };
  const elemWidth = (e: any): number | null => {
    const t = rootType(e);
    const el = t && elementType(t);
    return el ? typeWidth(el, ctx.sizeEnv) : null;
  };

  /** The bytes a store target occupies. */
  const store = (lhs: any): ByteRange | null => {
    const x = strip(lhs);
    if (x?.kind === NodeKind.MemberExpr) return field(x);
    if (x?.kind === NodeKind.SubscriptExpr) {
      const k = constIndex(x.index);
      if (k === null) return null;
      const base = strip(x.array);
      if (refName(base)) {
        const w = elemWidth(base);
        return w ? { off: k * w, size: w } : null;
      }
      if (base?.kind === NodeKind.MemberExpr) {
        const f = field(base);
        return f && f.elem ? { off: f.off + k * f.elem, size: f.elem } : null;
      }
    }
    return null;
  };

  /** Where a memset destination starts. */
  const start = (dst: any): number | null => {
    let d = strip(dst);
    let amp = false;
    if (d?.kind === NodeKind.UnaryExpr && d.operator === '&') { d = strip(d.operand); amp = true; }
    if (refName(d)) return 0;
    if (d?.kind === NodeKind.MemberExpr) {
      // Unaddressed, only an array member decays to its own bytes; a pointer member's are elsewhere.
      const f = field(d);
      return f && (amp || f.elem !== null) ? f.off : null;
    }
    if (d?.kind === NodeKind.SubscriptExpr && amp) return store(d)?.off ?? null;
    if (!amp && d?.kind === NodeKind.BinaryExpr && d.operator === '+') {
      const k = constIndex(d.right);
      const base = strip(d.left);
      if (k === null || !refName(base)) return null;
      const t = rootType(base);
      if (!isArrayType(t) && !elementType(t)) return null;
      const w = elemWidth(base);
      return w ? k * w : null;
    }
    return null;
  };

  return { store, start };
}

function mentionsName(n: any, name: string): boolean {
  let hit = false;
  walk(n, (x: any) => {
    if (hit) return 'skip';
    if (refName(x) === name) hit = true;
    return undefined;
  });
  return hit;
}

/**
 * A store into a part of an object that a later memset of the same object overwrites, with
 * nothing between them reading the object.
 *
 * `s.nType = 3; ... memset(&s, 0, sizeof(s));` leaves nType 0. The original sets the field
 * after clearing; the decompiler (or a pass moving stores) put the two in the other order, and
 * every caller sees the cleared value. Same block only: a branch between them may skip the
 * memset, which is not this.
 *
 * Where both the stored field and the cleared range can be measured (the declared type and
 * Ghidra's struct model), only a memset whose bytes overlap the field's is the defect: a
 * memset of the first five elements does not reach a store into the thirteenth, and one of
 * a struct's leading buckets does not reach its trailing count. Such a memset is passed over
 * like any other statement that does not read the object.
 */
export const fieldSetThenMemset: Check = {
  id: 'field-set-then-memset',
  blurb: 'a field store that a later memset of the same object overwrites unread',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      let model: ReturnType<typeof rangeModel> | null = null;
      for (const block of ctx.of(fn, NodeKind.CompoundStmt)) {
        const stmts: any[] = block.statements ?? [];
        stmts.forEach((s, i) => {
          if (s?.kind !== NodeKind.ExprStmt) return;
          const a = unparen(s.expression);
          if (a?.kind !== NodeKind.AssignExpr || !storesInto(a.left)) return;
          const name = storeRoot(a.left);
          if (!name || mentionsName(a.right, name)) return;
          const ranges = (model ??= rangeModel(ctx, fn));
          const stored = ranges.store(a.left);
          for (let j = i + 1; j < stmts.length; j++) {
            const m = memsetTarget(stmts[j]);
            if (m && m.name === name) {
              const nameArgs = (m.call.arguments ?? []).slice(1);
              if (nameArgs.some((x: any) => mentionsName(x, name) && !isSizeofOf(x, name))) break;
              const from = stored ? ranges.start(m.call.arguments?.[0]) : null;
              const n = from !== null ? ctx.value(fn, m.call.arguments?.[2]) : null;
              const measured = !!stored && from !== null && n !== null;
              // A memset of only a part of the object is the defect only where it is shown to
              // reach the field; one of the whole object reaches every field.
              if (!measured && !m.whole) break;
              if (measured && (from! + n! <= stored!.off || stored!.off + stored!.size <= from!)) continue;
              out.push({
                check: this.id, file: fn.file.path, line: line(s), fn: fn.qualifiedName, subject: name,
                detail: `a store into '${name}' at line ${line(s)} is overwritten by the memset at line ${line(stmts[j])}`,
                sig: `${signature(a)} ${signature(m.call)}`,
              });
              break;
            }
            if (mentionsName(stmts[j], name)) break;
          }
        });
      }
    }
    return out;
  },
};

/** `sizeof(x)` / `sizeof x` of the variable itself: a size, not a read. */
function isSizeofOf(e: any, name: string): boolean {
  const x = strip(e);
  if (x?.kind !== NodeKind.SizeofExpr) return false;
  return x.isType ? typeText(x.operand) === name : refName(strip(x.operand)) === name;
}
