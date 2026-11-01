/**
 * Every per-function fact the codegen reads off the decompiler and the listing, from one
 * decompile per function, cached per function across runs.
 *
 * The facts and their formats are the ones the separate extractors produce, and their
 * parsers read the rows back, so the consumers see no difference:
 *
 *   compareSites  compare-sites.ts   the `S` rows, behind the same text-hash gate
 *   branchLayout  branch-layout.ts
 *   callOrder     call-order.ts
 *   haltLines     halt-lines.ts      (listing only)
 *   stringOps     string-ops.ts
 *   jumpTables    jump-tables.ts
 *   zeroStores    zero-stores.ts
 *   maskSites     mask-sites.ts      (behind the compare-sites text-hash gate)
 *   labelFlow     label-flow.ts      (listing only; its own script, labels come from the text)
 *
 * Each extractor decompiled every function again; this script decompiles a function once
 * and runs all of their walks over the same markup. Each fact is attached only where its
 * own extractor would have looked (the same text predicate), so a function gains or loses
 * nothing by the merge. One difference: the decompile timeout is 60 s for all of them,
 * where compare-sites used 30 s.
 *
 * The cache (fact-cache.ts) keys a function's facts by the stamps in function-stamps.ts:
 * the program stamp, the function's own stamp and the stamp of every type its markup
 * named. The script takes the function's stamp before it decompiles and the type stamps
 * after; when the program's modification number moved in between, the row is marked
 * unstable and not cached, so a stored stamp is never newer than the facts beside it.
 *
 * Read-only: execute_script per batch, no transaction.
 */

import type { GhidraConnection, ExtractedFunction } from '../types.js';
import { STAMPER_JAVA, functionStampsScript, parseFunctionStamps, normalizeEntry, type TypeStamp } from './function-stamps.js';
import { printsComparison, javaStringHash, parseCompareSiteOutput } from './compare-sites.js';
import { printsBranch, parseBranchLayout, IF_OPERANDS_DECL_JAVA, IF_OPERANDS_TOKEN_JAVA, RETURN_COPIES_JAVA, EDGES_DECL_JAVA, EDGES_TOKEN_JAVA, EDGES_AFTER_JAVA, PUSHES_JAVA } from './branch-layout.js';
import { printsCallTemporary, parseCallOrder } from './call-order.js';
import { ACCESS_ORDER_TOKEN_JAVA, parseAccessOrderRow, printsAccess } from './access-order.js';
import { printsHaltOrProbe, parseHaltLines, HALT_NAME, IP_NAME, PROBE_NAMES } from './halt-lines.js';
import { STRING_OPS_JAVA, printsRepLoop, parseStringOpRow } from './string-ops.js';
import { JUMP_TABLES_JAVA, printsSwitch, parseJumpTableRow } from './jump-tables.js';
import { ZERO_STORES_JAVA, printsMemberZeroStore, parseZeroStoreRow } from './zero-stores.js';
import { MASK_SITES_JAVA, printsByteWordMask, parseMaskSiteRow } from './mask-sites.js';
import { labelsOf, labelFlowItems, labelFlowScript, parseLabelFlow, LABEL_FLOW_SCRIPT } from './label-flow.js';
import { FactCache, type CachedFacts, type FactEntry } from './fact-cache.js';
import { createHash } from 'node:crypto';

/**
 * Java, no imports. `__ITEMS__` is `;`-separated entries, decompiled on a small thread pool,
 * one decompiler per thread. Per function, in this order:
 *
 *   F  entry  self  textHash  textLength  stable    (`F entry self fail` when no markup)
 *   S  ...   the compare-sites row, as compare-sites.ts prints it (decompile completed only)
 *   B  ...   the branch-layout row
 *   O  ...   the call-order row
 *   A  ...   the access-order row (access-order.ts)
 *   H  ...   the halt-lines row, when it has halts or probes
 *   R  ...   the string-ops row, when it has REP STOS/MOVS instructions
 *   J  ...   the jump-tables row (jump-tables.ts), when the decompiler recovered a table
 *   Z  ...   the zero-stores row (zero-stores.ts), when it has struct-typed stack locals
 *   M  ...   the mask-sites row (mask-sites.ts), when it prints a byte or word mask
 *   D  id,full,shape;...   the types the markup named
 */
