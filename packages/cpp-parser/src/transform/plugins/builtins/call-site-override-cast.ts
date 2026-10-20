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
  /**
   * Names of functions the tree declares (program functions and Win32/CRT imports). A
   * call to one is through a declared prototype: an override at an import call
   * (SetWindowPos, whose override types hWndInsertAfter `int` for the HWND_NOTOPMOST
   * equate) restates the argument list, and casting the import to it would turn the
   * SDK's `(HWND)-2` into an argument that no longer converts.
   */
  functionNames?: string[];
}

const UNTYPED_CALLEE = new Set(['void', 'code', 'undefined']);

/** `new Set(names)`, memoised on the array: the table is built once and handed to every body. */
const nameSets = new WeakMap<readonly string[], Set<string>>();
const NO_NAMES: readonly string[] = [];
function nameSet(names: readonly string[] | undefined): Set<string> {
  const key = names ?? NO_NAMES;
  let set = nameSets.get(key);
  if (!set) { set = new Set(key); nameSets.set(key, set); }
  return set;
}

export function createCallSiteOverrideCastTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as CallSiteOverrideCastOptions;
  const byArity = new Map<number, string | null>();
  for (const ov of o.overrides ?? []) {
    const seen = byArity.get(ov.arity);
    byArity.set(ov.arity, seen === undefined || seen === ov.funcdef ? ov.funcdef : null);
  }
  if (byArity.size === 0) return (n: ASTNode) => n;
  const typedefTargets = o.typedefTargets ?? {};
  const functionNames = nameSet(o.functionNames);
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
          if (target.kind === NodeKind.Identifier || target.kind === NodeKind.QualifiedId) {
            const last = target.kind === NodeKind.Identifier
              ? (target as unknown as { name: string }).name
              : ((target as unknown as { name: { name?: string } }).name.name ?? '');
            if (functionNames.has(last)) return undefined;
          }
          const shape = shapeOf(target);
          if (!shape || shape.stars !== 1 || !UNTYPED_CALLEE.has(shape.base)) return undefined;
          changed = true;
          o.usedTypedefs?.add(funcdef);
          // `(*(code *)p)(...)`: the decompiler's own cast to its untyped `code *` says
          // nothing the override does not, so the override's cast replaces it rather than
          // stacking on it (`(dt_X)(code *)p`).
          while (target.kind === NodeKind.CStyleCastExpr) {
            const ct = (target as CStyleCastExpr).type as TypeNode;
            if (ct.kind !== NodeKind.PointerType) break;
            const pointee = (ct as unknown as { pointee: ASTNode & { name?: { name?: string } | string } }).pointee;
            const pn = typeof pointee.name === 'string' ? pointee.name : pointee.name?.name;
            if (!pn || !UNTYPED_CALLEE.has(pn)) break;
            target = unwrapParens((target as CStyleCastExpr).expression);
          }
          // `*(code **)E` - the slot loaded as the decompiler's untyped pointer: load it
          // as the override's pointer type instead (`*(dt_X *)E`), the same word read
          // from the same address, so no `code` is left to cast from.
          {
            const t = unwrapParens(target);
            if (t.kind === NodeKind.UnaryExpr && (t as UnaryExpr).operator === '*') {
              const inner = unwrapParens((t as UnaryExpr).operand);
              if (inner.kind === NodeKind.CStyleCastExpr) {
                const ct = (inner as CStyleCastExpr).type as unknown as { kind: NodeKind; pointee?: { kind: NodeKind; pointee?: { name?: { name?: string } | string } } };
                const pp = ct.kind === NodeKind.PointerType && ct.pointee?.kind === NodeKind.PointerType ? ct.pointee.pointee : undefined;
                const pn = pp ? (typeof pp.name === 'string' ? pp.name : pp.name?.name) : undefined;
                if (pn && UNTYPED_CALLEE.has(pn)) {
                  const slotType = {
                    kind: NodeKind.PointerType, qualifiers: [],
                    pointee: { kind: NodeKind.TypedefType, name: { ...Expr.identifier(funcdef), location: call.location, leadingTrivia: [], trailingTrivia: [] },
                      location: call.location, leadingTrivia: [], trailingTrivia: [] },
                    location: call.location, leadingTrivia: [], trailingTrivia: [],
                  } as unknown as TypeNode;
                  const load = { ...(t as UnaryExpr), operand: { ...(inner as CStyleCastExpr), type: slotType } } as UnaryExpr;
                  const paren: ParenExpr = { kind: NodeKind.ParenExpr, expression: load, location: call.location, leadingTrivia: [], trailingTrivia: [] };
                  return updateNode(call, { callee: paren } as Partial<CallExpr>);
                }
              }
            }
          }
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
