/**
 * Each comparison of a function's decompile, tied to the instructions that compiled it.
 *
 * Ghidra prints an ordered comparison with `<`/`<=` only and moves the constant to fit:
 * `CMP EDI,0x1450; JNC` prints as `0x144f < nByteOffset`, and `TEST EDX,EDX; JBE` as
 * `nCount != 0`. VC8 compiles each spelling as written, so the source form is read back off
 * the instructions (codegen/compare-form-spec.ts decides, the `compare-form` pass rewrites).
 *
 * The script decompiles each function again, with the options batch_decompile uses, and
 * walks the markup's operator tokens. A function whose C text hashes differently from the
 * extracted body is skipped: the token order is only meaningful for that exact text. For
 * every comparison token (`<`, `<=`, `>`, `>=`, `==`, `!=`, in text order) it records:
 *
 *   ord  text  opcode  size  cs  k  fp0  fp1  op  user  um  setter  sm  w  a  b  bv  pair
 *
 *   ord     the token's index among the comparison tokens
 *   text    the token as printed
 *   opcode  its PcodeOp (`-` when the token has none: no site, but the ordinal still counts)
 *   size    the size of the op's inputs
 *   cs      which input is a constant: 0, 1, or -1 for neither
 *   k       that constant, as an unsigned `size`-byte value in hex
 *   fp0/1   each input's fingerprint: `c:<hex>` for a constant, `v:<name>` for a variable
 *           (through CASTs), `e` for anything else
 *   op      the op's address
 *   user    the instruction that reads the flags: the Jcc of the CBRANCH the result reaches
 *           through BOOL_NEGATE, COPY or INT_ZEXT, else the first Jcc/SETcc after the op's
 *           own CMP/TEST; `um` its mnemonic
 *   setter  the nearest CMP/TEST before the user in the same block, at most 8 instructions
 *           back over MOV, LEA, PUSH, POP, MOVZX, MOVSX and NOP; `sm` its mnemonic
 *   w       the setter's operand width in bytes
 *   a       the setter's first operand: `r` register, `m` memory
 *   b       its second: `i` immediate (value `bv`, unsigned `w`-byte hex), `z` zero (TEST r,r,
 *           or a register the block zeroed by XOR/SUB r,r or MOV r,0), `r` register, `m`
 *           memory, `bit` a TEST of two different operands
 *   pair    1 when the op sits on the setter or the user: the tie is only trusted then
 *
 * Read-only: execute_script per batch, no transaction. A failure leaves the field unset,
 * which is also what an older snapshot looks like; the pass then changes nothing.
 */

import type { GhidraConnection, ExtractedFunction } from '../types.js';

/** One comparison token of a decompile, with the instructions behind it. */
export interface CompareSite {
  ord: number;
  text: string;
  /** Absent when the token carries no PcodeOp. */
  opcode?: string;
  size: number;
  /** 0 or 1: the constant input; -1: neither. */
  constSide: number;
  /** The constant input as an unsigned `size`-byte value. */
  k?: bigint;
  fp: [string, string];
  opAt: string;
  user?: { at: string; mnemonic: string };
  setter?: { at: string; mnemonic: string };
  width: number;
  aKind: string;
  bKind: string;
  bValue?: bigint;
  onPair: boolean;
}

