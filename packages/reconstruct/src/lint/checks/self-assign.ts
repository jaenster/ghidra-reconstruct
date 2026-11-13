/**
 * A store of a value into the place it was read from: `x = x;`, `s.f = s.f;`, `p->a[i] = p->a[i];`.
 *
 * The compiler accepts it and emits nothing, so whatever the original wrote there is gone. Two
 * species reach the tree. A parameter or local that shares its name with a global binds the
 * name in the function scope, so `nScaleFactor = nScaleFactor;` stores the parameter into itself
 * and the global is never written (D2Glide/D2Direct3D UpdateScaleFactor, D2GFX_Initialize). A
 * copy between two variables the generator folded into one (a vc8form fold, a Ghidra phi copy
 * of a struct field) leaves a harmless no-op. The first is a runtime defect, the second noise
 * that still hides the first, so every site is reported and the detail says which it looks like.
 */

import { NodeKind } from '@ghidra-mcp/cpp-parser';
import type { Check, Finding } from '../context.js';
import { line, refName, signature, unparen } from '../ast.js';

export const SELF_ASSIGNMENT_CHECK_ID = 'self-assignment';

/**
 * An lvalue whose evaluation has no side effect, so reading it twice reads the same place:
 * a name, a member of one, an element at a side-effect-free index, a dereference of one.
 */
function pureLvalue(e: any, depth = 0): boolean {
  const x = unparen(e);
  if (!x || depth > 20) return false;
  switch (x.kind) {
    case NodeKind.Identifier:
    case NodeKind.QualifiedId:
      return true;
    case NodeKind.MemberExpr:
      return pureLvalue(x.object, depth + 1);
    case NodeKind.SubscriptExpr:
      return pureLvalue(x.array, depth + 1) && pureIndex(x.index, depth + 1);
    case NodeKind.UnaryExpr:
      return x.operator === '*' && pureLvalue(x.operand, depth + 1);
    default:
      return false;
  }
}

const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '<<', '>>', '&', '|', '^']);

function pureIndex(e: any, depth: number): boolean {
  const x = unparen(e);
  if (!x) return false;
  if (x.kind === NodeKind.IntegerLiteral || x.kind === NodeKind.CharLiteral) return true;
  if (x.kind === NodeKind.BinaryExpr && ARITHMETIC.has(String(x.operator))) {
    return pureIndex(x.left, depth + 1) && pureIndex(x.right, depth + 1);
  }
  return pureLvalue(x, depth);
}

/** The source text of a pure lvalue, for the finding's subject: `sPacket.nReserved`, `*pFlag`. */
function lvalueText(e: any): string {
  const x = unparen(e);
  switch (x?.kind) {
    case NodeKind.Identifier: return x.name;
    case NodeKind.QualifiedId:
      return (x.isGlobal ? '::' : '') + [...(x.qualifier ?? []).map((q: any) => q?.name?.name ?? q?.name), x.name?.name].join('::');
    case NodeKind.MemberExpr: return `${lvalueText(x.object)}${x.isArrow ? '->' : '.'}${x.member?.name ?? '?'}`;
    case NodeKind.SubscriptExpr: return `${lvalueText(x.array)}[${lvalueText(x.index)}]`;
    case NodeKind.UnaryExpr: return `*${lvalueText(x.operand)}`;
    case NodeKind.IntegerLiteral: return String(x.raw ?? x.value);
    case NodeKind.BinaryExpr: return `${lvalueText(x.left)} ${x.operator} ${lvalueText(x.right)}`;
    default: return '?';
  }
}

export const selfAssignment: Check = {
  id: SELF_ASSIGNMENT_CHECK_ID,
  blurb: 'a value stored into the place it was read from - a shadowed global never written, or a folded copy',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      if (!(fn.node as any).body) continue;
      for (const a of ctx.of(fn, NodeKind.AssignExpr)) {
        if (a.operator !== '=') continue;
        const left = unparen(a.left);
        const right = unparen(a.right);
        if (!pureLvalue(left) || !pureLvalue(right)) continue;
        const sig = signature(left);
        if (sig !== signature(right)) continue;
        const name = refName(left);
        const r = name ? ctx.resolve(fn, left) : null;
        const shadowed = !!name && (r?.kind === 'param' || r?.kind === 'local') && ctx.tree.globals.has(name);
        const subject = lvalueText(left);
        out.push({
          check: this.id, file: fn.file.path, line: line(a), fn: fn.qualifiedName, subject,
          detail: shadowed
            ? `the ${r!.kind} ${name} shadows the global of the same name: the store never reaches the global`
            : `a no-op store of ${subject} into itself: a folded or phi copy, or a lost value`,
          sig,
        });
      }
    }
    return out;
  },
};
