/**
 * Struct Field Access Plugin
 *
 * Transforms field offset patterns into arrow notation.
 *
 * Transforms:
 * - *(int *)(param_1 + 4)     →  param_1->field_4  or  ((StructType*)param_1)->field_4
 * - *(type *)(ptr + offset)   →  ptr->field_offset
 */

import { NodeKind } from '../../../ast/kinds.js';
import { typeNodeName } from './call-arg-cast.js';
import type {
  ASTNode,
  Expression,
  Identifier,
  UnaryExpr,
  BinaryExpr,
  MemberExpr,
  ParenExpr,
  CStyleCastExpr,
  IntegerLiteralExpr,
  PointerType,
  TypeNode,
  BuiltinType,
  TypedefType,
} from '../../../ast/nodes.js';
import {
  createTransformer,
  createKindTransformer,
  updateNode,
  sequence,
  type Transformer,
} from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// TYPES
// ============================================

/**
 * Known struct field layout
 */
export interface StructLayout {
  /** Struct name */
  name: string;

  /** Fields by offset */
  fields: Map<number, FieldInfo>;
}

/**
 * Field information
 */
export interface FieldInfo {
  /** Field name */
  name: string;

  /** Field type (as string) */
  type: string;

  /** Field offset in bytes */
  offset: number;

  /** Field size in bytes */
  size: number;
}

// ============================================
// HELPERS
// ============================================

/**
 * Unwrap parentheses from an expression
 */
function unwrapParens(expr: Expression): Expression {
  while (expr.kind === NodeKind.ParenExpr) {
    expr = (expr as ParenExpr).expression;
  }
  return expr;
}

/**
 * Get the integer value from a literal
 */
function getIntValue(expr: Expression): number | null {
  if (expr.kind === NodeKind.IntegerLiteral) {
    const val = (expr as IntegerLiteralExpr).value;
    // Convert to number, but check for overflow
    if (val >= 0n && val <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(val);
    }
  }
  return null;
}

/**
 * Get size of a basic type
 */
function getTypeSize(type: TypeNode): number | null {
  if (type.kind === NodeKind.PointerType) {
    // Assume 8-byte pointers (64-bit)
    return 8;
  }

  if (type.kind === NodeKind.BuiltinType) {
    const builtin = type as BuiltinType;
    const name = builtin.name.toLowerCase();
    const modifiers = builtin.modifiers || [];

    const hasLong = modifiers.includes('long');
    const hasShort = modifiers.includes('short');

    switch (name) {
      case 'char':
        return 1;
      case 'short':
        return 2;
      case 'int':
        if (hasShort) return 2;
        if (hasLong) return 8;
        return 4;
      case 'long':
        if (hasLong) return 8; // long long
        return 8; // Assume 64-bit
      case 'float':
        return 4;
      case 'double':
        if (hasLong) return 16; // long double
        return 8;
      case 'void':
        return 0;
      case 'bool':
        return 1;
      default:
        return null;
    }
  }

  return null;
}

/** Scalar / Ghidra-primitive typedef names (a pointer to one has no members). */
const SCALAR_TYPEDEF_RE =
  /^(u?int(8|16|32|64)?(_t)?|s?byte|s?word|s?dword|s?qword|undefined[1-8]?|bool[18]?|float\d*|double\d*|u?char|u?short|u?long|u?longlong|wchar(_t)?|code|void|size_t|ssize_t|ptrdiff_t|u?intptr_t)$/i;

/**
 * Does this pointee have no members, so `((T*)x)->field_N` cannot compile?
 *
 * The answer belongs to the type model, not to a name pattern. `aggregateNames`
 * is the set of typedef names that resolve — through Ghidra's own typedef chain —
 * to a struct or a union; when it is supplied, a typedef outside it has no
 * members, full stop. That is what catches the Win32 spellings a regex over
 * Ghidra's primitives never could: `HANDLE` is `void *`, `SOCKET` is `uint`,
 * `LPBYTE` is `BYTE *`, `PRTL_CRITICAL_SECTION_DEBUG` is a pointer — none of them
 * name anything with a `field_10` on it.
 *
 * With no set supplied (a caller with no type model) the old name test stands,
 * so the pass still recognises Ghidra's primitives and `e[A-Z]` enums.
 */
