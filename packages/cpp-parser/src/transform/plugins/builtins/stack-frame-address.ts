/**
 * Stack-Frame-Address Plugin
 *
 * `stack0xNNNNNNNN` is the decompiler's name for a frame address that owns no
 * variable: `&stack0xfffffef3` is "the byte at frame offset -0x10d". It is an
 * address, and it is never zero.
 *
 * The emitter used to substitute the literal `0` for it, over the whole raw text.
 * Five sites reached the compiler as `(0)[i]` and failed; sixteen more reached it
 * as `*(T*)(0 + x)` and COMPILED, reading address `x` instead of `frame + x`.
 * That is the same shape as the `((T*)base)[N]` byte-offset bug fixed in
 * `ae2c1fc`: valid C++, wrong address, no diagnostic.
 *
 * So the frame reference is resolved against the frame Ghidra actually modelled:
 *
 *   - cast straight to an integer      → a frame IDENTITY, not an address. This
 *                                        is the security cookie
 *                                        (`COOKIE ^ (uintptr_t)&stack0xfffffffc`),
 *                                        whose value is only ever compared with
 *                                        itself, so the constant stands;
 *   - a slot AT that offset            → the slot itself (`&local_20`);
 *   - a slot whose extent COVERS it    → `((uint8_t*)&buf + delta)`, the same
 *                                        arithmetic the machine does, on the
 *                                        object that owns the storage;
 *   - one byte past the last PARAMETER → the same anchored form. This is
 *                                        `va_start`: every positive frame offset
 *                                        in the corpus is exactly the address
 *                                        after the last named argument of a
 *                                        varargs function, and the cdecl ABI —
 *                                        not the compiler's whim — fixes that
 *                                        layout, which is why the step is only
 *                                        taken across a parameter;
 *   - one byte BELOW an ARRAY, or a
 *     whole number of ELEMENTS below
 *     one whose elements are wider     → `((uint8_t*)&arr - n)`. MSVC starts an
 *                                        inlined `strcat`/`strlen` scan one byte
 *                                        under the buffer and pre-increments, and
 *                                        a strided walk one stride under it, so
 *                                        the first thing read is `arr[0]` and the
 *                                        walk stays inside the array. The step is
 *                                        taken only below an array, whose extent
 *                                        is what keeps the walk on the object
 *                                        that anchors it — below a scalar it
 *                                        means the frame is modelled too small,
 *                                        and that belongs in Ghidra;
 *   - the frame pointer as a VALUE     → `((uint8_t*)__builtin_frame_address(0))`,
 *                                        for the hand-rolled `CONTEXT.Ebp` store
 *                                        that is `PUSH EBP; POP [EBP-0x2dc]`.
 *                                        Refused for the whole body the moment
 *                                        the value is offset to reach a local,
 *                                        because that spelling compiles and is
 *                                        silently wrong;
 *   - nothing that owns it             → Ghidra's own name, left in place.
 *
 * The last case does not compile, and that is the point. An unowned frame slot
 * cannot be spelled in C++ without a frame pointer, so it fails loudly at the
 * exact offset rather than silently reading somewhere else.
 *
 * A slot is only bound when the emitted body actually DECLARES it: Ghidra lists
 * frame variables the emitter drops (the cookie's own `local_8` goes with the
 * cookie statement), and binding to one of those trades a wrong address for an
 * undeclared name.
 *
 * Runs after `boilerplate-cleanup` (priority 500), which recognises the security
 * cookie by the literal name `stack0x…`; rewriting first would leave every cookie
 * statement in the output.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  Identifier,
  UnaryExpr,
  ParenExpr,
  BinaryExpr,
  CStyleCastExpr,
  IntegerLiteralExpr,
  AssignExpr,
  SubscriptExpr,
  ArrayType,
  PointerType,
  TypedefType,
  TypeNode,
  BuiltinType,
  VariableDecl,
  ParameterDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createKindTransformer, sequence, type Transformer } from '../../transformer.js';
import { typeNodeName } from './call-arg-cast.js';
import { createPlugin } from '../registry.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

/** One entry of Ghidra's stack frame: a named variable at a signed byte offset. */
export interface StackSlot {
  name: string;
  offset: number;
  size: number;
  /** A parameter's frame position is fixed by the ABI; a local's is not. */
  isParameter?: boolean;
  /** An array's extent is what makes an address just below it walkable. */
  isArray?: boolean;
}

export interface StackFrameAddressOptions extends PluginOptions {
  /** The enclosing function's frame, from Ghidra's own local-variable list. */
  slots?: StackSlot[];
}

