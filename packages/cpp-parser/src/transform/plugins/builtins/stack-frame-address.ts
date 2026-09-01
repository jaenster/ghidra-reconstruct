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
 * exact offset rather than silently reading somewhere else. The one exception is
 * an unowned address STORED into a local nothing ever reads - MSVC's SEH
 * saved-ESP slot - where the store itself is dead and goes; see
 * `createDeadFrameStoreTransformer`.
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
  CompoundStmt,
  ExprStmt,
  Statement,
} from '../../../ast/nodes.js';
import type { Trivia } from '../../../lexer/trivia.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createKindTransformer, createTransformer, sequence, updateNode, type Transformer } from '../../transformer.js';
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
  /**
   * Global data symbol name (as emitted) → its address in the image.
   *
   * The decompiler's constant folding can collapse a frame address and a global
   * address into ONE literal, and neither anchor survives in the name. The map
   * is what lets the fold be undone; see
   * `createFoldedGlobalAddressTransformer`.
   */
  globalAddresses?: Record<string, number>;
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
 * So the value is followed: every name it flows into is tainted, and a tainted
 * name used in pointer arithmetic or as a subscript base refuses the whole body.
 * Refusing the BODY rather than the site is deliberate — the flow is through
 * assignments the decompiler split across branches, and a per-site answer would
 * be a guess.
 *
 * The refusal is over NEGATIVE and unknown offsets, which is all the `Item.cpp`
 * evidence covers. A CONSTANT offset of `+8` or more is different in kind: on
 * i386 with a frame pointer, `[fp+8]` and up are the incoming stack arguments,
 * at positions the ABI fixes rather than the compiler chooses. MSVC's
 * `_except_handler3` at `D2Sound/D2SoundUntil.cpp` reads exactly those — `+8`
 * is its own `pRecord` and `+0xc` its own `pRegistrationFrame` — and the
 * builtin is what forces GCC to keep the frame pointer that makes them correct.
 * A non-constant offset, a `-`, or a compound `+=`/`-=` (which moves the base,
 * so every later offset means something else) still refuses the body.
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
  /** A non-negative integer literal, or null for anything the offset is not. */
  const constantOffset = (e: Expression): number | null => {
    const u = unwrapParens(e);
    if (u.kind !== NodeKind.IntegerLiteral) return null;
    const v = Number((u as IntegerLiteralExpr).value);
    return Number.isSafeInteger(v) ? v : null;
  };
  /** The lowest offset an incoming stack argument can sit at, with a frame pointer. */
  const FIRST_STACK_ARGUMENT = 8;
  for (const n of traverseAST(root)) {
    if (n.kind === NodeKind.BinaryExpr) {
      const b = n as BinaryExpr;
      if (b.operator !== '+' && b.operator !== '-') continue;
      const leftTainted = isTaintedRef(b.left), rightTainted = isTaintedRef(b.right);
      if (!leftTainted && !rightTainted) continue;
      // A `-` is a NEGATIVE offset — a local, whose frame position the host
      // compiler is free to choose — and both sides tainted is not a read of an
      // argument at all.
      if (b.operator === '-') return false;
      if (leftTainted && rightTainted) return false;
      const offset = constantOffset(leftTainted ? b.right : b.left);
      if (offset === null || offset < FIRST_STACK_ARGUMENT) return false;
    } else if (n.kind === NodeKind.SubscriptExpr) {
      const sub = n as SubscriptExpr;
      if (!isTaintedRef(sub.array)) continue;
      const offset = constantOffset(sub.index);
      if (offset === null || offset < FIRST_STACK_ARGUMENT) return false;
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

/**
 * A `&stack0xNNNN` whose offset lies nowhere in the frame because a frame
 * address and a GLOBAL address were folded into one literal.
 *
 * `D2Launch/CharSel.cpp`'s `CHARSEL_EnumerateLocalSaves` inlines a `strcpy`
 * whose destination is addressed off the source pointer, and the source is a
 * global:
 *
 *     00438fe8 MOV  ECX,0x779b68        ; gszLocalSaveFilenameBuffer
 *     00438fef LEA  EDX,[EBP-0x114]     ; &findData.cFileName[0]
 *     00438ff5 SUB  EDX,ECX
 *     00438ffd MOV  AL,[EDX+ECX*1+0x1]  ; the +1 folds into the constant too
 *
 * Constant propagation collapses `frameSlot - globalAddress + 1` into a single
 * word, the decompiler prints the word as a pseudo stack symbol, and both
 * anchors are gone: no slot owns the offset, so every rule above declines and
 * the name reaches the compiler undeclared.
 *
 * The fold is undone by solving it. For a global `G` at address `A`, the frame
 * offset the machine actually took is `F = C + A`; if `F` binds to a slot the
 * body declares — exactly, or inside its extent — then `&stack0xC` is that
 * slot's address minus `&G`, which is a DISPLACEMENT and not an address. The
 * only sound use of a displacement is added to a pointer that walks `G`, and
 * that is the shape the site has, so the rewrite is at the `+` rather than at
 * the name:
 *
 *     &stack0xff886381 + (int)pszNameDst
 *   → pszNameDst + (((uint8_t*)&findData + 45) - (uint8_t*)&gszLocalSaveFilenameBuffer)
 *
 * which re-folds to the identical constant and keeps the walking pointer's own
 * type, so nothing downstream has to re-spell the assignment.
 *
 * Two things keep this from inventing an address:
 *
 *   - only a global the BODY NAMES is a candidate. Both operands of the fold
 *     were in the same instruction stream, and Ghidra names the global
 *     elsewhere in the function; a global picked from the whole image would be
 *     numerology. A name the frame also carries as a stack slot is dropped —
 *     that one is shadowed and `&name` would not be the global at all;
 *   - the solution must be UNIQUE. Two globals whose addresses differ by less
 *     than the frame's depth both land inside it, and there is nothing in the
 *     literal to choose between them. A second candidate means guessing which
 *     object is written, so nothing is emitted and the loud error stays.
 */

/** Every bare identifier the body mentions. */
function referencedNames(root: ASTNode): Set<string> {
  const names = new Set<string>();
  for (const n of traverseAST(root)) {
    if (n.kind === NodeKind.Identifier) names.add((n as Identifier).name);
  }
  return names;
}

/** `(uint8_t*)&name` — the global's address, in the same byte-pointer spelling. */
function globalByteAddress(name: string, from: ASTNode): Expression {
  const at = { location: from.location, leadingTrivia: [] as never[], trailingTrivia: [] as never[] };
  const addressOf: UnaryExpr = {
    kind: NodeKind.UnaryExpr, operator: '&', operand: makeIdentifier(name, from), ...at,
  };
  const byteType: TypedefType = { kind: NodeKind.TypedefType, name: makeIdentifier('uint8_t', from), ...at };
  const bytePointer: PointerType = { kind: NodeKind.PointerType, pointee: byteType, qualifiers: [], ...at };
  return { kind: NodeKind.CStyleCastExpr, type: bytePointer, expression: addressOf, ...at } as CStyleCastExpr;
}

/** The pointer expression a folded displacement is added to, through `(int)p` casts. */
function walkedPointer(expr: Expression, pointerNames: Set<string>): Expression | null {
  let e = unwrapParens(expr);
  while (e.kind === NodeKind.CStyleCastExpr) e = unwrapParens((e as CStyleCastExpr).expression);
  if (e.kind !== NodeKind.Identifier) return null;
  return pointerNames.has((e as Identifier).name) ? e : null;
}

function createFoldedGlobalAddressTransformer(
  slots: StackSlot[],
  globalAddresses: Record<string, number>,
): Transformer {
  return (root: ASTNode) => {
    const declared = declaredNames(root);
    const referenced = referencedNames(root);
    const slotNames = new Set(slots.map(s => s.name));
    const candidates: { name: string; address: number }[] = [];
    for (const [name, address] of Object.entries(globalAddresses)) {
      if (!referenced.has(name) || slotNames.has(name)) continue;
      if (!Number.isSafeInteger(address)) continue;
      candidates.push({ name, address });
    }
    if (candidates.length === 0) return root;

    // Names the body declares as POINTERS — what a displacement may be added to.
    const pointerNames = new Set<string>();
    for (const n of traverseAST(root)) {
      let name: string | undefined;
      let type: TypeNode | undefined;
      if (n.kind === NodeKind.VariableDecl) {
        const v = n as VariableDecl;
        name = v.name?.name; type = v.type;
      } else if (n.kind === NodeKind.ParameterDecl) {
        const pd = n as ParameterDecl;
        name = pd.name?.name; type = pd.type;
      }
      if (name && type && type.kind === NodeKind.PointerType) pointerNames.add(name);
    }

    /** The slot that owns frame offset `F`, and the delta into it. */
    const bind = (offset: number): { slot: StackSlot; delta: number } | null => {
      let owner: StackSlot | undefined;
      for (const sl of slots) {
        if (!declared.has(sl.name)) continue;
        if (offset < sl.offset || offset >= sl.offset + Math.max(sl.size, 1)) continue;
        if (!owner || sl.size < owner.size) owner = sl;
      }
      return owner ? { slot: owner, delta: offset - owner.offset } : null;
    };

    return createKindTransformer(NodeKind.BinaryExpr, (node) => {
      const b = node as BinaryExpr;
      if (b.operator !== '+') return undefined;
      const leftOffset = frameAddressOffset(b.left);
      const rightOffset = frameAddressOffset(b.right);
      if ((leftOffset === null) === (rightOffset === null)) return undefined;
      const folded = (leftOffset ?? rightOffset) as number;
      const other = leftOffset === null ? b.left : b.right;
      const pointer = walkedPointer(other, pointerNames);
      if (!pointer) return undefined;

      let solution: { name: string; slot: StackSlot; delta: number } | null = null;
      for (const g of candidates) {
        const bound = bind(folded + g.address);
        if (!bound) continue;
        if (solution) return undefined; // not unique — guessing which object is written
        solution = { name: g.name, slot: bound.slot, delta: bound.delta };
      }
      if (!solution) return undefined;

      const at = { location: b.location, leadingTrivia: [] as never[], trailingTrivia: [] as never[] };
      const displacement: BinaryExpr = {
        kind: NodeKind.BinaryExpr,
        operator: '-',
        left: anchoredAddress(solution.slot, solution.delta, b),
        right: globalByteAddress(solution.name, b),
        ...at,
      };
      const parenthesised: ParenExpr = { kind: NodeKind.ParenExpr, expression: displacement, ...at };
      return {
        kind: NodeKind.BinaryExpr,
        operator: '+',
        left: pointer,
        right: parenthesised,
        location: b.location,
        leadingTrivia: b.leadingTrivia ?? [],
        trailingTrivia: b.trailingTrivia ?? [],
      } as BinaryExpr;
    })(root);
  };
}

/**
 * A store of an address the frame could not account for, into a local that
 * nothing ever reads.
 *
 * MSVC's inlined SEH prologue ends with `MOV [EBP-0x10], ESP` - the unwinder's
 * saved-ESP slot. It has no counterpart in the C the compiler was given, which
 * held a `__try` and not a store. The value is ESP after the WHOLE prologue,
 * twelve bytes below the deepest local Ghidra models, inside the EBX/ESI/EDI
 * save area - storage the function does not allocate as locals, so no honest
 * declaration can cover it. It is not the frame pointer either: EBP sits at -4,
 * and `__builtin_frame_address(0)` would compile and be wrong by the frame's
 * whole size (3216 and 68 bytes at the two `D2Direct3D/Renderer/Direct3D.cpp`
 * sites).
 *
 * Every available spelling of the value asserts something false. What is true is
 * that the store is DEAD - the destination is written and never read - so the
 * statement is dropped. That removes compiler scaffolding rather than inventing
 * a value, which is the difference between this and substituting `0`.
 *
 * The guard is a property, not an address list:
 *
 *   - the value is a frame address `createFrameSlotTransformer` could not bind
 *     to any slot. That is why this runs LAST in the sequence - before it, the
 *     cookie seed, the frame pointer and every owned slot still look the same;
 *   - the destination is a plain local the body DECLARES, so a store to a global
 *     or through a pointer is never touched;
 *   - that local is not READ anywhere in the function. A compound assignment
 *     reads its target, and taking the address of the local is a read, so a
 *     value that is used anywhere keeps its loud error.
 *
 * The declaration stays; only the store goes. A local Ghidra put in the frame is
 * evidence, and another write to it elsewhere would still need somewhere to go.
 */

/**
 * Names that appear in a READ position: every identifier occurrence except a
 * declaration's own name and the target of a plain `=`.
 *
 * Deliberately over-inclusive - `&x`, `x++` and `x += 1` all count as reads -
 * because every name it wrongly reports as read merely keeps an error that was
 * already there, while one it wrongly reports as dead deletes a live store.
 */
function namesRead(root: ASTNode): Set<string> {
  const writePositions = new Set<ASTNode>();
  for (const n of traverseAST(root)) {
    if (n.kind === NodeKind.VariableDecl) {
      const name = (n as VariableDecl).name;
      if (name) writePositions.add(name);
    } else if (n.kind === NodeKind.ParameterDecl) {
      const name = (n as ParameterDecl).name;
      if (name) writePositions.add(name);
    } else if (n.kind === NodeKind.AssignExpr) {
      const assign = n as AssignExpr;
      // `+=` and friends read the target first; only a plain `=` overwrites it.
      if (assign.operator !== '=') continue;
      const lhs = unwrapParens(assign.left);
      if (lhs.kind === NodeKind.Identifier) writePositions.add(lhs);
    }
  }

  const names = new Set<string>();
  for (const n of traverseAST(root)) {
    if (n.kind !== NodeKind.Identifier || writePositions.has(n)) continue;
    names.add((n as Identifier).name);
  }
  return names;
}

/** Is this value a `&stack0xNNNN` no slot claimed - through parens and casts? */
function isUnresolvedFrameAddress(expr: Expression): boolean {
  let e = unwrapParens(expr);
  while (e.kind === NodeKind.CStyleCastExpr) {
    e = unwrapParens((e as CStyleCastExpr).expression);
  }
  return frameAddressOffset(e) !== null;
}

function createDeadFrameStoreTransformer(): Transformer {
  return (root: ASTNode) => {
    const read = namesRead(root);
    const declared = declaredNames(root);

    /** A plain local the body declares and never reads. */
    const isDeadLocal = (target: Expression): boolean => {
      const lhs = unwrapParens(target);
      if (lhs.kind !== NodeKind.Identifier) return false;
      const name = (lhs as Identifier).name;
      return declared.has(name) && !read.has(name);
    };

    const isDeadFrameStore = (stmt: Statement): boolean => {
      if (stmt.kind !== NodeKind.ExprStmt) return false;
      const expr = (stmt as ExprStmt).expression;
      if (expr.kind !== NodeKind.AssignExpr) return false;
      const assign = expr as AssignExpr;
      if (assign.operator !== '=') return false;
      return isUnresolvedFrameAddress(assign.right) && isDeadLocal(assign.left);
    };

    return createTransformer({
      // `uint8_t *local_14 = &stack0xffffffb8;` - keep the local, drop the store.
      visitVariableDecl(decl: VariableDecl): ASTNode | undefined {
        const init = decl.initializer;
        if (!init || !isUnresolvedFrameAddress(init as Expression)) return undefined;
        if (!isDeadLocal(decl.name)) return undefined;
        return updateNode(decl, { initializer: null } as Partial<VariableDecl>);
      },

      // `local_14 = &stack0xfffff36c;` standing on its own - drop the statement.
      visitCompoundStmt(node: CompoundStmt): ASTNode | undefined {
        const kept: Statement[] = [];
        let carried: Trivia[] = [];
        let dropped = false;
        for (const stmt of node.statements) {
          if (isDeadFrameStore(stmt)) {
            dropped = true;
            carried = [...carried, ...(stmt.leadingTrivia ?? [])];
            continue;
          }
          kept.push(
            carried.length > 0
              ? updateNode(stmt, { leadingTrivia: [...carried, ...(stmt.leadingTrivia ?? [])] })
              : stmt
          );
          carried = [];
        }
        if (!dropped) return undefined;
        // A comment on the dropped statement with nothing after it to carry it:
        // the store is not worth losing a Ghidra comment over.
        if (carried.length > 0) return undefined;
        return updateNode(node, { statements: kept } as Partial<CompoundStmt>);
      },
    })(root);
  };
}

function createStackFrameAddressTransformer(options: StackFrameAddressOptions = {}): Transformer {
  const slots = options.slots ?? [];
  const globalAddresses = options.globalAddresses ?? {};
  // The identity pass runs first, so a cookie seed is settled before the frame is
  // consulted — and it runs even for a function with no modelled frame at all.
  // Dead-store elimination runs LAST: its guard is "the frame could not account
  // for this address", which is only true of what survives the two passes above.
  return sequence(
    createFrameIdentityTransformer(),
    slots.length > 0 ? createFrameSlotTransformer(slots) : ((node: ASTNode) => node),
    // Only what the frame could NOT account for reaches the fold solver, which
    // is what makes "no slot owns this offset" evidence of a fold rather than a
    // rule that has not run yet.
    slots.length > 0 && Object.keys(globalAddresses).length > 0
      ? createFoldedGlobalAddressTransformer(slots, globalAddresses)
      : ((node: ASTNode) => node),
    createDeadFrameStoreTransformer(),
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
