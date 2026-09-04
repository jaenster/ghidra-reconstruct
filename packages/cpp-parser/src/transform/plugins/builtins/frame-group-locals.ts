/**
 * Frame-Group Locals Plugin
 *
 * The decompiler names each stack slot separately. Where the original code kept
 * an implicit struct on the frame — one object the code addresses through the
 * address of its FIRST slot, letting the callee reach the rest by byte offset —
 * Ghidra hands back N unrelated scalars, and C++ gives the compiler leave to put
 * them anywhere.
 *
 * `Storm::WindowHandle::WND_DispatchWindowMessage` @0x00420b00 is the site that
 * proved it. Its frame was `-36 hMsgWnd, -32 uMsgL, -28 nMsgWParam,
 * -24 dwMsgLParam, -20 nCmdCode, (hole at -16), -12 dwResult1, -8 dwResult2`,
 * all `undefined4`, and the body called
 * `SEvtDispatch(tag, hCur, uMsg, (uintptr_t)&hMsgWnd)`. The callees read +0/+4/
 * +8/+12 and wrote +24/+28. Re-emitted as seven separate locals, gcc laid them
 * out at `-0x30, -0x18, -0x1c, -0x20, -0x24, -0x2c, -0x28`: `+4` from the passed
 * pointer landed on `dwResult1` and the mouse x/y read at `+12` landed on
 * `nCmdCode`. Every mouse and keyboard event in the recompiled build was fed
 * garbage, and nothing diagnosed it — the code compiles, it just reads the wrong
 * words.
 *
 * So a run of frame slots whose first member's ADDRESS ESCAPES is emitted as one
 * local of a synthesized struct type, with the original slots as members and
 * explicit `uint8_t` padding for every hole, and every reference rewritten to
 * `<group>.<member>`. A struct's members are laid out in declaration order, at
 * increasing addresses — that is the one layout guarantee C++ gives — so the
 * relative offsets the callee walks are restored by construction.
 *
 * What makes a run:
 *
 *   - it STARTS at a local whose address escapes: `&x` handed to a call, stored
 *     through an assignment, or used to initialise something. `&x` that is
 *     immediately dereferenced, or compared, does not escape;
 *   - it EXTENDS forward through slots at increasing offsets while the step from
 *     one slot's end to the next's start is a hole of at most `MAX_GAP` bytes —
 *     the worked example needs 4, one 32-bit slot, and that is the bound. A
 *     wider hole is a break in the frame, not padding inside an object;
 *   - a slot the emitted body does not DECLARE becomes padding. Ghidra lists
 *     frame variables the emitter drops, and their bytes still have to be
 *     reserved or every later offset shifts;
 *   - it needs at least TWO declared members. A local with no contiguous named
 *     neighbour is not this defect — it is the ordinary single-word out-param,
 *     `SRegLoadValue(&nValue)` and `SFILE_OpenFileEx(&hFile)`, which is correct
 *     as it stands. A prior survey rejected roughly 1150 of 1406
 *     escaping-address sites for exactly that reason.
 *
 * The run is cut short — never mis-laid-out — the moment an offset cannot be
 * reproduced: a member whose emitted C++ type has no size this pass can name
 * (an opaque typedef, an enum, an aggregate), a member whose type size disagrees
 * with the size Ghidra committed to the slot, a member whose natural alignment
 * would push it past its frame offset, a slot that overlaps its predecessor, or
 * a declaration this pass cannot move (declared twice, sharing a
 * declaration-statement with another variable, or `static`). Truncating keeps
 * the prefix exact; the group is dropped entirely if fewer than two declared
 * members survive. A silently wrong struct is worse than the status quo.
 *
 * A single `static_assert` per group checks the total size against the frame
 * span, so a wrong entry in the size table below fails at compile time instead
 * of moving a field. It is guarded on `sizeof(void *) == 4` because the frame it
 * describes is a 32-bit Win32 one. It catches a size error, not every possible
 * misplacement — the explicit padding and the alignment check are what carry
 * that.
 *
 * Where Ghidra already models the run as ONE typed slot the pass sees a single
 * local and does nothing, which is the right answer: 0x00420b00 above was fixed
 * in the database by retyping the slot to `D2UIMouseMsgStrc`, and this pass
 * leaves it alone — unless the DECOMPILER split that one slot back apart, which
 * is the second rule below.
 *
 * THE INVERSE DEFECT: ONE VARIABLE PRINTED AS SEVERAL
 *
 * The decompiler also synthesises INTERIOR ALIAS names for positions inside a
 * single frame variable — `auStack_5a2`, `auStack_5a0`, `aiStack_…` — where
 * `get_stack_frame` shows one variable. The emitter declared each as a separate
 * local, so one buffer became several unrelated objects and gcc was again free to
 * order them as it liked.
 *
 * `D2WINEDITBOX_HandleKeyPress` @0x004feae0 proved this one. Its frame holds ONE
 * `undefined1[1024]` at -1444, printed as `uint16_t local_5a4;
 * uint8_t auStack_5a2[2]; uint8_t auStack_5a0[1020];`. gcc laid the first two in
 * REVERSE — `local_5a4` at `ebp-0x756`, `auStack_5a2` at `ebp-0x758` — so
 * `&auStack_5a2` was `base - 2` where the machine code means `base + 2`. The text
 * length came out `len - 1` instead of `len + 1` (an empty box computing
 * `(unsigned)(-2) >> 1`), and `CONTAINER_InitializeBuffer(&local_5a4, 2, 0x200)`
 * wrote 1024 bytes into a two-byte local. Typing into any edit box in the
 * recompiled build showed nothing at all, and nothing crashed.
 *
 * So a Ghidra variable with two or more printed pieces becomes ONE struct too,
 * with the pieces as members at their own offsets inside it. It is the same
 * emission machinery and it must be the same pass: both rules move declarations
 * and rewrite the same identifiers, and two passes doing that would fight. The
 * rules differ only in what starts a group, and they are kept apart:
 *
 *   - a split needs NO escaping address. Ghidra's own frame is the evidence that
 *     the pieces are one object;
 *   - the pieces must tile the variable's extent without overlap, at offsets
 *     their own alignment allows, and every one must be movable. Anything less
 *     and the variable is left exactly as the run rule already treated it — a
 *     half-converted object is worse than a split one;
 *   - the struct spans the WHOLE variable, tail padding included, because that is
 *     how big the object the callee writes is;
 *   - a split group covers ONE variable and stops. Its extent says nothing about
 *     its neighbours; reaching further is the escape rule's business, and that
 *     rule stops at a split variable exactly where it stopped before.
 *
 * An alias whose offset matches no frame variable is LEFT ALONE. Without an
 * extent there is nothing to be accurate about.
 *
 * THE THIRD RULE: A WRITE WITH A KNOWN BYTE COUNT
 *
 * The two rules above bound a group by what the FRAME says. Neither can see the
 * one place the real extent is written down in full: the call that fills the
 * buffer. `LAUNCHER_LoadCharacterAppearanceFromD2s` @0x0043c8a0 proved it. Its
 * frame is one 8 KB save-file image at -9736 that Ghidra models as thirteen
 * named positions — `local_2608`, `dwSaveVersion`, `wLevel`, `cClassOld`,
 * `wLevelOld`, `abEquipSlotOld`, `byPlayerClass`, `abVisualSlotOld`,
 * `abEquipSlotNew`, `loadBuffer` — followed by the next REAL variable,
 * `szSavePathBuffer`, at -1544. The delta is 0x2000 exactly, and the body reads
 * `fread(&local_2608, 1, 0x2000, pSaveFile)`.
 *
 * The run rule saw a 16-byte hole after `dwSaveVersion` — wider than `MAX_GAP` —
 * and stopped, emitting a group of 8 bytes and the other 8184 as independent
 * locals. `0043c928` in the original is `PUSH 0x2000; LEA EAX,[EBP-0x2604]`,
 * inside the frame; the rebuilt `0x835d01` is `movl $0x2000,0x8(%esp); lea
 * -0x54(%ebp),%eax`, which writes 8108 bytes PAST the frame. A 3248-byte save
 * overwrote the saved EBP, the return address, both parameters and the whole
 * caller frame of `CHARSEL_EnumerateLocalSaves`.
 *
 * So when a frame object is the DESTINATION of a call whose byte count is a
 * LITERAL at the call site, the group starting there spans exactly
 * `[offset, offset + count)`. The count is the only statement of the object's
 * real size that survives decompilation; a hole in the middle is padding inside
 * it, not a break between two objects.
 *
 *   - the count must be constant AT THE CALL SITE. A variable count says nothing
 *     about the extent, and a sentinel like `SStrCopy`'s 0x7fffffff says less;
 *   - the span must not END INSIDE a later frame variable. That is a
 *     contradiction between the frame and the call, and guessing which is wrong
 *     is exactly how a field moves silently. Ending on a variable's start, or in
 *     a hole, is consistent; ending past the saved frame pointer is not. The
 *     bound is offset 0 and NOT the last variable Ghidra happened to name — half
 *     a frame is typically unnamed, and those bytes are the object's too;
 *   - every frame variable and interior alias inside the span must be movable and
 *     must tile without overlap, at offsets its own alignment allows. Anything
 *     less and the group is skipped whole: a missed group is the status quo, a
 *     wrong one is new corruption;
 *   - it only fires when the count EXCEEDS what the destination already spans.
 *     `memset(&x, 0, 4)` on a four-byte `x` is not this defect.
 *
 * A known-count group takes precedence over both other rules for the slots it
 * covers — its extent is stated, theirs is inferred.
 *
 * Runs LAST (priority 950). Every type pass — `call-arg-cast`, `assign-cast`,
 * `pointer-assign-cast` — resolves a local's type by looking its NAME up among
 * the body's `VariableDecl`s. Grouping first would hide the members from all of
 * them and drop casts that the tree needs to compile, so the grouping is the
 * last thing that happens: by then every cast is already in place around the
 * identifier, and this pass only respells it.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  FunctionDecl,
  CompoundStmt,
  DeclStmt,
  VariableDecl,
  ParameterDecl,
  FieldDecl,
  StructDecl,
  Identifier,
  Expression,
  Statement,
  TypeNode,
  ArrayType,
  QualifiedType,
  BuiltinType,
  TypedefType,
  MemberExpr,
  QualifiedId,
  LabelStmt,
  GotoStmt,
  ElaboratedType,
  UnaryExpr,
  ParenExpr,
  CStyleCastExpr,
  CallExpr,
  AssignExpr,
  IntegerLiteralExpr,
  StaticAssertDecl,
  StringLiteralExpr,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren, findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, identity, type Transformer } from '../../transformer.js';
import { Decl, Expr, Stmt, Type } from '../../../ast/factory.js';
import { TriviaKind } from '../../../lexer/trivia.js';
import { typeNodeName, builtinBase } from './call-arg-cast.js';
import type { StackSlot } from './stack-frame-address.js';
import { createPlugin } from '../registry.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface FrameGroupLocalsOptions extends PluginOptions {
  /** The enclosing function's frame, from Ghidra's own local-variable list. */
  slots?: StackSlot[];
}