const STACK_NAME_RE = /^stack0x([0-9a-fA-F]+)$/;

/** The signed byte offset a `stack0xNNNNNNNN` name denotes, or null. */
export function stackNameOffset(name: string): number | null {
  const m = STACK_NAME_RE.exec(name);
  if (!m) return null;
  const raw = Number.parseInt(m[1], 16);
  if (!Number.isFinite(raw)) return null;
  // Ghidra prints the offset as an unsigned 32-bit word.
  return raw >= 0x80000000 ? raw - 0x100000000 : raw;
}

function unwrapParens(expr: Expression): Expression {
  while (expr.kind === NodeKind.ParenExpr) expr = (expr as ParenExpr).expression;
  return expr;
}

function makeIdentifier(name: string, from: ASTNode): Identifier {
  return {
    kind: NodeKind.Identifier,
    name,
    location: from.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
}

/** `(uint8_t*)&slot + delta`, parenthesised so it can sit anywhere an address can. */
function anchoredAddress(slot: StackSlot, delta: number, from: ASTNode): Expression {
  const at = { location: from.location, leadingTrivia: [], trailingTrivia: [] };

  const byteType: TypedefType = {
    kind: NodeKind.TypedefType,
    name: makeIdentifier('uint8_t', from),
    ...at,
  };
  const bytePointer: PointerType = {
    kind: NodeKind.PointerType,
    pointee: byteType,
    qualifiers: [],
    ...at,
  };
  const addressOfSlot: UnaryExpr = {
    kind: NodeKind.UnaryExpr,
    operator: '&',
    operand: makeIdentifier(slot.name, from),
    ...at,
  };
  const cast: CStyleCastExpr = {
    kind: NodeKind.CStyleCastExpr,
    type: bytePointer,
    expression: addressOfSlot,
    ...at,
  };

  const outer = {
    location: from.location,
    leadingTrivia: from.leadingTrivia ?? [],
    trailingTrivia: from.trailingTrivia ?? [],
  };
  if (delta === 0) {
    return { kind: NodeKind.ParenExpr, expression: cast, ...outer } as ParenExpr;
  }

  const magnitude: IntegerLiteralExpr = {
    kind: NodeKind.IntegerLiteral,
    value: BigInt(Math.abs(delta)),
    suffix: '',
    base: 10,
    raw: String(Math.abs(delta)),
    ...at,
  };
  const sum: BinaryExpr = {
    kind: NodeKind.BinaryExpr,
    operator: delta > 0 ? '+' : '-',
    left: cast,
    right: magnitude,
    ...at,
  };
  return { kind: NodeKind.ParenExpr, expression: sum, ...outer } as ParenExpr;
}

/** `(va_list)expr` — the frame address the cdecl ABI hands to a `v`-printf. */
function vaListCast(expr: Expression, from: ASTNode): Expression {
  const at = { location: from.location, leadingTrivia: [], trailingTrivia: [] };
  const vaListType: TypedefType = {
    kind: NodeKind.TypedefType,
    name: makeIdentifier('va_list', from),
    ...at,
  };
  return {
    kind: NodeKind.CStyleCastExpr,
    type: vaListType,
    expression: expr,
    location: from.location,
    leadingTrivia: from.leadingTrivia ?? [],
    trailingTrivia: from.trailingTrivia ?? [],
  } as CStyleCastExpr;
}

/** Names the emitted body declares — parameters included. */
function declaredNames(root: ASTNode): Set<string> {
  const names = new Set<string>();
  for (const n of traverseAST(root)) {
    if (n.kind === NodeKind.VariableDecl) {
      const name = (n as VariableDecl).name?.name;
      if (name) names.add(name);
    } else if (n.kind === NodeKind.ParameterDecl) {
      const name = (n as ParameterDecl).name?.name;
      if (name) names.add(name);
    }
  }
  return names;
}

/** The `&stack0xNNNN` a node is, once parens are off. Null when it is anything else. */
function frameAddressOffset(expr: Expression): number | null {
  const e = unwrapParens(expr);
  if (e.kind !== NodeKind.UnaryExpr) return null;
  const unary = e as UnaryExpr;
  if (unary.operator !== '&') return null;
  const operand = unwrapParens(unary.operand);
  if (operand.kind !== NodeKind.Identifier) return null;
  return stackNameOffset((operand as Identifier).name);
}

/** Is this type an integer — something a frame address is only ever cast to as a value? */
function isIntegerType(type: TypeNode): boolean {
  if (type.kind === NodeKind.BuiltinType) {
    return (type as BuiltinType).name !== 'void';
  }
  if (type.kind === NodeKind.TypedefType) {
    const n = typeNodeName((type as TypedefType).name) ?? '';
    return /^(u?int(8|16|32|64|ptr)?(_t)?|uint|ulong|ulonglong|size_t|ssize_t|ptrdiff_t|DWORD|ULONG|UINT|LONG|INT|DWORD_PTR|ULONG_PTR|UINT_PTR|INT_PTR)$/.test(n);
  }
  return false;
}

/**
 * `(uintptr_t)&stack0xfffffffc` — the security-cookie seed. The value is XORed
 * into a cookie and compared against itself; it is never dereferenced, so the
 * constant it has always been is faithful enough and stays.
 */
function createFrameIdentityTransformer(): Transformer {
  return createKindTransformer(NodeKind.CStyleCastExpr, (node) => {
    const cast = node as CStyleCastExpr;
    if (!isIntegerType(cast.type)) return undefined;
    if (frameAddressOffset(cast.expression) === null) return undefined;
    const zero: IntegerLiteralExpr = {
      kind: NodeKind.IntegerLiteral,
      value: 0n,
      suffix: '',
      base: 10,
      raw: '0',
      location: cast.location,
      leadingTrivia: [],
      trailingTrivia: [],
    };
    return { ...cast, expression: zero } as CStyleCastExpr;
  });
}


/**
 * The frame-pointer slot. A standard prologue pushes EBP at frame offset -4, so
 * `&stack0xfffffffc` in an EBP-framed function IS the frame pointer.
 */
const FRAME_POINTER_OFFSET = -4;

/**
 * `((uint8_t*)__builtin_frame_address(0))` — the frame pointer as a VALUE.
 *
 * `PUSH EBP; POP [EBP-0x2dc]` inside a hand-rolled `CONTEXT` fill is storing the
 * frame pointer itself; the address is the datum. The `uint8_t*` cast is the
 * same anchor spelling `anchoredAddress` uses, and it is load-bearing: the
 * builtin is `void*`, which reaches no other pointer type in C++.
 */
function frameAddressValue(from: ASTNode): Expression {
  const at = { location: from.location, leadingTrivia: [] as never[], trailingTrivia: [] as never[] };
  const zero: IntegerLiteralExpr = {
    kind: NodeKind.IntegerLiteral, value: 0n, suffix: '', base: 10, raw: '0', ...at,
  };
  const call = {
    kind: NodeKind.CallExpr,
    callee: makeIdentifier('__builtin_frame_address', from),
    arguments: [zero],
    ...at,
  } as unknown as Expression;
  const byteType: TypedefType = { kind: NodeKind.TypedefType, name: makeIdentifier('uint8_t', from), ...at };
  const bytePointer: PointerType = { kind: NodeKind.PointerType, pointee: byteType, qualifiers: [], ...at };
  const cast: CStyleCastExpr = { kind: NodeKind.CStyleCastExpr, type: bytePointer, expression: call, ...at };
  return { kind: NodeKind.ParenExpr, expression: cast, ...at } as unknown as Expression;
}

/**
 * Is the frame pointer used in this body as a VALUE and nothing else?
 *
 * The distinction decides whether `&stack0xfffffffc` may become the frame
 * pointer at all, and getting it wrong is worse than the error it replaces.
 * Two bodies in the corpus spell the very same statement:
 *
 *     uint8_t *pContextEbp = &stack0xfffffffc;   // Fog/Debug.cpp — a CONTEXT.Ebp store
 *     uint8_t *puVar3      = &stack0xfffffffc;   // D2Client/UNIT/Item.cpp
 *
 * and the second one later reads `*(byte**)(puVar3 - 0xc)` — a LOCAL, which
 * Ghidra's frame already holds under its own name. Materialising a frame pointer
 * there produces code that compiles and reads whatever the compiler happened to
 * put at that offset, which is a silent wrong answer.
 *
 * So the value is followed: every name it flows into is tainted, and if any
 * tainted name is ever an operand of pointer arithmetic or the base of a
 * subscript, the whole body is refused and the loud error stays. Refusing the
 * BODY rather than the site is deliberate — the flow is through assignments the
 * decompiler split across branches, and a per-site answer would be a guess.
 */
function frameAddressIsValueOnly(root: ASTNode): boolean {
  const tainted = new Set<string>();
  // The decompiler assigns through several names across branches, so the flow is
  // closed over rather than walked once.
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of traverseAST(root)) {
      let name: string | undefined;
      let value: Expression | undefined;
      if (n.kind === NodeKind.VariableDecl) {
        const v = n as VariableDecl;
        name = v.name?.name;
        value = v.initializer as Expression | undefined;
      } else if (n.kind === NodeKind.AssignExpr) {
        const a = n as AssignExpr;
        if (a.operator !== '=') continue;
        const lhs = unwrapParens(a.left);
        if (lhs.kind !== NodeKind.Identifier) continue;
        name = (lhs as Identifier).name;
        value = a.right;
      }
      if (!name || !value || tainted.has(name)) continue;
      const rhs = unwrapParens(value);
      const flows = frameAddressOffset(rhs) === FRAME_POINTER_OFFSET
        || (rhs.kind === NodeKind.Identifier && tainted.has((rhs as Identifier).name));
      if (!flows) continue;
      tainted.add(name);
      changed = true;
    }
  }

  const isTaintedRef = (e: Expression): boolean => {
    const u = unwrapParens(e);
    return u.kind === NodeKind.Identifier && tainted.has((u as Identifier).name);
  };
  for (const n of traverseAST(root)) {
    if (n.kind === NodeKind.BinaryExpr) {
      const b = n as BinaryExpr;
      if (b.operator !== '+' && b.operator !== '-') continue;
      if (isTaintedRef(b.left) || isTaintedRef(b.right)) return false;
    } else if (n.kind === NodeKind.SubscriptExpr) {
      if (isTaintedRef((n as SubscriptExpr).array)) return false;
    } else if (n.kind === NodeKind.AssignExpr) {
      const a = n as AssignExpr;
      if (a.operator !== '+=' && a.operator !== '-=') continue;
      if (isTaintedRef(a.left)) return false;
    }
  }
  return true;
}


