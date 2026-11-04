/**
 * Global Distance Index Plugin
 *
 * Fog's FreeMemoryPool hands a pool manager's slot back to the free list:
 *
 *     00409d79  MOV ECX, EBX
 *               SUB ECX, 0x74f104          ; - pGlobalPoolSystem.pManagers
 *               MOV EAX, 0x583f339b
 *               MUL ECX                    ; / sizeof(D2PoolManagerStrc), unsigned
 *
 * The decompiler has no symbol for "pManagers as an integer", so it folds the subtracted
 * address into the pointer, as a negative subscript of the manager and an offset into one
 * of its members:
 *
 *     (uint)(pMemory[-0x4eb].pOverflow + 0x3e5) / 0x17cc
 *
 * -0x4eb * 0x17cc + 0x7ac (pOverflow) + 0x3e5 * 4 is -0x74f104. In the image that is the
 * slot index; in a rebuild pManagers is somewhere else and the index is garbage, and the
 * next InitializePoolSystem hands out a manager far outside the array.
 *
 * The evidence is the instruction, not the shape: the function encodes A = 0x74f104 with a
 * plain reference, and the integer-cast pointer expression evaluates, exactly, to P - A for
 * a pointer local or parameter P. It is respelled as the difference it is:
 *
 *     (uint)((intptr_t)pMemory - (intptr_t)Fog::Memory::pGlobalPoolSystem.pManagers) / 0x17cc
 *
 * the same integer in the image, the right one in the rebuild, and the outer cast and the
 * division are kept as printed (the original divides unsigned).
 *
 * Exact, never inferred:
 *  - the expression is the operand of an integer cast;
 *  - it is a walk from P: subscripts by a literal (sizeof the pointee), `.member` steps
 *    (Ghidra's layout) and `+`/`-` of a literal (the element size of the pointer or decayed
 *    array the step is on); every size comes from the aggregate tables or the step is
 *    refused;
 *  - the offset is negative and its magnitude A is an address the function encodes with a
 *    plain reference;
 *  - A is the start of exactly one global's extent or of one member of it (by layout), and
 *    is spelled through it.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, BuiltinType, CStyleCastExpr, Expression, Identifier, IntegerLiteralExpr,
  MemberExpr, ParenExpr, SubscriptExpr, TypedefType, UnaryExpr,
} from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';

export interface GlobalDistanceIndexOptions extends PluginOptions {
  /** Addresses the function's instructions encode with a plain reference. */
  displacements?: readonly number[];
  /** Local and parameter name -> declared type spelling. */
  enclosingVarTypes?: Record<string, string>;
  /** Aggregate name -> size in bytes. */
  aggregateSizes?: Record<string, number>;
  /** Aggregate name -> every field's offset, size and Ghidra type. */
  structLayouts?: Record<string, ReadonlyArray<{ name: string; offset: number; size: number; type: string; bitSize?: number }>>;
  /** Global name (as emitted) -> address. */
  globalAddresses?: Record<string, number>;
  /** Global name -> size in bytes. */
  globalSizes?: Record<string, number>;
  /** Global name -> declared type spelling. */
  globalTypes?: Record<string, string>;
  /** Global name -> namespace segments of its definition. */
  globalNamespaces?: Record<string, readonly string[]>;
  onRewrite?: (info: { value: number; from: string; to: string }) => void;
}

const INT_CASTS = new Set(['int', 'uint', 'uintptr_t', 'intptr_t', 'int32_t', 'uint32_t', 'DWORD', 'long', 'ulong', 'undefined4', 'size_t']);
const SCALAR_SIZES: Record<string, number> = {
  char: 1, uchar: 1, byte: 1, BYTE: 1, uint8_t: 1, int8_t: 1, undefined1: 1, bool: 1,
  short: 2, ushort: 2, WORD: 2, uint16_t: 2, int16_t: 2, undefined2: 2, wchar_t: 2,
  int: 4, uint: 4, DWORD: 4, uint32_t: 4, int32_t: 4, undefined4: 4, long: 4, ulong: 4, float: 4, size_t: 4,
  double: 8, longlong: 8, ulonglong: 8, int64_t: 8, uint64_t: 8, undefined8: 8,
};

function unwrap(e: Expression): Expression {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression;
  return x;
}

function typeName(t: ASTNode): string | undefined {
  if (t.kind === NodeKind.TypedefType) {
    const n = (t as TypedefType).name;
    return n.kind === NodeKind.Identifier ? (n as Identifier).name : undefined;
  }
  if (t.kind === NodeKind.BuiltinType) {
    const b = t as BuiltinType & { modifiers?: string[] };
    const unsigned = (b.modifiers ?? []).includes('unsigned');
    if (b.name === 'int') return unsigned ? 'uint' : 'int';
    if (b.name === 'long') return unsigned ? 'ulong' : 'long';
    return b.name;
  }
  return undefined;
}

