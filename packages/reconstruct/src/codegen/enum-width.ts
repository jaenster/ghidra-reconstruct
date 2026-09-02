/**
 * The width Ghidra models for an enum, carried into the emitted C++.
 *
 * The tree spells every enum as `typedef <int> <Name>;` plus a namespace of
 * `constexpr` members rather than as a real C++ `enum`, because a forward
 * declaration has to be spellable without the members and a `typedef` name and
 * an `enum` tag cannot be mixed. That shape is kept here — only the underlying
 * integer changes. A real `enum <Name> : uint16_t` would also carry the width,
 * but it would break both the forward-declaration story and the implicit
 * int-conversions that decompiled bodies do on these values constantly.
 *
 * The width is not cosmetic. `eCollisionFlags` is a 2-byte enum, and
 * `D2RoomCollisionGridStrc::aMap` is an array of it — the disassembly indexes
 * that array with `MOVZX EAX, word ptr [ECX+ESI*0x2]`. Emitted at `int` the
 * array has a 4-byte stride, every element access reads the wrong cell, and
 * nothing reports it: the tree compiles and links and is simply wrong.
 * `D2IniConfigStrc` is the same story from offset 0x1EE on, where a 1-byte
 * `eD2PlayerClassID` and two 2-byte `eD2PlayerStatus` fields push the whole
 * tail of the struct out of place.
 *
 * Signedness is derived from the members, which is the same rule Ghidra uses:
 * an enum with no negative member is unsigned. It matters at 2 bytes —
 * `eCollisionFlags` runs 0..32768, which does NOT fit in `int16_t`.
 */

import type { ExtractedEnum, EnumValue } from '../types.js';

/** The underlying integer for a given Ghidra enum size, by signedness. */
const UNSIGNED_BY_SIZE: ReadonlyMap<number, string> = new Map([
  [1, 'uint8_t'],
  [2, 'uint16_t'],
  [8, 'uint64_t'],
]);

const SIGNED_BY_SIZE: ReadonlyMap<number, string> = new Map([
  [1, 'int8_t'],
  [2, 'int16_t'],
  [8, 'int64_t'],
]);

/**
 * The status-quo spelling: what every enum was emitted as before widths were
 * carried, and what an enum of unknown or non-standard size still gets.
 * 4 is deliberately not in the tables above — a 4-byte enum keeps `int` so the
 * change moves only the enums whose width is actually wrong.
 */
export const DEFAULT_ENUM_UNDERLYING = 'int';

/**
 * The underlying integer type for one enum, from the size Ghidra models and
 * the sign of its members.
 *
 * `size` is Ghidra's `DataType.getLength()`. A missing or zero size means the
 * extraction never carried one, and guessing a width from the member values
 * would be wrong in the dangerous direction — a genuinely 4-byte enum whose
 * largest member is 0xFFFF would be narrowed to 2. Unknown stays `int`.
 */
export function enumUnderlyingType(
  enumType: { size?: number; values?: readonly EnumValue[] }
): string {
  const size = enumType.size;
  if (typeof size !== 'number' || !Number.isFinite(size)) return DEFAULT_ENUM_UNDERLYING;
  const signed = (enumType.values ?? []).some(v => Number(v.value) < 0);
  const table = signed ? SIGNED_BY_SIZE : UNSIGNED_BY_SIZE;
  return table.get(size) ?? DEFAULT_ENUM_UNDERLYING;
}

/**
 * Underlying type per enum NAME, for the emission sites that only have a name:
 * the forward declarations in `addForwardDeclaration` and the globals header's
 * fallback. Those must spell the typedef exactly as `d2_enums.h` spells it or
 * the translation unit has two conflicting typedefs for one name.
 */
const knownEnumUnderlying = new Map<string, string>();

/**
 * Register the program's enums before emission.
 *
 * Ghidra carries some enum names under two category paths. Where the two agree
 * on a width, the name gets it. Where they DISAGREE — `eD2ServerIncomingStatus`
 * is 1 byte under /Diablo2/NETWORK/D2GS and 4 bytes under / — there is no
 * single right answer from the name alone, so the name keeps the status quo
 * and says so, rather than a coin-flip that silently relays a struct.
 */
export function setKnownEnumWidths(enums: Iterable<ExtractedEnum>): void {
  knownEnumUnderlying.clear();
  const conflicted = new Set<string>();
  for (const e of enums) {
    const spelling = enumUnderlyingType(e);
    const seen = knownEnumUnderlying.get(e.name);
    if (seen === undefined) {
      knownEnumUnderlying.set(e.name, spelling);
    } else if (seen !== spelling) {
      conflicted.add(e.name);
      knownEnumUnderlying.set(e.name, DEFAULT_ENUM_UNDERLYING);
    }
  }
  if (conflicted.size > 0) {
    console.warn(
      `enum width: ${conflicted.size} enum name(s) are modelled at two different ` +
      `sizes under different categories and keep \`${DEFAULT_ENUM_UNDERLYING}\`: ` +
      `${[...conflicted].sort().join(', ')}`
    );
  }
}

/** Test/reset hook — drops the registry so a later run starts from nothing. */
export function clearKnownEnumWidths(): void {
  knownEnumUnderlying.clear();
}

/**
 * The underlying integer for an enum name. `fallback` is the enum record when
 * the caller has one; the registry still wins, so a name Ghidra models at two
 * sizes resolves the same way at the definition and at every forward
 * declaration of it.
 */
export function enumUnderlyingFor(
  name: string,
  fallback?: { size?: number; values?: readonly EnumValue[] }
): string {
  const known = knownEnumUnderlying.get(name);
  if (known !== undefined) return known;
  return fallback ? enumUnderlyingType(fallback) : DEFAULT_ENUM_UNDERLYING;
}

/** The one-line typedef every emission site writes for an enum name. */
export function enumTypedefLine(
  name: string,
  fallback?: { size?: number; values?: readonly EnumValue[] }
): string {
  return `typedef ${enumUnderlyingFor(name, fallback)} ${name};`;
}
