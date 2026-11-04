/**
 * Floating-point data, valued from its bytes.
 *
 * Ghidra values a `float` or `double` datum as text it rounds: `sinTable_f32`
 * (00707800) arrives as `0.01227154`, `DOUBLE_006da6b0` as `0.0500000007450581`.
 * Read back as C, 253 of the table's 2048 bytes and that double come out one or
 * more units in the last place away from the image, and a game that reads them
 * computes with different numbers than the original did. The bytes are exact, so
 * every float datum is read as bytes and its value respelled wherever Ghidra's
 * text does not read back to the same bits.
 *
 * Only where it does not: a value that already reads back exactly keeps Ghidra's
 * spelling, so the tree changes only where it was wrong.
 *
 * Covered: a `float` or `double` global and any array of them (the elements sit
 * at a fixed stride). A float field inside a struct is not: `read_data_value`
 * gives a struct's fields without their offsets, so there is nothing to place the
 * bytes by. `float10` (an x87 80-bit datum) has no JS number to hold it and is
 * left alone too.
 */

import type { AnalyzedDataSymbol, DataValue } from '../types.js';

/** The element width of a float datum: `float`/`double` and arrays of them, else null. */
export function floatDataWidth(dataType: string | undefined): 4 | 8 | null {
  const m = /^\s*(float|double)\s*((?:\[\s*\d+\s*\])*)\s*$/.exec(dataType ?? '');
  if (!m) return null;
  return m[1] === 'float' ? 4 : 8;
}

/** The value one element's bytes hold, widened to a JS number (exact for both widths). */
function elementValue(bytes: Uint8Array, offset: number, width: 4 | 8): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, width);
  return width === 4 ? view.getFloat32(0, true) : view.getFloat64(0, true);
}

/** The element's bits as a hex string, for comparing a NaN by its payload. */
function elementBits(bytes: Uint8Array, offset: number, width: 4 | 8): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, width);
  return width === 4 ? BigInt(view.getUint32(0, true)) : view.getBigUint64(0, true);
}

/**
 * The C spelling of the element at `offset`: a literal that reads back to exactly
 * these bits in a slot of this width.
 *
 * A finite value is printed as JS prints a number, the shortest decimal that
 * reads back to the same double. For a `float` that double is the float itself,
 * exactly, so the slot's conversion from double to float is exact too and no
 * double rounding can happen (a 9-digit decimal read straight into a float slot
 * could round twice). An integral value keeps a `.0` so it stays a floating
 * literal; `-0.0` keeps its sign; an infinity is spelled the way Ghidra spells
 * one (`normalizeDataValue` maps it to `HUGE_VAL`); a NaN carries its payload
 * through `__builtin_nan`/`__builtin_nanf`.
 */
export function exactFloatSpelling(bytes: Uint8Array, offset: number, width: 4 | 8): string {
  const v = elementValue(bytes, offset, width);
  if (Number.isNaN(v)) {
    const bits = elementBits(bytes, offset, width);
    const mantissaBits = width === 4 ? 23n : 52n;
    const payload = bits & ((1n << mantissaBits) - 1n);
    const negative = (bits >> (mantissaBits + (width === 4 ? 8n : 11n))) & 1n;
    const call = `${width === 4 ? '__builtin_nanf' : '__builtin_nan'}("0x${payload.toString(16)}")`;
    return negative ? `-${call}` : call;
  }
  if (v === Infinity) return '+Infinity';
  if (v === -Infinity) return '-Infinity';
  if (Object.is(v, -0)) return '-0.0';
  const s = String(v);
  return /^-?\d+$/.test(s) ? `${s}.0` : s;
}

/**
 * The value C reads from Ghidra's spelling into a slot of this width, or null
 * when the text is not a number C would read (a NaN, a rendering).
 */
function readBack(text: string | undefined, width: 4 | 8): number | null {
  if (text === undefined) return null;
  const t = text.trim();
  if (t === 'Infinity' || t === '+Infinity') return Infinity;
  if (t === '-Infinity') return -Infinity;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const d = Number.parseFloat(t);
  return width === 4 ? Math.fround(d) : d;
}

/** Whether Ghidra's text for one element already reads back to the element's bits. */
function readsBackExactly(text: string | undefined, bytes: Uint8Array, offset: number, width: 4 | 8): boolean {
  const back = readBack(text, width);
  if (back === null) return false;
  const v = elementValue(bytes, offset, width);
  if (Number.isNaN(v)) return false;
  return Object.is(back, v);
}

/**
 * Respell every element of `g` whose text does not read back to its bytes.
 * `bytes` holds the datum from its first byte. Returns how many were respelled.
 */
export function applyExactFloatBytes(g: AnalyzedDataSymbol, bytes: Uint8Array): number {
  const width = floatDataWidth(g.dataType);
  if (!width) return 0;
  let changed = 0;
  const fix = (text: string | undefined, offset: number): string | undefined => {
    if (offset + width > bytes.length) return text;
    if (readsBackExactly(text, bytes, offset, width)) return text;
    changed++;
    return exactFloatSpelling(bytes, offset, width);
  };

  if (g.value !== undefined && !/\[/.test(g.dataType ?? '')) {
    const next = fix(g.value, 0);
    if (next !== undefined) g.value = next;
  }
  const root = g.initializedData;
  if (root) {
    // Elements in order, at the element width: nested arrays are flattened the
    // way C lays them out, row after row.
    let offset = 0;
    const walk = (d: DataValue): void => {
      if (d.kind === 'array' && d.elements) {
        for (const e of d.elements) walk(e);
        return;
      }
      if (d.kind === 'scalar') {
        const next = fix(d.value, offset);
        if (next !== undefined) d.value = next;
      }
      offset += width;
    };
    walk(root);
  }
  return changed;
}

/** The `read_memory` reply: the bytes, base64. */
interface ReadMemoryReply { bytes?: string; length?: number }

/**
 * Read every float datum's bytes and respell what Ghidra's text gets wrong.
 * A read that fails leaves that datum as Ghidra valued it.
 */
export async function fetchExactFloatData(
  connection: { sendCommand<T>(command: string, params?: Record<string, unknown>): Promise<T> },
  globals: AnalyzedDataSymbol[],
): Promise<{ read: number; respelled: number }> {
  const candidates = globals.filter(g =>
    g.isInitialized && floatDataWidth(g.dataType) !== null && g.size > 0 && g.size <= 64 * 1024);
  let read = 0;
  let respelled = 0;
  for (const g of candidates) {
    const reply = await connection.sendCommand<ReadMemoryReply>('read_memory', {
      address: g.address,
      length: g.size,
    }).catch(() => null);
    if (!reply?.bytes) continue;
    const bytes = Uint8Array.from(Buffer.from(reply.bytes, 'base64'));
    if (bytes.length !== g.size) continue;
    read++;
    respelled += applyExactFloatBytes(g, bytes);
  }
  return { read, respelled };
}
