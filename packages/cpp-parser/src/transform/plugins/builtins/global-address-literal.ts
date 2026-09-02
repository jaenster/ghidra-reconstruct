/**
 * Global Address Literal Resolution Plugin
 *
 * The data counterpart of `func-ptr-literal`. Where that pass resolves an
 * integer literal that IS a function's address into a reference to the
 * function, this one resolves a literal that is a GLOBAL's address — or a
 * folded expression over one — into a reference to the global.
 *
 * Transforms:
 * - `0x708360`    →  `&gSFileAsyncReqQueue`
 * - `0x708368`    →  `((char*)&gSFileAsyncReqQueue + 8)`
 * - `-7373669`    →  `~(uintptr_t)((char*)&gSFileAsyncReqQueue + 4)`
 * - `0x6cc928`    →  `s_modstate0_006cc928`      (a string constant: `char[N]`)
 * - `0x6cc92b`    →  `(s_modstate0_006cc928 + 3)`
 *
 * ## Why the complement form exists
 *
 * Ghidra constant-folds `~&someGlobal` into ONE literal, which the emitter then
 * prints verbatim — as a signed 32-bit decimal, because that is how a word with
 * the top bit set reads. `gSFileAsyncReqQueue.pHead = (void*)-7373669` is a
 * Storm linked-list anchor: `-7373669` is `0xFF8F7C9B`, which is `~0x00708364`,
 * which is four bytes into the queue head. Kept as a literal it is an absolute
 * 1.14d image address, meaningless once the linker places the object somewhere
 * else — those four anchors are why the reconstructed `d2.exe` faulted with a
 * WRITE at 0x00000000 while loading its first MPQ. Written through the symbol,
 * the value follows the object.
 *
 * ## The rules, in order
 *
 * For a literal reduced to an unsigned 32-bit value `v`:
 *
 *  1. `v` is EXACTLY some global's address → `&name`. If two globals share the
 *     address the literal is left alone; picking one would be a guess.
 *  2. `v` falls strictly inside `[address, address + size)` of exactly ONE
 *     global → `((char*)&name + n)`. Sizes come from the extraction, never from
 *     the gap to the next symbol — an inferred extent would silently widen a
 *     global and swallow a neighbour's base.
 *  3. Neither matched, and `v`'s high bit is set → retry rules 1 and 2 against
 *     `~v`, and wrap the hit as `~(uintptr_t)<form>`.
 *
 * Rule 1 beats rule 2 where both fire: a literal that is one global's base and
 * another's interior names the base, which is the more specific fact. Rule 2
 * requires uniqueness among interiors only.
 *
 * ## One past the end of A is also the base of B
 *
 * `gaYBufferRowOffsets` is `int32_t[732]` at 0x7c97a8; 0x7c97a8 + 732*4 is
 * 0x7ca318, which is `&gnTileClipLeft`. In the image those are the same byte.
 * In this tree they are two objects the linker places wherever it likes, and
 * `D2GFX_ClearYBuffer`'s `while ((int)pRow < 0x7ca318)` read as `&gnTileClipLeft`
 * ran a quarter of a million iterations and smeared a megabyte over whatever
 * was in between.
 *
 * The tie-break is USE, and only one use is decisive. Under a RELATIONAL
 * operator the literal is a bound, and a bound is a bound on something: when the
 * other operand provably walks A — traced from the bindings in the same function
 * back to a global, never guessed — and `A.address + A.size` is exactly the
 * literal, the literal is A's end and is emitted as one. Everywhere else,
 * including a comparison whose other operand cannot be traced or traces
 * somewhere else, rules 1-3 stand unchanged and the literal reads `&B`.
 *
 * `==` and `!=` are not bounds and are not touched. Neither is a walk over a RUN
 * of separate globals — `p = &gFirst; ... while (p < &gSixth)` — where no single
 * extent ends at the bound: that shape is equally broken by relocation, but the
 * repair is to type the run as one array in Ghidra, not to invent an extent here.
 *
 * ## Guards
 *
 * **The complement path needs the high bit.** Image addresses live around
 * 0x00400000-0x00900000, so `~address` always lands above 0xFF000000. Without
 * that floor every ordinary negative number in the tree becomes a complement
 * candidate, and `-1` starts resolving to whatever sits at address 0.
 *
 * **Every match is exact.** No nearest-symbol fallback, no fuzzy range, no
 * "closest preceding global". A literal that resolves to nothing stays a
 * literal; a wrong symbol is worse than an unresolved constant, because the
 * constant is at least visible as one.
 *
 * **A literal in an arithmetic context is NOT rewritten.** `base + 0x500100`,
 * `flags & 0x500100`, `n * 0x500100` — the pass reverts its own replacement the
 * way `func-ptr-literal` does. The reasoning: a genuine folded address in
 * arithmetic does exist (`*(int*)(0x708364 + i * 4)`), but so do masks, sizes
 * and scale factors that happen to collide with an address, and there is no
 * local evidence to tell them apart. Getting a real address wrong costs a wild
 * store; leaving one unresolved costs a compile-visible constant that the
 * hardcoded-address census still counts. The cheap failure is the one to take.
 *
 * A negation is the one arithmetic shape the pass DOES claim, because it is not
 * arithmetic on an address at all: the emitter's `-7373669` is how a
 * top-bit-set word prints, not a subtraction anyone wrote.
 *
 * **A compound assignment is arithmetic.** `x |= 0x800000` reads an operand,
 * combines it and stores the result, which is the binary operator with the store
 * folded in; `0x800000` there is a flag bit that happens to collide with a
 * global's base. It is a different AST node (`AssignExpr`) from the binary
 * operators, so it needs its own revert. Plain `=` is deliberately NOT in that
 * set: an address assigned into a slot is exactly the case the pass exists for.
 *
 * **A pointer form in an integer RETURN is cast, never withdrawn.** `&name` and
 * `(char*)&name + n` are pointer-typed; `~(uintptr_t)<form>` is not, which is
 * why the Storm anchors survive being assigned into an `int32_t` field. A
 * `return &name` from `uint32_t SFILE_GetGlobalPointer()` does not compile — but
 * the answer is the spelling, not the retreat:
 *
 *     return gbSystemInfoInitialized
 *         ? (uint32_t)(uintptr_t)&gbSystemInfoInitialized : 0;
 *
 * That function really does return a pointer carried in an integer, and
 * `GFX_InitCelDataCache` reads `*(int*)(SFILE_GetGlobalPointer() + 0xc)` through
 * it. Withdrawing the match put the absolute `0x74d88c` back, which the linker
 * does not move, and the read faulted at 0x0074D898 — the 1.14d address plus
 * twelve. An address that resolved to an EXACT symbol is that symbol; the
 * return type's width is a spelling problem, and `(T)(uintptr_t)&name` is the
 * spelling the globals emitter already writes for an address in an integer slot.
 *
 * The return value is the one context whose type the body's AST cannot show —
 * the body is parsed inside a wrapper — so the caller supplies the return type.
 * With no type, a pointer type, or a type no cast can be spelled with, nothing
 * is judged and the bare form stands.
 *
 * A call ARGUMENT is the opposite case and keeps its withdrawal, for a reason
 * that does not apply here: a parameter's type is invisible from the body, so
 * `__allmul(..., 0x989680, 0)` carries no evidence that the slot wants an
 * address at all. A return type is evidence, and it says WIDTH, not "not an
 * address".
 */

