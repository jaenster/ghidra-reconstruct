/**
 * Folded Address Rebase Plugin
 *
 * zlib's inflate_table biases its length tables by the first length symbol:
 *
 *     case LENS: base = lbase; base -= 257; extra = lext; extra -= 257;
 *
 * MSVC compiles that to
 *
 *     0042e2e8  MOV EAX, 0x6d38a8      ; lbase  (Ghidra: DATA ref -> 006d38a8)
 *     0042e2ed  SUB EAX, 0x202         ; - 257 * sizeof(ushort)
 *
 * and the decompiler folds the pair into 0x6d36a6, which it can only name by the
 * object that happens to contain it - `gdwCrc32Table5`, 0x2de bytes in:
 *
 *     pBaseTable = (ushort *)((int)gdwCrc32Table5 + 0x2de);
 *
 * In the image that is the same byte. In a rebuild `gdwCrc32Table5` and `lbase` are
 * separate objects the linker places independently, so `base[sym]` for a length
 * symbol reads CRC words: every dynamic-block inflate with a back-reference fails.
 *
 * The evidence is on the instructions, not in the pseudo-C: the extraction records
 * (extract/operand-refs.ts) that the function loads the start of X (`lbase`) into a
 * register and adjusts it to V by ADD/SUB/LEA on straight-line code, or that Ghidra
 * carries an offset reference V = X + d. Given those pairs (`rebases`), this pass
 * evaluates every pointer-cast address expression in the body; where one evaluates to
 * V and is spelled against an object other than X, it is respelled against X:
 *
 *     (ushort *)((int)gdwCrc32Table5 + 0x2de)   ->   (ushort *)(nZlibInflateTable_MaxCodes - 257)
 *
 * which is the source's `lbase - 257`: the same address in the image, and the right
 * object in the rebuild. When X is an array whose element size divides the distance,
 * the distance is in elements; otherwise it is in bytes through `(char *)X`.
 *
 * Exact, never inferred:
 *  - V must be one of the function's own derived addresses; the codegen side drops a
 *    V that any instruction of the function also ENCODES (then the decompile's own
 *    spelling may be that instruction's, and nothing says which one this is), and a V
 *    two different bases derive.
 *  - X must be the start of exactly one global the tables know.
 *  - Only an expression whose every step is address arithmetic the pass can evaluate:
 *    a global's address (`&Y`, an array `Y`, through integer or byte-pointer casts), a
 *    literal, and `+`/`-` of literal byte (or element, for an uncast array) distances.
 *  - Only under a pointer cast: the cast keeps the expression's type, so the rewrite
 *    changes the spelling of the address and nothing else.
 *
 * An address expression that evaluates to V in any other shape is reported, not
 * rewritten.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, BuiltinType, CStyleCastExpr, Expression, Identifier, IntegerLiteralExpr,
  ParenExpr, PointerType, QualifiedId, TypedefType, UnaryExpr,
} from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';

/** One derived address of this function: V = `value`, from the start of X at `base`. */
export interface FoldedAddress {
  value: number;
  base: number;
  /** The instruction that loads X, for the report. */
  ins?: string;
}

export interface FoldedAddressRebaseOptions extends PluginOptions {
  rebases?: readonly FoldedAddress[];
  /** Global name (as emitted) -> address. */
  globalAddresses?: Record<string, number>;
  /** Global name -> size in bytes. */
  globalSizes?: Record<string, number>;
  /** Global name -> element size, for arrays. */
  globalElementSizes?: Record<string, number>;
  /** Global name -> namespace segments of its definition (empty: root, or a static local). */
  globalNamespaces?: Record<string, readonly string[]>;
  onRewrite?: (info: { value: number; from: string; to: string; ins?: string }) => void;
  onRefusal?: (reason: string) => void;
}

