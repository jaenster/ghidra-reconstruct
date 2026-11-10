/**
 * Where each call of a function's decompile lies in the binary, and what was pushed before it.
 *
 * VC8 evaluates stack arguments right to left, so a call nested in an argument list,
 * `HasQuestItem(GetGamePointer(pUnit), pUnit, code)`, pushes the arguments to the right of
 * the inner call first and calls it after them. The decompiler hands the inner result back
 * through a temporary (`pGame = GetGamePointer(pUnit); HasQuestItem(pGame, pUnit, code);`),
 * which VC8 compiles with the call first and every push after it. The instructions between
 * the two CALLs tell the forms apart; the `nest-call` pass reads them from here:
 *
 *   calls   decompile line -> each direct call printed on it, in print order:
 *           the callee's name as the token prints it, the CALL's offset from the entry,
 *           the offset of the CALL before it in straight-line code (null when a branch,
 *           a jump target, the entry or the store that links an SEH frame comes first),
 *           the argument PUSHes between the two (CALL_PUSHES_JAVA: not a save of a
 *           callee-saved register, nor the PUSH of a register that reserves a local),
 *           and the callee's parameters as 4-byte stack slots each (0 for a register
 *           parameter; null when the callee is varargs or a parameter's storage is not
 *           plain stack or register)
 *
 * Lines are numbered as `DecompilerUtils.toLines` numbers them, with the options the
 * daemon's batch_decompile uses (as extract/branch-layout.ts), so they are the lines of the
 * snapshot's decompile text. `lineCount` lets the consumer reject another text.
 *
 * Read-only: one execute_script per batch, no transaction. A failure leaves the field unset,
 * which is also what an older snapshot looks like; the pass then changes nothing.
 */

import type { GhidraConnection, ExtractedFunction } from '../types.js';

export interface CallOrderCall {
  /** The callee's name as the decompile prints it (last component). */
  name: string;
  /** The CALL instruction's offset from the function entry. */
  at: number;
  /** The previous CALL in straight-line code before it; null when there is none to see. */
  prev: number | null;
  /** PUSH instructions between `prev` (or the walk's stop) and this CALL. */
  pushes: number;
  /** Stack slots per declared parameter (0: register); null when unknown. */
  slots: number[] | null;
}

export interface CallOrderFacts {
  /** Number of lines the decompiler printed. */
  lineCount: number;
  /** [line, calls in print order] for every line that prints a direct call. */
  calls: [number, CallOrderCall[]][];
}

/**
 * Java, per decompiler thread: `notArgPush.test(fn, push)` is true for a PUSH that sets up
 * no argument, so the walk back from a CALL counts only the pushes of its argument setup.
 *
 * VC8 places the saves of callee-saved registers where it likes: `push ebx; mov ebx,
 * [ebp+0xc]; push edi` (SFileOpenFileAsArchive, 0041bca0), `mov ecx, [g]; push esi; call`
 * (CHARSEL_HandleRealmChange, 0043b4c0), after an early-exit branch (UI_DrawMercenaryHealth-
 * Bar, 00452d20). Counted as arguments, they made the nested form look like the temporary
 * form, and nest-call refused every such site. Two kinds of PUSH set up no argument:
 *
 *   - a save: PUSH EBX/ESI/EDI/EBP while the register still holds the value it had at the
 *     entry, on some path from the entry (a register no instruction on that path writes;
 *     a call keeps these four). No compiler passes a caller's callee-saved value along.
 *     A function that takes a parameter in that register is not judged (counted);
 *   - a reservation: PUSH EAX/ECX/EDX in the run of register PUSHes that opens the
 *     function (after PUSH EBP; MOV EBP,ESP), MSVC's `sub esp, 4`. When the register holds
 *     one of the function's parameters it may as well be that parameter's argument; it is
 *     a reservation then only when the stack frame has a variable on the slot.
 *
 * In doubt (a walk over 4000 instructions), a PUSH counts as an argument, the old count.
 */