import { NodeKind } from '../../../ast/kinds.js';
import { Expr, Type } from '../../../ast/factory.js';
import { traverseAST } from '../../../ast/visitor.js';
import type {
  ASTNode,
  AssignExpr,
  BinaryExpr,
  CStyleCastExpr,
  CallExpr,
  CommaExpr,
  ConditionalExpr,
  Expression,
  Identifier,
  IntegerLiteralExpr,
  MemberExpr,
  ParenExpr,
  QualifiedId,
  ReturnStmt,
  SubscriptExpr,
  UnaryExpr,
  VariableDecl,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// Operators where an integer literal is a numeric operand, not an address
const ARITHMETIC_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);

/**
 * The operators that make a literal a BOUND rather than an identity.
 *
 * `==` and `!=` are deliberately absent: testing a pointer against an object's
 * address is the ordinary reading of that address, and the one-past-the-end
 * rule below has no business rewriting it. A `<` is different — it is the
 * termination test of a walk, and what terminates a walk over A is the end of A.
 */
const RELATIONAL_OPS = new Set(['<', '<=', '>', '>=']);

/**
 * How far from A's edge a bound may sit when A's element stride is unknown.
 *
 * What makes a bound miss A's edge at all is the FIELD OFFSET the cursor walks
 * at: a walk over `a[i].field` runs from `&a[0].field` to `&a[N].field`, so its
 * bound misses A's base or A's end by that offset, which is always less than
 * one element. The stride is therefore the exact window, and it is known
 * wherever Ghidra typed the global as an array — see `Candidate.elementSize`.
 *
 * This is only the fallback for the globals it did not. One 32-bit pointer pair:
 * wider starts admitting bounds that belong to the next object, narrower misses
 * the ordinary field-at-offset-4 walk. A bound outside the window is not this
 * shape and is left exactly as it was.
 */
const EDGE_SLACK = 8;

/**
 * The same reasoning as `ARITHMETIC_OPS`, one node kind over.
 *
 * `x |= 0x800000` is the binary operator with its store folded in, so its right
 * operand is as likely a mask, a size or a flag bit as it is an address — and it
 * parses to `AssignExpr`, which `visitBinaryExpr` never sees. Plain `=` is
 * excluded on purpose: that is the assignment of an address to a slot, the case
 * the pass was written for.
 */
const COMPOUND_ASSIGN_OPS = new Set([
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=',
]);

/** `~address` of a 32-bit image address always lands above this. */
const COMPLEMENT_FLOOR = 0xff000000;

const WORD = 0x100000000;

/**
 * The floor of last resort: a Win32 process reserves the first 64KB and never
 * maps an image there, so nothing real can live below it.
 *
 * Ghidra manufactures a data symbol wherever it sees a reference it cannot
 * resolve, so the symbol table carries `DAT_00000000`, `DAT_00000001`,
 * `DAT_00000004` and dozens more at single-digit addresses — the residue of
 * `[reg + 4]` style operands, not objects. Admitting them makes every `0`, `1`
 * and `2` in the program an address: the first run of this pass rewrote
 * `pdwParam[1]` to `pdwParam[&DAT_00000001]` and failed 394 of 505 files.
 *
 * This is only the fallback. THE FLOOR IS THE IMAGE BASE — see
 * `effectiveAddressFloor`. 64KB is a platform truth but a weak one: `0x30000`
 * clears it and is still a byte count, not an address, because this image is
 * mapped at 0x400000 and Ghidra has a placeholder `DAT_00030000` sitting where
 * nothing is loaded. `memcpy(&gPaletteAct1, src, 0x30000)` came out of the tree
 * as `memcpy(&gPaletteAct1, src, &DAT_00030000)`.
 */
const ADDRESS_FLOOR = 0x10000;

/**
 * The image base as the candidate floor, or null when the caller gave none.
 *
 * Ghidra reports it as hex, sometimes bare (`"00400000"`) and sometimes prefixed
 * (`"0x400000"`); a bare string read as decimal would be off by orders of
 * magnitude, so it is ALWAYS base 16. A caller that has already parsed it may
 * pass the number.
 *
 * An unusable value returns null rather than throwing: the pass then runs on the
 * 64KB fallback, which is what it did before the base was plumbed through. A
 * degraded floor costs unresolved constants; a dead pass costs the anchors.
 */
