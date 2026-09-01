/**
 * The all-ones sentinel: one place decides whether a data value that is every
 * bit set means -1, and how to spell it.
 *
 * D2 uses -1 as "none / invalid" throughout. Ghidra prints that value against
 * the DECLARED TYPE of the slot it found it in: a signed field decompiles as
 * `-1`, an unsigned or pointer field as `0xffffffff`. Both spellings are the
 * same 32 bits today. They stop being the same object the moment the slot is
 * wider than 32 bits:
 *
 *     void *p = (void*)0xffffffff;   // 64-bit: 0x00000000FFFFFFFF, not -1
 *     void *p = (void*)-1;           // 64-bit: 0xFFFFFFFFFFFFFFFF
 *
 * Every `p == (void*)-1` test against the first spelling silently stops
 * matching. So this is a latent 64-bit defect, not a compile error, and the fix
 * belongs where the slot type is known rather than where the text is written.
 *
 * WHY THIS LIVES IN THE DATA-INITIALIZER PATH AND NOT IN A TRANSFORM PASS
 *
 * In a decompiled expression a literal's own type takes part in the usual
 * arithmetic conversions, so re-spelling it can change the result:
 * `x & 0xffffffff` and `x & -1` differ when `x` is 64-bit. `signed-literal`
 * (packages/cpp-parser) handles that lane and guards itself with the explicit
 * `u` suffix that `concat-transform` writes for exactly this reason.
 *
 * An INITIALIZER is different in kind. The slot has a declared type, so its
 * width is fixed by the declaration and not by the literal. Re-spelling an
 * all-ones value as -1 in a fixed-width SIGNED slot is therefore provably
 * value-preserving - same width, same two's-complement bits, same object. The
 * only case where the stored value changes is the pointer-shaped slot, which is
 * precisely the case that is wrong today.
 *
 * WHAT IS DELIBERATELY REFUSED
 *
 * Not every all-ones value is a sentinel, and the discriminator is the slot's
 * type, never the value:
 *
 * - UNSIGNED integer slots keep their bit pattern. `uint32_t` is 32 bits at any
 *   target, so there is no 64-bit defect to fix, and this is where the masks,
 *   the 0xFFFFFFFF colours, the TLS_OUT_OF_INDEXES and the raw byte blobs live.
 *   In this tree that refusal covers 2,582 `byte` slots holding 0xff - binary
 *   data where the byte is a byte. Rewriting those would be a catastrophe, and
 *   it is the reason the rule keys on signedness rather than on the pattern.
 * - UNSIGNED POINTER-WIDTH slots (`size_t`, `ULONG_PTR`, `WPARAM`) are refused
 *   too, even though they DO carry a real 64-bit defect. A 4-byte binary field
 *   typed `size_t` changes the struct's stride when rebuilt at 64-bit; that is
 *   a layout bug and the type is what is wrong. Papering it over with `SIZE_MAX`
 *   would hide it. Those belong in the Ghidra type work order.
 * - An UNKNOWN slot type is refused. No type, no rewrite.
 *
 * WIDTH
 *
 * The rule is not 32-bit-only, and must not be: `0xffff` in an `int16_t` is the
 * same argument one size down and `0xff` in an `int8_t` again. It generalises
 * because the width is taken from the DECLARED TYPE and the value has to be all
 * ones for exactly that width. `undefined4` holding 0xff is 255, not -1, and is
 * left alone; `int` holding 0xff likewise. Plain `char` is excluded outright -
 * its signedness is implementation-defined and a `char` slot is where raw bytes
 * live.
 */

/** Signed integer slot spellings, by width in bytes. */
const SIGNED_WIDTHS = new Map<string, number>([
  ['int8_t', 1], ['sbyte', 1], ['signed char', 1],
  ['int16_t', 2], ['short', 2], ['short int', 2], ['signed short', 2], ['sword', 2], ['SHORT', 2],
  ['int', 4], ['int32_t', 4], ['signed int', 4], ['long', 4], ['long int', 4], ['sdword', 4],
  ['INT', 4], ['LONG', 4], ['BOOL', 4], ['HRESULT', 4],
  ['int64_t', 8], ['longlong', 8], ['long long', 8], ['sqword', 8], ['LONGLONG', 8],
]);