/** The script body (Java, runs inside GhidraScript.run()); `__ITEMS__` is `addr;addr;...`. */
export const COMPARE_SITES_SCRIPT = `
String items = "__ITEMS__";
ghidra.app.decompiler.DecompInterface di = new ghidra.app.decompiler.DecompInterface();
ghidra.app.decompiler.DecompileOptions o = new ghidra.app.decompiler.DecompileOptions();
o.setConventionPrint(true);
o.setNoCastPrint(false);
o.setPRECommentIncluded(true);
o.setPLATECommentIncluded(true);
o.setPOSTCommentIncluded(true);
o.setEOLCommentIncluded(true);
o.setWARNCommentIncluded(true);
o.setHeadCommentIncluded(true);
o.setEliminateUnreachable(false);
try {
  java.lang.reflect.Field nsf = ghidra.app.decompiler.DecompileOptions.class.getDeclaredField("namespaceStrategy");
  nsf.setAccessible(true);
  nsf.set(o, ghidra.app.decompiler.DecompileOptions.NamespaceStrategy.All);
} catch (Exception e) {}
di.setOptions(o);
di.openProgram(currentProgram);
ghidra.program.model.listing.Listing L = currentProgram.getListing();
ghidra.program.model.symbol.ReferenceManager rm = currentProgram.getReferenceManager();
java.util.Set<String> passive = new java.util.HashSet<>(java.util.Arrays.asList("MOV", "LEA", "PUSH", "POP", "MOVZX", "MOVSX", "NOP"));
java.util.Set<String> cmpText = new java.util.HashSet<>(java.util.Arrays.asList("<", "<=", ">", ">=", "==", "!="));
StringBuilder sb = new StringBuilder();
for (String a : items.split(";")) {
  if (a.length() == 0) continue;
  ghidra.program.model.listing.Function f = getFunctionAt(toAddr(a));
  if (f == null) { sb.append("F\\t").append(a).append("\\tnull\\n"); continue; }
  ghidra.app.decompiler.DecompileResults res = di.decompileFunction(f, 30, monitor);
  if (res == null || !res.decompileCompleted() || res.getCCodeMarkup() == null) { sb.append("F\\t").append(a).append("\\tfail\\n"); continue; }
  String c = res.getDecompiledFunction().getC();
  sb.append("F\\t").append(a).append('\\t').append(Integer.toHexString(c.hashCode())).append('\\t').append(c.length()).append('\\n');
  java.util.List<ghidra.app.decompiler.ClangNode> toks = new java.util.ArrayList<>();
  res.getCCodeMarkup().flatten(toks);
  int ord = -1;
  for (ghidra.app.decompiler.ClangNode n : toks) {
    if (!(n instanceof ghidra.app.decompiler.ClangOpToken)) continue;
    ghidra.app.decompiler.ClangOpToken t = (ghidra.app.decompiler.ClangOpToken) n;
    String text = t.getText();
    if (!cmpText.contains(text)) continue;
    ord++;
    ghidra.program.model.pcode.PcodeOp op = t.getPcodeOp();
    if (op == null || op.getNumInputs() != 2) { sb.append("S\\t").append(ord).append('\\t').append(text).append("\\t-\\n"); continue; }
    String[] fp = new String[2];
    for (int i = 0; i < 2; i++) {
      ghidra.program.model.pcode.Varnode v = op.getInput(i);
      for (int h = 0; h < 3 && v != null && !v.isConstant() && v.getDef() != null && v.getDef().getOpcode() == ghidra.program.model.pcode.PcodeOp.CAST
          && (v.getHigh() == null || v.getHigh().getSymbol() == null); h++) v = v.getDef().getInput(0);
      if (v == null) fp[i] = "e";
      else if (v.isConstant()) fp[i] = "c:" + Long.toHexString(v.getOffset());
      else if (v.getHigh() != null && v.getHigh().getSymbol() != null) fp[i] = "v:" + v.getHigh().getSymbol().getName();
      else fp[i] = "e";
    }
    ghidra.program.model.pcode.Varnode i0 = op.getInput(0), i1 = op.getInput(1);
    int cs = i1.isConstant() ? 1 : i0.isConstant() ? 0 : -1;
    ghidra.program.model.address.Address opAt = op.getSeqnum().getTarget();
    // The branch the result reaches through negations and copies.
    ghidra.program.model.address.Address br = null;
    java.util.List<ghidra.program.model.pcode.Varnode> front = new java.util.ArrayList<>();
    if (op.getOutput() != null) front.add(op.getOutput());
    for (int h = 0; h < 4 && br == null && !front.isEmpty(); h++) {
      java.util.List<ghidra.program.model.pcode.Varnode> next = new java.util.ArrayList<>();
      for (ghidra.program.model.pcode.Varnode v : front) {
        java.util.Iterator<ghidra.program.model.pcode.PcodeOp> it = v.getDescendants();
        while (it.hasNext()) {
          ghidra.program.model.pcode.PcodeOp d = it.next();
          int dc = d.getOpcode();
          if (dc == ghidra.program.model.pcode.PcodeOp.CBRANCH && br == null) br = d.getSeqnum().getTarget();
          else if ((dc == ghidra.program.model.pcode.PcodeOp.BOOL_NEGATE || dc == ghidra.program.model.pcode.PcodeOp.COPY
              || dc == ghidra.program.model.pcode.PcodeOp.INT_ZEXT) && d.getOutput() != null) next.add(d.getOutput());
        }
      }
      front = next;
    }
    // The instruction that reads the flags: the branch's, or the first after the op's own.
    ghidra.program.model.listing.Instruction user = null;
    ghidra.program.model.listing.Instruction at = L.getInstructionAt(opAt);
    if (br != null) user = L.getInstructionAt(br);
    else if (at != null) {
      String m = at.getMnemonicString();
      if (m.startsWith("J") || m.startsWith("SET")) user = at;
      else if (m.equals("CMP") || m.equals("TEST")) {
        ghidra.program.model.listing.Instruction q = at;
        for (int s = 0; s < 8 && q != null; s++) {
          ghidra.program.model.address.Address ft = q.getFallThrough();
          q = ft == null ? null : L.getInstructionAt(ft);
          if (q == null) break;
          String qm = q.getMnemonicString();
          if (qm.startsWith("J") || qm.startsWith("SET")) { user = q; break; }
          if (!passive.contains(qm)) break;
        }
      }
    }
    String um = user == null ? "-" : user.getMnemonicString();
    if (user != null && !(um.startsWith("J") && !um.equals("JMP")) && !um.startsWith("SET")) user = null;
    // The flags setter: the nearest CMP/TEST before the user in the same block.
    ghidra.program.model.listing.Instruction setter = null;
    if (user != null) {
      ghidra.program.model.listing.Instruction q = user;
      for (int s = 0; s < 9; s++) {
        boolean entered = false;
        for (ghidra.program.model.symbol.Reference r : rm.getReferencesTo(q.getAddress())) if (r.getReferenceType().isFlow()) entered = true;
        if (entered) break;
        ghidra.program.model.listing.Instruction p = L.getInstructionBefore(q.getAddress());
        if (p == null || p.getFallThrough() == null || !p.getFallThrough().equals(q.getAddress())) break;
        String pm = p.getMnemonicString();
        if (pm.equals("CMP") || pm.equals("TEST")) { setter = p; break; }
        if (!passive.contains(pm)) break;
        q = p;
      }
    }
    String bKind = "-", bVal = "-", aKind = "-";
    int w = 0;
    if (setter != null) {
      for (ghidra.program.model.pcode.PcodeOp po : setter.getPcode()) {
        int pc = po.getOpcode();
        if (pc == ghidra.program.model.pcode.PcodeOp.INT_SUB || pc == ghidra.program.model.pcode.PcodeOp.INT_AND
            || pc == ghidra.program.model.pcode.PcodeOp.INT_LESS) { w = po.getInput(0).getSize(); break; }
      }
      int t0 = setter.getOperandType(0), t1 = setter.getOperandType(1);
      aKind = ghidra.program.model.lang.OperandType.isRegister(t0) ? "r" : "m";
      boolean sameReg = ghidra.program.model.lang.OperandType.isRegister(t0) && ghidra.program.model.lang.OperandType.isRegister(t1)
          && setter.getRegister(0) != null && setter.getRegister(0).equals(setter.getRegister(1));
      if (setter.getMnemonicString().equals("TEST")) {
        if (sameReg) { bKind = "z"; bVal = "0"; } else { bKind = "bit"; }
      } else if (ghidra.program.model.lang.OperandType.isScalar(t1) && setter.getScalar(1) != null) {
        long sv = setter.getScalar(1).getSignedValue();
        long mask = w >= 8 ? -1L : (1L << (8 * w)) - 1;
        bKind = "i"; bVal = Long.toHexString(sv & mask);
      } else if (ghidra.program.model.lang.OperandType.isRegister(t1) && setter.getRegister(1) != null) {
        bKind = "r";
        // A register the block zeroed before the compare.
        ghidra.program.model.lang.Register rg = setter.getRegister(1);
        ghidra.program.model.listing.Instruction q = setter;
        for (int s = 0; s < 16; s++) {
          boolean entered = false;
          for (ghidra.program.model.symbol.Reference r : rm.getReferencesTo(q.getAddress())) if (r.getReferenceType().isFlow()) entered = true;
          if (entered) break;
          ghidra.program.model.listing.Instruction p = L.getInstructionBefore(q.getAddress());
          if (p == null || p.getFallThrough() == null || !p.getFallThrough().equals(q.getAddress())) break;
          boolean writes = false;
          for (Object ro : p.getResultObjects()) if (ro instanceof ghidra.program.model.lang.Register && (((ghidra.program.model.lang.Register) ro).contains(rg) || rg.contains((ghidra.program.model.lang.Register) ro))) writes = true;
          if (writes) {
            String pm = p.getMnemonicString();
            boolean zero = (pm.equals("XOR") || pm.equals("SUB")) && p.getRegister(0) != null && p.getRegister(0).equals(p.getRegister(1)) && p.getRegister(0).contains(rg);
            if (!zero && pm.equals("MOV") && p.getRegister(0) != null && p.getRegister(0).contains(rg)
                && ghidra.program.model.lang.OperandType.isScalar(p.getOperandType(1)) && p.getScalar(1) != null && p.getScalar(1).getValue() == 0) zero = true;
            if (zero) { bKind = "z"; bVal = "0"; }
            break;
          }
          q = p;
        }
      } else bKind = "m";
    }
    // The tie holds only when the op sits on the setter or on the user.
    boolean onPair = setter != null && (opAt.equals(setter.getAddress()) || opAt.equals(user.getAddress()));
    sb.append("S\\t").append(ord).append('\\t').append(text).append('\\t').append(op.getMnemonic())
      .append('\\t').append(i0.getSize()).append('\\t').append(cs)
      .append('\\t').append(cs < 0 ? "-" : Long.toHexString(op.getInput(cs).getOffset()))
      .append('\\t').append(fp[0]).append('\\t').append(fp[1])
      .append('\\t').append(opAt)
      .append('\\t').append(user == null ? "-" : user.getAddress().toString()).append('\\t').append(user == null ? "-" : user.getMnemonicString())
      .append('\\t').append(setter == null ? "-" : setter.getAddress().toString()).append('\\t').append(setter == null ? "-" : setter.getMnemonicString())
      .append('\\t').append(w).append('\\t').append(aKind).append('\\t').append(bKind).append('\\t').append(bVal)
      .append('\\t').append(onPair ? 1 : 0).append('\\n');
  }
}
di.dispose();
println(sb.toString());
`;