function parseImageBase(raw: string | number | undefined): number | null {
  const value = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && /^\s*(0x)?[0-9a-f]+\s*$/i.test(raw)
      ? Number.parseInt(raw.trim().replace(/^0x/i, ''), 16)
      : NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value >= ADDRESS_CEILING) return null;
  return value;
}

/**
 * Where this image is actually mapped, never below the platform reserve.
 *
 * The base raises the floor; it may not lower it below 64KB. A base that small
 * would not be one — and readmitting `DAT_00000001` is the failure that cost 394
 * files, whereas a floor a little too high only leaves a constant unresolved,
 * which is the cheap failure this pass takes everywhere else.
 */
function effectiveAddressFloor(imageBase: string | number | undefined): number {
  const base = parseImageBase(imageBase);
  return base === null ? ADDRESS_FLOOR : Math.max(base, ADDRESS_FLOOR);
}

/**
 * At or above this, an "address" is not one either.
 *
 * The same placeholder machinery runs at the other end: a small NEGATIVE offset
 * becomes a symbol near the top of the word, so the table also carries
 * `DAT_fffffffb` and `hWndInsertAfter_fffffffe`. Those turned `pDstExtra[-5]`
 * into `pDstExtra[&DAT_fffffffb]`.
 *
 * A 32-bit Win32 process maps its image in the low half of the address space;
 * everything from 0x80000000 up is kernel-reserved and never holds a global.
 *
 * This bounds the CANDIDATE addresses only. It does not constrain the literal
 * VALUES the pass inspects, which is what `COMPLEMENT_FLOOR` is for — a folded
 * `~address` legitimately lands above 0xFF000000 and must still be tried.
 */
const ADDRESS_CEILING = 0x80000000;

/**
 * The spelling to cast a pointer form to before returning it, or null to leave
 * the form exactly as it is.
 *
 * Null for a pointer or reference return — the bare `&name` is already right
 * there — for `void`, for a missing type, and for anything that is not a plain
 * type name (a template-id, a qualified name). Those the pass cannot spell a
 * cast with, and it does not withdraw instead: an unresolved symbol is a
 * compile error a human reads, while a restored absolute address is a fault at
 * runtime. `const`/`volatile` are dropped — they mean nothing on a prvalue and
 * only get in the cast's way.
 */
function integralReturnTarget(spelling: string | undefined): string | null {
  if (typeof spelling !== 'string') return null;
  if (spelling.includes('*') || spelling.includes('&')) return null;
  const bare = spelling
    .replace(/\b(?:const|volatile)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!bare || bare === 'void') return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?: [A-Za-z_][A-Za-z0-9_]*)*$/.test(bare)) return null;
  return bare;
}

interface Candidate {
  name: string;
  address: number;
  size: number;
  /**
   * The stride of one element, for a global Ghidra typed as an array — its
   * extent divided by its element count, so it is exact rather than inferred.
   *
   * Zero means the global is NOT a declared array: its type carried no `[N]`,
   * or the count did not divide the extent. That is a load-bearing distinction,
   * not a missing number. `p[4]` reaches a subobject of `p` where `p` is an
   * array and the POINTEE of `p` where it is a pointer, and only the first says
   * anything about `p`'s own storage.
   */
  elementSize: number;
  /** The namespace the DEFINITION is emitted in. Empty means root scope. */
  segments: readonly string[];
  /**
   * True when the object at this address is a STRING CONSTANT, declared
   * `char <name>[N]`. It changes the spelling, not the resolution — see
   * `anchoredAddress`.
   */
  stringConstant: boolean;
}

/** A resolved literal: the global it names and the byte offset into it. */
interface Anchor {
  name: string;
  segments: readonly string[];
  offset: number;
  stringConstant: boolean;
}

// ============================================
// RESOLUTION
// ============================================

/**
 * The global that owns unsigned address `v`, or null.
 *
 * Base-exact wins over interior. Either rule needs a UNIQUE owner: two globals
 * sharing a base, or two overlapping extents covering the same byte, both mean
 * the address does not identify one object and the literal stands.
 */
function ownerOf(v: number, candidates: readonly Candidate[]): Anchor | null {
  const owned = ownerOfAddress(v, candidates);
  return owned
    ? {
      name: owned.candidate.name,
      segments: owned.candidate.segments,
      offset: owned.offset,
      stringConstant: owned.candidate.stringConstant,
    }
    : null;
}

/** A global's extent, the only thing address ownership depends on. */
export interface AddressExtent {
  readonly address: number;
  readonly size: number;
}

/** Which extent owns an address, and how far into it the address sits. */
export interface AddressOwnership<C extends AddressExtent> {
  readonly candidate: C;
  readonly offset: number;
}

/**
 * The ownership rule itself, over anything carrying an extent.
 *
 * Exported because the decision "is this global safe to emit `static`?" has to
 * be made from the SAME rule, one phase earlier: a literal the pass will turn
 * into `&name` is a reference to `name`, and a scope analysis that cannot see it
 * promotes a symbol whose address is taken from another function or another
 * translation unit. Two implementations of this rule would disagree, and the
 * disagreement is a link error.
 */
export function ownerOfAddress<C extends AddressExtent>(
  v: number,
  candidates: readonly C[],
): AddressOwnership<C> | null {
  let base: C | undefined;
  let baseCount = 0;
  let interior: AddressOwnership<C> | null = null;
  let interiorCount = 0;

  for (const c of candidates) {
    if (c.address === v) {
      base = c;
      baseCount++;
      continue;
    }
    if (c.size > 0 && v > c.address && v < c.address + c.size) {
      interior = { candidate: c, offset: v - c.address };
      interiorCount++;
    }
  }

  if (baseCount === 1) return { candidate: base!, offset: 0 };
  if (baseCount > 1) return null;
  return interiorCount === 1 ? interior : null;
}