/**
 * Signed POINTER-WIDTH integers. `-1` is the right spelling at every target
 * width for these, which is the whole reason the Win32 SDK writes
 * `INVALID_HANDLE_VALUE` as `((HANDLE)(LONG_PTR)-1)`.
 */
const SIGNED_POINTER_WIDTH = new Set([
  'intptr_t', 'ptrdiff_t', 'ssize_t', 'LONG_PTR', 'INT_PTR', 'LPARAM', 'LRESULT',
]);

/**
 * Unsigned pointer-width integers. Refused: see the header. Listed rather than
 * inferred so the refusal is deliberate and greppable.
 */
export const UNSIGNED_POINTER_WIDTH = new Set([
  'size_t', 'uintptr_t', 'ULONG_PTR', 'UINT_PTR', 'DWORD_PTR', 'WPARAM', 'SIZE_T',
]);

/**
 * Win32 typedefs that ARE pointers without spelling a `*`. Their invalid value
 * is -1 rather than null - which is why the SDK writes `INVALID_HANDLE_VALUE`
 * as `((HANDLE)(LONG_PTR)-1)` instead of as a bit pattern.
 *
 * `SOCKET` is deliberately absent: it is `UINT_PTR`, and `INVALID_SOCKET` is
 * `(SOCKET)(~0)` - unsigned, so it keeps its pattern.
 */
const POINTER_SHAPED_TYPEDEFS = new Set([
  'HANDLE', 'HWND', 'HDC', 'HMODULE', 'HINSTANCE', 'HKEY', 'HGLOBAL', 'HLOCAL',
  'HBITMAP', 'HMENU', 'HICON', 'HCURSOR', 'HBRUSH', 'HFONT', 'HPALETTE', 'HRGN',
  'HGDIOBJ', 'HFILE', 'FARPROC', 'LPVOID', 'PVOID', 'LPSTR', 'LPCSTR', 'LPWSTR',
  'LPCWSTR', 'pointer',
]);

export interface SentinelSlotContext {
  /** Is this type name a Ghidra enum? Enums are emitted with an `int` base. */
  isEnumType?(name: string): boolean;
  /**
   * Is this type name spelled UNSIGNED by the header that declares it? Asked
   * only of the emitted spelling, which is not always what Ghidra modelled -
   * `GrAspectRatio_t` is a typedef over a signed base in the program database
   * and `unsigned int` in the Glide declarations the platform header carries.
   */
  isUnsignedSlot?(name: string): boolean;
  /** Is this type name a funcdef typedef, i.e. pointer-shaped without a `*`? */
  isFuncDefTypedef?(name: string): boolean;
  /** Spell a type for use inside a cast (root-qualification lives in the caller). */
  spellType?(type: string): string;
}

/**
 * Read a Ghidra data value. Values arrive as `0x...`, as bare hex with no
 * prefix (`ffffffff`), or as decimal (`4294967295` - which is how an enum slot
 * arrives). All three have to reach the same decision.
 */
export function parseDataValueNumber(raw: string | null | undefined): bigint | undefined {
  // Ghidra hands over `null` for a symbol that carries no datum, and the
  // extraction types that as an optional string. Both mean the same here.
  if (raw === undefined || raw === null) return undefined;
  const v = raw.trim();
  if (v === '') return undefined;
  try {
    if (/^0[xX][0-9a-fA-F]+$/.test(v)) return BigInt(v);
    if (/^\d+$/.test(v)) return BigInt(v);
    // Bare hex, no prefix. Only when it cannot be read as decimal, so that
    // `10` stays ten rather than becoming sixteen.
    if (/^[0-9a-fA-F]{2,16}$/.test(v) && /[a-fA-F]/.test(v)) return BigInt('0x' + v);
  } catch {
    return undefined;
  }
  return undefined;
}

/** Every bit set for `bytes` bytes. */
function allOnes(bytes: number): bigint {
  return (1n << BigInt(bytes * 8)) - 1n;
}

