/**
 * Where each line of a function's decompile lies in the binary.
 *
 * VC8 lays an `if` out by its source shape: the arm the source wrote first comes first (an
 * `||` condition puts the else first), and a leaving then-arm outside a loop sits inline.
 * The decompiler does not order arms by address, and the generator's own guard flattening
 * reorders them again, so the shape we print can contradict the original's layout while
 * meaning the same thing. The `branch-layout` pass reads the original order from here:
 *
 *   lines   decompile line -> the code offsets (from the function entry) of the p-code ops
 *           its tokens print, comments excluded
 *   ifs     decompile line of an `if` keyword -> the offset of its conditional branch
 *           (the keyword token carries the CBRANCH's address)
 *   tests   decompile line -> each `==`/`!=` token on it, with the instruction its p-code op
 *           sits on: mnemonic, first register operand, the amount a SUB/ADD/DEC/INC takes
 *           off the register, the constant compared against, the operand size and the
 *           instruction's offset. VC8 lowers a short switch to running subtractions
 *           (`sub ecx, 1; je; sub ecx, 3; je`) and an if-chain to CMPs; the decompiler
 *           prints both as equality tests, so this is what tells them apart.
 *   operands decompile line of an `if` whose condition is a short-circuit chain -> per
 *           leaf operand of its `&&`/`||` operators at any depth (text order), the offsets
 *           of the conditional branches its tokens feed. The `if` keyword carries only the last test's branch;
 *           this says where each test jumps from, so a leaving arm laid out among the tests
 *           can be placed after a particular one.
 *   returns every RET of the function with the run of instructions that reaches it only by
 *           falling through (the return copy): its start, the RET's offset and the copy's
 *           mnemonics. Where several returns of one value were merged into one copy the
 *           decompile prints one offset for all of them; the copy's own code tells a bare
 *           `xor eax, eax; ret` from one that also pops a frame. Each copy also lists
 *           how it is entered: the offsets of the jumps that land on its start, and
 *           whether the instruction before falls into it.
 *   edges   per `if`/`while` keyword whose p-code op is a CBRANCH, keyed by line and by the
 *           keyword's index among such keywords on its line: the conditional jump, its
 *           target and its fall-through instruction, and the decompile lines whose tokens
 *           print an op of the block each edge leads to (a block that prints nothing and
 *           has one successor is followed). The consumer reads which statement the jump
 *           falls into from the lines, so it needs no offset of an arm's first instruction.
 *
 * Lines are numbered as `DecompilerUtils.toLines` numbers them, which is the line order of
 * the decompile text the snapshot holds, provided the decompiler runs with the options the
 * daemon's batch_decompile uses (DecompilerPool.configureDecompileOptions, copied below).
 * `lineCount` lets the consumer reject a text from another version or with other options.
 *
 * Read-only: one execute_script per batch, no transaction. A failure leaves the field unset,
 * which is also what an older snapshot looks like; the pass then changes nothing.
 */

import type { GhidraConnection, ExtractedFunction } from '../types.js';

export interface BranchLayoutFacts {
  /** Number of lines the decompiler printed (the decompile text has the same count). */
  lineCount: number;
  /** [line, offsets] for every line that prints code, offsets ascending. */
  lines: [number, number[]][];
  /** [line, conditional-branch offset] per `if` keyword. */
  ifs: [number, number][];
  /** [line, test] per `==`/`!=` token tied to an instruction, in text order. Absent in older facts. */
  tests?: [number, EqualityTest][];
  /** [line, per leaf operand of the `&&`/`||` chain the branch offsets it feeds] per short-circuit `if`. Absent in older facts. */
  operands?: [number, number[][]][];
  /** Every return copy of the function, by start. Absent in older facts. */
  returns?: ReturnCopy[];
  /** Every conditional branch a keyword prints, in text order. Absent in older facts. */
  edges?: BranchEdge[];
}

/** A keyword's conditional jump and the lines each of its two edges leads to. */
export interface BranchEdge {
  line: number;
  /** Index of the keyword among the branching keywords of its line. */
  ord: number;
  keyword: 'if' | 'while';
  /** Offsets of the jump, its target and the instruction after it. */
  jcc: number;
  target: number;
  fall: number;
  /** Decompile lines printing an op of the block the fall-through / the jump leads to, ascending. */
  fallLines: number[];
  takenLines: number[];
}