export const FUNCTION_FACTS_SCRIPT = `
${STAMPER_JAVA}
final java.util.List<String> todo = new java.util.ArrayList<>();
for (String a : "__ITEMS__".split(";")) if (a.length() > 0) todo.add(a);
final java.util.concurrent.ConcurrentLinkedQueue<String> queue = new java.util.concurrent.ConcurrentLinkedQueue<>(todo);
final java.util.concurrent.ConcurrentHashMap<String, String> rows = new java.util.concurrent.ConcurrentHashMap<>();
final ghidra.util.task.TaskMonitor mon = monitor;
final java.util.Set<String> passive = new java.util.HashSet<>(java.util.Arrays.asList("MOV", "LEA", "PUSH", "POP", "MOVZX", "MOVSX", "NOP"));
final java.util.Set<String> cmpText = new java.util.HashSet<>(java.util.Arrays.asList("<", "<=", ">", ">=", "==", "!="));
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
    ghidra.program.model.listing.Listing L = prog.getListing();
    ghidra.program.model.symbol.ReferenceManager rm = prog.getReferenceManager();
    ghidra.program.model.listing.FunctionManager fm = prog.getFunctionManager();
    try {
      String a;
      while ((a = queue.poll()) != null) {
        StringBuilder out = new StringBuilder();
        try {
          ghidra.program.model.listing.Function fn = fm.getFunctionAt(prog.getAddressFactory().getAddress(a));
          if (fn == null || fn.isThunk() || fn.isExternal()) { rows.put(a, "F\\t" + a + "\\tnone\\tfail\\n"); continue; }
          long mod0 = prog.getModificationNumber();
          String self = S.fn(fn);
          ghidra.app.decompiler.DecompileResults r = di.decompileFunction(fn, __TIMEOUT__, mon);
          if (r == null || r.getCCodeMarkup() == null) { rows.put(a, "F\\t" + a + "\\t" + self + "\\tfail\\n"); continue; }
          long base = fn.getEntryPoint().getOffset();
          String ctext = r.decompileCompleted() && r.getDecompiledFunction() != null ? r.getDecompiledFunction().getC() : null;
          java.util.List<ghidra.app.decompiler.ClangNode> toks = new java.util.ArrayList<>();
          r.getCCodeMarkup().flatten(toks);
          // compare-sites
          StringBuilder sRows = new StringBuilder();
          if (ctext != null) {
            int ord = -1;
            for (ghidra.app.decompiler.ClangNode n : toks) {
              if (!(n instanceof ghidra.app.decompiler.ClangOpToken)) continue;
              ghidra.app.decompiler.ClangOpToken t = (ghidra.app.decompiler.ClangOpToken) n;
              String text = t.getText();
              if (!cmpText.contains(text)) continue;
              ord++;
              ghidra.program.model.pcode.PcodeOp op = t.getPcodeOp();
              if (op == null || op.getNumInputs() != 2) { sRows.append("S\\t").append(ord).append('\\t').append(text).append("\\t-\\n"); continue; }
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
              ghidra.program.model.listing.Instruction setter = null;
              if (user != null) {
                ghidra.program.model.listing.Instruction q = user;
                for (int s = 0; s < 9; s++) {
                  boolean entered = false;
                  for (ghidra.program.model.symbol.Reference rf : rm.getReferencesTo(q.getAddress())) if (rf.getReferenceType().isFlow()) entered = true;
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
                  ghidra.program.model.lang.Register rg = setter.getRegister(1);
                  ghidra.program.model.listing.Instruction q = setter;
                  for (int s = 0; s < 16; s++) {
                    boolean entered = false;
                    for (ghidra.program.model.symbol.Reference rf : rm.getReferencesTo(q.getAddress())) if (rf.getReferenceType().isFlow()) entered = true;
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
              boolean onPair = setter != null && (opAt.equals(setter.getAddress()) || opAt.equals(user.getAddress()));
              sRows.append("S\\t").append(ord).append('\\t').append(text).append('\\t').append(op.getMnemonic())
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
          // branch-layout and call-order, over the same lines
          StringBuilder ls = new StringBuilder(), is = new StringBuilder(), es = new StringBuilder(), cs = new StringBuilder();
          StringBuilder argRow = new StringBuilder(), storeRow = new StringBuilder();
          int count = 0;
${IF_OPERANDS_DECL_JAVA}${EDGES_DECL_JAVA}          for (ghidra.app.decompiler.ClangLine l : ghidra.app.decompiler.component.DecompilerUtils.toLines(r.getCCodeMarkup())) {
            count++;
            java.util.TreeSet<Long> offs = new java.util.TreeSet<>();
            StringBuilder one = new StringBuilder();
            StringBuilder oneArg = new StringBuilder(), oneSt = new StringBuilder();
            int storeOrd = 0;
            for (ghidra.app.decompiler.ClangToken t : l.getAllTokens()) {
              if (t instanceof ghidra.app.decompiler.ClangCommentToken) continue;
${IF_OPERANDS_TOKEN_JAVA}${EDGES_TOKEN_JAVA}${ACCESS_ORDER_TOKEN_JAVA}              ghidra.program.model.address.Address x = t.getMinAddress();
              if (x != null) {
                long off = x.getOffset() - base;
                offs.add(off);
                if (t instanceof ghidra.app.decompiler.ClangOpToken && (t.getText().equals("==") || t.getText().equals("!="))) {
                  ghidra.program.model.pcode.PcodeOp op = ((ghidra.app.decompiler.ClangOpToken) t).getPcodeOp();
                  ghidra.program.model.listing.Instruction in = op == null ? null : L.getInstructionAt(op.getSeqnum().getTarget());
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
                    es.append(es.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':').append(t.getText()).append(',').append(m).append(',').append(reg)
                      .append(',').append(d).append(',').append(k).append(',').append(op.getInput(0).getSize()).append(',').append(ioff < 0 ? "-" + Long.toHexString(-ioff) : Long.toHexString(ioff));
                  }
                }
                if (t.getText().equals("if")) {
                  is.append(is.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':').append(off < 0 ? "-" + Long.toHexString(-off) : Long.toHexString(off));
                }
              }
              if (!(t instanceof ghidra.app.decompiler.ClangFuncNameToken)) continue;
              ghidra.program.model.pcode.PcodeOp op = t.getPcodeOp();
              if (op == null || (op.getOpcode() != ghidra.program.model.pcode.PcodeOp.CALL)) continue;
              ghidra.program.model.address.Address cat = op.getSeqnum().getTarget();
              ghidra.program.model.listing.Instruction ci = L.getInstructionAt(cat);
              if (ci == null || !ci.getFlowType().isCall()) continue;
              int pushes = 0;
              String prev = "";
              ghidra.program.model.listing.Instruction cur = ci;
              for (int guard = 0; guard < 200; guard++) {
                boolean entered = false;
                for (ghidra.program.model.symbol.Reference ref : rm.getReferencesTo(cur.getAddress())) {
                  if (ref.getReferenceType().isFlow()) { entered = true; break; }
                }
                if (entered || cur.getAddress().equals(fn.getEntryPoint())) break;
                ghidra.program.model.listing.Instruction p = L.getInstructionBefore(cur.getAddress());
                if (p == null || p.getFallThrough() == null || !p.getFallThrough().equals(cur.getAddress())) break;
                if (!fn.getBody().contains(p.getAddress())) break;
                if (p.getFlowType().isCall()) { long po = p.getAddress().getOffset() - base; prev = po < 0 ? "-" + Long.toHexString(-po) : Long.toHexString(po); break; }
                if (p.getFlowType().isJump() || p.getFlowType().isTerminal()) break;
                if (p.getMnemonicString().equalsIgnoreCase("PUSH")) pushes++;
                cur = p;
              }
              String slots = "?";
              ghidra.program.model.listing.Function callee = op.getNumInputs() > 0 && op.getInput(0).isAddress()
                ? fm.getFunctionAt(op.getInput(0).getAddress()) : null;
              if (callee != null && callee.isThunk()) callee = callee.getThunkedFunction(true);
              if (callee != null && !callee.hasVarArgs()) {
                StringBuilder sb2 = new StringBuilder();
                boolean ok = true;
                for (ghidra.program.model.listing.Parameter prm : callee.getParameters()) {
                  ghidra.program.model.listing.VariableStorage vs = prm.getVariableStorage();
                  int n;
                  if (vs.isStackStorage()) n = (vs.size() + 3) / 4;
                  else if (vs.isRegisterStorage()) n = 0;
                  else { ok = false; break; }
                  sb2.append(sb2.length() > 0 ? "." : "").append(n);
                }
                if (ok) slots = sb2.length() > 0 ? sb2.toString() : "-";
              }
              long coff = cat.getOffset() - base;
              one.append(one.length() > 0 ? "|" : "").append(t.getText()).append(',')
                .append(coff < 0 ? "-" + Long.toHexString(-coff) : Long.toHexString(coff)).append(',')
                .append(prev).append(',').append(pushes).append(',').append(slots);
            }
            if (one.length() > 0) cs.append(cs.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':').append(one);
            if (oneArg.length() > 0) argRow.append(argRow.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':').append(oneArg);
            if (oneSt.length() > 0) storeRow.append(storeRow.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':').append(oneSt);
            if (offs.isEmpty()) continue;
            ls.append(ls.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':');
            boolean first = true;
            for (Long off : offs) {
              if (!first) ls.append(',');
              ls.append(off < 0 ? "-" + Long.toHexString(-off) : Long.toHexString(off));
              first = false;
            }
          }
${RETURN_COPIES_JAVA}${EDGES_AFTER_JAVA}${PUSHES_JAVA}          // string-ops
${STRING_OPS_JAVA}
          // halt-lines (listing only)
          StringBuilder hrow = new StringBuilder();
          StringBuilder probes = new StringBuilder();
          ghidra.program.model.listing.InstructionIterator hit = L.getInstructions(fn.getBody(), true);
          while (hit.hasNext()) {
            ghidra.program.model.listing.Instruction hc = hit.next();
            if (!hc.getFlowType().isCall() || hc.getFlows().length != 1) continue;
            ghidra.program.model.listing.Function hf = fm.getFunctionAt(hc.getFlows()[0]);
            if (hf != null && hf.isThunk()) hf = hf.getThunkedFunction(true);
            if (hf != null && (__PROBE_TEST__) && hc.getFallThrough() != null) {
              probes.append(probes.length() > 0 ? "," : "").append(Long.toHexString(hc.getFallThrough().getOffset()));
              continue;
            }
            if (hf == null || !hf.getName().equals("__HALT_NAME__")) continue;
            ghidra.program.model.listing.Instruction ps = L.getInstructionBefore(hc.getAddress());
            ghidra.program.model.listing.Instruction pe = ps == null ? null : L.getInstructionBefore(ps.getAddress());
            ghidra.program.model.listing.Instruction g = pe == null ? null : L.getInstructionBefore(pe.getAddress());
            if (g == null || !ps.getMnemonicString().equals("PUSH") || !pe.getMnemonicString().equals("PUSH")
                || !g.getFlowType().isCall() || g.getFlows().length != 1) continue;
            ghidra.program.model.listing.Function gf = fm.getFunctionAt(g.getFlows()[0]);
            if (gf != null && gf.isThunk()) gf = gf.getThunkedFunction(true);
            if (gf == null || !gf.getName().equals("__IP_NAME__")) continue;
            java.util.List<ghidra.program.model.listing.Instruction> pushers = new java.util.ArrayList<>();
            ghidra.program.model.listing.Instruction fp0 = L.getInstructionBefore(g.getAddress());
            if (fp0 != null && fn.getBody().contains(fp0.getAddress()) && fp0.getFallThrough() != null
                && fp0.getFallThrough().equals(g.getAddress())) pushers.add(fp0);
            else pushers.add(null);
            java.util.List<ghidra.program.model.address.Address> jumps = new java.util.ArrayList<>();
            for (ghidra.program.model.symbol.Reference rf : rm.getReferencesTo(g.getAddress())) {
              if (!rf.getReferenceType().isJump() || !fn.getBody().contains(rf.getFromAddress())) continue;
              jumps.add(rf.getFromAddress());
            }
            java.util.Collections.sort(jumps);
            for (ghidra.program.model.address.Address ja : jumps) {
              ghidra.program.model.listing.Instruction j = L.getInstructionAt(ja);
              ghidra.program.model.listing.Instruction jp = j == null || j.getFlowType().isConditional() ? null : L.getInstructionBefore(ja);
              pushers.add(jp != null && jp.getFallThrough() != null && jp.getFallThrough().equals(ja) ? jp : null);
            }
            StringBuilder ways = new StringBuilder();
            for (ghidra.program.model.listing.Instruction p : pushers) {
              String line = "-", guard = "-";
              if (p != null && p.getMnemonicString().equals("PUSH") && p.getNumOperands() == 1
                  && p.getScalar(0) != null && p.getRegister(0) == null) {
                line = Long.toHexString(p.getScalar(0).getUnsignedValue());
                ghidra.program.model.listing.Instruction c = null;
                for (ghidra.program.model.symbol.Reference rf : rm.getReferencesTo(p.getAddress())) {
                  if (!rf.getReferenceType().isConditional() || !fn.getBody().contains(rf.getFromAddress())) continue;
                  c = c == null ? L.getInstructionAt(rf.getFromAddress()) : null;
                  if (c == null) break;
                }
                if (c == null) {
                  ghidra.program.model.listing.Instruction b = L.getInstructionBefore(p.getAddress());
                  boolean entered = false;
                  for (ghidra.program.model.symbol.Reference rf : rm.getReferencesTo(p.getAddress())) if (rf.getReferenceType().isFlow()) entered = true;
                  if (!entered && b != null && b.getFlowType().isConditional() && b.getFallThrough() != null
                      && b.getFallThrough().equals(p.getAddress())) c = b;
                }
                if (c != null) guard = Long.toHexString(c.getAddress().getOffset() - base);
              }
              ways.append(ways.length() > 0 ? "," : "").append(line).append('/').append(guard);
            }
            hrow.append(hrow.length() > 0 ? ";" : "").append(Long.toHexString(hc.getAddress().getOffset() - base))
              .append(':').append(Long.toHexString(g.getAddress().getOffset() - base)).append(':').append(ways);
          }
${JUMP_TABLES_JAVA}${ZERO_STORES_JAVA}${MASK_SITES_JAVA}          // the types the markup named
          java.util.Set<Long> deps = new java.util.TreeSet<>();
          for (ghidra.app.decompiler.ClangNode n : toks) {
            ghidra.program.model.data.DataType d = null;
            if (n instanceof ghidra.app.decompiler.ClangTypeToken) d = ((ghidra.app.decompiler.ClangTypeToken) n).getDataType();
            else if (n instanceof ghidra.app.decompiler.ClangFieldToken) d = ((ghidra.app.decompiler.ClangFieldToken) n).getDataType();
            else if (n instanceof ghidra.app.decompiler.ClangVariableToken) {
              ghidra.program.model.pcode.HighVariable hv = ((ghidra.app.decompiler.ClangVariableToken) n).getHighVariable();
              if (hv != null) d = hv.getDataType();
            }
            if (d != null) S.deps(d, deps);
          }
          ghidra.program.model.pcode.HighFunction hfn = r.getHighFunction();
          if (hfn != null) {
            java.util.Iterator<ghidra.program.model.pcode.HighSymbol> hs = hfn.getLocalSymbolMap().getSymbols();
            while (hs.hasNext()) S.deps(hs.next().getDataType(), deps);
            java.util.Iterator<ghidra.program.model.pcode.HighSymbol> gs = hfn.getGlobalSymbolMap().getSymbols();
            while (gs.hasNext()) S.deps(gs.next().getDataType(), deps);
            ghidra.program.model.pcode.FunctionPrototype fpr = hfn.getFunctionPrototype();
            if (fpr != null) {
              S.deps(fpr.getReturnType(), deps);
              for (int pi = 0; pi < fpr.getNumParams(); pi++) S.deps(fpr.getParam(pi).getDataType(), deps);
            }
          }
          StringBuilder ds = new StringBuilder();
          for (Long k : deps) {
            String[] st = S.typeById(k);
            ds.append(ds.length() > 0 ? ";" : "").append(k).append(',').append(st[0]).append(',').append(st[1]);
          }
          boolean stable = prog.getModificationNumber() == mod0;
          out.append("F\\t").append(a).append('\\t').append(self).append('\\t')
            .append(ctext == null ? "-" : Integer.toHexString(ctext.hashCode())).append('\\t').append(ctext == null ? 0 : ctext.length())
            .append('\\t').append(stable ? 1 : 0).append('\\n');
          out.append(sRows);
          out.append("B\\t").append(a).append('\\t').append(count).append('\\t').append(ls).append('\\t').append(is).append('\\t').append(es).append('\\t').append(opsRow).append('\\t').append(retRow).append('\\t').append(edgeRow).append('\\t').append(pushRow).append('\\n');
          out.append("O\\t").append(a).append('\\t').append(count).append('\\t').append(cs).append('\\n');
          out.append("A\\t").append(a).append('\\t').append(count).append('\\t').append(argRow).append('\\t').append(storeRow).append('\\n');
          if (hrow.length() > 0 || probes.length() > 0) out.append("H\\t").append(a).append('\\t').append(hrow).append('\\t').append(probes).append('\\n');
          if (rrow.length() > 0) out.append("R\\t").append(a).append('\\t').append(rrow).append('\\n');
          if (jrow.length() > 0) out.append("J\\t").append(a).append('\\t').append(jrow).append('\\n');
          if (zrow.length() > 0) out.append("Z\\t").append(a).append('\\t').append(zrow).append('\\n');
          if (mrow.length() > 0) out.append("M\\t").append(a).append('\\t').append(mrow).append('\\n');
          out.append("D\\t").append(ds).append('\\n');
          rows.put(a, out.toString());
        } catch (Exception e) { rows.put(a, "F\\t" + a + "\\terror\\tfail\\n"); }
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
sb.append("P\\t").append(S.program()).append('\\n');
for (String a : todo) { String r = rows.get(a); if (r != null) sb.append(r); }
println(sb.toString());
`
  .replace('__PROBE_TEST__', PROBE_NAMES.map(n => `hf.getName().equals("${n}")`).join(' || '))
  .replace('__HALT_NAME__', HALT_NAME)
  .replace('__IP_NAME__', IP_NAME);