/**
 * The widest hole tolerated inside one group: one 32-bit stack slot.
 *
 * The verified frame at 0x00420b00 has exactly that — nothing owns -16, and the
 * callee still writes -12 and -8 through the pointer to -36. A wider hole is a
 * break between two objects, not padding inside one.
 */
const MAX_GAP = 4;

/**
 * A run longer than this is the whole local area, not a struct. The largest run
 * in evidence is ten slots; the bound only stops a densely packed frame from
 * collapsing wholesale on the strength of one escaping address.
 */
const MAX_MEMBERS = 32;

/** Pointer width of the frame being modelled: 32-bit Win32. */
const POINTER_SIZE = 4;

/**
 * Calls that write a known number of bytes into a destination argument.
 *
 * `dest` is the argument that receives the bytes; `count` the one that says how
 * many. `times` names a second count that MULTIPLIES it — `fread(p, size,
 * nmemb, f)` writes `size * nmemb`. Matching is on the LAST component of the
 * callee's name, because the emitter qualifies these
 * (`Fog::Source::SFile::thunk_ReadFile`).
 *
 * A SOURCE argument is not here. `WriteFile(h, &hdr, 0x2000, ...)` reading past
 * a small object is its own defect, but it does not smash the frame, and the
 * count says nothing about how big the object was meant to be.
 */