/** A RET and the instructions that reach it only by falling through. */
export interface ReturnCopy {
  /** Offset of the copy's first instruction: a jump target, or the instruction after a call or jump. */
  start: number;
  /** Offset of the RET. */
  ret: number;
  /** Mnemonics from start to the RET, each with its first register operand when it has one (`XOR/EAX`). */
  insns: string[];
  /** Offsets of the jumps that land on `start`. Absent in older facts. */
  jumpsIn?: number[];
  /** Whether the instruction before `start` falls into it. Absent in older facts. */
  fallsIn?: boolean;
}

/** One equality token of the decompile and the instruction that compiled it. */
export interface EqualityTest {
  op: '==' | '!=';
  mnemonic: string;
  /** The instruction's first operand when it is a register, else `-`. */
  reg: string;
  /** What a SUB/ADD/DEC/INC takes off the register (ADD/INC negated); absent for others. */
  delta?: number;
  /** The constant the op compares against, as an unsigned `size`-byte value. */
  k?: number;
  size: number;
  /** Offset of the instruction from the function entry. */
  at: number;
}

/**
 * Java for the per-line token loop: declares the state of the operand walk. Needs `base`.
 */
export const IF_OPERANDS_DECL_JAVA = `
          StringBuilder opsRow = new StringBuilder();
          int ifDepth = -1;
          int ifLine = 0;
          java.util.List<java.util.TreeSet<Long>> ifSegs = new java.util.ArrayList<>();
`;

/**
 * Java run for every token \`t\` of line \`l\` (comments excluded): follows an \`if\`'s
 * condition from the keyword to its closing paren, splits it at every \`&&\`/\`||\` token and collects, per operand, the CBRANCHes its tokens' values reach (directly, or
 * through a BOOL_NEGATE or COPY).
 */
export const IF_OPERANDS_TOKEN_JAVA = `
              {
                String tx = t.getText();
                if (ifDepth < 0) {
                  if (tx.equals("if")) { ifDepth = 0; ifLine = l.getLineNumber(); ifSegs.clear(); ifSegs.add(new java.util.TreeSet<Long>()); }
                } else if (tx.equals("(")) ifDepth++;
                else if (tx.equals(")")) {
                  ifDepth--;
                  if (ifDepth == 0) {
                    if (ifSegs.size() >= 2) {
                      opsRow.append(opsRow.length() > 0 ? ";" : "").append(ifLine).append(':');
                      for (int si = 0; si < ifSegs.size(); si++) {
                        if (si > 0) opsRow.append('|');
                        if (ifSegs.get(si).isEmpty()) { opsRow.append('-'); continue; }
                        boolean f1 = true;
                        for (Long bo : ifSegs.get(si)) { if (!f1) opsRow.append('.'); opsRow.append(bo < 0 ? "-" + Long.toHexString(-bo) : Long.toHexString(bo)); f1 = false; }
                      }
                    }
                    ifDepth = -1;
                  }
                } else if (ifDepth >= 1 && (tx.equals("&&") || tx.equals("||"))) ifSegs.add(new java.util.TreeSet<Long>());
                else if (ifDepth >= 1) {
                  java.util.List<ghidra.program.model.pcode.Varnode> vs = new java.util.ArrayList<>();
                  ghidra.program.model.pcode.PcodeOp top = t.getPcodeOp();
                  if (top != null && top.getOutput() != null) vs.add(top.getOutput());
                  if (t instanceof ghidra.app.decompiler.ClangVariableToken && ((ghidra.app.decompiler.ClangVariableToken) t).getVarnode() != null) vs.add(((ghidra.app.decompiler.ClangVariableToken) t).getVarnode());
                  for (int vi = 0; vi < vs.size() && vi < 8; vi++) {
                    java.util.Iterator<ghidra.program.model.pcode.PcodeOp> dit = vs.get(vi).getDescendants();
                    while (dit != null && dit.hasNext()) {
                      ghidra.program.model.pcode.PcodeOp dop = dit.next();
                      int oc = dop.getOpcode();
                      if (oc == ghidra.program.model.pcode.PcodeOp.CBRANCH) ifSegs.get(ifSegs.size() - 1).add(dop.getSeqnum().getTarget().getOffset() - base);
                      else if ((oc == ghidra.program.model.pcode.PcodeOp.BOOL_NEGATE || oc == ghidra.program.model.pcode.PcodeOp.COPY) && dop.getOutput() != null) vs.add(dop.getOutput());
                    }
                  }
                }
              }
`;

