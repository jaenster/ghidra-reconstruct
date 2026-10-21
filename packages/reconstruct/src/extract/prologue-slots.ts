/**
 * The stack slots a function's prologue reserves with `PUSH reg`.
 *
 * MSVC reserves a 4-byte local with `PUSH ECX` (or another register) instead of
 * `SUB ESP,4`: shorter, and the value pushed is irrelevant. It is still a store, so the
 * decompiler prints the register's value going into the local - `pNewBigInt = pData;` in
 * SHA1_FromBigIntBytes 0052a270 (`PUSH EBP; MOV EBP,ESP; PUSH ECX` with pData in ECX) -
 * and nothing in the pseudo-C tells that apart from an assignment the source made. The
 * instructions do: this reads them, and `dead-out-slot-store` drops such a store when the
 * call that follows overwrites the local through its address before anything reads it.
 *
 * Per function: after an optional `PUSH EBP; MOV EBP,ESP`, each `PUSH reg` before the
 * first other instruction, as the Ghidra stack offset of the slot it creates (the return
 * address is at 0, a saved EBP at -4). Callee-saved registers pushed there too are
 * recorded alike; only a slot that holds a LOCAL is ever acted on.
 *
 * Read-only: one execute_script, no transaction. A failure leaves the field unset, which
 * is also what an older snapshot looks like; no store is then dropped.
 */

import type { GhidraConnection, ExtractedFunction } from '../types.js';

export const PROLOGUE_SLOT_SCRIPT = `
ghidra.program.model.listing.Listing L = currentProgram.getListing();
StringBuilder sb = new StringBuilder();
ghidra.program.model.listing.FunctionIterator fi = currentProgram.getFunctionManager().getFunctions(true);
while (fi.hasNext()) {
  ghidra.program.model.listing.Function f = fi.next();
  if (f.isThunk() || f.isExternal()) continue;
  ghidra.program.model.listing.Instruction in = L.getInstructionAt(f.getEntryPoint());
  int off = -4; int k = 0;
  if (in != null && in.toString().equals("PUSH EBP")) {
    ghidra.program.model.listing.Instruction n = in.getNext();
    if (n != null && n.toString().equals("MOV EBP,ESP")) { in = n.getNext(); off = -8; }
  }
  while (in != null && k < 8 && f.getBody().contains(in.getAddress())) {
    String t = in.toString();
    if (!t.matches("PUSH (EAX|EBX|ECX|EDX|ESI|EDI)")) break;
    sb.append("P\\t").append(f.getEntryPoint().toString()).append("\\t").append(off).append("\\t").append(t.substring(5)).append("\\n");
    off -= 4; k++; in = in.getNext();
  }
}
println(sb.toString());
`;

/** Script output -> function address -> slots. */
export function parsePrologueSlots(output: string): Map<string, Array<{ offset: number; reg: string }>> {
  const out = new Map<string, Array<{ offset: number; reg: string }>>();
  for (const line of output.split('\n')) {
    const cols = line.replace(/\r$/, '').split('\t');
    if (cols[0] !== 'P' || cols.length < 4) continue;
    const addr = cols[1].replace(/^0x/i, '').toLowerCase().padStart(8, '0');
    const offset = Number(cols[2]);
    if (!Number.isInteger(offset)) continue;
    const list = out.get(addr) ?? [];
    if (!list.length) out.set(addr, list);
    list.push({ offset, reg: cols[3].trim().toUpperCase() });
  }
  return out;
}

export function applyPrologueSlots(slots: Map<string, Array<{ offset: number; reg: string }>>, functions: ExtractedFunction[]): number {
  let n = 0;
  for (const f of functions) {
    const s = slots.get(f.address.replace(/^0x/i, '').toLowerCase().padStart(8, '0'));
    if (!s) continue;
    f.pushSlots = s;
    n++;
  }
  return n;
}

export async function attachPrologueSlots(connection: GhidraConnection, functions: ExtractedFunction[]): Promise<number> {
  try {
    const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
      'execute_script',
      { language: 'java', code: PROLOGUE_SLOT_SCRIPT, scriptTimeout: 300, _commandTimeout: 360000 }
    );
    if (result.success === false || typeof result.output !== 'string') {
      console.warn(`  prologue slots unavailable: ${result.error ?? 'no output'}`);
      return 0;
    }
    return applyPrologueSlots(parsePrologueSlots(result.output), functions);
  } catch (err) {
    console.warn(`  prologue slots unavailable: ${(err as Error).message}`);
    return 0;
  }
}
