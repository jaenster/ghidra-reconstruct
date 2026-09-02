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
 * typedef) makes the struct UNDECIDABLE, and undecidable returns false: adding
 * `packed` on a hunch would change the ABI of a struct that may be fine. Those
 * are the ones `static_assert` on `offsetof` is for, and they stay silent until
 * that lands.
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
 * True when natural C alignment cannot reproduce the declared field offsets.
 *
 * Returns false for an undecidable struct - see the module comment. Also false
 * for a struct with fewer than two positioned fields, where there is nothing
 * for alignment to disagree about.
 */
export function requiresPacking(fields: readonly StructField[]): boolean {
  if (!fields || fields.length < 2) return false;
  let cursor = 0;
  for (const f of fields) {
    if (typeof f.offset !== 'number' || typeof f.size !== 'number' || f.size <= 0) {
      return false;                              // undecidable
    }
    const align = fieldAlignment(f.dataType);
    if (align === undefined) return false;       // undecidable
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
  return false;
}
