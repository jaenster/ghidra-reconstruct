/**
 * Biased Table Index Plugin
 *
 * MSVC indexes a byte table whose first index is 1 through `table - 1`:
 *
 *   006bdbd0  MOVZX EAX, byte ptr [EDX + 0x6be0d7]      ; EDX = eType, 1-based
 *
 * 0x6be0d7 is not the table's address. The table (`TXT_ParseFieldTypeCaseIndex`,
 * byte[26]) starts at 0x6be0d8; 0x6be0d7 is the LAST byte of the symbol before it,
 * the switch's jump table `TXT_ParseFieldTypeJumpTable` (void *[8], 0x6be0b8). The
 * decompiler names a constant address only by the data that contains it, so it prints
 *
 *   *(undefined1 *)((int)TXT_ParseFieldTypeJumpTable + eType + (FIELDTYPE_LINKER_UNK|FIELDTYPE_ASCII2))
 *
 * (0x1f = 31 = sizeof(jump table) - 1). In the rebuild the two tables are separate
 * objects, so that read lands past the end of an 8-pointer array: silently wrong.
 *
 * The address is `A + C + X` with A the named symbol, C a constant and X the index.
 * When A + C falls just below the symbol B that starts at A + sizeof(A), the access is
 * B's, biased: `B[X + (A + C - B)]`. Here that is `TXT_ParseFieldTypeCaseIndex[eType - 1]`,
 * the same byte for every eType. Held to a 1-byte access and a 1-byte-element B, and
 * to a bias of at most 8 below B - an address INSIDE A plus a small constant is A's own.
 *
 * When A is a byte array the decompiler subscripts it instead (`A[X + C]`). That shape
 * is held tighter, to the 1-based idiom exactly (C is A's last byte, the address is
 * B - 1): a small byte array subscripted with a small or no constant sits just as close
 * to the next table and is A's own read (`gaPanelStatColors[nIndex]`).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, CStyleCastExpr, Expression, Identifier, IntegerLiteralExpr, ParenExpr,
  PointerType, QualifiedId, TypedefType, UnaryExpr, BuiltinType, SubscriptExpr,
} from '../../../ast/nodes.js';
import { Expr } from '../../../ast/factory.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';

export interface BiasedTableIndexOptions extends PluginOptions {
  /** Global name → address. */
  globalAddresses?: Record<string, number>;
  /** Global name → size in bytes. */
  globalSizes?: Record<string, number>;
  /** Global name → element size, for arrays. */
  globalElementSizes?: Record<string, number>;
  /** Enum constant → value, for names that are unique across the program. */
  enumValues?: Record<string, number>;
}

const BYTE_TYPES = new Set(['undefined1', 'undefined', 'byte', 'uint8_t', 'int8_t', 'char', 'uchar', 'BYTE']);
const INT_CASTS = new Set(['int', 'uint', 'uintptr_t', 'intptr_t', 'int32_t', 'uint32_t', 'DWORD']);
const MAX_BIAS = 8;

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
    return (b.modifiers ?? []).includes('unsigned') && b.name === 'char' ? 'uchar' : b.name;
  }
  return undefined;
}

function symbolName(e: Expression): { name: string; node: Identifier | QualifiedId } | null {
  if (e.kind === NodeKind.Identifier) return { name: (e as Identifier).name, node: e as Identifier };
  if (e.kind === NodeKind.QualifiedId) {
    const q = e as QualifiedId;
    if (q.name.kind === NodeKind.Identifier) return { name: (q.name as Identifier).name, node: q };
  }
  return null;
}

/** Flatten a `+` tree into its terms. */
function terms(e: Expression, out: Expression[]): void {
  const x = unwrap(e);
  if (x.kind === NodeKind.BinaryExpr && (x as BinaryExpr).operator === '+') {
    terms((x as BinaryExpr).left, out);
    terms((x as BinaryExpr).right, out);
  } else out.push(x);
}

function constValue(e: Expression, enumValues: Record<string, number>): number | null {
  const x = unwrap(e);
  if (x.kind === NodeKind.IntegerLiteral) return Number((x as IntegerLiteralExpr).value);
  if (x.kind === NodeKind.Identifier) {
    const v = enumValues[(x as Identifier).name];
    return v === undefined ? null : v;
  }
  if (x.kind === NodeKind.BinaryExpr) {
    const b = x as BinaryExpr;
    const l = constValue(b.left, enumValues);
    const r = constValue(b.right, enumValues);
    if (l === null || r === null) return null;
    switch (b.operator) {
      case '|': return l | r;
      case '&': return l & r;
      case '^': return l ^ r;
      case '+': return l + r;
      case '-': return l - r;
      case '<<': return l << r;
      default: return null;
    }
  }
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    const v = constValue((x as UnaryExpr).operand, enumValues);
    return v === null ? null : -v;
  }
  return null;
}

