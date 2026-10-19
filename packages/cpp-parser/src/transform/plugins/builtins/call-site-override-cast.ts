/**
 * Call-Site Override Cast Plugin
 *
 * Ghidra can give one indirect CALL its own prototype - a call-site override, the
 * `override` namespace label `HighFunctionDBUtil.writeOverride` writes, pointing at a
 * FUNCTION_DEFINITION (`/auto_proto/dt_*`). The decompiler then passes the right
 * arguments, but prints the callee as it is typed, with no cast:
 *
 *   (*pBinFieldInput[nFieldMapIdx].fpLinker)(pSrc, pRecord, nOffset, nPos, nRow, nCol);
 *
 * on a `void *` field (`TXT_ParseDataAndPutIntoStructure` 006be01a: the field is a
 * link-table pointer for some field types and a linker callback for others, so no
 * single field type is right). Calling a `void *` does not compile; calling a `code *`
 * compiles as variadic `__cdecl`, which is not what the override says.
 *
 * The override is what the call IS, so the cast is spelled from it:
 *
 *   ((dt_43fbd679)pBinFieldInput[nFieldMapIdx].fpLinker)(pSrc, pRecord, ...);
 *
 * The AST carries no addresses, so a call is matched to its override by ARITY, and only
 * when every override in the function with that arity names the same FUNCTION_DEFINITION.
 * The callee must be an untyped pointer (`void *` or `code *`) by its declared type; a
 * callee typed as a function pointer already says what it is.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CallExpr, CStyleCastExpr, Expression, FunctionDecl, ParameterDecl, ParenExpr,
  TypeNode, TypedefType, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { Expr } from '../../../ast/factory.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { createExprShape } from './expr-shape.js';
import { unwrapParens, type TypedefResolver } from './call-arg-cast.js';

export interface CallSiteOverride {
  /** The FUNCTION_DEFINITION the override names; declared as a pointer typedef. */
  funcdef: string;
  /** Its parameter count. */
  arity: number;
}

export interface CallSiteOverrideCastOptions extends PluginOptions {
  /** This function's indirect-call overrides. */
  overrides?: CallSiteOverride[];
  /** Receives every funcdef spelled into a cast; the emitting file must declare it. */
  usedTypedefs?: Set<string>;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

const UNTYPED_CALLEE = new Set(['void', 'code', 'undefined']);

export function createCallSiteOverrideCastTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as CallSiteOverrideCastOptions;
  const byArity = new Map<number, string | null>();
  for (const ov of o.overrides ?? []) {
    const seen = byArity.get(ov.arity);
    byArity.set(ov.arity, seen === undefined || seen === ov.funcdef ? ov.funcdef : null);
  }
  if (byArity.size === 0) return (n: ASTNode) => n;
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
          const funcdef = byArity.get(call.arguments.length);
          if (!funcdef) return undefined;
          let target = unwrapParens(call.callee as Expression);
          if (target.kind === NodeKind.UnaryExpr && (target as UnaryExpr).operator === '*') {
            target = unwrapParens((target as UnaryExpr).operand);
          }
          const shape = shapeOf(target);
          if (!shape || shape.stars !== 1 || !UNTYPED_CALLEE.has(shape.base)) return undefined;
          changed = true;
          o.usedTypedefs?.add(funcdef);
          const cast: CStyleCastExpr = {
            kind: NodeKind.CStyleCastExpr,
            type: {
              kind: NodeKind.TypedefType,
              name: { ...Expr.identifier(funcdef), location: call.location, leadingTrivia: [], trailingTrivia: [] },
              location: call.location, leadingTrivia: [], trailingTrivia: [],
            } as TypedefType,
            expression: target,
            location: call.location, leadingTrivia: [], trailingTrivia: [],
          };
          const paren: ParenExpr = {
            kind: NodeKind.ParenExpr, expression: cast,
            location: call.location, leadingTrivia: [], trailingTrivia: [],
          };
          return updateNode(call, { callee: paren } as Partial<CallExpr>);
        },
      });
      const body = inner(node.body);
      return changed ? updateNode(node, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const callSiteOverrideCastPlugin: TransformPlugin = createPlugin(
  'call-site-override-cast',
  'Call-Site Override Cast',
  "An indirect call through an untyped pointer is cast to the prototype of Ghidra's call-site override",
  (options?: PluginOptions) => createCallSiteOverrideCastTransformer(options),
  {
    priority: 614, // with pointer-compare-cast (615): needs the final local and global types
    defaultEnabled: true,
    tags: ['correctness'],
    version: '1.0.0',
  },
);
