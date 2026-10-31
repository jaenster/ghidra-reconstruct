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
 * expression's value and type are unchanged. Anywhere else the mask stays.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, Expression, FunctionDecl, IntegerLiteralExpr, ParenExpr,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { unwrapParens, type TypedefResolver } from './call-arg-cast.js';
import { createFunctionRanges, type ValueRange } from './value-range.js';

export interface ShiftCountMaskOptions extends PluginOptions {
  enumTypes?: string[];
  enumValues?: Record<string, number>;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  /** Called for each masked count, with the range proven for it (null: none). */
  onSite?: (site: { line: number; dropped: boolean; range: ValueRange | null; shift: ASTNode; count: Expression }) => void;
}

const SHIFTS = new Set(['<<', '>>', '<<=', '>>=']);

/** The count of a masked shift: `C` of `(C & 0x1f)` / `(0x1f & C)`. */
function maskedCount(e: Expression): { count: Expression } | null {
  const x = unwrapParens(e);
  if (x.kind !== NodeKind.BinaryExpr || (x as BinaryExpr).operator !== '&') return null;
  const b = x as BinaryExpr;
  const is31 = (n: Expression) => {
    const u = unwrapParens(n);
    return u.kind === NodeKind.IntegerLiteral && (u as IntegerLiteralExpr).value === 0x1fn;
  };
  if (is31(b.right)) return { count: b.left };
  if (is31(b.left)) return { count: b.right };
  return null;
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
      const sites: { shift: BinaryExpr | AssignExpr; count: Expression }[] = [];
      const find = (n: ASTNode) => {
        if ((n.kind === NodeKind.BinaryExpr || n.kind === NodeKind.AssignExpr) && SHIFTS.has((n as BinaryExpr).operator)) {
          const m = maskedCount((n as BinaryExpr).right);
          if (m) sites.push({ shift: n as BinaryExpr, count: m.count });
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
      for (const s of sites) {
        const r = ranges.rangeAt(s.count);
        const dropped = !!r && r.lo >= 0 && r.hi <= 31;
        o.onSite?.({ line: s.shift.location?.start?.line ?? 0, dropped, range: r, shift: s.shift, count: s.count });
        if (!dropped) continue;
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
  'A shift count the decompiler masked with & 0x1f loses the mask where the count is proven to lie in [0, 31]',
  (options?: PluginOptions) => createShiftCountMaskTransformer(options),
  {
    priority: 621, // after the cast and compare passes: needs the final local types and loop shapes
    defaultEnabled: true,
    tags: ['matching'],
    version: '1.0.0',
  },
);