/** Drop cv-qualifiers and collapse whitespace; keep `*`, it is the shape. */
function canonical(type: string): string {
  return type
    .replace(/\b(const|volatile)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `D2Foo *[4]` / `int[8]` → the type with its array dimensions removed. */
function withoutArrayDimensions(type: string): string {
  return canonical(type.replace(/\s*\[\s*\d*\s*\]/g, ''));
}

function isPointerShaped(type: string, ctx: SentinelSlotContext): boolean {
  const t = withoutArrayDimensions(type);
  if (t.includes('*')) return true;
  if (POINTER_SHAPED_TYPEDEFS.has(t)) return true;
  return ctx.isFuncDefTypedef?.(t) === true;
}

/**
 * The spelling of an all-ones value for `declaredType`, or `undefined` when
 * this slot keeps its bit pattern.
 *
 * `undefined` is the answer for every unsigned integer slot, every unknown
 * type, and every value that is not all ones for the slot's own width - which
 * is most of them, by design.
 */
export function allOnesSentinel(
  rawValue: string | null | undefined,
  declaredType: string | null | undefined,
  ctx: SentinelSlotContext = {}
): string | undefined {
  if (!declaredType) return undefined;
  const value = parseDataValueNumber(rawValue);
  if (value === undefined || value <= 0n) return undefined;

  const spell = ctx.spellType ?? ((t: string) => t.replace(/\s*\*/g, '*'));

  // Pointer-shaped: the only slot whose stored value actually changes, and the
  // only one that is wrong today.
  if (isPointerShaped(declaredType, ctx)) {
    // A 32-bit binary's pointer is 4 bytes; accept the 64-bit pattern too so a
    // re-extraction at another width lands in the same place.
    if (value !== allOnes(4) && value !== allOnes(8)) return undefined;
    const slot = withoutArrayDimensions(declaredType);
    // The SDK spells this one for us, and spells it width-correctly:
    // `((HANDLE)(LONG_PTR)-1)`. Use the name where it is the name.
    if (slot === 'HANDLE') return 'INVALID_HANDLE_VALUE';
    return `(${spell(slot)})-1`;
  }

  const base = withoutArrayDimensions(declaredType);

  // A Ghidra enum is emitted as a plain `enum`, whose base gcc reports as `int`.
  if (ctx.isEnumType?.(base) === true) {
    return value === allOnes(4) ? '-1' : undefined;
  }

  if (SIGNED_POINTER_WIDTH.has(base)) {
    return value === allOnes(4) || value === allOnes(8) ? '-1' : undefined;
  }

  // Refused on purpose - the width itself is the defect, and it belongs in the
  // Ghidra type work order rather than in a spelling.
  if (UNSIGNED_POINTER_WIDTH.has(base)) return undefined;

  const bytes = SIGNED_WIDTHS.get(base);
  if (bytes === undefined) return undefined;   // unsigned, `char`, or unknown
  return value === allOnes(bytes) ? '-1' : undefined;
}

/**
 * A NEGATIVE datum in an UNSIGNED slot, spelled with the conversion written out.
 *
 * `-1` is D2's "none" everywhere, and Ghidra hands it back with the sign the
 * slot's own modelled type gives it. Where the EMITTED slot is unsigned the two
 * disagree, and C++ calls the difference narrowing:
 *
 *     GrTexInfo t = { 4, 4, -0x1, 5, nullptr };   // narrowing to unsigned int
 *
 * The bits are not in dispute - the same word is stored either way - so the
 * answer is not to change the value but to say which type it is being stored as.
 * `(GrAspectRatio_t)-0x1` keeps the sentinel legible, is the conversion the
 * original source performed implicitly, and stays the same object at any target
 * width because the typedef fixes the width.
 *
 * Spelling it `0xffffffff` instead would compile and would be the wrong answer:
 * it discards the fact that the value is -1, which is the thing a later reader -
 * or a 64-bit rebuild - needs to know.
 *
 * Returns `undefined` for a non-negative value, an unknown slot, or a slot the
 * caller does not vouch for as unsigned.
 */
export function negativeInUnsignedSlot(
  rawValue: string | null | undefined,
  declaredType: string | null | undefined,
  ctx: SentinelSlotContext = {}
): string | undefined {
  if (!declaredType || !ctx.isUnsignedSlot) return undefined;
  if (rawValue === undefined || rawValue === null) return undefined;
  const v = rawValue.trim();
  if (!/^-\s*(0[xX][0-9a-fA-F]+|\d+)$/.test(v)) return undefined;
  const base = withoutArrayDimensions(declaredType);
  if (base.includes('*')) return undefined;
  if (!ctx.isUnsignedSlot(base)) return undefined;
  const spell = ctx.spellType ?? ((t: string) => t);
  return `(${spell(base)})${v.replace(/\s+/g, '')}`;
}
