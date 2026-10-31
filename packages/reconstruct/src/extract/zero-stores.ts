/**
 * Which bytes of each struct-typed stack local the original's first stores to it write, and
 * which of those it writes with zero, read from the instructions.
 *
 * `T s = {0};` compiles to a zero store per member; the decompiler prints those stores and
 * drops the ones a later assignment overwrites, so a decompile cannot tell `T s = {0};` from
 * members cleared one by one. The instructions keep every zero store the compiler emitted.
 * The `aggregate-zero-init` pass only writes the initialiser where this fact shows the
 * original zeroing every member byte:
 *
 *   name    the decompiler's name for the local
 *   offset  its stack offset (the frame offsets Ghidra's stack references use), size its size
 *   zero    the bytes, relative to the local, the opening run stores zero to
 *   other   the bytes the opening run stores anything else to
 *
 * The opening run is every store to the local, in address order, up to the first instruction
 * that reads it, takes its address for anything but a zeroing `rep stos`, or writes it in
 * place (`add [s], 1`). A store is a zero store when its value is the constant 0 or a
 * register the same block set to 0 (`xor eax, eax`, `mov eax, 0`) with nothing writing it
 * since; a `rep stos` counts when EDI is a `lea` of the local, ECX a known count and EAX
 * (AX, AL) a known zero, all from the same block. A byte keeps what its first store wrote.
 *
 * Read-only: part of the per-function facts script (function-facts.ts), no transaction. A
 * failure leaves the field unset; the pass then changes nothing, since it needs this fact.
 */

export interface ZeroStoreLocal {
  name: string;
  offset: number;
  size: number;
  /** [from, to) byte ranges relative to the local, ascending and disjoint. */
  zero: [number, number][];
  other: [number, number][];
}

export type ZeroStoreFacts = ZeroStoreLocal[];

/**
 * Java fragment, run per function inside the facts script with `r` (the decompile results),
 * `fn`, `L` (the listing), `rm` (the reference manager) and `prog` in scope. Leaves the row
 * in `zrow`: `name,offset,size,zero,other;...` with offset signed hex, the ranges `a-b|c-d`.
 */
