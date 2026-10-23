/**
 * Checks about RAW ADDRESSES in code: an original 1.14d address written as a number where the
 * rebuilt program needs a reference to the object.
 */

import { NodeKind } from '@ghidra-mcp/cpp-parser';
import { isCast, isPointerType, line, signature, unparen } from '../ast.js';
import type { Check, Finding } from '../context.js';
import { addressTargetResolver, literalValue } from './initializers.js';

/**
 * An integer literal handed to a callee, or cast to a pointer, whose value is the original
 * address of a global the tree defines.
 *
 * `SCMD_ClearList(0x74c498);` compiles and links when the callee's parameter is an integer.
 * In the rebuilt image 0x74c498 is not `gStormCmdListHeadSlash` - it is whatever the new link
 * put there, or nothing - and the callee walks it as a list head. Ghidra prints a pushed
 * address as a number whenever the parameter it lands in is typed as an integer, so the fix is
 * the callee's parameter type in Ghidra; the site then emits `&name`.
 *
 * Sites: every argument of every call in a function body, through parentheses and casts, and
 * every pointer cast of a literal anywhere in a body. The value must be the start address of
 * exactly one Windows symbol whose name no other Windows symbol carries and which the tree
 * defines - the same target rule as raw-address-initializer - and the literal must be written
 * in hex, the way Ghidra prints an address: `__aulldiv(t, 10000000, 0)` passes 0x989680, which
 * is also a global's address. An interior address (head + 4) is not reported here.
 */
export const rawAddressArgument: Check = {
  id: 'raw-address-argument',
  blurb: "call argument or pointer cast holds the original address of a global the tree defines",
  run(ctx) {
    const out: Finding[] = [];
    if (!ctx.snapshot) return out;
    const targetOf = addressTargetResolver(ctx);

    for (const fn of ctx.tree.functions) {
      if (fn.file.isHeader) continue;
      const seen = new Set<any>();
      const report = (lit: any, how: string) => {
        // Ghidra prints an address in hex; a decimal literal is a count that merely coincides.
        if (seen.has(lit) || lit.base !== 16) return;
        const v = literalValue(lit);
        if (v === null) return;
        const target = targetOf(v);
        if (!target) return;
        seen.add(lit);
        out.push({
          check: this.id, file: fn.file.path, line: line(lit), fn: fn.qualifiedName, subject: target,
          detail: `${how} 0x${v.toString(16).padStart(8, '0')}, the original address of '${target}' - should be &${target}`,
          sig: signature(lit),
        });
      };

      for (const c of ctx.of(fn, NodeKind.CallExpr)) {
        for (const a of c.arguments ?? []) {
          let e = unparen(a);
          while (e && isCast(e)) e = unparen(e.expression);
          if (e?.kind === NodeKind.IntegerLiteral) report(e, 'passes');
        }
      }
      for (const kind of [NodeKind.CStyleCastExpr, NodeKind.StaticCastExpr, NodeKind.ReinterpretCastExpr]) {
        for (const c of ctx.of(fn, kind)) {
          if (!isPointerType(c.type)) continue;
          const e = unparen(c.expression);
          if (e?.kind === NodeKind.IntegerLiteral) report(e, 'casts');
        }
      }
    }
    return out;
  },
};