/**
 * Each declared array's element size in bytes.
 *
 * Ghidra's frame carries a slot's total BYTE extent and no element type, and the
 * emitted declaration carries the element count and no byte size. One is the
 * other's missing half: `D2RoomExStrc *nRoomPtrs[60]` in a 240-byte slot is a
 * 4-byte stride. Derived rather than computed from the type, because a `sizeof`
 * over reconstructed structs is exactly the number the emitter does not have.
 *
 * Only an exact division counts. A slot Ghidra sized differently from the
 * declaration is a disagreement, and guessing a stride from it would put an
 * address on the wrong element.
 */
function arrayElementSizes(root: ASTNode, slots: StackSlot[]): Map<string, number> {
  const bySlotName = new Map<string, number>();
  for (const s of slots) if (s.isArray) bySlotName.set(s.name, s.size);

  const sizes = new Map<string, number>();
  for (const n of traverseAST(root)) {
    if (n.kind !== NodeKind.VariableDecl) continue;
    const decl = n as VariableDecl;
    const name = decl.name?.name;
    if (!name) continue;
    const bytes = bySlotName.get(name);
    if (bytes === undefined) continue;
    const array = decl.type && decl.type.kind === NodeKind.ArrayType ? (decl.type as ArrayType) : null;
    const dim = array?.size;
    if (!dim || dim.kind !== NodeKind.IntegerLiteral) continue;
    const count = Number((dim as IntegerLiteralExpr).value);
    if (!Number.isFinite(count) || count <= 0) continue;
    if (bytes % count !== 0) continue;
    sizes.set(name, bytes / count);
  }
  return sizes;
}

