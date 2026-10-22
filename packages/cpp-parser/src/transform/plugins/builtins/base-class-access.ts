/**
 * Base-Class Access Plugin
 *
 * Ghidra models a base class as a struct component, `super_<Class>`, at offset
 * 0, and spells every access to an inherited member through it:
 *
 *   pThis->super_TSExportTableSimple.super_TSHashTableReuse.super_TSHashTable.pVtable
 *   TSHashObject<CELLIST, HASHKEY_NONE>::Destructor(&pNode->super_TSHashObject)
 *   TSHashTable<CELLIST, HASHKEY_NONE>::Ptr((TSHashTable<CELLIST, HASHKEY_NONE>*)&gCache, ...)
 *
 * Where the tree declares that component as a real base class, C++ says each of
 * these directly, and each rewrite keeps the value because a base at offset 0 is
 * the same object at the same address:
 *
 *   E.super_B.m       →  E.m       (and E->super_B.m → E->m), unless the derived
 *                                   class declares an m of its own
 *   &E.super_B        →  &E        (&E->super_B → E) where the pointer is
 *                                   converted at once: a call argument, the value
 *                                   of `=`, an initializer, a return value, a cast
 *                                   operand, a side of `==`/`!=`. The derived
 *                                   pointer converts to the base pointer
 *                                   implicitly, to the same address. Pointer
 *                                   arithmetic or a subscript would step by the
 *                                   derived class's size, so those are left alone.
 *   f(..., (B*)x, ...) →  f(..., x, ...)  when x's type is a pointer to a class
 *                                   derived from B: the cast is the conversion
 *                                   the argument undergoes anyway.
 *
 * Which components are bases is the generator's model (reconstruct
 * `codegen/templates/bases.ts`), passed by name: it guarantees that every
 * component of such a name, in every struct, is that struct's base, so the
 * member name alone decides. An expression whose type is unknown keeps its cast.
 *
 * Late (625): after every pass that inserts a cast from the declared types, so
 * none of them sees an implicit derived-to-base conversion as a mismatch.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CStyleCastExpr, Expression, FunctionDecl, MemberExpr,
  ParameterDecl, ParenExpr, ReturnStmt, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';
import { shapeOfNode, shapeOfSpelling, type TypedefResolver } from './call-arg-cast.js';

export interface BaseClassAccessOptions extends PluginOptions {
  /** Component names that are a base-class subobject in every struct that has one (`super_TSHashTable`). */
  baseComponents?: readonly string[];
  /** Member names some derived class declares again; an access through its base is not rewritten. */
  hiddenMembers?: readonly string[];
  /** Each class with a base and its direct base, as spellings. */
  bases?: ReadonlyArray<readonly [string, string]>;
  /** Global name → declared spelling. */
  globalTypes?: Record<string, string>;
  /** A name declared by the enclosing class/namespace body. */
  enclosingVarTypes?: Record<string, string>;
  /** Aggregate name → member name → member spelling. */
  structFields?: Record<string, Record<string, string>>;
  /** Member name → spelling, for members whose name is unambiguous tree-wide. */
  fieldTypes?: Record<string, string>;
  /** Function name → return spelling. */
  functionReturnTypes?: Record<string, string>;
  /** Typedef name → what it stands for. */
  typedefTargets?: Record<string, string>;
}

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function memberName(m: MemberExpr): string | undefined {
  const name = (m.member as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function createBaseClassAccessTransformer(options: BaseClassAccessOptions = {}): Transformer {
  const components = new Set(options.baseComponents ?? []);
  if (components.size === 0) return createTransformer({});
  const hidden = new Set(options.hiddenMembers ?? []);
  const typedefTargets = options.typedefTargets;
  const resolve: TypedefResolver | undefined = typedefTargets ? (name: string) => typedefTargets[name] : undefined;
  // Keyed as a type shape names its base, so a spelling and a parsed type agree.
  const baseOf = new Map<string, string>();
  for (const [derived, base] of options.bases ?? []) {
    const d = shapeOfSpelling(derived, resolve);
    const b = shapeOfSpelling(base, resolve);
    if (d && b && d.stars === 0 && b.stars === 0) baseOf.set(d.base, b.base);
  }
  const derivesFrom = (derived: string, base: string): boolean => {
    const seen = new Set<string>();
    for (let b = baseOf.get(derived); b !== undefined && !seen.has(b); b = baseOf.get(b)) {
      if (b === base) return true;
      seen.add(b);
    }
    return false;
  };
  const tables = {
    globalTypes: options.globalTypes,
    enclosingVarTypes: options.enclosingVarTypes,
    structFields: options.structFields,
    fieldTypes: options.fieldTypes,
    returnTypes: options.functionReturnTypes,
    resolve,
  };

  /** `E.super_B` / `E->super_B`: the access to a base subobject, if `e` is one. */
  const baseAccess = (e: Expression): MemberExpr | undefined => {
    const m = unwrapParens(e);
    if (m.kind !== NodeKind.MemberExpr) return undefined;
    const name = memberName(m as MemberExpr);
    return name !== undefined && components.has(name) ? (m as MemberExpr) : undefined;
  };

  /** `&E.super_B` → `&E`, `&E->super_B` → `E`; anything else unchanged. */
  const derivedPointer = (e: Expression): Expression => {
    const u = unwrapParens(e);
    if (u.kind !== NodeKind.UnaryExpr || (u as UnaryExpr).operator !== '&') return e;
    const access = baseAccess((u as UnaryExpr).operand);
    if (!access) return e;
    return access.isArrow ? access.object : ({ ...(u as UnaryExpr), operand: access.object } as UnaryExpr);
  };

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      const localTypes = new Map<string, TypeNode>();
      for (const p of node.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) localTypes.set(pd.name.name, pd.type);
      }
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
      }
      const shape = createExprShape(localTypes, tables);

      /** `(B*)x` with x a pointer to a class derived from B: x. */
      const withoutUpcast = (e: Expression): Expression => {
        const c = unwrapParens(e);
        if (c.kind !== NodeKind.CStyleCastExpr) return e;
        const to = shapeOfNode((c as CStyleCastExpr).type, 0, resolve);
        const from = shape((c as CStyleCastExpr).expression);
        if (!to || !from || to.stars !== 1 || from.stars !== 1 || from.isConst) return e;
        return derivesFrom(from.base, to.base) ? (c as CStyleCastExpr).expression : e;
      };

      const sub = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          switch (n.kind) {
            case NodeKind.MemberExpr: {
              const m = n as MemberExpr;
              const name = memberName(m);
              const access = m.isArrow ? undefined : baseAccess(m.object);
              if (!access || name === undefined || hidden.has(name)) return undefined;
              return { ...m, object: access.object, isArrow: access.isArrow } as MemberExpr;
            }
            case NodeKind.CallExpr: {
              const call = n as CallExpr;
              const args = call.arguments.map(a => withoutUpcast(derivedPointer(a)));
              return args.some((a, i) => a !== call.arguments[i]) ? ({ ...call, arguments: args } as CallExpr) : undefined;
            }
            case NodeKind.AssignExpr: {
              const a = n as AssignExpr;
              if (a.operator !== '=') return undefined;
              const right = derivedPointer(a.right);
              return right !== a.right ? ({ ...a, right } as AssignExpr) : undefined;
            }
            case NodeKind.VariableDecl: {
              const v = n as VariableDecl;
              if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr) return undefined;
              const init = derivedPointer(v.initializer as Expression);
              return init !== v.initializer ? ({ ...v, initializer: init } as VariableDecl) : undefined;
            }
            case NodeKind.ReturnStmt: {
              const r = n as ReturnStmt;
              if (!r.value) return undefined;
              const value = derivedPointer(r.value);
              return value !== r.value ? ({ ...r, value } as ReturnStmt) : undefined;
            }
            case NodeKind.CStyleCastExpr: {
              const c = n as CStyleCastExpr;
              const expression = derivedPointer(c.expression);
              return expression !== c.expression ? ({ ...c, expression } as CStyleCastExpr) : undefined;
            }
            case NodeKind.BinaryExpr: {
              const b = n as BinaryExpr;
              if (b.operator !== '==' && b.operator !== '!=') return undefined;
              const left = derivedPointer(b.left);
              const right = derivedPointer(b.right);
              return left !== b.left || right !== b.right ? ({ ...b, left, right } as BinaryExpr) : undefined;
            }
            default:
              return undefined;
          }
        },
      });

      return updateNode(node, { body: sub(node.body) } as Partial<FunctionDecl>);
    },
  });
}

export const baseClassAccessPlugin: TransformPlugin = {
  id: 'base-class-access',
  name: 'Base-Class Access',
  description:
    'Read an inherited member, take a base pointer and pass a derived pointer directly where Ghidra goes through the `super_` component of a real base class',
  version: '1.0.0',
  defaultEnabled: true,
  // After the late cast passes (600-622), so none of them re-casts the implicit
  // derived-to-base conversion; before seh-lowering (680) and the goto passes.
  priority: 625,
  tags: ['cleanup', 'structs', 'type'],
  createTransformer: createBaseClassAccessTransformer,
};