export const CALL_PUSHES_JAVA = `
    final java.util.function.BiPredicate<ghidra.program.model.listing.Function, ghidra.program.model.listing.Instruction> notArgPush = (fx, pi) -> {
      if (pi.getNumOperands() != 1) return false;
      ghidra.program.model.lang.Register pr0 = pi.getRegister(0);
      if (pr0 == null) return false;
      final ghidra.program.model.lang.Register pr = pr0.getBaseRegister();
      final String rn = pr.getName();
      final ghidra.program.model.listing.Listing XL = prog.getListing();
      final ghidra.program.model.symbol.ReferenceManager XR = prog.getReferenceManager();
      final ghidra.program.model.address.Address entry = fx.getEntryPoint();
      boolean param = false;
      for (ghidra.program.model.listing.Parameter prm : fx.getParameters()) {
        ghidra.program.model.listing.VariableStorage vs = prm.getVariableStorage();
        if (vs.isRegisterStorage() && vs.getRegister() != null && vs.getRegister().getBaseRegister().equals(pr)) param = true;
      }
      if (rn.equals("EBX") || rn.equals("ESI") || rn.equals("EDI") || rn.equals("EBP")) {
        if (param) return false;
        java.util.ArrayDeque<ghidra.program.model.listing.Instruction> work = new java.util.ArrayDeque<>();
        java.util.Set<ghidra.program.model.address.Address> seen = new java.util.HashSet<>();
        work.add(pi); seen.add(pi.getAddress());
        while (!work.isEmpty()) {
          if (seen.size() > 4000) return false;
          ghidra.program.model.listing.Instruction q = work.poll();
          if (q != pi) {
            boolean w = false;
            for (Object ro : q.getResultObjects()) {
              if (ro instanceof ghidra.program.model.lang.Register && ((ghidra.program.model.lang.Register) ro).getBaseRegister().equals(pr)) { w = true; break; }
            }
            if (w) continue;
          }
          if (q.getAddress().equals(entry)) return true;
          ghidra.program.model.listing.Instruction b = XL.getInstructionBefore(q.getAddress());
          if (b != null && fx.getBody().contains(b.getAddress()) && b.getFallThrough() != null
              && b.getFallThrough().equals(q.getAddress()) && seen.add(b.getAddress())) work.add(b);
          for (ghidra.program.model.symbol.Reference rf : XR.getReferencesTo(q.getAddress())) {
            if (!rf.getReferenceType().isFlow() || rf.getReferenceType().isCall()) continue;
            ghidra.program.model.address.Address fa = rf.getFromAddress();
            if (!fx.getBody().contains(fa) || !seen.add(fa)) continue;
            ghidra.program.model.listing.Instruction fi = XL.getInstructionAt(fa);
            if (fi != null) work.add(fi);
          }
        }
        return false;
      }
      if (rn.equals("EAX") || rn.equals("ECX") || rn.equals("EDX")) {
        ghidra.program.model.listing.Instruction q = XL.getInstructionAt(entry);
        int k = 0;
        if (q != null && q.toString().equals("PUSH EBP")) {
          k = 1; q = q.getNext();
          if (q != null && q.toString().equals("MOV EBP,ESP")) q = q.getNext();
        }
        while (q != null && fx.getBody().contains(q.getAddress()) && q.toString().matches("PUSH (EAX|ECX|EDX)")) {
          k++;
          if (q.getAddress().equals(pi.getAddress())) {
            return !param || fx.getStackFrame().getVariableContaining(-4 * k) != null;
          }
          q = q.getNext();
        }
      }
      return false;
    };
`;

/**
 * Java, in the walk back from a CALL (`p` the instruction before `cur`): true when `p`
 * links an SEH frame (`MOV dword ptr FS:[0x0],ESP`). The PUSHes before it build the
 * frame (`push -1; push handler; push eax`), so the walk stops there as at the entry.
 */
export const SEH_LINK_JAVA = `p.getMnemonicString().equals("MOV") && p.getNumOperands() == 2 && p.getRegister(1) != null && p.getRegister(1).getName().equals("ESP") && p.toString().contains("FS:")`;

/**
 * Java, no imports. `__ITEMS__` is `;`-separated function entries, decompiled on a small
 * thread pool, one decompiler per thread.
 */
