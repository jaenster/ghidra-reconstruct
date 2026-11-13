/**
 * Compare Signedness Plugin
 *
 * `compare-form` writes `X == 0` as `X <= 0` and `X != 0` as `X > 0` where the instructions
 * compare unsigned (`TEST r,r; JBE`), and casts X when its declared type is not unsigned.
 * Both forms equal the original only while X stays unsigned, and the passes between may give
 * X its final type (a register local folded onto its parameter, a global's real type). This
 * pass reads the tagged comparisons again with the final types and casts X to the unsigned
 * type of the compare's width wherever it no longer is unsigned. A constant that crossed zero
 * on a signed compare (`n >= 0` from `-1 < n`) is kept signed the same way.
 *
 * A 32-bit compare the instructions make signed (JL/JLE/JG/JGE; `compare-form` records it on
 * every comparison it ties) stays signed in C++ too. C++ compares unsigned as soon as one
 * operand is an `unsigned int` after the integer promotions, and two shapes the decompile
 * prints make one: arithmetic on an unsigned value, `0x14 < seed.nSeedLow % 100`, and an enum
 * constant, whose underlying type is `uint32_t` when the enum has no negative member
 * (`enum-width.ts`), compared with an int, `nQuest < QUEST_ActIntroduced`. VC8 then branches
 * with JBE/JAE where the original has JLE/JGE (AITHINK_Fn1_Mosquito 005f3730,
 * SCMD_0x58_MarkQuestDone 0054c9c0). Such an operand is cast to `int32_t`, which is the
 * comparison the instructions make; an operand narrower than an int is promoted to a signed
 * int anyway and is left as it is, and a pointer comparison is never touched.
 *
 * At a native byte/word equality, the operands are bit patterns of that width.
 * C++ instead promotes a signed and unsigned narrow pair to int: int16_t(-1)
 * and uint16_t(65535) then compare unequal. Where compare-form records a native
 * one- or two-byte comparison, cast the signed operand to that unsigned width.
 * Both declared widths must match the native width. An implicit widening needs
 * its own sign/zero-extension evidence, which a comparison-width fact lacks.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, ConditionalExpr, Expression, FunctionDecl, Identifier, IntegerLiteralExpr, QualifiedId, UnaryExpr,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import { unwrapParens, type TypedefResolver } from './call-arg-cast.js';
import { localTypesOf, operandSignedness, compareCast } from './compare-form.js';

export interface CompareSignednessOptions extends PluginOptions {
  enumTypes?: string[];
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  /** Enum constant → the enum that declares it, for constant names unique program-wide. */
  enumConstantTypes?: Record<string, string>;
}

/** The spellings of a 32-bit unsigned integer, after typedef resolution. */
const UNSIGNED_INT = new Set([
  'uint', 'uint32_t', 'unsigned', 'unsigned int', 'unsigned long', 'ulong', 'DWORD', 'UINT', 'ULONG', 'dword',
  'size_t', 'uintptr_t',
]);

const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '&', '|', '^']);

const NARROW_SIGNED = new Map([
  ...['char', 'signed char', 'int8_t', 'sbyte', 'CHAR'].map(n => [n, 1] as const),
  ...['short', 'short int', 'signed short', 'signed short int', 'int16_t', 'SHORT', 'sword'].map(n => [n, 2] as const),
]);
const NARROW_UNSIGNED = new Map([
  ...['unsigned char', 'uint8_t', 'byte', 'uchar', 'BYTE', 'UCHAR'].map(n => [n, 1] as const),
  ...['unsigned short', 'unsigned short int', 'uint16_t', 'ushort', 'word', 'WORD', 'USHORT'].map(n => [n, 2] as const),
]);

function narrowInteger(e: Expression, shapeOf: ExprShape): { width: number; signed: boolean } | null {
  const s = shapeOf(e);
  if (!s || s.stars !== 0) return null;
  const signed = NARROW_SIGNED.get(s.base), unsigned = NARROW_UNSIGNED.get(s.base);
  if (signed) return { width: signed, signed: true };
  if (unsigned) return { width: unsigned, signed: false };
  return null;
}

/** The native equality's bit domain, instead of the wider integer promotions. */
function narrowEquality(be: BinaryExpr, shapeOf: ExprShape): BinaryExpr | null {
  const width = be.ghidraInfo?.compareWidth;
  if ((be.operator !== '==' && be.operator !== '!=') || (width !== 1 && width !== 2)) return null;
  const l = narrowInteger(be.left, shapeOf), r = narrowInteger(be.right, shapeOf);
  if (!l || !r || l.width !== width || r.width !== width || l.signed === r.signed) return null;
  return updateNode(be, {
    left: l.signed ? compareCast(be.left, width) : be.left,
    right: r.signed ? compareCast(be.right, width) : be.right,
  } as Partial<BinaryExpr>);
}

/**
 * Whether `e` is an `unsigned int` once the integer promotions and the usual arithmetic
 * conversions are applied - so that comparing it with an int compares unsigned. `pointer`
 * for a pointer operand; `false` also where the type cannot be told, which leaves it alone.
 */