interface CountedSink {
  dest: number;
  count: number;
  /** A second argument multiplied into the count, as `fread`'s element size. */
  times?: number;
}

const COUNTED_SINKS: Readonly<Record<string, CountedSink>> = {
  memset: { dest: 0, count: 2 },
  memcpy: { dest: 0, count: 2 },
  memmove: { dest: 0, count: 2 },
  bcopy: { dest: 1, count: 2 },
  bzero: { dest: 0, count: 1 },
  ZeroMemory: { dest: 0, count: 1 },
  RtlZeroMemory: { dest: 0, count: 1 },
  FillMemory: { dest: 0, count: 1 },
  RtlFillMemory: { dest: 0, count: 1 },
  CopyMemory: { dest: 0, count: 2 },
  RtlCopyMemory: { dest: 0, count: 2 },
  MoveMemory: { dest: 0, count: 2 },
  RtlMoveMemory: { dest: 0, count: 2 },
  strncpy: { dest: 0, count: 2 },
  strncat: { dest: 0, count: 2 },
  wcsncpy: { dest: 0, count: 2 },
  wcsncat: { dest: 0, count: 2 },
  builtin_strncpy: { dest: 0, count: 2 },
  builtin_memcpy: { dest: 0, count: 2 },
  SStrCopy: { dest: 0, count: 2 },
  SStrNCat: { dest: 0, count: 2 },
  ReadFile: { dest: 1, count: 2 },
  thunk_ReadFile: { dest: 1, count: 2 },
  fread: { dest: 0, count: 2, times: 1 },
  snprintf: { dest: 0, count: 1 },
  _snprintf: { dest: 0, count: 1 },
  swprintf: { dest: 0, count: 1 },
  _snwprintf: { dest: 0, count: 1 },
};

/**
 * The largest count this pass will believe.
 *
 * `SStrCopy(dst, src, 0x7fffffff)` is the "no limit" sentinel, not a size, and
 * the frame check below would reject it anyway. The cap makes that explicit and
 * keeps an absurd literal from ever reaching the arithmetic.
 */
const MAX_COUNT = 0x100000;

/**
 * Byte sizes for the type spellings the emitter produces. A member whose type is
 * NOT here ends the run — the size is what places every later member, and a
 * guess that is wrong moves fields silently.
 */
const SCALAR_SIZE: Readonly<Record<string, number>> = {
  bool: 1, char: 1, 'signed char': 1, 'unsigned char': 1,
  short: 2, 'unsigned short': 2, 'short int': 2, 'unsigned short int': 2,
  int: 4, 'unsigned int': 4, unsigned: 4, 'signed int': 4,
  long: 4, 'unsigned long': 4, 'long int': 4, 'unsigned long int': 4,
  float: 4,
  'long long': 8, 'unsigned long long': 8, 'long long int': 8, 'unsigned long long int': 8,
  double: 8,
  int8_t: 1, uint8_t: 1, int16_t: 2, uint16_t: 2,
  int32_t: 4, uint32_t: 4, int64_t: 8, uint64_t: 8,
  undefined: 1, undefined1: 1, undefined2: 2, undefined4: 4, undefined8: 8,
  byte: 1, sbyte: 1, word: 2, sword: 2, dword: 4, sdword: 4, qword: 8, sqword: 8,
  uint: 4, ushort: 2, uchar: 1, ulong: 4,
  wchar_t: 2, wchar16: 2,
  BYTE: 1, CHAR: 1, BOOLEAN: 1,
  WORD: 2, SHORT: 2, USHORT: 2, WCHAR: 2,
  DWORD: 4, LONG: 4, ULONG: 4, UINT: 4, INT: 4, BOOL: 4, COLORREF: 4, FLOAT: 4,
};

interface TypeLayout {
  size: number;
  align: number;
}

/** Size and alignment of an emitted type, or null when this pass cannot say. */
export function frameTypeLayout(type: TypeNode | undefined): TypeLayout | null {
  if (!type) return null;
  switch (type.kind) {
    case NodeKind.PointerType:
      return { size: POINTER_SIZE, align: POINTER_SIZE };
    case NodeKind.QualifiedType:
      return frameTypeLayout((type as QualifiedType).type);
    case NodeKind.BuiltinType: {
      const b = type as BuiltinType;
      const size = SCALAR_SIZE[builtinBase(b.name, b.modifiers)];
      return size === undefined ? null : { size, align: size };
    }
    case NodeKind.TypedefType: {
      const name = typeNodeName((type as TypedefType).name);
      if (name === undefined) return null;
      const size = SCALAR_SIZE[name];
      return size === undefined ? null : { size, align: size };
    }
    case NodeKind.ArrayType: {
      const arr = type as ArrayType;
      const element = frameTypeLayout(arr.elementType);
      if (!element) return null;
      if (!arr.size || arr.size.kind !== NodeKind.IntegerLiteral) return null;
      const count = Number((arr.size as IntegerLiteralExpr).value);
      if (!Number.isSafeInteger(count) || count <= 0) return null;
      return { size: element.size * count, align: element.align };
    }
    default:
      return null;
  }
}

function alignUp(value: number, align: number): number {
  return align <= 1 ? value : Math.ceil(value / align) * align;
}

