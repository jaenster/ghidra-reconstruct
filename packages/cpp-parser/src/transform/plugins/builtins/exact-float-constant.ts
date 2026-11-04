/**
 * Exact Float Constant Plugin
 *
 * x87 code has no floating-point immediates: every constant other than the ones
 * FLD1/FLDZ/FLDPI load is read from memory, and the decompiler folds that read into
 * a literal it prints ROUNDED. `CLIENT_AdjustMemoryBudget` (00457300) multiplies by
 * the double at 006cccb0, 2^-20 = 9.5367431640625e-07, and the tree said
 *
 *     fPhysMemMB * 9.536743e-07
 *
 * which C reads as another double. `SOUND_UpdateAllChannels` (004ba020) steps by the
 * double at 006da6b0, 0.05000000074505806 (0.05f widened), printed `0.05`. The
 * rebuild computed with numbers the original never held.
 *
 * The constants are known exactly: the function's own instruction references
 * (operandRefs) name the addresses it reads, and the model values every float datum
 * from its bytes (extract/exact-floats.ts). So a literal is respelled as the value of
 * the one referenced constant it is a rounding of:
 *
 *  - the literal is NOT exactly any referenced constant (an exact literal is the
 *    constant, or an x87 load constant, and is left alone);
 *  - the constant rounded to the literal's own number of significant digits is the
 *    literal's value, compared by magnitude (the sign may be a negation the
 *    decompiler folded in, and is kept as printed);
 *  - exactly one distinct constant value qualifies. Two would be a guess.
 *
 * Without a referenced float constant there is nothing to respell from, and
 * nothing changes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, FloatingLiteralExpr, FunctionDecl } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';

export interface ExactFloatConstantOptions extends PluginOptions {
  /** The float/double data this function's instructions read: exact values. */
  constants?: readonly { name: string; value: number }[];
  onRewrite?: (info: { name: string; from: string; to: string }) => void;
  onRefusal?: (reason: string) => void;
}

/** Significant digits a decimal literal spells (leading and trailing zeros not counted). */
export function significantDigits(raw: string): number | null {
  const m = /^\s*([0-9]*)(?:\.([0-9]*))?(?:[eE][+-]?[0-9]+)?[fFlL]?\s*$/.exec(raw);
  if (!m) return null;
  const digits = `${m[1] ?? ''}${m[2] ?? ''}`.replace(/^0+/, '').replace(/0+$/, '');
  return Math.max(digits.length, 1);
}

/** The shortest decimal that reads back to `v` exactly, kept a floating literal. */
export function exactDecimal(v: number): string {
  const s = String(v);
  return /^-?\d+$/.test(s) ? `${s}.0` : s;
}

export function createExactFloatConstantTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as ExactFloatConstantOptions;
  const constants = (o.constants ?? []).filter(c => Number.isFinite(c.value));
  if (constants.length === 0) return (n: ASTNode) => n;
  const magnitudes = constants.map(c => ({ name: c.name, value: Math.abs(c.value) }));
  const exact = new Set(magnitudes.map(c => c.value));

  function respell(lit: FloatingLiteralExpr): FloatingLiteralExpr | undefined {
    const L = Math.abs(lit.value);
    if (!Number.isFinite(L) || exact.has(L)) return undefined;
    const raw = lit.raw ?? String(lit.value);
    const digits = significantDigits(raw);
    if (digits === null || digits >= 17) return undefined;
    const hits = new Map<number, string>();
    for (const c of magnitudes) {
      if (c.value === 0) continue;
      if (Number.parseFloat(c.value.toPrecision(digits)) === L) hits.set(c.value, c.name);
    }
    if (hits.size !== 1) {
      if (hits.size > 1) o.onRefusal?.(`${raw}: rounds ${[...hits.values()].join(', ')} alike`);
      return undefined;
    }
    const [[value, name]] = [...hits];
    const signed = lit.value < 0 ? -value : value;
    const suffix = /[fFlL]$/.test(raw) ? raw.slice(-1) : '';
    // A float suffix would round the exact double back; the constant is the double.
    const to = exactDecimal(signed) + (suffix === 'f' || suffix === 'F' ? '' : suffix);
    o.onRewrite?.({ name, from: raw, to });
    return updateNode(lit, { value: signed, raw: to, suffix: suffix === 'f' || suffix === 'F' ? '' : lit.suffix } as Partial<FloatingLiteralExpr>);
  }

  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const walk = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          return n.kind === NodeKind.FloatingLiteral ? respell(n as FloatingLiteralExpr) : undefined;
        },
      });
      return updateNode(fn, { body: walk(fn.body) } as Partial<FunctionDecl>);
    },
  });
}

export const exactFloatConstantPlugin: TransformPlugin = createPlugin(
  'exact-float-constant',
  'Exact Float Constant',
  'A float literal the decompiler rounded, respelled as the exact value of the memory constant the instruction reads',
  (options?: PluginOptions) => createExactFloatConstantTransformer(options),
  {
    priority: 8, // before simplify folds or type-normalize reads any float literal
    defaultEnabled: true,
    tags: ['correctness'],
    version: '1.0.0',
  },
);
