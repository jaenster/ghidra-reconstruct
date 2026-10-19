/**
 * Three-Byte Access Plugin
 *
 * The decompiler fuses three adjacent byte loads into one load of its 3-byte integer type
 * and prints it through a pointer to that type, whatever the pointer was declared as:
 *
 *   (*pPixelCallback)((uint)*(uint3 *)pPixelData);             // TILECMP_ApplyFunctionToPixels
 *   nMix = ... + (uint)*(uint3 *)((int)pData + 5) * 0x100;      // SSTR_JenkinsHash
 *
 * C has no 3-byte integer. `type-normalize` spells a 3-byte VALUE as its 4-byte container,
 * which is right for a local or a cast, and was also applied to the pointee: the load became
 * `*(uint32_t *)p`, which reads a FOURTH byte and hands it on. In the Jenkins hash that
 * byte lands in bits 24..31 of the mixed value; in the pixel walk the callback gets the next
 * pixel's first byte as its high byte. Both compile and both are wrong.
 *
 * So a load or store THROUGH a pointer to a 3-byte type is lowered here, before
 * `type-normalize` (15) can widen it, to an access of exactly three bytes:
 *
 *   *(uint3 *)E        →  d2_load24((uint8_t *)E)        zero-extended
 *   *(int3 *)E         →  d2_load24s((uint8_t *)E)       sign-extended from bit 23
 *   *(uint3 *)E = v    →  d2_store24((uint8_t *)E, v)    low three bytes of v
 *   *p, p `uint3 *`    →  d2_load24(p)                   (a parameter or local so declared)
 *
 * The helpers are in artifact-support.ts. The cast to `uint8_t *` names the same address as
 * the cast it replaces; only the width of the access changes, and that is the point. An
 * access in any other position (`&*p`, `++*p`) is left alone.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CStyleCastExpr, Expression, Identifier, ParameterDecl,
  ParenExpr, PointerType, TypedefType, UnaryExpr, VariableDecl, BinaryExpr, TypeNode,
} from '../../../ast/nodes.js';
import { Expr } from '../../../ast/factory.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin } from '../types.js';
import { createPlugin } from '../registry.js';

const UNSIGNED_3 = new Set(['uint3', 'undefined3']);
const SIGNED_3 = new Set(['int3']);

/** The 3-byte type a pointer type points at, or null. One level of pointer only. */
function threeBytePointee(t: TypeNode | undefined): 'u' | 's' | null {
  if (!t || t.kind !== NodeKind.PointerType) return null;
  const pointee = (t as PointerType).pointee as ASTNode & { name?: unknown };
  let name: string | undefined;
  if (pointee.kind === NodeKind.TypedefType) {
    const n = (pointee as TypedefType).name;
    if (n.kind === NodeKind.Identifier) name = (n as Identifier).name;
  } else if (pointee.kind === NodeKind.BuiltinType) {
    name = (pointee as unknown as { name: string }).name;
  }
  if (!name) return null;
  if (UNSIGNED_3.has(name)) return 'u';
  if (SIGNED_3.has(name)) return 's';
  return null;
}

function unwrap(e: Expression): Expression {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression;
  return x;
}

const BYTE_PTR = (template: ASTNode): PointerType => ({
  kind: NodeKind.PointerType,
  pointee: {
    kind: NodeKind.TypedefType,
    name: { ...Expr.identifier('uint8_t'), location: template.location, leadingTrivia: [], trailingTrivia: [] },
    location: template.location, leadingTrivia: [], trailingTrivia: [],
  } as TypedefType,
  qualifiers: [],
  location: template.location, leadingTrivia: [], trailingTrivia: [],
} as PointerType);

const call = (name: string, args: Expression[], template: ASTNode): CallExpr =>
  ({ ...Expr.call(name, args), location: template.location,
     leadingTrivia: template.leadingTrivia ?? [], trailingTrivia: template.trailingTrivia ?? [] }) as CallExpr;

/** An expression that can be evaluated twice with the same result and no effect. */
function isPure(e: ASTNode): boolean {
  switch (e.kind) {
    case NodeKind.Identifier:
    case NodeKind.IntegerLiteral:
      return true;
    case NodeKind.ParenExpr:
      return isPure((e as ParenExpr).expression);
    case NodeKind.CStyleCastExpr:
      return isPure((e as CStyleCastExpr).expression);
    case NodeKind.BinaryExpr:
      return ['+', '-'].includes((e as BinaryExpr).operator)
        && isPure((e as BinaryExpr).left) && isPure((e as BinaryExpr).right);
    default:
      return false;
  }
}

