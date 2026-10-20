/**
 * Data references from instruction operands, and the values the code derives from them.
 *
 * The decompiler folds constants. MSVC compiles zlib's
 *
 *     base = lbase; base -= 257;
 *
 * to `MOV EAX,0x6d38a8; SUB EAX,0x202`, and the decompile prints the folded 0x6d36a6,
 * which lies inside `gdwCrc32Table5` - a different object. In the image both spellings
 * are the same byte; in a rebuild the two objects move apart and the code reads CRC
 * words as length bases. Ghidra keeps the evidence on the instruction: the MOV's operand
 * carries a DATA reference to 0x6d38a8, the start of `lbase`. This records it, exactly:
 *
 *   R  ins  op  to  type  enc  [base]
 *                                  a DATA reference from operand `op` of `ins` to `to`
 *                                  (a non-executable block); `enc` 1 when the operand
 *                                  encodes the address (an immediate or displacement), 0
 *                                  when analysis propagated it there (`MOV [EBP-0x74],EAX`
 *                                  after the folded MOV/SUB); `base` for an offset
 *                                  reference (Ghidra's own "X + n" annotation)
 *   A  ins  to  value  at          the address `to` that `ins` loads into a register
 *                                  (MOV reg,imm / LEA reg,[imm]), after the ADD/SUB/LEA
 *                                  at `at` has made it `value`; followed through
 *                                  fall-through instructions only, up to the first
 *                                  instruction that writes the register otherwise or
 *                                  that another path jumps to (a loop's step is not a
 *                                  fold)
 *
 * so a pass can match a folded constant in the decompile to the instruction pair that
 * made it, rather than infer it from proximity. Read-only: one execute_script, no
 * transaction. A failure leaves the field unset, which is what an older snapshot looks
 * like too.
 */

import type { GhidraConnection, ExtractedFunction } from '../types.js';

/** One operand data reference. Addresses are bare 8-digit lower-case hex. */
export interface OperandRef {
  ins: string;
  op: number;
  to: string;
  /** Ghidra's RefType name: READ, WRITE, DATA, PARAM, READ_WRITE, ... */
  type: string;
  /**
   * The operand encodes the address (immediate or displacement). False for a reference
   * analysis propagated onto an instruction whose operand is a register.
   */
  encoded: boolean;
  /** For an offset reference: the base it is relative to. */
  base?: string;
}

/** An address loaded by `ins` (a reference to `to`) and adjusted to `value` at `at`. */
export interface DerivedAddress {
  ins: string;
  to: string;
  value: string;
  at: string;
}

export interface OperandRefFacts {
  refs: OperandRef[];
  derived: DerivedAddress[];
}

/**
 * Java, no imports (the body runs inside GhidraScript.run()). `__FUNCTIONS__` is
 * replaced by `;`-separated entry addresses, or the empty string for every function.
 */