/**
 * Identifies the scripts and parsers a cache entry was made with: a change to any of them
 * drops every entry.
 */
export const FACT_SCRIPT_VERSION = createHash('sha1')
  .update(FUNCTION_FACTS_SCRIPT).update(LABEL_FLOW_SCRIPT).update(functionStampsScript([], []))
  .update('facts-6')
  .digest('hex').slice(0, 16);

export function functionFactsScript(batch: string[], threads = 8, timeout = 60): string {
  return FUNCTION_FACTS_SCRIPT
    .replace('__ITEMS__', batch.join(';'))
    .replace('__THREADS__', String(threads))
    .replace('__TIMEOUT__', String(timeout));
}

/** One function's output of the combined script, before the per-fact selection. */
export interface FunctionFactRow {
  self: string;
  /** Java String.hashCode of the decompile text, unsigned; null when the decompile did not complete. */
  textHash: number | null;
  textLength: number;
  /** The program did not change while this function was read. */
  stable: boolean;
  /** The compare-sites `S` rows, untagged. */
  compareRows: string;
  /** The branch-layout and call-order rows, as their scripts print them. */
  branchRow?: string;
  callRow?: string;
  accessRow?: string;
  haltRow?: string;
  /** The string-ops row, untagged and without the entry. */
  stringRow?: string;
  /** The jump-tables and zero-stores rows, untagged and without the entry. */
  jumpRow?: string;
  zeroRow?: string;
  /** The mask-sites row, untagged and without the entry. */
  maskRow?: string;
  deps: Record<string, TypeStamp>;
}