/** Java for the per-line token loop: declares the edge walk's state. Needs nothing. */
export const EDGES_DECL_JAVA = `
          java.util.Map<Integer, java.util.TreeSet<Integer>> blkLines = new java.util.HashMap<>();
          java.util.List<Object[]> edgeKw = new java.util.ArrayList<>();
`;

/**
 * Java run for every token \`t\` of line \`l\` (comments excluded): the lines each basic
 * block prints, and the keywords that carry a CBRANCH.
 */
export const EDGES_TOKEN_JAVA = `
              {
                ghidra.program.model.pcode.PcodeOp eop = t.getPcodeOp();
                if (eop != null && eop.getParent() != null) {
                  blkLines.computeIfAbsent(eop.getParent().getIndex(), q -> new java.util.TreeSet<Integer>()).add(l.getLineNumber());
                  String etx = t.getText();
                  if ((etx.equals("if") || etx.equals("while")) && eop.getOpcode() == ghidra.program.model.pcode.PcodeOp.CBRANCH) {
                    int eord = 0;
                    for (Object[] pk : edgeKw) if ((Integer) pk[0] == l.getLineNumber()) eord++;
                    edgeKw.add(new Object[] { l.getLineNumber(), eord, etx, eop });
                  }
                }
              }
`;

/**
 * Java, after the line loop: per keyword the jump, its two destinations and the lines each
 * leads to, into \`edgeRow\`. Needs \`prog\`, \`base\`.
 */
export const EDGES_AFTER_JAVA = `
          StringBuilder edgeRow = new StringBuilder();
          for (Object[] k : edgeKw) {
            ghidra.program.model.pcode.PcodeOp eop = (ghidra.program.model.pcode.PcodeOp) k[3];
            ghidra.program.model.listing.Instruction ji = prog.getListing().getInstructionAt(eop.getSeqnum().getTarget());
            if (ji == null || !ji.getFlowType().isConditional() || ji.getFlows().length != 1 || ji.getFallThrough() == null) continue;
            ghidra.program.model.address.Address tgt = ji.getFlows()[0], fal = ji.getFallThrough();
            ghidra.program.model.pcode.PcodeBlock pb = eop.getParent();
            ghidra.program.model.pcode.PcodeBlock fb = null, tb = null;
            for (int oi = 0; oi < pb.getOutSize(); oi++) {
              ghidra.program.model.pcode.PcodeBlock ob = pb.getOut(oi);
              ghidra.program.model.address.Address os = ob.getStart();
              if (os != null && os.equals(fal)) fb = ob;
              else if (os != null && os.equals(tgt)) tb = ob;
            }
            if (pb.getOutSize() == 2) {
              if (fb == null && tb != null) fb = pb.getOut(0) == tb ? pb.getOut(1) : pb.getOut(0);
              if (tb == null && fb != null) tb = pb.getOut(0) == fb ? pb.getOut(1) : pb.getOut(0);
            }
            String[] side = new String[2];
            for (int si = 0; si < 2; si++) {
              ghidra.program.model.pcode.PcodeBlock b = si == 0 ? fb : tb;
              java.util.TreeSet<Integer> ln = null;
              for (int g = 0; g < 8 && b != null; g++) {
                ln = blkLines.get(b.getIndex());
                if (ln != null && !ln.isEmpty()) break;
                b = b.getOutSize() == 1 ? b.getOut(0) : null;
              }
              StringBuilder sl = new StringBuilder();
              if (ln != null) for (Integer x : ln) sl.append(sl.length() > 0 ? "," : "").append(x);
              side[si] = sl.length() > 0 ? sl.toString() : "-";
            }
            long jo = ji.getAddress().getOffset() - base, to = tgt.getOffset() - base, fo = fal.getOffset() - base;
            edgeRow.append(edgeRow.length() > 0 ? ";" : "").append(k[0]).append('.').append(k[1]).append(':').append(k[2])
              .append(':').append(jo < 0 ? "-" + Long.toHexString(-jo) : Long.toHexString(jo))
              .append(':').append(to < 0 ? "-" + Long.toHexString(-to) : Long.toHexString(to))
              .append(':').append(fo < 0 ? "-" + Long.toHexString(-fo) : Long.toHexString(fo))
              .append(':').append(side[0]).append(':').append(side[1]);
          }
`;