function unwrapParens(expr: Expression): Expression {
  let e = expr;
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** Every node's parent, so a `&x` can be read in the context that consumes it. */
function parentMap(root: ASTNode): Map<ASTNode, ASTNode> {
  const parents = new Map<ASTNode, ASTNode>();
  for (const node of traverseAST(root)) {
    for (const child of getChildren(node)) parents.set(child, node);
  }
  return parents;
}

/**
 * Locals whose ADDRESS leaves the frame: handed to a call, stored through an
 * assignment, or used to initialise something. `*&x` and `&x == p` keep the
 * address inside the expression and prove nothing about layout.
 */
function escapingLocals(body: CompoundStmt): Set<string> {
  const parents = parentMap(body);
  const escaping = new Set<string>();

  for (const node of traverseAST(body)) {
    if (node.kind !== NodeKind.UnaryExpr) continue;
    const unary = node as UnaryExpr;
    if (unary.operator !== '&') continue;
    const target = unwrapParens(unary.operand);
    if (target.kind !== NodeKind.Identifier) continue;

    // Walk out through the parentheses and casts the decompiler wraps an address
    // in — `(uintptr_t)&hMsgWnd` is still the address of `hMsgWnd`.
    let child: ASTNode = node;
    let parent = parents.get(child);
    while (parent && (parent.kind === NodeKind.ParenExpr || parent.kind === NodeKind.CStyleCastExpr)) {
      child = parent;
      parent = parents.get(child);
    }
    if (!parent) continue;

    let escapes = false;
    if (parent.kind === NodeKind.CallExpr) {
      escapes = (parent as CallExpr).arguments.includes(child as Expression);
    } else if (parent.kind === NodeKind.AssignExpr) {
      escapes = (parent as AssignExpr).right === child;
    } else if (parent.kind === NodeKind.VariableDecl) {
      escapes = (parent as VariableDecl).initializer === child;
    }
    if (escapes) escaping.add((target as Identifier).name);
  }
  return escaping;
}

/** A local this pass is allowed to move into a group. */
interface MovableLocal {
  decl: VariableDecl;
  /** The statement that declares it, so the declaration can be replaced. */
  stmt: DeclStmt;
  layout: TypeLayout;
}

/**
 * Locals the pass can move: declared exactly once, alone in their
 * declaration-statement, with no storage specifier, and of a type whose size is
 * known. Anything else stays where it is — and ends any run that reaches it.
 */
function movableLocals(body: CompoundStmt): Map<string, MovableLocal> {
  const declCount = new Map<string, number>();
  for (const d of findNodesByKind(body, NodeKind.VariableDecl)) {
    const name = (d as VariableDecl).name?.name;
    if (name) declCount.set(name, (declCount.get(name) ?? 0) + 1);
  }

  const movable = new Map<string, MovableLocal>();
  for (const s of findNodesByKind(body, NodeKind.DeclStmt)) {
    const stmt = s as DeclStmt;
    if (stmt.declarations.length !== 1) continue;
    const decl = stmt.declarations[0];
    if (decl.kind !== NodeKind.VariableDecl) continue;
    const v = decl as VariableDecl;
    const name = v.name?.name;
    if (!name || declCount.get(name) !== 1) continue;
    if (v.specifiers && v.specifiers.length > 0) continue;
    const layout = frameTypeLayout(v.type);
    if (!layout) continue;
    movable.set(name, { decl: v, stmt, layout });
  }
  return movable;
}

/** The last component of a callee's name: `A::B::memset` is `memset`. */
function calleeBaseName(callee: Expression): string | null {
  const e = unwrapParens(callee);
  switch (e.kind) {
    case NodeKind.Identifier:
      return (e as Identifier).name;
    case NodeKind.QualifiedId: {
      const q = e as QualifiedId;
      return q.name.kind === NodeKind.Identifier ? (q.name as Identifier).name : null;
    }
    case NodeKind.MemberExpr: {
      const m = e as MemberExpr;
      return m.member.kind === NodeKind.Identifier ? (m.member as Identifier).name : null;
    }
    default:
      return null;
  }
}

/** A non-negative integer literal, through the casts the decompiler wraps it in. */
function literalCount(arg: Expression | undefined): number | null {
  if (!arg) return null;
  let e = unwrapParens(arg);
  while (e.kind === NodeKind.CStyleCastExpr) e = unwrapParens((e as CStyleCastExpr).expression);
  if (e.kind !== NodeKind.IntegerLiteral) return null;
  const n = Number((e as IntegerLiteralExpr).value);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

/**
 * The local a destination argument names, or null when the argument is not a
 * frame object.
 *
 * `&x` — through the parentheses and casts the decompiler adds — is the address
 * of the frame object `x`, whatever its type. A BARE identifier only counts when
 * its declared type is an ARRAY: that is the decay of a frame buffer.
 * `memset(pPalShiftEntry, 0, 0x1008)` on an `int *` from `AllocClientMemory`
 * writes to the HEAP, and reading its count as a frame extent would invent an
 * 0x1008-byte stack object that the original never had.
 */
function destinationLocal(arg: Expression | undefined, movable: Map<string, MovableLocal>): string | null {
  if (!arg) return null;
  let e = unwrapParens(arg);
  while (e.kind === NodeKind.CStyleCastExpr) e = unwrapParens((e as CStyleCastExpr).expression);
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '&') {
    const target = unwrapParens((e as UnaryExpr).operand);
    return target.kind === NodeKind.Identifier ? (target as Identifier).name : null;
  }
  if (e.kind !== NodeKind.Identifier) return null;
  const name = (e as Identifier).name;
  const local = movable.get(name);
  if (!local) return null;
  return local.decl.type?.kind === NodeKind.ArrayType ? name : null;
}

/**
 * Local name → the largest LITERAL byte count written into it by a call.
 *
 * The count is the only place the object's real size survives decompilation. The
 * largest one wins: the object has to be at least as big as the biggest write,
 * and a smaller write into the same buffer is not evidence against that.
 */
function knownCountWrites(body: CompoundStmt, movable: Map<string, MovableLocal>): Map<string, number> {
  const writes = new Map<string, number>();
  for (const node of traverseAST(body)) {
    if (node.kind !== NodeKind.CallExpr) continue;
    const call = node as CallExpr;
    const name = calleeBaseName(call.callee);
    if (!name) continue;
    const sink = COUNTED_SINKS[name];
    if (!sink) continue;
    const count = literalCount(call.arguments[sink.count]);
    if (count === null) continue;
    let bytes = count;
    if (sink.times !== undefined) {
      const times = literalCount(call.arguments[sink.times]);
      if (times === null) continue;
      bytes *= times;
    }
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_COUNT) continue;
    const dest = destinationLocal(call.arguments[sink.dest], movable);
    if (!dest) continue;
    writes.set(dest, Math.max(writes.get(dest) ?? 0, bytes));
  }
  return writes;
}

/**
 * The signed frame offset a decompiler AUTO-NAME encodes, or null.
 *
 * Ghidra spells an unnamed frame position by the magnitude of its offset in hex:
 * `local_5a4` and `auStack_5a2` are frame -0x5a4 and -0x5a2. Only the two auto
 * shapes are read — `local_<hex>` and `<type prefix>Stack_<hex>` — because a name
 * the frame does not carry is the ONLY evidence an interior alias leaves, and a
 * looser pattern would read an offset out of a hand-given name.
 */