/** At or above this value, a literal may be a folded `~&global`. */
export const ADDRESS_LITERAL_COMPLEMENT_FLOOR = COMPLEMENT_FLOOR;

/** At or above this address, a Ghidra data symbol is not a real global. */
export const ADDRESS_LITERAL_CEILING = ADDRESS_CEILING;

/**
 * The candidate floor for this image — the image base, never below the 64KB
 * platform reserve. Shared so the scope analysis admits exactly the addresses
 * the pass admits; a floor that disagreed would either miss references (link
 * error) or count `DAT_00000001` as one (mass false demotion).
 */
export function addressLiteralFloor(imageBase: string | number | undefined): number {
  return effectiveAddressFloor(imageBase);
}

// ============================================
// EMISSION
// ============================================

/**
 * `&name`, or `((char*)&name + n)` for a non-zero offset — and for a STRING
 * CONSTANT, the bare `name` or `(name + n)`.
 *
 * A string constant is declared `char <name>[N]`, so the name already decays to
 * the `char*` every use of it wants. `&name` there is `char(*)[N]`, a different
 * type that converts to nothing — the same mistake `array-global-address-of`
 * exists to undo on Ghidra's `<base>_ARRAY_<hex>` globals, and one this pass
 * must not make in the first place: that plugin runs at priority 46, before this
 * one, so nothing would come along afterwards to clean it up.
 *
 * The interior form needs no `(char*)` either, for the same reason: pointer
 * arithmetic on a `char[N]` is already byte arithmetic.
 */
function anchoredAddress(anchor: Anchor): Expression {
  const designator = anchor.segments.length === 0
    ? Expr.identifier(anchor.name)
    : Expr.qualifiedId([...anchor.segments, anchor.name]);
  if (anchor.stringConstant) {
    if (anchor.offset === 0) return designator;
    return Expr.paren(Expr.binary(designator, '+', Expr.intLiteral(anchor.offset)));
  }
  const addressOf = Expr.unary('&', designator);
  if (anchor.offset === 0) return addressOf;
  const bytes = Expr.cast(Type.pointer(Type.char()), addressOf);
  return Expr.paren(Expr.binary(bytes, '+', Expr.intLiteral(anchor.offset)));
}

/** `~(uintptr_t)<form>` — the complement the decompiler folded away. */
function complemented(form: Expression): Expression {
  return Expr.unary('~', Expr.cast(Type.typedef('uintptr_t'), form));
}

/**
 * `(T)(uintptr_t)<form>` — a pointer form spelled at an integer slot's width.
 *
 * Through `uintptr_t` first so nothing narrows on the way. That is the same
 * two-step `initializerAddressSpelling` writes for an address stored in an
 * integer slot and `narrow-cast-through-uintptr` writes for a pointer read as a
 * byte; `(T)` alone is a narrowing pointer-to-integer cast the moment `T` is
 * smaller than a pointer, which C++ rejects outright.
 */
function widthSpelled(target: string, form: Expression): Expression {
  return Expr.cast(Type.typedef(target), Expr.cast(Type.typedef('uintptr_t'), form));
}

/**
 * A bound at the EDGE of `anchor`, `k` bytes from its base.
 *
 * Two anchorings, chosen by which edge `k` is at:
 *
 *  - below the end — `((char*)&a + k)`, or `((char*)&a - k)` for a bound just
 *    under the base, which is how the decompiler folds `p >= &a[0].field` into
 *    `&a - 1 < p`;
 *  - at or past the end — `((char*)&a + sizeof(a))`, plus the field
 *    displacement past it where there is one.
 *
 * **Why `sizeof` and not the byte count the extraction reports.** The extent is
 * what PROVES the literal is at A's edge; it is not what the bound should be
 * SPELLED as. A literal count is a second, independent statement of A's size,
 * and if the declaration this tree emits for A disagrees with it — a lost array
 * dimension is exactly the shape of that failure — the count walks off the end
 * of the object and the smear this rule exists to stop comes back in a smaller
 * form. `sizeof(a)` cannot: whatever A is declared as, the bound is A's own
 * storage plus a field offset, so the loop is either right or short, never
 * wild. A short loop is a visible functional bug; an over-long one corrupts
 * whatever the linker put next.
 *
 * A bound below the end takes no `sizeof`: it is measured from the base, which
 * no declaration can move.
 */
function edgeOfExtent(anchor: Candidate, k: number): Expression {
  const designator = (): Expression => (anchor.segments.length === 0
    ? Expr.identifier(anchor.name)
    : Expr.qualifiedId([...anchor.segments, anchor.name]));
  const base = anchor.stringConstant
    ? designator()
    : Expr.cast(Type.pointer(Type.char()), Expr.unary('&', designator()));

  const displaced = (from: Expression, delta: number): Expression => (delta === 0
    ? from
    : Expr.binary(from, delta > 0 ? '+' : '-', Expr.intLiteral(Math.abs(delta))));

  // Below the end the base is the fixed point; at or past it, the declaration is.
  const form = anchor.size > 0 && k >= anchor.size
    ? displaced(Expr.binary(base, '+', Expr.sizeof(designator(), false)), k - anchor.size)
    : displaced(base, k);
  return Expr.paren(form);
}

// ============================================
// TRANSFORMER
// ============================================

/**
 * Calls whose argument is a RETURN VALUE, not an argument.
 *
 * `Fog::Debug::GuardStack` is the MSVC `/GS` epilogue: it checks the stack
 * cookie and passes EAX straight through, so `return GuardStack(x)` is how every
 * cookie-using function in this binary returns `x`. The value in that slot is
 * therefore typed by the CALLER's return type, not by a parameter, and a
 * function returning a pointer through it is exactly the case this pass exists
 * to resolve.
 *
 * Withdrawing pointer forms there put an absolute image address back into
 * `NET_GetLocalIp`, which returns `cp_0075d040`; the caller printed it as `%s`
 * and faulted reading 0x0075D040.
 *
 * This is a claim about one function's semantics, not a guess about a name — the
 * pass-through is documented at the definition and is why `d2_hand.h` implements
 * `GuardStack` as an identity.
 */