/** Drop a cast of the stored value to a 3-byte type: the store keeps the low three bytes. */
function stripThreeByteValueCast(e: Expression): Expression {
  const x = unwrap(e);
  if (x.kind !== NodeKind.CStyleCastExpr) return e;
  const t = (x as CStyleCastExpr).type as ASTNode;
  if (t.kind !== NodeKind.TypedefType) return e;
  const n = (t as TypedefType).name;
  const name = n.kind === NodeKind.Identifier ? (n as Identifier).name : '';
  return UNSIGNED_3.has(name) || SIGNED_3.has(name) ? (x as CStyleCastExpr).expression : e;
}

function createThreeByteAccessTransformer(): Transformer {
  return (root: ASTNode) => {
    // Names declared as a pointer to a 3-byte type — and only ever so declared, so a name
    // reused with another type somewhere in the same unit is not touched.
    const ptrNames = new Map<string, 'u' | 's'>();
    const otherNames = new Set<string>();
    const note = (name: string | undefined, t: TypeNode) => {
      if (!name) return;
      const k = threeBytePointee(t);
      if (k) ptrNames.set(name, k); else otherNames.add(name);
    };
    for (const p of findNodesByKind(root, NodeKind.ParameterDecl)) note((p as ParameterDecl).name?.name, (p as ParameterDecl).type);
    for (const v of findNodesByKind(root, NodeKind.VariableDecl)) note((v as VariableDecl).name.name, (v as VariableDecl).type);
    for (const n of otherNames) ptrNames.delete(n);

    /** `E` as the address operand of the 3-byte access, and its signedness; or null. */
    const access = (operand: Expression): { addr: Expression; kind: 'u' | 's' } | null => {
      const x = unwrap(operand);
      if (x.kind === NodeKind.CStyleCastExpr) {
        const cast = x as CStyleCastExpr;
        const kind = threeBytePointee(cast.type);
        if (!kind) return null;
        return { addr: { ...cast, type: BYTE_PTR(cast) } as CStyleCastExpr, kind };
      }
      if (x.kind === NodeKind.Identifier) {
        const kind = ptrNames.get((x as Identifier).name);
        return kind ? { addr: x, kind } : null;
      }
      return null;
    };

    // Bottom-up: the operand of `&`/`++`/`--` is visited before its parent, so a load made
    // there is swapped back for the original dereference by the parent.
    const originalOf = new WeakMap<ASTNode, Expression>();
    return createTransformer({
      visitNode(node: ASTNode): ASTNode | undefined {
        if (node.kind === NodeKind.AssignExpr) {
          const a = node as AssignExpr;
          const target = unwrap(a.left);
          const orig = originalOf.get(target) ?? (target.kind === NodeKind.UnaryExpr ? target : undefined);
          if (!orig || orig.kind !== NodeKind.UnaryExpr || (orig as UnaryExpr).operator !== '*') return undefined;
          const acc = access((orig as UnaryExpr).operand);
          if (!acc) return undefined;
          let value: Expression;
          if (a.operator === '=') {
            value = stripThreeByteValueCast(a.right);
          } else {
            if (!isPure(acc.addr)) return { ...a, left: orig } as AssignExpr;
            const load = call(acc.kind === 's' ? 'd2_load24s' : 'd2_load24', [acc.addr], a);
            value = { kind: NodeKind.BinaryExpr, operator: a.operator.slice(0, -1), left: load,
              right: { kind: NodeKind.ParenExpr, expression: a.right, location: a.location, leadingTrivia: [], trailingTrivia: [] } as ParenExpr,
              location: a.location, leadingTrivia: [], trailingTrivia: [] } as unknown as BinaryExpr;
          }
          return call('d2_store24', [acc.addr, value], a);
        }
        if (node.kind === NodeKind.PostfixExpr || (node.kind === NodeKind.UnaryExpr && ['&', '++', '--'].includes((node as UnaryExpr).operator))) {
          const u = node as UnaryExpr;
          const orig = originalOf.get(unwrap(u.operand));
          return orig ? { ...u, operand: orig } as UnaryExpr : undefined;
        }
        if (node.kind !== NodeKind.UnaryExpr || (node as UnaryExpr).operator !== '*') return undefined;
        const acc = access((node as UnaryExpr).operand);
        if (!acc) return undefined;
        const load = call(acc.kind === 's' ? 'd2_load24s' : 'd2_load24', [acc.addr], node);
        originalOf.set(load, node as UnaryExpr);
        return load;
      },
    })(root);
  };
}

export const threeByteAccessPlugin: TransformPlugin = createPlugin(
  'three-byte-access',
  'Three-Byte Access',
  'Lowers a load/store through a pointer to uint3/int3/undefined3 to an access of exactly three bytes',
  () => createThreeByteAccessTransformer(),
  {
    priority: 14, // before type-normalize (15), which widens the 3-byte pointee to 4 bytes
    defaultEnabled: true,
    tags: ['cleanup', 'ghidra', 'correctness'],
    version: '1.0.0',
  },
);