export const OPERAND_REF_SCRIPT = `
String only = "__FUNCTIONS__";
ghidra.program.model.listing.Listing L = currentProgram.getListing();
ghidra.program.model.mem.Memory M = currentProgram.getMemory();
ghidra.program.model.address.AddressSpace sp = currentProgram.getAddressFactory().getDefaultAddressSpace();
java.util.List<ghidra.program.model.listing.Function> fns = new java.util.ArrayList<>();
if (only.length() == 0) {
  for (ghidra.program.model.listing.Function f : currentProgram.getFunctionManager().getFunctions(true)) fns.add(f);
} else {
  for (String a : only.split(";")) {
    if (a.length() == 0) continue;
    ghidra.program.model.listing.Function f = getFunctionAt(toAddr(a));
    if (f != null) fns.add(f);
  }
}
StringBuilder sb = new StringBuilder();
for (ghidra.program.model.listing.Function f : fns) {
  if (f.isThunk() || f.isExternal()) continue;
  boolean head = false;
  for (ghidra.program.model.listing.Instruction x : L.getInstructions(f.getBody(), true)) {
    for (ghidra.program.model.symbol.Reference r : x.getReferencesFrom()) {
      ghidra.program.model.address.Address to = r.getToAddress();
      ghidra.program.model.symbol.RefType rt = r.getReferenceType();
      if (!to.isMemoryAddress() || rt.isFlow() || r.getOperandIndex() < 0) continue;
      ghidra.program.model.mem.MemoryBlock b = M.getBlock(to);
      if (b == null || b.isExecute()) continue;
      if (!head) { sb.append("F\\t").append(f.getEntryPoint()).append('\\n'); head = true; }
      // Does the operand ENCODE the address (an immediate or a displacement), or did
      // analysis propagate it there (a store of a register holding a folded value)?
      boolean enc = false;
      for (Object o : x.getOpObjects(r.getOperandIndex())) {
        if (o instanceof ghidra.program.model.scalar.Scalar && ((ghidra.program.model.scalar.Scalar) o).getUnsignedValue() == to.getOffset()) enc = true;
        if (o instanceof ghidra.program.model.address.Address && ((ghidra.program.model.address.Address) o).getOffset() == to.getOffset()) enc = true;
      }
      sb.append("R\\t").append(x.getAddress()).append('\\t').append(r.getOperandIndex()).append('\\t').append(to).append('\\t').append(rt.getName()).append('\\t').append(enc ? "1" : "0");
      if (r.isOffsetReference()) sb.append('\\t').append(((ghidra.program.model.symbol.OffsetReference) r).getBaseAddress());
      sb.append('\\n');
      // The register the instruction loads the address into, if that is all it does.
      String mn = x.getMnemonicString();
      if (!(mn.equals("MOV") || mn.equals("LEA")) || x.getNumOperands() != 2) continue;
      Object[] d = x.getOpObjects(0); Object[] s = x.getOpObjects(1);
      if (!ghidra.program.model.lang.OperandType.isRegister(x.getOperandType(0))) continue;
      if (d.length != 1 || !(d[0] instanceof ghidra.program.model.lang.Register)) continue;
      if (s.length != 1 || !(s[0] instanceof ghidra.program.model.scalar.Scalar)) continue;
      long v = ((ghidra.program.model.scalar.Scalar) s[0]).getUnsignedValue();
      if (v != to.getOffset()) continue;
      ghidra.program.model.lang.Register reg = (ghidra.program.model.lang.Register) d[0];
      if (reg.getBitLength() != 32) continue;
      ghidra.program.model.listing.Instruction y = x;
      for (int k = 0; k < 8; k++) {
        if (y.getFallThrough() == null || y.getFlowType().isCall() || y.getFlowType().isJump()) break;
        y = L.getInstructionAt(y.getFallThrough());
        if (y == null || !f.getBody().contains(y.getAddress())) break;
        // A jump target joins another path: the register's value there is not this one.
        boolean joined = false;
        for (ghidra.program.model.symbol.Reference q : currentProgram.getReferenceManager().getReferencesTo(y.getAddress())) {
          if (q.getReferenceType().isFlow()) joined = true;
        }
        if (joined) break;
        String ym = y.getMnemonicString();
        Object[] y0 = y.getOpObjects(0); Object[] y1 = y.getNumOperands() > 1 ? y.getOpObjects(1) : new Object[0];
        boolean dstReg = y.getNumOperands() == 2 && ghidra.program.model.lang.OperandType.isRegister(y.getOperandType(0))
          && y0.length == 1 && y0[0] instanceof ghidra.program.model.lang.Register;
        // LEA r2,[reg + disp]: the derived value lands in r2.
        if (ym.equals("LEA") && dstReg && y1.length == 2 && reg.equals(y1[0]) && y1[1] instanceof ghidra.program.model.scalar.Scalar) {
          long nv = (v + ((ghidra.program.model.scalar.Scalar) y1[1]).getSignedValue()) & 0xffffffffL;
          sb.append("A\\t").append(x.getAddress()).append('\\t').append(to).append('\\t').append(sp.getAddress(nv)).append('\\t').append(y.getAddress()).append('\\n');
          if (reg.equals(y0[0])) { v = nv; continue; }
        }
        boolean writes = false;
        for (Object o : y.getResultObjects()) {
          if (o instanceof ghidra.program.model.lang.Register && ((ghidra.program.model.lang.Register) o).getBaseRegister().equals(reg.getBaseRegister())) writes = true;
        }
        if (!writes) continue;
        if ((ym.equals("ADD") || ym.equals("SUB")) && dstReg && reg.equals(y0[0]) && y1.length == 1 && y1[0] instanceof ghidra.program.model.scalar.Scalar) {
          long dv = ((ghidra.program.model.scalar.Scalar) y1[0]).getSignedValue();
          v = (ym.equals("ADD") ? v + dv : v - dv) & 0xffffffffL;
          sb.append("A\\t").append(x.getAddress()).append('\\t').append(to).append('\\t').append(sp.getAddress(v)).append('\\t').append(y.getAddress()).append('\\n');
          continue;
        }
        break;
      }
    }
  }
}
println(sb.toString());
`;

