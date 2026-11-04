/**
 * CRT Intrinsic Call Plugin
 *
 * The binary's x87 math helpers `_CIpow`, `_CIlog`, `_CIlog10`, `_CIsin`, `_CIcos` and
 * `_CIsqrt` (00687c10, 00687ac0, 00687ea0, 00688590, 006886c0, 006879c0) take their operands
 * on the FPU stack. No source calls them by name: they are what VC8 emits for `pow`, `log`,
 * `log10`, `sin`, `cos` and `sqrt` from <math.h> under /Oi, which /O2 implies (a probe with
 * the oracle's flags compiles `pow((double)a, (double)b)` to `fld; fld; call __CIpow`, and
 * the other five to their `__CI*` helper the same way).
 *
 * Ghidra names the helpers (CRT_CIPow ... __CIsqrt) and gives them `float10` operands, so a
 * call site prints `CRT_CIPow((float10)dwLinearValue, (float10)dwScale)`. Compiled as
 * written that is a cdecl call with the operands pushed on the stack, which the original
 * never makes (SOUNDSMP_LinearToLogVolume 00516590). The call is written as the <math.h>
 * function it came from, each operand as a double:
 *
 *     CRT_CIPow((long double)x, (long double)y)  ->  pow((double)x, (double)y)
 *     CRT_CISin((long double)(double)x)          ->  sin((double)x)
 *     __CIsqrt(e)                                ->  sqrt((double)(e))
 *
 * Value-preserving for VC8, whose `long double` is `double`: the operands were doubles in
 * the original and the helper computes the function. In the rebuild the <cmath> function
 * runs in double where the CRT_CI* shim ran in 80-bit precision, which is the precision the
 * original's x87 control word (53-bit mantissa) gave it.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BuiltinType, CallExpr, CStyleCastExpr, Expression, Identifier, ParenExpr, TypedefType,
} from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { createTransformer, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

/** Ghidra's name of each helper -> the <math.h> function VC8 lowers to it, and its arity. */
export const CRT_INTRINSICS: ReadonlyMap<string, { fn: string; arity: number }> = new Map([
  ['CRT_CIPow', { fn: 'pow', arity: 2 }],
  ['CRT_CILog', { fn: 'log', arity: 1 }],
  ['CRT_CILog10', { fn: 'log10', arity: 1 }],
  ['CRT_CISin', { fn: 'sin', arity: 1 }],
  ['CRT_CICos', { fn: 'cos', arity: 1 }],
  ['__CIsqrt', { fn: 'sqrt', arity: 1 }],
]);

export interface CrtIntrinsicCallOptions extends PluginOptions {
  onSite?: (e: { line: number; from: string; to: string }) => void;
}

function calleeName(e: Expression): string | null {
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  if (e.kind === NodeKind.QualifiedId) {
    const q = e as unknown as { parts?: string[]; isGlobal?: boolean };
    if (q.parts && q.parts.length === 1) return q.parts[0];
  }
  return null;
}

/** `long double` / `float10` / `double` as a builtin or typedef spelling, else null. */
function floatKind(t: ASTNode): 'long double' | 'double' | null {
  if (t.kind === NodeKind.BuiltinType) {
    const b = t as BuiltinType;
    if (b.name === 'long double' && b.modifiers.every(m => m === 'const')) return 'long double';
    if (b.name !== 'double') return null;
    const extra = b.modifiers.filter(m => m !== 'const');
    if (extra.length === 0) return 'double';
    if (extra.length === 1 && extra[0] === 'long') return 'long double';
    return null;
  }
  // type-normalize renames Ghidra's `float10` to a typedef spelling `long double`.
  if (t.kind === NodeKind.TypedefType) {
    const n = (t as TypedefType).name as unknown as string | { name: string };
    if (['float10', 'long double'].includes(typeof n === 'string' ? n : n.name)) return 'long double';
  }
  return null;
}

/** The operand as a double: outer casts to long double or double dropped, one `(double)` put back. */
function asDouble(arg: Expression): Expression {
  let e = arg;
  for (;;) {
    while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
    if (e.kind !== NodeKind.CStyleCastExpr) break;
    const c = e as CStyleCastExpr;
    if (!floatKind(c.type)) break;
    e = c.expression;
  }
  const inner = cloneNode(e);
  const primary = inner.kind === NodeKind.Identifier || inner.kind === NodeKind.MemberExpr ||
    inner.kind === NodeKind.CallExpr || inner.kind === NodeKind.SubscriptExpr ||
    inner.kind === NodeKind.FloatingLiteral || inner.kind === NodeKind.IntegerLiteral;
  return Expr.cast(Type.double(), primary ? inner : Expr.paren(inner));
}

export const crtIntrinsicCallPlugin: TransformPlugin = {
  id: 'crt-intrinsic-call',
  name: 'CRT Intrinsic Call',
  description: 'A call of an x87 _CI* math helper is written as the <math.h> function VC8 lowers to it',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 59.66,
  tags: ['matching'],
  createTransformer: (options: CrtIntrinsicCallOptions = {}): Transformer => createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind !== NodeKind.CallExpr) return undefined;
      const call = node as CallExpr;
      const name = calleeName(call.callee);
      const m = name ? CRT_INTRINSICS.get(name) : undefined;
      if (!m || call.arguments.length !== m.arity) return undefined;
      const out = Expr.call(m.fn, call.arguments.map(asDouble));
      out.location = node.location;
      options.onSite?.({ line: node.location?.start.line ?? 0, from: name!, to: m.fn });
      return out;
    },
  }),
};
