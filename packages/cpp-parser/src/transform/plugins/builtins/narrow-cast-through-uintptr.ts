/**
 * Narrowing-Cast-Through-`uintptr_t` Plugin
 *
 * The machine reads the low byte or the low word of an address. Ghidra spells
 * that `(char)pSep`, `(uint16_t)local_c`, `(uint8_t)pMsg[1].pNext` — a C-style
 * cast straight from a pointer to an integer narrower than a pointer. C++
 * rejects it outright ("cast from 'T*' to 'char' loses precision"), while C
 * allowed it, which is why the decompiler emits it and the tree does not build.
 *
 * `(IntT)(uintptr_t)ptr` is the C++ spelling of the same operation, and on a
 * 32-bit target it is exact: the address becomes a machine word, the word is
 * truncated to `IntT`. That is byte-for-byte what the `mov al, [..]` /
 * `movzx eax, word ptr [..]` did. Nothing is invented and nothing is silenced —
 * the truncation stays visible, it is merely spelled in two steps instead of one.
 *
 * The pass only fires on a cast that CANNOT compile today, so it cannot regress
 * a translation unit:
 *
 *   - the target must be an integer STRICTLY NARROWER than a pointer. A cast to
 *     `int` / `uint32_t` / `uintptr_t` is already legal and is left alone.
 *   - `bool` is deliberately NOT in the set. `(bool)ptr` is a legal C++
 *     conversion, so rewriting it would touch code that already builds, and the
 *     "only errors are touched" guarantee is the whole safety argument.
 *   - the operand's type must reduce to a POINTER. A funcdef typedef (`Draw`,
 *     `Key`) counts: it names a code address, which `asCodeAddress` reduces to
 *     one indirection, and g++ rejects narrowing it exactly as it rejects
 *     narrowing an object pointer.
 *   - a shape the model cannot determine comes back `null` and is left alone,
 *     the same refusal every other cast pass makes.
 *
 * The source type is NEVER repaired here. Each of the sites this clears was
 * checked against the disassembly and the declaration is right: `pwszCursor` in
 * `D2WINEDITBOX_HandleKeyRelease` really is 4-byte-strided, `D2ControlStrc::fpDraw`
 * really is a `Draw`, and the 0xA3 packet payload really does run into the next
 * queue entry. Retyping any of them would make a shared header lie about the
 * other users of the same slot; the cast is where the truth belongs.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, ParameterDecl, Expression, CStyleCastExpr, TypeNode,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Type, Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';
import {
  asCodeAddress, cachedSet, shapeOfNode, type TypedefResolver,
} from './call-arg-cast.js';

export interface NarrowCastThroughUintptrOptions extends PluginOptions {
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  funcdefNames?: string[];
}

/**
 * Canonical bases for an integer strictly narrower than a 32-bit pointer.
 * Everything the emitter spells — `uint8_t`, `byte`, `WORD`, `short int`,
 * `undefined2` — reduces into this set through `TYPE_ALIASES`, so the set is
 * the canonical widths and not a list of spellings.
 *
 * `wchar_t` is here because it is 16 bits on this target, which is what makes
 * `(WCHAR)ptr` a narrowing cast rather than a word-wide one.
 */
const NARROW_INTEGER_BASES = new Set([
  'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'wchar_t',
]);

export function createNarrowCastThroughUintptrTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as NarrowCastThroughUintptrOptions;
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  const funcdefNames = cachedSet(o.funcdefNames);

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
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.CStyleCastExpr) return undefined;
          const cast = n as CStyleCastExpr;
          const target = shapeOfNode(cast.type, 0, resolve);
          if (!target || target.stars !== 0) return undefined;
          if (!NARROW_INTEGER_BASES.has(target.base)) return undefined;

          const operand = cast.expression as Expression;
          const source = asCodeAddress(shapeOf(operand), funcdefNames);
          if (!source || source.stars === 0) return undefined;

          changed = true;
          return updateNode(cast, {
            expression: Expr.cast(Type.typedef('uintptr_t'), operand),
          } as Partial<CStyleCastExpr>);
        },
      });

      const newBody = inner(node.body);
      if (!changed) return undefined;
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const narrowCastThroughUintptrPlugin: TransformPlugin = {
  id: 'narrow-cast-through-uintptr',
  name: 'Narrowing Pointer Cast Through uintptr_t',
  description:
    'Routes a C-style cast from a pointer to a sub-pointer-width integer through uintptr_t, which C++ requires and the machine performs on the address word',
  version: '1.0.0',
  // After every cast-inserting pass (call-arg-cast 610, assign-cast and
  // pointer-compare-cast 615, float-pointer-bitcast 618), so the operand's
  // final spelling is the one this reads.
  priority: 620,
  defaultEnabled: true,
  tags: ['cleanup', 'type'],
  createTransformer: createNarrowCastThroughUintptrTransformer,
};