export const ZERO_STORES_JAVA = `
          StringBuilder zrow = new StringBuilder();
          try {
            ghidra.program.model.pcode.HighFunction zh = r.getHighFunction();
            java.util.List<String> zNames = new java.util.ArrayList<>();
            java.util.List<long[]> zSpans = new java.util.ArrayList<>();
            if (zh != null) {
              java.util.Iterator<ghidra.program.model.pcode.HighSymbol> zit = zh.getLocalSymbolMap().getSymbols();
              while (zit.hasNext()) {
                ghidra.program.model.pcode.HighSymbol zs = zit.next();
                if (zs.isParameter()) continue;
                ghidra.program.model.listing.VariableStorage zst = zs.getStorage();
                if (zst == null || !zst.isStackStorage()) continue;
                ghidra.program.model.data.DataType zdt = zs.getDataType();
                for (int d = 0; d < 8 && zdt instanceof ghidra.program.model.data.TypeDef; d++) zdt = ((ghidra.program.model.data.TypeDef) zdt).getBaseDataType();
                if (!(zdt instanceof ghidra.program.model.data.Structure) && !(zdt instanceof ghidra.program.model.data.Union)) continue;
                int zsz = zs.getSize();
                if (zsz < 2 || zsz > 0x10000) continue;
                zNames.add(zs.getName());
                zSpans.add(new long[] { zst.getStackOffset(), zsz });
              }
            }
            if (!zNames.isEmpty()) {
              int zn = zNames.size();
              java.util.BitSet[] zZero = new java.util.BitSet[zn], zOther = new java.util.BitSet[zn];
              boolean[] zOpen = new boolean[zn];
              for (int k = 0; k < zn; k++) { zZero[k] = new java.util.BitSet(); zOther[k] = new java.util.BitSet(); zOpen[k] = true; }
              ghidra.program.model.lang.Register zEax = prog.getRegister("EAX"), zEcx = prog.getRegister("ECX"), zEdi = prog.getRegister("EDI");
              // Pass 1: register values within a block, to find the zeroing rep stos and the LEAs that feed them.
              java.util.Map<ghidra.program.model.address.Address, long[]> zStos = new java.util.HashMap<>();
              java.util.Set<ghidra.program.model.address.Address> zFeeds = new java.util.HashSet<>();
              java.util.Map<ghidra.program.model.address.Address, Boolean> zZeroSrc = new java.util.HashMap<>();
              for (int pass = 0; pass < 2; pass++) {
                java.util.Map<ghidra.program.model.lang.Register, Long> zImm = new java.util.HashMap<>();
                java.util.Map<ghidra.program.model.lang.Register, Object[]> zLea = new java.util.HashMap<>();
                ghidra.program.model.listing.InstructionIterator zi = L.getInstructions(fn.getBody(), true);
                while (zi.hasNext()) {
                  ghidra.program.model.listing.Instruction ins = zi.next();
                  boolean entered = false;
                  for (ghidra.program.model.symbol.Reference rf : rm.getReferencesTo(ins.getAddress())) if (rf.getReferenceType().isFlow()) entered = true;
                  if (entered) { zImm.clear(); zLea.clear(); }
                  String zm = ins.getMnemonicString();
                  java.util.List<ghidra.program.model.symbol.StackReference> srefs = new java.util.ArrayList<>();
                  for (ghidra.program.model.symbol.Reference rf : rm.getReferencesFrom(ins.getAddress())) {
                    if (rf instanceof ghidra.program.model.symbol.StackReference) srefs.add((ghidra.program.model.symbol.StackReference) rf);
                  }
                  if (pass == 1) {
                    long[] cover = zStos.get(ins.getAddress());
                    if (cover != null) {
                      for (int k = 0; k < zn; k++) {
                        if (!zOpen[k]) continue;
                        long lo = Math.max(cover[0], zSpans.get(k)[0]), hi = Math.min(cover[0] + cover[1], zSpans.get(k)[0] + zSpans.get(k)[1]);
                        for (long b = lo; b < hi; b++) {
                          int rb = (int) (b - zSpans.get(k)[0]);
                          if (!zZero[k].get(rb) && !zOther[k].get(rb)) zZero[k].set(rb);
                        }
                      }
                    } else if (!zFeeds.contains(ins.getAddress()) && !srefs.isEmpty()) {
                      // The value a STORE writes, and its size.
                      int stSize = -1; Boolean stZero = null;
                      for (ghidra.program.model.pcode.PcodeOp po : ins.getPcode()) {
                        if (po.getOpcode() != ghidra.program.model.pcode.PcodeOp.STORE) continue;
                        ghidra.program.model.pcode.Varnode v = po.getInput(2);
                        stSize = v.getSize();
                        if (v.isConstant()) stZero = v.getOffset() == 0;
                        else if (v.isRegister()) {
                          ghidra.program.model.lang.Register vr = prog.getRegister(v.getAddress(), v.getSize());
                          boolean z = false;
                          for (java.util.Map.Entry<ghidra.program.model.lang.Register, Long> e : zImm.entrySet()) {
                            if (vr != null && e.getValue() == 0L && e.getKey().contains(vr)) z = true;
                          }
                          stZero = z;
                        } else stZero = false;
                      }
                      for (ghidra.program.model.symbol.StackReference sr : srefs) {
                        long so = sr.getStackOffset();
                        boolean store = stSize > 0 && sr.getReferenceType().isWrite() && !sr.getReferenceType().isRead();
                        for (int k = 0; k < zn; k++) {
                          long lo0 = zSpans.get(k)[0], hi0 = lo0 + zSpans.get(k)[1];
                          if (!zOpen[k]) continue;
                          long end = store ? so + stSize : so + 1;
                          if (end <= lo0 || so >= hi0) continue;
                          if (!store) { zOpen[k] = false; continue; }
                          for (long b = Math.max(so, lo0); b < Math.min(end, hi0); b++) {
                            int rb = (int) (b - lo0);
                            if (zZero[k].get(rb) || zOther[k].get(rb)) continue;
                            if (stZero != null && stZero) zZero[k].set(rb); else zOther[k].set(rb);
                          }
                        }
                      }
                    }
                  }
                  // Register state after this instruction.
                  if (pass == 0 && zm.contains(".REP") && zm.startsWith("STOS")) {
                    Object[] src = zLea.get(zEdi);
                    Long cnt = zImm.get(zEcx);
                    Long val = null;
                    for (java.util.Map.Entry<ghidra.program.model.lang.Register, Long> e : zImm.entrySet()) if (e.getKey().equals(zEax)) val = e.getValue();
                    int unit = zm.startsWith("STOSD") ? 4 : zm.startsWith("STOSW") ? 2 : 1;
                    if (src != null && cnt != null && val != null && val == 0L) {
                      zStos.put(ins.getAddress(), new long[] { (Long) src[1], cnt * unit });
                      zFeeds.add((ghidra.program.model.address.Address) src[0]);
                    }
                  }
                  if (ins.getFlowType().isCall()) { zImm.clear(); zLea.clear(); continue; }
                  java.util.List<ghidra.program.model.lang.Register> written = new java.util.ArrayList<>();
                  for (Object ro : ins.getResultObjects()) if (ro instanceof ghidra.program.model.lang.Register) written.add((ghidra.program.model.lang.Register) ro);
                  for (ghidra.program.model.lang.Register w : written) {
                    zImm.keySet().removeIf(k2 -> k2.contains(w) || w.contains(k2));
                    zLea.keySet().removeIf(k2 -> k2.contains(w) || w.contains(k2));
                  }
                  ghidra.program.model.lang.Register d0 = ins.getNumOperands() > 0 ? ins.getRegister(0) : null;
                  if (d0 != null && d0.getBitLength() == 32 && ins.getNumOperands() == 2) {
                    ghidra.program.model.scalar.Scalar s1 = ghidra.program.model.lang.OperandType.isScalar(ins.getOperandType(1)) ? ins.getScalar(1) : null;
                    if (zm.equals("MOV") && s1 != null) zImm.put(d0, s1.getUnsignedValue() & 0xffffffffL);
                    else if ((zm.equals("XOR") || zm.equals("SUB")) && d0.equals(ins.getRegister(1))) zImm.put(d0, 0L);
                    else if (zm.equals("OR") && s1 != null && s1.getSignedValue() == -1) zImm.put(d0, 0xffffffffL);
                    else if (zm.equals("LEA") && srefs.size() == 1) zLea.put(d0, new Object[] { ins.getAddress(), srefs.get(0).getStackOffset() });
                  }
                }
              }
              for (int k = 0; k < zn; k++) {
                StringBuilder zr = new StringBuilder(), orr = new StringBuilder();
                for (int pass = 0; pass < 2; pass++) {
                  java.util.BitSet bs = pass == 0 ? zZero[k] : zOther[k];
                  StringBuilder sbz = pass == 0 ? zr : orr;
                  for (int b = bs.nextSetBit(0); b >= 0; ) {
                    int e = bs.nextClearBit(b);
                    sbz.append(sbz.length() > 0 ? "|" : "").append(Integer.toHexString(b)).append('-').append(Integer.toHexString(e));
                    b = bs.nextSetBit(e);
                  }
                }
                long zo = zSpans.get(k)[0];
                zrow.append(zrow.length() > 0 ? ";" : "").append(zNames.get(k)).append(',')
                  .append(zo < 0 ? "-" + Long.toHexString(-zo) : Long.toHexString(zo)).append(',')
                  .append(Long.toHexString(zSpans.get(k)[1])).append(',').append(zr).append(',').append(orr);
              }
            }
          } catch (Exception ze) { zrow.setLength(0); }
`;

