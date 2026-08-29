/**
 * Float/Pointer Bit-Reinterpretation Plugin
 *
 * A cast between a floating type and a pointer is not a conversion in any C
 * dialect - there is no value to convert - and C++ rejects it outright:
 * "invalid cast from type 'float' to type 'int*'". It appears here because the
 * decompiler recovers ONE type per stack slot while the machine reuses the same
 * four bytes as a float in one live range and as an address in another. The
 * instruction that produced the cast is a `mov`: the same four bytes, read
 * differently.
 *
 * So the faithful translation is a bit reinterpretation, not a value cast:
 *
 *     pChannelEntry = (int*)CalculateHypotenuse(...);   // slot holds a float
 *     if (fFalloffMin < (float)pChannelEntry)           // ...read back as one
 *
 * `d2_bits_of` / `d2_bits_to_float` in `d2_platform.h` do the four-byte move.
 * A `double`-typed operand is narrowed to `float` first, because the slot the
 * machine wrote is four bytes wide - the `double` is C's promotion of an x87
 * expression, not a wider store.
 *
 * Deliberately narrow: only floating-to-pointer and pointer-to-floating. A
 * float/integer cast IS a value conversion and is left exactly as it is.
 *
 * The same disagreement reaches AGGREGATES from both sides — a struct the
 * machine holds in a register, cast to the word it is (`(int)palPalEntry`), and
 * a word stored into the bytes a struct occupies (`(uD2UnitMode)pItem`). Neither
 * is a conversion C++ has, so both are written as the move the instruction
 * makes: `d2_bits_of` one way, `d2_bits_as<T>` the other. An aggregate whose
 * emitted declaration carries a converting constructor is left alone — there the
 * cast is legal C++ and already means exactly this.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, ParameterDecl, Expression, CStyleCastExpr, TypeNode,
  BinaryExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { emit } from '../../../emit/index.js';
import { createExprShape } from './expr-shape.js';
import {
  SCALAR_BASES, isAggregateValue, sameShape, shapeOfNode, unwrapParens,
  type TypeShape, type TypedefResolver,
} from './call-arg-cast.js';

export interface FloatPointerBitcastOptions extends PluginOptions {
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  /** Aggregates the emitted header gives a converting constructor to. */
  convertingAggregates?: string[];
}

/**
 * Every spelling the emitter uses for a floating slot. `float10` is Ghidra's
 * name for the x87 80-bit register, which reaches memory as one of these.
 */
const FLOAT_BASES = new Set(['float', 'double', 'long double', 'float10']);

const isFloating = (s: TypeShape | null): boolean => !!s && s.stars === 0 && FLOAT_BASES.has(s.base);
const isPointer = (s: TypeShape | null): boolean => !!s && s.stars > 0;

/** The arithmetic whose result is floating as soon as one operand is. */
const ARITHMETIC = new Set(['*', '/', '+', '-']);

/** A cast target that is one machine value: any pointer, or an arithmetic type. */
const isScalarTarget = (s: TypeShape): boolean =>
  s.stars > 0 || (SCALAR_BASES.has(s.base) && s.base !== 'void');

export function createFloatPointerBitcastTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as FloatPointerBitcastOptions;
  const typedefTargets = o.typedefTargets ?? {};
  const structFields = o.structFields ?? {};
  const converting = new Set(o.convertingAggregates ?? []);
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
        structFields,
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });

      /**
       * `expr-shape` has no shape for an arithmetic expression - it types
       * objects, not results - but `(D2SoundsTxt*)(*(float*)p * 0.003125)` is
       * still four bytes of float. Arithmetic is floating as soon as one side
       * is, so the operands are walked directly.
       */
      const isFloatingExpr = (e: Expression, depth: number): boolean => {
        if (depth > 6) return false;
        const u = unwrapParens(e);
        if (u.kind === NodeKind.FloatingLiteral) return true;
        if (u.kind === NodeKind.BinaryExpr) {
          const b = u as BinaryExpr;
          if (!ARITHMETIC.has(b.operator)) return false;
          return isFloatingExpr(b.left as Expression, depth + 1)
            || isFloatingExpr(b.right as Expression, depth + 1);
        }
        return isFloating(shapeOf(u));
      };

      let changed = false;
      const inner = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.CStyleCastExpr) return undefined;
          const cast = n as CStyleCastExpr;
          const target = shapeOfNode(cast.type, 0, resolve);
          if (!target) return undefined;
          const operand = shapeOf(cast.expression as Expression);

          // (T*)<floating> — the four bytes become an address.
          if (isPointer(target) && isFloatingExpr(cast.expression as Expression, 0)) {
            changed = true;
            return updateNode(cast, {
              expression: Expr.call('d2_bits_of', [cast.expression as Expression]),
            } as Partial<CStyleCastExpr>);
          }
          // (float)<pointer> — the address becomes four bytes. The outer cast is
          // kept so a `double` target still widens exactly as it did.
          if (isFloating(target) && isPointer(operand)) {
            changed = true;
            return updateNode(cast, {
              expression: Expr.call('d2_bits_to_float', [cast.expression as Expression]),
            } as Partial<CStyleCastExpr>);
          }
          // The same disagreement one step up: a struct the machine holds in a
          // register, cast to the word it is. `(int)palPalEntry` and
          // `(D2QServerHacklistEntryStrc*)nin_addr.S_un` are the decompiler
          // reading four bytes back out of an aggregate, not a conversion that
          // exists. Only a KNOWN aggregate qualifies, so an enum - where the
          // cast is legal and means the value - is never touched.
          if (operand && isScalarTarget(target) && isAggregateValue(operand, structFields)) {
            changed = true;
            return updateNode(cast, {
              expression: Expr.call(
                isFloating(target) ? 'd2_bits_to_float' : 'd2_bits_of',
                [cast.expression as Expression],
              ),
            } as Partial<CStyleCastExpr>);
          }
          // And the mirror of it: a machine word read back AS an aggregate.
          // `(uD2UnitMode)pItem`, `(FILETIME)0x0`, `(_struct_1227)nAddr` are the
          // store the instruction makes into the bytes the struct occupies -
          // there is no conversion from a word to a struct for C++ to perform,
          // so it reads the cast as a constructor call and reports one that does
          // not exist. Skipped where the emitted declaration DOES carry a
          // converting constructor (`D2SeedStrc`, `in_addr`): there the cast is
          // legal and already means this, and rewriting it would churn 900 sites
          // to no effect.
          if (target.stars === 0 && !!structFields[target.base] && !converting.has(target.base)
              && !(operand && sameShape(operand, target))) {
            changed = true;
            return Expr.call(
              `d2_bits_as<${emit(cast.type).trim()}>`,
              [cast.expression as Expression],
            );
          }
          return undefined;
        },
      });

      const newBody = inner(node.body);
      if (!changed) return undefined;
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const floatPointerBitcastPlugin: TransformPlugin = {
  id: 'float-pointer-bitcast',
  name: 'Float/Pointer Bit Reinterpretation',
  description:
    'Routes a cast between a floating type, a pointer or an aggregate through a bit reinterpretation, which is the move the machine performs',
  version: '1.0.0',
  defaultEnabled: true,
  // After pointer-compare-cast (615), so a comparison operand has settled first.
  priority: 618,
  tags: ['cleanup', 'type'],
  createTransformer: createFloatPointerBitcastTransformer,
};