export function frameAliasOffset(name: string): number | null {
  const m = /^(?:local|[A-Za-z]{1,6}Stack)_([0-9a-fA-F]+)$/.exec(name);
  if (!m) return null;
  const magnitude = Number.parseInt(m[1], 16);
  if (!Number.isSafeInteger(magnitude) || magnitude <= 0) return null;
  return -magnitude;
}

/** One member of a synthesized group: an original local, or reserved padding. */
interface GroupMember {
  /** null for padding. */
  name: string | null;
  type: TypeNode;
  /** Byte offset within the group. */
  at: number;
  size: number;
  align: number;
  /**
   * Padding that reserves the tail of a Ghidra variable, not the gap between two
   * of them. It is part of the object and must survive the trailing-padding trim.
   */
  sealed?: boolean;
}

/**
 * One declared piece of a single Ghidra frame variable that the decompiler
 * printed as several: `local_5a4`, `auStack_5a2`, `auStack_5a0` for the one
 * `undefined1[1024]` at frame -1444.
 */
interface SlotPiece {
  name: string;
  local: MovableLocal;
  /** Byte offset within the owning slot. */
  rel: number;
}

/** Why a group exists, which is also what its comment has to say. */
type GroupReason = 'escape' | 'split' | 'write';

interface FrameGroup {
  varName: string;
  typeName: string;
  members: GroupMember[];
  /** Frame offset of the first member, for the explanatory comment. */
  baseOffset: number;
  /** `sizeof` the emitted struct must have on the 32-bit target. */
  expectedSize: number;
  reason: GroupReason;
}

function paddingMember(at: number, bytes: number, sealed = false): GroupMember {
  return {
    name: null,
    type: Type.array(Type.typedef('uint8_t'), Expr.intLiteral(bytes)),
    at,
    size: bytes,
    align: 1,
    sealed,
  };
}

/**
 * The Ghidra frame variables the decompiler split into several printed locals,
 * as an exact tiling of each one's extent.
 *
 * This is the INVERSE of the run rule below. There, N separate frame variables
 * have to stay contiguous because the address of the first escapes. Here ONE
 * frame variable — `get_stack_frame` says so — was printed as several, and the
 * emitter turned each into an unrelated object. `D2WINEDITBOX_HandleKeyPress`
 * @0x004feae0 is the site that proved it: one `undefined1[1024]` at -1444 came
 * out as `uint16_t local_5a4; uint8_t auStack_5a2[2]; uint8_t auStack_5a0[1020];`
 * and gcc laid the first two in REVERSE, so `&auStack_5a2` was `base - 2` where
 * the machine code means `base + 2`. Every edit box in the recompiled build
 * showed nothing at all as you typed, and `CONTAINER_InitializeBuffer(&local_5a4,
 * 2, 0x200)` wrote 1024 bytes into a two-byte local on top of it.
 *
 * A slot qualifies only when at least TWO printed locals map into it, every one
 * of them is movable, and together they tile `[0, slot.size)` without overlap and
 * at offsets their own alignment permits. Anything less and the slot is left
 * exactly as the run rule already treats it: a half-converted object would be
 * worse than the split one.
 */
function splitSlotPieces(
  locals: StackSlot[],
  movable: Map<string, MovableLocal>,
  declaredNames: ReadonlySet<string>,
): Map<string, SlotPiece[]> {
  const slotByName = new Map<string, StackSlot>();
  for (const s of locals) slotByName.set(s.name, s);

  const splits = new Map<string, SlotPiece[]>();
  for (const slot of locals) {
    const candidates: { name: string; rel: number }[] = [];
    for (const name of declaredNames) {
      if (name === slot.name) {
        candidates.push({ name, rel: 0 });
        continue;
      }
      // A name the frame itself carries is that variable, wherever its auto-name
      // shape would otherwise point.
      if (slotByName.has(name)) continue;
      const offset = frameAliasOffset(name);
      if (offset === null) continue;
      if (offset < slot.offset || offset >= slot.offset + slot.size) continue;
      candidates.push({ name, rel: offset - slot.offset });
    }
    if (candidates.length < 2) continue;

    candidates.sort((a, b) => a.rel - b.rel || (a.name < b.name ? -1 : 1));
    const pieces: SlotPiece[] = [];
    let end = 0;
    let ok = true;
    for (const c of candidates) {
      const local = movable.get(c.name);
      if (!local) { ok = false; break; }
      if (c.rel < end) { ok = false; break; }
      if (c.rel % local.layout.align !== 0) { ok = false; break; }
      if (c.rel + local.layout.size > slot.size) { ok = false; break; }
      pieces.push({ name: c.name, local, rel: c.rel });
      end = c.rel + local.layout.size;
    }
    if (!ok || pieces.length < 2) continue;

    // The struct stands in for the whole variable, so its size has to be the
    // whole variable's — the callee at 0x004feae0 writes all 1024 bytes.
    const maxAlign = pieces.reduce((a, p) => Math.max(a, p.local.layout.align), 1);
    if (alignUp(slot.size, maxAlign) !== slot.size) continue;

    splits.set(slot.name, pieces);
  }
  return splits;
}

/**
 * The maximal run starting at `slots[start]`, as members with exact offsets, or
 * null when fewer than two declared locals survive the checks.
 */