/** A member store of a constant zero: the decompiles whose struct locals are read. */
const MEMBER_ZERO_STORE = /[A-Za-z_]\w*\.[A-Za-z_][\w.]*\s*=\s*(?:\([^()]*\)\s*)?(?:0|0x0|'\\0'|NULL)\s*;/;

export function printsMemberZeroStore(decompiled: string): boolean {
  return MEMBER_ZERO_STORE.test(decompiled);
}

/** One function's row, parsed; malformed locals are dropped. */
export function parseZeroStoreRow(row: string): ZeroStoreFacts {
  const out: ZeroStoreFacts = [];
  const ranges = (s: string): [number, number][] | null => {
    if (s === '') return [];
    const r: [number, number][] = [];
    for (const p of s.split('|')) {
      const m = /^([0-9a-f]+)-([0-9a-f]+)$/i.exec(p);
      if (!m) return null;
      r.push([Number.parseInt(m[1], 16), Number.parseInt(m[2], 16)]);
    }
    return r;
  };
  for (const item of row.split(';')) {
    const c = item.split(',');
    if (c.length !== 5 || !/^[A-Za-z_]\w*$/.test(c[0]) || !/^-?[0-9a-f]+$/i.test(c[1]) || !/^[0-9a-f]+$/i.test(c[2])) continue;
    const zero = ranges(c[3]), other = ranges(c[4]);
    if (!zero || !other) continue;
    const off = c[1].startsWith('-') ? -Number.parseInt(c[1].slice(1), 16) : Number.parseInt(c[1], 16);
    out.push({ name: c[0], offset: off, size: Number.parseInt(c[2], 16), zero, other });
  }
  return out;
}