function hasNoMembers(t: TypeNode, aggregateNames?: ReadonlySet<string>): boolean {
  if (t.kind === NodeKind.BuiltinType) return true;
  if (t.kind === NodeKind.TypedefType) {
    const n = typeNodeName((t as TypedefType).name) ?? '';
    if (aggregateNames) return !aggregateNames.has(n);
    return SCALAR_TYPEDEF_RE.test(n) || /^e[A-Z]/.test(n);
  }
  return false;
}

/**
 * Generate a field name from offset
 */
function generateFieldName(offset: number, type?: TypeNode): string {
  // If we have type info, use it to generate better names
  if (type && type.kind === NodeKind.PointerType) {
    const ptrType = type as PointerType;
    if (ptrType.pointee.kind === NodeKind.BuiltinType) {
      const builtin = ptrType.pointee as BuiltinType;
      const name = builtin.name.toLowerCase();

      switch (name) {
        case 'char':
          return `str_${offset.toString(16)}`;
        case 'int':
          return `int_${offset.toString(16)}`;
        case 'void':
          return `ptr_${offset.toString(16)}`;
        default:
          break;
      }
    }
  }

  // Default: field_OFFSET in hex
  return `field_${offset.toString(16)}`;
}

// ============================================
// STRUCT FIELD TRANSFORMATION
// ============================================

/**
 * Transform *(type *)(ptr + offset) to ptr->field_offset
 */
function createStructFieldTransformer(
  layouts?: Map<string, StructLayout>,
  aggregateNames?: ReadonlySet<string>,
): Transformer {
  return createKindTransformer(NodeKind.UnaryExpr, (node) => {
    const unary = node as UnaryExpr;

    // Only handle dereference
    if (unary.operator !== '*') return undefined;

    // Must be a cast expression
    if (unary.operand.kind !== NodeKind.CStyleCastExpr) return undefined;

    const cast = unary.operand as CStyleCastExpr;

    // Cast must be to a pointer type
    if (cast.type.kind !== NodeKind.PointerType) return undefined;

    // Inner expression must be binary addition
    const inner = unwrapParens(cast.expression);
    if (inner.kind !== NodeKind.BinaryExpr) return undefined;

    const binary = inner as BinaryExpr;
    if (binary.operator !== '+') return undefined;

    // Determine base and offset
    let base: Expression;
    let offsetValue: number | null = null;

    // Try right as offset first (most common: ptr + 4)
    offsetValue = getIntValue(binary.right);
    if (offsetValue !== null) {
      base = binary.left;
    } else {
      // Try left as offset (less common: 4 + ptr)
      offsetValue = getIntValue(binary.left);
      if (offsetValue !== null) {
        base = binary.right;
      } else {
        // Neither side is a constant offset, can't transform
        return undefined;
      }
    }

    // Don't transform offset 0 (that's just a cast)
    if (offsetValue === 0) return undefined;

    // `castBase->field_N` compiles only when castBase is a pointer to a struct/
    // union. castBase's pointer type is the base's OWN cast (when base is already
    // a cast) or the deref's `cast.type` (when we wrap a bare base). Skip when:
    //   - the base is raw pointer arithmetic `(int)p + n` (BinaryExpr) — a
    //     computed address, never a struct lvalue; or
    //   - the effective pointer points to a scalar/enum (`((int *)x)->f`,
    //     `((uint16_t *)x)->f`, `((char *)((int)p+n))->str_c` never compile); or
    //   - the effective "pointer" is not a pointer at all (`(int)p` base →
    //     "base operand is not a pointer").
    // The faithful `*(T*)(base + off)` deref already compiles and is what the
    // decompiler meant. A genuine struct base (Identifier/MemberExpr cast to a
    // struct pointer) is preserved as `ptr->field_N`. (Subsumes the old SUBPIECE
    // `(char *)&x` guard.)
    const baseUnwrapped = unwrapParens(base);
    if (baseUnwrapped.kind === NodeKind.BinaryExpr) return undefined;
    const effectiveType = baseUnwrapped.kind === NodeKind.CStyleCastExpr
      ? (baseUnwrapped as CStyleCastExpr).type
      : cast.type;
    if (effectiveType.kind !== NodeKind.PointerType) return undefined;
    const effPointee = (effectiveType as PointerType).pointee;
    // A pointer-to-pointer (`(T **)x`) memberized gives `((T **)x)->field`, whose
    // `->` yields `T *` — still a pointer, so `.field_N` on it is "request for
    // member … in pointer type (maybe you meant ->)". Leave the faithful deref.
    if (effPointee.kind === NodeKind.PointerType) return undefined;
    if (hasNoMembers(effPointee, aggregateNames)) return undefined;

    // Determine field name
    let fieldName: string;

    // Check if we have layout information for this struct
    if (layouts) {
      // Try to find the struct by examining the base expression
      // This is a simplified heuristic; full implementation would use type info
      let structName: string | null = null;

      if (base.kind === NodeKind.Identifier) {
        // Could look up parameter type from function signature
        // For now, just use the default field name
      }

      if (structName && layouts.has(structName)) {
        const layout = layouts.get(structName)!;
        const field = layout.fields.get(offsetValue);
        if (field) {
          fieldName = field.name;
        } else {
          fieldName = generateFieldName(offsetValue, cast.type);
        }
      } else {
        fieldName = generateFieldName(offsetValue, cast.type);
      }
    } else {
      fieldName = generateFieldName(offsetValue, cast.type);
    }

    // Create member expression: base->fieldName
    const fieldId: Identifier = {
      kind: NodeKind.Identifier,
      name: fieldName,
      location: unary.location,
      leadingTrivia: [],
      trailingTrivia: [],
    };

    // Cast the base to the appropriate pointer type if needed
    let castBase: Expression = base;

    // Only add cast if base doesn't already have matching type
    if (base.kind !== NodeKind.CStyleCastExpr) {
      castBase = {
        kind: NodeKind.CStyleCastExpr,
        type: cast.type,
        expression: base,
        location: cast.location,
        leadingTrivia: [],
        trailingTrivia: [],
      } as CStyleCastExpr;
    }

    return {
      kind: NodeKind.MemberExpr,
      object: castBase,
      member: fieldId,
      isArrow: true,
      location: unary.location,
      leadingTrivia: unary.leadingTrivia,
      trailingTrivia: unary.trailingTrivia,
    } as MemberExpr;
  });
}