/**
 * Java, after the line loop: every RET of \`fn\` with the instructions that reach it only by
 * falling through, into \`retRow\`. Needs \`prog\`, \`fn\`, \`base\`.
 */
export const RETURN_COPIES_JAVA = `
          StringBuilder retRow = new StringBuilder();
          {
            ghidra.program.model.listing.Listing RL = prog.getListing();
            ghidra.program.model.symbol.ReferenceManager RM = prog.getReferenceManager();
            ghidra.program.model.listing.InstructionIterator rit = RL.getInstructions(fn.getBody(), true);
            while (rit.hasNext()) {
              ghidra.program.model.listing.Instruction ri = rit.next();
              if (!ri.getMnemonicString().equals("RET")) continue;
              java.util.LinkedList<String> ins = new java.util.LinkedList<>();
              ghidra.program.model.listing.Instruction cur = ri;
              for (int g = 0; g < 16; g++) {
                String rn = cur.getNumOperands() >= 1 && ghidra.program.model.lang.OperandType.isRegister(cur.getOperandType(0)) && cur.getRegister(0) != null ? "/" + cur.getRegister(0).getName() : "";
                ins.addFirst(cur.getMnemonicString() + rn);
                boolean entered = cur.getAddress().equals(fn.getEntryPoint());
                for (ghidra.program.model.symbol.Reference rf : RM.getReferencesTo(cur.getAddress())) if (rf.getReferenceType().isFlow()) entered = true;
                if (entered) break;
                ghidra.program.model.listing.Instruction p = RL.getInstructionBefore(cur.getAddress());
                if (p == null || !fn.getBody().contains(p.getAddress()) || p.getFallThrough() == null || !p.getFallThrough().equals(cur.getAddress())) break;
                if (p.getFlowType().isCall() || p.getFlowType().isJump()) break;
                cur = p;
              }
              long so = cur.getAddress().getOffset() - base, ro = ri.getAddress().getOffset() - base;
              StringBuilder rin = new StringBuilder();
              for (ghidra.program.model.symbol.Reference rf : RM.getReferencesTo(cur.getAddress())) {
                if (!rf.getReferenceType().isJump()) continue;
                long fo = rf.getFromAddress().getOffset() - base;
                rin.append(rin.length() > 0 ? "." : "").append(fo < 0 ? "-" + Long.toHexString(-fo) : Long.toHexString(fo));
              }
              ghidra.program.model.listing.Instruction rp = RL.getInstructionBefore(cur.getAddress());
              boolean rfall = rp != null && fn.getBody().contains(rp.getAddress()) && rp.getFallThrough() != null && rp.getFallThrough().equals(cur.getAddress());
              retRow.append(retRow.length() > 0 ? ";" : "").append(so < 0 ? "-" + Long.toHexString(-so) : Long.toHexString(so))
                .append(':').append(ro < 0 ? "-" + Long.toHexString(-ro) : Long.toHexString(ro)).append(':').append(String.join(".", ins))
                .append(':').append(rfall ? "f" : "-").append(rin.length() > 0 ? rin.toString() : "-");
            }
          }
`;

/**
 * Java, no imports. `__ITEMS__` is `;`-separated function entries. The functions are
 * decompiled on a small thread pool, one decompiler per thread.
 */
