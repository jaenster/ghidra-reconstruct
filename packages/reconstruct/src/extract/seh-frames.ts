/**
 * MSVC structured exception frames, read off the instructions.
 *
 * A function with `__try` opens with the inline EH3/EH4 registration
 *
 *     push ebp; mov ebp,esp; push -1 (EH4: -2); push <scope table>;
 *     push _except_handler3 (EH4: __except_handler4); mov eax,fs:[0]; push eax;
 *     mov fs:[0],esp
 *
 * and keeps the active scope in `[ebp-4]` (the try level). The scope table says, per
 * level, the enclosing level, the filter funclet (none for `__finally`) and the
 * handler. The decompiler prints the stores and nothing of the funclets: they are
 * reached only through the table, so they are not in the function's flow. This is
 * what the generator needs to lower the frame back into a `__try`:
 *
 *  - the table's entries, read from memory (EH4 tables start with 16 bytes of cookie
 *    offsets);
 *  - each funclet's first instructions, following one fall-through or jump, and
 *    whether each lies inside the parent function (a handler's continuation does);
 *  - how often the function stores each try level, so a store the decompiler printed
 *    once is known to be the only one;
 *  - what the parent does after each try-level store, up to its deregistration: a
 *    `__finally`'s normal path calls the termination handler's body there.
 *
 * Read-only: one execute_script for the program, no transaction. A failure leaves the
 * field unset, which is what an older snapshot looks like too.
 */

import type { GhidraConnection, ExtractedFunction } from '../types.js';

export interface SehInstruction {
  address: string;
  /** Ghidra's rendering, e.g. `MOV EAX,0x1`, `MOV ESP,dword ptr [EBP + -0x18]`. */
  text: string;
  /** The instruction lies in the parent function's body. */
  inParent: boolean;
}

export interface SehScopeEntry {
  level: number;
  enclosingLevel: number;
  /** Filter funclet address; absent for a `__finally` entry. */
  filter?: string;
  handler: string;
  filterCode: SehInstruction[];
  handlerCode: SehInstruction[];
}

export interface SehFrameFacts {
  kind: 'eh3' | 'eh4';
  scopeTable: string;
  /** The registration's handler symbol (`_except_handler3`, `__except_handler4`). */
  handlerSymbol: string;
  entries: SehScopeEntry[];
  /**
   * Try level -> how many `mov [ebp-4],level` stores the function holds; `reg` counts
   * the stores of a register (`mov [ebp-4],ebx` with EBX zeroed), whose level the
   * instruction does not say.
   */
  tryLevelStores: Record<string, number>;
  /**
   * Per try-level store (by its address): the instructions that follow it by
   * fall-through, up to and including the `mov fs:[0],reg` deregistration (at most 8).
   * Absent in snapshots that predate the field.
   */
  afterStores?: Record<string, { level: string; code: SehAfterInstruction[] }>;
}

export interface SehAfterInstruction {
  address: string;
  text: string;
  /** A CALL's target. */
  callTarget?: string;
}