function planRun(
  slots: StackSlot[],
  start: number,
  movable: Map<string, MovableLocal>,
  stuck: ReadonlySet<string>,
  splits: Map<string, SlotPiece[]>,
  blocked: ReadonlySet<string>,
): GroupMember[] | null {
  const base = slots[start].offset;
  const members: GroupMember[] = [];
  let cursor = 0;
  let declared = 0;
  let lastEnd = base;

  for (let i = start; i < slots.length; i++) {
    const slot = slots[i];
    if (i > start) {
      // A split variable is a whole object with a known extent; it is grouped on
      // its own, and a run reaching it stops exactly where it stopped before.
      if (splits.has(slot.name)) break;
      // A slot a known-count group already owns has a STATED extent; an inferred
      // run must not reach into it.
      if (blocked.has(slot.name)) break;
      const gap = slot.offset - lastEnd;
      if (gap < 0 || gap > MAX_GAP) break;
    }
    const rel = slot.offset - base;
    if (rel < cursor) break;

    const pieces = i === start ? splits.get(slot.name) : undefined;
    if (pieces) {
      // ONE variable is one group. Its extent is exactly known, and nothing about
      // it is evidence for its neighbours — extending is the escape rule's job,
      // and that rule stops at a split slot just as it stopped here before.
      // ONE Ghidra variable the decompiler printed as several. The pieces tile
      // its extent exactly (`splitSlotPieces` checked), so they go in at their
      // own offsets and the whole extent is reserved.
      if (declared + pieces.length > MAX_MEMBERS) break;
      let at = rel;
      for (const p of pieces) {
        const target = rel + p.rel;
        if (target > at) members.push(paddingMember(at, target - at, true));
        members.push({
          name: p.name,
          type: p.local.decl.type,
          at: target,
          size: p.local.layout.size,
          align: p.local.layout.align,
        });
        at = target + p.local.layout.size;
      }
      const end = rel + slot.size;
      if (end > at) members.push(paddingMember(at, end - at, true));
      cursor = end;
      declared += pieces.length;
      break;
    }

    const local = movable.get(slot.name);
    if (local) {
      // A declared slot whose emitted type disagrees with the width Ghidra
      // committed to the frame cannot be placed: one of the two is wrong, and
      // guessing which moves every later member.
      if (local.layout.size !== slot.size) break;
      if (declared === MAX_MEMBERS) break;
      const padded: GroupMember[] = [];
      let at = cursor;
      if (rel > cursor) {
        padded.push(paddingMember(cursor, rel - cursor));
        at = rel;
      }
      // Padding is `uint8_t`, so the member sits exactly at `rel` only when
      // `rel` already satisfies its own alignment.
      if (alignUp(at, local.layout.align) !== rel) break;
      members.push(...padded, {
        name: slot.name,
        type: local.decl.type,
        at: rel,
        size: local.layout.size,
        align: local.layout.align,
      });
      cursor = rel + local.layout.size;
      declared++;
    } else if (stuck.has(slot.name)) {
      // Declared, but this pass cannot move the declaration. Its bytes could be
      // reserved, but the local itself would stay outside the group and keep
      // floating, so the run ends here.
      break;
    }
    // A slot the body does not declare at all (the emitter drops some) reserves
    // its bytes through the gap arithmetic above and needs no member.
    lastEnd = slot.offset + slot.size;
  }

  if (declared < 2) return null;
  // Never end on padding: trailing bytes belong to whatever follows the run —
  // unless they are the tail of a variable the group stands in for, which is
  // part of the object and has to be reserved.
  while (members.length > 0) {
    const last = members[members.length - 1];
    if (last.name !== null || last.sealed) break;
    members.pop();
  }
  return members;
}

/**
 * The group a known-count write demands: exactly `[base, base + bytes)`, with
 * every frame variable and interior alias inside it as a member at its own
 * offset. Null when the span contradicts the frame, when a piece cannot be
 * moved, when the pieces do not tile, or when there is no defect to fix.
 */
function planKnownCount(
  locals: StackSlot[],
  start: number,
  bytes: number,
  movable: Map<string, MovableLocal>,
  declaredNames: ReadonlySet<string>,
): GroupMember[] | null {
  const base = locals[start].offset;
  const baseLocal = movable.get(locals[start].name);
  // The group is addressed through its FIRST member; if that one cannot be moved
  // there is nothing to anchor the rest to.
  if (!baseLocal) return null;
  const end = base + bytes;

  // Past the top of the local area. Offset 0 is the saved frame pointer, so a
  // group that reaches it fills the locals exactly and one that passes it is
  // describing something other than this frame. The bound is 0 and NOT the end
  // of the last NAMED variable: Ghidra names only part of a frame, and the bytes
  // above the last name are still the object's — `MISSILE_CreateDebrisWithCollision`
  // @0x004d2520 writes 0x5c from -96, ending at -4 with nothing named past -44.
  if (end > 0) return null;

  // Ending INSIDE a later variable is a contradiction between the frame and the
  // call. Ending on a variable's start, or in a hole, is consistent.
  for (const slot of locals) {
    if (slot.offset < end && end < slot.offset + slot.size) return null;
  }

  // Only a write that exceeds what the destination already spans is this defect.
  if (bytes <= baseLocal.layout.size) return null;

  const slotByName = new Map<string, StackSlot>();
  for (const s of locals) slotByName.set(s.name, s);

  const candidates: { name: string; rel: number; local: MovableLocal }[] = [];
  for (const slot of locals) {
    if (slot.offset < base || slot.offset >= end) continue;
    if (!declaredNames.has(slot.name)) continue;   // undeclared bytes become padding
    const local = movable.get(slot.name);
    if (!local) return null;                       // declared but stuck: it would float
    candidates.push({ name: slot.name, rel: slot.offset - base, local });
  }
  for (const name of declaredNames) {
    if (slotByName.has(name)) continue;            // a real variable, handled above
    const offset = frameAliasOffset(name);
    if (offset === null || offset < base || offset >= end) continue;
    const local = movable.get(name);
    if (!local) return null;
    candidates.push({ name, rel: offset - base, local });
  }
  if (candidates.length === 0 || candidates.length > MAX_MEMBERS) return null;

  candidates.sort((a, b) => a.rel - b.rel || (a.name < b.name ? -1 : 1));
  const members: GroupMember[] = [];
  let cursor = 0;
  for (const c of candidates) {
    if (c.rel < cursor) return null;                       // overlap
    if (c.rel % c.local.layout.align !== 0) return null;    // padding is uint8_t
    if (c.rel + c.local.layout.size > bytes) return null;   // runs out of the span
    if (c.rel > cursor) members.push(paddingMember(cursor, c.rel - cursor, true));
    members.push({
      name: c.name,
      type: c.local.decl.type,
      at: c.rel,
      size: c.local.layout.size,
      align: c.local.layout.align,
    });
    cursor = c.rel + c.local.layout.size;
  }
  // The struct IS the object the callee fills, so its tail is part of it.
  if (cursor < bytes) members.push(paddingMember(cursor, bytes - cursor, true));

  // `sizeof` has to come out at exactly `bytes`; trailing alignment padding the
  // compiler adds would move nothing but would fail the assert, and a span the
  // members' alignment cannot express is not one this pass can reproduce.
  const maxAlign = members.reduce((a, m) => Math.max(a, m.align), 1);
  if (alignUp(bytes, maxAlign) !== bytes) return null;
  return members;
}

