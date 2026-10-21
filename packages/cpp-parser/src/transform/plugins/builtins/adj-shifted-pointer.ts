/**
 * `ADJ(p)` -> the container a shifted pointer points into.
 *
 * Ghidra prints an access through a shifted pointer (a pointer-typedef with a component
 * offset, see reconstruct/extract/shifted-pointers.ts) against the CONTAINER:
 * `ADJ(pSlotLink)->nTaskCount`, where pSlotLink points k bytes into a
 * D2TaskQueueSlotStrc. The typedef is emitted as a pointer to the member at k, and
 * `ADJ(p)` is that member's containing record:
 *
 *     ((D2TaskQueueSlotStrc *)((char *)pSlotLink - 0x10))->nTaskCount
 *
 * which is `CONTAINING_RECORD(pSlotLink, D2TaskQueueSlotStrc, sSlotLink)` written out, the
 * same address arithmetic the instructions do. The container comes from p's declared type
 * (a local, parameter, global or member typed with the shifted typedef); an `ADJ` whose
 * argument's type is not one is left as printed, and fails to compile where it stands.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CallExpr, Expression, FunctionDecl, Identifier, MemberExpr, ParameterDecl, TypeNode, VariableDecl,
} from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';
import { unwrapParens } from './call-arg-cast.js';

export interface AdjShiftedPointerOptions extends PluginOptions {
  /** Shifted typedef name -> the container it points into and the offset. */
  shiftedPointers?: Record<string, { container: string; offset: number; member?: string }>;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  returnTypes?: Record<string, string>;
}

function hex(n: number): Expression {
  return Expr.intLiteral(BigInt(Math.abs(n)), 16) as unknown as Expression;
}

function createAdjTransformer(o: AdjShiftedPointerOptions): Transformer {
  const specs = o.shiftedPointers ?? {};
  if (Object.keys(specs).length === 0) return createTransformer({});
  const tables = {
    globalTypes: o.globalTypes, enclosingVarTypes: o.enclosingVarTypes,
    structFields: o.structFields, fieldTypes: o.fieldTypes, returnTypes: o.returnTypes,
  };
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const localTypes = new Map<string, TypeNode>();
      for (const p of fn.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) localTypes.set(pd.name.name, pd.type);
      }
      for (const d of findNodesByKind(fn.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
      }
      const shape = createExprShape(localTypes, tables);
      let changed = false;
      // (Container *)((char *)p - k) for an ADJ(p) whose p is a known shifted pointer.
      // The transformer visits children first, so a member's ADJ object may already be lowered.
      const produced = new WeakSet<object>();
      const container = (n: ASTNode): Expression | undefined => {
        if (n.kind !== NodeKind.CallExpr) return undefined;
        const c = n as CallExpr;
        const callee = unwrapParens(c.callee);
        if (callee.kind !== NodeKind.Identifier || (callee as Identifier).name !== 'ADJ' || c.arguments.length !== 1) return undefined;
        const arg = c.arguments[0];
        const s = shape(arg);
        const spec = s && s.stars === 0 ? specs[s.base.replace(/^::/, '')] : undefined;
        if (!spec) return undefined;
        const bytes = Expr.cast(Type.pointer(Type.char()), Expr.paren(arg));
        const moved = spec.offset === 0 ? bytes : Expr.binary(bytes, spec.offset > 0 ? '-' : '+', hex(spec.offset));
        const out = Expr.paren(Expr.cast(Type.pointer(Type.typedef(spec.container)), Expr.paren(moved)));
        produced.add(out);
        return out;
      };
      const lower = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          // Ghidra prints the container's offset-0 member as `ADJ(p).f` (it reads *ADJ(p)); the
          // address is the same as `ADJ(p)->f`, and on the lowered pointer only `->` is C.
          if (n.kind === NodeKind.MemberExpr && !(n as MemberExpr).isArrow) {
            const m = n as MemberExpr;
            const lowered = produced.has(m.object) ? m.object : container(unwrapParens(m.object));
            if (!lowered) return undefined;
            changed = true;
            return { ...m, object: lowered, isArrow: true } as ASTNode;
          }
          const lowered = container(n);
          if (!lowered) return undefined;
          changed = true;
          return lowered;
        },
      });
      const body = lower(fn.body);
      return changed ? { ...fn, body } as ASTNode : undefined;
    },
  });
}

export const adjShiftedPointerPlugin: TransformPlugin = {
  id: 'adj-shifted-pointer',
  name: 'Shifted Pointer ADJ',
  description: "ADJ(p) on a shifted pointer -> (Container *)((char *)p - offset), the member's containing record",
  version: '1.0.0',
  defaultEnabled: true,
  // Before anything reads `ADJ(p)->field` as a member access on an unknown call.
  priority: 11,
  tags: ['correctness', 'ghidra', 'type'],
  createTransformer: (o?: PluginOptions) => createAdjTransformer((o ?? {}) as AdjShiftedPointerOptions),
};
