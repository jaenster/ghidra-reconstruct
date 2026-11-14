/**
 * Shift Count Mask Plugin
 *
 * An x86 SHL/SHR/SAR by CL uses the low five bits of the count, and the decompiler
 * models that by printing the mask:
 *
 *   return 1 << ((char)nIndex + 4U & 0x1f);      // DRLGOUTDOOR_GetAdjacentLevelVisMask
 *
 * The source wrote `1 << (nIndex + 4)`; VC8 emits the bare `shl eax,cl` for it, and
 * with the mask spelled out it emits an `and ecx,0x1f` the original does not have.
 *
 * The mask is not free to drop. In C++ a shift by 32 or more is undefined, and the
 * mingw build is C++: `x << (n & 0x1f)` is defined for every n, `x << n` only for n
 * in [0, 31]. So the mask goes only where the count is PROVEN to lie in [0, 31] (see
 * value-range.ts): a constant, a byte masked or reduced below 32, a loop counter
 * whose test bounds it, a value an earlier test excludes. There `n & 0x1f == n`, and
 * the shift's type is its left operand's whatever the count's type, so the
 * expression's value and type are unchanged.
 *
 * Anywhere else the mask stays - unless the target names a count macro (`countMacro`,
 * for Diablo II `D2_SHIFT_COUNT` from d2_platform.h). Then the count goes through it:
 * `x << D2_SHIFT_COUNT(n)`. The macro is the count as the shift instruction takes it,
 * its low five bits: `(n) & 0x1f` for a C++ build, where that keeps every count defined,
 * and `(n)` for MSVC, which compiles the shift to the bare SHL/SHR/SAR by CL whose
 * hardware masks the count the same way - what the original source wrote. The masked
 * count compiles differently: VC8 keeps an `and ecx,0x1f`, or loads a byte count with
 * MOVZX where the original loads CL (`mov cl, byte ptr [esi+0x196]`, GetMinDamage
 * 0064af20). Of the 551 shifts by CL in Diablo II 1.14d's Game.exe, 4 mask the count
 * with an AND first, 2 of them in the C runtime, so the bare count is what the source
 * had almost everywhere.
 *
 * Where the count is not proven, a narrowing integer cast in it goes, before the macro
 * takes it: the decompiler takes
 * the count from CL, so it prints `(uint8_t)` (or `(char)`) over an int it read whole -
 *
 *   pBitStream->nBitAccum |= nBitsValue << ((uint8_t)pBitStream->nBitsHeld & 0x1f);
 *
 * where the original loads the int field with `mov ecx, dword ptr [eax+0x10]` and VC8
 * compiles the cast to a MOVZX byte load (BITSTREAM_WriteBits 0041d950). A cast to any
 * integer type of 8 or more bits keeps the low eight bits of its operand, a sum or
 * difference's low five bits depend on only its operands' low five, and the mask keeps
 * just those five: `(T)n & 0x1f == n & 0x1f` for every n. So the cast goes where it
 * stands as the count, or as an operand of a `+`/`-` that is the count, and its operand
 * is an integer of at most 32 bits whose type is known. Within a sum/difference both
 * operands must be known integers: a cast can select an overloaded operator. When
 * stripping a cast would leave signed arithmetic, one operand becomes uint32_t so
 * widening a byte to an unrestricted int cannot introduce overflow before the mask.
 * A count the mask drops keeps its casts: there the range was proven for the cast's
 * value, not its operand's.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CStyleCastExpr, Expression, FunctionDecl, IntegerLiteralExpr, ParenExpr,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { unwrapParens, type TypedefResolver } from './call-arg-cast.js';
import { createFunctionRanges, type ValueRange } from './value-range.js';
import { shapeOfNode } from './call-arg-cast.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import { compareCast, localTypesOf } from './compare-form.js';

export interface ShiftCountMaskOptions extends PluginOptions {
  enumTypes?: string[];
  enumValues?: Record<string, number>;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  /**
   * A function-like macro giving a shift count as the instruction takes it (its low five
   * bits). A count not proven to lie in [0, 31] goes through it instead of keeping the
   * decompiler's mask. Unset: the mask stays.
   */
  countMacro?: string;
  /** Called for each masked count, with the range proven for it (null: none) and whether the count macro took it. */
  onSite?: (site: { line: number; dropped: boolean; wrapped: boolean; range: ValueRange | null; shift: ASTNode; count: Expression }) => void;
}

const SHIFTS = new Set(['<<', '>>', '<<=', '>>=']);

/** The count of a masked shift: `C` of `(C & 0x1f)` / `(0x1f & C)`, and its side of the `&`. */
function maskedCount(e: Expression): { count: Expression; mask: BinaryExpr; side: 'left' | 'right' } | null {
  const x = unwrapParens(e);
  if (x.kind !== NodeKind.BinaryExpr || (x as BinaryExpr).operator !== '&') return null;
  const b = x as BinaryExpr;
  const is31 = (n: Expression) => {
    const u = unwrapParens(n);
    return u.kind === NodeKind.IntegerLiteral && (u as IntegerLiteralExpr).value === 0x1fn;
  };
  if (is31(b.right)) return { count: b.left, mask: b, side: 'left' };
  if (is31(b.left)) return { count: b.right, mask: b, side: 'right' };
  return null;
}