export interface FunctionFactOutput {
  program: string | null;
  rows: Map<string, FunctionFactRow>;
}

export function parseFunctionFacts(output: string): FunctionFactOutput {
  const out: FunctionFactOutput = { program: null, rows: new Map() };
  let cur: FunctionFactRow | null = null;
  const compare: string[] = [];
  const flush = () => { if (cur) cur.compareRows = compare.join('\n'); compare.length = 0; };
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const tag = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    if (tag === 'P') { out.program = rest; continue; }
    if (tag === 'F') {
      flush();
      cur = null;
      const c = rest.split('\t');
      if (c.length < 5 || c[2] === 'fail') continue;
      cur = {
        self: c[1],
        textHash: /^[0-9a-f]+$/i.test(c[2]) ? Number.parseInt(c[2], 16) : null,
        textLength: Number(c[3]),
        stable: c[4] === '1',
        compareRows: '',
        deps: {},
      };
      out.rows.set(normalizeEntry(c[0]), cur);
      continue;
    }
    if (!cur) continue;
    if (tag === 'S') compare.push(rest);
    else if (tag === 'B') cur.branchRow = rest;
    else if (tag === 'O') cur.callRow = rest;
    else if (tag === 'A') cur.accessRow = rest;
    else if (tag === 'H') cur.haltRow = rest;
    else if (tag === 'R') cur.stringRow = rest.slice(rest.indexOf('\t') + 1);
    else if (tag === 'J') cur.jumpRow = rest.slice(rest.indexOf('\t') + 1);
    else if (tag === 'Z') cur.zeroRow = rest.slice(rest.indexOf('\t') + 1);
    else if (tag === 'M') cur.maskRow = rest.slice(rest.indexOf('\t') + 1);
    else if (tag === 'D') {
      for (const part of rest ? rest.split(';') : []) {
        const [id, full, shape] = part.split(',');
        if (id && full && shape) cur.deps[id] = { full, shape };
      }
    }
  }
  flush();
  return out;
}