function createFrameSlotTransformer(slots: StackSlot[]): Transformer {
  const byOffset = new Map<number, StackSlot>();
  for (const s of slots) if (!byOffset.has(s.offset)) byOffset.set(s.offset, s);

  return (root: ASTNode) => {
    const declared = declaredNames(root);
    const elementSizes = arrayElementSizes(root, slots);
    const framePointerIsValue = frameAddressIsValueOnly(root);
    return createKindTransformer(NodeKind.UnaryExpr, (node) => {
      const unary = node as UnaryExpr;
      if (unary.operator !== '&') return undefined;
      const operand = unwrapParens(unary.operand);
      if (operand.kind !== NodeKind.Identifier) return undefined;
      const offset = stackNameOffset((operand as Identifier).name);
      if (offset === null) return undefined;

      // The slot that starts here: `&stack0xffffffe0` IS `&local_20`.
      const exact = byOffset.get(offset);
      if (exact && declared.has(exact.name)) {
        return { ...unary, operand: makeIdentifier(exact.name, operand) } as UnaryExpr;
      }

      // The slot whose storage covers this byte: a buffer indexed from part-way in.
      let owner: StackSlot | undefined;
      for (const s of slots) {
        if (s.size <= 1 || !declared.has(s.name)) continue;
        if (offset < s.offset || offset >= s.offset + s.size) continue;
        if (!owner || s.size < owner.size) owner = s;
      }
      if (owner) return anchoredAddress(owner, offset - owner.offset, unary);

      // One byte below an array. Nothing may own the byte itself — an owned byte
      // is the slot before it, and binding across a boundary the compiler chooses
      // is a guess. Below an array the walk immediately enters the array, so the
      // arithmetic stays on the object that anchors it.
      const ownedByAny = slots.some((s) => offset >= s.offset && offset < s.offset + Math.max(s.size, 1));
      if (!ownedByAny) {
        for (const s of slots) {
          if (!s.isArray || !declared.has(s.name)) continue;
          if (offset !== s.offset - 1) continue;
          return anchoredAddress(s, -1, unary);
        }

        // A whole number of ELEMENTS below an array of elements wider than a
        // byte. The byte rule above is the same walk on a `char` buffer: MSVC
        // pre-advances a strided walk from one stride under the object, so the
        // first thing read is element 0 and the walk stays inside the array.
        // `&stack0xfffffee0` against `D2RoomExStrc *nRoomPtrs[60]` is exactly
        // `&nRoomPtrs[-2]`.
        //
        // An ELEMENT boundary is what makes this different from "some address
        // near an array": an offset that is not a multiple of the stride is not
        // a pre-advanced walk and gets no anchor. That is also why a `char`
        // array is excluded here rather than reached with a bigger radius —
        // every offset is an element boundary in a byte array, and the one-byte
        // rule is the whole of what the corpus justifies for those. The reach
        // stops at the array's own length, and the NEAREST array wins.
        let below: StackSlot | undefined;
        for (const s of slots) {
          if (!s.isArray || !declared.has(s.name)) continue;
          if (offset >= s.offset || s.offset - offset > s.size) continue;
          const stride = elementSizes.get(s.name);
          if (!stride || stride <= 1 || (s.offset - offset) % stride !== 0) continue;
          if (!below || s.offset - offset < below.offset - offset) below = s;
        }
        if (below) return anchoredAddress(below, offset - below.offset, unary);
      }

      // The address just past a parameter: the varargs list. `va_start(ap, fmt)`
      // on cdecl is `&fmt + sizeof fmt`, and the ABI guarantees the adjacency —
      // so the step is taken across a parameter and never across a local, whose
      // frame position the compiler is free to choose.
      for (const s of slots) {
        if (!s.isParameter || !declared.has(s.name)) continue;
        if (offset !== s.offset + s.size) continue;
        // The one place where the ABI, not a guess, fixes what the address MEANS:
        // this is the varargs list, and on cdecl a `va_list` IS a byte pointer into
        // the frame. The address is only ever handed to a `v`-printf, whose
        // parameter is `va_list`, so spell the conversion the ABI already makes
        // rather than leaving a `uint8_t*` the callee cannot take.
        return vaListCast(anchoredAddress(s, s.size, unary), unary);
      }

      // The frame pointer itself, consumed as a value. See
      // `frameAddressIsValueOnly` for why the whole body has to agree.
      if (offset === FRAME_POINTER_OFFSET && framePointerIsValue) {
        return frameAddressValue(unary);
      }

      // Nothing in the frame owns this address. Leave Ghidra's name, so it fails
      // where it is instead of turning into a read of address `0 + index`.
      return undefined;
    })(root);
  };
}

function createStackFrameAddressTransformer(options: StackFrameAddressOptions = {}): Transformer {
  const slots = options.slots ?? [];
  // The identity pass runs first, so a cookie seed is settled before the frame is
  // consulted — and it runs even for a function with no modelled frame at all.
  return sequence(
    createFrameIdentityTransformer(),
    slots.length > 0 ? createFrameSlotTransformer(slots) : ((node: ASTNode) => node),
  );
}

export const stackFrameAddressPlugin: TransformPlugin = createPlugin(
  'stack-frame-address',
  'Stack Frame Address',
  'Resolves Ghidra `&stack0xNNNN` frame addresses against the function\'s own stack frame',
  (options?: PluginOptions) =>
    createStackFrameAddressTransformer(options as StackFrameAddressOptions),
  {
    // After boilerplate-cleanup (500), which matches the security cookie on the
    // literal `stack0x` name.
    priority: 520,
    defaultEnabled: true,
    tags: ['cleanup', 'memory'],
    version: '1.0.0',
  }
);