const BYTE_TYPES = new Set(['undefined1', 'undefined', 'byte', 'uint8_t', 'int8_t', 'char', 'uchar', 'BYTE']);
const INT_CASTS = new Set(['int', 'uint', 'uintptr_t', 'intptr_t', 'int32_t', 'uint32_t', 'DWORD', 'long', 'ulong', 'undefined4']);
const WORD = 0x1_0000_0000;

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
    if (b.name === 'char') return unsigned ? 'uchar' : 'char';
    if (b.name === 'int') return unsigned ? 'uint' : 'int';
    if (b.name === 'long') return unsigned ? 'ulong' : 'long';
    return b.name;
  }
  return undefined;
}

function symbolName(e: Expression): string | null {
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  if (e.kind === NodeKind.QualifiedId) {
    const q = e as QualifiedId;
    if (q.name.kind === NodeKind.Identifier) return (q.name as Identifier).name;
  }
  return null;
}

/**
 * The value of an address expression. `stride` is what `+ 1` adds: 1 once the
 * expression is an integer or a byte pointer, the element size for an array that
 * decays, undefined where the pass does not know it. `symbol` is the global the
 * expression is spelled against (absent for a literal).
 */
interface Evaluated { value: number; stride?: number; symbol?: string }

export function createFoldedAddressRebaseTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as FoldedAddressRebaseOptions;
  const rebases = o.rebases ?? [];
  const addresses = o.globalAddresses ?? {};
  if (rebases.length === 0) return (n: ASTNode) => n;
  const sizes = o.globalSizes ?? {};
  const elementSizes = o.globalElementSizes ?? {};
  const namespaces = o.globalNamespaces ?? {};

  // Address -> the one global that starts there ('' when two do).
  const byAddress = new Map<number, string>();
  for (const [name, addr] of Object.entries(addresses)) {
    byAddress.set(addr, byAddress.has(addr) ? '' : name);
  }
  const byValue = new Map<number, FoldedAddress>();
  for (const r of rebases) {
    if (byValue.has(r.value) && byValue.get(r.value)!.base !== r.base) {
      byValue.delete(r.value);
      o.onRefusal?.(`0x${r.value.toString(16)}: derived from two bases`);
      continue;
    }
    byValue.set(r.value, r);
  }

  function evaluate(e: Expression): Evaluated | null {
    const x = unwrap(e);
    switch (x.kind) {
      case NodeKind.IntegerLiteral: {
        const v = (x as IntegerLiteralExpr).value;
        if (v < 0n || v >= BigInt(WORD)) return null;
        return { value: Number(v), stride: 1 };
      }
      case NodeKind.Identifier:
      case NodeKind.QualifiedId: {
        // An array decays to its address; a scalar's name is its value, not an address.
        const name = symbolName(x);
        if (!name || addresses[name] === undefined || elementSizes[name] === undefined) return null;
        return { value: addresses[name], stride: elementSizes[name], symbol: name };
      }
      case NodeKind.UnaryExpr: {
        const u = x as UnaryExpr;
        if (u.operator !== '&') return null;
        const name = symbolName(unwrap(u.operand));
        if (!name || addresses[name] === undefined) return null;
        // `&Y + 1` steps by sizeof(Y), which is only known as the global's size.
        return { value: addresses[name], stride: sizes[name], symbol: name };
      }
      case NodeKind.CStyleCastExpr: {
        const c = x as CStyleCastExpr;
        const inner = evaluate(c.expression);
        if (!inner) return null;
        const t = c.type;
        if (t.kind === NodeKind.PointerType) {
          const pointee = typeName((t as PointerType).pointee);
          return { ...inner, stride: pointee && BYTE_TYPES.has(pointee) ? 1 : undefined };
        }
        const tn = typeName(t);
        return tn && INT_CASTS.has(tn) ? { ...inner, stride: 1 } : null;
      }
      case NodeKind.BinaryExpr: {
        const b = x as BinaryExpr;
        if (b.operator !== '+' && b.operator !== '-') return null;
        const left = evaluate(b.left);
        const k = unwrap(b.right);
        if (!left || left.stride === undefined || k.kind !== NodeKind.IntegerLiteral) return null;
        const n = Number((k as IntegerLiteralExpr).value) * left.stride;
        const value = b.operator === '+' ? left.value + n : left.value - n;
        if (value < 0 || value >= WORD) return null;
        return { value, stride: left.stride, symbol: left.symbol };
      }
      default:
        return null;
    }
  }

  function spell(e: Expression): string {
    const x = unwrap(e);
    if (x.kind === NodeKind.Identifier || x.kind === NodeKind.QualifiedId) return symbolName(x) ?? '?';
    if (x.kind === NodeKind.UnaryExpr) return `&${spell((x as UnaryExpr).operand)}`;
    if (x.kind === NodeKind.CStyleCastExpr) return spell((x as CStyleCastExpr).expression);
    if (x.kind === NodeKind.BinaryExpr) {
      const b = x as BinaryExpr;
      const r = unwrap(b.right);
      return `${spell(b.left)} ${b.operator} ${r.kind === NodeKind.IntegerLiteral ? '0x' + (r as IntegerLiteralExpr).value.toString(16) : '?'}`;
    }
    if (x.kind === NodeKind.IntegerLiteral) return '0x' + (x as IntegerLiteralExpr).value.toString(16);
    return '?';
  }

  function reference(name: string): Expression {
    const segs = namespaces[name] ?? [];
    return segs.length === 0 ? Expr.identifier(name) : Expr.qualifiedId([...segs, name]);
  }

  function rebased(r: FoldedAddress, x: string): Expression {
    const d = r.value - r.base;
    const stride = elementSizes[x];
    const op = d < 0 ? '-' : '+';
    if (stride !== undefined && stride > 0 && d % stride === 0) {
      return Expr.paren(Expr.binary(reference(x), op, Expr.intLiteral(Math.abs(d / stride))));
    }
    return Expr.paren(Expr.binary(
      Expr.cast(Type.pointer(Type.char()), reference(x)),
      op, Expr.intLiteral(Math.abs(d))));
  }

  const used = new Set<number>();
  const inner = createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.CStyleCastExpr) return undefined;
      const node = n as CStyleCastExpr;
      if (node.type.kind !== NodeKind.PointerType) return undefined;
      const v = evaluate(node.expression);
      if (!v) return undefined;
      const r = byValue.get(v.value);
      if (!r) return undefined;
      const x = byAddress.get(r.base);
      if (!x) {
        o.onRefusal?.(`0x${v.value.toString(16)}: no single global starts at 0x${r.base.toString(16)}`);
        return undefined;
      }
      used.add(v.value);
      if (v.symbol === x) return undefined;
      const to = rebased(r, x);
      o.onRewrite?.({ value: v.value, from: spell(node.expression), to: `${x} ${r.value < r.base ? '-' : '+'} ${Math.abs(r.value - r.base)}B`, ins: r.ins });
      return { ...node, expression: to } as CStyleCastExpr;
    },
  });
  // A derived address outside X that the body never spells in a shape this pass reads
  // is reported: the decompile may still name it against the wrong object.
  return (unit: ASTNode) => {
    const out = inner(unit);
    for (const [value, r] of byValue) {
      if (used.has(value)) continue;
      const x = byAddress.get(r.base);
      // No global starts at the base (an offset reference to a member path): nothing
      // here could be respelled against it, and nothing says the value is foreign.
      if (!x) continue;
      const size = sizes[x];
      if (size !== undefined && value >= r.base && value < r.base + size) continue;
      o.onRefusal?.(`0x${value.toString(16)} (${x} ${value < r.base ? '-' : '+'} ${Math.abs(value - r.base)}B, ins ${r.ins ?? '?'}): no pointer-cast address expression in the body evaluates to it`);
    }
    return out;
  };
}

export const foldedAddressRebasePlugin: TransformPlugin = createPlugin(
  'folded-address-rebase',
  'Folded Address Rebase',
  'An address the decompiler folded into another object, respelled against the object the instruction references',
  (options?: PluginOptions) => createFoldedAddressRebaseTransformer(options),
  {
    priority: 13, // beside biased-table-index (12), before type-normalize (15) and the cast passes
    defaultEnabled: true,
    tags: ['correctness'],
    version: '1.0.0',
  },
);
