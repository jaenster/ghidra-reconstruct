/**
 * Does a struct need `__attribute__((packed))` to land where Ghidra says it does?
 *
 * The emitter annotates every field with the offset Ghidra models:
 *
 *     /* 0x09 *\/ uint32_t dwDataStartOffset;
 *
 * That comment is the intent, and nothing used to enforce it. Where Ghidra's
 * layout is packed and C's is naturally aligned, the compiler silently puts the
 * field somewhere else - and the code still compiles, links and runs, reading
 * the wrong bytes.
 *
 * `D2StringTableTblFileStrc` is the worked example. Its real 21-byte header has
 * unaligned dwords at 0x09, 0x0D and 0x11. Emitted without packing, a 32-bit
 * compiler puts them at 12, 16 and 20 and makes the struct 24 bytes. The .tbl
 * CRC is then computed over a garbage range and walks off the end of the buffer.
 *
 * Ghidra's own `packed` flag is not reliably set on these, so the decision is
 * DERIVED instead: simulate natural C layout over the declared fields and see
 * whether it reproduces every declared offset. If it cannot, the struct is
 * packed - that is not a guess, it is the only layout consistent with the
 * offsets the database carries.
 *
 * A field whose alignment cannot be determined (a nested struct, an unknown
 * typedef, a bitfield) makes the struct UNDECIDABLE - and undecidable used to
 * return false. That threw away an answer the database already had. Ghidra
 * records an `alignment` per structure, and 914 of the 1063 non-mac structures
 * carry `alignment: 1`; every one of the 42 structs the cross compiler proved
 * mislaid was among them. So undecidable now defers to Ghidra's own alignment
 * instead of to a guess: `alignment === 1` is Ghidra saying "packed", and
 * nothing but the derivation above can say it for us.
 *
 * The positive derivation is unchanged. An undecidable struct with no recorded
 * alignment still returns false - adding `packed` on a hunch would change the
 * ABI of a struct that may be fine.
 *
 * The third trigger is TRAILING PADDING. A struct can reproduce every declared
 * offset naturally and still be the wrong SIZE, because C rounds the total up
 * to the struct's own alignment where Ghidra does not. Offsets alone cannot see
 * it, and `sizeof` is the array stride - so an array of such a struct reads the
 * wrong row from its second element on. 43 structures in 1.14d are in this
 * class; `layout_check.py` had already caught three of them by hand.
 */

import type { StructField } from '../types.js';

/** Natural alignment of each primitive spelling on the 32-bit target. */
const ALIGN: ReadonlyMap<string, number> = new Map([
  ['char', 1], ['uchar', 1], ['byte', 1], ['int8_t', 1], ['uint8_t', 1], ['bool', 1],
  ['undefined', 1], ['undefined1', 1],
  ['short', 2], ['ushort', 2], ['int16_t', 2], ['uint16_t', 2], ['wchar_t', 2],
  ['undefined2', 2], ['word', 2],
  ['int', 4], ['uint', 4], ['long', 4], ['ulong', 4], ['int32_t', 4], ['uint32_t', 4],
  ['float', 4], ['BOOL', 4], ['DWORD', 4], ['undefined4', 4], ['dword', 4],
  ['int64_t', 8], ['uint64_t', 8], ['double', 8], ['undefined8', 8], ['qword', 8],
]);

/**
 * Alignment of one field, or undefined when it cannot be determined.
 *
 * An ARRAY aligns like its element, not like its total size - `char[260]` is
 * 1-aligned, and treating it as 260 would invent a packing requirement that is
 * not there.
 */
export function fieldAlignment(dataType: string): number | undefined {
  let t = (dataType || '').trim();
  const arr = /^(.*?)\s*\[\s*\d+\s*\]$/.exec(t);
  if (arr) t = arr[1].trim();
  if (t.endsWith('*')) return 4;                 // any pointer, 32-bit target
  t = t.replace(/^(const|volatile|struct|union|enum)\s+/, '').trim();
  return ALIGN.get(t);
}