/** Java's String.hashCode, over UTF-16 code units: the script's gate on the decompile text. */
export function javaStringHash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return h >>> 0;
}

const COMPARISON = /[<>]=?|[=!]=/;

/** Addresses of the decompiled functions that print a comparison at all, in batches. */
export function compareSiteBatches(functions: Pick<ExtractedFunction, 'address' | 'decompiled'>[], batchSize = 150): string[][] {
  const items: string[] = [];
  for (const f of functions) if (f.decompiled && COMPARISON.test(f.decompiled)) items.push(normalize(f.address));
  const out: string[][] = [];
  for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
  return out;
}

/** The script for one batch. */
export function compareSitesScript(batch: string[]): string {
  return COMPARE_SITES_SCRIPT.replace('__ITEMS__', batch.join(';'));
}

export interface CompareSiteBlock {
  /** Java String.hashCode of the decompile the script read, unsigned. */
  hash: number;
  length: number;
  /** The `S` rows, without the tag: the form `compareSites` stores. */
  rows: string;
}

/** The script's output: function address -> its hash and rows. Failed functions are absent. */
export function parseCompareSiteOutput(output: string): Map<string, CompareSiteBlock> {
  const out = new Map<string, CompareSiteBlock>();
  let cur: CompareSiteBlock | null = null;
  const rows: string[] = [];
  const flush = () => { if (cur) { cur.rows = rows.join('\n'); rows.length = 0; } };
  for (const line of output.split('\n')) {
    const c = line.replace(/\r$/, '').split('\t');
    if (c[0] === 'F') {
      flush();
      cur = null;
      if (c.length < 4 || !/^[0-9a-f]+$/i.test(c[2])) continue;
      cur = { hash: Number.parseInt(c[2], 16), length: Number(c[3]), rows: '' };
      out.set(normalize(c[1]), cur);
    } else if (c[0] === 'S' && cur) {
      rows.push(c.slice(1).join('\t'));
    }
  }
  flush();
  return out;
}