const RETURN_VALUE_CARRIERS = new Set(['GuardStack']);

function isReturnValueCarrier(callee: Expression): boolean {
  if (callee.kind === NodeKind.Identifier) {
    return RETURN_VALUE_CARRIERS.has((callee as { name: string }).name);
  }
  if (callee.kind === NodeKind.QualifiedId) {
    // The trailing name is `name`, not the last element of `qualifier` — the
    // qualifier holds only the `ns::nested::` part.
    const tail = (callee as QualifiedId).name;
    if (tail.kind !== NodeKind.Identifier) return false;
    return RETURN_VALUE_CARRIERS.has((tail as Identifier).name);
  }
  return false;
}

function createGlobalAddressLiteralTransformer(
  options: GlobalAddressLiteralOptions,
): Transformer {
  const addresses = options.globalAddresses ?? {};
  const sizes = options.globalSizes ?? {};
  const namespaces = options.globalNamespaces ?? {};
  const elementSizes = options.globalElementSizes ?? {};
  const stringConstants = new Set(options.stringConstantNames ?? []);
  const floor = effectiveAddressFloor(options.imageBase);
  const returnTarget = integralReturnTarget(options.enclosingReturnType);

  const candidates: Candidate[] = [];
  for (const [name, address] of Object.entries(addresses)) {
    if (!Number.isSafeInteger(address) || address < floor || address >= ADDRESS_CEILING) {
      continue;
    }
    const size = sizes[name];
    const stride = elementSizes[name];
    candidates.push({
      name,
      address,
      size: Number.isSafeInteger(size) && size! > 0 ? size! : 0,
      elementSize: Number.isSafeInteger(stride) && stride! > 0 ? stride! : 0,
      segments: namespaces[name] ?? [],
      stringConstant: stringConstants.has(name),
    });
  }
  if (candidates.length === 0) return createTransformer({});

  /** By emitted name, for the derivation scan below. */
  const byName = new Map<string, Candidate>();
  for (const c of candidates) {
    if (!byName.has(c.name)) byName.set(c.name, c);
  }

  // ============================================
  // WHERE A POINTER CAME FROM
  // ============================================

  /**
   * What an expression ultimately designates: a global, a local variable, or
   * nothing this pass can name.
   *
   * The walk sees through the conversions that do not change WHICH object is
   * being pointed at — parens, casts, `&`, unary `+`, and pointer displacement
   * by `+`/`-`. It stops at everything that does: a dereference, a subscript, a
   * member access, a call. `*p` is a different object from `p`, and treating it
   * as the same would let a load through an unrelated pointer stand in as
   * evidence about A's extent.
   */
  type Root =
    | { readonly kind: 'global'; readonly candidate: Candidate }
    | { readonly kind: 'variable'; readonly name: string }
    | null;

  function namedRoot(name: string): Root {
    const global = byName.get(name);
    return global ? { kind: 'global', candidate: global } : { kind: 'variable', name };
  }

  function rootOf(expr: Expression | null | undefined): Root {
    if (!expr) return null;
    switch (expr.kind) {
      case NodeKind.ParenExpr:
        return rootOf((expr as ParenExpr).expression);
      case NodeKind.CStyleCastExpr:
        return rootOf((expr as CStyleCastExpr).expression);
      case NodeKind.UnaryExpr: {
        const unary = expr as UnaryExpr;
        // `&a` and `+a` designate `a`; `*a` and the increments do not.
        if (unary.operator === '&' || unary.operator === '+') return rootOf(unary.operand);
        return null;
      }
      case NodeKind.Identifier:
        return namedRoot((expr as Identifier).name);
      case NodeKind.QualifiedId: {
        const tail = (expr as QualifiedId).name;
        return tail.kind === NodeKind.Identifier
          ? namedRoot((tail as Identifier).name)
          : null;
      }
      case NodeKind.IntegerLiteral: {
        // Ownership, not just the base: a walk that starts at a FIELD of the
        // first element starts at an interior address, and that address names
        // the object it is inside by exactly the rule the pass resolves every
        // other literal with.
        const literal = expr as IntegerLiteralExpr;
        if (literal.value < 0n || literal.value >= BigInt(WORD)) return null;
        const owner = ownerOfAddress(Number(literal.value), candidates);
        return owner ? { kind: 'global', candidate: owner.candidate } : null;
      }
      case NodeKind.BinaryExpr: {
        const binary = expr as BinaryExpr;
        // Displacement keeps the object; anything else is a new value.
        if (binary.operator !== '+' && binary.operator !== '-') return null;
        const left = rootOf(binary.left);
        if (left) return left;
        return binary.operator === '+' ? rootOf(binary.right) : null;
      }
      case NodeKind.SubscriptExpr: {
        // `a[i]` is a subobject of `a` only where `a` is an ARRAY. On a pointer
        // it is the pointee — somebody else's storage entirely — and a bound
        // placed at the pointer variable's own edge would be nonsense. A local
        // is never admitted either: nothing here says which of the two it is.
        const root = rootOf((expr as SubscriptExpr).array);
        if (!root || root.kind !== 'global') return null;
        return root.candidate.elementSize > 0 ? root : null;
      }
      case NodeKind.MemberExpr: {
        // `.field` names a subobject; `->field` follows a pointer out of one.
        const member = expr as MemberExpr;
        return member.isArrow ? null : rootOf(member.object);
      }
      default:
        return null;
    }
  }

  /**
   * What each local was last known to have come from, over the whole unit this
   * transformer was handed — which is one function.
   *
   * `origin` is the single global every binding of the name traced back to;
   * `poisoned` records that they did not all agree, or that one of them was
   * something this pass cannot follow. Only an unpoisoned name with an origin
   * is evidence, so every uncertainty collapses to "no answer" rather than to a
   * guess.
   *
   * A name assigned FROM ITSELF is not a rebinding: `pRow = pRow + 1` is the
   * walk, and it is the shape the whole rule is about. Compound assignment and
   * the increments are the same statement written shorter and are ignored for
   * the same reason. Taking a name's ADDRESS poisons it: `Init(&pRow)` can
   * store anything into it, and the scan does not follow callees.
   */
  interface Origin {
    candidate: Candidate | null;
    poisoned: boolean;
  }
  const origins = new Map<string, Origin>();

  function originOf(name: string): Origin {
    let origin = origins.get(name);
    if (!origin) {
      origin = { candidate: null, poisoned: false };
      origins.set(name, origin);
    }
    return origin;
  }

  function noteBinding(name: string, source: Root): void {
    const origin = originOf(name);
    if (origin.poisoned) return;
    if (source && source.kind === 'variable' && source.name === name) return;
    if (source && source.kind === 'global') {
      if (origin.candidate && origin.candidate !== source.candidate) {
        origin.poisoned = true;
        return;
      }
      origin.candidate = source.candidate;
      return;
    }
    origin.poisoned = true;
  }

  /** The bare name a binding target designates, or null if it is not a name. */
  function boundName(target: Expression): string | null {
    const root = rootOf(target);
    return root && root.kind === 'variable' ? root.name : null;
  }

  function scanOrigins(unit: ASTNode): void {
    origins.clear();
    for (const node of traverseAST(unit)) {
      if (node.kind === NodeKind.VariableDecl) {
        const decl = node as VariableDecl;
        if (decl.initializer && decl.initializer.kind !== NodeKind.InitListExpr) {
          noteBinding(decl.name.name, rootOf(decl.initializer as Expression));
        }
        continue;
      }
      if (node.kind === NodeKind.AssignExpr) {
        const assign = node as AssignExpr;
        // A compound assignment displaces; only `=` rebinds.
        if (assign.operator !== '=') continue;
        const name = boundName(assign.left);
        if (name) noteBinding(name, rootOf(assign.right));
        continue;
      }
      if (node.kind === NodeKind.UnaryExpr) {
        const unary = node as UnaryExpr;
        if (unary.operator !== '&') continue;
        const name = boundName(unary.operand);
        if (name) originOf(name).poisoned = true;
      }
    }
  }

  /** The global a compared operand provably walks, or null. */
  function walkedGlobal(expr: Expression): Candidate | null {
    const root = rootOf(expr);
    if (!root) return null;
    if (root.kind === 'global') return root.candidate;
    const origin = origins.get(root.name);
    return origin && !origin.poisoned ? origin.candidate : null;
  }

  /**
   * The edge-of-A reading of one side of a comparison, or null to leave it as
   * it is.
   *
   * The other operand PROVABLY walking A is what makes A known rather than
   * guessed, and nothing here relaxes it. What it widens is the offset. A
   * cursor that walks A at field offset `d` runs from `A.address + d` to
   * `A.address + A.size + d`, so a bound belonging to A sits at `A.address + k`
   * for a `k` within one element of either edge: below the base for a
   * descending walk, past the end for an ascending one. The two differ only in
   * which way the operator points, and neither the rule nor the spelling has to
   * know which — the offset says everything.
   *
   * `k === 0` is excluded. A bound at A's own base is `&A`, which rule 1
   * already spells, and overriding it here would only make the same address
   * read worse.
   *
   * A `k` strictly inside A is rule 2's interior form already and this agrees
   * with it; where A's extent is unknown it reaches an interior bound rule 2
   * cannot.
   */
  function edgeReading(side: ASTNode, other: Expression): Expression | null {
    const literal = literalBehind(side);
    if (!literal) return null;
    if (literal.value < 0n || literal.value >= BigInt(WORD)) return null;

    const walked = walkedGlobal(other);
    if (!walked) return null;

    const k = Number(literal.value) - walked.address;
    if (k === 0) return null;

    // The exact window where the stride is known, one pointer pair where it is
    // not. Further out than one element is not a field offset, and a literal
    // that far from A is not this shape.
    const slack = walked.elementSize > 0 ? walked.elementSize : EDGE_SLACK;
    const nearBase = k > -slack && k < slack;
    const pastEnd = walked.size > 0 && k >= walked.size && k < walked.size + slack;
    if (!nearBase && !pastEnd) return null;

    return edgeOfExtent(walked, k);
  }

  /**
   * Every replacement this pass produced, against the node it came from — the
   * same bookkeeping `func-ptr-literal` uses. `transformAST` hands the visitor's
   * own object to the parent, so a parent that turns out to be arithmetic
   * recognises the identical node and can put the original back.
   */
  const produced = new Map<ASTNode, ASTNode>();

  /**
   * The subset of `produced` whose replacement is POINTER-typed — `&name` and
   * `(char*)&name + n`. The complement form is not in here: `~(uintptr_t)...` is
   * an integer expression, and the anchor initialisers that assign it into an
   * `int32_t` field depend on its staying one.
   */
  const pointerForms = new Set<ASTNode>();

  /** The literal `v`, or its complement, spelled through whichever global owns it. */
  function resolve(v: number): { form: Expression; pointer: boolean } | null {
    const direct = ownerOf(v, candidates);
    if (direct) return { form: anchoredAddress(direct), pointer: true };
    if (v < COMPLEMENT_FLOOR) return null;
    const flipped = ownerOf((~v) >>> 0, candidates);
    return flipped
      ? { form: complemented(anchoredAddress(flipped)), pointer: false }
      : null;
  }

  /** Carry the original node's trivia onto the replacement that stands in for it. */
  function replacing(original: ASTNode, replacement: Expression): ASTNode {
    return {
      ...replacement,
      location: original.location,
      leadingTrivia: original.leadingTrivia ?? [],
      trailingTrivia: original.trailingTrivia ?? [],
    } as ASTNode;
  }

  /** The literal behind a child, seeing through a replacement this pass made. */
  function literalBehind(node: ASTNode): IntegerLiteralExpr | null {
    const original = produced.get(node) ?? node;
    return original.kind === NodeKind.IntegerLiteral
      ? (original as IntegerLiteralExpr)
      : null;
  }

  /** Restore whichever of a two-operand node's operands this pass replaced. */
  function withOperandsRestored<N extends { left: Expression; right: Expression }>(
    node: N,
  ): N | undefined {
    const left = produced.get(node.left);
    const right = produced.get(node.right);
    if (!left && !right) return undefined;
    return {
      ...node,
      left: (left ?? node.left) as Expression,
      right: (right ?? node.right) as Expression,
    };
  }

  /**
   * The value positions of `expr` — where a subexpression IS the value the whole
   * expression yields, so its type has to be the type the context demands. A
   * ternary hands over both its branches; a comma its last operand; a paren its
   * contents. A cast is where the walk stops: the cast is itself the conversion,
   * so a pointer form under one is already legal.
   */
  function mapPointerForms(
    expr: Expression,
    respell: (form: Expression) => Expression | null,
  ): Expression | null {
    if (pointerForms.has(expr)) return respell(expr);

    switch (expr.kind) {
      case NodeKind.ParenExpr: {
        const paren = expr as ParenExpr;
        const inner = mapPointerForms(paren.expression, respell);
        return inner ? { ...paren, expression: inner } : null;
      }
      case NodeKind.ConditionalExpr: {
        const cond = expr as ConditionalExpr;
        const then = mapPointerForms(cond.thenExpr, respell);
        const other = mapPointerForms(cond.elseExpr, respell);
        if (!then && !other) return null;
        return { ...cond, thenExpr: then ?? cond.thenExpr, elseExpr: other ?? cond.elseExpr };
      }
      case NodeKind.CommaExpr: {
        const comma = expr as CommaExpr;
        const last = comma.expressions[comma.expressions.length - 1];
        if (!last) return null;
        const mapped = mapPointerForms(last, respell);
        if (!mapped) return null;
        return {
          ...comma,
          expressions: [...comma.expressions.slice(0, -1), mapped],
        };
      }
      default:
        return null;
    }
  }

  /** Put the literal back wherever this pass wrote a pointer form. */
  function restorePointerForms(expr: Expression): Expression | null {
    return mapPointerForms(expr, form => (produced.get(form) ?? null) as Expression | null);
  }

  const transform = createTransformer({
    // Bottom-up: a literal is visited before the expression that contains it.
    visitNode(node: ASTNode) {
      // `x |= 0x800000` is arithmetic with a store folded in, but it is an
      // AssignExpr, so `visitBinaryExpr` never sees it. There is no
      // `visitAssignExpr` on the visitor either — the catch-all is where the
      // kind arrives.
      if (node.kind === NodeKind.AssignExpr) {
        const assign = node as AssignExpr;
        if (!COMPOUND_ASSIGN_OPS.has(assign.operator)) return undefined;
        return withOperandsRestored(assign);
      }

      if (node.kind !== NodeKind.IntegerLiteral) return undefined;

      const literal = node as IntegerLiteralExpr;
      if (literal.value < 0n || literal.value >= BigInt(WORD)) return undefined;

      const resolved = resolve(Number(literal.value));
      if (!resolved) return undefined;

      const ref = replacing(literal, resolved.form);
      produced.set(ref, literal);
      if (resolved.pointer) pointerForms.add(ref);
      return ref;
    },

    // The return value's type is the one fact a body parsed on its own cannot
    // show, so the caller states it. `&name` and `(char*)&name + n` are pointers
    // and do not convert to a `uint32_t` return, so they are spelled at that
    // width — NOT withdrawn: the function returns a pointer carried in an
    // integer, and the literal put back is an address the linker will not move.
    // `~(uintptr_t)...` is already an integer and is left as it is.
    visitReturnStmt(node: ReturnStmt) {
      if (!returnTarget || !node.value) return undefined;
      const spelled = mapPointerForms(node.value, form => widthSpelled(returnTarget, form));
      return spelled ? { ...node, value: spelled } : undefined;
    },

    // `-7373669` is one folded word, not a subtraction: reduce the negation and
    // the literal together, and undo any match the bare magnitude made on its own
    // (0x707C25 is as plausible an image address as 0xFF8F7C9B is).
    visitUnaryExpr(node: UnaryExpr) {
      if (node.operator !== '-') return undefined;

      const literal = literalBehind(node.operand);
      if (!literal) return undefined;
      if (literal.value <= 0n || literal.value > BigInt(WORD)) return undefined;

      const restored: UnaryExpr = { ...node, operand: literal };
      const resolved = resolve((WORD - Number(literal.value)) >>> 0);
      if (!resolved) {
        // No match for the negated word — put back whatever the magnitude alone
        // matched, so the number reads as the number it is.
        return produced.has(node.operand) ? restored : undefined;
      }

      const ref = replacing(node, resolved.form);
      produced.set(ref, restored);
      if (resolved.pointer) pointerForms.add(ref);
      return ref;
    },

    // A parameter's type is not visible from a body parsed on its own, so an
    // argument slot says nothing about whether the value there is an address.
    // `__allmul(nUnixTime + 0xb6109100, ..., 0x989680, 0)` — the FILETIME
    // conversion's 10,000,000 — sits exactly where `gnCurrentTimestamp` does,
    // and came out of the tree as `&gnCurrentTimestamp` in a `uint32_t` slot.
    // Same evidence, same verdict as an arithmetic operand: the literal stands.
    //
    // Only the POINTER forms are withdrawn. `~(uintptr_t)...` is an integer
    // expression by construction, and passing one is no different from passing
    // any other computed word.
    visitCallExpr(node: CallExpr) {
      if (isReturnValueCarrier(node.callee)) return undefined;
      let changed = false;
      const args = node.arguments.map(arg => {
        const restored = restorePointerForms(arg);
        if (!restored) return arg;
        changed = true;
        return restored;
      });
      return changed ? { ...node, arguments: args } : undefined;
    },

    // An address in arithmetic is indistinguishable from a mask or a scale
    // factor, so a replacement under an arithmetic operator is withdrawn.
    //
    // A relational operator is the other case entirely: there the literal is a
    // BOUND, and a bound one past the end of the object the other operand walks
    // is that object's end, not the next object's base — the two are the same
    // byte in the image and different objects once the linker has placed them.
    visitBinaryExpr(node: BinaryExpr) {
      if (ARITHMETIC_OPS.has(node.operator)) return withOperandsRestored(node);
      if (!RELATIONAL_OPS.has(node.operator)) return undefined;

      const right = edgeReading(node.right, node.left);
      if (right) {
        const form = replacing(node.right, right) as Expression;
        produced.set(form, produced.get(node.right) ?? node.right);
        return { ...node, right: form };
      }
      const left = edgeReading(node.left, node.right);
      if (left) {
        const form = replacing(node.left, left) as Expression;
        produced.set(form, produced.get(node.left) ?? node.left);
        return { ...node, left: form };
      }
      return undefined;
    },
  });

  // The origins have to be read while the comparison is being visited, and the
  // visitor is bottom-up, so they are collected in one pass over the ORIGINAL
  // tree before the transform runs — before this pass has rewritten any of the
  // literals the scan itself resolves.
  return (unit: ASTNode) => {
    scanOrigins(unit);
    return transform(unit);
  };
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface GlobalAddressLiteralOptions extends PluginOptions {
  /** Global variable name (as emitted) → its address in the image. */
  globalAddresses?: Record<string, number>;
  /**
   * Global variable name (as emitted) → its size in bytes, as the extraction
   * reports it. A name absent here resolves only on its exact base: without a
   * real extent there is no interior to point into, and inferring one from the
   * distance to the next symbol would invent storage the global does not own.
   */
  globalSizes?: Record<string, number>;
  /**
   * Global variable name (as emitted) → the namespace segments its DEFINITION is
   * emitted in. Absent or empty means root scope, and the reference is the bare
   * name — which is also what a name this table does not carry gets.
   *
   * The same fact `func-ptr-literal` carries on `FuncPtrTarget`, for the same
   * reason: a global's address is taken from anywhere, and a bare name only
   * resolves where the definition happens to be in scope. The segments arrive
   * already resolved; this pass renders a qualifier, it never decides one.
   */
  globalNamespaces?: Record<string, readonly string[]>;
  /**
   * Global variable name (as emitted) → the stride of ONE ELEMENT, for a global
   * Ghidra typed as an array: its extent divided by its element count.
   *
   * Exact, not inferred — both numbers come from the same Ghidra record — and
   * its ABSENCE is information too: a name missing here is not a declared
   * array, which is what stops a subscript on a POINTER global from being read
   * as a walk over the pointer's own four bytes.
   */
  globalElementSizes?: Record<string, number>;
  /**
   * The subset of `globalAddresses` whose objects are STRING CONSTANTS —
   * declared `char <name>[N]`, defined from the bytes Ghidra read.
   *
   * Ghidra types a string label `string`, which is not a C type, so the globals
   * extraction drops it and no `globals` record for it ever exists; the address
   * table therefore has to be told which of its entries are strings, because the
   * only thing that changes is the SPELLING of the reference. Everything else —
   * the floor, the ceiling, the uniqueness rule, the arithmetic withdrawal — is
   * identical to any other candidate.
   *
   * A name here that `globalAddresses` does not carry is ignored: the table is
   * what admits an address, and this only classifies what it admitted.
   */
  stringConstantNames?: readonly string[];
  /**
   * Where the program is mapped, as Ghidra's `ProgramInfo.imageBase` reports it
   * — hex, with or without an `0x` prefix, or already parsed to a number.
   *
   * This is the candidate floor. A symbol below the base is not a global: it is
   * a Ghidra placeholder standing where a reference could not be resolved, and
   * the literal that "matches" it is a size or a count. Absent or unparseable,
   * the pass falls back to the 64KB platform reserve and still runs.
   */
  imageBase?: string | number;
  /**
   * The enclosing function's return type, spelled the way its emitted definition
   * spells it.
   *
   * The body is parsed inside a wrapper, so at the point a `return` is visited
   * the AST cannot show the return type; the caller has it. A pointer form
   * returned from a function declared to return an integer is spelled
   * `(T)(uintptr_t)&name` rather than put back as a literal — the symbol is the
   * value either way, and only its width was ever in question. A pointer return,
   * `void`, a type no cast can be spelled with, or no type at all: nothing is
   * judged and the bare form stands.
   */
  enclosingReturnType?: string;
}

export const globalAddressLiteralPlugin: TransformPlugin = {
  id: 'global-address-literal',
  name: 'Global Address Literal Resolution',
  description:
    'Resolve integer literals that are a global\'s address — including the ~&global form Ghidra folds into one constant — into a reference to the global, so the value survives relocation',
  version: '1.0.0',
  defaultEnabled: true,
  // Alongside `func-ptr-literal` (69), and for the same reason: after
  // `signed-literal` (30) has settled how a top-bit-set word is spelled, and
  // before the cast passes at 70+, which can only recognise a designator.
  priority: 68,
  tags: ['core', 'cleanup', 'correctness'],

  createTransformer(options?: GlobalAddressLiteralOptions) {
    return createGlobalAddressLiteralTransformer(options ?? {});
  },
};
