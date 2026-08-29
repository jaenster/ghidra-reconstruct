/**
 * The type an expression has, as a `TypeShape`.
 *
 * This is the object-type inference `call-arg-cast` grew for deciding whether a
 * call argument needs a cast, lifted out so more than one pass can ask the same
 * question and get the same answer. It walks the expression against four
 * sources, in this order of authority:
 *
 *   1. the function's own parameters and body-declared locals (an AST type),
 *   2. the enclosing declaration a class body sits in,
 *   3. the global's declared spelling,
 *   4. the aggregate that declares the member being read.
 *
 * It is deliberately partial. A shape it cannot determine comes back `null`,
 * and every caller treats that as "leave this alone" - inferring a type wrongly
 * is how a pass writes a cast that compiles and reads the wrong bytes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  Expression, Identifier, MemberExpr, SubscriptExpr, CallExpr, CStyleCastExpr,
  UnaryExpr, BinaryExpr, TypeNode,
} from '../../../ast/nodes.js';
import {
  bareName, calleeName, shapeOfNode, shapeOfSpelling, unwrapParens,
  type TypeShape, type TypedefResolver,
} from './call-arg-cast.js';

export interface ExprShapeTables {
  /** Global name → declared spelling. */
  globalTypes?: Record<string, string>;
  /** A name declared by the class/namespace body this function sits in. */
  enclosingVarTypes?: Record<string, string>;
  /** Aggregate name → member name → member spelling. Exact when the object type is known. */
  structFields?: Record<string, Record<string, string>>;
  /** Member name → spelling, for members whose name is unambiguous tree-wide. */
  fieldTypes?: Record<string, string>;
  /** Function name → return spelling. */
  returnTypes?: Record<string, string>;
  /** Typedef name → what it stands for. */
  resolve?: TypedefResolver;
}

export type ExprShape = (expr: Expression) => TypeShape | null;

/**
 * Build the resolver for one function body.
 *
 * `localTypes` is that function's parameters and locals. `funcdefReturnOfCallee`
 * supplies the return spelling for a call made THROUGH a function pointer, whose
 * type only the funcdef the slot is declared with knows; it is a hook because
 * resolving that callee itself needs this resolver, so the two are mutually
 * recursive and the caller ties the knot.
 */
export function createExprShape(
  localTypes: ReadonlyMap<string, TypeNode>,
  tables: ExprShapeTables,
  funcdefReturnOfCallee?: (callee: Expression) => string | undefined,
): ExprShape {
  const globalTypes = tables.globalTypes ?? {};
  const enclosingVarTypes = tables.enclosingVarTypes ?? {};
  const structFields = tables.structFields ?? {};
  const fieldTypes = tables.fieldTypes ?? {};
  const returnTypes = tables.returnTypes ?? {};
  const resolve = tables.resolve;

  const shape: ExprShape = (expr: Expression): TypeShape | null => {
    const e = unwrapParens(expr);
    switch (e.kind) {
      case NodeKind.CStyleCastExpr:
        return shapeOfNode((e as CStyleCastExpr).type, 0, resolve);
      case NodeKind.UnaryExpr: {
        const u = e as UnaryExpr;
        if (u.operator === '*') {
          const pointee = shape(u.operand);
          return pointee && pointee.stars > 0 ? { ...pointee, stars: pointee.stars - 1 } : null;
        }
        if (u.operator !== '&') return null;
        const inner = shape(u.operand);
        // `&arr` where arr is already an array decayed once - taking the
        // address of that is a pointer-to-array, which this does not model.
        return inner ? { ...inner, stars: inner.stars + 1 } : null;
      }
      case NodeKind.Identifier: {
        const name = (e as Identifier).name;
        const local = localTypes.get(name);
        if (local) return shapeOfNode(local, 0, resolve);
        const declared = enclosingVarTypes[name];
        if (declared) return shapeOfSpelling(declared, resolve);
        const g = globalTypes[name];
        return g ? shapeOfSpelling(g, resolve) : null;
      }
      case NodeKind.QualifiedId: {
        const q = calleeName(e);
        if (!q) return null;
        const bare = bareName(q);
        const g = globalTypes[q] ?? globalTypes[bare];
        return g ? shapeOfSpelling(g, resolve) : null;
      }
      case NodeKind.MemberExpr: {
        const m = e as MemberExpr;
        const member = m.member as { name?: string };
        if (typeof member?.name !== 'string') return null;
        // If the object's own type is known, the field's type is exact.
        const obj = shape(m.object);
        if (obj && obj.stars === (m.isArrow ? 1 : 0)) {
          const exact = structFields[obj.base]?.[member.name];
          if (exact) return shapeOfSpelling(exact, resolve);
        }
        const t = fieldTypes[member.name];
        return t ? shapeOfSpelling(t, resolve) : null;
      }
      case NodeKind.SubscriptExpr: {
        const inner = shape((e as SubscriptExpr).array);
        // Subscripting peels one indirection off; a scalar subscript is a
        // model error somewhere else and is left alone.
        return inner && inner.stars > 0 ? { ...inner, stars: inner.stars - 1 } : null;
      }
      case NodeKind.CallExpr: {
        const callee = (e as CallExpr).callee;
        const cn = calleeName(callee);
        const rt = cn !== undefined
          ? returnTypes[cn] ?? returnTypes[bareName(cn)]
          : undefined;
        if (rt) return shapeOfSpelling(rt, resolve);
        // No name matched — a call THROUGH a function pointer, whose result
        // type only the funcdef the slot is declared with can supply.
        const fd = funcdefReturnOfCallee?.(callee);
        return fd ? shapeOfSpelling(fd, resolve) : null;
      }
      case NodeKind.BinaryExpr: {
        // Pointer arithmetic keeps the pointer's type: `pBuf + 0x11` is still
        // a `T*`, and Ghidra writes an offset onto a base constantly. Only
        // `+`/`-` do this, and only with exactly one pointer operand -
        // `p - q` is an integer distance, and everything else is arithmetic.
        const b = e as BinaryExpr;
        if (b.operator !== '+' && b.operator !== '-') return null;
        const l = shape(b.left);
        const r = shape(b.right);
        if (l && l.stars > 0 && (!r || r.stars === 0)) return l;
        if (b.operator === '+' && r && r.stars > 0 && (!l || l.stars === 0)) return r;
        return null;
      }
      default:
        return null;
    }
  };

  return shape;
}

/** The parameters and body-declared locals of one function, by name. */
export function collectLocalTypes(node: {
  parameters: ReadonlyArray<{ name?: { name: string } | null; type: TypeNode }>;
  body?: unknown;
}, findVariableDecls: () => Array<{ name: { name: string }; type: TypeNode }>): Map<string, TypeNode> {
  const localTypes = new Map<string, TypeNode>();
  for (const p of node.parameters) {
    if (p.name) localTypes.set(p.name.name, p.type);
  }
  for (const v of findVariableDecls()) {
    if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
  }
  return localTypes;
}