/** A short name that nothing in the body already uses. */
function freeName(used: Set<string>, index: number): { varName: string; typeName: string } {
  let n = index;
  for (;;) {
    const varName = `__frame${n}`;
    const typeName = `${varName}_t`;
    if (!used.has(varName) && !used.has(typeName)) return { varName, typeName };
    n++;
  }
}

/** The two comment lines that say why the group exists, ahead of its definition. */
function explanation(group: FrameGroup): string[] {
  const first = group.members.find(m => m.name)?.name ?? '';
  if (group.reason === 'write') {
    return [
      `// Frame ${group.baseOffset}..${group.baseOffset + group.expectedSize} is ONE object:`
        + ` a call writes ${group.expectedSize} literal bytes starting at &${first}.`,
      '// Separate locals let the compiler reorder them, and the write would run off the frame.',
    ];
  }
  if (group.reason === 'split') {
    return [
      `// Frame ${group.baseOffset}..${group.baseOffset + group.expectedSize} is ONE Ghidra variable`
        + ` the decompiler printed as ${group.members.filter(m => m.name).length} locals.`,
      '// Separate locals let the compiler reorder them, so the pieces are one struct.',
    ];
  }
  return [
    `// Frame slots ${group.baseOffset}..${group.baseOffset + group.expectedSize} are ONE object:`
      + ` &${first} is passed out and the callee reaches the rest by byte offset.`,
    '// Separate locals let the compiler reorder them, so the run is one struct.',
  ];
}

function structFor(group: FrameGroup): StructDecl {
  const fields: FieldDecl[] = group.members.map(m =>
    Decl.field(m.name ?? `__pad${m.at}`, m.type));
  return Decl.struct_(group.typeName, fields);
}