/**
 * Transform scaled offset patterns for arrays within structs
 * *(type *)(ptr + offset + i * sizeof(type))
 */
function createArrayFieldTransformer(): Transformer {
  // This would detect patterns like:
  // *(int *)(param_1 + 8 + i * 4)
  // Which suggests an int array at offset 8

  // For now, this is a placeholder for future enhancement
  return (node) => node;
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface StructFieldOptions extends PluginOptions {
  /** Transform *(type*)(ptr + offset) to ptr->field (default: true) */
  offsetToField?: boolean;

  /** Known struct layouts for accurate field names */
  layouts?: Map<string, StructLayout>;

  /**
   * Every type name that resolves to a struct or a union, typedefs included.
   * A pointee typedef outside this set has no members, so the pass leaves the
   * faithful `*(T*)(base + off)` deref alone instead of inventing `->field_N`.
   */
  aggregateTypeNames?: string[];

  /** Minimum offset to transform (to avoid false positives) */
  minOffset?: number;

  /** Maximum offset to transform */
  maxOffset?: number;
}

/**
 * Struct Field Access Plugin
 *
 * Transforms struct field offset patterns into arrow notation
 * for more readable code.
 */
export const structFieldPlugin: TransformPlugin = {
  id: 'struct-field',
  name: 'Struct Field Access',
  description:
    'Transform struct field patterns like *(int*)(ptr + 4) to ptr->field_4',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 50, // After array access transformation
  tags: ['core', 'cleanup', 'structs'],

  createTransformer(options?: StructFieldOptions) {
    const opts = options ?? {};
    const transforms: Transformer[] = [];

    if (opts.offsetToField !== false) {
      const aggregateNames = opts.aggregateTypeNames
        ? new Set(opts.aggregateTypeNames)
        : undefined;
      transforms.push(createStructFieldTransformer(opts.layouts, aggregateNames));
    }

    return sequence(...transforms);
  },
};

// Types are exported at top of file
