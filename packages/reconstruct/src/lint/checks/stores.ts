/**
 * Values the emitted code computes and then loses: a constant converted where its bits were
 * meant, a field store that a later memset of the whole object overwrites.
 */

import { NodeKind, type ASTNode } from '@ghidra-mcp/cpp-parser';
import type { Check, Finding } from '../context.js';
import { calleeName, isCast, line, refName, signature, strip, typeText, unparen, walk } from '../ast.js';

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

/** The variable a memset clears: `memset(&x, ...)`, `memset(x, ...)`. */
function memsetTarget(s: any): { name: string; call: any } | null {
  if (s?.kind !== NodeKind.ExprStmt) return null;
  const c = unparen(s.expression);
  if (c?.kind !== NodeKind.CallExpr || calleeName(c.callee) !== 'memset') return null;
  const dst = strip(c.arguments?.[0]);
  if (!dst) return null;
  const name = dst.kind === NodeKind.UnaryExpr && dst.operator === '&' ? refName(strip(dst.operand)) : refName(dst);
  return name ? { name, call: c } : null;
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
 */
export const fieldSetThenMemset: Check = {
  id: 'field-set-then-memset',
  blurb: 'a field store that a later memset of the same object overwrites unread',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      for (const block of ctx.of(fn, NodeKind.CompoundStmt)) {
        const stmts: any[] = block.statements ?? [];
        stmts.forEach((s, i) => {
          if (s?.kind !== NodeKind.ExprStmt) return;
          const a = unparen(s.expression);
          if (a?.kind !== NodeKind.AssignExpr || !storesInto(a.left)) return;
          const name = storeRoot(a.left);
          if (!name || mentionsName(a.right, name)) return;
          for (let j = i + 1; j < stmts.length; j++) {
            const m = memsetTarget(stmts[j]);
            if (m && m.name === name) {
              const nameArgs = (m.call.arguments ?? []).slice(1);
              if (nameArgs.some((x: any) => mentionsName(x, name) && !isSizeofOf(x, name))) break;
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