/**
 * The facts each extractor would have attached to this function, from its combined row.
 * `text` is the decompile the snapshot holds; `compareSites` reads the PE-only switch.
 */
export function selectFacts(text: string, entry: string, row: FunctionFactRow, compareSites: boolean): CachedFacts {
  const facts: CachedFacts = {};
  if (compareSites && printsComparison(text) && row.textHash !== null && row.compareRows
      && text.length === row.textLength && javaStringHash(text) === row.textHash) {
    // Through the compare-sites parser, so the rows are exactly what it would store.
    const block = parseCompareSiteOutput(
      `F\t${entry}\t${row.textHash.toString(16)}\t${row.textLength}\n` +
      row.compareRows.split('\n').map(r => `S\t${r}`).join('\n')
    ).get(entry);
    if (block?.rows) facts.compareSites = block.rows;
  }
  if (printsBranch(text) && row.branchRow) {
    const b = parseBranchLayout(row.branchRow).get(entry);
    if (b) facts.branchLayout = b;
  }
  if (printsCallTemporary(text) && row.callRow) {
    const c = parseCallOrder(row.callRow).get(entry);
    if (c) facts.callOrder = c;
  }
  if (printsAccess(text) && row.accessRow) {
    const a = parseAccessOrderRow(row.accessRow);
    if (a && a.entry === entry) facts.accessOrder = a.facts;
  }
  if (printsHaltOrProbe(text) && row.haltRow) {
    const h = parseHaltLines(row.haltRow).get(entry);
    if (h) facts.haltLines = h;
  }
  if (printsRepLoop(text) && row.stringRow) {
    const ops = parseStringOpRow(row.stringRow);
    if (ops.length > 0) facts.stringOps = ops;
  }
  if (printsSwitch(text) && row.jumpRow) {
    const t = parseJumpTableRow(row.jumpRow);
    if (t.length > 0) facts.jumpTables = t;
  }
  if (printsMemberZeroStore(text) && row.zeroRow) {
    const z = parseZeroStoreRow(row.zeroRow);
    if (z.length > 0) facts.zeroStores = z;
  }
  // Positions in text order: only for the exact text they were read from.
  if (printsByteWordMask(text) && row.maskRow && row.textHash !== null
      && text.length === row.textLength && javaStringHash(text) === row.textHash) {
    const m = parseMaskSiteRow(row.maskRow);
    if (m) facts.maskSites = m;
  }
  return facts;
}

