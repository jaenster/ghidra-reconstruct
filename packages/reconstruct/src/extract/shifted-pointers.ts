/**
 * Shifted pointers: Ghidra pointer-typedefs that carry a component offset.
 *
 * A container-of read - a pointer to a struct's MEMBER used to reach the enclosing struct
 * (`pSlotLink` points at D2TaskQueueSlotStrc.sSlotLink, +0x10, and the code reads the
 * slot's nTaskCount at -0xc from it) - has no C type that says so, and the decompiler
 * prints it as negative indexing on the member's type (`pSlotLink[-2].pPrev`). Ghidra
 * models it with a pointer-typedef whose settings carry a component offset ("shifted
 * pointer", `D2TaskQueueSlotStrc * __shifted(D2TaskQueueSlotStrc,0x10)`): the pointer
 * holds the container's address plus the offset, and the decompiler prints every access
 * through it against the container, `ADJ(pSlotLink)->nTaskCount`.
 *
 * The listing gives a typedef only its underlying spelling, so the offset is read here,
 * one script for the whole program, and attached to the typedef's record as `shifted`.
 * Codegen then declares the typedef as a pointer to the member at that offset and lowers
 * `ADJ(p)` to `CONTAINING_RECORD(p, Container, member)` (codegen/shifted-pointers.ts).
 *
 * Read-only: one execute_script, no transaction. A failure leaves the field unset, which
 * is also what an older snapshot looks like; no typedef is then treated as shifted.
 */

import type { GhidraConnection, ExtractedDataType, ExtractedTypedef } from '../types.js';

/**
 * Every TypeDef with a non-zero component offset: `S\t<name>\t<category>\t<pointee>\t<pointee
 * category>\t<offset>`. The offset is the ComponentOffsetSettingsDefinition value of the
 * typedef's default settings (Ghidra 10.2+).
 */
export const SHIFTED_POINTER_SCRIPT = `
ghidra.program.model.data.DataTypeManager dtm = currentProgram.getDataTypeManager();
StringBuilder sb = new StringBuilder();
java.util.Iterator<ghidra.program.model.data.DataType> it = dtm.getAllDataTypes();
while (it.hasNext()) {
  ghidra.program.model.data.DataType dt = it.next();
  if (!(dt instanceof ghidra.program.model.data.TypeDef)) continue;
  ghidra.program.model.data.TypeDef td = (ghidra.program.model.data.TypeDef) dt;
  ghidra.program.model.data.DataType base = td.getBaseDataType();
  if (!(base instanceof ghidra.program.model.data.Pointer)) continue;
  long off = 0;
  try {
    off = ghidra.program.model.data.ComponentOffsetSettingsDefinition.DEF.getValue(td.getDefaultSettings());
  } catch (Throwable t) { off = 0; }
  if (off == 0) continue;
  ghidra.program.model.data.DataType to = ((ghidra.program.model.data.Pointer) base).getDataType();
  if (to == null) continue;
  sb.append("S\\t").append(td.getName()).append('\\t').append(td.getCategoryPath().getPath())
    .append('\\t').append(to.getName()).append('\\t').append(to.getCategoryPath().getPath())
    .append('\\t').append(off).append('\\n');
}
println(sb.toString());
`;

export interface ShiftedPointerFact {
  /** The container the pointer is shifted into. */
  base: string;
  baseCategory?: string;
  /** Bytes from the container's start to where the pointer points. */
  offset: number;
}

/** Script output -> `name\u0000category` -> fact. */
export function parseShiftedPointers(output: string): Map<string, ShiftedPointerFact> {
  const out = new Map<string, ShiftedPointerFact>();
  for (const line of output.split('\n')) {
    const cols = line.replace(/\r$/, '').split('\t');
    if (cols[0] !== 'S' || cols.length < 6) continue;
    const offset = Number(cols[5]);
    if (!Number.isFinite(offset) || offset === 0) continue;
    out.set(`${cols[1]}\u0000${cols[2]}`, { base: cols[3], baseCategory: cols[4], offset });
  }
  return out;
}

/** Attach each fact to its typedef record. Returns how many were attached. */
export function applyShiftedPointers(facts: Map<string, ShiftedPointerFact>, dataTypes: ExtractedDataType[]): number {
  let n = 0;
  for (const dt of dataTypes) {
    if (dt.kind !== 'TYPEDEF') continue;
    const f = facts.get(`${dt.name}\u0000${dt.category}`);
    if (!f) continue;
    (dt as ExtractedTypedef).shifted = f;
    n++;
  }
  return n;
}

export async function attachShiftedPointers(connection: GhidraConnection, dataTypes: ExtractedDataType[]): Promise<number> {
  try {
    const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
      'execute_script',
      { language: 'java', code: SHIFTED_POINTER_SCRIPT, scriptTimeout: 300, _commandTimeout: 360000 }
    );
    if (result.success === false || typeof result.output !== 'string') {
      console.warn(`  shifted pointers unavailable: ${result.error ?? 'no output'}`);
      return 0;
    }
    return applyShiftedPointers(parseShiftedPointers(result.output), dataTypes);
  } catch (err) {
    console.warn(`  shifted pointers unavailable: ${(err as Error).message}`);
    return 0;
  }
}