/** Java, no imports (the body runs inside GhidraScript.run()). */
export const SEH_FRAME_SCRIPT = `
ghidra.program.model.listing.Listing L = currentProgram.getListing();
ghidra.program.model.mem.Memory M = currentProgram.getMemory();
ghidra.program.model.symbol.SymbolTable st = currentProgram.getSymbolTable();
StringBuilder sb = new StringBuilder();
for (ghidra.program.model.listing.Function f : currentProgram.getFunctionManager().getFunctions(true)) {
  if (f.isThunk() || f.isExternal()) continue;
  ghidra.program.model.listing.Instruction ins = L.getInstructionAt(f.getEntryPoint());
  long table = -1; String hsym = null; boolean fs = false;
  for (int i = 0; i < 8 && ins != null; i++) {
    String t = ins.toString();
    if (ins.getMnemonicString().equals("PUSH") && ins.getNumOperands() == 1 && ins.getScalar(0) != null) {
      long v = ins.getScalar(0).getUnsignedValue();
      ghidra.program.model.symbol.Symbol s = st.getPrimarySymbol(toAddr(v));
      if (s != null && (s.getName().contains("except_handler3") || s.getName().contains("except_handler4"))) hsym = s.getName();
      else if (hsym == null && v > 0x10000) table = v;
    }
    if (t.equals("MOV EAX,dword ptr FS:[0x0]") || t.equals("MOV EAX,FS:[0x0]")) { fs = true; break; }
    ins = ins.getNext();
  }
  if (!fs || hsym == null || table < 0) continue;
  boolean eh4 = hsym.contains("4");
  ghidra.program.model.address.Address ta = toAddr(table);
  sb.append("F\\t").append(f.getEntryPoint()).append('\\t').append(eh4 ? "eh4" : "eh3").append('\\t').append(ta).append('\\t').append(hsym).append('\\n');
  java.util.TreeMap<Long, Integer> levels = new java.util.TreeMap<>();
  int regStores = 0;
  StringBuilder after = new StringBuilder();
  for (ghidra.program.model.listing.Instruction x : L.getInstructions(f.getBody(), true)) {
    String t = x.toString();
    if (!t.startsWith("MOV dword ptr [EBP + -0x4],")) continue;
    String lvText;
    if (x.getScalar(1) != null) {
      long lv = (int) x.getScalar(1).getValue();
      levels.put(lv, levels.getOrDefault(lv, 0) + 1);
      lvText = String.valueOf(lv);
    } else {
      regStores++;
      lvText = "reg";
    }
    // What the parent does after the store, up to its deregistration: a __finally's
    // normal path calls the termination handler's body here.
    ghidra.program.model.listing.Instruction y = x;
    for (int k = 0; k < 8; k++) {
      ghidra.program.model.address.Address ft = y.getFallThrough();
      if (ft == null) break;
      y = L.getInstructionAt(ft);
      if (y == null) break;
      ghidra.program.model.address.Address[] fl = y.getFlows();
      after.append("X\\t").append(x.getAddress()).append('\\t').append(lvText).append('\\t').append(y.getAddress()).append('\\t')
        .append(y.getFlowType().isCall() && fl.length == 1 ? fl[0].toString() : "-").append('\\t').append(y.toString()).append('\\n');
      if (y.toString().startsWith("MOV dword ptr FS:[0x0],")) break;
    }
  }
  for (java.util.Map.Entry<Long, Integer> e : levels.entrySet()) sb.append("L\\t").append(e.getKey()).append('\\t').append(e.getValue()).append('\\n');
  if (regStores > 0) sb.append("L\\treg\\t").append(regStores).append('\\n');
  sb.append(after);
  int off = eh4 ? 16 : 0;
  for (int e = 0; e < 64; e++) {
    ghidra.program.model.address.Address ea = ta.add(off + e * 12);
    int encl; long filt; long hnd;
    try { encl = M.getInt(ea); filt = M.getInt(ea.add(4)) & 0xffffffffL; hnd = M.getInt(ea.add(8)) & 0xffffffffL; } catch (Exception ex) { break; }
    if (encl < (eh4 ? -2 : -1) || encl >= e) break;
    ghidra.program.model.mem.MemoryBlock hb = M.getBlock(toAddr(hnd));
    if (hb == null || !hb.isExecute()) break;
    if (filt != 0) { ghidra.program.model.mem.MemoryBlock fb = M.getBlock(toAddr(filt)); if (fb == null || !fb.isExecute()) break; }
    sb.append("E\\t").append(e).append('\\t').append(encl).append('\\t').append(filt == 0 ? "-" : toAddr(filt).toString()).append('\\t').append(toAddr(hnd)).append('\\n');
    long[] starts = { filt, hnd };
    String[] roles = { "filter", "handler" };
    for (int r = 0; r < 2; r++) {
      if (starts[r] == 0) continue;
      ghidra.program.model.listing.Instruction x = L.getInstructionAt(toAddr(starts[r]));
      boolean jumped = false;
      for (int k = 0; k < 6 && x != null; k++) {
        sb.append("I\\t").append(roles[r]).append('\\t').append(e).append('\\t').append(x.getAddress()).append('\\t')
          .append(f.getBody().contains(x.getAddress()) ? "1" : "0").append('\\t').append(x.toString()).append('\\n');
        String mn = x.getMnemonicString();
        if (mn.equals("RET")) break;
        if (mn.equals("JMP")) {
          if (jumped || x.getFlows().length != 1) break;
          jumped = true;
          x = L.getInstructionAt(x.getFlows()[0]);
          continue;
        }
        ghidra.program.model.address.Address ft = x.getFallThrough();
        if (ft == null) break;
        x = L.getInstructionAt(ft);
      }
    }
  }
}
println(sb.toString());
`;