/** Integer types of 8 to 32 bits, after typedef resolution. */
const INT32_OR_NARROWER = new Set([
  'char', 'signed char', 'unsigned char', 'int8_t', 'uint8_t', 'uchar', 'byte', 'BYTE', 'UCHAR', 'sbyte',
  'short', 'short int', 'unsigned short', 'int16_t', 'uint16_t', 'ushort', 'word', 'WORD', 'USHORT', 'SHORT', 'sword',
  'int', 'signed', 'signed int', 'unsigned', 'unsigned int', 'int32_t', 'uint32_t', 'uint', 'dword', 'DWORD',
  'UINT', 'INT', 'long', 'long int', 'unsigned long', 'ulong', 'LONG', 'ULONG', 'BOOL', 'sdword',
]);

/** Unsigned types that stay unsigned after integral promotion on the 32-bit target. */
const UNSIGNED_WORD = new Set([
  'unsigned', 'unsigned int', 'uint32_t', 'uint', 'dword', 'DWORD', 'UINT',
  'unsigned long', 'ulong', 'ULONG',
]);

/**
 * The promoted type of a count's builtin integer +/- tree. Unknown/wider operands
 * refuse cast removal: even an integer cast on one side can select a different
 * overload when the other side is a class. Byte/short unsigned operands promote to
 * signed int, so checking only a spelling's signedness would miss overflow.
 */
function countIntegerType(e: Expression, shapeOf: ExprShape): 'signed' | 'unsigned' | null {
  const x = unwrapParens(e);
  if (x.kind === NodeKind.IntegerLiteral) {
    const lit = x as IntegerLiteralExpr;
    const suffix = (lit.suffix ?? '').toLowerCase();
    if (suffix.includes('ll') || lit.value > 0xffffffffn) return null;
    if (suffix.includes('u')) return 'unsigned';
    if (lit.value <= 0x7fffffffn) return 'signed';
    return lit.base !== 10 ? 'unsigned' : null;
  }
  if (x.kind === NodeKind.BinaryExpr && ['+', '-'].includes((x as BinaryExpr).operator)) {
    const b = x as BinaryExpr;
    const left = countIntegerType(b.left, shapeOf), right = countIntegerType(b.right, shapeOf);
    return left && right ? (left === 'unsigned' || right === 'unsigned' ? 'unsigned' : 'signed') : null;
  }
  const s = shapeOf(x);
  if (!s || s.stars !== 0 || !INT32_OR_NARROWER.has(s.base)) return null;
  return UNSIGNED_WORD.has(s.base) ? 'unsigned' : 'signed';
}

/**
 * `c` with each narrowing integer cast that stands as the count, or as an operand of a
 * `+`/`-` that is the count, replaced by its operand; `c` itself when none goes. Only for a
 * count the mask keeps (see the header).
 */
function stripCountCasts(c: Expression, shapeOf: ExprShape, resolve: TypedefResolver, depth = 0): Expression {
  const x = unwrapParens(c);
  if (x.kind === NodeKind.CStyleCastExpr) {
    const cast = x as CStyleCastExpr;
    const to = shapeOfNode(cast.type, 0, resolve);
    if (!to || to.stars !== 0 || !INT32_OR_NARROWER.has(to.base)) return c;
    const inner = unwrapParens(cast.expression);
    const from = shapeOf(inner);
    if (!from || from.stars !== 0 || !INT32_OR_NARROWER.has(from.base)) return c;
    return primary(inner) ? inner : {
      kind: NodeKind.ParenExpr, expression: inner, location: inner.location, leadingTrivia: [], trailingTrivia: [],
    } as ParenExpr;
  }
  if (depth < 4 && x.kind === NodeKind.BinaryExpr && ((x as BinaryExpr).operator === '+' || (x as BinaryExpr).operator === '-')) {
    const b = x as BinaryExpr;
    if (!countIntegerType(b, shapeOf)) return c;
    let left = stripCountCasts(b.left, shapeOf, resolve, depth + 1);
    const right = stripCountCasts(b.right, shapeOf, resolve, depth + 1);
    if (left === b.left && right === b.right) return c;
    // The low five bits survive unsigned word arithmetic. Casting the RESULT would
    // be too late: `n + 4` can already overflow after `(uint8_t)n` becomes `n`.
    if (countIntegerType(left, shapeOf) !== 'unsigned' && countIntegerType(right, shapeOf) !== 'unsigned') {
      left = compareCast(left, 4);
    }
    return updateNode(b, { left, right } as Partial<BinaryExpr>) as Expression;
  }
  return c;
}