function sizeAssert(group: FrameGroup): StaticAssertDecl {
  const message: StringLiteralExpr = Expr.stringLiteral(
    `frame group ${group.typeName} must reproduce the Ghidra frame layout`);
  const isWin32 = Expr.binary(
    Expr.sizeof(Type.pointer(Type.void()), true), '!=', Expr.intLiteral(POINTER_SIZE));
  const sized = Expr.binary(
    Expr.sizeof(Type.typedef(group.typeName), true), '==', Expr.intLiteral(group.expectedSize));
  return {
    kind: NodeKind.StaticAssertDecl,
    condition: Expr.binary(isWin32, '||', sized),
    message,
    location: message.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as StaticAssertDecl;
}

/** The three statements that introduce one group at the top of the body. */
function groupStatements(group: FrameGroup): Statement[] {
  const struct = Stmt.declStmt([structFor(group)]);
  struct.leadingTrivia = explanation(group).map(text => ({
    kind: TriviaKind.LineComment,
    text,
    location: struct.location,
  }));
  return [
    struct,
    Stmt.declStmt([sizeAssert(group)]),
    Stmt.declStmt([Decl.variable(group.varName, Type.typedef(group.typeName))]),
  ];
}

/** `<group>.<member>`, the respelling of one grouped local. */
function memberAccess(group: string, member: string): MemberExpr {
  return Expr.member(Expr.identifier(group), member, false);
}

/**
 * A `<group>.<member>` this pass built, unwrapped back to its bare identifier.
 *
 * The rewrite replaces identifiers wherever they occur, and an identifier is
 * also how a member name, a type name and a label are spelled. Those positions
 * are restored on the way back up: `pRect->nRectLeft` must not become
 * `pRect->__frame0.nRectLeft`.
 */
function unwrapGroupAccess(node: unknown, groupVars: Set<string>): Identifier | null {
  const n = node as MemberExpr | undefined;
  if (!n || n.kind !== NodeKind.MemberExpr || n.isArrow) return null;
  const object = n.object;
  if (object.kind !== NodeKind.Identifier) return null;
  if (!groupVars.has((object as Identifier).name)) return null;
  return n.member.kind === NodeKind.Identifier ? (n.member as Identifier) : null;
}

function createFrameGroupLocalsTransformer(options: FrameGroupLocalsOptions = {}): Transformer {
  const slots = options.slots ?? [];
  if (slots.length === 0) return identity;

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      const body = node.body;

      const paramNames = new Set<string>();
      for (const p of node.parameters) {
        const name = (p as ParameterDecl).name?.name;
        if (name) paramNames.add(name);
      }

      const locals = slots
        .filter(s => !s.isParameter && s.offset < 0 && s.size > 0 && !paramNames.has(s.name))
        .sort((a, b) => a.offset - b.offset)
        .filter((s, i, all) => i === 0 || all[i - 1].offset !== s.offset);
      if (locals.length === 0) return undefined;

      const movable = movableLocals(body);
      const declaredNames = new Set<string>();
      for (const d of findNodesByKind(body, NodeKind.VariableDecl)) {
        const name = (d as VariableDecl).name?.name;
        if (name) declaredNames.add(name);
      }
      const stuck = new Set([...declaredNames].filter(n => !movable.has(n)));

      // A variable Ghidra models as one and the decompiler printed as several is
      // mis-laid-out on its own evidence; nothing has to escape for that.
      const splits = splitSlotPieces(locals, movable, declaredNames);
      const escaping = escapingLocals(body);
      // A call with a literal byte count STATES the extent; the other two rules
      // only infer it.
      const writes = knownCountWrites(body, movable);
      if (escaping.size === 0 && splits.size === 0 && writes.size === 0) return undefined;

      const used = new Set<string>(declaredNames);
      for (const id of traverseAST(body)) {
        if (id.kind === NodeKind.Identifier) used.add((id as Identifier).name);
      }

      const plans: Omit<FrameGroup, 'varName' | 'typeName'>[] = [];
      const consumedSlots = new Set<string>();
      /** Slot names a known-count group owns: no inferred run may reach them. */
      const blocked = new Set<string>();

      // The stated extents first, so an inferred run can be stopped by one.
      for (let i = 0; i < locals.length; i++) {
        const slot = locals[i];
        if (blocked.has(slot.name)) continue;
        const bytes = writes.get(slot.name);
        if (bytes === undefined) continue;
        const members = planKnownCount(locals, i, bytes, movable, declaredNames);
        if (!members) continue;
        plans.push({ members, baseOffset: slot.offset, expectedSize: bytes, reason: 'write' });
        for (const m of members) if (m.name) consumedSlots.add(m.name);
        for (const s of locals) {
          if (s.offset >= slot.offset && s.offset < slot.offset + bytes) blocked.add(s.name);
        }
      }

      for (let i = 0; i < locals.length; i++) {
        const slot = locals[i];
        if (consumedSlots.has(slot.name) || blocked.has(slot.name)) continue;
        const isSplit = splits.has(slot.name);
        if (!isSplit && (!escaping.has(slot.name) || !movable.has(slot.name))) continue;

        const run = planRun(locals, i, movable, stuck, splits, blocked);
        if (!run) continue;

        const declared = run.filter(m => m.name !== null);
        const maxAlign = declared.reduce((a, m) => Math.max(a, m.align), 1);
        const span = run.reduce((end, m) => Math.max(end, m.at + m.size), 0);
        plans.push({
          members: run,
          baseOffset: slot.offset,
          expectedSize: alignUp(span, maxAlign),
          reason: isSplit ? 'split' : 'escape',
        });
        for (const m of declared) consumedSlots.add(m.name as string);
      }

      if (plans.length === 0) return undefined;

      // Named in frame order, so the emitted preamble reads bottom-up like the
      // frame itself and a name does not move when an unrelated rule fires.
      plans.sort((a, b) => a.baseOffset - b.baseOffset);
      const groups: FrameGroup[] = plans.map((plan, i) => {
        const names = freeName(used, i);
        used.add(names.varName);
        used.add(names.typeName);
        return { ...names, ...plan };
      });

      const memberOwner = new Map<string, string>();
      const groupVars = new Set<string>();
      for (const g of groups) {
        groupVars.add(g.varName);
        for (const m of g.members) if (m.name) memberOwner.set(m.name, g.varName);
      }

      const dropped = new Set<ASTNode>();
      const restore = (n: ASTNode, field: string): ASTNode | undefined => {
        const current = (n as unknown as Record<string, unknown>)[field];
        const original = unwrapGroupAccess(current, groupVars);
        return original ? updateNode(n, { [field]: original } as Partial<ASTNode>) : undefined;
      };

      const rewrite = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          switch (n.kind) {
            // Positions where an identifier NAMES something rather than reading
            // it. The blanket identifier rewrite below reaches them too, and a
            // member access there is nonsense.
            case NodeKind.MemberExpr:
              return restore(n, 'member');
            case NodeKind.TypedefType:
            case NodeKind.ElaboratedType:
              return restore(n as TypedefType | ElaboratedType, 'name');
            case NodeKind.LabelStmt:
            case NodeKind.GotoStmt:
              return restore(n as LabelStmt | GotoStmt, 'label');
            case NodeKind.ParameterDecl:
            case NodeKind.FieldDecl:
            case NodeKind.FunctionDecl:
              return restore(n, 'name');
            case NodeKind.QualifiedId: {
              const q = n as QualifiedId;
              const name = unwrapGroupAccess(q.name, groupVars);
              const qualifier = q.qualifier.map(p => unwrapGroupAccess(p, groupVars) ?? p);
              const changed = name !== null || qualifier.some((p, i) => p !== q.qualifier[i]);
              return changed
                ? updateNode(q, { name: name ?? q.name, qualifier } as Partial<QualifiedId>)
                : undefined;
            }

            case NodeKind.VariableDecl:
              return restore(n, 'name');

            case NodeKind.DeclStmt: {
              const stmt = n as DeclStmt;
              if (stmt.declarations.length !== 1) return undefined;
              const decl = stmt.declarations[0];
              if (decl.kind !== NodeKind.VariableDecl) return undefined;
              const v = decl as VariableDecl;
              const owner = v.name && memberOwner.get(v.name.name);
              if (!owner) return undefined;
              if (v.initializer) {
                const assign = Stmt.expr(
                  Expr.assign(memberAccess(owner, v.name.name), v.initializer));
                assign.leadingTrivia = stmt.leadingTrivia ?? [];
                return assign;
              }
              const gone = Stmt.null_();
              dropped.add(gone);
              return gone;
            }

            case NodeKind.CompoundStmt: {
              const block = n as CompoundStmt;
              if (!block.statements.some(s => dropped.has(s))) return undefined;
              return updateNode(block, {
                statements: block.statements.filter(s => !dropped.has(s)),
              } as Partial<CompoundStmt>);
            }

            case NodeKind.Identifier: {
              const owner = memberOwner.get((n as Identifier).name);
              return owner ? memberAccess(owner, (n as Identifier).name) : undefined;
            }

            default:
              return undefined;
          }
        },
      });

      let rewritten = rewrite(body) as CompoundStmt;
      const preamble: Statement[] = [];
      for (const g of groups) preamble.push(...groupStatements(g));
      rewritten = updateNode(rewritten, {
        statements: [...preamble, ...rewritten.statements],
      } as Partial<CompoundStmt>);

      return updateNode(node, { body: rewritten } as Partial<FunctionDecl>);
    },
  });
}

export const frameGroupLocalsPlugin: TransformPlugin = createPlugin(
  'frame-group-locals',
  'Frame-Group Locals',
  'Emits a frame object the decompiler scattered across several locals as one struct-typed local - a run whose first address escapes, a Ghidra variable printed in pieces, or the span a call writes a literal byte count into - so the callee\'s byte offsets survive compilation',
  (options?: PluginOptions) =>
    createFrameGroupLocalsTransformer(options as FrameGroupLocalsOptions),
  {
    // Last. Every type pass resolves a local by name against the body's
    // VariableDecls; grouping earlier hides the members from all of them.
    priority: 950,
    defaultEnabled: true,
    tags: ['correctness', 'declaration'],
    version: '1.1.0',
  }
);