function addressKey(address: string): string {
  const bare = address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
  return bare.replace(/^0x/i, '').toLowerCase().padStart(8, '0');
}

/** Parse the script's rows: `F` opens a frame, `L` / `E` / `I` belong to the last one. */
export function parseSehFrames(output: string): Map<string, SehFrameFacts> {
  const out = new Map<string, SehFrameFacts>();
  let cur: SehFrameFacts | undefined;
  for (const raw of output.split('\n')) {
    const cols = raw.replace(/\r$/, '').split('\t');
    switch (cols[0]) {
      case 'F': {
        if (cols.length < 5 || (cols[2] !== 'eh3' && cols[2] !== 'eh4')) { cur = undefined; break; }
        cur = { kind: cols[2], scopeTable: addressKey(cols[3]), handlerSymbol: cols[4], entries: [], tryLevelStores: {} };
        out.set(addressKey(cols[1]), cur);
        break;
      }
      case 'L':
        if (cur && cols.length >= 3) cur.tryLevelStores[cols[1] === 'reg' ? 'reg' : String(Number(cols[1]))] = Number(cols[2]);
        break;
      case 'X': {
        if (!cur || cols.length < 6) break;
        const at = addressKey(cols[1]);
        cur.afterStores ??= {};
        const rec = (cur.afterStores[at] ??= { level: cols[2] === 'reg' ? 'reg' : String(Number(cols[2])), code: [] });
        rec.code.push({ address: addressKey(cols[3]), text: cols.slice(5).join('\t'), ...(cols[4] !== '-' ? { callTarget: addressKey(cols[4]) } : {}) });
        break;
      }
      case 'E':
        if (cur && cols.length >= 5) {
          cur.entries.push({
            level: Number(cols[1]),
            enclosingLevel: Number(cols[2]),
            ...(cols[3] !== '-' ? { filter: addressKey(cols[3]) } : {}),
            handler: addressKey(cols[4]),
            filterCode: [],
            handlerCode: [],
          });
        }
        break;
      case 'I': {
        if (!cur || cols.length < 6) break;
        const entry = cur.entries.find(e => e.level === Number(cols[2]));
        if (!entry) break;
        const ins: SehInstruction = { address: addressKey(cols[3]), inParent: cols[4] === '1', text: cols.slice(5).join('\t') };
        (cols[1] === 'filter' ? entry.filterCode : entry.handlerCode).push(ins);
        break;
      }
    }
  }
  return out;
}

/** Attach each frame to its function. Returns how many were attached. */
export function applySehFrames(frames: Map<string, SehFrameFacts>, functions: ExtractedFunction[]): number {
  let attached = 0;
  for (const func of functions) {
    const frame = frames.get(addressKey(func.address));
    if (!frame) continue;
    func.sehFrame = frame;
    attached++;
  }
  return attached;
}

export async function attachSehFrames(connection: GhidraConnection, functions: ExtractedFunction[]): Promise<number> {
  let output: string;
  try {
    const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
      'execute_script',
      { language: 'java', code: SEH_FRAME_SCRIPT, scriptTimeout: 300, _commandTimeout: 360000 }
    );
    if (result.success === false || typeof result.output !== 'string') {
      console.warn(`  SEH frames unavailable: ${result.error ?? 'no output'}`);
      return 0;
    }
    output = result.output;
  } catch (err) {
    console.warn(`  SEH frames unavailable: ${(err as Error).message}`);
    return 0;
  }
  return applySehFrames(parseSehFrames(output), functions);
}
