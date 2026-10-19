/**
 * COM IUnknown Call Plugin
 *
 * Ghidra's `IUnknown` is the C shape, `struct IUnknown { IUnknownVtbl *lpVtbl; }`, and a
 * call through it is printed as C COM: the receiver passed by hand as the first argument.
 *
 *   pIface->lpVtbl->Release(pIface);                 // d3dFloorCache / d3dSubtileCache / ...
 *
 * The tree does not define Ghidra's `IUnknown`: mingw's <unknwnbase.h> already defines the
 * C++ interface class under that name in every translation unit (no CINTERFACE), and a
 * second definition collides (see PLATFORM_DEFINED_TYPES in reconstruct's platform-types).
 * The C++ class has no `lpVtbl`; it has the same three virtual methods in the same three
 * vtable slots, and a virtual call passes the receiver as `this` exactly where the C form
 * passed it by hand. So the call is respelled as the C++ one:
 *
 *   pIface->Release();
 *
 * Same slot, same receiver, same remaining arguments. Applied only where the receiver's
 * declared type is `IUnknown *`, the receiver is a plain name (it is evaluated once either
 * way), the first argument is that same name, and the method is one IUnknown declares.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CallExpr, Expression, FunctionDecl, Identifier, MemberExpr, ParameterDecl,
  TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { createExprShape } from './expr-shape.js';
import { unwrapParens, type TypedefResolver } from './call-arg-cast.js';

export interface ComIUnknownCallOptions extends PluginOptions {
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

/** The methods the platform's C++ `IUnknown` declares, in vtable order. */
const IUNKNOWN_METHODS = new Set(['QueryInterface', 'AddRef', 'Release']);

function memberName(m: MemberExpr): string | undefined {
  return m.member.kind === NodeKind.Identifier ? (m.member as Identifier).name : undefined;
}

export function createComIUnknownCallTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as ComIUnknownCallOptions;
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];

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
      const shapeOf = createExprShape(localTypes, {
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });

      let changed = false;
      const inner = createTransformer({
        visitCallExpr(call: CallExpr): ASTNode | undefined {
          let callee = unwrapParens(call.callee as Expression);
          if (callee.kind === NodeKind.UnaryExpr && (callee as UnaryExpr).operator === '*') {
            callee = unwrapParens((callee as UnaryExpr).operand);
          }
          if (callee.kind !== NodeKind.MemberExpr || !(callee as MemberExpr).isArrow) return undefined;
          const method = memberName(callee as MemberExpr);
          if (!method || !IUNKNOWN_METHODS.has(method)) return undefined;
          const vtbl = unwrapParens((callee as MemberExpr).object);
          if (vtbl.kind !== NodeKind.MemberExpr || !(vtbl as MemberExpr).isArrow) return undefined;
          if (memberName(vtbl as MemberExpr) !== 'lpVtbl') return undefined;
          const receiver = unwrapParens((vtbl as MemberExpr).object);
          if (receiver.kind !== NodeKind.Identifier) return undefined;
          const first = call.arguments[0] ? unwrapParens(call.arguments[0]) : undefined;
          if (!first || first.kind !== NodeKind.Identifier
            || (first as Identifier).name !== (receiver as Identifier).name) return undefined;
          const shape = shapeOf(receiver);
          if (!shape || shape.base !== 'IUnknown' || shape.stars !== 1) return undefined;
          changed = true;
          const newCallee: MemberExpr = {
            ...(callee as MemberExpr),
            object: receiver,
            leadingTrivia: [], trailingTrivia: [],
          };
          return updateNode(call, { callee: newCallee, arguments: call.arguments.slice(1) } as Partial<CallExpr>);
        },
      });
      const body = inner(node.body);
      return changed ? updateNode(node, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const comIUnknownCallPlugin: TransformPlugin = createPlugin(
  'com-iunknown-call',
  'COM IUnknown Call',
  'p->lpVtbl->Release(p) through an IUnknown * becomes p->Release() against the platform C++ IUnknown',
  (options?: PluginOptions) => createComIUnknownCallTransformer(options),
  {
    priority: 616, // with pointer-compare-cast (615): needs the final local and global types
    defaultEnabled: true,
    tags: ['correctness', 'platform'],
    version: '1.0.0',
  },
);
