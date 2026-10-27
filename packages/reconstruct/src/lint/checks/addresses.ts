/**
 * Checks about RAW ADDRESSES in code: an original 1.14d address written as a number where the
 * rebuilt program needs a reference to the object.
 */

import { NodeKind } from '@ghidra-mcp/cpp-parser';
import { isCast, isPointerType, line, signature, unparen } from '../ast.js';
import type { Check, Finding } from '../context.js';
import { addressTargetResolver, definedDataNames, inImage, literalValue } from './initializers.js';

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

/** One set bit, or one bit short of a power of two: a mask, whatever it collides with. */
function isMaskShaped(v: number): boolean {
  if (v <= 0) return false;
  return ((v & (v - 1)) >>> 0) === 0 || (((v + 1) & v) >>> 0) === 0;
}

/**
 * A hex literal operand of integer `+` or `-` (or `+=`/`-=`) that is an address inside a
 * global the tree defines.
 *
 * `pSrc[pGameNameOut - 0x799294] = ch;` is a copy loop's `dst - src`: the decompiler folded
 * the source buffer's address into the constant. It compiles, and in the rebuild the
 * distance is from a buffer that is no longer at 0x799294, so the copy writes to a dead
 * address. The `global-address-literal` pass spells such an operand `(intptr_t)&member`
 * when it lies in a data block; this reports what is left.
 *
 * The value must lie in a data block (when the snapshot records them), not be mask-shaped,
 * and be the start of exactly one Windows symbol, or inside exactly one whose extent is an
 * array or wider than a word, or - inside none - one byte below exactly one symbol's start,
 * whose name the tree defines. A negated operand (`-0x730520 - p`) counts the same.
 */
export const rawAddressArithmetic: Check = {
  id: 'raw-address-arithmetic',
  blurb: "integer + or - operand holds an original address inside a global the tree defines",
  run(ctx) {
    const out: Finding[] = [];
    const snap = ctx.snapshot;
    if (!snap) return out;
    const defined = definedDataNames(ctx);
    const sections = snap.dataSections ?? null;
    const inData = (v: number) => sections === null || sections.some(([s, e]) => v >= s && v < e);
    const ownerOf = (v: number): { name: string; offset: number } | null => {
      const bases = snap.globals.filter(g => g.address === v);
      if (bases.length === 1) return { name: bases[0]!.name, offset: 0 };
      if (bases.length > 1) return null;
      const inside = snap.globals.filter(g =>
        v > g.address && v < g.address + g.size && (g.size > 4 || g.dataType.includes('[')));
      if (inside.length === 1) return { name: inside[0]!.name, offset: v - inside[0]!.address };
      // In no extent and one below a symbol's start: a byte copy's biased source.
      if (snap.globals.some(g => v >= g.address && v < g.address + g.size)) return null;
      const next = snap.globals.filter(g => g.address === v + 1);
      return next.length === 1 ? { name: next[0]!.name, offset: -1 } : null;
    };

    for (const fn of ctx.tree.functions) {
      if (fn.file.isHeader) continue;
      const seen = new Set<any>();
      const consider = (operand: any) => {
        let lit = unparen(operand);
        if (lit?.kind === NodeKind.UnaryExpr && lit.operator === '-') lit = unparen(lit.operand);
        if (lit?.kind !== NodeKind.IntegerLiteral || lit.base !== 16 || seen.has(lit)) return;
        const v = literalValue(lit);
        if (v === null || !inImage(v) || !inData(v) || isMaskShaped(v)) return;
        const owner = ownerOf(v);
        if (!owner || !defined.has(owner.name)) return;
        seen.add(lit);
        const at = owner.offset === 0 ? owner.name : `${owner.name} ${owner.offset < 0 ? '-' : '+'} ${Math.abs(owner.offset)}`;
        out.push({
          check: this.id, file: fn.file.path, line: line(lit), fn: fn.qualifiedName, subject: owner.name,
          detail: `adds or subtracts 0x${v.toString(16).padStart(8, '0')}, the original address of ${at} - should be (intptr_t)&${owner.name}...`,
          sig: signature(lit),
        });
      };
      for (const b of ctx.of(fn, NodeKind.BinaryExpr)) {
        if (b.operator !== '+' && b.operator !== '-') continue;
        if (unparen(b.left)?.kind === NodeKind.IntegerLiteral && unparen(b.right)?.kind === NodeKind.IntegerLiteral) continue;
        consider(b.left);
        consider(b.right);
      }
      for (const a of ctx.of(fn, NodeKind.AssignExpr)) {
        if (a.operator === '+=' || a.operator === '-=') consider(a.right);
      }
    }
    return out;
  },
};