export interface FunctionFactOptions {
  /** Attach compare sites (PE images, and not switched off). */
  compareSites: boolean;
  /** The per-function cache; absent extracts everything. */
  cache?: FactCache;
  /** Functions per script run. */
  batchSize?: number;
  /** Decompiler threads per script run. */
  threads?: number;
  /**
   * Re-extract this many cache hits (or all of them) and compare. A mismatch is reported
   * and the fresh facts win; it means the stamps missed a dependency.
   */
  verify?: number | 'all';
  log?: (message: string) => void;
}

export interface FunctionFactStats {
  candidates: number;
  hits: number;
  misses: number;
  extracted: number;
  unstable: number;
  /** Why the misses missed. */
  reasons: Record<string, number>;
  verified: number;
  verifyMismatches: string[];
  stampMs: number;
  extractMs: number;
  labelMs: number;
}

const FACT_KEYS = ['compareSites', 'branchLayout', 'callOrder', 'accessOrder', 'haltLines', 'stringOps', 'jumpTables', 'zeroStores', 'maskSites', 'labelFlow'] as const;

/**
 * Attach every per-function fact to the decompiled functions, from the cache where the
 * stamps say it is current and from one combined script run where not.
 */
export async function extractFunctionFacts(
  connection: GhidraConnection,
  functions: ExtractedFunction[],
  options: FunctionFactOptions,
): Promise<FunctionFactStats> {
  const log = options.log ?? (() => {});
  const batchSize = options.batchSize ?? 400;
  const threads = options.threads ?? 8;
  const stats: FunctionFactStats = {
    candidates: 0, hits: 0, misses: 0, extracted: 0, unstable: 0, reasons: {},
    verified: 0, verifyMismatches: [], stampMs: 0, extractMs: 0, labelMs: 0,
  };
  const byEntry = new Map<string, ExtractedFunction>();
  for (const f of functions) {
    if (!f.decompiled || f.isThunk || f.isExternal) continue;
    if (!(printsComparison(f.decompiled) || printsBranch(f.decompiled) || printsCallTemporary(f.decompiled)
        || printsAccess(f.decompiled) || printsHaltOrProbe(f.decompiled) || printsRepLoop(f.decompiled)
        || printsSwitch(f.decompiled) || printsMemberZeroStore(f.decompiled) || printsByteWordMask(f.decompiled)
        || labelsOf(f.decompiled).length > 0)) continue;
    byEntry.set(normalizeEntry(f.address), f);
  }
  stats.candidates = byEntry.size;
  const cache = options.cache;

  // Which cached entries are current.
  const hits = new Map<string, FactEntry>();
  let program: string | null = null;
  if (cache && cache.size > 0) {
    const t0 = Date.now();
    const entries = [...byEntry.keys()];
    for (let i = 0; i < entries.length; i += 2000) {
      const batch = entries.slice(i, i + 2000);
      const typeIds = new Set<string>();
      for (const e of batch) for (const id of Object.keys(cache.get(e)?.deps ?? {})) typeIds.add(id);
      const stamps = parseFunctionStamps(await runScript(connection, functionStampsScript(batch, typeIds, threads), 600));
      program = stamps.program;
      for (const e of batch) {
        const why = cache.check(e, byEntry.get(e)!.decompiled!, stamps);
        if (why === null) hits.set(e, cache.get(e)!);
        else stats.reasons[why] = (stats.reasons[why] ?? 0) + 1;
      }
    }
    stats.stampMs = Date.now() - t0;
  }

  // Attach hits; extract the rest.
  const miss: string[] = [];
  for (const [e, f] of byEntry) {
    const hit = hits.get(e);
    if (hit) { attach(f, hit.facts); stats.hits++; }
    else miss.push(e);
  }
  stats.misses = miss.length;

  let verifySet: string[] = [];
  if (options.verify && hits.size > 0) {
    const all = [...hits.keys()];
    verifySet = options.verify === 'all' ? all : sample(all, options.verify);
  }
  const fresh = await extractFresh(connection, [...miss, ...verifySet], byEntry, options, threads, batchSize, stats);
  if (fresh.program) program = fresh.program;
  for (const e of miss) {
    const got = fresh.facts.get(e);
    if (!got) continue;
    attach(byEntry.get(e)!, got.facts);
    stats.extracted++;
    if (cache && got.cacheable && program) cache.put(e, { ...got.entry, program });
    if (!got.cacheable) stats.unstable++;
  }
  for (const e of verifySet) {
    const got = fresh.facts.get(e);
    if (!got) continue;
    stats.verified++;
    const old = hits.get(e)!.facts;
    if (stableJson(old) !== stableJson(got.facts)) {
      stats.verifyMismatches.push(e);
      const f = byEntry.get(e)!;
      for (const k of FACT_KEYS) delete f[k];
      attach(f, got.facts);
      if (cache && got.cacheable && program) cache.put(e, { ...got.entry, program });
    }
  }
  if (cache && program) cache.setProgram(program);
  log(`facts: ${stats.candidates} candidates, ${stats.hits} cached, ${stats.misses} extracted` +
    (stats.verified ? `, ${stats.verified} verified (${stats.verifyMismatches.length} mismatched)` : ''));
  return stats;
}

