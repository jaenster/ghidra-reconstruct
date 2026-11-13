/**
 * ROUND tokens whose native FISTP explicitly selects x87 RC=truncate. Ghidra does
 * not carry the preceding FLDCW into FLOAT_ROUND: `(int)ROUND(x)` is a plain C
 * conversion here, rather than `(int)std::nearbyint(x)` in the caller's mode.
 *
 * Facts count every printed ROUND and select ordinals only after a native proof.
 * They belong to the exact decompile text, through function-facts' hash gate.
 * The proof deliberately recognizes only the VC8 EBP/EAX control-word idiom;
 * unknown encodings, stores, stack pushes and interior flow entries fail closed.
 */
export interface TruncatingRoundSite { ord: number; width: 4 | 8 }
export interface TruncatingRoundFacts { count: number; sites: TruncatingRoundSite[] }

/** Java helper separated so its native proof can be compiled and exercised with fixtures. */
export const TRUNCATING_ROUND_PROOF_JAVA = `
class TruncatingRoundInstruction {
  byte[] bytes;
  String mnemonic, destBase;
  boolean flowEntry, fallThrough, boundary;
  TruncatingRoundInstruction(byte[] bytes, String mnemonic, String destBase,
      boolean flowEntry, boolean fallThrough, boolean boundary) {
    this.bytes=bytes; this.mnemonic=mnemonic; this.destBase=destBase;
    this.flowEntry=flowEntry; this.fallThrough=fallThrough; this.boundary=boundary;
  }
}
class TruncatingRoundProof {
  // EBP + signed disp8/disp32, exactly one ModR/M memory operand, no prefixes/SIB.
  Integer slot(byte[] b, int prefix, int opcode, int extension) {
    int p = prefix < 0 ? 0 : 1;
    if (b.length < p + 3 || (prefix >= 0 && (b[0] & 255) != prefix)
        || (b[p] & 255) != opcode) return null;
    int m = b[p + 1] & 255, mod = m >>> 6;
    if ((m & 7) != 5 || ((m >>> 3) & 7) != extension) return null;
    if (mod == 1 && b.length == p + 3) return (int)b[p + 2];
    if (mod == 2 && b.length == p + 6)
      return (b[p+2]&255) | ((b[p+3]&255)<<8) | ((b[p+4]&255)<<16) | (b[p+5]<<24);
    return null;
  }
  boolean orTruncate(byte[] b) {
    return java.util.Arrays.equals(b, new byte[]{0x0d,0,0x0c,0,0})
        || java.util.Arrays.equals(b, new byte[]{(byte)0x81,(byte)0xc8,0,0x0c,0,0});
  }
  boolean passive(TruncatingRoundInstruction i, boolean protectEax, boolean afterLoad) {
    String m = i.mnemonic.toUpperCase(java.util.Locale.ROOT);
    if (!afterLoad && java.util.Arrays.asList("FLD","FILD","FMUL","FMULP","FADD","FADDP",
        "FSUB","FSUBP","FSUBR","FSUBRP","FDIV","FDIVP","FDIVR","FDIVRP","FXCH").contains(m)) return true;
    if (m.equals("NOP") || m.equals("CMP") || m.equals("TEST")) return true;
    if (!java.util.Arrays.asList("MOV","MOVZX","MOVSX","ADD","SUB","AND","OR","XOR",
        "SHR","SHL","SAR","POP").contains(m) || i.destBase == null) return false;
    // Changing EBP invalidates every slot. ESP changes alone do not write memory;
    // PUSH and every memory destination are excluded above.
    return !i.destBase.equals("EBP") && (!protectEax || !i.destBase.equals("EAX"));
  }
  int width(java.util.List<TruncatingRoundInstruction> seq) {
    if (seq.size() < 6 || seq.size() > 20) return 0;
    TruncatingRoundInstruction end = seq.get(seq.size()-1);
    if (!end.mnemonic.equalsIgnoreCase("FISTP")) return 0;
    byte[] last = end.bytes;
    int width = slot(last,-1,0xdb,3) != null ? 4 : slot(last,-1,0xdf,7) != null ? 8 : 0;
    if (width == 0) return 0;
    for (int k = 0; k < seq.size(); k++) {
      TruncatingRoundInstruction i = seq.get(k);
      if (i.boundary || (k > 0 && i.flowEntry) || (k < seq.size()-1 && !i.fallThrough)) return 0;
    }
    Integer saved = slot(seq.get(0).bytes,-1,0xd9,7), temp = null;
    if (saved == null) return 0;
    int state = 0;
    for (int k = 1; k < seq.size()-1; k++) {
      TruncatingRoundInstruction i = seq.get(k);
      byte[] b = i.bytes;
      if (state == 0 && saved.equals(slot(b,0x0f,0xb7,0))) { state = 1; continue; }
      if (state == 1 && orTruncate(b)) { state = 2; continue; }
      Integer dest = slot(b,-1,0x89,0);
      if (state == 2 && dest != null) {
        if ((long)dest < (long)saved+2 && (long)saved < (long)dest+4) return 0;
        temp = dest; state = 3; continue;
      }
      if (state == 3 && temp.equals(slot(b,-1,0xd9,5))) { state = 4; continue; }
      if (!passive(i, state == 1 || state == 2, state == 4)) return 0;
    }
    return state == 4 ? width : 0;
  }
}
`;

