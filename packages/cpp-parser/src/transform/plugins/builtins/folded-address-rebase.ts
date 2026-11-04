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
 *  - Or a bare literal V that is an operand of a comparison (a loop bound,
 *    `(int)pwVar7 < 0x96de98`): respelled `(int)(X + d)` in the other side's integer
 *    type (`uintptr_t` when that side carries none), so the comparison's type is kept.
 *
 * An address expression that evaluates to V in any other shape is reported, not
 * rewritten.
 *
 * ## An index biased into the previous object
 *
 * zlib's `d_code(dist)` after `dist--` is `MOVZX EAX, byte ptr [EDX + 0x6d13d8]` with
 * EDX = nDist - 1, a displacement that references `_dist_code`. The decompiler takes the
 * - 1 into the constant and names the sum by the object that contains 0x6d13d7, the
 * last byte of `static_dtree` just before it:
 *
 *     *(byte *)((int)&gZlibStaticDTreeDistCode[0x1d].dl + nDist + 1)
 *
 * which in a rebuild reads `_dist_code` only while the linker keeps it right behind
 * `static_dtree`. With the instruction's plain reference to D (`displacements`), a sum
 * under a pointer cast whose one address term is spelled through G, whose literal terms
 * bring it to A, and which has at least one other term, is respelled against the global
 * N at D when G ends exactly at D, A is inside G and D - A is at most 8:
 *
 *     *(byte *)((int)_dist_code + nDist - 1)
 *
 * The other terms keep their order and signs; the address term keeps its integer cast;
 * the literals become the one distance A - D. Every address on the way is evaluated
 * exactly (subscripts by declared dimensions, members by Ghidra's layout) or the sum is
 * left as printed.
 *
 * ## An indexed access through a folded base
 *
 * A table indexed by a raw id whose first entry is not id 0 is read through a base below
 * it. DRLGOUTDOOR_SpawnAct4OutdoorPresets reads the Act 4 preset bases as
 * `LEA EAX,[EAX*4-0x1a0]; MOV ECX,[EAX+0x6f22b0]`: the displacement is the table, the
 * -104 * 4 is in the index. The decompiler folds the two into 0x6f2110 + 4 * id, an element
 * of the table 416 bytes earlier, and prints `gaAct5SceneryPresetTable_0[0][id + 4]`: a
 * read 420 bytes past row 0 of an unrelated table once relinked. The same happens through
 * a LEA (`LEA ESI,[ESI*8+0x6e1bb0]`, 540 rows below gaMonsterEquipTable, printed against
 * the string before it) and through an ADD from memory, where Ghidra's offset reference
 * names the table.
 *
 * With V (the folded constant part) derived from the base X the instruction names, the
 * access is respelled against X, the index carrying the distance:
 *
 *  - a subscript `T[..][I + c]` whose element is at V for I = 0, X an array of the same
 *    element width: `X[I + (V - X) / stride]`;
 *  - a sum under a pointer cast, `(P *)(A + I * k + c)` with one address term A (a string
 *    literal the strings table places at one address, or an address this pass evaluates)
 *    and A + c = V: `(P *)&X[I + (V - X) / k]` when k is X's element size, otherwise
 *    `(P *)((char *)X + I * k + (V - X))`.
 *
 * Same address for every index in the image; the right object in the rebuild.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, BuiltinType, CStyleCastExpr, Expression, Identifier, IntegerLiteralExpr,
  MemberExpr, ParenExpr, PointerType, QualifiedId, StringLiteralExpr, SubscriptExpr, TypedefType, UnaryExpr,
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
  /** Addresses the function's instructions encode with a plain reference (folded-address-spec.ts). */
  displacements?: readonly number[];
  /** Global name -> declared type spelling, for the member walk of an address term. */
  globalTypes?: Record<string, string>;
  /** Aggregate name -> every field's offset, size and Ghidra type. */
  structLayouts?: Record<string, ReadonlyArray<{ name: string; offset: number; size: number; type: string; bitSize?: number }>>;
  /** A string's text -> the one address it is at, for a string literal in an address sum. */
  stringAddresses?: Record<string, number>;
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
  const displacements = o.displacements ?? [];
  if (rebases.length === 0 && displacements.length === 0) return (n: ASTNode) => n;
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

  // ============================================
  // AN INDEX BIASED INTO THE PREVIOUS OBJECT
  // ============================================

  const globalTypes = o.globalTypes ?? {};
  const structLayouts = o.structLayouts ?? {};
  const displaced = new Set(displacements);
  /** The tail distance the rule accepts: an index biased by a small constant. */
  const TAIL_SLACK = 8;

  /** `T[a][b]` -> T and its dimensions, outermost first; null for anything else. */
  function arrayShape(spelling: string): { base: string; dims: number[] } | null {
    const m = /^([^[\]]*?)\s*((?:\[\s*\d+\s*\])+)$/.exec(spelling.trim());
    if (!m) return { base: spelling.trim(), dims: [] };
    const dims = [...m[2]!.matchAll(/\d+/g)].map(d => Number(d[0]));
    return { base: m[1]!.trim(), dims };
  }

  /**
   * The address of the object `e` designates, its type and its size: a global, then
   * subscripts by a literal (stride from the declared dimensions) and `.member` steps
   * (Ghidra's layout). The global it is spelled through comes along. Null at any step
   * not known exactly.
   */
  function objectAt(e: Expression): { global: string; address: number; spelling?: string; size?: number } | null {
    const x = unwrap(e);
    if (x.kind === NodeKind.Identifier || x.kind === NodeKind.QualifiedId) {
      const name = symbolName(x);
      if (!name || addresses[name] === undefined) return null;
      return { global: name, address: addresses[name], spelling: globalTypes[name], size: sizes[name] };
    }
    if (x.kind === NodeKind.SubscriptExpr) {
      const s = x as SubscriptExpr;
      const owner = objectAt(s.array);
      const k = unwrap(s.index);
      if (!owner || owner.spelling === undefined || owner.size === undefined || k.kind !== NodeKind.IntegerLiteral) return null;
      const shape = arrayShape(owner.spelling);
      if (!shape || shape.dims.length === 0) return null;
      const count = shape.dims[0]!;
      if (!(count > 0) || owner.size % count !== 0) return null;
      const stride = owner.size / count;
      const index = Number((k as IntegerLiteralExpr).value);
      if (index < 0 || index >= count) return null;
      const rest = shape.dims.slice(1).map(d => `[${d}]`).join('');
      return { global: owner.global, address: owner.address + index * stride, spelling: shape.base + rest, size: stride };
    }
    if (x.kind === NodeKind.MemberExpr) {
      const m = x as MemberExpr;
      if (m.isArrow || m.member.kind !== NodeKind.Identifier) return null;
      const owner = objectAt(m.object);
      if (!owner || owner.spelling === undefined) return null;
      const shape = arrayShape(owner.spelling);
      if (!shape || shape.dims.length > 0) return null;
      // A namespace-qualified spelling names the aggregate by its last segment, as Ghidra does.
      const bare = shape.base.includes('<') ? shape.base : shape.base.split('::').pop()!;
      const layout = structLayouts[shape.base] ?? structLayouts[bare];
      if (!layout) return null;
      const name = (m.member as Identifier).name;
      const fields = layout.filter(f => f.name === name);
      if (fields.length !== 1 || fields[0]!.bitSize !== undefined) return null;
      return { global: owner.global, address: owner.address + fields[0]!.offset, spelling: fields[0]!.type, size: fields[0]!.size };
    }
    return null;
  }

  /** The address an integer-cast address term evaluates to: `(int)&<path>`, `(int)<array>`. */
  function addressTerm(e: Expression): { global: string; address: number; cast: CStyleCastExpr } | null {
    const x = unwrap(e);
    if (x.kind !== NodeKind.CStyleCastExpr) return null;
    const c = x as CStyleCastExpr;
    const tn = typeName(c.type);
    if (!tn || !INT_CASTS.has(tn)) return null;
    const inner = unwrap(c.expression);
    if (inner.kind === NodeKind.UnaryExpr && (inner as UnaryExpr).operator === '&') {
      const at = objectAt((inner as UnaryExpr).operand);
      return at ? { global: at.global, address: at.address, cast: c } : null;
    }
    const name = symbolName(inner);
    if (name && addresses[name] !== undefined && elementSizes[name] !== undefined) {
      return { global: name, address: addresses[name], cast: c };
    }
    return null;
  }

  /** A `+`/`-` chain as signed terms, left to right. */
  function terms(e: Expression, sign: 1 | -1, out: Array<{ sign: 1 | -1; expr: Expression }>): void {
    const x = unwrap(e);
    if (x.kind === NodeKind.BinaryExpr && ((x as BinaryExpr).operator === '+' || (x as BinaryExpr).operator === '-')) {
      const b = x as BinaryExpr;
      terms(b.left, sign, out);
      terms(b.right, (b.operator === '-' ? -sign : sign) as 1 | -1, out);
      return;
    }
    out.push({ sign, expr: e });
  }

  function tailRebased(sum: Expression): Expression | null {
    const list: Array<{ sign: 1 | -1; expr: Expression }> = [];
    terms(sum, 1, list);
    if (list.length < 3) return null;
    let address: { global: string; address: number; cast: CStyleCastExpr } | null = null;
    let addressIndex = -1;
    let literal = 0;
    const others: number[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      const x = unwrap(t.expr);
      if (x.kind === NodeKind.IntegerLiteral) {
        const v = (x as IntegerLiteralExpr).value;
        if (v < 0n || v >= BigInt(WORD)) return null;
        literal += t.sign * Number(v);
        continue;
      }
      const a = addressTerm(t.expr);
      if (a) {
        if (address || t.sign !== 1) return null;
        address = a;
        addressIndex = i;
        continue;
      }
      others.push(i);
    }
    if (!address || others.length === 0 || literal === 0) return null;
    const size = sizes[address.global];
    const start = addresses[address.global]!;
    if (size === undefined || !(size > 0)) return null;
    const end = start + size;
    const value = address.address + literal;
    if (value < start || value >= end || !displaced.has(end)) return null;
    const k = end - value;
    if (k <= 0 || k > TAIL_SLACK) return null;
    // An instruction that names a byte of G between A and D says the sum may be G's after all.
    if (displacements.some(d => d >= value && d < end)) {
      o.onRefusal?.(`0x${value.toString(16)}: an instruction references 0x${value.toString(16)}..0x${(end - 1).toString(16)} inside ${address.global}`);
      return null;
    }
    const n = byAddress.get(end);
    if (!n || n === address.global) {
      if (!n) o.onRefusal?.(`0x${value.toString(16)}: no single global starts at 0x${end.toString(16)}`);
      return null;
    }
    const target = elementSizes[n] !== undefined ? reference(n) : Expr.unary('&', reference(n));
    const rebuilt: Array<{ sign: 1 | -1; expr: Expression }> = [];
    for (let i = 0; i < list.length; i++) {
      if (i === addressIndex) rebuilt.push({ sign: 1, expr: { ...address.cast, expression: target } as CStyleCastExpr });
      else if (others.includes(i)) rebuilt.push(list[i]!);
    }
    let out: Expression = rebuilt[0]!.sign === 1 ? rebuilt[0]!.expr : Expr.unary('-', rebuilt[0]!.expr);
    for (const t of rebuilt.slice(1)) out = Expr.binary(out, t.sign === 1 ? '+' : '-', t.expr);
    out = Expr.binary(out, '-', Expr.intLiteral(k));
    o.onRewrite?.({ value, from: `${address.global} + 0x${(value - start).toString(16)}`, to: `${n} - ${k}B` });
    return out;
  }

  // ============================================
  // AN INDEXED ACCESS THROUGH A FOLDED BASE
  // ============================================

  const stringAddresses = o.stringAddresses ?? {};

  /** The derived V at `c0` and the one global its base X starts, or null. */
  function foldedAt(c0: number, spelledAgainst: string | undefined): { r: FoldedAddress; x: string } | null {
    const r = byValue.get(c0);
    if (!r) return null;
    const x = byAddress.get(r.base);
    if (!x) {
      o.onRefusal?.(`0x${c0.toString(16)}: no single global starts at 0x${r.base.toString(16)}`);
      return null;
    }
    used.add(c0);
    return x === spelledAgainst ? null : { r, x };
  }

  /** `others + k`, the non-literal terms in their order and signs and one literal. */
  function rebuild(others: Array<{ sign: 1 | -1; expr: Expression }>, k: number): Expression {
    let out: Expression = others[0]!.sign === 1 ? others[0]!.expr : Expr.unary('-', others[0]!.expr);
    for (const t of others.slice(1)) out = Expr.binary(out, t.sign === 1 ? '+' : '-', t.expr);
    return k === 0 ? out : Expr.binary(out, k < 0 ? '-' : '+', Expr.intLiteral(Math.abs(k)));
  }

  /** An index as its literal sum and the other terms; null when no other term is left. */
  function splitIndex(e: Expression): { literal: number; others: Array<{ sign: 1 | -1; expr: Expression }> } | null {
    const list: Array<{ sign: 1 | -1; expr: Expression }> = [];
    terms(e, 1, list);
    let literal = 0;
    const others: Array<{ sign: 1 | -1; expr: Expression }> = [];
    for (const t of list) {
      const x = unwrap(t.expr);
      if (x.kind === NodeKind.IntegerLiteral) {
        const v = (x as IntegerLiteralExpr).value;
        if (v < 0n || v >= BigInt(WORD)) return null;
        literal += t.sign * Number(v);
      } else {
        others.push(t);
      }
    }
    return others.length > 0 ? { literal, others } : null;
  }

  /**
   * `T[i]..[X + c]`: an element read through a subscript whose constant part is a derived V
   * of a base X the instruction names, respelled `X[X + (V - X) / stride]` when X is an
   * array of the same element width:
   *
   *     gaAct5SceneryPresetTable_0[0][pLevel->eD2LevelId + 4]
   *       -> aAct4OutdoorPresetBaseByLevel[pLevel->eD2LevelId - 104]
   */
  function subscriptRebased(node: SubscriptExpr): Expression | null {
    const row = objectAt(node.array);
    if (!row || row.spelling === undefined || row.size === undefined) return null;
    const shape = arrayShape(row.spelling);
    if (!shape || shape.dims.length === 0) return null;
    const count = shape.dims[0]!;
    if (!(count > 0) || row.size % count !== 0) return null;
    const stride = row.size / count;
    const index = splitIndex(node.index);
    if (!index) return null;
    const c0 = row.address + index.literal * stride;
    const hit = foldedAt(c0, row.global);
    if (!hit) return null;
    if (elementSizes[hit.x] !== stride) {
      o.onRefusal?.(`0x${c0.toString(16)}: ${hit.x} does not have ${stride}-byte elements`);
      return null;
    }
    const d = c0 - hit.r.base;
    if (d % stride !== 0) return null;
    o.onRewrite?.({ value: c0, from: `${row.global} + 0x${(c0 - addresses[row.global]!).toString(16)}`, to: `${hit.x} ${d < 0 ? '-' : '+'} ${Math.abs(d)}B`, ins: hit.r.ins });
    return Expr.subscript(reference(hit.x), rebuild(index.others, d / stride));
  }

  /** The address of one term of an address sum: a string literal, or an evaluable address. */
  function termAddress(e: Expression): { value: number; symbol?: string; bytes: boolean } | null {
    const x = unwrap(e);
    if (x.kind === NodeKind.StringLiteral) {
      const lit = x as StringLiteralExpr;
      if (lit.prefix) return null;
      const a = stringAddresses[lit.value];
      return a === undefined ? null : { value: a, bytes: true };
    }
    const v = evaluate(x);
    if (!v || v.stride !== 1) return null;
    return { value: v.value, symbol: v.symbol, bytes: true };
  }

  /**
   * `(T *)(A + X * k + c)` under a pointer cast, A the one address term (a string literal
   * the strings table places, or an address this pass evaluates) and A + c a derived V of a
   * base X: respelled `(T *)&X[X + (V - X) / k]` when the only other term is a multiple of
   * X's element size, and `(T *)((char *)X + ... + (V - X))` otherwise:
   *
   *     (uint32_t *)("d:\\...\\a1q2.cpp" + nClassId * 8 + 0x18)
   *       -> (uint32_t *)&gaMonsterEquipTable[nClassId - 540]
   */
  function sumRebased(sum: Expression): Expression | null {
    const list: Array<{ sign: 1 | -1; expr: Expression }> = [];
    terms(sum, 1, list);
    if (list.length < 2) return null;
    let base: { value: number; symbol?: string } | null = null;
    let literal = 0;
    const others: Array<{ sign: 1 | -1; expr: Expression }> = [];
    for (const t of list) {
      const x = unwrap(t.expr);
      if (x.kind === NodeKind.IntegerLiteral) {
        const v = (x as IntegerLiteralExpr).value;
        if (v < 0n || v >= BigInt(WORD)) return null;
        literal += t.sign * Number(v);
        continue;
      }
      const a = t.sign === 1 && !base ? termAddress(t.expr) : null;
      if (a) { base = a; continue; }
      others.push(t);
    }
    if (!base || others.length === 0) return null;
    const c0 = base.value + literal;
    const hit = foldedAt(c0, base.symbol);
    if (!hit) return null;
    const d = c0 - hit.r.base;
    const stride = elementSizes[hit.x];
    // One `X * k` term with k the element size: an element of X.
    if (others.length === 1 && others[0]!.sign === 1 && stride !== undefined && stride > 0 && d % stride === 0) {
      const t = unwrap(others[0]!.expr);
      if (t.kind === NodeKind.BinaryExpr && (t as BinaryExpr).operator === '*') {
        const m = t as BinaryExpr;
        const k = unwrap(m.right);
        if (k.kind === NodeKind.IntegerLiteral && Number((k as IntegerLiteralExpr).value) === stride) {
          o.onRewrite?.({ value: c0, from: `${base.symbol ?? 'literal'} + 0x${literal.toString(16)}`, to: `${hit.x} ${d < 0 ? '-' : '+'} ${Math.abs(d)}B`, ins: hit.r.ins });
          return Expr.unary('&', Expr.subscript(reference(hit.x), rebuild([{ sign: 1, expr: m.left }], d / stride)));
        }
      }
    }
    o.onRewrite?.({ value: c0, from: `${base.symbol ?? 'literal'} + 0x${literal.toString(16)}`, to: `${hit.x} ${d < 0 ? '-' : '+'} ${Math.abs(d)}B`, ins: hit.r.ins });
    const bytes = Expr.cast(Type.pointer(Type.char()), elementSizes[hit.x] !== undefined ? reference(hit.x) : Expr.unary('&', reference(hit.x)));
    let out: Expression = bytes;
    for (const t of others) out = Expr.binary(out, t.sign === 1 ? '+' : '-', t.expr);
    return d === 0 ? out : Expr.binary(out, d < 0 ? '-' : '+', Expr.intLiteral(Math.abs(d)));
  }

  const used = new Set<number>();
  const COMPARISONS = new Set(['<', '<=', '>', '>=', '==', '!=']);
  /**
   * A bare literal V compared against an address: `(int)pwVar7 < 0x96de98`. The
   * instruction (`CMP EDI,0x96de98` @0068a2bb) encodes V and Ghidra's offset reference
   * says it is X + d, so the literal is an address, spelled in the comparison's integer
   * type. Respelled `(int)(X + d)`: the cast is the other side's (the decompiler's
   * signed compare, MSVC's JL), so the comparison keeps its type and only the object
   * the address is spelled against changes.
   */
  function rebasedOperand(lit: Expression, other: Expression): Expression | null {
    const k = unwrap(lit);
    if (k.kind !== NodeKind.IntegerLiteral) return null;
    const value = (k as IntegerLiteralExpr).value;
    if (value < 0n || value >= BigInt(WORD)) return null;
    const r = byValue.get(Number(value));
    if (!r) return null;
    const x = byAddress.get(r.base);
    if (!x) {
      o.onRefusal?.(`0x${r.value.toString(16)}: no single global starts at 0x${r.base.toString(16)}`);
      return null;
    }
    used.add(r.value);
    const ot = unwrap(other);
    const tn = ot.kind === NodeKind.CStyleCastExpr ? typeName((ot as CStyleCastExpr).type) : undefined;
    const intType = tn && INT_CASTS.has(tn) ? (ot as CStyleCastExpr).type : Type.typedef('uintptr_t');
    o.onRewrite?.({ value: r.value, from: spell(lit), to: `${x} ${r.value < r.base ? '-' : '+'} ${Math.abs(r.value - r.base)}B`, ins: r.ins });
    return Expr.cast(intType, rebased(r, x));
  }
  const inner = createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind === NodeKind.BinaryExpr && COMPARISONS.has((n as BinaryExpr).operator)) {
        const b = n as BinaryExpr;
        const right = rebasedOperand(b.right, b.left);
        if (right) return { ...b, right } as BinaryExpr;
        const left = rebasedOperand(b.left, b.right);
        if (left) return { ...b, left } as BinaryExpr;
        return undefined;
      }
      if (n.kind === NodeKind.SubscriptExpr) {
        if (byValue.size === 0) return undefined;
        return subscriptRebased(n as SubscriptExpr) ?? undefined;
      }
      if (n.kind !== NodeKind.CStyleCastExpr) return undefined;
      const node = n as CStyleCastExpr;
      if (node.type.kind !== NodeKind.PointerType) return undefined;
      const v = evaluate(node.expression);
      if (!v) {
        const indexed = byValue.size > 0 ? sumRebased(node.expression) : null;
        if (indexed) return { ...node, expression: Expr.paren(indexed) } as CStyleCastExpr;
        if (displaced.size === 0) return undefined;
        const tail = tailRebased(node.expression);
        return tail ? { ...node, expression: Expr.paren(tail) } as CStyleCastExpr : undefined;
      }
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