export const CALL_ORDER_SCRIPT = `
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
    ghidra.program.model.listing.Listing L = prog.getListing();
    ghidra.program.model.symbol.ReferenceManager rm = prog.getReferenceManager();
${CALL_PUSHES_JAVA}
    try {
      String a;
      while ((a = queue.poll()) != null) {
        try {
          ghidra.program.model.listing.Function fn = prog.getFunctionManager().getFunctionAt(prog.getAddressFactory().getAddress(a));
          if (fn == null || fn.isThunk() || fn.isExternal()) continue;
          ghidra.app.decompiler.DecompileResults r = di.decompileFunction(fn, __TIMEOUT__, mon);
          if (r == null || r.getCCodeMarkup() == null) continue;
          long base = fn.getEntryPoint().getOffset();
          StringBuilder cs = new StringBuilder();
          int count = 0;
          for (ghidra.app.decompiler.ClangLine l : ghidra.app.decompiler.component.DecompilerUtils.toLines(r.getCCodeMarkup())) {
            count++;
            StringBuilder one = new StringBuilder();
            for (ghidra.app.decompiler.ClangToken t : l.getAllTokens()) {
              if (!(t instanceof ghidra.app.decompiler.ClangFuncNameToken)) continue;
              ghidra.program.model.pcode.PcodeOp op = t.getPcodeOp();
              if (op == null || (op.getOpcode() != ghidra.program.model.pcode.PcodeOp.CALL)) continue;
              ghidra.program.model.address.Address at = op.getSeqnum().getTarget();
              ghidra.program.model.listing.Instruction ci = L.getInstructionAt(at);
              if (ci == null || !ci.getFlowType().isCall()) continue;
              // Walk back through straight-line code to the previous CALL.
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
                if (${SEH_LINK_JAVA}) break;
                if (p.getMnemonicString().equalsIgnoreCase("PUSH") && !notArgPush.test(fn, p)) pushes++;
                cur = p;
              }
              String slots = "?";
              ghidra.program.model.listing.Function callee = op.getNumInputs() > 0 && op.getInput(0).isAddress()
                ? prog.getFunctionManager().getFunctionAt(op.getInput(0).getAddress()) : null;
              if (callee != null && callee.isThunk()) callee = callee.getThunkedFunction(true);
              if (callee != null && !callee.hasVarArgs()) {
                StringBuilder sb = new StringBuilder();
                boolean ok = true;
                for (ghidra.program.model.listing.Parameter prm : callee.getParameters()) {
                  ghidra.program.model.listing.VariableStorage vs = prm.getVariableStorage();
                  int n;
                  if (vs.isStackStorage()) n = (vs.size() + 3) / 4;
                  else if (vs.isRegisterStorage()) n = 0;
                  else { ok = false; break; }
                  sb.append(sb.length() > 0 ? "." : "").append(n);
                }
                if (ok) slots = sb.length() > 0 ? sb.toString() : "-";
              }
              long off = at.getOffset() - base;
              String name = t.getText();
              one.append(one.length() > 0 ? "|" : "").append(name).append(',')
                .append(off < 0 ? "-" + Long.toHexString(-off) : Long.toHexString(off)).append(',')
                .append(prev).append(',').append(pushes).append(',').append(slots);
            }
            if (one.length() == 0) continue;
            cs.append(cs.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':').append(one);
          }
          rows.put(a, a + "\\t" + count + "\\t" + cs);
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
export function callOrderScript(batch: string[], threads = 8, timeout = 60): string {
  return CALL_ORDER_SCRIPT
    .replace('__ITEMS__', batch.join(';'))
    .replace('__THREADS__', String(threads))
    .replace('__TIMEOUT__', String(timeout));
}

/** A line assigning a value that holds a call (a cast in front included). */
const CALL_TEMPORARY = /^\s*[A-Za-z_]\w*\s*=[^=;][^;]*\b[A-Za-z_][\w:]*\s*\(/m;

/** Whether a call's result could feed a later call in this decompile: the functions the script reads. */
export function printsCallTemporary(decompiled: string): boolean {
  return CALL_TEMPORARY.test(decompiled);
}

/**
 * Entries of every decompiled function where a call's result could feed a later call, in
 * batches: a line assigning a value that holds a call (a cast in front included).
 */
export function callOrderBatches(functions: Pick<ExtractedFunction, 'address' | 'decompiled'>[], batchSize = 400): string[][] {
  const items: string[] = [];
  for (const f of functions) {
    if (f.decompiled && printsCallTemporary(f.decompiled)) items.push(normalize(f.address));
  }
  const out: string[][] = [];
  for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
  return out;
}

function offset(s: string): number {
  return s.startsWith('-') ? -parseInt(s.slice(1), 16) : parseInt(s, 16);
}

/** Parse the script's rows: function entry -> facts. */
export function parseCallOrder(output: string): Map<string, CallOrderFacts> {
  const out = new Map<string, CallOrderFacts>();
  for (const line of output.split('\n')) {
    const c = line.replace(/\r$/, '').split('\t');
    if (c.length < 3 || !/^[0-9a-fA-F]{8}$/.test(c[0])) continue;
    const lineCount = Number(c[1]);
    if (!Number.isInteger(lineCount)) continue;
    const calls: [number, CallOrderCall[]][] = [];
    let ok = true;
    for (const part of c[2] ? c[2].split(';') : []) {
      const i = part.indexOf(':');
      const ln = Number(part.slice(0, i));
      const list: CallOrderCall[] = [];
      for (const one of part.slice(i + 1).split('|')) {
        const f = one.split(',');
        if (f.length !== 5) { ok = false; break; }
        list.push({
          name: f[0],
          at: offset(f[1]),
          prev: f[2] === '' ? null : offset(f[2]),
          pushes: Number(f[3]),
          slots: f[4] === '?' ? null : f[4] === '-' ? [] : f[4].split('.').map(Number),
        });
      }
      if (!ok || !Number.isInteger(ln)) { ok = false; break; }
      calls.push([ln, list]);
    }
    if (ok) out.set(normalize(c[0]), { lineCount, calls });
  }
  return out;
}

function normalize(a: string): string {
  return a.replace(/^0x/i, '').toLowerCase().padStart(8, '0');
}

/** Run the script over every decompiled function with a candidate and attach `callOrder`. */
export async function extractCallOrder(connection: GhidraConnection, functions: ExtractedFunction[]): Promise<number> {
  let n = 0;
  const byAddr = new Map(functions.map(f => [normalize(f.address), f]));
  for (const batch of callOrderBatches(functions)) {
    const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
      'execute_script',
      { language: 'java', readOnly: true, code: callOrderScript(batch), scriptTimeout: 600, _commandTimeout: 660000 }
    );
    if (result.success === false || typeof result.output !== 'string') throw new Error(result.error ?? 'no output');
    for (const [fn, facts] of parseCallOrder(result.output)) {
      const f = byAddr.get(fn);
      if (!f) continue;
      f.callOrder = facts;
      n++;
    }
  }
  return n;
}