/** The rows of `compareSites`, parsed. A malformed row is dropped; its ordinal stays counted by the others. */
export function compareSiteRows(rows: string | undefined): CompareSite[] {
  if (!rows) return [];
  const out: CompareSite[] = [];
  for (const line of rows.split('\n')) {
    const c = line.split('\t');
    if (c.length < 3 || !/^\d+$/.test(c[0])) continue;
    const ord = Number(c[0]);
    if (c[2] === '-' || c.length < 18) {
      out.push({ ord, text: c[1], size: 0, constSide: -1, fp: ['e', 'e'], opAt: '-', width: 0, aKind: '-', bKind: '-', onPair: false });
      continue;
    }
    const hex = (s: string) => (/^[0-9a-f]+$/i.test(s) ? BigInt(`0x${s}`) : undefined);
    out.push({
      ord, text: c[1], opcode: c[2], size: Number(c[3]), constSide: Number(c[4]),
      k: hex(c[5]),
      fp: [c[6], c[7]],
      opAt: normalize(c[8]),
      ...(c[9] !== '-' ? { user: { at: normalize(c[9]), mnemonic: c[10] } } : {}),
      ...(c[11] !== '-' ? { setter: { at: normalize(c[11]), mnemonic: c[12] } } : {}),
      width: Number(c[13]), aKind: c[14], bKind: c[15], bValue: hex(c[16]),
      onPair: c[17] === '1',
    });
  }
  return out;
}

function normalize(a: string): string {
  return a.replace(/^0x/i, '').toLowerCase().padStart(8, '0');
}

/**
 * Run the script over every decompiled function that prints a comparison and attach
 * `compareSites` where the script read the same text. Returns the number of functions
 * that got rows.
 */
export async function extractCompareSites(connection: GhidraConnection, functions: ExtractedFunction[], concurrency = 4): Promise<number> {
  const byAddr = new Map(functions.map(f => [normalize(f.address), f]));
  const batches = compareSiteBatches(functions);
  let n = 0;
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
        'execute_script',
        { language: 'java', code: compareSitesScript(batch), scriptTimeout: 900, _commandTimeout: 960000 }
      );
      if (result.success === false || typeof result.output !== 'string') throw new Error(result.error ?? 'no output');
      for (const [fn, block] of parseCompareSiteOutput(result.output)) {
        const f = byAddr.get(fn);
        if (!f?.decompiled || !block.rows) continue;
        if (f.decompiled.length !== block.length || javaStringHash(f.decompiled) !== block.hash) continue;
        f.compareSites = block.rows;
        n++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return n;
}