export const TRUNCATING_ROUNDS_JAVA = `
          StringBuilder urow = new StringBuilder();
          try {
            if (ctext != null && ctext.contains("ROUND")
                && prog.getLanguage().getLanguageID().toString().startsWith("x86:LE:32:")) {
              ${TRUNCATING_ROUND_PROOF_JAVA}
              TruncatingRoundProof proof = new TruncatingRoundProof();
              int ucount = 0;
              StringBuilder usites = new StringBuilder();
              for (ghidra.app.decompiler.ClangNode n : toks) {
                if (!(n instanceof ghidra.app.decompiler.ClangToken)
                    || !((ghidra.app.decompiler.ClangToken)n).getText().equals("ROUND")) continue;
                int ord = ucount++;
                ghidra.program.model.pcode.PcodeOp op = ((ghidra.app.decompiler.ClangToken)n).getPcodeOp();
                if (op == null || op.getOpcode() != ghidra.program.model.pcode.PcodeOp.FLOAT_ROUND
                    || op.getOutput() == null || op.getSeqnum() == null) continue;
                ghidra.program.model.pcode.PcodeOp use = op.getOutput().getLoneDescend();
                if (use == null || use.getOpcode() != ghidra.program.model.pcode.PcodeOp.FLOAT_TRUNC
                    || use.getOutput() == null) continue;
                java.util.List<TruncatingRoundInstruction> seq = new java.util.ArrayList<>();
                ghidra.program.model.listing.Instruction cur = L.getInstructionAt(op.getSeqnum().getTarget());
                ghidra.program.model.address.Address following = null;
                for (int k = 0; cur != null && k < 20; k++) {
                  if (!fn.getBody().contains(cur.getAddress())) { seq.clear(); break; }
                  boolean entry = false;
                  for (ghidra.program.model.symbol.Reference rf : rm.getReferencesTo(cur.getAddress()))
                    if (rf.getReferenceType().isFlow()) entry = true;
                  ghidra.program.model.lang.Register dest = cur.getNumOperands() > 0
                      && ghidra.program.model.lang.OperandType.isRegister(cur.getOperandType(0)) ? cur.getRegister(0) : null;
                  boolean next = following == null || (cur.getFallThrough() != null && cur.getFallThrough().equals(following));
                  seq.add(0,new TruncatingRoundInstruction(cur.getBytes(),cur.getMnemonicString(),
                      dest == null ? null : dest.getBaseRegister().getName(),entry,next,
                      cur.getFlowType().isCall() || cur.getFlowType().isJump() || cur.getFlowType().isTerminal()));
                  if (proof.slot(cur.getBytes(),-1,0xd9,7) != null) break;
                  following = cur.getAddress();
                  cur = L.getInstructionBefore(cur.getAddress());
                }
                int width = proof.width(seq);
                if (width != 0 && use.getOutput().getSize() == width)
                  usites.append(';').append(ord).append(':').append(width);
              }
              if (usites.length() > 0) urow.append(ucount).append(usites);
            }
          } catch (Exception ue) { urow.setLength(0); }
`;

export function printsRound(text: string): boolean { return /\bROUND\s*\(/.test(text); }

export function parseTruncatingRoundRow(row: string): TruncatingRoundFacts | null {
  const [rawCount, ...rawSites] = row.split(';');
  if (!/^\d+$/.test(rawCount)) return null;
  const count = Number(rawCount);
  if (!Number.isSafeInteger(count) || count < 1) return null;
  const sites: TruncatingRoundSite[] = [];
  const seen = new Set<number>();
  for (const raw of rawSites) {
    const m = /^(\d+):(4|8)$/.exec(raw);
    if (!m) return null;
    const ord = Number(m[1]);
    if (!Number.isSafeInteger(ord) || ord >= count || seen.has(ord)) return null;
    seen.add(ord);
    sites.push({ ord, width: Number(m[2]) as 4 | 8 });
  }
  return sites.length ? { count, sites } : null;
}