export function createBiasedTableIndexTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as BiasedTableIndexOptions;
  const addresses = o.globalAddresses ?? {};
  const sizes = o.globalSizes ?? {};
  const elementSizes = o.globalElementSizes ?? {};
  const enumValues = o.enumValues ?? {};
  const byAddress = new Map<number, string>();
  for (const [name, addr] of Object.entries(addresses)) {
    if (byAddress.has(addr)) byAddress.set(addr, ''); else byAddress.set(addr, name);
  }
  if (byAddress.size === 0) return (n: ASTNode) => n;

  /**
   * `A + C + X` (A a global named by `sym`, C the constant terms, X the rest) read
   * one byte at a time: B[X - bias] when A + C lies at most MAX_BIAS below the
   * byte table B that starts where A ends.
   */
  function rebias(
    sym: { name: string; node: Identifier | QualifiedId },
    constant: number,
    index: Expression[],
    node: ASTNode,
  ): ASTNode | undefined {
    if (index.length === 0) return undefined;
    const base = addresses[sym.name];
    const size = sizes[sym.name];
    if (size === undefined) return undefined;
    const nextName = byAddress.get(base + size);
    if (!nextName || elementSizes[nextName] !== 1) return undefined;
    const bias = base + constant - (base + size);
    if (bias >= 0 || bias < -MAX_BIAS) return undefined;

    let idx: Expression = index.reduce((a, b) => Expr.binary(a, '+', b));
    idx = Expr.binary(idx, '-', Expr.intLiteral(-bias));
    // The neighbour is spelled with the same qualifier the symbol was.
    const nextRef: Expression = sym.node.kind === NodeKind.QualifiedId
      ? { ...(sym.node as QualifiedId), name: { ...Expr.identifier(nextName) } } as QualifiedId
      : Expr.identifier(nextName);
    return { ...Expr.subscript(nextRef, idx), location: node.location,
      leadingTrivia: node.leadingTrivia, trailingTrivia: node.trailingTrivia };
  }

  return createTransformer({
    visitUnaryExpr(node: UnaryExpr): ASTNode | undefined {
      if (node.operator !== '*') return undefined;
      const cast = unwrap(node.operand);
      if (cast.kind !== NodeKind.CStyleCastExpr) return undefined;
      const pt = (cast as CStyleCastExpr).type;
      if (pt.kind !== NodeKind.PointerType) return undefined;
      const pointee = typeName((pt as PointerType).pointee);
      if (!pointee || !BYTE_TYPES.has(pointee)) return undefined;

      const parts: Expression[] = [];
      terms((cast as CStyleCastExpr).expression, parts);
      let sym: { name: string; node: Identifier | QualifiedId } | null = null;
      let constant = 0;
      const index: Expression[] = [];
      for (const t of parts) {
        if (t.kind === NodeKind.CStyleCastExpr) {
          const tn = typeName((t as CStyleCastExpr).type);
          const s = tn && INT_CASTS.has(tn) ? symbolName(unwrap((t as CStyleCastExpr).expression)) : null;
          if (s && addresses[s.name] !== undefined) {
            if (sym) return undefined;
            sym = s;
            continue;
          }
        }
        const v = constValue(t, enumValues);
        if (v !== null) { constant += v; continue; }
        index.push(t);
      }
      if (!sym) return undefined;
      return rebias(sym, constant, index, node);
    },
    // The same read when A is itself a byte array: the decompiler subscripts it,
    // `gaItemPaletteTransformData[byPrimaryColor + 0x3b0ff]` for
    // `MOV AL,[EDX + 0x87d80f]` (D2COMP_LoadGuildEmblemIcon @00505425), A being
    // 0x3b100 bytes, so the read is gaGlideEmblemPrimaryColorTableEntries[byPrimaryColor - 1].
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind !== NodeKind.SubscriptExpr) return undefined;
      const sub = node as SubscriptExpr;
      const sym = symbolName(unwrap(sub.array));
      if (!sym || addresses[sym.name] === undefined || elementSizes[sym.name] !== 1) return undefined;
      const parts: Expression[] = [];
      terms(sub.index, parts);
      let constant = 0;
      const index: Expression[] = [];
      for (const t of parts) {
        const v = constValue(t, enumValues);
        if (v !== null) { constant += v; continue; }
        index.push(t);
      }
      // Held to the 1-based idiom exactly: the constant is A's last byte, so the
      // address is `B - 1`. A subscript of a SMALL byte array with a small or no
      // constant (`gaPanelStatColors[nIndex]`, 4 bytes) is just as close to the next
      // table and is A's own read; only the folded `table - 1` is evidence.
      const size = sizes[sym.name];
      if (size === undefined || constant !== size - 1 || constant <= 0) return undefined;
      return rebias(sym, constant, index, node);
    },
  });
}

export const biasedTableIndexPlugin: TransformPlugin = createPlugin(
  'biased-table-index',
  'Biased Table Index',
  'A byte read at (int)A + C + i that lands in the table after A becomes Next[i + bias]',
  (options?: PluginOptions) => createBiasedTableIndexTransformer(options),
  {
    priority: 12, // before type-normalize (15) rewrites the undefined1 cast, and before enum qualification
    defaultEnabled: true,
    tags: ['correctness'],
    version: '1.0.0',
  },
);