export const BRANCH_LAYOUT_SCRIPT = `
String items = "__ITEMS__";
final ghidra.program.model.listing.Program prog = currentProgram;
final java.util.List<String> todo = new java.util.ArrayList<>();
for (String a : items.split(";")) if (a.length() > 0) todo.add(a);
final java.util.concurrent.ConcurrentLinkedQueue<String> queue = new java.util.concurrent.ConcurrentLinkedQueue<>(todo);
final java.util.concurrent.ConcurrentHashMap<String, String> rows = new java.util.concurrent.ConcurrentHashMap<>();
final ghidra.util.task.TaskMonitor mon = monitor;
int nThreads = Math.max(1, Math.min(__THREADS__, todo.size()));
java.util.List<Thread> threads = new java.util.ArrayList<>();
for (int ti = 0; ti < nThreads; ti++) {
  Thread th = new Thread(() -> {
    ghidra.app.decompiler.DecompInterface di = new ghidra.app.decompiler.DecompInterface();
    ghidra.app.decompiler.DecompileOptions o = new ghidra.app.decompiler.DecompileOptions();
    o.setConventionPrint(true); o.setNoCastPrint(false);
    o.setPRECommentIncluded(true); o.setPLATECommentIncluded(true); o.setPOSTCommentIncluded(true);
    o.setEOLCommentIncluded(true); o.setWARNCommentIncluded(true); o.setHeadCommentIncluded(true);
    o.setEliminateUnreachable(false);
    try {
      java.lang.reflect.Field nf = ghidra.app.decompiler.DecompileOptions.class.getDeclaredField("namespaceStrategy");
      nf.setAccessible(true);
      nf.set(o, ghidra.app.decompiler.DecompileOptions.NamespaceStrategy.All);
    } catch (Exception e) { }
    di.setOptions(o);
    di.openProgram(prog);
    try {
      String a;
      while ((a = queue.poll()) != null) {
        try {
          ghidra.program.model.listing.Function fn = prog.getFunctionManager().getFunctionAt(prog.getAddressFactory().getAddress(a));
          if (fn == null || fn.isThunk() || fn.isExternal()) continue;
          ghidra.app.decompiler.DecompileResults r = di.decompileFunction(fn, __TIMEOUT__, mon);
          if (r == null || r.getCCodeMarkup() == null) continue;
          long base = fn.getEntryPoint().getOffset();
          StringBuilder ls = new StringBuilder(), is = new StringBuilder(), cs = new StringBuilder();
          int count = 0;
${IF_OPERANDS_DECL_JAVA}${EDGES_DECL_JAVA}          for (ghidra.app.decompiler.ClangLine l : ghidra.app.decompiler.component.DecompilerUtils.toLines(r.getCCodeMarkup())) {
            count++;
            java.util.TreeSet<Long> offs = new java.util.TreeSet<>();
            for (ghidra.app.decompiler.ClangToken t : l.getAllTokens()) {
              if (t instanceof ghidra.app.decompiler.ClangCommentToken) continue;
${IF_OPERANDS_TOKEN_JAVA}${EDGES_TOKEN_JAVA}              ghidra.program.model.address.Address x = t.getMinAddress();
              if (x == null) continue;
              long off = x.getOffset() - base;
              offs.add(off);
              if (t instanceof ghidra.app.decompiler.ClangOpToken && (t.getText().equals("==") || t.getText().equals("!="))) {
                ghidra.program.model.pcode.PcodeOp op = ((ghidra.app.decompiler.ClangOpToken) t).getPcodeOp();
                ghidra.program.model.listing.Instruction in = op == null ? null : prog.getListing().getInstructionAt(op.getSeqnum().getTarget());
                if (in != null) {
                  String m = in.getMnemonicString();
                  String reg = "-", d = "-", k = "-";
                  if (in.getNumOperands() >= 1 && ghidra.program.model.lang.OperandType.isRegister(in.getOperandType(0)) && in.getRegister(0) != null) reg = in.getRegister(0).getName();
                  if ((m.equals("SUB") || m.equals("ADD")) && in.getNumOperands() == 2 && ghidra.program.model.lang.OperandType.isScalar(in.getOperandType(1)) && in.getScalar(1) != null) {
                    long v = in.getScalar(1).getSignedValue();
                    d = Long.toString(m.equals("SUB") ? v : -v);
                  } else if (m.equals("DEC")) d = "1";
                  else if (m.equals("INC")) d = "-1";
                  for (int ii = 0; ii < op.getNumInputs(); ii++) if (op.getInput(ii).isConstant()) k = Long.toString(op.getInput(ii).getOffset());
                  long ioff = in.getAddress().getOffset() - base;
                  cs.append(cs.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':').append(t.getText()).append(',').append(m).append(',').append(reg)
                    .append(',').append(d).append(',').append(k).append(',').append(op.getInput(0).getSize()).append(',').append(ioff < 0 ? "-" + Long.toHexString(-ioff) : Long.toHexString(ioff));
                }
              }
              if (t.getText().equals("if")) {
                is.append(is.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':').append(off < 0 ? "-" + Long.toHexString(-off) : Long.toHexString(off));
              }
            }
            if (offs.isEmpty()) continue;
            ls.append(ls.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':');
            boolean first = true;
            for (Long off : offs) {
              if (!first) ls.append(',');
              ls.append(off < 0 ? "-" + Long.toHexString(-off) : Long.toHexString(off));
              first = false;
            }
          }
${RETURN_COPIES_JAVA}${EDGES_AFTER_JAVA}          rows.put(a, a + "\\t" + count + "\\t" + ls + "\\t" + is + "\\t" + cs + "\\t" + opsRow + "\\t" + retRow + "\\t" + edgeRow);
        } catch (Exception e) { }
      }
    } finally {
      di.dispose();
    }
  });
  th.start();
  threads.add(th);
}
for (Thread th : threads) th.join();
StringBuilder sb = new StringBuilder();
for (String a : todo) { String r = rows.get(a); if (r != null) sb.append(r).append('\\n'); }
println(sb.toString());
`;