export function promotesToUnsignedInt(
  e: Expression,
  shapeOf: ExprShape,
  enumConstantTypes: Record<string, string>,
  typedefTargets: Record<string, string>,
): boolean | 'pointer' {
  const base = (name: string): string => {
    let b = name;
    for (let i = 0; i < 8 && typedefTargets[b] && typedefTargets[b] !== b; i++) b = typedefTargets[b];
    return b;
  };
  const visit = (x: Expression): boolean | 'pointer' => {
    const u = unwrapParens(x);
    switch (u.kind) {
      case NodeKind.IntegerLiteral: {
        const lit = u as IntegerLiteralExpr;
        if (/u/i.test(lit.suffix)) return true;
        // An unsuffixed hex or octal literal above INT_MAX is an unsigned int in C++.
        return lit.base !== 10 && lit.value > 0x7fffffffn && lit.value <= 0xffffffffn;
      }
      case NodeKind.CharLiteral:
      case NodeKind.BoolLiteral:
      case NodeKind.FloatingLiteral:
        return false;
      case NodeKind.Identifier:
      case NodeKind.QualifiedId: {
        const last = u.kind === NodeKind.Identifier ? (u as Identifier) : (u as QualifiedId).name;
        const name = last.kind === NodeKind.Identifier ? (last as Identifier).name : undefined;
        const enumName = name ? enumConstantTypes[name] : undefined;
        if (enumName) return UNSIGNED_INT.has(base(enumName));
        break;
      }
      case NodeKind.BinaryExpr: {
        const b = u as BinaryExpr;
        if (ARITHMETIC.has(b.operator)) {
          const l = visit(b.left), r = visit(b.right);
          if (l === 'pointer' || r === 'pointer') return 'pointer';
          return l || r;
        }
        if (b.operator === '<<' || b.operator === '>>') return visit(b.left);
        return false;
      }
      case NodeKind.UnaryExpr: {
        const un = u as UnaryExpr;
        if (un.operator === '-' || un.operator === '+' || un.operator === '~') return visit(un.operand);
        if (un.operator === '!') return false;
        break;
      }
      case NodeKind.ConditionalExpr: {
        const c = u as ConditionalExpr;
        const t = visit(c.thenExpr), f = visit(c.elseExpr);
        if (t === 'pointer' || f === 'pointer') return 'pointer';
        return t || f;
      }
    }
    const s = shapeOf(u);
    if (!s) return false;
    if (s.stars > 0) return 'pointer';
    return UNSIGNED_INT.has(base(s.base));
  };
  return visit(e);
}

export function createCompareSignednessTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as CompareSignednessOptions;
  const enumTypes = new Set(o.enumTypes ?? []);
  const typedefTargets = o.typedefTargets ?? {};
  const enumConstantTypes = o.enumConstantTypes ?? {};
  // An enum is not unsigned whatever it is spelled with.
  const resolve: TypedefResolver = name => (enumTypes.has(name) ? undefined : typedefTargets[name]);

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      const tables = {
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
      };
      const localTypes = localTypesOf(node);
      const shapeOf = createExprShape(localTypes, { ...tables, resolve });
      // What C++ compares with: an enum is its underlying type here.
      const cppShapeOf = createExprShape(localTypes, { ...tables, resolve: name => typedefTargets[name] });
      let changed = false;
      const inner = createTransformer({
        visitBinaryExpr(be: BinaryExpr): ASTNode | undefined {
          const equality = narrowEquality(be, shapeOf);
          if (equality) { changed = true; return equality; }
          const unsignedWidth = be.ghidraInfo?.unsignedCompareWidth;
          const signedWidth = be.ghidraInfo?.signedCompareWidth;
          if (unsignedWidth) {
            const s = operandSignedness(be.left, shapeOf);
            if (s === 'unsigned' || s === 'pointer') return undefined;
            changed = true;
            return updateNode(be, { left: compareCast(be.left, unsignedWidth) } as Partial<BinaryExpr>);
          }
          if (signedWidth && operandSignedness(be.left, shapeOf) === 'unsigned') {
            changed = true;
            return updateNode(be, { left: compareCast(be.left, signedWidth, true) } as Partial<BinaryExpr>);
          }
          if (be.ghidraInfo?.signedJccWidth === 4 && !signedWidth) {
            const l = promotesToUnsignedInt(be.left, cppShapeOf, enumConstantTypes, typedefTargets);
            const r = promotesToUnsignedInt(be.right, cppShapeOf, enumConstantTypes, typedefTargets);
            if (l === 'pointer' || r === 'pointer' || (!l && !r)) return undefined;
            changed = true;
            return updateNode(be, {
              left: l ? compareCast(be.left, 4, true) : be.left,
              right: r ? compareCast(be.right, 4, true) : be.right,
            } as Partial<BinaryExpr>);
          }
          return undefined;
        },
      });
      const body = inner(node.body);
      return changed ? updateNode(node, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const compareSignednessPlugin: TransformPlugin = createPlugin(
  'compare-signedness',
  'Compare Signedness',
  'A comparison keeps the signedness its instructions show under the final types',
  (options?: PluginOptions) => createCompareSignednessTransformer(options),
  {
    priority: 619, // after unsigned-range-compare (617): needs the final local and global types
    defaultEnabled: true,
    tags: ['correctness'],
    version: '1.0.0',
  },
);