/** The script for every function (`entries` empty) or for the listed entry points. */
export function operandRefScript(entries: string[] = []): string {
  return OPERAND_REF_SCRIPT.replace('__FUNCTIONS__', entries.map(addressKey).join(';'));
}

function addressKey(address: string): string {
  const bare = address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
  return bare.replace(/^0x/i, '').toLowerCase().padStart(8, '0');
}

/** Parse the script's rows: `F` opens a function, `R` / `A` belong to the last one. */
export function parseOperandRefs(output: string): Map<string, OperandRefFacts> {
  const out = new Map<string, OperandRefFacts>();
  let cur: OperandRefFacts | undefined;
  for (const raw of output.split('\n')) {
    const c = raw.replace(/\r$/, '').split('\t');
    switch (c[0]) {
      case 'F':
        if (c.length < 2) { cur = undefined; break; }
        cur = { refs: [], derived: [] };
        out.set(addressKey(c[1]), cur);
        break;
      case 'R':
        if (!cur || c.length < 6) break;
        cur.refs.push({
          ins: addressKey(c[1]), op: Number(c[2]), to: addressKey(c[3]), type: c[4], encoded: c[5] === '1',
          ...(c[6] ? { base: addressKey(c[6]) } : {}),
        });
        break;
      case 'A':
        if (!cur || c.length < 5) break;
        cur.derived.push({ ins: addressKey(c[1]), to: addressKey(c[2]), value: addressKey(c[3]), at: addressKey(c[4]) });
        break;
    }
  }
  return out;
}

/**
 * Attach the facts to each function. A function the output covers and that has no
 * reference gets nothing (absent and empty mean the same to the passes). When `entries`
 * says which functions the run covered, those are cleared first, so a re-run drops a
 * reference that no longer exists.
 */
export function applyOperandRefs(
  facts: Map<string, OperandRefFacts>, functions: ExtractedFunction[], entries?: string[],
): number {
  const covered = entries ? new Set(entries.map(addressKey)) : undefined;
  let attached = 0;
  for (const func of functions) {
    const key = addressKey(func.address);
    if (!covered || covered.has(key)) delete func.operandRefs;
    const f = facts.get(key);
    if (!f) continue;
    func.operandRefs = f;
    attached++;
  }
  return attached;
}

/** Run the script (for every function, or the listed entries) and attach `operandRefs`. */
export async function attachOperandRefs(
  connection: GhidraConnection, functions: ExtractedFunction[], entries?: string[],
): Promise<number> {
  let output: string;
  try {
    const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
      'execute_script',
      { language: 'java', code: operandRefScript(entries ?? []), scriptTimeout: 600, _commandTimeout: 660000 }
    );
    if (result.success === false || typeof result.output !== 'string') {
      console.warn(`  Operand references unavailable: ${result.error ?? 'no output'}`);
      return 0;
    }
    output = result.output;
  } catch (err) {
    console.warn(`  Operand references unavailable: ${(err as Error).message}`);
    return 0;
  }
  return applyOperandRefs(parseOperandRefs(output), functions, entries);
}