/** The script for one batch of function entries. */
export function branchLayoutScript(batch: string[], threads = 8, timeout = 60): string {
  return BRANCH_LAYOUT_SCRIPT
    .replace('__ITEMS__', batch.join(';'))
    .replace('__THREADS__', String(threads))
    .replace('__TIMEOUT__', String(timeout));
}

/** Whether a decompile prints an `if`. */
export function printsIf(decompiled: string): boolean {
  return /\bif\s*\(/.test(decompiled);
}

/** Whether a decompile prints an `if` or a `switch` (case-layout orders its cases): the functions the script reads. */
export function printsBranch(decompiled: string): boolean {
  return printsIf(decompiled) || /\bswitch\s*\(/.test(decompiled);
}

/** Entries of every decompiled function that prints an `if` or a `switch`, in batches. */
export function branchLayoutBatches(functions: Pick<ExtractedFunction, 'address' | 'decompiled'>[], batchSize = 400): string[][] {
  const items: string[] = [];
  for (const f of functions) {
    if (f.decompiled && printsBranch(f.decompiled)) items.push(normalize(f.address));
  }
  const out: string[][] = [];
  for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
  return out;
}

function offset(s: string): number {
  return s.startsWith('-') ? -parseInt(s.slice(1), 16) : parseInt(s, 16);
}

/** Parse the script's rows: function entry -> facts. */
export function parseBranchLayout(output: string): Map<string, BranchLayoutFacts> {
  const out = new Map<string, BranchLayoutFacts>();
  for (const line of output.split('\n')) {
    const c = line.replace(/\r$/, '').split('\t');
    if (c.length < 4 || !/^[0-9a-fA-F]{8}$/.test(c[0])) continue;
    const lineCount = Number(c[1]);
    if (!Number.isInteger(lineCount)) continue;
    const lines: [number, number[]][] = [];
    for (const part of c[2] ? c[2].split(';') : []) {
      const i = part.indexOf(':');
      lines.push([Number(part.slice(0, i)), part.slice(i + 1).split(',').map(offset)]);
    }
    const ifs: [number, number][] = [];
    for (const part of c[3] ? c[3].split(';') : []) {
      const i = part.indexOf(':');
      ifs.push([Number(part.slice(0, i)), offset(part.slice(i + 1))]);
    }
    const tests: [number, EqualityTest][] = [];
    for (const part of c[4] ? c[4].split(';') : []) {
      const i = part.indexOf(':');
      const f = part.slice(i + 1).split(',');
      if (i < 0 || f.length < 7 || (f[0] !== '==' && f[0] !== '!=')) continue;
      const num = (x: string) => (/^-?\d+$/.test(x) ? Number(x) : undefined);
      const delta = num(f[3]);
      const k = num(f[4]);
      tests.push([Number(part.slice(0, i)), {
        op: f[0], mnemonic: f[1], reg: f[2],
        ...(delta !== undefined ? { delta } : {}),
        ...(k !== undefined ? { k } : {}),
        size: Number(f[5]), at: offset(f[6]),
      }]);
    }
    const facts: BranchLayoutFacts = c.length > 4 ? { lineCount, lines, ifs, tests } : { lineCount, lines, ifs };
    if (c.length > 6) {
      facts.operands = parseOperands(c[5]);
      facts.returns = parseReturns(c[6]);
    }
    if (c.length > 7) facts.edges = parseEdges(c[7]);
    out.set(normalize(c[0]), facts);
  }
  return out;
}

/** `line:o.o|o|-;...` -> [line, per operand its branch offsets]. */
function parseOperands(col: string): [number, number[][]][] {
  const out: [number, number[][]][] = [];
  for (const part of col ? col.split(';') : []) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const segs = part.slice(i + 1).split('|').map(seg => (seg === '-' || seg === '' ? [] : seg.split('.').map(offset)));
    out.push([Number(part.slice(0, i)), segs]);
  }
  return out;
}

/** `start:ret:M.M/R;...` -> the return copies. */
function parseReturns(col: string): ReturnCopy[] {
  const out: ReturnCopy[] = [];
  for (const part of col ? col.split(';') : []) {
    const f = part.split(':');
    if (f.length < 3) continue;
    const copy: ReturnCopy = { start: offset(f[0]), ret: offset(f[1]), insns: f[2] ? f[2].split('.') : [] };
    if (f.length > 3 && f[3]) {
      copy.fallsIn = f[3][0] === 'f';
      const rest = f[3].slice(1);
      copy.jumpsIn = rest && rest !== '-' ? rest.split('.').map(offset) : [];
    }
    out.push(copy);
  }
  return out;
}

/** `line.ord:kw:jcc:target:fall:L,L:L,L;...` -> the edges. */
function parseEdges(col: string): BranchEdge[] {
  const out: BranchEdge[] = [];
  const lines = (x: string) => (x === '-' || x === '' ? [] : x.split(',').map(Number));
  for (const part of col ? col.split(';') : []) {
    const f = part.split(':');
    if (f.length < 7 || (f[1] !== 'if' && f[1] !== 'while')) continue;
    const [line, ord] = f[0].split('.').map(Number);
    if (!Number.isInteger(line) || !Number.isInteger(ord)) continue;
    out.push({
      line, ord, keyword: f[1], jcc: offset(f[2]), target: offset(f[3]), fall: offset(f[4]),
      fallLines: lines(f[5]), takenLines: lines(f[6]),
    });
  }
  return out;
}

function normalize(a: string): string {
  return a.replace(/^0x/i, '').toLowerCase().padStart(8, '0');
}

/** Run the script over every decompiled function that has an `if` or a `switch` and attach `branchLayout`. */
export async function extractBranchLayout(connection: GhidraConnection, functions: ExtractedFunction[]): Promise<number> {
  let n = 0;
  const byAddr = new Map(functions.map(f => [normalize(f.address), f]));
  for (const batch of branchLayoutBatches(functions)) {
    const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
      'execute_script',
      { language: 'java', code: branchLayoutScript(batch), scriptTimeout: 600, _commandTimeout: 660000 }
    );
    if (result.success === false || typeof result.output !== 'string') throw new Error(result.error ?? 'no output');
    for (const [fn, facts] of parseBranchLayout(result.output)) {
      const f = byAddr.get(fn);
      if (!f) continue;
      f.branchLayout = facts;
      n++;
    }
  }
  return n;
}