/** A type spelling as its parts: `T *`, `T[a][b]`, `T`. */
interface Shape { base: string; pointers: number; dims: number[] }

function shapeOf(spelling: string): Shape | null {
  let s = spelling.trim().replace(/\s*\*\s*32\b/g, ' *');
  const dims: number[] = [];
  const arr = /^(.*?)\s*((?:\[\s*\d+\s*\])+)$/.exec(s);
  if (arr) {
    for (const d of arr[2]!.matchAll(/\d+/g)) dims.push(Number(d[0]));
    s = arr[1]!.trim();
  }
  let pointers = 0;
  while (s.endsWith('*')) { pointers++; s = s.slice(0, -1).trim(); }
  s = s.replace(/^(const|volatile)\s+/, '').replace(/^(struct|union|class)\s+/, '');
  if (!/^[A-Za-z_][\w:<>, ]*$/.test(s)) return null;
  return { base: s, pointers, dims };
}

export function createGlobalDistanceIndexTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as GlobalDistanceIndexOptions;
  const displacements = new Set(o.displacements ?? []);
  if (displacements.size === 0) return (n: ASTNode) => n;
  const varTypes = o.enclosingVarTypes ?? {};
  const aggregateSizes = o.aggregateSizes ?? {};
  const layouts = o.structLayouts ?? {};
  const addresses = o.globalAddresses ?? {};
  const sizes = o.globalSizes ?? {};
  const globalTypes = o.globalTypes ?? {};
  const namespaces = o.globalNamespaces ?? {};

  const bare = (name: string) => (name.includes('<') ? name : name.split('::').pop()!);
  const layoutOf = (name: string) => layouts[name] ?? layouts[bare(name)];

  /** sizeof a type shape, or undefined when not exactly known. */
  function sizeOf(s: Shape): number | undefined {
    let n: number | undefined;
    if (s.pointers > 0) n = 4;
    else n = SCALAR_SIZES[s.base] ?? aggregateSizes[s.base] ?? aggregateSizes[bare(s.base)];
    if (n === undefined) return undefined;
    for (const d of s.dims) n *= d;
    return n;
  }

  /** The element a pointer or array shape steps over, or null. */
  function elementOf(s: Shape): Shape | null {
    if (s.dims.length > 0) return { ...s, dims: s.dims.slice(1) };
    if (s.pointers > 0) return { ...s, pointers: s.pointers - 1 };
    return null;
  }

  /**
   * `e` as (root, byte offset from the root's value, the type of the result). A pointer
   * value's shape is its pointee as a pointer; an lvalue's shape is its object type.
   */
  interface Walk { root: string; offset: number; shape: Shape; lvalue: boolean }
  function walk(e: Expression): Walk | null {
    const x = unwrap(e);
    switch (x.kind) {
      case NodeKind.Identifier: {
        const name = (x as Identifier).name;
        const t = varTypes[name];
        const shape = t ? shapeOf(t) : null;
        if (!shape || shape.pointers === 0 || shape.dims.length > 0) return null;
        return { root: name, offset: 0, shape, lvalue: false };
      }
      case NodeKind.SubscriptExpr: {
        const s = x as SubscriptExpr;
        const base = walk(s.array);
        const index = literalValue(s.index);
        if (!base || index === null) return null;
        // A subscript of a pointer value, or of an array object; one of a pointer OBJECT loads it.
        if (base.lvalue && base.shape.dims.length === 0) return null;
        const element = elementOf(base.shape);
        if (!element) return null;
        const stride = sizeOf(element);
        if (stride === undefined) return null;
        return { root: base.root, offset: base.offset + index * stride, shape: element, lvalue: true };
      }
      case NodeKind.MemberExpr: {
        const m = x as MemberExpr;
        if (m.member.kind !== NodeKind.Identifier) return null;
        const owner = walk(m.object);
        if (!owner) return null;
        let shape: Shape;
        let offset = owner.offset;
        if (m.isArrow) {
          if (owner.lvalue || owner.shape.pointers !== 1 || owner.shape.dims.length > 0) return null;
          shape = { ...owner.shape, pointers: 0 };
        } else {
          if (!owner.lvalue || owner.shape.pointers !== 0 || owner.shape.dims.length > 0) return null;
          shape = owner.shape;
        }
        const layout = layoutOf(shape.base);
        if (!layout) return null;
        const name = (m.member as Identifier).name;
        const fields = layout.filter(f => f.name === name);
        if (fields.length !== 1 || fields[0]!.bitSize !== undefined) return null;
        const fieldShape = shapeOf(fields[0]!.type);
        if (!fieldShape) return null;
        offset += fields[0]!.offset;
        return { root: owner.root, offset, shape: fieldShape, lvalue: true };
      }
      case NodeKind.BinaryExpr: {
        const b = x as BinaryExpr;
        if (b.operator !== '+' && b.operator !== '-') return null;
        const left = walk(b.left);
        const k = literalValue(b.right);
        if (!left || k === null) return null;
        // The pointer the step is on: a pointer value, or an array lvalue that decays.
        let pointer: Shape;
        if (left.lvalue) {
          if (left.shape.dims.length === 0) return null;
          const element = elementOf(left.shape)!;
          pointer = { ...element, pointers: element.pointers + 1 };
          if (element.dims.length > 0) return null;
        } else {
          pointer = left.shape;
        }
        const stride = sizeOf({ ...pointer, pointers: pointer.pointers - 1 });
        if (stride === undefined || pointer.pointers === 0) return null;
        const n = k * stride;
        return { root: left.root, offset: left.offset + (b.operator === '+' ? n : -n), shape: pointer, lvalue: false };
      }
      default:
        return null;
    }
  }

  /** A literal, or a negated one (`-0x4eb`), as a number; null for anything else. */
  function literalValue(e: Expression): number | null {
    const x = unwrap(e);
    if (x.kind === NodeKind.IntegerLiteral) return Number((x as IntegerLiteralExpr).value);
    if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
      const v = unwrap((x as UnaryExpr).operand);
      if (v.kind === NodeKind.IntegerLiteral) return -Number((v as IntegerLiteralExpr).value);
    }
    return null;
  }

  /** The designator of the global (or member of one) that starts exactly at `a`. */
  function designatorAt(a: number): { expr: Expression; array: boolean; text: string } | null {
    const owners = Object.entries(addresses).filter(([n, start]) => {
      const size = sizes[n];
      return a === start || (size !== undefined && a > start && a < start + size);
    });
    if (owners.length !== 1) return null;
    const [name, start] = owners[0]!;
    const segs = namespaces[name] ?? [];
    let expr: Expression = segs.length === 0 ? Expr.identifier(name) : Expr.qualifiedId([...segs, name]);
    let text = [...segs, name].join('::');
    let rest = a - start;
    let spelling = globalTypes[name];
    let shape = spelling ? shapeOf(spelling) : null;
    while (rest > 0) {
      if (!shape || shape.pointers > 0 || shape.dims.length > 0) return null;
      const layout = layoutOf(shape.base);
      if (!layout) return null;
      const hits = layout.filter(f => f.bitSize === undefined && f.size > 0 && f.offset <= rest && rest < f.offset + f.size);
      if (hits.length !== 1 || !hits[0]!.name) return null;
      expr = Expr.member(expr, hits[0]!.name);
      text += '.' + hits[0]!.name;
      rest -= hits[0]!.offset;
      spelling = hits[0]!.type;
      shape = shapeOf(spelling);
    }
    return { expr, array: !!shape && shape.dims.length > 0, text };
  }

  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.CStyleCastExpr) return undefined;
      const cast = n as CStyleCastExpr;
      const tn = typeName(cast.type);
      if (!tn || !INT_CASTS.has(tn)) return undefined;
      const inner = unwrap(cast.expression);
      if (inner.kind === NodeKind.Identifier) return undefined;
      const w = walk(inner);
      if (!w || w.lvalue || w.offset >= 0) return undefined;
      const a = -w.offset;
      if (!displacements.has(a)) return undefined;
      const target = designatorAt(a);
      if (!target) return undefined;
      const intptr = Type.typedef('intptr_t');
      const difference = Expr.binary(
        Expr.cast(intptr, Expr.identifier(w.root)),
        '-',
        Expr.cast(intptr, target.array ? target.expr : Expr.unary('&', target.expr)));
      o.onRewrite?.({ value: a, from: `${w.root} - 0x${a.toString(16)}`, to: `${w.root} - ${target.text}` });
      return { ...cast, expression: Expr.paren(difference) } as CStyleCastExpr;
    },
  });
}

export const globalDistanceIndexPlugin: TransformPlugin = createPlugin(
  'global-distance-index',
  'Global Distance Index',
  'A pointer minus a global\'s address, folded into a negative subscript, respelled as the difference',
  (options?: PluginOptions) => createGlobalDistanceIndexTransformer(options),
  {
    priority: 13, // with folded-address-rebase, before type-normalize (15) and the cast passes
    defaultEnabled: true,
    tags: ['correctness'],
    version: '1.0.0',
  },
);
