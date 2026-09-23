/**
 * Checks about CALLS whose shape lost information the machine code had.
 */

import { NodeKind } from '@ghidra-mcp/cpp-parser';
import {
  innermostElement, isArrayType, line, refName, signature, strip, typeRefName, unparen, unqualified, walk,
} from '../ast.js';
import type { Check, Finding } from '../context.js';

/** Is this type `code *`, `code **`, ... - Ghidra's untyped function pointer? */
function isCodePointer(t: any): boolean {
  let u = unqualified(t);
  let depth = 0;
  while (u?.kind === NodeKind.PointerType) { u = unqualified(u.pointee); depth++; }
  return depth > 0 && typeRefName(u) === 'code';
}

/**
 * An indirect call through Ghidra's untyped `code *` made with NO arguments.
 *
 * Ghidra prints a call through an unsignatured pointer as `(**(code **)x)()` even when the
 * machine plainly sets the arguments. `LoadDataForGame` walks a 52-entry init table and
 * loads pIni into ECX before each `CALL EAX`; the table even has a real funcdef element type,
 * but indexing it by byte offset cast it back to `code **`, the parameter vanished, and all
 * 52 client-init callbacks ran with a garbage ECX until ClientInit_Fullscreen read off null.
 *
 * AST: a CallExpr with zero arguments whose callee, through parentheses and dereferences,
 * is a CAST to `code *`/`code **` - or a local declared as one. The regex matched only the
 * two-star `(**(code **)...)()` spelling within 120 characters on one line; the one-star
 * form and a call split across lines are the same class. A hit whose cast operand names a
 * table with a real element type is listed as TYPED TABLE - there the signature is known and
 * only the call spelling dropped it. Most other hits are honest vtable calls.
 */
export const arglessIndirectCall: Check = {
  id: 'argless-indirect-call',
  blurb: 'call through an untyped code* with no arguments - may have dropped real ones',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      for (const c of ctx.of(fn, NodeKind.CallExpr)) {
        if (c.arguments.length) continue;
        let callee = unparen(c.callee);
        while (callee?.kind === NodeKind.UnaryExpr && callee.operator === '*') callee = unparen(callee.operand);
        let viaCast: any = null;
        if (callee?.kind === NodeKind.CStyleCastExpr && isCodePointer(callee.type)) viaCast = callee;
        else if (refName(callee)) {
          const r = ctx.resolve(fn, callee);
          if (!r || !isCodePointer(r.type)) continue;
        } else continue;
        // Does the pointer come out of a table whose element type is a real signature?
        let table: string | null = null;
        if (viaCast) {
          walk(viaCast.expression, (n: any) => {
            if (table) return 'skip';
            const nm = refName(n);
            if (!nm) return undefined;
            const r = ctx.resolve(fn, n);
            if (r && isArrayType(r.type)) {
              const el = innermostElement(r.type);
              if (!(el?.kind === NodeKind.PointerType && isCodePointer(el))) table = nm;
            }
            return undefined;
          });
        }
        const target = viaCast ? strip(viaCast.expression) : callee;
        out.push({
          check: this.id, file: fn.file.path, line: line(c), fn: fn.qualifiedName,
          subject: table ?? refName(target) ?? 'indirect',
          detail: table
            ? `TYPED TABLE ${table}[] called with no arguments`
            : `indirect call with no arguments`,
          sig: signature(c),
        });
      }
    }
    return out;
  },
};
