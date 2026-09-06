/**
 * Return-Value Cast-Insertion Plugin
 *
 * Ghidra's output is C. In C a `void*` converts to any object pointer implicitly and
 * unrelated object pointers convert with a warning; C++ allows neither, so a decompiled
 *
 *     short int * UNICODE_FindWideChar(void *pThis, int16_t wChar) { ...; return pThis; }
 *
 * is not valid C++ - "invalid conversion from 'void*' to 'short int*'". The original MSVC
 * source had to write the cast, so writing it back is RECONSTRUCTION, not invention: the
 * parameter really is `void*` in the binary and the conversion is one the machine performs
 * for free.
 *
 * `assign-cast` does this at a store and `call-arg-cast` at an argument. `return` was the
 * third position and had no pass, which is why `UNICODE_FindWideChar`
 * (D2Lang/Unicode/UNISYS.cpp, 00526670) needed a hand patch that survived every regen.
 *
 * ## What it will not do
 *
 * Only fires when BOTH types are determinable pointers that differ. A value whose type
 * cannot be read gets nothing: casting on a guess silently reinterprets it, and a compile
 * error that names the line is worth more than a wrong pointer that links. Returning a
 * typed pointer as `void*` is left alone too - that widening is legal C++.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, Expression, FunctionDecl, Identifier, ParameterDecl, ReturnStmt,
  TypeNode, PointerType, CStyleCastExpr, UnaryExpr, ParenExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { shapeOfNode, sameShape } from './call-arg-cast.js';

export interface ReturnCastOptions extends PluginOptions {
  /**
   * Names (bare AND qualified) of functions that return `void*`, so a `return SMemAlloc(n)`
   * in a typed-pointer function is recognised. Same list `pointer-assign-cast` takes.
   */
  voidPointerFunctions?: string[];
}

function unwrapParens(e: Expression): Expression {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression;
  return x;
}

function calleeName(expr: Expression): string | undefined {
  const e = unwrapParens(expr);
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  if (e.kind === NodeKind.QualifiedId) {
    const q = e as unknown as { name?: unknown };
    const n = q.name;
    return typeof n === 'string' ? n : undefined;
  }
  return undefined;
}

/**
 * The pointer type of a returned expression, or null when it cannot be read.
 *
 * Deliberately the same narrow set of shapes `pointer-assign-cast` trusts: an explicit
 * cast, an address-of-deref that cancels to one, a named pointer whose declaration is in
 * this function, or a call to a known `void*` function.
 */
function returnedPointerType(
  expr: Expression,
  typeByName: Map<string, TypeNode>,
  voidPointerFunctions: Set<string>,
): TypeNode | null {
  const e = unwrapParens(expr);

  if (e.kind === NodeKind.CStyleCastExpr) {
    const ct = (e as CStyleCastExpr).type;
    return ct.kind === NodeKind.PointerType ? ct : null;
  }

  // &*(U*)x cancels to (U*)x
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '&') {
    const inner = unwrapParens((e as UnaryExpr).operand);
    if (inner.kind === NodeKind.UnaryExpr && (inner as UnaryExpr).operator === '*') {
      return returnedPointerType((inner as UnaryExpr).operand, typeByName, voidPointerFunctions);
    }
    return null;
  }

  if (e.kind === NodeKind.Identifier) {
    const t = typeByName.get((e as Identifier).name);
    return t && t.kind === NodeKind.PointerType ? t : null;
  }

  if (e.kind === NodeKind.CallExpr && voidPointerFunctions.size > 0) {
    const name = calleeName((e as { callee: Expression }).callee);
    if (!name) return null;
    const bare = name.includes('::') ? name.slice(name.lastIndexOf('::') + 2) : name;
    if (voidPointerFunctions.has(name) || voidPointerFunctions.has(bare)) {
      return { kind: NodeKind.PointerType, pointee: { kind: NodeKind.BuiltinType, name: 'void' } } as TypeNode;
    }
  }

  return null;
}

/** Every pointer-typed name declared in this function: parameters first, then body locals. */
function pointerTypesInScope(fn: FunctionDecl): Map<string, TypeNode> {
  const types = new Map<string, TypeNode>();
  for (const p of fn.parameters ?? []) {
    const param = p as ParameterDecl;
    // `name` is an Identifier NODE, not a string.
    if (param.name?.name && param.type) types.set(param.name.name, param.type);
  }
  if (fn.body) {
    for (const d of findNodesByKind(fn.body as ASTNode, NodeKind.VariableDecl)) {
      const v = d as VariableDecl;
      if (v.name?.name && v.type) types.set(v.name.name, v.type);
    }
  }
  return types;
}

function createReturnCastTransformer(options: ReturnCastOptions = {}): Transformer {
  const voidPointerFunctions = new Set(options.voidPointerFunctions ?? []);

  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body || !fn.returnType) return undefined;

      const want = shapeOfNode(fn.returnType);
      // Not a pointer return, or a type we cannot read. `void*` accepts anything.
      if (!want || want.stars === 0 || want.base === 'void') return undefined;

      const typeByName = pointerTypesInScope(fn);
      let changed = false;

      const inner = createTransformer({
        visitReturnStmt(ret: ReturnStmt): ASTNode | undefined {
          if (!ret.value) return undefined;
          const have = returnedPointerType(ret.value, typeByName, voidPointerFunctions);
          if (!have) return undefined;

          const got = shapeOfNode(have);
          if (!got || sameShape(got, want)) return undefined;

          changed = true;
          return updateNode(ret, {
            value: Expr.cast(fn.returnType as TypeNode, ret.value),
          } as Partial<ReturnStmt>);
        },
      });

      const body = inner(fn.body as ASTNode);
      if (!changed) return undefined;
      return updateNode(fn, { body } as Partial<FunctionDecl>);
    },
  });
}

export const returnCastPlugin: TransformPlugin = {
  id: 'return-cast',
  name: 'Return-Value Cast Insertion',
  description: 'Casts a returned pointer to the function\'s declared return type when C++ would reject the conversion',
  version: '1.0.0',
  defaultEnabled: true,
  // Beside assign-cast (615) and call-arg-cast (610): after the types are final and after
  // the goto passes have finished moving returns around.
  priority: 616,
  tags: ['type', 'correctness'],
  createTransformer: createReturnCastTransformer,
};