/**
 * True when natural C layout cannot reproduce what Ghidra records.
 *
 * Three independent triggers, any one of which is sufficient:
 *
 *  1. A field lands EARLIER than natural alignment would put it. Only a packed
 *     layout explains the offset the database carries.
 *  2. The derivation is undecidable and Ghidra records `alignment: 1` - the
 *     database answering the question the derivation could not.
 *  3. Every offset reproduces, but the natural TOTAL is bigger than Ghidra's
 *     `size` - trailing padding C adds and the database does not model.
 *
 * Also false for a struct with fewer than two positioned fields, where there
 * is nothing for alignment to disagree about.
 *
 * @param ghidraAlignment the structure's `alignment` as Ghidra records it; 1
 *   means Ghidra itself laid the struct out packed.
 * @param ghidraSize the structure's `size` as Ghidra records it, for trigger 3.
 */
export function requiresPacking(
  fields: readonly StructField[],
  ghidraAlignment?: number,
  ghidraSize?: number,
): boolean {
  // Ghidra could not size a field, so the derivation below cannot run past it.
  // Defer to what the database recorded rather than to a guess.
  const undecidable = () => ghidraAlignment === 1;

  if (!fields || fields.length < 2) return false;
  let cursor = 0;
  let maxAlign = 1;
  for (const f of fields) {
    if (typeof f.offset !== 'number' || typeof f.size !== 'number' || f.size <= 0) {
      return undecidable();
    }
    const align = fieldAlignment(f.dataType);
    if (align === undefined) return undecidable();
    if (align > maxAlign) maxAlign = align;
    const aligned = Math.ceil(cursor / align) * align;
    if (aligned !== f.offset) {
      // Natural layout would put this field somewhere else. Only a packed
      // layout explains the offset the database carries.
      if (f.offset < aligned) return true;
      // A LARGER declared offset is explicit padding, not a packing conflict -
      // Ghidra models those as real filler fields, so follow the database.
      cursor = f.offset;
    }
    cursor = f.offset + f.size;
  }

  // Every field offset reproduces naturally - and the struct can STILL be
  // wrong, because C rounds the total up to the struct's own alignment and
  // Ghidra does not. `D2ConfigControlDescStrc` is 10 bytes in the database and
  // 12 in C; `D2HirelingHireData` 58 and 60. Every `offsetof` agrees, so the
  // offset derivation above sees nothing - but `sizeof` IS the array stride,
  // so an array of one of these reads the wrong row from element 1 onward, and
  // any allocation sized by `sizeof` is over-large in a way nothing reports.
  //
  // Only a total LARGER than Ghidra's is evidence: a declared size bigger than
  // the fields need is trailing filler the database models on purpose, and
  // packing cannot add bytes anyway.
  if (typeof ghidraSize === 'number' && ghidraSize > 0 && cursor <= ghidraSize) {
    const naturalSize = Math.ceil(cursor / maxAlign) * maxAlign;
    if (naturalSize > ghidraSize) return true;
  }

  return false;
}

/**
 * Give an aggregate the layout facts of the Ghidra structure it is built from.
 *
 * A `DetectedClass` is a Ghidra STRUCTURE that acquired methods, and it takes
 * its fields from that structure at four separate points in the pipeline. Each
 * of those points copied `fields` and nothing else, so the emitted class had no
 * way to know its own alignment and `generateClassDeclaration` could not pack
 * it - a class-shaped aggregate silently escaped the check a struct-shaped one
 * gets. The fields and the numbers that describe their layout travel together.
 *
 * Fields are only adopted when the target has none, matching what each call
 * site already did; the numbers are adopted whenever the target lacks them,
 * because a class whose fields arrived earlier still needs them.
 */
export function adoptGhidraLayout(
  target: { fields?: StructField[]; alignment?: number; size?: number },
  source: { fields?: StructField[]; alignment?: number; size?: number },
): void {
  if ((!target.fields || target.fields.length === 0) && source.fields) {
    target.fields = source.fields;
  }
  if (target.alignment === undefined) target.alignment = source.alignment;
  if (target.size === undefined) target.size = source.size;
}