/** A count that can stand as a shift's right operand without parentheses. */
function primary(e: Expression): boolean {
  return [
    NodeKind.Identifier, NodeKind.IntegerLiteral, NodeKind.ParenExpr, NodeKind.MemberExpr,
    NodeKind.SubscriptExpr, NodeKind.CallExpr, NodeKind.CStyleCastExpr, NodeKind.StaticCastExpr,
    NodeKind.QualifiedId,
  ].includes(e.kind as NodeKind);
}

/**
 * Rebuild `root` with each shift in `counts` given its new count, copying only the
 * paths that change. A shift nested in another's operand is rewritten too.
 */
function replaceCounts(root: ASTNode, counts: Map<ASTNode, Expression>): ASTNode {
  let copy: Record<string, unknown> | null = null;
  for (const key of Object.keys(root)) {
    if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
    const v = (root as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      let changed = false;
      const next = v.map(x => {
        if (!x || typeof x !== 'object' || typeof (x as ASTNode).kind !== 'string') return x;
        const r = replaceCounts(x as ASTNode, counts);
        if (r !== x) changed = true;
        return r;
      });
      if (changed) (copy ??= { ...root })[key] = next;
    } else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') {
      const r = replaceCounts(v as ASTNode, counts);
      if (r !== v) (copy ??= { ...root })[key] = r;
    }
  }
  const count = counts.get(root);
  if (count) (copy ??= { ...root }).right = replaceCounts(count, counts);
  return (copy ?? root) as unknown as ASTNode;
}

export function createShiftCountMaskTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as ShiftCountMaskOptions;
  const enumTypes = new Set(o.enumTypes ?? []);
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => (enumTypes.has(name) ? undefined : typedefTargets[name]);

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      const sites: { shift: BinaryExpr | AssignExpr; count: Expression; mask: BinaryExpr; side: 'left' | 'right' }[] = [];
      const find = (n: ASTNode) => {
        if ((n.kind === NodeKind.BinaryExpr || n.kind === NodeKind.AssignExpr) && SHIFTS.has((n as BinaryExpr).operator)) {
          const m = maskedCount((n as BinaryExpr).right);
          if (m) sites.push({ shift: n as BinaryExpr, count: m.count, mask: m.mask, side: m.side });
        }
        for (const key of Object.keys(n)) {
          if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
          const v = (n as unknown as Record<string, unknown>)[key];
          if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && typeof (x as ASTNode).kind === 'string') find(x as ASTNode); }
          else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') find(v as ASTNode);
        }
      };
      find(node.body);
      if (!sites.length) return undefined;

      const ranges = createFunctionRanges(node, {
        enumTypes: o.enumTypes,
        enumValues: o.enumValues,
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });
      const counts = new Map<ASTNode, Expression>();
      let shapeOf: ExprShape | undefined;
      for (const s of sites) {
        const r = ranges.rangeAt(s.count);
        const dropped = !!r && r.lo >= 0 && r.hi <= 31;
        const wrapped = !dropped && !!o.countMacro;
        o.onSite?.({ line: s.shift.location?.start?.line ?? 0, dropped, wrapped, range: r, shift: s.shift, count: s.count });
        if (!dropped) {
          shapeOf ??= createExprShape(localTypesOf(node), {
            globalTypes: o.globalTypes ?? {},
            enclosingVarTypes: o.enclosingVarTypes ?? {},
            structFields: o.structFields ?? {},
            fieldTypes: o.fieldTypes ?? {},
            returnTypes: o.functionReturnTypes ?? {},
            resolve,
          });
          const stripped = stripCountCasts(s.count, shapeOf, resolve);
          if (wrapped) {
            counts.set(s.shift, Expr.call(o.countMacro!, [unwrapParens(stripped)]) as Expression);
            continue;
          }
          if (stripped === s.count) continue;
          const mask = updateNode(s.mask, { [s.side]: stripped } as Partial<BinaryExpr>) as Expression;
          counts.set(s.shift, {
            kind: NodeKind.ParenExpr, expression: mask, location: s.mask.location, leadingTrivia: [], trailingTrivia: [],
          } as ParenExpr);
          continue;
        }
        const c = unwrapParens(s.count);
        const right: Expression = primary(c) ? c : {
          kind: NodeKind.ParenExpr, expression: c, location: c.location, leadingTrivia: [], trailingTrivia: [],
        } as ParenExpr;
        counts.set(s.shift, right);
      }
      if (!counts.size) return undefined;
      return updateNode(node, { body: replaceCounts(node.body, counts) } as Partial<FunctionDecl>);
    },
  });
}

export const shiftCountMaskPlugin: TransformPlugin = createPlugin(
  'shift-count-mask',
  'Shift Count Mask',
  'A shift count the decompiler masked with & 0x1f loses the mask where the count is proven to lie in [0, 31], and goes through the target\'s count macro elsewhere',
  (options?: PluginOptions) => createShiftCountMaskTransformer(options),
  {
    priority: 621, // after the cast and compare passes: needs the final local types and loop shapes
    defaultEnabled: true,
    tags: ['matching'],
    version: '1.0.1',
  },
);