interface FreshFacts {
  facts: CachedFacts;
  cacheable: boolean;
  entry: Omit<FactEntry, 'program'>;
}

async function extractFresh(
  connection: GhidraConnection,
  entries: string[],
  byEntry: Map<string, ExtractedFunction>,
  options: FunctionFactOptions,
  threads: number,
  batchSize: number,
  stats: FunctionFactStats,
): Promise<{ program: string | null; facts: Map<string, FreshFacts> }> {
  const out = new Map<string, FreshFacts>();
  let program: string | null = null;
  if (entries.length === 0) return { program, facts: out };
  const t0 = Date.now();
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const parsed = parseFunctionFacts(await runScript(connection, functionFactsScript(batch, threads), 900));
    if (parsed.program) program = parsed.program;
    for (const [e, row] of parsed.rows) {
      const f = byEntry.get(e);
      if (!f?.decompiled) continue;
      const text = f.decompiled;
      out.set(e, {
        facts: selectFacts(text, e, row, options.compareSites),
        // The stamps describe the decompile the script read; the entry is only worth keeping
        // when that is also the text the snapshot holds.
        cacheable: row.stable && row.textHash !== null && text.length === row.textLength && javaStringHash(text) === row.textHash,
        entry: { self: row.self, deps: row.deps, textHash: row.textHash ?? -1, textLength: row.textLength, facts: {} },
      });
    }
  }
  stats.extractMs += Date.now() - t0;

  // Label flow: labels come from the text, the facts from the listing.
  const t1 = Date.now();
  const withLabels = entries.map(e => byEntry.get(e)!).filter(f => f.decompiled && labelsOf(f.decompiled).length > 0);
  for (const batch of labelFlowItems(withLabels)) {
    for (const [fn, rec] of parseLabelFlow(await runScript(connection, labelFlowScript(batch), 300))) {
      const got = out.get(fn);
      if (got) got.facts.labelFlow = { ...(got.facts.labelFlow ?? {}), ...rec };
    }
  }
  stats.labelMs += Date.now() - t1;
  for (const got of out.values()) got.entry.facts = got.facts;
  return { program, facts: out };
}

async function runScript(connection: GhidraConnection, code: string, timeoutSec: number): Promise<string> {
  const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
    'execute_script',
    { language: 'java', code, scriptTimeout: timeoutSec, _commandTimeout: (timeoutSec + 60) * 1000 },
  );
  if (result.success === false || typeof result.output !== 'string') throw new Error(result.error ?? 'no output');
  return result.output;
}

function attach(f: ExtractedFunction, facts: CachedFacts): void {
  if (facts.compareSites !== undefined) f.compareSites = facts.compareSites;
  if (facts.branchLayout !== undefined) f.branchLayout = facts.branchLayout;
  if (facts.callOrder !== undefined) f.callOrder = facts.callOrder;
  if (facts.accessOrder !== undefined) f.accessOrder = facts.accessOrder;
  if (facts.haltLines !== undefined) f.haltLines = facts.haltLines;
  if (facts.stringOps !== undefined) f.stringOps = facts.stringOps;
  if (facts.jumpTables !== undefined) f.jumpTables = facts.jumpTables;
  if (facts.zeroStores !== undefined) f.zeroStores = facts.zeroStores;
  if (facts.maskSites !== undefined) f.maskSites = facts.maskSites;
  if (facts.labelFlow !== undefined) f.labelFlow = { ...(f.labelFlow ?? {}), ...facts.labelFlow };
}

/** JSON with sorted keys: the comparison the equality checks use. */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x);
}

/** A deterministic spread of `n` items. */
function sample<T>(items: T[], n: number): T[] {
  if (n >= items.length) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}
